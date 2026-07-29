import type {
  LumiCognitiveConversationType,
  LumiRecallState,
  LumiWorkingEntityBinding,
  LumiWorkingMemory,
  LumiWorkingMemoryItem,
} from './types'

export interface LumiRecallConversationTurn {
  /** Stable source message identifier. */
  id: string
  /** Speaker role. */
  role: 'user' | 'assistant'
  /** Plain visible message content. */
  content: string
}

/** Input used to create a contextual automatic-recall query. */
export interface LumiRecallQueryInput {
  /** Current user text. */
  message: string
  /** Recent complete user-assistant turns in chronological order. */
  recentTurns: LumiRecallConversationTurn[]
  /** Current privacy-isolated working state. */
  workingMemory: LumiWorkingMemory
  /** Current ISO timestamp. @default new Date().toISOString() */
  now?: string
}

/** Result of contextual query construction. */
export interface LumiRecallQueryResult {
  /** Query to embed or send to hybrid retrieval. */
  query: string
  /** True when no new embedding is needed and previous results can be reused. */
  reusedPreviousState: boolean
  /** Safe diagnostic reason. */
  reason: 'empty' | 'low_information_reuse' | 'low_information_without_state' | 'contextual_query'
  /** Previous result identifiers when reuse is possible. */
  reusedMemoryIds: string[]
  /** Source messages contributing semantic context. */
  sourceMessageIds: string[]
}

/** Options for creating an empty working-memory record. */
export interface LumiWorkingMemoryOptions {
  /** Immutable person identifier. */
  personId: string
  /** Lumi persona identifier. */
  personaId: string
  /** Owning conversation identifier. */
  conversationId: string
  /** Direct, group, or internal boundary. */
  conversationType: LumiCognitiveConversationType
  /** Current ISO timestamp. @default new Date().toISOString() */
  now?: string
  /** Whole-state time to live in milliseconds. @default 86400000 */
  ttlMs?: number
}

const PURE_CONTINUATIONS = new Set([
  '嗯',
  '嗯嗯',
  '对',
  '对的',
  '好',
  '好的',
  '继续',
  '然后呢',
  '确实',
  '可以',
  '行',
  '是',
  '没错',
  'ok',
  'okay',
])

const TOPIC_SWITCH_PATTERN = /换个话题|说点别的|不说这个|先不聊这个|另外一件事|另一个问题|new topic/i

/**
 * Creates an empty privacy-isolated working-memory projection.
 *
 * Use when:
 * - A new person/conversation pair starts
 * - A legacy current_state record has no matching working-memory record
 *
 * Expects:
 * - Identity fields were resolved by the host
 *
 * Returns:
 * - A versioned empty projection with a bounded TTL
 */
export function createLumiWorkingMemory(options: LumiWorkingMemoryOptions): LumiWorkingMemory {
  const now = validIso(options.now) ?? new Date().toISOString()
  return {
    version: 1,
    personId: options.personId,
    personaId: options.personaId,
    conversationId: options.conversationId,
    conversationType: options.conversationType,
    activeTopics: [],
    topicStack: [],
    entityBindings: [],
    goals: [],
    openLoops: [],
    projects: [],
    temporaryUserStates: [],
    sourceMessageIds: [],
    updatedAt: now,
    expiresAt: addMilliseconds(now, options.ttlMs ?? 24 * 60 * 60 * 1000),
  }
}

/**
 * Detects a pure low-information continuation without assigning sentiment.
 *
 * Use when:
 * - Deciding whether to reuse the previous RecallState
 *
 * Expects:
 * - Raw user-visible text
 *
 * Returns:
 * - True only for an exact bounded acknowledgement/continuation token
 */
export function isLumiLowInformationContinuation(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[。！!？?，,、~～…\s]+/g, '')
  return PURE_CONTINUATIONS.has(normalized)
}

/**
 * Builds a contextual query or reuses a still-valid previous RecallState.
 *
 * Use when:
 * - Running automatic shallow recall before Planner
 *
 * Expects:
 * - Recent turns include assistant context needed to resolve confirmations
 * - Working memory belongs to the immutable current actor/conversation
 *
 * Returns:
 * - A reusable state marker or a bounded contextual query
 */
export function buildLumiContextualRecallQuery(input: LumiRecallQueryInput): LumiRecallQueryResult {
  const message = input.message.trim()
  const now = validIso(input.now) ?? new Date().toISOString()
  if (!message) {
    return {
      query: '',
      reusedPreviousState: false,
      reason: 'empty',
      reusedMemoryIds: [],
      sourceMessageIds: [],
    }
  }

  const previous = activeRecallState(input.workingMemory.recallState, now)
  if (isLumiLowInformationContinuation(message)) {
    if (previous) {
      return {
        query: previous.query,
        reusedPreviousState: true,
        reason: 'low_information_reuse',
        reusedMemoryIds: [...previous.memoryIds],
        sourceMessageIds: [...previous.sourceMessageIds],
      }
    }
    return {
      query: contextualParts(input, message).join('\n'),
      reusedPreviousState: false,
      reason: 'low_information_without_state',
      reusedMemoryIds: [],
      sourceMessageIds: recentSourceIds(input.recentTurns),
    }
  }

  return {
    query: contextualParts(input, message).join('\n'),
    reusedPreviousState: false,
    reason: 'contextual_query',
    reusedMemoryIds: [],
    sourceMessageIds: recentSourceIds(input.recentTurns),
  }
}

/**
 * Applies deterministic, high-certainty turn updates without a model call.
 *
 * Use when:
 * - A direct or group-observation turn commits
 * - Planner supplies validated topic/entity/goal updates
 *
 * Expects:
 * - `previous` belongs to the same immutable person and conversation
 * - Optional item arrays were host-validated before this reducer
 *
 * Returns:
 * - An incrementally updated working-memory projection
 */
export function reduceLumiWorkingMemory(input: {
  previous: LumiWorkingMemory
  sourceMessageId: string
  userText: string
  assistantText?: string
  activeTopics?: LumiWorkingMemoryItem[]
  entityBindings?: LumiWorkingEntityBinding[]
  goals?: LumiWorkingMemoryItem[]
  openLoops?: LumiWorkingMemoryItem[]
  projects?: LumiWorkingMemoryItem[]
  temporaryUserStates?: LumiWorkingMemoryItem[]
  relationshipContext?: LumiWorkingMemoryItem
  recallState?: LumiRecallState
  now?: string
  ttlMs?: number
}): LumiWorkingMemory {
  const now = validIso(input.now) ?? new Date().toISOString()
  const switchedTopic = TOPIC_SWITCH_PATTERN.test(input.userText)
  const sourceMessageIds = uniqueStrings([
    ...input.previous.sourceMessageIds,
    input.sourceMessageId,
  ]).slice(-24)
  const previousTopics = pruneItems(input.previous.activeTopics, now)
  const activeTopics = input.activeTopics
    ? mergeItems(switchedTopic ? [] : previousTopics, input.activeTopics, now, 6)
    : switchedTopic ? [] : previousTopics
  const topicStack = switchedTopic
    ? mergeItems(input.previous.topicStack, previousTopics, now, 12)
    : pruneItems(input.previous.topicStack, now).slice(0, 12)

  return {
    ...input.previous,
    activeTopics,
    topicStack,
    entityBindings: switchedTopic
      ? normalizeBindings(input.entityBindings ?? [], now)
      : mergeBindings(input.previous.entityBindings, input.entityBindings ?? [], now),
    goals: mergeItems(input.previous.goals, input.goals ?? [], now, 8),
    openLoops: mergeItems(input.previous.openLoops, input.openLoops ?? [], now, 8),
    projects: mergeItems(input.previous.projects, input.projects ?? [], now, 8),
    temporaryUserStates: mergeItems(
      input.previous.temporaryUserStates,
      input.temporaryUserStates ?? [],
      now,
      6,
    ),
    relationshipContext: input.relationshipContext
      ?? activeItem(input.previous.relationshipContext, now),
    continuationPoint: boundedText(input.assistantText || input.userText, 1_200),
    recallState: input.recallState ?? activeRecallState(input.previous.recallState, now),
    sourceMessageIds,
    updatedAt: now,
    expiresAt: addMilliseconds(now, input.ttlMs ?? 24 * 60 * 60 * 1000),
  }
}

/** Removes expired working-memory fields while preserving identity. */
export function pruneLumiWorkingMemory(memory: LumiWorkingMemory, now = new Date().toISOString()): LumiWorkingMemory {
  const validNow = validIso(now) ?? new Date().toISOString()
  if (Date.parse(memory.expiresAt) <= Date.parse(validNow))
    return createLumiWorkingMemory({ ...memory, now: validNow })

  return {
    ...memory,
    activeTopics: pruneItems(memory.activeTopics, validNow),
    topicStack: pruneItems(memory.topicStack, validNow),
    entityBindings: normalizeBindings(memory.entityBindings, validNow),
    goals: pruneItems(memory.goals, validNow),
    openLoops: pruneItems(memory.openLoops, validNow),
    projects: pruneItems(memory.projects, validNow),
    temporaryUserStates: pruneItems(memory.temporaryUserStates, validNow),
    relationshipContext: activeItem(memory.relationshipContext, validNow),
    recallState: activeRecallState(memory.recallState, validNow),
  }
}

function contextualParts(input: LumiRecallQueryInput, message: string) {
  const recent = input.recentTurns
    .filter(turn => turn.content.trim())
    .slice(-6)
    .map(turn => `${turn.role === 'assistant' ? 'Lumi' : '用户'}: ${boundedText(turn.content, 600)}`)
  const topics = input.workingMemory.activeTopics
    .map(item => item.value)
    .filter(Boolean)
    .slice(0, 4)
  const entities = input.workingMemory.entityBindings
    .map(item => `${item.key}=${item.value}`)
    .slice(0, 6)
  return [
    `当前用户消息: ${boundedText(message, 1_000)}`,
    recent.length ? `最近完整对话:\n${recent.join('\n')}` : '',
    topics.length ? `活跃话题: ${topics.join('；')}` : '',
    entities.length ? `实体指代: ${entities.join('；')}` : '',
    input.workingMemory.recallState?.query
      ? `上一轮召回查询: ${boundedText(input.workingMemory.recallState.query, 1_000)}`
      : '',
  ].filter(Boolean)
}

function recentSourceIds(turns: LumiRecallConversationTurn[]) {
  return uniqueStrings(turns.slice(-6).map(turn => turn.id))
}

function mergeItems(
  previous: LumiWorkingMemoryItem[],
  incoming: LumiWorkingMemoryItem[],
  now: string,
  limit: number,
) {
  const merged = new Map<string, LumiWorkingMemoryItem>()
  for (const item of [...incoming, ...pruneItems(previous, now)]) {
    const value = item.value.trim()
    if (!value)
      continue
    const key = item.id || value.toLowerCase()
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, {
        ...item,
        value,
        evidenceIds: uniqueStrings(item.evidenceIds),
        sourceMessageIds: uniqueStrings(item.sourceMessageIds),
      })
      continue
    }
    merged.set(key, {
      ...existing,
      evidenceIds: uniqueStrings([...existing.evidenceIds, ...item.evidenceIds]),
      sourceMessageIds: uniqueStrings([...existing.sourceMessageIds, ...item.sourceMessageIds]),
      updatedAt: existing.updatedAt > item.updatedAt ? existing.updatedAt : item.updatedAt,
      expiresAt: existing.expiresAt > item.expiresAt ? existing.expiresAt : item.expiresAt,
    })
  }
  return [...merged.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit)
}

function pruneItems(items: LumiWorkingMemoryItem[], now: string) {
  const timestamp = Date.parse(now)
  return items.filter(item => Number.isFinite(Date.parse(item.expiresAt)) && Date.parse(item.expiresAt) > timestamp)
}

function activeItem(item: LumiWorkingMemoryItem | undefined, now: string) {
  return item && Date.parse(item.expiresAt) > Date.parse(now) ? item : undefined
}

function mergeBindings(
  previous: LumiWorkingEntityBinding[],
  incoming: LumiWorkingEntityBinding[],
  now: string,
) {
  const merged = new Map<string, LumiWorkingEntityBinding>()
  for (const binding of [...incoming, ...normalizeBindings(previous, now)]) {
    if (!binding.key.trim() || !binding.value.trim())
      continue
    const existing = merged.get(binding.key)
    if (!existing || binding.updatedAt > existing.updatedAt)
      merged.set(binding.key, binding)
  }
  return [...merged.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 12)
}

function normalizeBindings(bindings: LumiWorkingEntityBinding[], now: string) {
  const timestamp = Date.parse(now)
  return bindings.filter(binding =>
    binding.key.trim()
    && binding.value.trim()
    && Number.isFinite(Date.parse(binding.expiresAt))
    && Date.parse(binding.expiresAt) > timestamp,
  )
}

function activeRecallState(state: LumiRecallState | undefined, now: string) {
  if (!state?.query.trim())
    return undefined
  return Date.parse(state.expiresAt) > Date.parse(now) ? state : undefined
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function boundedText(value: string, limit: number) {
  return value.trim().slice(0, limit)
}

function addMilliseconds(iso: string, duration: number) {
  return new Date(Date.parse(iso) + Math.max(1, duration)).toISOString()
}

function validIso(value: string | undefined) {
  if (!value || !Number.isFinite(Date.parse(value)))
    return undefined
  return new Date(value).toISOString()
}
