import type { LumiMemoryFragment } from '../types'
import type { LumiHypothesisObservation } from './beliefs'
import type { LumiCognitiveEvidence } from './types'

/** Why one curated memory cannot participate in cognitive consolidation. */
export type LumiMemoryCognitiveObservationRejection
  = | 'unsupported_memory_type'
    | 'missing_semantic_tag'
    | 'invalid_source_evidence'

/** Host-validated result of mapping a curated memory to one cognitive predicate. */
export type LumiMemoryCognitiveObservationResult
  = | {
    supported: true
    observation: LumiHypothesisObservation
  }
  | {
    supported: false
    reason: LumiMemoryCognitiveObservationRejection
  }

/**
 * Derives one evidence-backed hypothesis observation from a curated memory.
 *
 * Use when:
 * - Desktop or server medium-loop persistence has a model-curated memory
 * - The host has loaded the matching immutable primary message evidence
 *
 * Expects:
 * - Memory scope/classification was already host-validated
 * - Evidence belongs to the memory actor and source message
 *
 * Returns:
 * - A shared predicate/value/TTL policy, or a stable rejection reason
 */
export function deriveLumiMemoryCognitiveObservation(
  memory: LumiMemoryFragment,
  evidence: LumiCognitiveEvidence,
): LumiMemoryCognitiveObservationResult {
  if (
    evidence.origin !== 'primary'
    || evidence.actorId !== memory.userId
    || !evidence.subjectUserIds.includes(memory.userId)
    || !memory.sourceMessageId
    || evidence.sourceMessageId !== memory.sourceMessageId
    || (memory.conversationId && evidence.conversationId !== memory.conversationId)
  ) {
    return { supported: false, reason: 'invalid_source_evidence' }
  }
  const prefix = cognitiveMemoryPrefix(memory.type)
  if (!prefix)
    return { supported: false, reason: 'unsupported_memory_type' }
  const semanticTag = memory.tags
    .map(tag => stableCognitiveKey(tag))
    .find(tag => tag && !['auto-memory', 'needs-review', 'explicit-remember', 'lumi-self'].includes(tag))
  if (!semanticTag)
    return { supported: false, reason: 'missing_semantic_tag' }
  return {
    supported: true,
    observation: {
      subjectId: memory.userId,
      predicate: `${prefix}:${semanticTag}`,
      value: memory.content,
      evidence,
      ttlMs: cognitiveMemoryTtlMs(memory.type),
    },
  }
}

function cognitiveMemoryPrefix(type: LumiMemoryFragment['type']): string | undefined {
  switch (type) {
    case 'user_preference':
      return 'preference'
    case 'user_fact':
      return 'fact'
    case 'project_context':
      return 'project'
    case 'promise':
      return 'decision'
    case 'temporary_context':
      return 'current_state'
    case 'emotional_echo':
      return 'current_mood'
    default:
      return undefined
  }
}

function cognitiveMemoryTtlMs(type: LumiMemoryFragment['type']): number {
  switch (type) {
    case 'temporary_context':
      return 2 * 24 * 60 * 60 * 1000
    case 'emotional_echo':
      return 24 * 60 * 60 * 1000
    case 'project_context':
    case 'promise':
      return 90 * 24 * 60 * 60 * 1000
    default:
      return 180 * 24 * 60 * 60 * 1000
  }
}

function stableCognitiveKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9\u4E00-\u9FFF]+/g, '-').replace(/^-|-$/g, '')
}
