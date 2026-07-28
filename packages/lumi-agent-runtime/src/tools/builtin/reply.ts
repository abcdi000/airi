import type { LumiVisibleReply } from '@proj-airi/lumi-runtime'

import type { LumiAgentContextMessage } from '../../context/messages'
import type { DirectPerceptionEnvelope } from '../../input'
import type { DirectOutboundCapability } from '../../policy/outbound-guard'
import type { AgentPersonProfile } from '../../ports/identity'
import type { DirectOutboundPort } from '../../ports/outbound'
import type { ReplyIntentProposal, ReplyPolicyPort } from '../../ports/reply'
import type { SocialLanguagePort } from '../../ports/social-language'
import type { StickerPort } from '../../ports/stickers'
import type { ReplyerService } from '../../replyer/replyer-service'
import type { ToolSpec } from '../registry'

import { normalizeLumiReplyIntent } from '@proj-airi/lumi-runtime'

/** Runtime state read by the explicit reply tool at invocation time. */
export interface ReplyToolRuntimeContext {
  turnId: string
  envelope: DirectPerceptionEnvelope
  capability: DirectOutboundCapability
  history: readonly LumiAgentContextMessage[]
  profile?: AgentPersonProfile
  signal?: AbortSignal
  alreadyReplied: boolean
  claimReplyAttempt: () => boolean
  isCurrentGeneration: () => boolean
  onSent: (input: {
    reply: LumiVisibleReply
    messageIds: readonly string[]
    stickerId?: string
  }) => Promise<void> | void
}

/**
 * Creates the only builtin allowed to produce visible direct-chat output.
 */
export function createReplyTool(options: {
  context: () => ReplyToolRuntimeContext
  replyPolicy: ReplyPolicyPort
  replyer: ReplyerService
  outbound: DirectOutboundPort
  socialLanguage?: SocialLanguagePort
  expressionSelectorEnabled?: boolean
  sticker?: {
    port: StickerPort
    cooldownMs: number
    minimumScore: number
  }
}): ToolSpec {
  return {
    name: 'reply',
    // Reply includes expression selection, generation, validation, and one
    // correction pass. Keep headroom below the five-minute gateway deadline.
    timeoutMs: 240_000,
    description: '提交 Lumi 的回复意图。宿主策略确认后，由不带工具权限的 Replyer 生成并发送最终私聊消息。',
    inputSchema: {
      type: 'object',
      properties: {
        targetMessageId: { type: 'string', description: '当前需要回应的消息标识。' },
        quote: { type: 'boolean', description: '是否引用目标消息。' },
        replyAct: { type: 'string', description: '回复行为，例如回应、安慰、解释、拒绝或调侃。' },
        semanticGoal: { type: 'string', description: '这次回复要让对方理解或感受到什么，不要写最终措辞。' },
        keyPoints: { type: 'array', description: '最终回复应覆盖的事实或要点。', items: { type: 'string' } },
        referenceInfo: { type: 'array', description: '允许 Replyer 使用的参考信息。', items: { type: 'string' } },
        expressionIntent: { type: 'object', description: '语气、风格和分段倾向。' },
        stickerIntent: { type: 'object', description: '是否以及在何种情绪场景下考虑发送表情包。' },
      },
      required: ['targetMessageId', 'replyAct', 'semanticGoal'],
      additionalProperties: false,
    },
    provider: 'lumi-agent-runtime',
    visibility: 'visible',
    stage: 'planner',
    chatScope: 'direct',
    riskLevel: 'low',
    executionMode: 'automatic',
    sideEffectType: 'write',
    idempotencyPolicy: 'required',
    requiredScopes: [],
    async handler({ invocation }) {
      const context = options.context()
      if (context.alreadyReplied) {
        return {
          success: false,
          errorCode: 'ALREADY_REPLIED',
          errorMessage: '本轮已经发送过可见回复。',
        }
      }
      const proposal = parseReplyProposal(invocation.arguments, context.envelope.sourceMessageId)
      if (!proposal) {
        return {
          success: false,
          errorCode: 'INVALID_REPLY_INTENT',
          errorMessage: 'reply 工具参数无效。',
        }
      }
      if (!context.claimReplyAttempt()) {
        return {
          success: false,
          errorCode: 'REPLY_ALREADY_ATTEMPTED',
          errorMessage: '本轮已经执行过 Replyer，不会重复生成可见回复。',
        }
      }

      const intent = normalizeLumiReplyIntent(await options.replyPolicy.resolveIntent({
        proposal,
        envelope: context.envelope,
        profile: context.profile,
      }))
      const forbiddenPrivacyTokens = await options.replyPolicy.forbiddenPrivacyTokens?.({
        envelope: context.envelope,
        intent,
      })
      const languageReferences = await options.socialLanguage?.replyReferences({
        envelope: context.envelope,
        intent,
        limit: 3,
        expressionSelectorEnabled: options.expressionSelectorEnabled ?? true,
      })
      const generated = await options.replyer.generate({
        turnId: context.turnId,
        intent,
        history: context.history,
        languageReferences,
        forbiddenPrivacyTokens,
        signal: context.signal,
      })
      if (!generated.success || !generated.reply) {
        return {
          success: false,
          errorCode: 'REPLYER_VALIDATION_FAILED',
          errorMessage: generated.issues.join(' ') || 'Replyer 未能生成有效回复。',
        }
      }
      if (!context.isCurrentGeneration()) {
        return {
          success: false,
          errorCode: 'STALE_GENERATION',
          errorMessage: '新的私聊消息已经取代本次回复。',
        }
      }

      const messageIds: string[] = []
      for (const message of generated.reply.messages) {
        if (message.delayMs)
          await delay(message.delayMs, context.signal)
        if (!context.isCurrentGeneration()) {
          return {
            success: false,
            errorCode: 'STALE_GENERATION',
            errorMessage: '新的私聊消息已经取代本次回复。',
          }
        }
        if (message.quoteMessageId) {
          await options.outbound.sendQuote(context.capability, {
            conversationId: context.envelope.conversationId,
            personId: context.envelope.personId,
            sourceMessageId: message.quoteMessageId,
          })
        }
        const sent = await options.outbound.sendText(context.capability, {
          conversationId: context.envelope.conversationId,
          personId: context.envelope.personId,
          text: message.text,
          delayMs: message.delayMs,
        })
        messageIds.push(sent.messageId)
      }
      let stickerId: string | undefined
      if (
        messageIds.length > 0
        && proposal.stickerIntent?.enabled
        && options.sticker
        && context.isCurrentGeneration()
      ) {
        const candidates = await options.sticker.port.findCandidates({
          personId: context.envelope.personId,
          conversationId: context.envelope.conversationId,
          emotionOrScene: proposal.stickerIntent.emotionOrScene,
          userText: context.envelope.text ?? '',
          replyText: generated.reply.messages.map(message => message.text).join('\n'),
          limit: 6,
        })
        const now = Date.now()
        const selected = [...candidates]
          .filter(candidate =>
            candidate.score >= options.sticker!.minimumScore
            && (candidate.lastSentAt === undefined || now - candidate.lastSentAt >= options.sticker!.cooldownMs),
          )
          .sort((left, right) =>
            right.score - left.score
            || left.sentCount - right.sentCount
            || left.id.localeCompare(right.id),
          )[0]
        if (selected) {
          const sent = await options.outbound.sendSticker(context.capability, {
            conversationId: context.envelope.conversationId,
            personId: context.envelope.personId,
            stickerId: selected.id,
            localPath: selected.localPath,
          })
          messageIds.push(sent.messageId)
          stickerId = selected.id
          await options.sticker.port.recordSent({
            stickerId: selected.id,
            personId: context.envelope.personId,
            conversationId: context.envelope.conversationId,
            sentAt: sent.timestamp,
          })
        }
      }
      await context.onSent({
        reply: generated.reply,
        messageIds,
        stickerId,
      })
      if (options.socialLanguage) {
        const selectedReferenceIds = [
          ...languageReferences?.expressions.map(reference => reference.id) ?? [],
          ...languageReferences?.behaviors.map(reference => reference.id) ?? [],
          ...languageReferences?.jargon.map(reference => reference.id) ?? [],
        ]
        try {
          await options.socialLanguage.recordSentReply({
            envelope: context.envelope,
            intent,
            reply: generated.reply,
            sentMessageIds: messageIds,
            selectedReferenceIds,
            replyerPromptSnapshot: generated.promptMessages,
          })
        }
        catch (error) {
          console.warn(
            '[lumi-agent-runtime] failed to record social-language reply usage',
            error,
          )
        }
      }
      return {
        success: true,
        output: {
          sentMessageIds: messageIds,
          messageCount: messageIds.length,
          appliedExpressionIds: generated.reply.appliedExpressionIds,
          stickerId,
        },
      }
    },
  }
}

function parseReplyProposal(
  value: Readonly<Record<string, unknown>>,
  fallbackTargetMessageId: string,
): ReplyIntentProposal | undefined {
  const replyAct = stringValue(value.replyAct)
  const semanticGoal = stringValue(value.semanticGoal)
  if (!replyAct || !semanticGoal)
    return undefined
  const expression = recordValue(value.expressionIntent)
  const sticker = recordValue(value.stickerIntent)
  return {
    targetMessageId: stringValue(value.targetMessageId) || fallbackTargetMessageId,
    quote: typeof value.quote === 'boolean' ? value.quote : undefined,
    replyAct,
    semanticGoal,
    keyPoints: stringArray(value.keyPoints),
    referenceInfo: stringArray(value.referenceInfo),
    expressionIntent: expression
      ? {
          focus: stringValue(expression.focus) || undefined,
          scene: stringValue(expression.scene) || undefined,
          tone: stringValue(expression.tone) || undefined,
          desiredLength: replyLength(expression.desiredLength),
          preferredActs: stringArray(expression.preferredActs),
          avoid: stringArray(expression.avoid),
        }
      : undefined,
    stickerIntent: sticker && typeof sticker.enabled === 'boolean'
      ? {
          enabled: sticker.enabled,
          emotionOrScene: stringValue(sticker.emotionOrScene) || undefined,
        }
      : undefined,
  }
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap(item => typeof item === 'string' && item.trim() ? [item.trim()] : []).slice(0, 32)
    : []
}

function replyLength(value: unknown): 'tiny' | 'short' | 'medium' | 'long' | undefined {
  return value === 'tiny' || value === 'short' || value === 'medium' || value === 'long'
    ? value
    : undefined
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds)
    const abort = () => {
      clearTimeout(timeout)
      reject(signal?.reason ?? new Error('Reply delay aborted'))
    }
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
