import type {
  LanguageLearningConfig,
  SocialLanguageEvidence,
} from './types'

export type SocialLanguageCandidateIngress
  = | 'direct_turn'
    | 'group_observation'

/**
 * Decides whether one trusted evidence item may create social-language candidates.
 *
 * Group learning is accepted only through the dedicated read-only observation
 * ingress. Direct turns remain feedback-only unless the owner explicitly enables
 * the compatibility switch.
 */
export function canCreateSocialLanguageCandidates(input: {
  config: LanguageLearningConfig
  evidence: SocialLanguageEvidence
  ingress: SocialLanguageCandidateIngress
}): boolean {
  if (!input.config.enabled || !input.evidence.authorVerified)
    return false

  if (input.ingress === 'group_observation') {
    return input.evidence.sourceKind === 'group_chat'
      && input.evidence.source === 'human'
  }

  return input.config.directLanguageCandidateLearningEnabled
    && input.evidence.sourceKind === 'chat'
}
