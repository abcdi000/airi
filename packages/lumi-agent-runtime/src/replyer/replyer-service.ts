import type { LumiReplyIntent, LumiVisibleReply } from '@proj-airi/lumi-runtime'

import type { LumiAgentContextMessage } from '../context/messages'
import type { AgentTracePort } from '../observability/trace'
import type { LanguageModelMessage, LanguageModelPort } from '../ports/model'
import type { ReplyLanguageReferences } from '../ports/social-language'
import type { LumiPromptTemplate } from '../prompts/templates'

import { errorMessageFrom } from '@moeru/std'
import {
  parseLumiVisibleReply,
  validateLumiVisibleReply,
  visibleReplyFromText,
} from '@proj-airi/lumi-runtime'

import { selectContextWithinBudget } from '../context/history'
import { projectReplyerHistory } from '../context/replyer-projection'
import {
  lumiPromptTemplateMetadata,
  redactPromptMessages,
} from '../prompts/templates'

/** Result of one bounded no-tool Replyer execution. */
export interface ReplyerExecutionResult {
  success: boolean
  reply?: LumiVisibleReply
  issues: readonly string[]
  retryCount: number
  /** Redacted request messages retained only when host prompt logging is enabled. */
  promptMessages?: ReadonlyArray<{ role: string, content: string }>
}

/** Configuration for the strict no-tool Replyer. */
export interface ReplyerServiceOptions {
  model: LanguageModelPort
  prompt: LumiPromptTemplate
  promptLoggingEnabled?: boolean
  multiMessageEnabled?: boolean
  maximumMessages?: number
  historyBudgetTokens?: number
  trace?: AgentTracePort
}

/**
 * Generates visible language without exposing Planner or tool internals.
 *
 * Use when:
 * - The explicit reply tool already has a host-authorized LumiReplyIntent
 *
 * Expects:
 * - History contains typed records from one direct session
 *
 * Returns:
 * - A validated reply, or a structured failure after at most one retry
 */
export class ReplyerService {
  readonly #options: ReplyerServiceOptions

  constructor(options: ReplyerServiceOptions) {
    this.#options = options
  }

  async generate(input: {
    turnId: string
    intent: LumiReplyIntent
    history: readonly LumiAgentContextMessage[]
    languageReferences?: ReplyLanguageReferences
    forbiddenPrivacyTokens?: readonly string[]
    signal?: AbortSignal
  }): Promise<ReplyerExecutionResult> {
    const recentAssistantTexts = input.history
      .filter(message => message.kind === 'dialogue_assistant')
      .flatMap(message => message.textSegments)
      .slice(-8)
    let issues: readonly string[] = []

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const messages = buildReplyerMessages({
        systemPrompt: this.#options.prompt.content,
        history: input.history,
        intent: input.intent,
        languageReferences: input.languageReferences,
        previousIssues: attempt === 1 ? issues : undefined,
        historyBudgetTokens: this.#options.historyBudgetTokens,
      })
      const startedAt = Date.now()
      const purpose = attempt === 0 ? 'replyer' : 'replyer_retry'
      let raw: string
      try {
        raw = await this.#options.model.generate(
          messages,
          purpose,
          input.signal,
        )
      }
      catch (error) {
        await this.#options.trace?.record({
          type: 'model_request',
          turnId: input.turnId,
          purpose,
          status: 'error',
          durationMs: Date.now() - startedAt,
          prompt: lumiPromptTemplateMetadata(this.#options.prompt),
          messageCount: messages.length,
          toolCount: 0,
          messages: this.#options.promptLoggingEnabled
            ? redactPromptMessages(messages)
            : undefined,
          errorMessage: (errorMessageFrom(error) ?? 'Replyer request failed').slice(0, 2_000),
          timestamp: Date.now(),
        })
        throw error
      }
      await this.#options.trace?.record({
        type: 'model_request',
        turnId: input.turnId,
        purpose,
        status: 'completed',
        durationMs: Date.now() - startedAt,
        prompt: lumiPromptTemplateMetadata(this.#options.prompt),
        messageCount: messages.length,
        toolCount: 0,
        messages: this.#options.promptLoggingEnabled
          ? redactPromptMessages(messages)
          : undefined,
        timestamp: Date.now(),
      })
      const reply = parseLumiVisibleReply(raw, {
        multiMessageEnabled: this.#options.multiMessageEnabled,
        maximumMessages: this.#options.maximumMessages,
        allowedExpressionIds: input.languageReferences?.expressions.map(reference => reference.id),
      }) ?? plainTextReply(raw)
      if (!reply) {
        issues = ['Replyer 没有返回符合约定的 JSON 消息文档。']
      }
      else {
        const validation = validateLumiVisibleReply({
          intent: input.intent,
          reply,
          forbiddenPrivacyTokens: [...(input.forbiddenPrivacyTokens ?? [])],
          recentAssistantTexts,
        })
        issues = validation.issues
        await this.#options.trace?.record({
          type: 'reply_validation',
          turnId: input.turnId,
          passed: validation.passed,
          issues,
          retryCount: attempt,
          timestamp: Date.now(),
        })
        if (validation.passed) {
          return {
            success: true,
            reply,
            issues: [],
            retryCount: attempt,
            promptMessages: this.#options.promptLoggingEnabled
              ? redactPromptMessages(messages)
              : undefined,
          }
        }
      }
    }

    await this.#options.trace?.record({
      type: 'reply_validation',
      turnId: input.turnId,
      passed: false,
      issues,
      retryCount: 1,
      timestamp: Date.now(),
    })
    return {
      success: false,
      issues,
      retryCount: 1,
    }
  }
}

function plainTextReply(raw: string): LumiVisibleReply | null {
  const text = raw.trim()
  const quotedReply = parseQuotedPlainTextReply(text)
  if (quotedReply)
    return quotedReply
  if (!text || text.startsWith('{') || text.startsWith('[') || text.startsWith('```'))
    return null
  return visibleReplyFromText(text)
}

/**
 * Parses the narrow non-JSON quote format occasionally emitted by chat models.
 *
 * Before:
 * - `[quoteMessageId: "message-1"]\n我听见了。`
 *
 * After:
 * - `{ messages: [{ quoteMessageId: "message-1", text: "我听见了。" }] }`
 */
function parseQuotedPlainTextReply(raw: string): LumiVisibleReply | null {
  const headerEndIndex = raw.indexOf(']')
  if (headerEndIndex < 1)
    return null
  const header = raw.slice(0, headerEndIndex + 1)
  const match = header.match(
    /^\[(?:quoteMessageId|quote_message_id)\s*:\s*(?:"([^"\r\n]{0,240})"|null)\]$/,
  )
  if (!match)
    return null
  const quoteMessageId = match[1]?.trim()
  const text = raw.slice(headerEndIndex + 1).trim()
  if (
    !text
    || text.startsWith('{')
    || text.startsWith('[')
    || text.startsWith('```')
  ) {
    return null
  }
  return {
    messages: [{
      text,
      quoteMessageId: quoteMessageId || undefined,
    }],
  }
}

function buildReplyerMessages(input: {
  systemPrompt: string
  history: readonly LumiAgentContextMessage[]
  intent: LumiReplyIntent
  languageReferences?: ReplyLanguageReferences
  previousIssues?: readonly string[]
  historyBudgetTokens?: number
}): LanguageModelMessage[] {
  const projected = projectReplyerHistory(input.history)
  const selected = projectReplyerHistory(selectContextWithinBudget(
    projected,
    Math.max(1, input.historyBudgetTokens ?? 256_000),
  ))
  const history = selected.map<LanguageModelMessage>((message) => {
    if (message.kind === 'dialogue_user') {
      return {
        role: 'user',
        content: message.text,
      }
    }
    if (message.kind === 'dialogue_assistant') {
      return {
        role: 'assistant',
        content: message.textSegments.join('\n\n'),
      }
    }
    return {
      role: 'system',
      content: `<已授权参考 类型="${message.referenceType}">\n${message.content}\n</已授权参考>`,
    }
  })

  return [
    {
      role: 'system',
      content: input.systemPrompt,
    },
    ...history,
    {
      role: 'user',
      content: JSON.stringify({
        task: '根据授权意图写出 Lumi 的最终私聊回复。',
        outputSchema: {
          messages: [{
            text: 'string',
            delayMs: 'optional number',
            quoteMessageId: 'optional string',
          }],
          appliedExpressionIds: [],
        },
        intent: input.intent,
        expressionReferences: (input.languageReferences?.expressions ?? []).slice(0, 3),
        behaviorReferences: (input.languageReferences?.behaviors ?? []).slice(0, 3),
        jargonReferences: (input.languageReferences?.jargon ?? []).slice(0, 3),
        retryIssues: input.previousIssues ?? [],
      }),
    },
  ]
}
