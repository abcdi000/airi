import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const channel = vi.hoisted(() => ({
  listeners: new Map<string, (event: { data: unknown, metadata?: { event?: { parentId?: string } } }) => void>(),
  reconnect: undefined as (() => void) | undefined,
  sent: [] as unknown[],
}))
const voicePayloads = vi.hoisted(() => new Map<string, ArrayBuffer>())

vi.mock('@vueuse/core', () => ({
  useLocalStorage: <T>(_key: string, initialValue: T) => ref(structuredClone(initialValue)),
}))

vi.mock('nanoid', () => {
  let sequence = 0
  return { nanoid: () => `generated-${++sequence}` }
})

vi.mock('localforage', () => ({
  default: {
    createInstance: () => ({
      getItem: async (key: string) => voicePayloads.get(key) ?? null,
      removeItem: async (key: string) => { voicePayloads.delete(key) },
      setItem: async (key: string, value: ArrayBuffer) => {
        voicePayloads.set(key, value)
        return value
      },
    }),
  },
}))

vi.mock('./mods/api/channel-server', () => ({
  useModsServerChannelStore: () => ({
    onEvent: (type: string, callback: (event: { data: unknown, metadata?: { event?: { parentId?: string } } }) => void) => {
      channel.listeners.set(type, callback)
      return () => channel.listeners.delete(type)
    },
    onReconnected: (callback: () => void) => {
      channel.reconnect = callback
      return () => {
        channel.reconnect = undefined
      }
    },
    send: (event: unknown) => channel.sent.push(event),
  }),
}))

const { useLumiRoomClientStore } = await import('./lumi-room-client')

const actor = {
  provider: 'lumi-lan',
  providerInstanceId: 'home-host',
  externalUserId: 'moussy-device',
}

describe('lumi room client reliability', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    channel.listeners.clear()
    channel.reconnect = undefined
    channel.sent.length = 0
    voicePayloads.clear()
  })

  it('sends stable delivery identifiers and stops resending after host acceptance', () => {
    const store = useLumiRoomClientStore()
    store.initialize()
    const pending = store.sendText({ conversationId: 'group-1', actor, text: 'hello' })

    expect(channel.sent.at(-1)).toMatchObject({
      type: 'input:text',
      metadata: { event: { id: pending.messageId } },
      data: {
        text: 'hello',
        actor,
        room: {
          messageId: pending.messageId,
          idempotencyKey: pending.idempotencyKey,
        },
        overrides: { sessionId: 'group-1' },
      },
    })

    channel.listeners.get('lumi:room:ack')?.({
      data: {
        conversationId: 'group-1',
        messageId: pending.messageId,
        idempotencyKey: pending.idempotencyKey,
        status: 'accepted',
        inputSequence: 1,
        latestSequence: 1,
        acknowledgedAt: 1,
      },
    })
    channel.sent.length = 0
    channel.reconnect?.()

    expect(store.pending[0]?.status).toBe('accepted')
    expect(channel.sent).toHaveLength(1)
    expect(channel.sent[0]).toMatchObject({ type: 'lumi:room:sync:request' })
  })

  it('resends an unacknowledged input with the same identifiers after reconnect', () => {
    const store = useLumiRoomClientStore()
    store.initialize()
    const pending = store.sendText({ conversationId: 'group-1', actor, text: 'hello' })
    channel.sent.length = 0

    channel.reconnect?.()

    expect(channel.sent).toHaveLength(2)
    expect(channel.sent[1]).toMatchObject({
      type: 'input:text',
      data: {
        room: {
          messageId: pending.messageId,
          idempotencyKey: pending.idempotencyKey,
        },
      },
    })
  })

  it('merges replayed events by host sequence and advances the cursor', () => {
    const store = useLumiRoomClientStore()
    store.initialize()
    store.joinRoom('group-1', actor)

    channel.listeners.get('lumi:room:sync')?.({
      data: {
        conversationId: 'group-1',
        afterSequence: 0,
        latestSequence: 2,
        retainedFromSequence: 1,
        truncated: false,
        events: [
          { conversationId: 'group-1', sequence: 2, messageId: 'a2', role: 'assistant', actorId: 'lumi', content: 'hi', createdAt: 2 },
          { conversationId: 'group-1', sequence: 1, messageId: 'u1', role: 'user', actorId: 'moussy', content: 'hello', createdAt: 1 },
        ],
      },
    })

    expect(store.rooms[0]?.cursor).toBe(2)
    expect(store.rooms[0]?.events.map(event => event.sequence)).toEqual([1, 2])
  })

  it('keeps failed sends for an explicit retry with new identifiers', async () => {
    const store = useLumiRoomClientStore()
    store.initialize()
    const pending = store.sendText({ conversationId: 'group-1', actor, text: 'hello' })

    channel.listeners.get('lumi:room:ack')?.({
      data: {
        conversationId: 'group-1',
        messageId: pending.messageId,
        idempotencyKey: pending.idempotencyKey,
        status: 'failed',
        inputSequence: 1,
        latestSequence: 1,
        reason: 'model unavailable',
        acknowledgedAt: 1,
      },
    })
    const retried = await store.retry(pending.messageId)

    expect(retried?.messageId).not.toBe(pending.messageId)
    expect(retried?.idempotencyKey).not.toBe(pending.idempotencyKey)
    expect(store.pending).toHaveLength(1)
    expect(store.pending[0]?.status).toBe('queued')
  })

  it('persists and resends a voice payload with stable delivery identifiers', async () => {
    const store = useLumiRoomClientStore()
    store.initialize()
    const pending = await store.sendVoice({
      conversationId: 'group-1',
      actor,
      recording: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }),
      durationMs: 1_000,
    })

    expect(channel.sent.at(-1)).toMatchObject({
      type: 'input:voice',
      data: {
        audio: expect.any(ArrayBuffer),
        byteLength: 3,
        durationMs: 1_000,
        room: {
          messageId: pending.messageId,
          idempotencyKey: pending.idempotencyKey,
        },
      },
    })

    channel.sent.length = 0
    channel.reconnect?.()
    await vi.waitFor(() => expect(channel.sent).toHaveLength(2))
    expect(channel.sent[1]).toMatchObject({ type: 'input:voice' })
  })

  it('cancels a host-owned transcription and removes its cached payload after acknowledgement', async () => {
    const store = useLumiRoomClientStore()
    store.initialize()
    const pending = await store.sendVoice({
      conversationId: 'group-1',
      actor,
      recording: new Blob([new Uint8Array([1])], { type: 'audio/wav' }),
      durationMs: 500,
    })

    channel.listeners.get('lumi:room:ack')?.({
      data: {
        conversationId: 'group-1',
        messageId: pending.messageId,
        idempotencyKey: pending.idempotencyKey,
        status: 'transcribing',
        latestSequence: 0,
        acknowledgedAt: 1,
      },
    })
    store.cancelVoice(pending.messageId)
    expect(channel.sent.at(-1)).toMatchObject({ type: 'lumi:room:voice:cancel' })

    channel.listeners.get('lumi:room:ack')?.({
      data: {
        conversationId: 'group-1',
        messageId: pending.messageId,
        idempotencyKey: pending.idempotencyKey,
        status: 'cancelled',
        latestSequence: 0,
        acknowledgedAt: 2,
      },
    })
    await vi.waitFor(() => expect(voicePayloads.size).toBe(0))
    expect(store.pending).toHaveLength(0)
  })

  it('maps a pre-routing server rejection back to the reliable room input', () => {
    const store = useLumiRoomClientStore()
    store.initialize()
    const pending = store.sendText({ conversationId: 'group-1', actor, text: 'too fast' })

    channel.listeners.get('error')?.({
      data: {
        message: 'This Lumi device is sending messages too quickly.',
        code: 'lumi-device-rate-limited',
        retryAfterMs: 2_500,
      },
      metadata: { event: { parentId: pending.messageId } },
    })

    expect(store.pending[0]).toMatchObject({
      messageId: pending.messageId,
      status: 'rejected',
      failureReason: 'This Lumi device is sending messages too quickly.',
      retryAfterMs: 2_500,
    })
  })

  it('purges cached room history and pending sends when host access is revoked', () => {
    const store = useLumiRoomClientStore()
    store.initialize()
    store.sendText({ conversationId: 'group-1', actor, text: 'hello' })

    channel.listeners.get('lumi:room:access-revoked')?.({
      data: {
        conversationId: 'group-1',
        reason: 'The actor is no longer a room participant.',
        revokedAt: 1,
      },
    })

    expect(store.rooms).toHaveLength(0)
    expect(store.pending).toHaveLength(0)
  })
})
