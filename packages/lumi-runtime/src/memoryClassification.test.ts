import type { LumiMemoryCandidate } from './types'

import { describe, expect, it } from 'vitest'

import { classifyLumiMemoryCandidate } from './memoryClassification'

function candidate(patch: Partial<LumiMemoryCandidate>): LumiMemoryCandidate {
  return {
    type: 'user_fact',
    content: 'Doggy uses Windows.',
    confidence: 0.95,
    importance: 0.9,
    emotionalIntensity: 0.1,
    relationshipRelevance: 0.5,
    decay: 0,
    tags: [],
    status: 'candidate',
    reason: 'test',
    ...patch,
  }
}

const direct = {
  actorId: 'doggy',
  personaId: 'lumi-card',
  conversationId: 'doggy-direct',
  conversationType: 'direct' as const,
  participantUserIds: ['doggy'],
}

describe('lumi memory classification policy', () => {
  /** @example A real Lumi self fact becomes available across relationships. */
  it('promotes an explicit Lumi self fact to global ownership', () => {
    expect(classifyLumiMemoryCandidate(candidate({
      type: 'persona_fact',
      content: 'Lumi\'s birthday is May 13.',
      tags: ['lumi_self', 'birthday'],
      scope: 'global',
    }), direct)).toMatchObject({
      scope: 'global',
      ownerType: 'lumi',
      participantUserIds: [],
      subjectUserIds: ['lumi'],
      sourceActorId: 'doggy',
    })
  })

  /** @example A mislabeled user fact cannot become global merely by carrying a model tag. */
  it('downgrades a mislabeled user fact from global to relationship', () => {
    expect(classifyLumiMemoryCandidate(candidate({
      type: 'persona_fact',
      content: 'Doggy\'s birthday is May 1.',
      tags: ['lumi_self'],
      scope: 'global',
    }), direct)).toMatchObject({
      scope: 'relationship',
      ownerId: 'doggy',
      participantUserIds: ['doggy'],
    })
  })

  /** @example Privacy always wins over a model proposal to share. */
  it('forces private sensitivity into the source relationship', () => {
    expect(classifyLumiMemoryCandidate(candidate({
      type: 'shared_event',
      scope: 'shared',
      sensitivity: 'private',
    }), direct)).toMatchObject({
      scope: 'private',
      visibility: 'private',
      participantUserIds: ['doggy'],
    })
  })

  /** @example Group evidence belongs to the exact host-authorized room. */
  it('assigns non-private group evidence to its room participants', () => {
    expect(classifyLumiMemoryCandidate(candidate({ type: 'shared_event' }), {
      ...direct,
      conversationId: 'doggy-moussy-room',
      conversationType: 'group',
      participantUserIds: ['doggy', 'moussy'],
    })).toMatchObject({
      scope: 'group',
      ownerId: 'doggy-moussy-room',
      participantUserIds: ['doggy', 'moussy'],
    })
  })

  /** @example Only ordinary events and moods may cross direct relationships. */
  it('allows shareable daily events but downgrades shared user facts', () => {
    expect(classifyLumiMemoryCandidate(candidate({ type: 'shared_event', scope: 'shared' }), direct).scope).toBe('shared')
    expect(classifyLumiMemoryCandidate(candidate({ type: 'user_fact', scope: 'shared' }), direct).scope).toBe('relationship')
  })
})
