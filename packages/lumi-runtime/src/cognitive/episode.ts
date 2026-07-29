import type { LumiMemoryFragment } from '../types'
import type {
  LumiCognitiveEvidence,
  LumiCognitiveIdentity,
} from './types'

/** Input used to materialize one context checkpoint as a private episode. */
export interface LumiConversationEpisodeInput {
  /** Immutable identity that owned every summarized direct turn. */
  identity: LumiCognitiveIdentity
  /** Stable dialogue checkpoint identifier assigned by Agent Runtime. */
  episodeId: string
  /** Model-derived continuity summary; never treated as a user statement. */
  summary: string
  /** Ordered source message identifiers covered by the checkpoint. */
  sourceMessageIds: readonly string[]
  /** Verified primary evidence loaded by the host for covered user messages. */
  primaryEvidence: readonly LumiCognitiveEvidence[]
  /** ISO timestamp at which the immutable checkpoint was accepted. */
  occurredAt: string
}

/** Evidence and episodic memory produced from one grounded checkpoint. */
export interface LumiConversationEpisode {
  /** Derived evidence whose parents are verified primary message evidence. */
  evidence: LumiCognitiveEvidence
  /** Private long-term episodic projection backed by the derived evidence. */
  memory: LumiMemoryFragment
}

/**
 * Materializes an immutable direct-conversation checkpoint as one episode.
 *
 * Use when:
 * - Agent Runtime completed idle context compaction
 * - A host has reloaded primary evidence under the same immutable identity
 *
 * Expects:
 * - The summary is model-derived and therefore never author-verified
 * - At least one covered user message has verified primary evidence
 *
 * Returns:
 * - A private derived evidence record and one transitive episodic memory
 */
export function createLumiConversationEpisode(
  input: LumiConversationEpisodeInput,
): LumiConversationEpisode {
  assertDirectIdentity(input.identity)
  const episodeId = requiredText(input.episodeId, 'Conversation episode id', 240)
  const summary = requiredText(input.summary, 'Conversation episode summary', 8_000)
  const occurredAt = requiredIsoTimestamp(input.occurredAt)
  const sourceMessageIds = uniqueTexts(input.sourceMessageIds, 'Conversation episode source message', 500)
  if (sourceMessageIds.length === 0)
    throw new Error('Conversation episode has no source messages')

  const sourceOrder = new Map(sourceMessageIds.map((sourceMessageId, index) => [sourceMessageId, index]))
  const primaryEvidence = [...input.primaryEvidence]
    .filter(evidence => isAuthorizedPrimaryEvidence(evidence, input.identity, sourceOrder))
    .sort((left, right) => (
      sourceOrder.get(left.sourceMessageId ?? '') ?? Number.MAX_SAFE_INTEGER
    ) - (
      sourceOrder.get(right.sourceMessageId ?? '') ?? Number.MAX_SAFE_INTEGER
    ))
  const uniqueEvidence = [...new Map(primaryEvidence.map(evidence => [evidence.id, evidence])).values()]
  if (uniqueEvidence.length === 0)
    throw new Error('Conversation episode has no authorized primary evidence')

  const digest = stableDigest([
    input.identity.actorId,
    input.identity.personaId,
    input.identity.conversationId,
    episodeId,
    ...sourceMessageIds,
  ].join('\0'))
  const evidence: LumiCognitiveEvidence = {
    id: `evidence:episode:${digest}`,
    actorId: input.identity.actorId,
    subjectUserIds: [input.identity.actorId],
    conversationId: input.identity.conversationId,
    conversationType: 'direct',
    kind: 'conversation_episode',
    origin: 'derived',
    content: summary,
    sourceId: episodeId,
    occurredAt,
    trust: 0.74,
    authorVerified: false,
    scope: 'private',
    sensitivity: 'private',
    participantUserIds: [...input.identity.participantUserIds],
    derivedFromEvidenceIds: uniqueEvidence.map(item => item.id),
    derivationReason: 'Context compaction summary grounded in verified direct-message evidence.',
    schemaVersion: 1,
  }
  const memory: LumiMemoryFragment = {
    id: `memory:episode:${digest}`,
    userId: input.identity.actorId,
    personaId: input.identity.personaId,
    conversationId: input.identity.conversationId,
    type: 'shared_event',
    content: summary,
    confidence: evidence.trust,
    importance: 0.65,
    emotionalIntensity: 0,
    relationshipRelevance: 0.45,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    decay: 0.08,
    tags: ['conversation_episode', 'context_summary'],
    status: 'active',
    scope: 'private',
    ownerType: 'user',
    ownerId: input.identity.actorId,
    visibility: 'private',
    participantUserIds: [...input.identity.participantUserIds],
    subjectUserIds: [input.identity.actorId],
    sensitivity: 'private',
    sourceActorId: input.identity.actorId,
    sourceConversationType: 'direct',
    classificationReason: 'A direct-conversation checkpoint remains private to its immutable actor and conversation.',
    disclosureReason: 'Private episodic memory; never disclose outside the source relationship.',
    derivedFromEvidenceIds: [evidence.id],
    validFrom: occurredAt,
    sourceEpisodeStartMessageId: sourceMessageIds[0],
    sourceEpisodeEndMessageId: sourceMessageIds.at(-1),
    useCount: 0,
    evidenceOrigin: 'derived',
  }
  return { evidence, memory }
}

function isAuthorizedPrimaryEvidence(
  evidence: LumiCognitiveEvidence,
  identity: LumiCognitiveIdentity,
  sourceOrder: ReadonlyMap<string, number>,
): boolean {
  return evidence.origin === 'primary'
    && evidence.authorVerified
    && evidence.actorId === identity.actorId
    && evidence.conversationId === identity.conversationId
    && evidence.conversationType === 'direct'
    && evidence.scope === 'private'
    && evidence.sensitivity === 'private'
    && evidence.derivedFromEvidenceIds.length === 0
    && Boolean(evidence.sourceMessageId && sourceOrder.has(evidence.sourceMessageId))
    && sameStringSet(evidence.participantUserIds, identity.participantUserIds)
}

function assertDirectIdentity(identity: LumiCognitiveIdentity): void {
  if (
    identity.conversationType !== 'direct'
    || !identity.actorId.trim()
    || !identity.personaId.trim()
    || !identity.conversationId.trim()
    || !identity.participantUserIds.includes(identity.actorId)
  ) {
    throw new Error('Conversation episode identity is invalid')
  }
}

function uniqueTexts(values: readonly string[], label: string, maximum: number): string[] {
  if (values.length > maximum)
    throw new Error(`${label} count exceeds ${maximum}`)
  const normalized = values.map(value => requiredText(value, label, 240))
  return [...new Set(normalized)]
}

function requiredText(value: string, label: string, maximumLength: number): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > maximumLength)
    throw new Error(`${label} is invalid`)
  return normalized
}

function requiredIsoTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value)))
    throw new Error('Conversation episode timestamp is invalid')
  return new Date(value).toISOString()
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length)
    return false
  const rightValues = new Set(right)
  return left.every(value => rightValues.has(value))
}

function stableDigest(value: string): string {
  let first = 2166136261
  let second = 2246822519
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ code, 3266489917)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}
