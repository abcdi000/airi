import type { LumiOnlineBridge, LumiOnlineClientState, PendingOnlineSend } from './lumi-online'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

vi.mock('@vueuse/core', () => ({
  useLocalStorage: <T>(_key: string, initialValue: T) => ref(structuredClone(initialValue)),
}))

vi.mock('nanoid', () => {
  let sequence = 0
  return { nanoid: () => `generated-${++sequence}` }
})

const { useLumiOnlineStore } = await import('./lumi-online')

describe('lumi Online client account isolation and reliability', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('keeps one delivery identity across a failed send and reconnect retry', async () => {
    const store = useLumiOnlineStore()
    const sent: PendingOnlineSend[] = []
    let failFirst = true
    const bridge = createBridge({
      personId: 'lumi-person-doggy',
      sendMessage: async (input) => {
        sent.push(structuredClone(input))
        if (failFirst) {
          failFirst = false
          throw new Error('connection dropped')
        }
        return { status: 'accepted', input: message(input) }
      },
    })
    store.setBridge(bridge)

    await store.login({ serverUrl: 'http://127.0.0.1:6130', username: 'doggy', password: 'secret' })
    await expect(store.sendText('doggy-direct', 'hello')).rejects.toThrow('connection dropped')
    expect(store.pending).toHaveLength(1)

    await store.reconnect()
    expect(store.state.person?.id).toBe('lumi-person-doggy')

    expect(sent).toHaveLength(2)
    expect(sent[1]?.messageId).toBe(sent[0]?.messageId)
    expect(sent[1]?.idempotencyKey).toBe(sent[0]?.idempotencyKey)
    expect(store.pending).toHaveLength(0)
  })

  it('clears every account-scoped projection before another account is admitted', async () => {
    const store = useLumiOnlineStore()
    const cleared = vi.fn(async () => {})
    store.setBridge(createBridge({ personId: 'lumi-person-doggy', clearProjection: cleared }))
    await store.login({ serverUrl: 'http://127.0.0.1:6130', username: 'doggy', password: 'secret' })
    store.pending.push({
      accountPersonId: 'lumi-person-doggy',
      conversationId: 'doggy-direct',
      messageId: 'doggy-pending',
      idempotencyKey: 'doggy-device:pending',
      content: 'private draft',
      createdAt: 1,
    })

    store.setBridge(createBridge({ personId: 'lumi-person-moussy', clearProjection: cleared }))
    await store.login({ serverUrl: 'http://127.0.0.1:6130', username: 'moussy', password: 'secret' })

    expect(store.state.person?.id).toBe('lumi-person-moussy')
    expect(store.conversations.map(item => item.id)).toEqual(['moussy-direct'])
    expect(store.messages).toEqual({})
    expect(store.pending).toEqual([])
    expect(cleared).toHaveBeenCalled()
  })

  it('emits local speech hints only for live completed generations', async () => {
    const store = useLumiOnlineStore()
    const generationHandlers: Array<(payload: Parameters<LumiOnlineBridge['onGeneration']>[0] extends (value: infer T) => void ? T : never) => void> = []
    store.setBridge(createBridge({
      personId: 'lumi-person-doggy',
      onGeneration: (handler) => {
        generationHandlers.push(handler)
        return () => {}
      },
    }))
    await store.login({ serverUrl: 'http://127.0.0.1:6130', username: 'doggy', password: 'secret' })
    expect(store.completedGeneration).toBeUndefined()

    generationHandlers[0]?.({
      conversationId: 'doggy-direct',
      inputMessageId: 'input-1',
      state: 'completed',
      message: {
        id: 'assistant-1',
        conversationId: 'doggy-direct',
        sequence: 1,
        role: 'assistant',
        actorPersonId: 'lumi',
        content: 'Welcome back.',
        createdAt: 2,
        expression: 'happy',
        motion: 'Happy',
      },
    })

    expect(store.completedGeneration?.deliveryId).toBe(1)
    expect(store.completedGeneration?.payload.message?.content).toBe('Welcome back.')
  })

  it('publishes a failed generation so the chat can stop waiting and show the cause', async () => {
    const store = useLumiOnlineStore()
    const generationHandlers: Array<(payload: Parameters<LumiOnlineBridge['onGeneration']>[0] extends (value: infer T) => void ? T : never) => void> = []
    store.setBridge(createBridge({
      personId: 'lumi-person-doggy',
      onGeneration: (handler) => {
        generationHandlers.push(handler)
        return () => {}
      },
    }))
    await store.login({ serverUrl: 'http://127.0.0.1:6130', username: 'doggy', password: 'secret' })

    generationHandlers[0]?.({
      conversationId: 'doggy-direct',
      inputMessageId: 'input-1',
      state: 'failed',
      error: 'provider rejected tools',
    })

    expect(store.failedGeneration?.deliveryId).toBe(1)
    expect(store.failedGeneration?.payload.error).toBe('provider rejected tools')
  })

  it('restores the main-process runtime role after legacy renderer settings are migrated', async () => {
    const store = useLumiOnlineStore()
    const connectStored = vi.fn(async () => ({
      status: 'online' as const,
      serverUrl: 'https://lumi.example.test',
      person: { id: 'lumi-person-doggy', displayName: 'Doggy', role: 'owner' as const },
    }))
    store.setBridge(createBridge({
      personId: 'lumi-person-doggy',
      getState: async () => ({
        status: 'offline',
        runtimeMode: 'online-client',
        serverUrl: 'https://lumi.example.test',
      }),
      connectStored,
    }))

    await store.initialize()

    expect(store.runtimeMode).toBe('online-client')
    expect(store.configuredServerUrl).toBe('https://lumi.example.test')
    expect(connectStored).toHaveBeenCalledOnce()
  })
})

function createBridge(overrides: {
  personId: string
  sendMessage?: LumiOnlineBridge['sendMessage']
  clearProjection?: LumiOnlineBridge['clearProjection']
  connectStored?: LumiOnlineBridge['connectStored']
  getState?: LumiOnlineBridge['getState']
  onGeneration?: LumiOnlineBridge['onGeneration']
}): LumiOnlineBridge {
  const state: LumiOnlineClientState = {
    status: 'online',
    person: { id: overrides.personId, displayName: overrides.personId.endsWith('doggy') ? 'Doggy' : 'Moussy', role: overrides.personId.endsWith('doggy') ? 'owner' : 'member' },
    capabilities: { protocolVersion: 1, serverVersion: 'test', voiceInput: true, localTtsRequired: true, maxTextLength: 10_000, maxVoiceBytes: 1_000_000 },
  }
  const directId = overrides.personId.endsWith('doggy') ? 'doggy-direct' : 'moussy-direct'
  return {
    getState: overrides.getState ?? (async () => state),
    login: async () => state,
    claimInvitation: async () => state,
    connectStored: overrides.connectStored ?? (async () => state),
    logout: async () => ({ status: 'offline' }),
    listConversations: async () => ({ conversations: [{ id: directId, type: 'direct', title: directId, participantPersonIds: [overrides.personId], latestSequence: 0, updatedAt: 1 }] }),
    replayConversation: async input => ({ conversationId: input.conversationId, latestSequence: 0, messages: [] }),
    sendMessage: overrides.sendMessage ?? (async input => ({ status: 'accepted', input: message(input) })),
    listDevices: async () => ({ devices: [] }),
    revokeDevice: async input => ({ device: { id: input.deviceId, accountId: overrides.personId, name: input.deviceId, platform: 'test', createdAt: 1, lastSeenAt: 1, revokedAt: 1 } }),
    transcribeVoice: async () => ({ text: 'voice' }),
    onState: () => () => {},
    onMessages: () => () => {},
    onGeneration: overrides.onGeneration ?? (() => () => {}),
    onPresence: () => () => {},
    onAccessRevoked: () => () => {},
    projectSnapshot: async () => {},
    clearProjection: overrides.clearProjection ?? (async () => {}),
  }
}

function message(input: PendingOnlineSend) {
  return {
    id: input.messageId,
    conversationId: input.conversationId,
    sequence: 1,
    role: 'user' as const,
    actorPersonId: input.accountPersonId,
    content: input.content,
    createdAt: input.createdAt,
  }
}
