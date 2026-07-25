import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createFallbackLumiReplyIntent } from '../../../lumi-runtime/src'
import { useLumiSocialLanguageStore } from './lumi-social-language'

describe('lumi social-language store', () => {
  beforeEach(() => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size
      },
    })
    setActivePinia(createPinia())
  })

  it('serializes the reactive snapshot before crossing the Electron persistence bridge', async () => {
    const persisted: unknown[] = []
    const store = useLumiSocialLanguageStore()
    store.setPersistenceBridge({
      loadSnapshot: async () => undefined,
      replaceSnapshot: async (snapshot) => {
        expect(() => structuredClone(snapshot)).not.toThrow()
        persisted.push(snapshot)
      },
    })

    await store.recordDecision({
      id: 'decision-proxy-regression',
      timestamp: 1,
      personId: 'doggy',
      conversationId: 'astrbot-private',
      platform: 'qq',
      plannerIntent: createFallbackLumiReplyIntent({ rawDraft: '知道了' }),
      retrievedExpressions: [],
      selectedExpressions: [],
      selectedExpressionReasons: {},
      selectedBehaviors: [],
      generatedReply: { messages: [{ text: '知道了' }] },
      actuallySentReply: { messages: [{ text: '知道了' }] },
      emotionState: {},
      defenseState: {},
      validator: {
        passed: true,
        attempts: 1,
        issues: [],
        fallbackUsed: false,
      },
    })

    expect(persisted).toHaveLength(1)
  })

  it('persists the v2 repair of expressions forgotten by the v1 threshold bug', async () => {
    const persisted: unknown[] = []
    const store = useLumiSocialLanguageStore()
    store.setPersistenceBridge({
      loadSnapshot: async () => ({
        version: 1,
        expressions: [{
          id: 'legacy-expression',
          phrase: '这也能炸',
          situation: 'surprise',
          pragmaticFunction: 'react briefly',
          patternType: 'reaction',
          origin: {
            personId: 'doggy',
            conversationId: 'direct',
            platform: 'desktop',
            messageIds: ['message-1'],
            source: 'human',
          },
          affinity: {
            global: 0.02,
            byPerson: { doggy: 0.12 },
            byConversation: { direct: 0.12 },
            byPlatform: { desktop: 0.12 },
          },
          familiarity: 0.064,
          ownership: 0.02,
          confidence: 0.8,
          observationCount: 1,
          useCount: 0,
          successfulUseCount: 0,
          awkwardUseCount: 0,
          explicitRejectionCount: 0,
          firstSeenAt: 100,
          lastSeenAt: 100,
          status: 'forgotten',
        }],
        jargon: [],
        behaviors: [],
        decisions: [],
        updatedAt: 100,
      }),
      replaceSnapshot: async (snapshot) => {
        persisted.push(snapshot)
      },
    })

    await store.initialize()

    expect(store.snapshot.version).toBe(4)
    expect(store.snapshot.expressions[0]?.status).toBe('observed')
    expect(persisted).toHaveLength(1)
  })

  it('keeps recent group observations and records the exact batch learning changes', async () => {
    const store = useLumiSocialLanguageStore()
    const observation = {
      eventId: 'default:group-message-1',
      messageId: 'group-message-1',
      sourceId: 'default:group-1',
      platform: 'aiocqhttp',
      platformInstanceId: 'default',
      groupId: 'group-1',
      senderId: 'member-1',
      senderName: '群友',
      text: '这也太炸了',
      timestamp: 100,
    }

    const batch = await store.enqueueObservation(observation, 1)
    expect(store.snapshot.observationHistory).toEqual([observation])
    expect(store.activeObservationBatch?.messageCount).toBe(1)

    await store.completeObservationBatch({
      observations: batch,
      modelOutput: JSON.stringify({
        expressions: [],
        jargon: [{
          term: '炸了',
          meaning: '表示事情很离谱或突然失败',
          context: '群聊吐槽',
          pragmaticFunctions: ['吐槽'],
          confidence: 0.9,
        }],
        behaviors: [],
      }),
      processedAt: 200,
    })

    expect(store.activeObservationBatch).toBeNull()
    expect(store.snapshot.observationBuffer).toEqual([])
    expect(store.snapshot.observationBatches).toHaveLength(1)
    expect(store.snapshot.observationBatches[0]?.expressionIds).toHaveLength(0)
    expect(store.snapshot.observationBatches[0]?.jargonIds).toHaveLength(1)
  })

  it('does not let concurrent arrivals claim the same observation batch', async () => {
    const store = useLumiSocialLanguageStore()
    const first = await store.enqueueObservation(groupObservation('1', 1), 1)
    const second = await store.enqueueObservation(groupObservation('2', 2), 1)

    expect(first.map(item => item.messageId)).toEqual(['1'])
    expect(second).toEqual([])
    expect(store.activeObservationBatch?.messageCount).toBe(1)
    expect(store.snapshot.observationBuffer.map(item => item.messageId)).toEqual(['1', '2'])
  })

  it('allows complete batches from different sources to be claimed concurrently', async () => {
    const store = useLumiSocialLanguageStore()
    await store.enqueueObservation(groupObservation('1', 1), 1, { claimBatch: false })
    await store.enqueueObservation({
      ...groupObservation('2', 2),
      sourceId: 'default:group-2',
      groupId: 'group-2',
    }, 1, { claimBatch: false })

    const first = store.takeNextObservationBatch(1)
    const second = store.takeNextObservationBatch(1)

    expect(first.map(item => item.messageId)).toEqual(['1'])
    expect(second.map(item => item.messageId)).toEqual(['2'])
    expect(store.activeObservationBatches).toHaveLength(2)
  })

  it('keeps invalid and zero-change model batches recoverable from raw history', async () => {
    const store = useLumiSocialLanguageStore()
    const observation = groupObservation('recover-me', 1)
    const batch = await store.enqueueObservation(observation, 1)

    const result = await store.completeObservationBatch({
      observations: batch,
      modelOutput: '模型没有返回 JSON',
      processedAt: 2,
    })

    expect(result.successful).toBe(false)
    expect(store.snapshot.observationBatches[0]?.curator).toBe('pending')
    expect(store.snapshot.observationBatches[0]?.warning).toContain('JSON')
    expect(store.recoverableObservationGroups()[0]?.observations).toEqual([observation])
  })

  it('persists manual expression, jargon, and behavior management', async () => {
    const persisted: unknown[] = []
    const store = useLumiSocialLanguageStore()
    store.setPersistenceBridge({
      loadSnapshot: async () => undefined,
      replaceSnapshot: async (snapshot) => {
        persisted.push(snapshot)
      },
    })
    await store.observeEvidence({
      messageId: 'message-assets',
      text: 'learned source',
      personId: 'doggy',
      conversationId: 'direct',
      platform: 'desktop',
      timestamp: 100,
      source: 'human',
      sourceKind: 'chat',
      authorVerified: true,
    }, JSON.stringify({
      expressions: [{
        phrase: 'manual phrase',
        situation: 'chat',
        pragmaticFunction: 'react',
        patternType: 'phrase',
        confidence: 0.8,
      }],
      jargon: [{
        term: 'term',
        meaning: 'meaning',
        context: 'chat',
        pragmaticFunctions: ['react'],
        confidence: 0.8,
      }],
      behaviors: [{
        situation: 'chat',
        action: 'reply briefly',
        expectedEffect: 'natural conversation',
        confidence: 0.8,
      }],
    }))

    const expressionId = store.snapshot.expressions[0]!.id
    const jargonId = store.snapshot.jargon[0]!.id
    const behaviorId = store.snapshot.behaviors[0]!.id

    await store.updateExpression(expressionId, { phrase: 'edited phrase', status: 'habit' })
    await store.updateJargon(jargonId, { term: 'edited term' })
    await store.updateBehavior(behaviorId, { action: 'edited action' })

    expect(store.snapshot.expressions[0]?.phrase).toBe('edited phrase')
    expect(store.snapshot.expressions[0]?.status).toBe('habit')
    expect(store.snapshot.jargon[0]?.term).toBe('edited term')
    expect(store.snapshot.behaviors[0]?.action).toBe('edited action')

    await store.deleteExpression(expressionId)
    await store.deleteJargon(jargonId)
    await store.deleteBehavior(behaviorId)

    expect(store.snapshot.expressions).toEqual([])
    expect(store.snapshot.jargon).toEqual([])
    expect(store.snapshot.behaviors).toEqual([])
    expect(persisted.length).toBeGreaterThan(0)
  })

  it('refreshes prompt logging changed by a separate Electron window', () => {
    const store = useLumiSocialLanguageStore()
    localStorage.setItem('settings/lumi/language-learning/config-v1', JSON.stringify({
      ...store.config,
      promptLoggingEnabled: true,
    }))

    const refreshed = store.refreshConfigFromStorage()

    expect(refreshed.promptLoggingEnabled).toBe(true)
    expect(store.config.promptLoggingEnabled).toBe(true)
  })
})

function groupObservation(messageId: string, timestamp: number) {
  return {
    eventId: `default:${messageId}`,
    messageId,
    sourceId: 'default:group-1',
    platform: 'aiocqhttp',
    platformInstanceId: 'default',
    groupId: 'group-1',
    senderId: 'member-1',
    senderName: '群友',
    text: `消息 ${messageId}`,
    timestamp,
  }
}
