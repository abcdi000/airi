import type { LumiAccessRevokedPushed, LumiConversationMessagesPushed, LumiGenerationPushed, LumiOnlineConversation, LumiOnlineDevice, LumiOnlineMessage, LumiPresencePushed } from '@proj-airi/lumi-online'

import { useLocalStorage } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

export type LumiClientRuntimeMode = 'offline-client' | 'online-client'

export interface LumiOnlineClientState {
  status: 'offline' | 'connecting' | 'online' | 'reconnecting' | 'error'
  runtimeMode?: LumiClientRuntimeMode
  serverUrl?: string
  person?: { id: string, displayName: string, role: 'owner' | 'member' }
  capabilities?: { protocolVersion: number, serverVersion: string, voiceInput: boolean, localTtsRequired: true, maxTextLength: number, maxVoiceBytes: number }
  error?: string
}

export interface LumiOnlineProjection {
  personId: string
  conversations: LumiOnlineConversation[]
  messages: Record<string, LumiOnlineMessage[]>
}

export interface LumiOnlineBridge {
  getState: () => Promise<LumiOnlineClientState>
  login: (input: { serverUrl: string, username: string, password: string, deviceId: string, deviceName: string }) => Promise<LumiOnlineClientState>
  claimInvitation: (input: { serverUrl: string, invitationCode: string, username: string, password: string, deviceId: string, deviceName: string }) => Promise<LumiOnlineClientState>
  connectStored: (input: { deviceId: string, deviceName: string }) => Promise<LumiOnlineClientState>
  logout: () => Promise<LumiOnlineClientState>
  listConversations: () => Promise<{ conversations: LumiOnlineConversation[] }>
  replayConversation: (input: { conversationId: string, afterSequence: number }) => Promise<{ conversationId: string, latestSequence: number, messages: LumiOnlineMessage[] }>
  sendMessage: (input: PendingOnlineSend) => Promise<{ status: 'accepted' | 'duplicate', input: LumiOnlineMessage }>
  listDevices: () => Promise<{ devices: LumiOnlineDevice[] }>
  revokeDevice: (input: { deviceId: string }) => Promise<{ device: LumiOnlineDevice }>
  transcribeVoice: (input: { audio: Uint8Array, mimeType: string }) => Promise<{ text: string }>
  onState: (handler: (state: LumiOnlineClientState) => void) => () => void
  onMessages: (handler: (payload: LumiConversationMessagesPushed) => void) => () => void
  onGeneration: (handler: (payload: LumiGenerationPushed) => void) => () => void
  onPresence: (handler: (payload: LumiPresencePushed) => void) => () => void
  onAccessRevoked: (handler: (payload: LumiAccessRevokedPushed) => void) => () => void
  projectSnapshot: (snapshot: LumiOnlineProjection) => void | Promise<void>
  clearProjection: () => void | Promise<void>
}

export interface PendingOnlineSend {
  accountPersonId: string
  conversationId: string
  messageId: string
  idempotencyKey: string
  content: string
  createdAt: number
}

/** Holds only the current authenticated account's online projection. */
export const useLumiOnlineStore = defineStore('lumi-online', () => {
  const runtimeMode = useLocalStorage<LumiClientRuntimeMode>('settings/lumi/runtime-mode', 'offline-client')
  const configuredServerUrl = useLocalStorage('settings/lumi/online/server-url', 'http://127.0.0.1:6130')
  const deviceId = useLocalStorage('settings/lumi/online/device-id', `windows-${nanoid()}`)
  const state = ref<LumiOnlineClientState>({ status: 'offline' })
  const conversations = ref<LumiOnlineConversation[]>([])
  const messages = ref<Record<string, LumiOnlineMessage[]>>({})
  const generation = ref<Record<string, LumiGenerationPushed>>({})
  const completedGeneration = ref<{ deliveryId: number, payload: LumiGenerationPushed }>()
  const failedGeneration = ref<{ deliveryId: number, payload: LumiGenerationPushed }>()
  const pending = useLocalStorage<PendingOnlineSend[]>('lumi/online/outbox/v1', [])
  const devices = ref<LumiOnlineDevice[]>([])
  const presence = ref<Record<string, 'online' | 'offline'>>({})
  const bridge = shallowRef<LumiOnlineBridge>()
  const disposers: Array<() => void> = []
  let initialized = false
  let refreshing: Promise<void> | undefined

  const isOnline = computed(() => runtimeMode.value === 'online-client' && state.value.status === 'online')

  function setBridge(next: LumiOnlineBridge) {
    disposeSubscriptions()
    bridge.value = next
    disposers.push(next.onState(handleState))
    disposers.push(next.onMessages(handleMessages))
    disposers.push(next.onGeneration(handleGeneration))
    disposers.push(next.onPresence(payload => presence.value = { ...presence.value, [payload.personId]: payload.state }))
    disposers.push(next.onAccessRevoked(handleAccessRevoked))
  }

  async function initialize(deviceName = 'Lumi Windows') {
    if (initialized)
      return
    initialized = true
    if (!bridge.value)
      return
    state.value = await bridge.value.getState()
    if (state.value.runtimeMode)
      runtimeMode.value = state.value.runtimeMode
    if (state.value.serverUrl)
      configuredServerUrl.value = state.value.serverUrl
    if (runtimeMode.value !== 'online-client')
      return
    try {
      handleState(await bridge.value.connectStored({ deviceId: deviceId.value, deviceName }))
    }
    catch {
      // The state event carries the connection failure for settings UI.
    }
  }

  async function login(input: { serverUrl: string, username: string, password: string, deviceName?: string }) {
    const transport = requiredBridge()
    await clearAccountProjection()
    const next = await transport.login({ ...input, deviceId: deviceId.value, deviceName: input.deviceName ?? 'Lumi Windows' })
    configuredServerUrl.value = input.serverUrl
    runtimeMode.value = 'online-client'
    handleState(next)
    await refresh()
    await refreshDevices()
  }

  async function claimInvitation(input: { serverUrl: string, invitationCode: string, username: string, password: string, deviceName?: string }) {
    const transport = requiredBridge()
    await clearAccountProjection()
    const next = await transport.claimInvitation({ ...input, deviceId: deviceId.value, deviceName: input.deviceName ?? 'Lumi Windows' })
    configuredServerUrl.value = input.serverUrl
    runtimeMode.value = 'online-client'
    handleState(next)
    await refresh()
    await refreshDevices()
  }

  async function logout() {
    await requiredBridge().logout()
    runtimeMode.value = 'offline-client'
    state.value = { status: 'offline' }
    await clearAccountProjection()
  }

  async function reconnect(deviceName = 'Lumi Windows') {
    const transport = requiredBridge()
    runtimeMode.value = 'online-client'
    handleState(await transport.connectStored({ deviceId: deviceId.value, deviceName }))
    await refresh()
    // Reconnect does not resolve until the durable outbox has been retried.
    // `handleState` may already have started a single-flight refresh; this
    // explicit pass gives callers a stable completion contract even when
    // state-event and command-driven refreshes overlap.
    await flushPending()
    await refreshDevices()
  }

  async function refreshDevices() {
    if (!isOnline.value) {
      devices.value = []
      return
    }
    devices.value = (await requiredBridge().listDevices()).devices
  }

  async function revokeDevice(targetDeviceId: string) {
    await requiredBridge().revokeDevice({ deviceId: targetDeviceId })
    if (targetDeviceId === deviceId.value) {
      await logout()
      return
    }
    await refreshDevices()
  }

  async function useOfflineMode() {
    if (state.value.status !== 'offline')
      await requiredBridge().logout()
    runtimeMode.value = 'offline-client'
    state.value = { status: 'offline' }
    await clearAccountProjection()
  }

  async function refresh() {
    if (refreshing)
      return await refreshing
    refreshing = (async () => {
      const transport = requiredBridge()
      if (state.value.status !== 'online' || !state.value.person)
        return
      pending.value = pending.value.filter(item => item.accountPersonId === state.value.person!.id)
      const listed = await transport.listConversations()
      conversations.value = listed.conversations
      const authorized = new Set(listed.conversations.map(conversation => conversation.id))
      messages.value = Object.fromEntries(Object.entries(messages.value).filter(([id]) => authorized.has(id)))
      for (const conversation of listed.conversations)
        await replayUntilCurrent(conversation)
      await project()
      await flushPending()
    })().finally(() => {
      refreshing = undefined
    })
    return await refreshing
  }

  async function replayUntilCurrent(conversation: LumiOnlineConversation) {
    let cursor = messages.value[conversation.id]?.at(-1)?.sequence ?? 0
    while (cursor < conversation.latestSequence) {
      const replay = await requiredBridge().replayConversation({ conversationId: conversation.id, afterSequence: cursor })
      mergeMessages(conversation.id, replay.messages)
      const next = messages.value[conversation.id]?.at(-1)?.sequence ?? cursor
      if (next <= cursor)
        break
      cursor = next
    }
  }

  async function sendText(conversationId: string, content: string) {
    if (!isOnline.value)
      throw new Error('Lumi Online is not connected')
    if (!conversations.value.some(conversation => conversation.id === conversationId))
      throw new Error('The current account cannot access this conversation')
    const send: PendingOnlineSend = {
      accountPersonId: state.value.person!.id,
      conversationId,
      messageId: nanoid(),
      idempotencyKey: `${deviceId.value}:${nanoid()}`,
      content: requiredText(content, 'message', state.value.capabilities?.maxTextLength ?? 100_000),
      createdAt: Date.now(),
    }
    pending.value.push(send)
    await dispatch(send)
    return send
  }

  async function sendVoice(conversationId: string, recording: Blob) {
    if (!isOnline.value || !state.value.capabilities?.voiceInput)
      throw new Error('Lumi Online voice input is unavailable')
    if (!recording.size || recording.size > state.value.capabilities.maxVoiceBytes)
      throw new Error(`Voice recording exceeds ${state.value.capabilities.maxVoiceBytes} bytes`)
    const audio = new Uint8Array(await recording.arrayBuffer())
    const result = await requiredBridge().transcribeVoice({ audio, mimeType: recording.type || 'audio/webm' })
    return await sendText(conversationId, result.text)
  }

  async function dispatch(send: PendingOnlineSend) {
    // Persisted Vue state wraps queued entries in reactive proxies. Eventa,
    // Electron IPC, and structured cloning require a plain transport value.
    const transportSend: PendingOnlineSend = { ...send }
    const response = await requiredBridge().sendMessage(transportSend)
    mergeMessages(send.conversationId, [response.input])
    pending.value = pending.value.filter(item => item !== send)
    await project()
  }

  async function flushPending() {
    for (const send of [...pending.value]) {
      try {
        await dispatch(send)
      }
      catch {
        return
      }
    }
  }

  function handleState(next: LumiOnlineClientState) {
    state.value = next
    if (runtimeMode.value === 'online-client' && next.status === 'online')
      void refresh()
  }

  function handleMessages(payload: LumiConversationMessagesPushed) {
    if (!conversations.value.some(conversation => conversation.id === payload.conversationId))
      return
    mergeMessages(payload.conversationId, payload.messages)
    void project()
  }

  function handleGeneration(payload: LumiGenerationPushed) {
    generation.value = { ...generation.value, [payload.conversationId]: payload }
    if (payload.message)
      mergeMessages(payload.conversationId, [payload.message])
    if (payload.state === 'completed' && payload.message?.role === 'assistant') {
      completedGeneration.value = {
        deliveryId: (completedGeneration.value?.deliveryId ?? 0) + 1,
        payload,
      }
    }
    if (payload.state === 'failed') {
      failedGeneration.value = {
        deliveryId: (failedGeneration.value?.deliveryId ?? 0) + 1,
        payload,
      }
    }
    void project()
  }

  function handleAccessRevoked(payload: LumiAccessRevokedPushed) {
    if (!payload.conversationId) {
      state.value = { ...state.value, status: 'error', error: payload.reason }
      void clearAccountProjection()
      return
    }
    conversations.value = conversations.value.filter(conversation => conversation.id !== payload.conversationId)
    const nextMessages = { ...messages.value }
    delete nextMessages[payload.conversationId]
    messages.value = nextMessages
    void project()
  }

  function mergeMessages(conversationId: string, incoming: LumiOnlineMessage[]) {
    const bySequence = new Map((messages.value[conversationId] ?? []).map(message => [message.sequence, message]))
    for (const message of incoming) {
      if (message.conversationId === conversationId)
        bySequence.set(message.sequence, message)
    }
    messages.value = { ...messages.value, [conversationId]: [...bySequence.values()].sort((left, right) => left.sequence - right.sequence) }
  }

  async function project() {
    if (state.value.person)
      await bridge.value?.projectSnapshot({ personId: state.value.person.id, conversations: conversations.value, messages: messages.value })
  }

  async function clearAccountProjection() {
    conversations.value = []
    messages.value = {}
    generation.value = {}
    completedGeneration.value = undefined
    failedGeneration.value = undefined
    pending.value = []
    devices.value = []
    presence.value = {}
    await bridge.value?.clearProjection()
  }

  function disposeSubscriptions() {
    while (disposers.length)
      disposers.pop()?.()
  }

  function requiredBridge() {
    if (!bridge.value)
      throw new Error('Lumi Online desktop bridge is unavailable')
    return bridge.value
  }

  return { runtimeMode, configuredServerUrl, deviceId, state, conversations, messages, generation, completedGeneration, failedGeneration, pending, devices, presence, isOnline, setBridge, initialize, login, claimInvitation, reconnect, logout, useOfflineMode, refresh, refreshDevices, revokeDevice, sendText, sendVoice }
})

function requiredText(value: string, field: string, maxLength: number) {
  const normalized = value.trim()
  if (!normalized)
    throw new Error(`${field} is required`)
  if (normalized.length > maxLength)
    throw new Error(`${field} is too long`)
  return normalized
}
