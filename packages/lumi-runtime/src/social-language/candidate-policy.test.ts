import { describe, expect, it } from 'vitest'

import { canCreateSocialLanguageCandidates } from './candidate-policy'
import { DEFAULT_LANGUAGE_LEARNING_CONFIG } from './config'

describe('social-language candidate policy', () => {
  it('keeps direct turns feedback-only by default', () => {
    // ROOT CAUSE:
    //
    // Private-chat evidence previously entered the same candidate learner as
    // group observations, so ordinary direct turns created new language assets.
    // The ingress policy now requires an explicit owner opt-in for that legacy
    // behavior while leaving delayed feedback on existing assets independent.
    expect(canCreateSocialLanguageCandidates({
      config: { ...DEFAULT_LANGUAGE_LEARNING_CONFIG },
      evidence: evidence('chat'),
      ingress: 'direct_turn',
    })).toBe(false)
  })

  it('allows an explicit direct-learning compatibility opt-in', () => {
    expect(canCreateSocialLanguageCandidates({
      config: {
        ...DEFAULT_LANGUAGE_LEARNING_CONFIG,
        directLanguageCandidateLearningEnabled: true,
      },
      evidence: evidence('chat'),
      ingress: 'direct_turn',
    })).toBe(true)
  })

  it('accepts group evidence only through the group-observation ingress', () => {
    expect(canCreateSocialLanguageCandidates({
      config: { ...DEFAULT_LANGUAGE_LEARNING_CONFIG },
      evidence: evidence('group_chat'),
      ingress: 'direct_turn',
    })).toBe(false)
    expect(canCreateSocialLanguageCandidates({
      config: { ...DEFAULT_LANGUAGE_LEARNING_CONFIG },
      evidence: evidence('group_chat'),
      ingress: 'group_observation',
    })).toBe(true)
  })

  it('rejects Lumi-authored and unverified group observations', () => {
    expect(canCreateSocialLanguageCandidates({
      config: { ...DEFAULT_LANGUAGE_LEARNING_CONFIG },
      evidence: { ...evidence('group_chat'), source: 'lumi' },
      ingress: 'group_observation',
    })).toBe(false)
    expect(canCreateSocialLanguageCandidates({
      config: { ...DEFAULT_LANGUAGE_LEARNING_CONFIG },
      evidence: { ...evidence('group_chat'), authorVerified: false },
      ingress: 'group_observation',
    })).toBe(false)
  })
})

function evidence(sourceKind: 'chat' | 'group_chat') {
  return {
    messageId: 'message-1',
    text: 'verified evidence',
    personId: 'person-1',
    conversationId: 'conversation-1',
    platform: 'test',
    timestamp: 1,
    source: 'human' as const,
    sourceKind,
    authorVerified: true,
  }
}
