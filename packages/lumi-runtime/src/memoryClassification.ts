import type {
  LumiMemoryCandidate,
  LumiMemoryOwnerType,
  LumiMemoryScope,
  LumiMemorySensitivity,
  LumiMemorySourceConversationType,
  LumiMemoryVisibility,
} from './types'

/** Trusted turn context used to assign memory ownership and disclosure boundaries. */
export interface LumiMemoryClassificationContext {
  /** Internal user ID resolved by the host. */
  actorId: string
  /** Stable Lumi persona ID. */
  personaId: string
  /** Host-owned conversation ID when the source came from chat. */
  conversationId?: string
  /** Trusted conversation surface, never inferred from model output. */
  conversationType?: LumiMemorySourceConversationType
  /** Host-authorized participants in the source conversation. */
  participantUserIds?: string[]
  /** Optional caller proposal; unsafe values are downgraded by policy. */
  requestedScope?: LumiMemoryScope
  /** Optional caller proposal; final visibility follows final scope. */
  requestedVisibility?: LumiMemoryVisibility
  /** Explicit privacy proposal, which can only make access narrower. */
  requestedSensitivity?: LumiMemorySensitivity
  /** Proposed subjects filtered against trusted identities. */
  requestedSubjectUserIds?: string[]
}

/** Host-authoritative memory ownership and disclosure decision. */
export interface LumiMemoryClassification {
  scope: LumiMemoryScope
  ownerType: LumiMemoryOwnerType
  ownerId: string
  visibility: LumiMemoryVisibility
  participantUserIds: string[]
  subjectUserIds: string[]
  sensitivity: LumiMemorySensitivity
  sourceActorId: string
  sourceConversationType: LumiMemorySourceConversationType
  classificationReason: string
  disclosureReason: string
}

/**
 * Assigns a candidate to a host-authoritative memory access domain.
 *
 * Use when:
 * - Persisting model-curated or deterministic memories
 * - Downgrading unsafe model scope proposals before storage
 *
 * Expects:
 * - Actor and participants have already been resolved by the host
 * - Candidate scope and tags are untrusted model suggestions
 *
 * Returns:
 * - A complete ownership, audience, provenance, and disclosure decision
 */
export function classifyLumiMemoryCandidate(
  candidate: LumiMemoryCandidate,
  context: LumiMemoryClassificationContext,
): LumiMemoryClassification {
  const requestedScope = context.requestedScope ?? candidate.scope ?? 'relationship'
  const sensitivity = context.requestedSensitivity === 'private'
    || candidate.sensitivity === 'private'
    || candidate.visibility === 'private'
    || requestedScope === 'private'
    ? 'private'
    : 'normal'
  const conversationType = context.conversationType ?? 'manual'
  const participants = unique([context.actorId, ...(context.participantUserIds ?? [])])
  const subjects = trustedSubjects(candidate, context, participants)

  if (sensitivity === 'private') {
    return decision({
      scope: 'private',
      ownerType: 'user',
      ownerId: context.actorId,
      visibility: 'private',
      participantUserIds: [context.actorId],
      subjectUserIds: subjects,
      sensitivity,
      sourceActorId: context.actorId,
      sourceConversationType: conversationType,
      classificationReason: 'Explicit privacy markers force this memory into the source actor relationship.',
      disclosureReason: 'Private memory; never disclose outside the source actor relationship.',
    })
  }

  if (requestedScope === 'global' && isExplicitLumiSelfMemory(candidate)) {
    return decision({
      scope: 'global',
      ownerType: 'lumi',
      ownerId: context.personaId,
      visibility: 'global',
      participantUserIds: [],
      subjectUserIds: ['lumi'],
      sensitivity,
      sourceActorId: context.actorId,
      sourceConversationType: conversationType,
      classificationReason: 'Explicit non-private Lumi self fact applies across every relationship.',
      disclosureReason: 'Lumi-owned self knowledge is available in every authorized conversation.',
    })
  }

  if (conversationType === 'group' && context.conversationId) {
    return decision({
      scope: 'group',
      ownerType: 'group',
      ownerId: context.conversationId,
      visibility: 'participants',
      participantUserIds: participants,
      subjectUserIds: subjects,
      sensitivity,
      sourceActorId: context.actorId,
      sourceConversationType: conversationType,
      classificationReason: 'Non-private evidence originated in a host-authorized group conversation.',
      disclosureReason: 'Visible only inside this exact group conversation and to its participants.',
    })
  }

  if (requestedScope === 'shared' && isShareableDailyMemory(candidate)) {
    return decision({
      scope: 'shared',
      ownerType: 'user',
      ownerId: context.actorId,
      visibility: 'shared',
      participantUserIds: [],
      subjectUserIds: subjects,
      sensitivity,
      sourceActorId: context.actorId,
      sourceConversationType: conversationType,
      classificationReason: 'Ordinary non-private daily event or mood was explicitly classified as shareable.',
      disclosureReason: 'May be recalled as a concise everyday experience without exposing source chat records.',
    })
  }

  const downgrade = requestedScope === 'global'
    ? 'Global proposal lacked explicit Lumi self ownership and was downgraded.'
    : requestedScope === 'shared'
      ? 'Shared proposal was not an approved daily-event type and was downgraded.'
      : requestedScope === 'group'
        ? 'Group proposal lacked a trusted group conversation and was downgraded.'
        : 'Memory belongs to the source actor relationship.'
  return decision({
    scope: 'relationship',
    ownerType: 'user',
    ownerId: context.actorId,
    visibility: 'participants',
    participantUserIds: [context.actorId],
    subjectUserIds: subjects,
    sensitivity,
    sourceActorId: context.actorId,
    sourceConversationType: conversationType,
    classificationReason: downgrade,
    disclosureReason: 'Available only when Lumi is interacting with the source actor.',
  })
}

function isExplicitLumiSelfMemory(candidate: LumiMemoryCandidate) {
  if (candidate.type !== 'persona_fact' && candidate.type !== 'persona_preference')
    return false
  if (!candidate.tags.includes('lumi_self'))
    return false
  return /\bLumi(?:'s|\s+(?:is|was|has|likes|loves|prefers|dislikes|birthday|favorite|name|anniversary))\b|Lumi\s*(?:[的是有]|喜欢|偏好|讨厌|生日)/i.test(candidate.content)
}

function isShareableDailyMemory(candidate: LumiMemoryCandidate) {
  return candidate.type === 'shared_event' || candidate.type === 'emotional_echo'
}

function trustedSubjects(
  candidate: LumiMemoryCandidate,
  context: LumiMemoryClassificationContext,
  participants: string[],
) {
  if (candidate.type === 'persona_fact' || candidate.type === 'persona_preference')
    return ['lumi']
  const allowed = new Set(['lumi', ...participants])
  const proposed = context.requestedSubjectUserIds ?? candidate.subjectUserIds ?? []
  const filtered = proposed.filter(subject => allowed.has(subject))
  if (candidate.type === 'user_fact' || candidate.type === 'user_preference')
    filtered.push(context.actorId)
  return unique(filtered.length ? filtered : [context.actorId])
}

function decision(value: LumiMemoryClassification): LumiMemoryClassification {
  return value
}

function unique(values: string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}
