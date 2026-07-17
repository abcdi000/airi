import type { LumiMemoryFragment, LumiStateSnapshot } from './types'

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
  const normalized = { ...fragment }
  for (const field of boundedNumberFields) {
    normalized[field] = clamp01(fragment[field])
  }
  return normalized
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
