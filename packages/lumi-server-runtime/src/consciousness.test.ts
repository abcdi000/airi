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
      const runtime = createLumiNodeConsciousness({
        database,
        model: { generate, generateLanguageText: async () => visibleReply('Yes.') },
        personaPrompt: 'You are Lumi.',
      })
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
      expect(request.messages[0].content).not.toContain('Doggy likes building houses.')
      expect(request.messages[0].content).not.toContain('Minecraft')
      const authorizedEvidence = request.messages.find(message => message.content.includes('[Lumi authorized turn evidence]'))
      expect(authorizedEvidence?.content).toContain('Doggy likes building houses.')
      expect(authorizedEvidence?.content).toContain('Minecraft')
      expect(request.messages.at(-1)?.content).toContain('[Lumi planner turn context]')
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
      const runtime = createLumiNodeConsciousness({
        database,
        model: { generate, generateLanguageText: async () => visibleReply('I can hear you both.') },
        personaPrompt: 'You are Lumi.',
      })
      const doggyInput = input(DOGGY_MOUSSY_GROUP_ID, DOGGY_PERSON_ID, 'Doggy')
      const moussyInput = input(DOGGY_MOUSSY_GROUP_ID, MOUSSY_PERSON_ID, 'Moussy')

      await runtime.generate({
        conversation: database.listConversations(DOGGY_PERSON_ID).find(item => item.id === DOGGY_MOUSSY_GROUP_ID)!,
        history: [doggyInput, moussyInput],
        input: moussyInput,
      }, () => {})

      const request = generate.mock.calls[0][0]
      expect(request.personStates).toEqual([])
      expect(request.messages.map(item => item.content)).toContain('[Doggy] Do you remember?')
      const authorizedEvidence = request.messages.find(message => message.content.includes('[Lumi authorized turn evidence]'))
      expect(authorizedEvidence?.content).toMatch(/^\[Moussy\] Do you remember\?/)
      expect(authorizedEvidence?.content).toContain('[Lumi authorized turn evidence]')
      expect(request.messages.at(-1)?.content).toContain('[Lumi planner turn context]')
      expect(request.messages[0].content).not.toContain('privateTopic')
      expect(request.messages[0].content).not.toContain('Current authenticated speaker: Moussy')
      expect(authorizedEvidence?.name).toBe('Moussy')
      expect(authorizedEvidence?.content).toContain('[Moussy] Do you remember?')
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
            return { text: plannerReply('answer') }
          },
          async generateLanguageText() {
            return visibleReply(requests.length === 1
              ? 'I will remember with the correct boundaries.'
              : 'I remember my own birthday and a shareable experience.')
          },
          async curateTurn() {
            return requests.length === 1
              ? {
                  candidateMemories: [
                    candidate('Lumi\'s birthday is July 21.', 'persona_fact', { scope: 'global', tags: ['lumi_self'] }),
                    candidate('Doggy felt happy after finishing a difficult feature.', 'shared_event', { scope: 'shared' }),
                    candidate('Doggy keeps a private account recovery phrase.', 'user_fact', { scope: 'private', sensitivity: 'private' }),
                  ],
                }
              : {}
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
          async generate(_request) {
            return { text: plannerReply('acknowledge') }
          },
          async generateLanguageText() {
            return visibleReply('State noted.')
          },
          async curateTurn(request) {
            return {
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

  it('keeps language decisions from different conversations that finish concurrently', async () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      const runtime = createLumiNodeConsciousness({
        database,
        personaPrompt: 'You are Lumi.',
        model: {
          async generate(request) {
            await new Promise(resolve => setTimeout(resolve, request.actorPersonId === DOGGY_PERSON_ID ? 20 : 1))
            return { text: plannerReply('answer') }
          },
          async generateLanguageText() {
            return visibleReply('收到。')
          },
        },
      })
      const doggyInput = input(`lumi-direct:${DOGGY_PERSON_ID}`, DOGGY_PERSON_ID, 'Doggy')
      const moussyInput = input(`lumi-direct:${MOUSSY_PERSON_ID}`, MOUSSY_PERSON_ID, 'Moussy')

      await Promise.all([
        runtime.generate({
          conversation: database.listConversations(DOGGY_PERSON_ID).find(item => item.id === doggyInput.conversationId)!,
          history: [doggyInput],
          input: doggyInput,
        }, () => {}),
        runtime.generate({
          conversation: database.listConversations(MOUSSY_PERSON_ID).find(item => item.id === moussyInput.conversationId)!,
          history: [moussyInput],
          input: moussyInput,
        }, () => {}),
      ])

      expect(database.getSocialLanguageSnapshot().decisions).toHaveLength(2)
      expect(database.getSocialLanguageSnapshot().decisions.map(item => item.personId)).toEqual(
        expect.arrayContaining([DOGGY_PERSON_ID, MOUSSY_PERSON_ID]),
      )
    }
    finally {
      database.close()
    }
  })

  it('compresses an oversized online timeline with the consciousness model and persists its cursor', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const conversationId = `lumi-direct:${DOGGY_PERSON_ID}`
    try {
      for (let index = 0; index < 70; index += 1) {
        database.acceptUserMessage({
          conversationId,
          actorPersonId: DOGGY_PERSON_ID,
          messageId: `context-user-${index}`,
          idempotencyKey: `context-user-${index}`,
          content: `第 ${index} 轮用户消息 ${'需要保留的长期上下文'.repeat(80)}`,
          createdAt: index * 2 + 1,
        })
        database.appendAssistantMessage({
          conversationId,
          messageId: `context-assistant-${index}`,
          content: `第 ${index} 轮 Lumi 回复 ${'具体事实与未完成事项'.repeat(80)}`,
          createdAt: index * 2 + 2,
        })
      }
      const history = database.replay(conversationId, DOGGY_PERSON_ID, 0, 1_000).messages
      const currentInput = history.findLast(message => message.role === 'user')!
      const requests: LumiConsciousnessRequest[] = []
      const purposes: string[] = []
      const languageRequests: Array<{
        messages: Array<{ role: 'system' | 'user' | 'assistant', content: string, name?: string }>
        purpose: string
      }> = []
      const runtime = createLumiNodeConsciousness({
        database,
        personaPrompt: 'You are Lumi.',
        maxContextTokens: 32_000,
        outputReserveTokens: 2_000,
        promptReserveTokens: 2_000,
        model: {
          async generate(request) {
            requests.push(request)
            return { text: plannerReply('answer') }
          },
          async generateLanguageText(messages, purpose) {
            purposes.push(purpose)
            languageRequests.push({ messages, purpose })
            return purpose === 'context_summary'
              ? '较早轮次的结构化连续性摘要'
              : visibleReply('我记得前面的事')
          },
        },
      })

      await runtime.generate({
        conversation: database.listConversations(DOGGY_PERSON_ID).find(item => item.id === conversationId)!,
        history,
        input: currentInput,
      }, () => {})

      expect(purposes).toContain('context_summary')
      expect(database.getConversationSummary(conversationId)?.sourceMessageCount).toBeGreaterThan(0)
      expect(requests[0]?.messages.some(message => message.content.includes('conversation continuity summary'))).toBe(true)
      expect(requests[0]?.messages.some(message => message.content.includes('第 69 轮用户消息'))).toBe(true)
      const replyerRequest = languageRequests.find(request => request.purpose === 'replyer')
      expect(replyerRequest?.messages.some(message => message.content.includes('final-response planning contract'))).toBe(false)
      expect(replyerRequest?.messages.at(-1)?.content).toContain('较早轮次的结构化连续性摘要')
    }
    finally {
      database.close()
    }
  })
})

function plannerReply(replyAct: string) {
  return JSON.stringify({
    shouldReply: true,
    replyAct,
    semanticGoal: 'Respond naturally while preserving the tested server policy.',
    keyPoints: ['Preserve authorized facts and relationship boundaries.'],
    referenceInfo: [],
    attitude: { willingnessToHelp: 'normal' },
    emotion: { primary: 'neutral', intensity: 0.3 },
    defenseState: { active: false, refusalRequired: false, prohibitedHelpTypes: [] },
    expressionIntent: {
      focus: 'the current message',
      scene: 'direct_chat',
      tone: 'natural',
      desiredLength: 'short',
      preferredActs: [],
      avoid: [],
    },
    immutableConstraints: [],
  })
}

function visibleReply(text: string) {
  return JSON.stringify({ messages: [{ text }] })
}

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
