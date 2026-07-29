import type { LumiMemoryFragment } from '../types'
import type {
  LumiBeliefHypothesis,
  LumiCognitiveContextBundle,
  LumiCognitiveEvidence,
  LumiCognitiveIdentity,
  LumiCognitiveProfileProjection,
  LumiFeedbackEvent,
  LumiRecallState,
  LumiRecallTrace,
  LumiWorkingMemory,
} from './types'

import { assembleLumiCognitiveContext } from './context'
import { classifyExplicitLumiFeedback } from './feedback'
import {
  buildLumiContextualRecallQuery,
  createLumiWorkingMemory,
  isLumiLowInformationContinuation,
  reduceLumiWorkingMemory,
} from './working-memory'

/** One visible dialogue turn used to contextualize automatic recall. */
export interface LumiCognitiveDialogueTurn {
  /** Stable source or outbound message identifier. */
  id: string
  /** Dialogue speaker. */
  role: 'user' | 'assistant'
  /** Visible text only. */
  content: string
}

/** Non-memory projections loaded by a host for the immutable turn actor. */
export interface LumiCognitiveProjectionState {
  /** Evidence available for lineage checks. */
  evidence: readonly LumiCognitiveEvidence[]
  /** Non-expired hypotheses available to this actor. */
  hypotheses: readonly LumiBeliefHypothesis[]
  /** Materialized profile projections. */
  profile: readonly LumiCognitiveProfileProjection[]
  /** Direct-only relationship state. */
  relationshipState?: unknown
  /** Current Lumi emotion projection. */
  currentEmotion?: unknown
  /** Evidence-backed interaction strategies. */
  interactionStrategies?: readonly string[]
  /** Replyer expression candidates. */
  expressionAssets?: readonly string[]
  /** Unresolved cognition conflicts. */
  contradictions?: readonly string[]
}

/** Result returned by the host's ACL-filtered hybrid recall service. */
export interface LumiCognitiveRecallResult {
  /** Authorized memories after threshold and conflict filtering. */
  memories: readonly LumiMemoryFragment[]
  /** Privacy-safe retrieval diagnostics. */
  trace: LumiRecallTrace
}

/**
 * Persistence and retrieval boundary used by the shared cognitive fast loop.
 *
 * Implementations belong in Electron main or a server database service. Every
 * method must use the supplied immutable identity rather than UI selection.
 */
export interface LumiCognitiveTurnRepository {
  /** Loads one conversation-scoped working-memory record. */
  loadWorkingMemory: (identity: LumiCognitiveIdentity) => Promise<LumiWorkingMemory | undefined>
  /** Atomically stores source evidence, feedback, and the new working state. */
  commitFastLoop: (input: {
    identity: LumiCognitiveIdentity
    evidence: LumiCognitiveEvidence
    feedback: readonly LumiFeedbackEvent[]
    workingMemory: LumiWorkingMemory
  }) => Promise<void>
  /** Runs structured + lexical + ANN retrieval with host-side ACL checks. */
  recall: (input: {
    identity: LumiCognitiveIdentity
    query: string
    limit: number
    signal?: AbortSignal
  }) => Promise<LumiCognitiveRecallResult>
  /** Reloads already-authorized memories without recomputing an embedding. */
  loadMemoriesByIds: (input: {
    identity: LumiCognitiveIdentity
    memoryIds: readonly string[]
    signal?: AbortSignal
  }) => Promise<readonly LumiMemoryFragment[]>
  /** Loads beliefs, profile projections, relationship, emotion, and language assets. */
  loadProjectionState: (identity: LumiCognitiveIdentity) => Promise<LumiCognitiveProjectionState>
}

/** Input for one no-extra-model cognitive fast loop. */
export interface PrepareLumiCognitiveTurnInput {
  /** Immutable identity resolved at ingress. */
  identity: LumiCognitiveIdentity
  /** Current verified message identifier. */
  sourceMessageId: string
  /** Current visible user text. */
  userText: string
  /** Recent complete dialogue in chronological order. */
  recentTurns: readonly LumiCognitiveDialogueTurn[]
  /** Shared host repository. */
  repository: LumiCognitiveTurnRepository
  /** Abort signal bounded by the Agent Runtime. */
  signal?: AbortSignal
  /** Current ISO timestamp. @default new Date().toISOString() */
  now?: string
}

/**
 * Executes Lumi's deterministic per-turn cognitive loop before Planner.
 *
 * Use when:
 * - Desktop, server, or AstrBot has resolved one immutable direct actor
 * - Automatic recall must run without another language-model request
 *
 * Expects:
 * - Repository retrieval revalidates ACL and memory scope
 * - Recent turns include the current user message and relevant assistant text
 *
 * Returns:
 * - One deduplicated cognitive bundle for Planner and Replyer projections
 */
export async function prepareLumiCognitiveTurn(
  input: PrepareLumiCognitiveTurnInput,
): Promise<LumiCognitiveContextBundle> {
  assertDirectIdentity(input.identity)
  throwIfAborted(input.signal)
  const now = normalizedTimestamp(input.now)
  const previous = await input.repository.loadWorkingMemory(input.identity)
    ?? createLumiWorkingMemory({
      personId: input.identity.actorId,
      personaId: input.identity.personaId,
      conversationId: input.identity.conversationId,
      conversationType: input.identity.conversationType,
      now,
    })
  validateWorkingMemoryOwner(previous, input.identity)

  const feedbackKinds = classifyExplicitLumiFeedback(input.userText)
  const evidence = messageEvidence(input, feedbackKinds, now)
  const recentTurns = input.recentTurns.map(turn => ({ ...turn }))
  const query = buildLumiContextualRecallQuery({
    message: input.userText,
    recentTurns,
    workingMemory: previous,
    now,
  })
  throwIfAborted(input.signal)

  const recalled = query.reusedPreviousState
    ? await reusedRecall(input, query.reusedMemoryIds)
    : query.query.trim()
      ? await input.repository.recall({
          identity: input.identity,
          query: query.query,
          limit: 5,
          signal: input.signal,
        })
      : emptyRecall('empty_query')
  throwIfAborted(input.signal)

  const recallState = buildRecallState(previous.recallState, query, recalled.memories, now)
  const recentAssistant = [...input.recentTurns]
    .reverse()
    .find(turn => turn.role === 'assistant' && turn.content.trim())
  const workingMemory = reduceLumiWorkingMemory({
    previous,
    sourceMessageId: input.sourceMessageId,
    userText: input.userText,
    assistantText: isLumiLowInformationContinuation(input.userText)
      ? recentAssistant?.content
      : undefined,
    recallState,
    now,
  })
  const feedback = feedbackKinds.map(kind => feedbackEvent(input, evidence, kind, now))
  await input.repository.commitFastLoop({
    identity: input.identity,
    evidence,
    feedback,
    workingMemory,
  })
  const projection = await input.repository.loadProjectionState(input.identity)
  throwIfAborted(input.signal)

  return assembleLumiCognitiveContext({
    identity: input.identity,
    workingMemory,
    evidence: dedupeEvidence([...projection.evidence, evidence]),
    memories: recalled.memories,
    hypotheses: projection.hypotheses,
    profile: projection.profile,
    relationshipState: projection.relationshipState,
    currentEmotion: projection.currentEmotion,
    interactionStrategies: projection.interactionStrategies,
    expressionAssets: projection.expressionAssets,
    contradictions: projection.contradictions,
    recallTrace: {
      ...recalled.trace,
      query: query.query,
      queryReason: query.reason,
      reusedPreviousState: query.reusedPreviousState,
      injectedCount: recalled.memories.length,
    },
    now,
  })
}

function messageEvidence(
  input: PrepareLumiCognitiveTurnInput,
  feedbackKinds: readonly string[],
  occurredAt: string,
): LumiCognitiveEvidence {
  const correction = feedbackKinds.includes('fact_correction')
  return {
    id: `evidence:message:${input.identity.conversationId}:${input.sourceMessageId}`,
    actorId: input.identity.actorId,
    subjectUserIds: [input.identity.actorId],
    conversationId: input.identity.conversationId,
    conversationType: input.identity.conversationType,
    kind: correction
      ? 'user_correction'
      : feedbackKinds.length > 0 ? 'user_feedback' : 'user_statement',
    origin: 'primary',
    content: input.userText,
    sourceId: input.sourceMessageId,
    sourceMessageId: input.sourceMessageId,
    occurredAt,
    trust: 1,
    authorVerified: true,
    scope: 'private',
    sensitivity: 'private',
    participantUserIds: [...input.identity.participantUserIds],
    derivedFromEvidenceIds: [],
    schemaVersion: 1,
  }
}

function feedbackEvent(
  input: PrepareLumiCognitiveTurnInput,
  evidence: LumiCognitiveEvidence,
  kind: LumiFeedbackEvent['kind'],
  occurredAt: string,
): LumiFeedbackEvent {
  const recentAssistantId = [...input.recentTurns]
    .reverse()
    .find(turn => turn.role === 'assistant')
    ?.id
  return {
    id: `feedback:${input.identity.conversationId}:${input.sourceMessageId}:${kind}`,
    actorId: input.identity.actorId,
    conversationId: input.identity.conversationId,
    conversationType: input.identity.conversationType,
    kind,
    sourceId: input.sourceMessageId,
    evidenceId: evidence.id,
    targetIds: recentAssistantId ? [recentAssistantId] : [],
    strength: 1,
    occurredAt,
    authorVerified: true,
    scope: evidence.scope,
    sensitivity: evidence.sensitivity,
  }
}

async function reusedRecall(
  input: PrepareLumiCognitiveTurnInput,
  memoryIds: readonly string[],
): Promise<LumiCognitiveRecallResult> {
  const startedAt = Date.now()
  const memories = await input.repository.loadMemoriesByIds({
    identity: input.identity,
    memoryIds,
    signal: input.signal,
  })
  return {
    memories: memories.slice(0, 5),
    trace: {
      ran: true,
      reusedPreviousState: true,
      aclInputCount: memoryIds.length,
      aclOutputCount: memories.length,
      lexicalCandidateCount: 0,
      annCandidateCount: 0,
      mergedCandidateCount: memories.length,
      rerankedCandidateCount: memories.length,
      thresholdRejectedCount: Math.max(0, memoryIds.length - memories.length),
      conflictRejectedCount: 0,
      injectedCount: memories.length,
      durationMs: Date.now() - startedAt,
      vectorIndexStatus: 'reused_previous_recall',
    },
  }
}

function emptyRecall(fallbackReason: string): LumiCognitiveRecallResult {
  return {
    memories: [],
    trace: {
      ran: false,
      reusedPreviousState: false,
      aclInputCount: 0,
      aclOutputCount: 0,
      lexicalCandidateCount: 0,
      annCandidateCount: 0,
      mergedCandidateCount: 0,
      rerankedCandidateCount: 0,
      thresholdRejectedCount: 0,
      conflictRejectedCount: 0,
      injectedCount: 0,
      durationMs: 0,
      fallbackReason,
    },
  }
}

function buildRecallState(
  previous: LumiRecallState | undefined,
  query: ReturnType<typeof buildLumiContextualRecallQuery>,
  memories: readonly LumiMemoryFragment[],
  now: string,
): LumiRecallState | undefined {
  if (!query.query.trim())
    return undefined
  return {
    query: query.query,
    memoryIds: memories.map(memory => memory.id),
    activeTopics: [],
    sourceMessageIds: [...query.sourceMessageIds],
    updatedAt: now,
    expiresAt: new Date(Date.parse(now) + 30 * 60 * 1_000).toISOString(),
    reuseCount: query.reusedPreviousState ? (previous?.reuseCount ?? 0) + 1 : 0,
  }
}

function validateWorkingMemoryOwner(memory: LumiWorkingMemory, identity: LumiCognitiveIdentity): void {
  if (
    memory.personId !== identity.actorId
    || memory.personaId !== identity.personaId
    || memory.conversationId !== identity.conversationId
    || memory.conversationType !== identity.conversationType
  ) {
    throw new TypeError('Working memory does not belong to the immutable cognitive identity')
  }
}

function assertDirectIdentity(identity: LumiCognitiveIdentity): void {
  if (identity.conversationType !== 'direct')
    throw new TypeError('The direct cognitive fast loop requires a direct identity')
  if (!identity.actorId.trim() || !identity.conversationId.trim() || !identity.personaId.trim())
    throw new TypeError('Cognitive identity fields must be non-empty')
  if (!identity.participantUserIds.includes(identity.actorId))
    throw new TypeError('Cognitive participants must include the immutable actor')
}

function dedupeEvidence(evidence: readonly LumiCognitiveEvidence[]): LumiCognitiveEvidence[] {
  return [...new Map(evidence.map(item => [item.id, item])).values()]
}

function normalizedTimestamp(value?: string): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString()
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason ?? new Error('Cognitive turn aborted')
}
