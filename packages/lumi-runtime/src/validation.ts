import type {
  LumiMemoryFragment,
  LumiMemoryOwnerType,
  LumiMemoryScope,
  LumiMemorySearchRequest,
  LumiMemorySensitivity,
  LumiMemorySourceConversationType,
  LumiMemoryVisibility,
  LumiStateSnapshot,
} from './types'

import { createDefaultLumiStateSnapshot } from './defaults'

const boundedNumberFields = [
  'confidence',
  'importance',
  'emotionalIntensity',
  'relationshipRelevance',
  'decay',
] as const

/**
 * Checks whether a memory is eligible for semantic retrieval.
 *
 * Use when:
 * - A MemoryDriver filters records before vector search.
 * - A stage wants to avoid showing rejected or archived records as active facts.
 *
 * Expects:
 * - Memory status semantics from Lumi: only active memories can be recalled.
 *
 * Returns:
 * - True only for active memory fragments with non-empty content.
 */
export function isRecallableMemory(fragment: LumiMemoryFragment): boolean {
  return fragment.status === 'active' && fragment.content.trim().length > 0
}

/**
 * Clamps numeric memory scores into Lumi's normalized range.
 *
 * Before:
 * - confidence: 1.7
 * - decay: -0.4
 *
 * After:
 * - confidence: 1
 * - decay: 0
 */
export function normalizeMemoryScores(fragment: LumiMemoryFragment): LumiMemoryFragment {
  const scope = normalizeMemoryScope(fragment.scope)
  const participantUserIds = uniqueStrings(fragment.participantUserIds)
  if (scope !== 'global' && scope !== 'shared' && participantUserIds.length === 0 && fragment.userId)
    participantUserIds.push(fragment.userId)
  const normalized: LumiMemoryFragment = {
    ...fragment,
    scope,
    ownerType: normalizeOwnerType(fragment.ownerType, scope),
    ownerId: fragment.ownerId?.trim() || defaultOwnerId(fragment, scope),
    visibility: normalizeVisibility(fragment.visibility, scope),
    participantUserIds,
    subjectUserIds: uniqueStrings(fragment.subjectUserIds),
    sensitivity: normalizeSensitivity(fragment.sensitivity, scope),
    sourceActorId: fragment.sourceActorId?.trim() || fragment.userId,
    sourceConversationType: normalizeSourceConversationType(fragment.sourceConversationType),
    classificationReason: fragment.classificationReason?.trim() || 'Legacy memory normalized under the current access policy.',
    disclosureReason: fragment.disclosureReason?.trim() || defaultDisclosureReason(scope),
  }
  for (const field of boundedNumberFields) {
    normalized[field] = clamp01(fragment[field])
  }
  return normalized
}

/**
 * Checks whether a user may retrieve a memory in the current interaction.
 *
 * Use when:
 * - Filtering lexical or vector memory pools
 * - Projecting host-owned memories to a remote channel user
 *
 * Expects:
 * - Legacy memories may omit scope metadata and are treated as relationship-only
 *
 * Returns:
 * - True only when the viewer belongs to the memory's disclosure audience
 */
export function canAccessLumiMemory(fragment: LumiMemoryFragment, request: LumiMemorySearchRequest): boolean {
  const memory = normalizeMemoryScores(fragment)
  const viewerUserId = request.viewerUserId || request.userId
  if (memory.scope === 'global')
    return memory.sensitivity !== 'private'
  if (memory.scope === 'shared')
    return memory.sensitivity !== 'private'

  // Group turns must never inherit a participant's direct-message relationship
  // or private memories, even when that participant is the current speaker.
  if (request.conversationType === 'group') {
    if (memory.scope !== 'group')
      return false
    if (!memory.participantUserIds?.includes(viewerUserId))
      return false
    if (!request.conversationId)
      return false
    return memory.ownerId === request.conversationId
  }

  if (memory.scope === 'relationship')
    return memory.ownerId === viewerUserId || memory.participantUserIds?.includes(viewerUserId) === true
  if (memory.scope === 'group') {
    return false
  }
  return memory.participantUserIds?.includes(viewerUserId) === true
}

/**
 * Checks whether a memory may be displayed directly in a user-facing inspector.
 *
 * Use when:
 * - A settings page lists raw memory content outside Lumi's conversational disclosure flow
 * - A participant inspects memories created under their own identity or group
 *
 * Expects:
 * - Model retrieval remains governed separately by {@link canAccessLumiMemory}
 *
 * Returns:
 * - True for Lumi-global facts, the viewer's own memories, and groups containing the viewer
 */
export function canInspectLumiMemory(fragment: LumiMemoryFragment, viewerUserId: string): boolean {
  const memory = normalizeMemoryScores(fragment)
  if (memory.scope === 'global')
    return memory.ownerType === 'lumi' && memory.sensitivity !== 'private'
  if (memory.scope === 'group')
    return memory.participantUserIds?.includes(viewerUserId) === true
  return memory.ownerId === viewerUserId || memory.userId === viewerUserId
}

function normalizeMemoryScope(value: LumiMemoryScope | undefined): LumiMemoryScope {
  return value === 'global' || value === 'shared' || value === 'group' || value === 'private' ? value : 'relationship'
}

function normalizeOwnerType(value: LumiMemoryOwnerType | undefined, scope: LumiMemoryScope): LumiMemoryOwnerType {
  if (value === 'lumi' || value === 'user' || value === 'group')
    return value
  if (scope === 'global')
    return 'lumi'
  if (scope === 'group')
    return 'group'
  return 'user'
}

function normalizeVisibility(value: LumiMemoryVisibility | undefined, scope: LumiMemoryScope): LumiMemoryVisibility {
  if (value === 'global' || value === 'shared' || value === 'participants' || value === 'private')
    return value
  if (scope === 'global')
    return 'global'
  if (scope === 'shared')
    return 'shared'
  if (scope === 'private')
    return 'private'
  return 'participants'
}

function normalizeSensitivity(value: LumiMemorySensitivity | undefined, scope: LumiMemoryScope): LumiMemorySensitivity {
  return value === 'private' || scope === 'private' ? 'private' : 'normal'
}

function normalizeSourceConversationType(value: LumiMemorySourceConversationType | undefined): LumiMemorySourceConversationType {
  return value === 'direct' || value === 'group' || value === 'manual' ? value : 'import'
}

function defaultDisclosureReason(scope: LumiMemoryScope) {
  if (scope === 'global')
    return 'Legacy Lumi-owned memory available in every authorized conversation.'
  if (scope === 'shared')
    return 'Legacy non-private memory marked shareable across relationships.'
  if (scope === 'group')
    return 'Legacy group memory visible only in its owning conversation.'
  if (scope === 'private')
    return 'Private memory; never disclose outside its source relationship.'
  return 'Relationship memory visible only to its owning user.'
}

function defaultOwnerId(fragment: LumiMemoryFragment, scope: LumiMemoryScope) {
  if (scope === 'global')
    return fragment.personaId || 'lumi'
  if (scope === 'group')
    return fragment.conversationId || 'unassigned-group'
  return fragment.userId
}

function uniqueStrings(values: string[] | undefined) {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))]
}

/**
 * Clamps all scalar state values into normalized bounds.
 *
 * Before:
 * - mood.irritation: 2
 * - relationship.trust: -0.2
 *
 * After:
 * - mood.irritation: 1
 * - relationship.trust: 0
 */
export function normalizeStateSnapshot(snapshot: LumiStateSnapshot): LumiStateSnapshot {
  const source = asRecord(snapshot)
  const baseline = createDefaultLumiStateSnapshot({
    userId: readString(source, 'userId', 'user_id') || 'local',
    personaId: readString(source, 'personaId', 'persona_id') || 'lumi',
    updatedAt: readString(source, 'updatedAt', 'updated_at') || new Date().toISOString(),
  })
  const mood = asRecord(source.mood)
  const relationship = asRecord(source.relationship)

  return {
    ...baseline,
    ...snapshot,
    personaId: readString(source, 'personaId', 'persona_id') || baseline.personaId,
    userId: readString(source, 'userId', 'user_id') || baseline.userId,
    dominantEmotion: readString(source, 'dominantEmotion', 'dominant_emotion') as LumiStateSnapshot['dominantEmotion'] || baseline.dominantEmotion,
    updatedAt: readString(source, 'updatedAt', 'updated_at') || baseline.updatedAt,
    mood: {
      valence: clampSigned(readNumber(mood, baseline.mood.valence, 'valence')),
      arousal: clamp01(readNumber(mood, baseline.mood.arousal, 'arousal')),
      stress: clamp01(readNumber(mood, baseline.mood.stress, 'stress')),
      irritation: clamp01(readNumber(mood, baseline.mood.irritation, 'irritation')),
      fatigue: clamp01(readNumber(mood, baseline.mood.fatigue, 'fatigue')),
      warmth: clamp01(readNumber(mood, baseline.mood.warmth, 'warmth')),
      defensiveness: clamp01(readNumber(mood, baseline.mood.defensiveness, 'defensiveness')),
      curiosity: clamp01(readNumber(mood, baseline.mood.curiosity, 'curiosity')),
      sadness: clamp01(readNumber(mood, baseline.mood.sadness, 'sadness')),
      sensitivity: clamp01(readNumber(mood, baseline.mood.sensitivity, 'sensitivity')),
    },
    relationship: {
      ...baseline.relationship,
      ...relationship,
      relationshipScore: clamp01(readRelationshipScore(relationship, baseline.relationship.relationshipScore)),
      trust: clamp01(readNumber(relationship, baseline.relationship.trust, 'trust')),
      familiarity: clamp01(readNumber(relationship, baseline.relationship.familiarity, 'familiarity')),
      attachment: clamp01(readNumber(relationship, baseline.relationship.attachment, 'attachment')),
      recentConflict: readBoolean(relationship, baseline.relationship.recentConflict, 'recentConflict', 'recent_conflict'),
      lastConflictSummary: readString(relationship, 'lastConflictSummary', 'last_conflict_summary') || undefined,
      conflictCooldownTurns: Math.max(0, Math.floor(readNumber(relationship, baseline.relationship.conflictCooldownTurns, 'conflictCooldownTurns', 'conflict_cooldown_turns'))),
      unresolvedConflict: readBoolean(relationship, baseline.relationship.unresolvedConflict, 'unresolvedConflict', 'unresolved_conflict'),
      repairRequired: readBoolean(relationship, baseline.relationship.repairRequired, 'repairRequired', 'repair_required'),
      hurt: clamp01(readNumber(relationship, baseline.relationship.hurt, 'hurt')),
      resentment: clamp01(readNumber(relationship, baseline.relationship.resentment, 'resentment')),
      topicShiftResistance: clamp01(readNumber(relationship, baseline.relationship.topicShiftResistance, 'topicShiftResistance', 'topic_shift_resistance')),
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function readNumber(source: Record<string, unknown>, fallback: number, ...keys: string[]): number {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value))
      return value
  }
  return fallback
}

function readRelationshipScore(source: Record<string, unknown>, fallback: number): number {
  const raw = readNumber(source, fallback, 'relationshipScore', 'relationship_score')
  return raw > 1 ? raw / 100 : raw
}

function readString(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string')
      return value
  }
  return ''
}

function readBoolean(source: Record<string, unknown>, fallback: boolean, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'boolean')
      return value
  }
  return fallback
}

function clamp01(value: number): number {
  if (!Number.isFinite(value))
    return 0
  return Math.min(1, Math.max(0, value))
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value))
    return 0
  return Math.min(1, Math.max(-1, value))
}
