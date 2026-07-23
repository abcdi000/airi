import type { LumiConsciousnessRequest } from './consciousness'

import { describe, expect, it, vi } from 'vitest'

import { createLumiNodeConsciousness } from './consciousness'
import {
  DOGGY_MOUSSY_GROUP_ID,
  DOGGY_PERSON_ID,
  LumiServerDatabase,
  MOUSSY_PERSON_ID,
} from './database'

function input(conversationId: string, actorPersonId: string, actorDisplayName: string) {
  return {
    id: `input:${actorPersonId}`,
    conversationId,
    sequence: 1,
    role: 'user' as const,
    actorPersonId,
    actorDisplayName,
    content: 'Do you remember?',
    createdAt: Date.now(),
  }
}

describe('createLumiNodeConsciousness', () => {
  it('projects only the direct user state and authorized memories', async () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      database.writePersonState({ personId: DOGGY_PERSON_ID, kind: 'profile', payload: { favorite: 'Minecraft' } })
      database.writePersonState({ personId: MOUSSY_PERSON_ID, kind: 'profile', payload: { privateFavorite: 'secret' } })
      const memory = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
        candidate: {
          type: 'user_fact',
          content: 'Doggy likes building houses.',
          confidence: 1,
          importance: 1,
          emotionalIntensity: 0.2,
          relationshipRelevance: 0.7,
          decay: 0.1,
          tags: [],
          status: 'candidate',
          reason: 'test',
        },
      })
      database.setMemoryStatus(memory.id, 'active')
      const generate = vi.fn(async (_request: LumiConsciousnessRequest) => ({ text: 'Yes.' }))
      const runtime = createLumiNodeConsciousness({ database, model: { generate }, personaPrompt: 'You are Lumi.' })
      const userInput = input(`lumi-direct:${DOGGY_PERSON_ID}`, DOGGY_PERSON_ID, 'Doggy')

      await runtime.generate({
        conversation: database.listConversations(DOGGY_PERSON_ID)[0],
        history: [userInput],
        input: userInput,
      }, () => {})

      const request = generate.mock.calls[0][0]
      expect(request.personStates).toHaveLength(1)
      expect(request.personStates[0].payload).toEqual({ favorite: 'Minecraft' })
      expect(request.memories.map(item => item.content)).toEqual(['Doggy likes building houses.'])
      expect(request.messages[0].content).not.toContain('privateFavorite')
    }
    finally {
      database.close()
    }
  })

  it('labels group speakers without injecting any direct person state', async () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      database.writePersonState({ personId: DOGGY_PERSON_ID, kind: 'short-term', payload: { privateTopic: 'hidden' } })
      const generate = vi.fn(async (_request: LumiConsciousnessRequest) => ({ text: 'I can hear you both.' }))
      const runtime = createLumiNodeConsciousness({ database, model: { generate }, personaPrompt: 'You are Lumi.' })
      const doggyInput = input(DOGGY_MOUSSY_GROUP_ID, DOGGY_PERSON_ID, 'Doggy')
      const moussyInput = input(DOGGY_MOUSSY_GROUP_ID, MOUSSY_PERSON_ID, 'Moussy')

      await runtime.generate({
        conversation: database.listConversations(DOGGY_PERSON_ID).find(item => item.id === DOGGY_MOUSSY_GROUP_ID)!,
        history: [doggyInput, moussyInput],
        input: moussyInput,
      }, () => {})

      const request = generate.mock.calls[0][0]
      expect(request.personStates).toEqual([])
      expect(request.messages.map(item => item.content)).toEqual(expect.arrayContaining([
        '[Doggy] Do you remember?',
        '[Moussy] Do you remember?',
      ]))
      expect(request.messages[0].content).not.toContain('privateTopic')
      expect(request.messages[0].content).toContain('Current authenticated speaker: Moussy')
    }
    finally {
      database.close()
    }
  })

  it('shares Lumi facts and ordinary experiences without leaking private relationship memory', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const requests: LumiConsciousnessRequest[] = []
    try {
      const runtime = createLumiNodeConsciousness({
        database,
        personaPrompt: 'You are Lumi.',
        model: {
          async generate(request) {
            requests.push(request)
            return requests.length === 1
              ? {
                  text: 'I will remember with the correct boundaries.',
                  candidateMemories: [
                    candidate('Lumi\'s birthday is July 21.', 'persona_fact', { scope: 'global', tags: ['lumi_self'] }),
                    candidate('Doggy felt happy after finishing a difficult feature.', 'shared_event', { scope: 'shared' }),
                    candidate('Doggy keeps a private account recovery phrase.', 'user_fact', { scope: 'private', sensitivity: 'private' }),
                  ],
                }
              : { text: 'I remember my own birthday and a shareable experience.' }
          },
        },
      })
      const doggyInput = input(`lumi-direct:${DOGGY_PERSON_ID}`, DOGGY_PERSON_ID, 'Doggy')
      await runtime.generate({
        conversation: database.listConversations(DOGGY_PERSON_ID).find(item => item.id === `lumi-direct:${DOGGY_PERSON_ID}`)!,
        history: [doggyInput],
        input: doggyInput,
      }, () => {})

      const moussyInput = input(`lumi-direct:${MOUSSY_PERSON_ID}`, MOUSSY_PERSON_ID, 'Moussy')
      await runtime.generate({
        conversation: database.listConversations(MOUSSY_PERSON_ID).find(item => item.id === `lumi-direct:${MOUSSY_PERSON_ID}`)!,
        history: [moussyInput],
        input: moussyInput,
      }, () => {})

      expect(requests[1].memories.map(memory => memory.content)).toEqual(expect.arrayContaining([
        'Lumi\'s birthday is July 21.',
        'Doggy felt happy after finishing a difficult feature.',
      ]))
      expect(requests[1].memories.some(memory => memory.content.includes('recovery phrase'))).toBe(false)
      expect(requests[1].personStates.every(state => state.personId === MOUSSY_PERSON_ID)).toBe(true)
    }
    finally {
      database.close()
    }
  })

  it('updates only the direct actor state and preserves migrated payload fields', async () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      database.writePersonState({
        personId: DOGGY_PERSON_ID,
        kind: 'profile',
        payload: { entries: [{ key: 'legacy-impression', value: 'preserved' }] },
      })
      const runtime = createLumiNodeConsciousness({
        database,
        personaPrompt: 'You are Lumi.',
        model: {
          async generate(request) {
            return {
              text: 'State noted.',
              personStateUpdates: request.conversationType === 'direct'
                ? {
                    'profile': { impression: 'Doggy is focused on the server refactor.' },
                    'short-term': { currentFocus: 'Lumi Online testing' },
                    'emotion': { warmth: 0.8 },
                    'relationship': { trust: 0.9 },
                  }
                : { profile: { forbiddenGroupProjection: true } },
            }
          },
        },
      })
      const directInput = input(`lumi-direct:${DOGGY_PERSON_ID}`, DOGGY_PERSON_ID, 'Doggy')
      await runtime.generate({
        conversation: database.listConversations(DOGGY_PERSON_ID).find(item => item.id === `lumi-direct:${DOGGY_PERSON_ID}`)!,
        history: [directInput],
        input: directInput,
      }, () => {})

      expect(database.readPersonState(DOGGY_PERSON_ID, 'profile')?.payload).toMatchObject({
        entries: [{ key: 'legacy-impression', value: 'preserved' }],
        onlineCurator: { impression: 'Doggy is focused on the server refactor.', sourceMessageId: directInput.id },
      })
      expect(database.readPersonState(DOGGY_PERSON_ID, 'short-term')?.payload).toMatchObject({
        onlineCurator: { currentFocus: 'Lumi Online testing' },
      })

      const groupInput = input(DOGGY_MOUSSY_GROUP_ID, DOGGY_PERSON_ID, 'Doggy')
      await runtime.generate({
        conversation: database.listConversations(DOGGY_PERSON_ID).find(item => item.id === DOGGY_MOUSSY_GROUP_ID)!,
        history: [groupInput],
        input: groupInput,
      }, () => {})
      expect(database.readPersonState(DOGGY_PERSON_ID, 'profile')?.payload).not.toHaveProperty('onlineCurator.forbiddenGroupProjection')
      expect(database.readPersonState(MOUSSY_PERSON_ID, 'profile')).toBeUndefined()
    }
    finally {
      database.close()
    }
  })
})

function candidate(
  content: string,
  type: 'persona_fact' | 'shared_event' | 'user_fact',
  policy: { scope: 'global' | 'shared' | 'private', tags?: string[], sensitivity?: 'private' },
) {
  return {
    type,
    content,
    confidence: 0.95,
    importance: 0.9,
    emotionalIntensity: 0.2,
    relationshipRelevance: 0.7,
    decay: 0.1,
    tags: policy.tags ?? [],
    status: 'candidate' as const,
    reason: 'test',
    scope: policy.scope,
    sensitivity: policy.sensitivity,
  }
}
