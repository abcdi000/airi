import type {
  LumiBeliefHypothesis,
  LumiCognitiveEvidence,
  LumiCognitiveProfileProjection,
} from './types'

import {
  decayLumiBeliefHypothesis,
  projectLumiBeliefsToProfile,
} from './beliefs'

/** Result of one deterministic cognitive slow-loop pass for one person. */
export interface LumiCognitiveMaintenanceResult {
  /** Beliefs after TTL expiry, confidence decay, and status downgrade. */
  beliefs: LumiBeliefHypothesis[]
  /** Fresh profile materializations derived from maintained beliefs. */
  projections: LumiCognitiveProfileProjection[]
  /** Beliefs that became expired during this pass. */
  expiredCount: number
  /** Stable or supported beliefs moved to a weaker status. */
  downgradedCount: number
}

/**
 * Runs the shared deterministic cognitive slow-loop policy for one person.
 *
 * Use when:
 * - Desktop or server background maintenance has loaded one actor's beliefs and evidence
 * - Profile projections need rebuilding without another model request
 *
 * Expects:
 * - Evidence IDs retain immutable actor lineage
 * - The host writes results only inside the same actor boundary
 *
 * Returns:
 * - Decayed beliefs and rebuilt profile projections with audit counts
 */
export function maintainLumiCognitiveState(input: {
  subjectId: string
  beliefs: readonly LumiBeliefHypothesis[]
  evidenceById: ReadonlyMap<string, LumiCognitiveEvidence>
  now?: string
}): LumiCognitiveMaintenanceResult {
  const now = input.now ?? new Date().toISOString()
  const sourceBeliefs = input.beliefs.filter(belief => belief.subjectId === input.subjectId)
  const beliefs = sourceBeliefs
    .map(belief => decayLumiBeliefHypothesis(belief, now))
  return {
    expiredCount: beliefs.filter((belief, index) =>
      belief.status === 'expired' && sourceBeliefs[index]?.status !== 'expired',
    ).length,
    downgradedCount: beliefs.filter((belief, index) =>
      statusRank(belief.status) < statusRank(sourceBeliefs[index]?.status),
    ).length,
    beliefs,
    projections: projectLumiBeliefsToProfile({
      subjectId: input.subjectId,
      beliefs,
      evidenceById: input.evidenceById,
      now,
    }),
  }
}

function statusRank(status: LumiBeliefHypothesis['status'] | undefined): number {
  switch (status) {
    case 'stable':
      return 4
    case 'supported':
      return 3
    case 'tentative':
      return 2
    case 'contradicted':
      return 1
    case 'expired':
    default:
      return 0
  }
}
