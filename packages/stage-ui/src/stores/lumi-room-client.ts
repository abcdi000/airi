import type { InputActorIdentity, LumiRoomAckEvent, LumiRoomEvent, LumiRoomSyncEvent, WebSocketBaseEvent, WebSocketEvents } from '@proj-airi/server-sdk'

import localforage from 'localforage'

import { LUMI_ROOM_VOICE_MAX_BYTES, LUMI_ROOM_VOICE_MAX_DURATION_MS, LUMI_ROOM_VOICE_MIME_TYPES } from '@proj-airi/stage-shared/server-channel-qr'
import { useLocalStorage } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import { useModsServerChannelStore } from './mods/api/channel-server'

interface LumiRoomClientRoom {
  conversationId: string
  actor: InputActorIdentity
  cursor: number
  retainedFromSequence: number
  truncated: boolean
  events: LumiRoomEvent[]
}

interface LumiRoomPendingInputBase {
  conversationId: string
  messageId: string
  idempotencyKey: string
  actor: InputActorIdentity
  createdAt: number
  status: 'queued' | 'transcribing' | 'accepted' | 'failed' | 'rejected'
  failureReason?: string
  retryAfterMs?: number
}

export type LumiRoomPendingInput
  = | LumiRoomPendingInputBase & {
    /** Omitted by text records persisted before room voice support. */
    kind?: 'text'
    text: string
  }
  | LumiRoomPendingInputBase & {
    kind: 'voice'
    mimeType: string
    byteLength: number
    durationMs: number
  }

interface LumiRoomClientSnapshot {
  version: 1
  rooms: LumiRoomClientRoom[]
  pending: LumiRoomPendingInput[]
  acknowledgements: LumiRoomAckEvent[]
}

const MAX_CLIENT_ROOM_EVENTS = 5_000
const MAX_CLIENT_ACKNOWLEDGEMENTS = 2_000
const voicePayloads = localforage.createInstance({ name: 'lumi-room-voice-payloads' })
const voicePayloadKey = (messageId: string) => `voice:${messageId}`

/**
 * Maintains reliable client delivery and replay state for host-authoritative Lumi rooms.
 *
 * Use when:
 * - A LAN or channel client sends text into a Lumi group conversation
 * - A client reconnects and must recover events without repeating accepted model work
 *
 * Expects:
 * - The host has an exact external-identity mapping for the supplied actor claim
 * - The actor is authorized for the requested conversation
 *
 * Returns:
 * - Persistent pending sends, acknowledgements, and sequence-ordered room events
 */
export const useLumiRoomClientStore = defineStore('lumi-room-client', () => {
  const channel = useModsServerChannelStore()
  const snapshot = useLocalStorage<LumiRoomClientSnapshot>('lumi/room-client/v1', {
    version: 1,
    rooms: [],
    pending: [],
    acknowledgements: [],
  })
  let disposeAck: (() => void) | undefined
  let disposeAccessRevoked: (() => void) | undefined
  let disposeError: (() => void) | undefined
  let disposeSync: (() => void) | undefined
  let disposeReconnect: (() => void) | undefined

  const rooms = computed(() => snapshot.value.rooms)
  const pending = computed(() => snapshot.value.pending)
  const acknowledgements = computed(() => snapshot.value.acknowledgements)

  function initialize() {
    if (disposeAck)
      return

    disposeAck = channel.onEvent('lumi:room:ack', event => handleAcknowledgement(event.data))
    disposeAccessRevoked = channel.onEvent('lumi:room:access-revoked', event => leaveRoom(event.data.conversationId))
    disposeError = channel.onEvent('error', handleServerError)
    disposeSync = channel.onEvent('lumi:room:sync', event => handleSync(event.data))
    disposeReconnect = channel.onReconnected(recoverRooms)
    recoverRooms()
  }

  function dispose() {
    disposeAck?.()
    disposeAccessRevoked?.()
    disposeError?.()
    disposeSync?.()
    disposeReconnect?.()
    disposeAck = undefined
    disposeAccessRevoked = undefined
    disposeError = undefined
    disposeSync = undefined
    disposeReconnect = undefined
  }

  function joinRoom(conversationId: string, actor: InputActorIdentity) {
    const normalizedConversationId = requiredText(conversationId, 'conversationId', 240)
    const normalizedActor = normalizeActor(actor)
    const room = snapshot.value.rooms.find(item => item.conversationId === normalizedConversationId)
    if (room) {
      room.actor = normalizedActor
    }
    else {
      snapshot.value.rooms.push({
        conversationId: normalizedConversationId,
        actor: normalizedActor,
        cursor: 0,
        retainedFromSequence: 1,
        truncated: false,
        events: [],
      })
    }
    requestSync(normalizedConversationId)
  }

  function leaveRoom(conversationId: string) {
    const removedVoiceInputs = snapshot.value.pending.filter(input => input.conversationId === conversationId && input.kind === 'voice')
    snapshot.value.rooms = snapshot.value.rooms.filter(room => room.conversationId !== conversationId)
    snapshot.value.pending = snapshot.value.pending.filter(input => input.conversationId !== conversationId)
    void Promise.all(removedVoiceInputs.map(input => voicePayloads.removeItem(voicePayloadKey(input.messageId))))
  }

  function sendText(input: { conversationId: string, actor: InputActorIdentity, text: string }) {
    const conversationId = requiredText(input.conversationId, 'conversationId', 240)
    const actor = normalizeActor(input.actor)
    const text = requiredText(input.text, 'text', 100_000)
    joinRoom(conversationId, actor)

    const pendingInput: LumiRoomPendingInput = {
      conversationId,
      messageId: nanoid(),
      idempotencyKey: nanoid(),
      actor,
      text,
      createdAt: Date.now(),
      status: 'queued',
    }
    snapshot.value.pending.push(pendingInput)
    void dispatch(pendingInput)
    return pendingInput
  }

  async function sendVoice(input: { conversationId: string, actor: InputActorIdentity, recording: Blob, durationMs: number }) {
    const conversationId = requiredText(input.conversationId, 'conversationId', 240)
    const actor = normalizeActor(input.actor)
    const mimeType = requiredText(input.recording.type, 'recording.type', 160).toLowerCase()
    if (!LUMI_ROOM_VOICE_MIME_TYPES.includes(mimeType as typeof LUMI_ROOM_VOICE_MIME_TYPES[number]))
      throw new Error('The room voice recording must use WAV audio.')
    if (input.recording.size <= 0 || input.recording.size > LUMI_ROOM_VOICE_MAX_BYTES)
      throw new Error(`The room voice recording exceeds ${LUMI_ROOM_VOICE_MAX_BYTES} bytes.`)
    if (!Number.isFinite(input.durationMs) || input.durationMs <= 0 || input.durationMs > LUMI_ROOM_VOICE_MAX_DURATION_MS)
      throw new Error(`The room voice recording exceeds ${LUMI_ROOM_VOICE_MAX_DURATION_MS} milliseconds.`)
    joinRoom(conversationId, actor)

    const pendingInput: LumiRoomPendingInput = {
      kind: 'voice',
      conversationId,
      messageId: nanoid(),
      idempotencyKey: nanoid(),
      actor,
      mimeType,
      byteLength: input.recording.size,
      durationMs: Math.round(input.durationMs),
      createdAt: Date.now(),
      status: 'queued',
    }
    await voicePayloads.setItem(voicePayloadKey(pendingInput.messageId), await input.recording.arrayBuffer())
    snapshot.value.pending.push(pendingInput)
    await dispatch(pendingInput)
    return pendingInput
  }

  async function retry(messageId: string) {
    const previous = snapshot.value.pending.find(input => input.messageId === messageId)
    if (!previous || (previous.status !== 'failed' && previous.status !== 'rejected'))
      return undefined

    const retried: LumiRoomPendingInput = {
      ...previous,
      messageId: nanoid(),
      idempotencyKey: nanoid(),
      createdAt: Date.now(),
      status: 'queued',
      failureReason: undefined,
      retryAfterMs: undefined,
    }
    if (previous.kind === 'voice') {
      const payload = await voicePayloads.getItem<ArrayBuffer>(voicePayloadKey(previous.messageId))
      if (!payload)
        return undefined
      await voicePayloads.setItem(voicePayloadKey(retried.messageId), payload)
      await voicePayloads.removeItem(voicePayloadKey(previous.messageId))
    }
    snapshot.value.pending = snapshot.value.pending.filter(input => input !== previous)
    snapshot.value.pending.push(retried)
    await dispatch(retried)
    return retried
  }

  function cancelVoice(messageId: string) {
    const input = snapshot.value.pending.find(candidate => candidate.messageId === messageId)
    if (!input || input.kind !== 'voice' || (input.status !== 'queued' && input.status !== 'transcribing'))
      return
    channel.send({
      type: 'lumi:room:voice:cancel',
      data: {
        conversationId: input.conversationId,
        messageId: input.messageId,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor,
      },
    })
  }

  function requestSync(conversationId: string) {
    const room = snapshot.value.rooms.find(item => item.conversationId === conversationId)
    if (!room)
      return
    channel.send({
      type: 'lumi:room:sync:request',
      data: {
        conversationId: room.conversationId,
        afterSequence: room.cursor,
        actor: room.actor,
      },
    })
  }

  function recoverRooms() {
    for (const room of snapshot.value.rooms)
      requestSync(room.conversationId)
    for (const input of snapshot.value.pending) {
      if (input.status === 'queued' || input.status === 'transcribing')
        void dispatch(input)
    }
  }

  async function dispatch(input: LumiRoomPendingInput) {
    if (input.kind === 'voice') {
      const audio = await voicePayloads.getItem<ArrayBuffer>(voicePayloadKey(input.messageId))
      if (!audio) {
        input.status = 'failed'
        input.failureReason = 'The cached voice recording is no longer available.'
        return
      }
      channel.send({
        type: 'input:voice',
        metadata: { event: { id: input.messageId } },
        data: {
          audio,
          mimeType: input.mimeType,
          byteLength: input.byteLength,
          durationMs: input.durationMs,
          actor: input.actor,
          room: {
            messageId: input.messageId,
            idempotencyKey: input.idempotencyKey,
          },
          overrides: { sessionId: input.conversationId },
        },
      })
      return
    }

    channel.send({
      type: 'input:text',
      metadata: {
        event: { id: input.messageId },
      },
      data: {
        text: input.text,
        actor: input.actor,
        room: {
          messageId: input.messageId,
          idempotencyKey: input.idempotencyKey,
        },
        overrides: {
          sessionId: input.conversationId,
        },
      },
    })
  }

  function handleServerError(event: WebSocketBaseEvent<'error', WebSocketEvents['error']>) {
    const parentId = event.metadata?.event?.parentId
    if (!parentId)
      return

    const input = snapshot.value.pending.find(candidate => candidate.messageId === parentId)
    if (!input)
      return

    input.status = 'rejected'
    input.failureReason = event.data.message
    input.retryAfterMs = event.data.retryAfterMs
  }

  function handleAcknowledgement(acknowledgement: LumiRoomAckEvent) {
    snapshot.value.acknowledgements.push(acknowledgement)
    snapshot.value.acknowledgements = snapshot.value.acknowledgements.slice(-MAX_CLIENT_ACKNOWLEDGEMENTS)

    const input = snapshot.value.pending.find(candidate =>
      candidate.conversationId === acknowledgement.conversationId
      && candidate.messageId === acknowledgement.messageId
      && candidate.idempotencyKey === acknowledgement.idempotencyKey,
    )
    if (!input)
      return

    if (acknowledgement.status === 'completed' || (acknowledgement.status === 'duplicate' && acknowledgement.outputSequence)) {
      snapshot.value.pending = snapshot.value.pending.filter(candidate => candidate !== input)
      if (input.kind === 'voice')
        void voicePayloads.removeItem(voicePayloadKey(input.messageId))
      requestSync(acknowledgement.conversationId)
      return
    }
    if (acknowledgement.status === 'cancelled') {
      snapshot.value.pending = snapshot.value.pending.filter(candidate => candidate !== input)
      if (input.kind === 'voice')
        void voicePayloads.removeItem(voicePayloadKey(input.messageId))
      return
    }
    if (acknowledgement.status === 'duplicate' && acknowledgement.reason) {
      input.status = 'failed'
      input.failureReason = acknowledgement.reason
      input.retryAfterMs = undefined
      return
    }
    if (acknowledgement.status === 'failed' || acknowledgement.status === 'rejected') {
      input.status = acknowledgement.status
      input.failureReason = acknowledgement.reason
      input.retryAfterMs = undefined
      return
    }

    input.status = acknowledgement.status === 'transcribing' ? 'transcribing' : 'accepted'
    requestSync(acknowledgement.conversationId)
  }

  function handleSync(sync: LumiRoomSyncEvent) {
    const room = snapshot.value.rooms.find(item => item.conversationId === sync.conversationId)
    if (!room)
      return

    const eventsBySequence = new Map(room.events.map(event => [event.sequence, event]))
    for (const event of sync.events) {
      if (event.conversationId === room.conversationId)
        eventsBySequence.set(event.sequence, event)
    }
    room.events = [...eventsBySequence.values()]
      .sort((left, right) => left.sequence - right.sequence)
      .slice(-MAX_CLIENT_ROOM_EVENTS)
    room.cursor = Math.max(room.cursor, sync.latestSequence)
    room.retainedFromSequence = sync.retainedFromSequence
    room.truncated = sync.truncated
  }

  return {
    rooms,
    pending,
    acknowledgements,
    initialize,
    dispose,
    joinRoom,
    leaveRoom,
    sendText,
    sendVoice,
    cancelVoice,
    retry,
    requestSync,
  }
})

function normalizeActor(actor: InputActorIdentity): InputActorIdentity {
  return {
    provider: requiredText(actor.provider, 'actor.provider', 160),
    providerInstanceId: requiredText(actor.providerInstanceId, 'actor.providerInstanceId', 160),
    externalUserId: requiredText(actor.externalUserId, 'actor.externalUserId', 160),
  }
}

function requiredText(value: string, field: string, maxLength: number) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized)
    throw new Error(`${field} is required.`)
  if (normalized.length > maxLength)
    throw new Error(`${field} exceeds ${maxLength} characters.`)
  return normalized
}
