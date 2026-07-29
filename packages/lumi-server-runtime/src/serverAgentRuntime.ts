import type {
  AgentMemoryReference,
  AgentMemoryScope,
  AgentPersistencePort,
  AgentPersonProfile,
  AgentToolsPort,
  AgentTraceEvent,
  DialogueAssistantMessage,
  DialogueUserMessage,
  DirectOutboundAdapter,
  DirectOutboundResult,
  DirectPerceptionEnvelope,
  LanguageModelPort,
  LumiAgentContextMessage,
  LumiAgentRuntimeConfig,
  LumiPromptTemplate,
  LumiPromptTemplateId,
  OutboundSecurityAudit,
  PlannerModelPort,
  ReplyPolicyPort,
} from '@proj-airi/lumi-agent-runtime'
import type { LumiOnlineMessage } from '@proj-airi/lumi-online'
import type {
  LanguageLearningConfig,
  LumiHelpWillingness,
  LumiMemoryFragment,
} from '@proj-airi/lumi-runtime'

import type { LumiPersonStateKind, LumiServerDatabase } from './database'
import type {
  LumiReplyContext,
  LumiReplyGenerator,
  LumiReplyMessage,
} from './onlineServer'

import { randomUUID } from 'node:crypto'

import {
  buildDefaultPlannerSystemPrompt,
  buildDefaultReplyerSystemPrompt,
  LumiAgentRuntime,
} from '@proj-airi/lumi-agent-runtime'

import { createServerSocialLanguagePort } from './agentSocialLanguage'
import { LUMI_PERSONA_ID } from './database'
import { createServerCognitiveContextPort } from './serverCognitive'

export interface LumiServerAgentRuntimeOptions {
  database: LumiServerDatabase
  plannerModel: PlannerModelPort
  languageModel: LanguageModelPort
  personaPrompt: string
  runtime?: LumiAgentRuntimeConfig
  tools?: AgentToolsPort
  languageLearning?: Partial<LanguageLearningConfig>
  promptTemplates?: Partial<Record<LumiPromptTemplateId, LumiPromptTemplate>>
  semanticMemorySearch?: (
    request: Parameters<LumiServerDatabase['listAccessibleMemories']>[0],
    limit: number,
  ) => Promise<LumiMemoryFragment[]>
}

/**
 * Creates the server adapter for the shared host-managed Lumi Agent Runtime.
 *
 * Use when:
 * - A committed private online message should enter the shared Planner loop
 * - Server SQLite, MCP, plugins, memory, and identity remain authoritative
 *
 * Expects:
 * - The surrounding online server has already authenticated membership
 * - Group conversations are routed to read-only observation, never this adapter
 *
 * Returns:
 * - A compatibility reply generator containing one or more independently
 *   persisted messages produced through the explicit `reply` tool
 */
export function createLumiServerAgentReplyGenerator(
  options: LumiServerAgentRuntimeOptions,
): LumiReplyGenerator {
  const personaPrompt = requiredText(options.personaPrompt, 'personaPrompt', 200_000)
  const outbound = new CapturingServerOutbound()
  const identity = createIdentityPort(options.database)
  const socialLanguage = createServerSocialLanguagePort({
    database: options.database,
    model: options.languageModel,
    config: options.languageLearning,
    promptTemplates: options.promptTemplates,
  })
  const runtime = new LumiAgentRuntime({
    config: {
      ...options.runtime,
      plannerSystemPrompt: options.runtime?.plannerSystemPrompt
        ?? options.promptTemplates?.planner?.content
        ?? buildDefaultPlannerSystemPrompt(personaPrompt),
      plannerPromptVersion: options.runtime?.plannerPromptVersion
        ?? options.promptTemplates?.planner?.version,
      replyerSystemPrompt: options.runtime?.replyerSystemPrompt
        ?? options.promptTemplates?.replyer?.content
        ?? buildDefaultReplyerSystemPrompt(personaPrompt),
      replyerPromptVersion: options.runtime?.replyerPromptVersion
        ?? options.promptTemplates?.replyer?.version,
      contextSummarySystemPrompt: options.runtime?.contextSummarySystemPrompt
        ?? options.promptTemplates?.context_summary?.content,
      contextSummaryPromptVersion: options.runtime?.contextSummaryPromptVersion
        ?? options.promptTemplates?.context_summary?.version,
    },
    plannerModel: options.plannerModel,
    languageModel: options.languageModel,
    persistence: databasePersistence(options.database),
    identity,
    cognitive: createServerCognitiveContextPort(options),
    memory: createMemoryPort(options),
    replyPolicy: createReplyPolicy(options.database),
    socialLanguage,
    tools: options.tools,
    trace: {
      record(event) {
        recordTrace(options.database, event)
      },
    },
    outboundAdapter: outbound,
    outboundAudit: {
      record(audit) {
        recordOutboundAudit(options.database, audit)
      },
    },
  })
  const ready = runtime.resumePersistedSessions()

  return {
    async generate(context, emitDelta) {
      await ready
      if (context.conversation.type !== 'direct')
        throw new Error('Shared Lumi Agent Runtime accepts direct conversations only')
      const personId = context.input.actorPersonId
      if (!personId)
        throw new Error('Online user input is missing its authenticated actor')
      synchronizeSession(options.database, context)
      const envelope = directEnvelope(context, personId)
      outbound.begin(envelope)
      try {
        const result = await runtime.ingestDirect(envelope)
        if (result.endReason === 'failed' || result.endReason === 'interrupted')
          throw new Error(`Lumi Agent Runtime ended with ${result.endReason}`)
        const messages = outbound.finish(envelope.conversationId)
        for (const message of messages)
          emitDelta(message.content)
        return { messages }
      }
      catch (error) {
        outbound.cancel(envelope.conversationId)
        throw error
      }
    },
  }
}

class CapturingServerOutbound implements DirectOutboundAdapter {
  readonly #captures = new Map<string, {
    personId: string
    messages: LumiReplyMessage[]
    pendingQuoteMessageId?: string
  }>()

  begin(envelope: DirectPerceptionEnvelope): void {
    if (this.#captures.has(envelope.conversationId))
      throw new Error('A server outbound capture is already active for this conversation')
    this.#captures.set(envelope.conversationId, {
      personId: envelope.personId,
      messages: [],
    })
  }

  finish(conversationId: string): readonly LumiReplyMessage[] {
    const capture = this.#captures.get(conversationId)
    if (!capture)
      throw new Error('Server outbound capture is not active')
    this.#captures.delete(conversationId)
    return capture.messages
  }

  cancel(conversationId: string): void {
    this.#captures.delete(conversationId)
  }

  async sendText(payload: Parameters<DirectOutboundAdapter['sendText']>[0]) {
    const capture = this.#capture(payload)
    const messageId = randomUUID()
    capture.messages.push({
      messageId,
      content: payload.text,
      delayMs: payload.delayMs,
      quoteMessageId: capture.pendingQuoteMessageId,
    })
    capture.pendingQuoteMessageId = undefined
    return outboundResult(messageId)
  }

  async sendQuote(payload: Parameters<DirectOutboundAdapter['sendQuote']>[0]) {
    const capture = this.#capture(payload)
    capture.pendingQuoteMessageId = payload.sourceMessageId
    return outboundResult(`quote:${payload.sourceMessageId}`)
  }

  async sendImage(
    payload: Parameters<DirectOutboundAdapter['sendImage']>[0],
  ): Promise<DirectOutboundResult> {
    this.#capture(payload)
    throw new Error('Online structured image output is not available in this protocol version')
  }

  async sendSticker(
    payload: Parameters<DirectOutboundAdapter['sendSticker']>[0],
  ): Promise<DirectOutboundResult> {
    this.#capture(payload)
    throw new Error('Online structured sticker output is handled by the platform adapter')
  }

  async sendVoice(
    payload: Parameters<DirectOutboundAdapter['sendVoice']>[0],
  ): Promise<DirectOutboundResult> {
    this.#capture(payload)
    throw new Error('Online voice output is generated by the client device')
  }

  async sendAt(
    payload: Parameters<DirectOutboundAdapter['sendAt']>[0],
  ): Promise<DirectOutboundResult> {
    this.#capture(payload)
    throw new Error('Direct online conversations do not support at-mentions')
  }

  #capture(payload: { conversationId: string, personId: string }) {
    const capture = this.#captures.get(payload.conversationId)
    if (!capture || capture.personId !== payload.personId)
      throw new Error('Outbound operation has no matching authenticated server capture')
    return capture
  }
}

function databasePersistence(database: LumiServerDatabase): AgentPersistencePort {
  return {
    async loadSession(conversationId) {
      return database.loadAgentSession(conversationId)
    },
    async saveSession(state) {
      database.saveAgentSession(state)
    },
    async listWaitingSessionIds() {
      return database.listWaitingAgentSessionIds()
    },
  }
}

function createIdentityPort(database: LumiServerDatabase) {
  return {
    async getPersonProfile(input: {
      personId: string
      conversationId: string
      viewerPersonId: string
    }): Promise<AgentPersonProfile | undefined> {
      if (input.personId !== input.viewerPersonId)
        return undefined
      const person = database.listPeople().find(candidate => candidate.id === input.personId)
      if (!person)
        return undefined
      const states = personStates(database, input.personId)
      return {
        personId: person.id,
        displayName: person.displayName,
        facts: states
          .filter(state => state.kind === 'profile')
          .map(state => JSON.stringify(state.payload)),
        relationshipState: serializedState(states, 'relationship'),
        shortTermState: serializedState(states, 'short-term'),
        emotionState: serializedState(states, 'emotion'),
      }
    },
  }
}

function createMemoryPort(options: LumiServerAgentRuntimeOptions) {
  return {
    async query(input: {
      query: string
      personId: string
      conversationId: string
      participantPersonIds: readonly string[]
      scopes?: readonly AgentMemoryScope[]
      limit: number
      signal?: AbortSignal
    }): Promise<readonly AgentMemoryReference[]> {
      if (input.signal?.aborted)
        throw input.signal.reason ?? new Error('Memory query aborted')
      const request = {
        query: input.query,
        userId: input.personId,
        personaId: LUMI_PERSONA_ID,
        limit: input.limit,
        conversationType: 'direct' as const,
        viewerUserId: input.personId,
        conversationId: input.conversationId,
        participantUserIds: [...input.participantPersonIds],
      }
      let memories: LumiMemoryFragment[]
      try {
        memories = options.semanticMemorySearch
          ? await options.semanticMemorySearch(request, input.limit)
          : options.database.listAccessibleMemories(request, input.limit)
      }
      catch {
        memories = options.database.listAccessibleMemories(request, input.limit)
      }
      const requestedScopes = input.scopes ? new Set(input.scopes) : undefined
      return memories
        .map(memoryReference)
        .filter(memory => !requestedScopes || requestedScopes.has(memory.scope))
        .slice(0, input.limit)
    },
  }
}

function createReplyPolicy(database: LumiServerDatabase): ReplyPolicyPort {
  return {
    async resolveIntent({ proposal, envelope }) {
      const states = personStates(database, envelope.personId)
      const emotion = statePayload(states, 'emotion')
      const relationship = statePayload(states, 'relationship')
      const shortTerm = statePayload(states, 'short-term')
      const defenseActive = booleanFrom(shortTerm, ['defenseActive', 'defense_active'])
        || booleanFrom(relationship, ['defenseActive', 'defense_active'])
      const refusalRequired = booleanFrom(shortTerm, ['refusalRequired', 'refusal_required'])
        || booleanFrom(relationship, ['refusalRequired', 'refusal_required'])
      const shouldReply = proposal.replyAct !== 'stay_silent'
      return {
        shouldReply,
        targetMessageId: proposal.targetMessageId,
        replyAct: proposal.replyAct,
        semanticGoal: proposal.semanticGoal,
        keyPoints: [...proposal.keyPoints],
        referenceInfo: [...proposal.referenceInfo],
        attitude: {
          towardTarget: stringFrom(relationship, ['towardTarget', 'toward_target']),
          stance: stringFrom(relationship, ['stance']),
          willingnessToHelp: willingnessFrom(relationship),
        },
        emotion: {
          primary: stringFrom(emotion, ['primary', 'emotion', 'mood']) ?? 'neutral',
          intensity: numberFrom(emotion, ['intensity']) ?? 0.35,
          secondary: stringArrayFrom(emotion, ['secondary']),
        },
        defenseState: {
          active: defenseActive,
          level: numberFrom(shortTerm, ['defenseLevel', 'defense_level']),
          reason: stringFrom(shortTerm, ['defenseReason', 'defense_reason']),
          refusalRequired,
          prohibitedHelpTypes: stringArrayFrom(shortTerm, ['prohibitedHelpTypes', 'prohibited_help_types']),
        },
        expressionIntent: {
          focus: proposal.expressionIntent?.focus ?? proposal.semanticGoal,
          scene: proposal.expressionIntent?.scene ?? 'private_chat',
          tone: proposal.expressionIntent?.tone ?? 'natural',
          desiredLength: proposal.expressionIntent?.desiredLength ?? 'short',
          preferredActs: [...(proposal.expressionIntent?.preferredActs ?? [])],
          avoid: [
            ...(proposal.expressionIntent?.avoid ?? []),
            '固定套话',
            '逐字重复以前的拒绝回复',
          ],
        },
        immutableConstraints: [
          '不得泄露其他人的私聊或私密记忆。',
          ...(refusalRequired
            ? ['保持拒绝边界，不提供被禁止的帮助。']
            : []),
        ],
      }
    },
    async forbiddenPrivacyTokens() {
      return []
    },
  }
}

function synchronizeSession(database: LumiServerDatabase, context: LumiReplyContext): void {
  const current = database.loadAgentSession(context.conversation.id)
  if (!current) {
    database.saveAgentSession({
      conversationId: context.conversation.id,
      contextEpoch: 0,
      summaryVersion: 0,
      stablePrefixHash: '',
      dialogueSegmentId: 'dialogue:0',
      generation: 0,
      history: dialogueHistory(context.history.filter(message => message.id !== context.input.id)),
      completedEvents: [],
    })
    return
  }
  const knownMessageIds = new Set(current.history.flatMap((message) => {
    if (message.kind === 'dialogue_user')
      return [message.messageId]
    if (message.kind === 'dialogue_assistant')
      return [...message.messageIds]
    return []
  }))
  const missing = context.history.filter(message =>
    message.id !== context.input.id
    && !knownMessageIds.has(message.id),
  )
  if (missing.length === 0)
    return
  database.saveAgentSession({
    ...current,
    history: [...current.history, ...dialogueHistory(missing)],
  })
}

function dialogueHistory(messages: readonly LumiOnlineMessage[]): LumiAgentContextMessage[] {
  const history: LumiAgentContextMessage[] = []
  for (const message of messages) {
    if (message.role === 'user' && message.actorPersonId) {
      history.push({
        id: `user:${message.id}`,
        kind: 'dialogue_user',
        messageId: message.id,
        personId: message.actorPersonId,
        text: visiblePerceptionText(message.content),
        segments: [{ type: 'text', text: visiblePerceptionText(message.content) }],
        attachments: [],
        timestamp: message.createdAt,
        countInContext: true,
        remainingUses: null,
        source: 'lumi-online',
        visibility: 'both',
        provenance: {
          origin: 'server_message_history',
          sourceIds: [message.id],
        },
      } satisfies DialogueUserMessage)
      continue
    }
    if (message.role === 'assistant') {
      history.push({
        id: `assistant:${message.id}`,
        kind: 'dialogue_assistant',
        messageIds: [message.id],
        textSegments: [message.content],
        appliedExpressionIds: [],
        timestamp: message.createdAt,
        countInContext: true,
        remainingUses: null,
        source: 'lumi',
        visibility: 'both',
        provenance: {
          origin: 'server_message_history',
          sourceIds: [message.id],
        },
      } satisfies DialogueAssistantMessage)
    }
  }
  return history
}

function directEnvelope(context: LumiReplyContext, personId: string): DirectPerceptionEnvelope {
  const text = visiblePerceptionText(context.input.content)
  return {
    eventId: context.input.id,
    conversationId: context.conversation.id,
    personId,
    platform: 'lumi-online',
    platformInstanceId: 'lumi-server',
    externalUserId: personId,
    timestamp: context.input.createdAt,
    text,
    segments: [{ type: 'text', text }],
    attachments: [],
    sourceMessageId: context.input.id,
    participantPersonIds: [...context.conversation.participantPersonIds],
    conversationType: 'direct',
  }
}

/**
 * Normalizes AstrBot's trusted perception envelope for dialogue display.
 *
 * Before:
 * - `[Lumi trusted ordered perception]\n[{"type":"text","text":"hi"}]\n[...]`
 *
 * After:
 * - `hi`
 */
function visiblePerceptionText(content: string): string {
  const openingTag = '[Lumi trusted ordered perception]'
  const closingTag = '[/Lumi trusted ordered perception]'
  const normalized = content.trim()
  if (!normalized.startsWith(openingTag) || !normalized.endsWith(closingTag))
    return content
  const serializedSegments = normalized.slice(openingTag.length, -closingTag.length).trim()
  if (!serializedSegments)
    return content
  try {
    const segments = JSON.parse(serializedSegments) as unknown
    if (!Array.isArray(segments))
      return content
    const projected = segments.flatMap((segment) => {
      if (!segment || typeof segment !== 'object' || Array.isArray(segment))
        return []
      const record = segment as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string')
        return [record.text]
      if (record.type === 'auditory_perception' && typeof record.transcript === 'string')
        return [`[Heard voice] ${record.transcript}`]
      if (record.type === 'visual_perception')
        return [`[Visual perception] ${JSON.stringify(record.perception ?? {})}`]
      return []
    })
    return projected.join('\n').trim() || content
  }
  catch {
    return content
  }
}

function memoryReference(memory: LumiMemoryFragment): AgentMemoryReference {
  return {
    id: memory.id,
    content: memory.content,
    scope: agentMemoryScope(memory),
    status: memory.status,
    confidence: memory.confidence,
    provenance: {
      sourceMessageId: memory.sourceMessageId,
      sourceActorId: memory.sourceActorId,
      sourceConversationType: memory.sourceConversationType,
      ownerType: memory.ownerType,
      ownerId: memory.ownerId,
    },
    authorizationReason: memory.disclosureReason
      ?? memory.classificationReason
      ?? 'Authorized by Lumi Server memory policy',
  }
}

function agentMemoryScope(memory: LumiMemoryFragment): AgentMemoryScope {
  if (memory.scope === 'private')
    return 'private_person'
  if (memory.scope === 'group')
    return 'group_public'
  if (memory.scope === 'global')
    return memory.ownerType === 'lumi' ? 'lumi_self' : 'global'
  return 'direct_shared'
}

function personStates(database: LumiServerDatabase, personId: string) {
  return (['profile', 'short-term', 'emotion', 'relationship'] as const)
    .flatMap(kind => database.readPersonState(personId, kind) ?? [])
}

function serializedState(
  states: ReturnType<typeof personStates>,
  kind: LumiPersonStateKind,
): string | undefined {
  const state = states.find(candidate => candidate.kind === kind)
  return state ? JSON.stringify(state.payload) : undefined
}

function statePayload(
  states: ReturnType<typeof personStates>,
  kind: LumiPersonStateKind,
): Record<string, unknown> {
  return states.find(candidate => candidate.kind === kind)?.payload ?? {}
}

function stringFrom(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim())
      return value.trim()
  }
  return undefined
}

function stringArrayFrom(record: Record<string, unknown>, keys: readonly string[]): string[] | undefined {
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) {
      return value.flatMap(item =>
        typeof item === 'string' && item.trim() ? [item.trim()] : [],
      )
    }
  }
  return undefined
}

function booleanFrom(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some(key => record[key] === true)
}

function numberFrom(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value))
      return value
  }
  return undefined
}

function willingnessFrom(record: Record<string, unknown>): LumiHelpWillingness {
  const value = stringFrom(record, ['willingnessToHelp', 'willingness_to_help'])
  return value === 'eager'
    || value === 'normal'
    || value === 'reluctant'
    || value === 'unwilling'
    || value === 'refuse'
    ? value
    : 'normal'
}

function outboundResult(messageId: string): DirectOutboundResult {
  return {
    messageId,
    timestamp: Date.now(),
  }
}

function recordTrace(database: LumiServerDatabase, event: AgentTraceEvent): void {
  database.recordSecurityAudit(`agent-${event.type}`, {
    turnId: event.turnId,
    eventType: event.type,
    timestamp: String(event.timestamp),
    ...('round' in event ? { round: String(event.round) } : {}),
    ...('reason' in event ? { reason: event.reason } : {}),
    ...(event.type === 'model_request'
      ? {
          purpose: event.purpose,
          status: event.status,
          durationMs: String(event.durationMs),
          promptId: event.prompt.id,
          promptVersion: event.prompt.version,
          promptHash: event.prompt.hash,
          messageCount: String(event.messageCount),
          toolCount: String(event.toolCount ?? ''),
          requestedToolChoice: event.requestedToolChoice ?? '',
          modelName: event.modelName ?? '',
          errorMessage: event.errorMessage ?? '',
          inputTokens: String(event.usage?.inputTokens ?? ''),
          outputTokens: String(event.usage?.outputTokens ?? ''),
          cacheHitTokens: String(event.usage?.cacheHitTokens ?? ''),
          cacheMissTokens: String(event.usage?.cacheMissTokens ?? ''),
          ...(event.messages ? { promptMessages: JSON.stringify(event.messages) } : {}),
        }
      : {}),
  })
}

function recordOutboundAudit(database: LumiServerDatabase, audit: OutboundSecurityAudit): void {
  database.recordSecurityAudit(audit.code, {
    operation: audit.operation,
    conversationId: audit.conversationId ?? '',
    personId: audit.personId ?? '',
    reason: audit.reason,
    timestamp: String(audit.timestamp),
  })
}

function requiredText(value: string, field: string, maximum: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum)
    throw new Error(`${field} is invalid`)
  return normalized
}
