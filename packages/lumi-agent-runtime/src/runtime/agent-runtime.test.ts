import type { LumiCognitiveContextBundle, LumiReplyIntent } from '@proj-airi/lumi-runtime'

import type {
  AgentPersistencePort,
  AgentToolsPort,
  AgentTraceEvent,
  CognitiveContextPort,
  DialogueAssistantMessage,
  DialogueUserMessage,
  DirectOutboundAdapter,
  DirectPerceptionEnvelope,
  LanguageModelPort,
  LumiAgentRuntimeConfig,
  MemoryPort,
  PersistedSessionState,
  PlannerMessage,
  PlannerModelPort,
  PlannerToolCall,
  ReplyPolicyPort,
  SocialLanguagePort,
  StickerPort,
} from '../index'

import { createLumiWorkingMemory } from '@proj-airi/lumi-runtime'
import { describe, expect, it, vi } from 'vitest'

import { PlannerResponseFormatError } from '../ports/model'
import { LumiAgentRuntime } from './agent-runtime'

function envelope(index: number, text: string): DirectPerceptionEnvelope {
  return {
    eventId: `event-${index}`,
    conversationId: 'direct-doggy',
    personId: 'doggy',
    platform: 'qq',
    platformInstanceId: 'qq-main',
    externalUserId: '1770249418',
    timestamp: 1_700_000_000_000 + index,
    text,
    segments: [{ type: 'text', text }],
    attachments: [],
    sourceMessageId: `message-${index}`,
    participantPersonIds: ['doggy'],
    conversationType: 'direct',
  }
}

function cognitiveBundle(
  currentEnvelope: DirectPerceptionEnvelope,
  overrides: Partial<LumiCognitiveContextBundle> = {},
): LumiCognitiveContextBundle {
  const now = new Date(currentEnvelope.timestamp).toISOString()
  return {
    identity: {
      actorId: currentEnvelope.personId,
      personaId: 'lumi',
      conversationId: currentEnvelope.conversationId,
      conversationType: 'direct',
      participantUserIds: [...currentEnvelope.participantPersonIds],
    },
    workingMemory: createLumiWorkingMemory({
      personId: currentEnvelope.personId,
      personaId: 'lumi',
      conversationId: currentEnvelope.conversationId,
      conversationType: 'direct',
      now,
    }),
    stableFacts: [{
      id: 'memory-cognitive-1',
      userId: currentEnvelope.personId,
      personaId: 'lumi',
      conversationId: currentEnvelope.conversationId,
      type: 'user_fact',
      content: 'Doggy 正在维护 Patchright 浏览器链路',
      confidence: 0.94,
      importance: 0.8,
      emotionalIntensity: 0.1,
      relationshipRelevance: 0.5,
      createdAt: now,
      updatedAt: now,
      decay: 0,
      tags: ['Patchright'],
      status: 'active',
      scope: 'private',
      ownerType: 'user',
      ownerId: currentEnvelope.personId,
      visibility: 'private',
      participantUserIds: [...currentEnvelope.participantPersonIds],
      subjectUserIds: [currentEnvelope.personId],
      sensitivity: 'private',
      sourceActorId: currentEnvelope.personId,
      sourceConversationType: 'direct',
    }],
    tentativeImpressions: [],
    relevantEpisodes: [],
    userProfileProjection: {
      communicationPreferences: [],
      stableGoals: [],
      relevantTraits: [],
      currentState: [],
    },
    currentEmotion: { primary: 'neutral', intensity: 0.2 },
    interactionStrategies: ['直接回应当前问题'],
    expressionAssets: ['说“我看看”时保持自然简短'],
    contradictions: [],
    recallTrace: {
      ran: true,
      query: 'Patchright 浏览器链路',
      queryReason: 'contextual_query',
      reusedPreviousState: false,
      aclInputCount: 4,
      aclOutputCount: 1,
      lexicalCandidateCount: 2,
      annCandidateCount: 2,
      mergedCandidateCount: 3,
      rerankedCandidateCount: 1,
      thresholdRejectedCount: 2,
      conflictRejectedCount: 0,
      injectedCount: 1,
      durationMs: 12,
    },
    feedbackEvents: [],
    ...overrides,
  }
}

function toolCall(
  id: string,
  name: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): PlannerToolCall {
  return {
    id,
    name,
    arguments: argumentsValue,
  }
}

function replyCall(id = 'reply-1'): PlannerToolCall {
  return toolCall(id, 'reply', {
    targetMessageId: 'message-1',
    replyAct: 'answer',
    semanticGoal: '自然回应当前消息',
    keyPoints: ['保持简短'],
    referenceInfo: [],
  })
}

function plannerStep(toolCalls: readonly PlannerToolCall[] = []) {
  return {
    content: '',
    toolCalls,
    modelName: 'fake-planner',
  }
}

function createPersistence() {
  const sessions = new Map<string, PersistedSessionState>()
  const port: AgentPersistencePort = {
    loadSession: vi.fn(async conversationId => sessions.get(conversationId)),
    saveSession: vi.fn(async (state) => {
      sessions.set(state.conversationId, structuredClone(state))
    }),
    listWaitingSessionIds: vi.fn(async () =>
      [...sessions.values()]
        .filter(session => session.waitState?.continuation)
        .map(session => session.conversationId),
    ),
  }
  return { port, sessions }
}

function replyPolicy(): ReplyPolicyPort {
  return {
    async resolveIntent({ proposal }) {
      return {
        shouldReply: true,
        targetMessageId: proposal.targetMessageId,
        replyAct: 'answer',
        semanticGoal: proposal.semanticGoal,
        keyPoints: [...proposal.keyPoints],
        referenceInfo: [...proposal.referenceInfo],
        attitude: {
          willingnessToHelp: 'normal',
        },
        emotion: {
          primary: 'neutral',
          intensity: 0.2,
        },
        defenseState: {
          active: false,
        },
        expressionIntent: {
          focus: proposal.expressionIntent?.focus ?? 'current message',
          scene: proposal.expressionIntent?.scene ?? 'casual private chat',
          tone: proposal.expressionIntent?.tone ?? 'natural',
          desiredLength: proposal.expressionIntent?.desiredLength ?? 'short',
          preferredActs: [...(proposal.expressionIntent?.preferredActs ?? [])],
          avoid: [...(proposal.expressionIntent?.avoid ?? [])],
        },
        immutableConstraints: [],
      } satisfies LumiReplyIntent
    },
  }
}

function createHarness(input: {
  plannerModel: PlannerModelPort
  config?: LumiAgentRuntimeConfig
  replyTexts?: string[]
  replyOutputs?: string[]
  memoryQuery?: MemoryPort['query']
  cognitive?: CognitiveContextPort
  sticker?: StickerPort
  tools?: AgentToolsPort
  socialLanguage?: SocialLanguagePort
  replyPolicy?: ReplyPolicyPort
  trace?: (event: AgentTraceEvent) => void
  persistence?: ReturnType<typeof createPersistence>
}) {
  const persistence = input.persistence ?? createPersistence()
  let sentIndex = 0
  const sentTexts: string[] = []
  const outboundResult = () => ({
    messageId: `sent-${++sentIndex}`,
    timestamp: Date.now(),
  })
  const outboundAdapter: DirectOutboundAdapter = {
    sendText: vi.fn(async (payload) => {
      sentTexts.push(payload.text)
      return outboundResult()
    }),
    sendImage: vi.fn(async () => outboundResult()),
    sendSticker: vi.fn(async () => outboundResult()),
    sendVoice: vi.fn(async () => outboundResult()),
    sendAt: vi.fn(async () => outboundResult()),
    sendQuote: vi.fn(async () => outboundResult()),
  }
  const replyTexts = [...(input.replyTexts ?? ['收到'])]
  const replyOutputs = [...(input.replyOutputs ?? [])]
  const generate = vi.fn<LanguageModelPort['generate']>(async (messages, purpose) => {
    if (purpose === 'context_summary') {
      const payload = JSON.parse(messages[1]?.content ?? '{}') as { coverageToken?: string }
      return JSON.stringify({
        summary: 'Doggy and Lumi kept the active project and unresolved decision for continuity.',
        coverageToken: payload.coverageToken,
      })
    }
    return replyOutputs.shift() ?? JSON.stringify({
      messages: [{ text: replyTexts.shift() ?? '收到' }],
      appliedExpressionIds: [],
    })
  })
  const languageModel = { generate }
  const runtime = new LumiAgentRuntime({
    config: {
      mergeWindowMs: 0,
      ...input.config,
    },
    plannerModel: input.plannerModel,
    languageModel,
    persistence: persistence.port,
    identity: {
      getPersonProfile: vi.fn(async () => ({
        personId: 'doggy',
        displayName: 'Doggy',
        facts: ['Lumi的朋友'],
      })),
    },
    cognitive: input.cognitive,
    memory: input.memoryQuery
      ? {
          query: input.memoryQuery,
        }
      : undefined,
    replyPolicy: input.replyPolicy ?? replyPolicy(),
    socialLanguage: input.socialLanguage,
    sticker: input.sticker,
    tools: input.tools,
    trace: input.trace
      ? { record: input.trace }
      : undefined,
    outboundAdapter,
    outboundAudit: {
      record: vi.fn(),
    },
  })
  return {
    runtime,
    persistence,
    languageModel,
    outboundAdapter,
    sentTexts,
  }
}

describe('lumiAgentRuntime direct session', () => {
  // ROOT CAUSE:
  //
  // Memory was available only as an explicit Planner tool while profile,
  // relationship, and learned-language stores injected unrelated references.
  // A normal turn therefore had no automatic recall and Replyer could receive
  // duplicate or overly broad context.
  //
  // We fixed this with one host cognitive port that prepares an ACL-filtered
  // bundle before Planner and projects a separate narrow expression reference.
  /** @example Automatic recall precedes Planner and Replyer receives no memory body. */
  it('prepares one cognitive bundle before Planner and narrows the Replyer projection', async () => {
    const currentEnvelope = envelope(1, 'Patchright 现在怎么样了')
    const order: string[] = []
    const traces: AgentTraceEvent[] = []
    const recordContextUse = vi.fn<NonNullable<CognitiveContextPort['recordContextUse']>>(async () => {})
    const prepareTurn = vi.fn<CognitiveContextPort['prepareTurn']>(async (input) => {
      order.push('cognitive')
      expect(input.envelope.personId).toBe('doggy')
      expect(input.recentTurns.at(-1)).toMatchObject({
        role: 'user',
        personId: 'doggy',
        textSegments: ['Patchright 现在怎么样了'],
      })
      return cognitiveBundle(currentEnvelope)
    })
    const generateStep = vi.fn<PlannerModelPort['generateStep']>(async () => {
      order.push('planner')
      return plannerStep([replyCall()])
    })
    const plannerModel = { generateStep }
    const harness = createHarness({
      plannerModel,
      cognitive: { prepareTurn, recordContextUse },
      trace: event => traces.push(event),
    })

    const result = await harness.runtime.ingestDirect(currentEnvelope)

    expect(result.endReason).toBe('reply_sent')
    expect(order).toEqual(['cognitive', 'planner'])
    const plannerMessages = plannerModel.generateStep.mock.calls[0]?.[0].messages ?? []
    expect(plannerMessages.some(message =>
      message.content.includes('Doggy 正在维护 Patchright 浏览器链路'),
    )).toBe(true)
    const replyerMessages = harness.languageModel.generate.mock.calls[0]?.[0] ?? []
    expect(replyerMessages.some(message =>
      message.content.includes('说“我看看”时保持自然简短'),
    )).toBe(true)
    expect(replyerMessages.every(message =>
      !message.content.includes('Doggy 正在维护 Patchright 浏览器链路'),
    )).toBe(true)
    expect(recordContextUse).toHaveBeenCalledWith(expect.objectContaining({
      envelope: currentEnvelope,
      memoryIds: ['memory-cognitive-1'],
    }))
    expect(traces.find(event => event.type === 'automatic_recall')).toMatchObject({
      status: 'completed',
      recall: {
        ran: true,
        query: undefined,
        injectedCount: 1,
      },
    })
  })

  // ROOT CAUSE:
  //
  // A mutable desktop user selection or a faulty adapter could return context
  // for another person after ingress authentication. Trusting that projection
  // would leak private memory into the current Planner prompt.
  //
  // We fixed this by checking actor, conversation, participants, and working
  // memory against the immutable direct envelope before any reference is added.
  /** @example A mismatched actor falls back without exposing its cognitive body. */
  it('rejects a cognitive bundle for another actor and safely uses the legacy fallback', async () => {
    const currentEnvelope = envelope(1, '还记得我的项目吗')
    const traces: AgentTraceEvent[] = []
    const foreignBundle = cognitiveBundle(currentEnvelope, {
      identity: {
        actorId: 'moussy',
        personaId: 'lumi',
        conversationId: currentEnvelope.conversationId,
        conversationType: 'direct',
        participantUserIds: ['doggy'],
      },
      stableFacts: [{
        ...cognitiveBundle(currentEnvelope).stableFacts[0]!,
        id: 'moussy-private-memory',
        content: 'Moussy 的私密信息绝不能泄漏',
      }],
    })
    const generateStep = vi.fn<PlannerModelPort['generateStep']>()
      .mockResolvedValueOnce(plannerStep([replyCall()]))
    const plannerModel = { generateStep }
    const harness = createHarness({
      plannerModel,
      cognitive: {
        prepareTurn: vi.fn(async () => foreignBundle),
      },
      trace: event => traces.push(event),
    })

    const result = await harness.runtime.ingestDirect(currentEnvelope)

    expect(result.endReason).toBe('reply_sent')
    const plannerMessages = plannerModel.generateStep.mock.calls[0]?.[0].messages ?? []
    expect(plannerMessages.every(message =>
      !message.content.includes('Moussy 的私密信息绝不能泄漏'),
    )).toBe(true)
    expect(plannerMessages.some(message => message.content.includes('Doggy'))).toBe(true)
    expect(traces.find(event => event.type === 'automatic_recall')).toMatchObject({
      status: 'fallback',
      recall: {
        ran: false,
        fallbackReason: 'cognitive_context_unavailable',
      },
    })
  })

  /** @example Explicit history lookup remains a real tool call after shallow recall. */
  it('retains explicit deep memory search when automatic shallow recall is enabled', async () => {
    const currentEnvelope = envelope(1, '你从记忆里查一查你的生日')
    const memoryQuery = vi.fn<MemoryPort['query']>(async () => [{
      id: 'memory-birthday',
      content: 'Lumi 的生日是 7 月 21 日',
      scope: 'lumi_self' as const,
      status: 'active' as const,
      confidence: 0.98,
      provenance: { sourceMessageId: 'birthday-message' },
      authorizationReason: 'Lumi self fact is visible in this direct chat',
    }])
    const plannerModel = {
      generateStep: vi.fn()
        .mockImplementationOnce(async (input: Parameters<PlannerModelPort['generateStep']>[0]) => {
          expect(input.tools.map(tool => tool.name)).toEqual(['query_memory'])
          return plannerStep([
            toolCall('memory-birthday', 'query_memory', { query: 'Lumi 的生日' }),
          ])
        })
        .mockResolvedValueOnce(plannerStep([replyCall()])),
    }
    const harness = createHarness({
      plannerModel,
      memoryQuery,
      cognitive: {
        prepareTurn: vi.fn(async () => cognitiveBundle(currentEnvelope)),
      },
    })

    const result = await harness.runtime.ingestDirect(currentEnvelope)

    expect(result.endReason).toBe('reply_sent')
    expect(memoryQuery).toHaveBeenCalledOnce()
    expect(plannerModel.generateStep).toHaveBeenCalledTimes(2)
  })

  // ROOT CAUSE:
  //
  // A host relationship gate could require refusal while preserving the
  // Planner's original "answer" reply act. Replyer then received conflicting
  // instructions and could fail validation twice, leaving AstrBot with no
  // outbound message.
  //
  // We fixed this at the shared reply-tool boundary so every host normalizes a
  // refusal-required intent before expression selection and Replyer generation.
  it('normalizes a defense-gated answer into a model-generated refusal', async () => {
    const plannerModel = {
      generateStep: vi.fn().mockResolvedValueOnce(plannerStep([replyCall()])),
    }
    const defensePolicy: ReplyPolicyPort = {
      async resolveIntent({ proposal }) {
        return {
          shouldReply: true,
          targetMessageId: proposal.targetMessageId,
          replyAct: 'answer',
          semanticGoal: proposal.semanticGoal,
          keyPoints: [],
          referenceInfo: [],
          attitude: { willingnessToHelp: 'refuse' },
          emotion: { primary: 'defensive', intensity: 0.8 },
          defenseState: { active: true, refusalRequired: true },
          expressionIntent: {
            focus: 'current message',
            scene: 'private chat',
            tone: 'defensive',
            desiredLength: 'short',
            preferredActs: [],
            avoid: [],
          },
          immutableConstraints: [],
        }
      },
    }
    const harness = createHarness({
      plannerModel,
      replyPolicy: defensePolicy,
      replyOutputs: [JSON.stringify({
        messages: [{ text: '先到这，我现在不想顺着这个话题说。' }],
        appliedExpressionIds: [],
      })],
    })

    const result = await harness.runtime.ingestDirect(envelope(1, '继续说'))

    expect(result.endReason).toBe('reply_sent')
    expect(harness.outboundAdapter.sendText).toHaveBeenCalledOnce()
    expect(harness.sentTexts).toEqual(['先到这，我现在不想顺着这个话题说。'])
    const [messages] = harness.languageModel.generate.mock.calls[0]!
    expect(messages.at(-1)?.content).toContain('"replyAct":"refuse"')
  })

  /**
   * @example
   * expect(replyerPayload.expressionReferences).toHaveLength(1)
   */
  it('injects selected expression, behavior, and jargon assets into the real Replyer request', async () => {
    const plannerModel = {
      generateStep: vi.fn().mockResolvedValueOnce(plannerStep([replyCall()])),
    }
    const socialLanguage: SocialLanguagePort = {
      plannerReferences: vi.fn(async () => []),
      replyReferences: vi.fn<SocialLanguagePort['replyReferences']>(async () => ({
        expressions: [{
          id: 'expression-1',
          kind: 'expression',
          content: '复活辣 | 轻松确认恢复 | playful confirmation',
          confidence: 0.96,
        }],
        behaviors: [{
          id: 'behavior-1',
          kind: 'behavior',
          content: '对方确认状态 -> 简短回应',
          confidence: 0.9,
        }],
        jargon: [{
          id: 'jargon-1',
          kind: 'jargon',
          content: '复活: 恢复正常',
          confidence: 0.94,
        }],
      })),
      observeDirectFeedback: vi.fn(async () => {}),
      recordSentReply: vi.fn(async () => {}),
    }
    const harness = createHarness({
      plannerModel,
      socialLanguage,
      config: {
        promptLoggingEnabled: true,
      },
      replyOutputs: [JSON.stringify({
        messages: [{ text: '嗯，满血复活了' }],
        appliedExpressionIds: ['expression-1'],
      })],
    })

    await harness.runtime.ingestDirect(envelope(1, '你复活了吗'))

    const [messages, purpose] = harness.languageModel.generate.mock.calls[0]!
    const payloadMessage = messages.at(-1)
    expect(purpose).toBe('replyer')
    expect(payloadMessage?.role).toBe('user')

    const payload = JSON.parse(payloadMessage?.content ?? '{}') as {
      expressionReferences?: Array<{ id: string }>
      behaviorReferences?: Array<{ id: string }>
      jargonReferences?: Array<{ id: string }>
    }
    expect(payload.expressionReferences?.map(reference => reference.id)).toEqual(['expression-1'])
    expect(payload.behaviorReferences?.map(reference => reference.id)).toEqual(['behavior-1'])
    expect(payload.jargonReferences?.map(reference => reference.id)).toEqual(['jargon-1'])
    expect(socialLanguage.recordSentReply).toHaveBeenCalledWith(expect.objectContaining({
      selectedReferenceIds: ['expression-1', 'behavior-1', 'jargon-1'],
      replyerPromptSnapshot: expect.any(Array),
    }))
  })

  /** @example The next verified turn receives exact prior expression and behavior IDs for feedback. */
  it('persists actual social asset IDs into the next cognitive feedback turn', async () => {
    const preparedTurns: Parameters<CognitiveContextPort['prepareTurn']>[0][] = []
    const feedbackEvent = {
      id: 'feedback-2',
      actorId: 'doggy',
      conversationId: 'direct-doggy',
      conversationType: 'direct' as const,
      kind: 'explicit_praise' as const,
      sourceId: 'message-2',
      evidenceId: 'evidence-2',
      targetIds: ['expression-1', 'behavior-1', 'sent-1'],
      strength: 1,
      occurredAt: '2026-07-29T10:00:00.000Z',
      authorVerified: true,
      scope: 'private' as const,
      sensitivity: 'private' as const,
    }
    const prepareTurn = vi.fn<CognitiveContextPort['prepareTurn']>(async (input) => {
      preparedTurns.push(input)
      return cognitiveBundle(input.envelope, {
        feedbackEvents: input.envelope.sourceMessageId === 'message-2' ? [feedbackEvent] : [],
      })
    })
    const socialLanguage: SocialLanguagePort = {
      plannerReferences: vi.fn(async () => []),
      replyReferences: vi.fn<SocialLanguagePort['replyReferences']>(async () => ({
        expressions: [{ id: 'expression-1', kind: 'expression', content: '自然短句' }],
        behaviors: [{ id: 'behavior-1', kind: 'behavior', content: '先接住当前情绪' }],
        jargon: [{ id: 'jargon-1', kind: 'jargon', content: '炸了：出问题' }],
      })),
      observeDirectFeedback: vi.fn(async () => {}),
      recordSentReply: vi.fn(async () => {}),
    }
    const harness = createHarness({
      plannerModel: {
        generateStep: vi.fn()
          .mockResolvedValueOnce(plannerStep([replyCall('reply-first')]))
          .mockResolvedValueOnce(plannerStep([replyCall('reply-second')])),
      },
      cognitive: { prepareTurn },
      socialLanguage,
      replyOutputs: [
        JSON.stringify({
          messages: [{ text: '第一条回复' }],
          appliedExpressionIds: ['expression-1'],
        }),
        JSON.stringify({
          messages: [{ text: '第二条回复' }],
          appliedExpressionIds: [],
        }),
      ],
    })

    await harness.runtime.ingestDirect(envelope(1, '先回复一次'))
    await harness.runtime.ingestDirect(envelope(2, '这次不错'))

    expect(preparedTurns[1]?.recentTurns.find(turn => turn.role === 'assistant')).toMatchObject({
      feedbackTargetIds: ['expression-1', 'behavior-1'],
    })
    expect(socialLanguage.observeDirectFeedback).toHaveBeenLastCalledWith(expect.objectContaining({
      feedbackEvents: [feedbackEvent],
    }))
  })

  it('stops the turn after a successful reply even when old Maibot finalization is configured', async () => {
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce(plannerStep([replyCall()])),
    }
    const harness = createHarness({
      plannerModel,
      config: {
        plannerFinalizationMode: 'maibot',
      },
    })

    const result = await harness.runtime.ingestDirect(envelope(1, '在吗'))

    expect(result.endReason).toBe('reply_sent')
    expect(result.sentMessageIds).toEqual(['sent-1'])
    expect(harness.sentTexts).toEqual(['收到'])
    expect(plannerModel.generateStep).toHaveBeenCalledOnce()
    expect(harness.languageModel.generate).toHaveBeenCalledOnce()
  })

  it('allows only one reply invocation when Planner emits concurrent reply calls', async () => {
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce(plannerStep([
          replyCall('reply-first'),
          replyCall('reply-duplicate'),
        ])),
    }
    const harness = createHarness({ plannerModel })

    const result = await harness.runtime.ingestDirect(envelope(1, '在吗'))

    expect(result.endReason).toBe('reply_sent')
    expect(harness.sentTexts).toEqual(['收到'])
    expect(harness.languageModel.generate).toHaveBeenCalledOnce()
    expect(plannerModel.generateStep).toHaveBeenCalledOnce()
  })

  it('accepts a natural plain-text Replyer response without a JSON-format retry', async () => {
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce(plannerStep([replyCall()])),
    }
    const harness = createHarness({
      plannerModel,
      replyOutputs: ['我在呢'],
    })

    const result = await harness.runtime.ingestDirect(envelope(1, '在吗'))

    expect(result.endReason).toBe('reply_sent')
    expect(harness.sentTexts).toEqual(['我在呢'])
    expect(harness.languageModel.generate).toHaveBeenCalledOnce()
  })

  it('accepts a quoted plain-text Replyer response and preserves its source message', async () => {
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce(plannerStep([replyCall()])),
    }
    const harness = createHarness({
      plannerModel,
      replyOutputs: [
        '[quoteMessageId: "message-1"]\n我听见了。\n\n别急，翻页了，过来吧。',
      ],
    })

    const result = await harness.runtime.ingestDirect(envelope(1, '你听见了吗'))

    expect(result.endReason).toBe('reply_sent')
    expect(harness.sentTexts).toEqual(['我听见了。\n\n别急，翻页了，过来吧。'])
    expect(harness.outboundAdapter.sendQuote).toHaveBeenCalledOnce()
    expect(harness.outboundAdapter.sendQuote).toHaveBeenCalledWith(
      expect.objectContaining({ sourceMessageId: 'message-1' }),
    )
    expect(harness.languageModel.generate).toHaveBeenCalledOnce()
  })

  it('accepts a same-line quoted Replyer response with an empty quote target', async () => {
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce(plannerStep([replyCall()])),
    }
    const harness = createHarness({
      plannerModel,
      replyOutputs: [
        '[quoteMessageId: null] 我没说翻篇，我是说刚才那页。',
      ],
    })

    const result = await harness.runtime.ingestDirect(envelope(1, '你什么翻篇了'))

    expect(result.endReason).toBe('reply_sent')
    expect(harness.sentTexts).toEqual(['我没说翻篇，我是说刚才那页。'])
    expect(harness.outboundAdapter.sendQuote).not.toHaveBeenCalled()
    expect(harness.languageModel.generate).toHaveBeenCalledOnce()
  })

  it('allows the multi-stage reply tool to outlive the ordinary tool timeout', async () => {
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce(plannerStep([replyCall()])),
    }
    const harness = createHarness({
      plannerModel,
      config: {
        toolStepTimeoutMs: 10,
      },
    })
    harness.languageModel.generate.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 25))
      return JSON.stringify({
        messages: [{ text: '我还在。' }],
        appliedExpressionIds: [],
      })
    })

    const result = await harness.runtime.ingestDirect(envelope(1, '你还在吗'))

    expect(result.endReason).toBe('reply_sent')
    expect(harness.sentTexts).toEqual(['我还在。'])
    expect(result.failure).toBeUndefined()
  })

  it('does not treat an arbitrary bracketed Replyer payload as visible text', async () => {
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce(plannerStep([replyCall()])),
    }
    const harness = createHarness({
      plannerModel,
      replyOutputs: [
        '[memory_write]\nstatus: checking',
        '[memory_write]\nstatus: stored',
      ],
    })

    const result = await harness.runtime.ingestDirect(envelope(1, '你好'))

    expect(result.endReason).toBe('planner_finished')
    expect(result.failure?.code).toBe('REPLYER_VALIDATION_FAILED')
    expect(harness.sentTexts).toEqual([])
    expect(harness.outboundAdapter.sendText).not.toHaveBeenCalled()
    expect(harness.languageModel.generate).toHaveBeenCalledTimes(2)
  })

  it('does not restart Planner after one bounded Replyer correction fails', async () => {
    const plannerModel = {
      generateStep: vi.fn(async () => plannerStep([replyCall()])),
    }
    const harness = createHarness({
      plannerModel,
      replyOutputs: ['{"messages":', '{"messages":'],
    })

    const result = await harness.runtime.ingestDirect(envelope(1, '在吗'))

    expect(result.endReason).toBe('planner_finished')
    expect(result.failure?.code).toBe('REPLYER_VALIDATION_FAILED')
    expect(harness.sentTexts).toEqual([])
    expect(harness.languageModel.generate).toHaveBeenCalledTimes(2)
    expect(plannerModel.generateStep).toHaveBeenCalledOnce()
  })

  it('reminds Planner to use tools after an accidental plain-text answer', async () => {
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce({
          content: '这段正文不能直接发给用户',
          toolCalls: [],
          modelName: 'fake-planner',
        })
        .mockResolvedValueOnce(plannerStep([replyCall()])),
    }
    const harness = createHarness({
      plannerModel,
      config: {
        plannerNoToolRetryLimit: 2,
        plannerFinalizationMode: 'stop_after_successful_reply',
      },
    })

    const result = await harness.runtime.ingestDirect(envelope(1, '你好'))

    expect(result.endReason).toBe('reply_sent')
    expect(plannerModel.generateStep).toHaveBeenCalledTimes(2)
    const retryMessages = plannerModel.generateStep.mock.calls[1]?.[0].messages as PlannerMessage[]
    expect(retryMessages.at(-1)?.content).toContain('上一轮没有调用任何工具')
    expect(harness.sentTexts).toEqual(['收到'])
  })

  it('retries a malformed Planner tool response instead of failing the direct turn', async () => {
    const plannerModel = {
      generateStep: vi.fn()
        .mockRejectedValueOnce(new PlannerResponseFormatError('invalid tool arguments'))
        .mockResolvedValueOnce(plannerStep([replyCall()])),
    }
    const harness = createHarness({
      plannerModel,
      config: {
        plannerNoToolRetryLimit: 2,
        plannerFinalizationMode: 'stop_after_successful_reply',
      },
    })

    const result = await harness.runtime.ingestDirect(envelope(1, '你好'))

    expect(result.endReason).toBe('reply_sent')
    expect(plannerModel.generateStep).toHaveBeenCalledTimes(2)
    const retryMessages = plannerModel.generateStep.mock.calls[1]?.[0].messages as PlannerMessage[]
    expect(retryMessages.at(-1)?.content).toContain('工具调用参数不是合法 JSON 对象')
    expect(harness.sentTexts).toEqual(['收到'])
  })

  it('feeds an authorized memory tool result back to Planner before replying', async () => {
    const traces: AgentTraceEvent[] = []
    const memoryQuery = vi.fn<MemoryPort['query']>(async () => [{
      id: 'memory-1',
      content: 'Lumi的生日是7月21日',
      scope: 'lumi_self' as const,
      status: 'active' as const,
      confidence: 0.95,
      provenance: { sourceMessageId: 'old-message' },
      authorizationReason: 'Lumi self fact is visible in this direct chat',
    }])
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce(plannerStep([
          toolCall('memory-1', 'query_memory', { query: 'Lumi生日' }),
        ]))
        .mockResolvedValueOnce(plannerStep([replyCall()])),
    }
    const harness = createHarness({
      plannerModel,
      memoryQuery,
      trace: event => traces.push(event),
    })

    await harness.runtime.ingestDirect(envelope(1, '你生日什么时候'))

    expect(memoryQuery).toHaveBeenCalledOnce()
    expect(plannerModel.generateStep).toHaveBeenCalledTimes(2)
    expect(plannerModel.generateStep.mock.calls.every(call =>
      call[0].toolChoice === 'required',
    )).toBe(true)
    const secondMessages = plannerModel.generateStep.mock.calls[1]?.[0].messages as PlannerMessage[]
    const memoryResult = secondMessages.find(message =>
      message.role === 'tool' && message.toolName === 'query_memory')
    expect(memoryResult?.content).toContain('7月21日')
    const memoryToolTraces = traces.filter((
      event,
    ): event is Extract<AgentTraceEvent, { type: 'tool_execution' }> =>
      event.type === 'tool_execution'
      && event.toolName === 'query_memory')
    expect(memoryToolTraces.map(event => event.status)).toEqual(['started', 'succeeded'])
    expect(harness.sentTexts).toEqual(['收到'])
  })

  // ROOT CAUSE:
  //
  // Tool progress only exposed the tool name and execution status. The desktop
  // gateway therefore invented fixed action phrases instead of forwarding the
  // Planner's public text for the current step.
  //
  // We fixed this by carrying only the first visible sentence from Planner
  // `content` on the started trace. Planner `reasoning` remains private.
  /** @example A Planner status sentence is attached to the matching tool start. */
  it('attaches the first public Planner sentence to tool-start progress', async () => {
    const traces: AgentTraceEvent[] = []
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce({
          content: '第6个 bili_46589789225 未封禁，继续处理。\n后面的说明不应作为进度发送。',
          reasoning: '这是不能发送到 QQ 的隐藏推理。',
          toolCalls: [toolCall('browser-1', 'browser_click', { selector: '#confirm' })],
          modelName: 'fake-planner',
        })
        .mockResolvedValueOnce(plannerStep([replyCall()])),
    }
    const harness = createHarness({
      plannerModel,
      tools: {
        registerTools(registry) {
          registry.register({
            name: 'browser_click',
            description: 'Clicks one browser element.',
            inputSchema: {
              type: 'object',
              properties: { selector: { type: 'string' } },
              required: ['selector'],
              additionalProperties: false,
            },
            provider: 'test',
            visibility: 'visible',
            stage: 'planner',
            chatScope: 'direct',
            riskLevel: 'low',
            executionMode: 'automatic',
            sideEffectType: 'write',
            idempotencyPolicy: 'optional',
            requiredScopes: [],
            async handler() {
              return { success: true, output: { clicked: true } }
            },
          })
        },
      },
      trace: event => traces.push(event),
    })

    await harness.runtime.ingestDirect(envelope(1, '继续处理这些账号'))

    const startedTrace = traces.find(event =>
      event.type === 'tool_execution'
      && event.toolName === 'browser_click'
      && event.status === 'started',
    )
    expect(startedTrace).toMatchObject({
      publicProgressText: '第6个 bili_46589789225 未封禁，继续处理。',
    })
    expect(JSON.stringify(startedTrace)).not.toContain('隐藏推理')
  })

  // ROOT CAUSE:
  //
  // `toolChoice: required` only required one of the advertised tools. When the
  // user explicitly said "从记忆里查", the provider could still choose `reply`
  // immediately and let Replyer claim that Lumi already knew the answer.
  //
  // We fixed this by declaring explicit command fragments on ToolSpec and
  // exposing only the requested tool until a real result enters the turn.
  it('requires a real memory query before reply for an explicit memory command', async () => {
    const memoryQuery = vi.fn<MemoryPort['query']>(async () => [{
      id: 'memory-birthday',
      content: 'Lumi 的生日是 7 月 21 日',
      scope: 'lumi_self' as const,
      status: 'active' as const,
      confidence: 0.98,
      provenance: { sourceMessageId: 'birthday-message' },
      authorizationReason: 'Lumi self fact is visible in this direct chat',
    }])
    const plannerModel = {
      generateStep: vi.fn()
        .mockImplementationOnce(async (input: Parameters<PlannerModelPort['generateStep']>[0]) => {
          expect(input.tools.map(tool => tool.name)).toEqual(['query_memory'])
          expect(input.messages.at(-1)?.content).toContain('当前必须先实际调用其中的工具')
          return plannerStep([
            toolCall('memory-birthday', 'query_memory', { query: 'Lumi 的生日' }),
          ])
        })
        .mockImplementationOnce(async (input: Parameters<PlannerModelPort['generateStep']>[0]) => {
          expect(input.tools.map(tool => tool.name)).toContain('reply')
          return plannerStep([replyCall()])
        }),
    }
    const harness = createHarness({ plannerModel, memoryQuery })

    const result = await harness.runtime.ingestDirect(
      envelope(1, '你从记忆里查一查你的生日'),
    )

    expect(result.endReason).toBe('reply_sent')
    expect(memoryQuery).toHaveBeenCalledOnce()
    expect(plannerModel.generateStep).toHaveBeenCalledTimes(2)
    expect(harness.sentTexts).toEqual(['收到'])
  })

  // ROOT CAUSE:
  //
  // A successful tool call reset the no-tool retry counter. When the remaining
  // Planner rounds returned no tool calls, the loop could exhaust its round
  // budget before reaching the existing recovery reply. The authorized tool
  // result also stayed Planner-only, so a synthetic Replyer call could not use
  // the fact that had just been retrieved.
  //
  // We fixed this by reserving the final round for a real reply-tool recovery
  // and explicitly carrying this turn's bounded tool evidence into Replyer.
  it('finalizes with authorized tool evidence when Planner exhausts rounds after a memory query', async () => {
    const memoryQuery = vi.fn<MemoryPort['query']>(async () => [{
      id: 'memory-birthday',
      content: 'Lumi的生日是7月21日',
      scope: 'lumi_self' as const,
      status: 'active' as const,
      confidence: 0.98,
      provenance: { sourceMessageId: 'birthday-message' },
      authorizationReason: 'Lumi self fact is visible in this direct chat',
    }])
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce(plannerStep([
          toolCall('memory-birthday', 'query_memory', { query: 'Lumi生日' }),
        ]))
        .mockResolvedValue(plannerStep()),
    }
    const harness = createHarness({
      plannerModel,
      memoryQuery,
      config: {
        plannerMaxRounds: 3,
        plannerNoToolRetryLimit: 2,
      },
    })

    const result = await harness.runtime.ingestDirect(envelope(1, '你从记忆里查一查你的生日'))

    expect(result.endReason).toBe('reply_sent')
    expect(result.failure).toBeUndefined()
    expect(memoryQuery).toHaveBeenCalledOnce()
    expect(plannerModel.generateStep).toHaveBeenCalledTimes(3)
    expect(harness.languageModel.generate).toHaveBeenCalledOnce()
    const replyerMessages = harness.languageModel.generate.mock.calls[0]?.[0] ?? []
    expect(replyerMessages.some(message => message.content.includes('Lumi的生日是7月21日'))).toBe(true)
    expect(harness.sentTexts).toHaveLength(1)
  })

  // ROOT CAUSE:
  //
  // A tool could complete successfully, then the next Planner request could
  // fail while observing that result. The session-level catch converted the
  // exception into a generic PLANNER_NO_REPLY result and never gave Replyer
  // the authorized evidence that had already been collected.
  //
  // We fixed this by recording the real turn failure and attempting one
  // model-generated recovery reply from the current turn's tool evidence.
  it('recovers with memory evidence when Planner fails after a successful tool call', async () => {
    const memoryQuery = vi.fn<MemoryPort['query']>(async () => [{
      id: 'memory-birthday',
      content: 'Lumi的生日是7月21日',
      scope: 'lumi_self' as const,
      status: 'active' as const,
      confidence: 0.98,
      provenance: { sourceMessageId: 'birthday-message' },
      authorizationReason: 'Lumi self fact is visible in this direct chat',
    }])
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce(plannerStep([
          toolCall('memory-birthday', 'query_memory', { query: 'Lumi生日' }),
        ]))
        .mockRejectedValueOnce(new Error('provider rejected the tool continuation')),
    }
    const harness = createHarness({ plannerModel, memoryQuery })

    const result = await harness.runtime.ingestDirect(envelope(1, '你从记忆里查一查你的生日'))

    expect(result.endReason).toBe('reply_sent')
    expect(result.failure).toBeUndefined()
    expect(memoryQuery).toHaveBeenCalledOnce()
    expect(harness.languageModel.generate).toHaveBeenCalledOnce()
    const replyerMessages = harness.languageModel.generate.mock.calls[0]?.[0] ?? []
    expect(replyerMessages.some(message => message.content.includes('Lumi的生日是7月21日'))).toBe(true)
    expect(harness.sentTexts).toHaveLength(1)
  })

  it('finalizes after every Planner round is used for tools', async () => {
    let callIndex = 0
    const execute = vi.fn(async () => ({ observation: `step-${callIndex}` }))
    const tools: AgentToolsPort = {
      registerTools(registry) {
        registry.register({
          name: 'observe_external_state',
          description: 'Observe external state',
          inputSchema: { type: 'object', properties: {} },
          provider: 'test',
          visibility: 'visible',
          stage: 'planner',
          chatScope: 'direct',
          riskLevel: 'low',
          executionMode: 'automatic',
          sideEffectType: 'read',
          idempotencyPolicy: 'optional',
          requiredScopes: [],
          async handler() {
            return {
              success: true,
              output: await execute(),
            }
          },
        })
      },
    }
    const plannerModel = {
      generateStep: vi.fn(async () => plannerStep([
        toolCall(`observe-${++callIndex}`, 'observe_external_state', {}),
      ])),
    }
    const harness = createHarness({
      plannerModel,
      tools,
      config: { plannerMaxRounds: 3 },
    })

    const result = await harness.runtime.ingestDirect(envelope(1, '连续观察后告诉我结果'))

    expect(result.endReason).toBe('reply_sent')
    expect(result.failure).toBeUndefined()
    expect(plannerModel.generateStep).toHaveBeenCalledTimes(3)
    expect(execute).toHaveBeenCalledTimes(3)
    expect(harness.languageModel.generate).toHaveBeenCalledOnce()
    const replyerMessages = harness.languageModel.generate.mock.calls[0]?.[0] ?? []
    expect(replyerMessages.some(message => message.content.includes('step-3'))).toBe(true)
    expect(harness.sentTexts).toHaveLength(1)
  })

  it('resumes Planner after a wait timeout', async () => {
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce(plannerStep([
          toolCall('wait-1', 'wait', { seconds: 0.01 }),
        ]))
        .mockResolvedValueOnce(plannerStep([replyCall()])),
    }
    const harness = createHarness({ plannerModel })

    const result = await harness.runtime.ingestDirect(envelope(1, '等一下'))

    expect(result.endReason).toBe('reply_sent')
    expect(plannerModel.generateStep).toHaveBeenCalledTimes(2)
    const secondMessages = plannerModel.generateStep.mock.calls[1]?.[0].messages as PlannerMessage[]
    expect(secondMessages.some(message =>
      message.role === 'tool'
      && message.toolName === 'wait'
      && message.content.includes('timeout'),
    )).toBe(true)
  })

  it('wakes wait with a new message and preserves both user messages in the same turn', async () => {
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce(plannerStep([
          toolCall('wait-1', 'wait', { seconds: 60 }),
        ]))
        .mockResolvedValueOnce(plannerStep([replyCall()])),
    }
    const harness = createHarness({ plannerModel })

    const first = harness.runtime.ingestDirect(envelope(1, '我想想'))
    await waitUntil(() => {
      const session = harness.persistence.sessions.get('direct-doggy')
      return session?.waitState?.toolCallId === 'wait-1'
    })
    const second = harness.runtime.ingestDirect(envelope(2, '想好了'))
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult.turnId).toBe(secondResult.turnId)
    expect(harness.sentTexts).toEqual(['收到'])
    const secondMessages = plannerModel.generateStep.mock.calls[1]?.[0].messages as PlannerMessage[]
    expect(secondMessages.filter(message => message.role === 'user').map(message => message.content)).toEqual(
      expect.arrayContaining(['我想想', '想好了']),
    )
  })

  it('re-arms a persisted wait after restart and resumes Planner with the next message', async () => {
    const persistence = createPersistence()
    const originalEnvelope = envelope(1, '等我一下')
    persistence.sessions.set('direct-doggy', {
      conversationId: 'direct-doggy',
      contextEpoch: 0,
      summaryVersion: 0,
      stablePrefixHash: '',
      dialogueSegmentId: 'dialogue:0',
      generation: 1,
      history: [],
      waitState: {
        toolCallId: 'wait-before-restart',
        startedAt: Date.now(),
        targetSeconds: 60,
        deadlineAt: Date.now() + 60_000,
        continuation: {
          turnId: 'event-1:g1',
          generation: 1,
          plannerRound: 1,
          envelope: originalEnvelope,
          replied: false,
          sentMessageIds: [],
        },
      },
      completedEvents: [],
    })
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce(plannerStep([replyCall('reply-after-restart')])),
    }
    const harness = createHarness({ plannerModel, persistence })

    await harness.runtime.resumePersistedSessions()
    const result = await harness.runtime.ingestDirect(envelope(2, '我回来了'))

    expect(result.endReason).toBe('reply_sent')
    expect(harness.sentTexts).toEqual(['收到'])
    expect(persistence.sessions.get('direct-doggy')?.waitState).toBeUndefined()
    const plannerMessages = plannerModel.generateStep.mock.calls[0]?.[0].messages as PlannerMessage[]
    expect(plannerMessages.some(message =>
      message.role === 'user'
      && message.content.includes('工具="wait"')
      && message.content.includes('restoredAfterRestart'),
    )).toBe(true)
  })

  it('discards an interrupted Planner result even when the model ignores AbortSignal', async () => {
    let resolveFirst: ((value: ReturnType<typeof plannerStep>) => void) | undefined
    const firstStep = new Promise<ReturnType<typeof plannerStep>>((resolve) => {
      resolveFirst = resolve
    })
    const plannerModel = {
      generateStep: vi.fn()
        .mockImplementationOnce(async () => await firstStep)
        .mockResolvedValueOnce(plannerStep([replyCall('reply-new')])),
    }
    const harness = createHarness({ plannerModel, replyTexts: ['新消息回复'] })

    const first = harness.runtime.ingestDirect(envelope(1, '旧消息'))
    await waitUntil(() => plannerModel.generateStep.mock.calls.length === 1)
    const second = harness.runtime.ingestDirect(envelope(2, '新消息'))
    resolveFirst?.(plannerStep([replyCall('reply-stale')]))
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult.endReason).toBe('interrupted')
    expect(secondResult.endReason).toBe('reply_sent')
    expect(harness.sentTexts).toEqual(['新消息回复'])
    expect(harness.outboundAdapter.sendText).toHaveBeenCalledOnce()
  })

  it('continues with a newer message when an interrupted Planner never settles', async () => {
    // ROOT CAUSE:
    //
    // Passing AbortSignal alone did not release the session when a provider
    // ignored cancellation. The old Planner request then blocked every newer
    // direct message in the same conversation.
    //
    // We fixed the model boundary so cancellation wins the request race even
    // when the provider promise never resolves.
    const neverFinishes = new Promise<never>(() => {})
    const plannerModel = {
      generateStep: vi.fn()
        .mockImplementationOnce(async () => await neverFinishes)
        .mockResolvedValueOnce(plannerStep([replyCall('reply-new')])),
    }
    const harness = createHarness({ plannerModel, replyTexts: ['new reply'] })

    const first = harness.runtime.ingestDirect(envelope(1, 'old message'))
    await waitUntil(() => plannerModel.generateStep.mock.calls.length === 1)
    const second = harness.runtime.ingestDirect(envelope(2, 'new message'))
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult.endReason).toBe('interrupted')
    expect(secondResult.endReason).toBe('reply_sent')
    expect(harness.sentTexts).toEqual(['new reply'])
    expect(harness.outboundAdapter.sendText).toHaveBeenCalledOnce()
  })

  it('continues with a newer message when an interrupted Replyer never settles', async () => {
    // ROOT CAUSE:
    //
    // The reply tool had a long timeout and relied on its model adapter to
    // honor AbortSignal. One ignored cancellation could therefore make Lumi
    // appear completely silent after the user sent a follow-up message.
    //
    // The executor now treats parent cancellation as a terminal race result.
    const plannerModel = {
      generateStep: vi.fn(async () => plannerStep([replyCall()])),
    }
    const harness = createHarness({ plannerModel, replyTexts: ['new reply'] })
    const neverFinishes = new Promise<never>(() => {})
    harness.languageModel.generate
      .mockImplementationOnce(async () => await neverFinishes)
      .mockResolvedValueOnce(JSON.stringify({
        messages: [{ text: 'new reply' }],
        appliedExpressionIds: [],
      }))

    const first = harness.runtime.ingestDirect(envelope(1, 'old message'))
    await waitUntil(() => harness.languageModel.generate.mock.calls.length === 1)
    const second = harness.runtime.ingestDirect(envelope(2, 'new message'))
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult.endReason).toBe('interrupted')
    expect(secondResult.endReason).toBe('reply_sent')
    expect(harness.sentTexts).toEqual(['new reply'])
    expect(harness.outboundAdapter.sendText).toHaveBeenCalledOnce()
  })

  it('retries invalid Replyer output once and never sends Planner content as fallback', async () => {
    const plannerModel = {
      generateStep: vi.fn()
        .mockResolvedValueOnce({
          content: '这段 Planner 文本绝不能发送',
          toolCalls: [replyCall()],
        })
        .mockResolvedValueOnce(plannerStep()),
    }
    const harness = createHarness({ plannerModel })
    harness.languageModel.generate
      .mockReset()
      .mockResolvedValueOnce('{"messages":')
      .mockResolvedValueOnce('{"messages":')

    const result = await harness.runtime.ingestDirect(envelope(1, '你好'))

    expect(result.sentMessageIds).toHaveLength(0)
    expect(harness.languageModel.generate).toHaveBeenCalledTimes(2)
    expect(plannerModel.generateStep).toHaveBeenCalledOnce()
    expect(harness.outboundAdapter.sendText).not.toHaveBeenCalled()
    expect(harness.sentTexts).not.toContain('这段 Planner 文本绝不能发送')
  })

  it('sends at most one eligible sticker after visible text and respects cooldown', async () => {
    const now = Date.now()
    const sticker: StickerPort = {
      findCandidates: vi.fn(async () => [
        {
          id: 'recent-high-score',
          localPath: 'recent.png',
          labels: ['开心'],
          score: 0.99,
          sentCount: 1,
          lastSentAt: now,
        },
        {
          id: 'eligible',
          localPath: 'eligible.png',
          labels: ['开心'],
          score: 0.8,
          sentCount: 2,
          lastSentAt: now - 60 * 60 * 1_000,
        },
      ]),
      recordSent: vi.fn(async () => undefined),
    }
    const plannerModel = {
      generateStep: vi.fn(async () => plannerStep([
        toolCall('reply-sticker', 'reply', {
          targetMessageId: 'message-1',
          replyAct: 'answer',
          semanticGoal: '开心回应',
          stickerIntent: {
            enabled: true,
            emotionOrScene: '开心',
          },
        }),
      ])),
    }
    const harness = createHarness({ plannerModel, sticker })

    const result = await harness.runtime.ingestDirect(envelope(1, '好耶'))

    expect(result.sentMessageIds).toEqual(['sent-1', 'sent-2'])
    expect(harness.outboundAdapter.sendSticker).toHaveBeenCalledOnce()
    expect(harness.outboundAdapter.sendSticker).toHaveBeenCalledWith(
      expect.objectContaining({ stickerId: 'eligible' }),
    )
    expect(sticker.recordSent).toHaveBeenCalledWith(expect.objectContaining({
      stickerId: 'eligible',
    }))
  })

  // ROOT CAUSE:
  //
  // A no-tool Planner response was eventually converted into a synthetic reply
  // call with no authorized tool evidence. For factual requests such as memory
  // lookup, Replyer could then invent an answer while the UI showed no query.
  //
  // We fixed this by requiring a Planner action at the provider boundary and
  // failing closed if the provider still emits no tool call.
  it('does not synthesize a reply after Planner exhausts no-tool retries without evidence', async () => {
    const sticker: StickerPort = {
      findCandidates: vi.fn(async () => []),
      recordSent: vi.fn(async () => undefined),
    }
    const plannerModel = {
      generateStep: vi.fn(async (
        _input: Parameters<PlannerModelPort['generateStep']>[0],
      ) => plannerStep()),
    }
    const harness = createHarness({ plannerModel, sticker })

    const result = await harness.runtime.ingestDirect(envelope(1, '先别回'))

    expect(result.endReason).toBe('failed')
    expect(result.failure?.code).toBe('PLANNER_TOOL_SELECTION_REQUIRED')
    expect(plannerModel.generateStep).toHaveBeenCalledTimes(3)
    expect(plannerModel.generateStep.mock.calls.every(call =>
      call[0].toolChoice === 'required',
    )).toBe(true)
    expect(harness.languageModel.generate).not.toHaveBeenCalled()
    expect(harness.outboundAdapter.sendText).not.toHaveBeenCalled()
    expect(harness.sentTexts).toEqual([])
    expect(harness.outboundAdapter.sendSticker).not.toHaveBeenCalled()
    expect(sticker.findCandidates).not.toHaveBeenCalled()
  })

  it('hides deferred host tools when deferred discovery is disabled', async () => {
    const generateStep = vi.fn(async (
      _input: Parameters<PlannerModelPort['generateStep']>[0],
    ) => plannerStep())
    const plannerModel = {
      generateStep,
    }
    const tools: AgentToolsPort = {
      registerTools(registry) {
        registry.register({
          name: 'mcp_deferred_example',
          description: 'Deferred example',
          inputSchema: { type: 'object', properties: {} },
          provider: 'test',
          visibility: 'deferred',
          stage: 'planner',
          chatScope: 'direct',
          riskLevel: 'low',
          executionMode: 'automatic',
          sideEffectType: 'read',
          idempotencyPolicy: 'none',
          requiredScopes: [],
          async handler() {
            return { success: true }
          },
        })
      },
    }
    const harness = createHarness({
      plannerModel,
      tools,
      config: { deferredToolsEnabled: false },
    })

    await harness.runtime.ingestDirect(envelope(1, '不用外部工具'))

    const firstCall = generateStep.mock.calls.at(0)
    expect(firstCall).toBeDefined()
    const definitions = firstCall?.[0].tools ?? []
    expect(definitions.map(tool => tool.name)).not.toContain('tool_search')
    expect(definitions.map(tool => tool.name)).not.toContain('mcp_deferred_example')
  })

  it('disables precise expression selection and direct feedback independently', async () => {
    const socialLanguage: SocialLanguagePort = {
      plannerReferences: vi.fn(async () => []),
      replyReferences: vi.fn(async () => ({
        expressions: [],
        behaviors: [],
        jargon: [],
      })),
      observeDirectFeedback: vi.fn(async () => undefined),
      recordSentReply: vi.fn(async () => undefined),
    }
    const plannerModel = {
      generateStep: vi.fn(async () => plannerStep([replyCall()])),
    }
    const harness = createHarness({
      plannerModel,
      socialLanguage,
      config: {
        expressionSelectorEnabled: false,
        directLanguageFeedbackEnabled: false,
      },
    })

    await harness.runtime.ingestDirect(envelope(1, '自然说就好'))

    expect(socialLanguage.replyReferences).toHaveBeenCalledWith(expect.objectContaining({
      expressionSelectorEnabled: false,
    }))
    expect(socialLanguage.observeDirectFeedback).not.toHaveBeenCalled()
  })

  it('records prompt version and hash without prompt bodies by default', async () => {
    const traces: AgentTraceEvent[] = []
    const plannerModel = {
      generateStep: vi.fn(async () => plannerStep([replyCall()])),
    }
    const harness = createHarness({
      plannerModel,
      trace: event => traces.push(event),
    })

    await harness.runtime.ingestDirect(envelope(1, 'apiKey=private-value'))

    const requests = traces.filter(event => event.type === 'model_request')
    expect(requests.map(event => event.purpose)).toEqual(['planner', 'replyer'])
    expect(requests.every(event => event.prompt.version.length > 0)).toBe(true)
    expect(requests.every(event => event.prompt.hash.startsWith('fnv1a32:'))).toBe(true)
    expect(requests.every(event => event.messages === undefined)).toBe(true)
    expect(JSON.stringify(requests)).not.toContain('private-value')
  })

  it('redacts sensitive values when private prompt logging is explicitly enabled', async () => {
    const traces: AgentTraceEvent[] = []
    const plannerModel = {
      generateStep: vi.fn(async () => plannerStep([replyCall()])),
    }
    const harness = createHarness({
      plannerModel,
      config: { promptLoggingEnabled: true },
      trace: event => traces.push(event),
    })

    await harness.runtime.ingestDirect(envelope(1, 'apiKey=private-value'))

    const serialized = JSON.stringify(traces.filter(event => event.type === 'model_request'))
    expect(serialized).toContain('[REDACTED]')
    expect(serialized).not.toContain('private-value')
  })

  // ROOT CAUSE:
  //
  // Context compaction used to persist only a continuity reference. The
  // medium cognitive loop never received the grounded source range, so old
  // dialogue disappeared from typed history without becoming an episode.
  //
  // We fixed this by notifying the host cognitive port after an accepted idle
  // checkpoint, while keeping consolidation failure outside the reply path.
  /** @example An accepted idle checkpoint becomes one host-owned episode. */
  it('consolidates a successful context checkpoint after the visible reply', async () => {
    const persistence = createPersistence()
    const history = Array.from({ length: 18 }, (_, index): DialogueUserMessage | DialogueAssistantMessage => {
      const timestamp = 1_700_000_000_000 + index
      if (index % 2 === 0) {
        return {
          id: `history-user:${index}`,
          kind: 'dialogue_user',
          messageId: `history-message:${index}`,
          personId: 'doggy',
          text: `user history ${index}`,
          segments: [{ type: 'text', text: `user history ${index}` }],
          attachments: [],
          timestamp,
          countInContext: true,
          remainingUses: null,
          source: 'test',
          visibility: 'both',
          provenance: {
            origin: 'test',
            sourceIds: [`history-message:${index}`],
          },
        }
      }
      return {
        id: `history-assistant:${index}`,
        kind: 'dialogue_assistant',
        messageIds: [`history-message:${index}`],
        textSegments: [`assistant history ${index}`],
        appliedExpressionIds: [],
        timestamp,
        countInContext: true,
        remainingUses: null,
        source: 'test',
        visibility: 'both',
        provenance: {
          origin: 'test',
          sourceIds: [`history-message:${index}`],
        },
      }
    })
    persistence.sessions.set('direct-doggy', {
      conversationId: 'direct-doggy',
      contextEpoch: 0,
      summaryVersion: 0,
      stablePrefixHash: '',
      dialogueSegmentId: 'dialogue:0',
      generation: 0,
      history,
      completedEvents: [],
    })
    const consolidateEpisode = vi.fn<NonNullable<CognitiveContextPort['consolidateEpisode']>>(async () => {})
    const currentEnvelope = envelope(20, 'continue the project')
    const harness = createHarness({
      persistence,
      plannerModel: {
        generateStep: vi.fn(async () => plannerStep([replyCall()])),
      },
      cognitive: {
        prepareTurn: vi.fn(async () => cognitiveBundle(currentEnvelope)),
        consolidateEpisode,
      },
      config: {
        contextCompactionIdleMs: 0,
        contextCompactionThresholdMessages: 16,
        contextRecentMessages: 8,
      },
    })

    const result = await harness.runtime.ingestDirect(currentEnvelope)
    await waitUntil(() => consolidateEpisode.mock.calls.length === 1)

    expect(result.endReason).toBe('reply_sent')
    expect(consolidateEpisode).toHaveBeenCalledWith(expect.objectContaining({
      identity: cognitiveBundle(currentEnvelope).identity,
      episodeId: 'dialogue:1:summary:1',
      summary: 'Doggy and Lumi kept the active project and unresolved decision for continuity.',
    }))
    expect(consolidateEpisode.mock.calls[0]?.[0].sourceMessageIds).toContain('history-message:0')
  })

  it('deduplicates the same platform event while it is in flight', async () => {
    let resolvePlanner: ((value: ReturnType<typeof plannerStep>) => void) | undefined
    const pendingPlanner = new Promise<ReturnType<typeof plannerStep>>((resolve) => {
      resolvePlanner = resolve
    })
    const plannerModel = {
      generateStep: vi.fn(async () => await pendingPlanner),
    }
    const harness = createHarness({ plannerModel })
    const duplicated = envelope(1, '只处理一次')

    const first = harness.runtime.ingestDirect(duplicated)
    const second = harness.runtime.ingestDirect(structuredClone(duplicated))
    await waitUntil(() => plannerModel.generateStep.mock.calls.length === 1)
    resolvePlanner?.(plannerStep([replyCall()]))
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(firstResult).toEqual(secondResult)
    expect(plannerModel.generateStep).toHaveBeenCalledOnce()
    expect(harness.outboundAdapter.sendText).toHaveBeenCalledOnce()
  })

  it('deduplicates a completed platform event after restoring the session', async () => {
    const firstPlanner = {
      generateStep: vi.fn(async () => plannerStep([replyCall()])),
    }
    const firstHarness = createHarness({ plannerModel: firstPlanner })
    const duplicated = envelope(1, '落盘后也只处理一次')
    const firstResult = await firstHarness.runtime.ingestDirect(duplicated)
    await firstHarness.runtime.drain()
    const persisted = firstHarness.persistence.sessions.get(duplicated.conversationId)
    expect(persisted?.completedEvents).toHaveLength(1)

    const secondPlanner = {
      generateStep: vi.fn(async () => plannerStep([replyCall()])),
    }
    const sentTexts: string[] = []
    const restoredRuntime = new LumiAgentRuntime({
      config: {
        mergeWindowMs: 0,
        plannerFinalizationMode: 'stop_after_successful_reply',
      },
      plannerModel: secondPlanner,
      languageModel: {
        generate: vi.fn(async () => JSON.stringify({
          messages: [{ text: '不应该发送' }],
          appliedExpressionIds: [],
        })),
      },
      persistence: firstHarness.persistence.port,
      identity: {
        getPersonProfile: vi.fn(async () => ({
          personId: 'doggy',
          displayName: 'Doggy',
          facts: [],
        })),
      },
      replyPolicy: replyPolicy(),
      outboundAdapter: {
        sendText: vi.fn(async (payload) => {
          sentTexts.push(payload.text)
          return { messageId: 'unexpected', timestamp: Date.now() }
        }),
        sendImage: vi.fn(),
        sendSticker: vi.fn(),
        sendVoice: vi.fn(),
        sendAt: vi.fn(),
        sendQuote: vi.fn(),
      },
      outboundAudit: {
        record: vi.fn(),
      },
    })

    const restoredResult = await restoredRuntime.ingestDirect(structuredClone(duplicated))

    expect(restoredResult).toEqual(firstResult)
    expect(secondPlanner.generateStep).not.toHaveBeenCalled()
    expect(sentTexts).toEqual([])
  })
})

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('Timed out waiting for test condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
