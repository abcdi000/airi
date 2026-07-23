import type { LumiOnlineDevice } from '@proj-airi/lumi-online'
import type { LumiOnlineBridge, LumiOnlineClientState, PendingOnlineSend } from '@proj-airi/stage-ui/stores/lumi-online'

import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { Capacitor } from '@capacitor/core'
import { defineInvoke } from '@moeru/eventa'
import { createContext as createWebSocketContext } from '@moeru/eventa/adapters/websocket/native'
import { errorMessageFrom } from '@moeru/std'
import {
  LUMI_ONLINE_PROTOCOL_VERSION,
  lumiOnlineAccessRevoked,
  lumiOnlineGenerationPushed,
  lumiOnlineHello,
  lumiOnlineListConversations,
  lumiOnlineMessagesPushed,
  lumiOnlinePresencePushed,
  lumiOnlineReplayConversation,
  lumiOnlineSendMessage,
} from '@proj-airi/lumi-online'
import { projectLumiOnlineGeneration, projectLumiOnlineSnapshot } from '@proj-airi/stage-ui/libs/lumi-online-chat-projection'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useChatStreamStore } from '@proj-airi/stage-ui/stores/chat/stream-store'

interface StoredCredential {
  serverUrl: string
  token: string
}

type SocketContext = ReturnType<typeof createWebSocketContext>['context']

/** Creates the Pocket transport while keeping credentials inside native secure storage. */
export function createLumiOnlinePocketBridge(): LumiOnlineBridge {
  const sessions = useChatSessionStore()
  const stream = useChatStreamStore()
  let state: LumiOnlineClientState = { status: 'offline' }
  let socket: WebSocket | undefined
  let context: SocketContext | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectAttempts = 0
  let explicitlyLoggedOut = false
  let device = { id: '', name: '' }
  const stateListeners = new Set<(value: LumiOnlineClientState) => void>()
  const messageListeners = new Set<Parameters<LumiOnlineBridge['onMessages']>[0]>()
  const generationListeners = new Set<Parameters<LumiOnlineBridge['onGeneration']>[0]>()
  const presenceListeners = new Set<Parameters<LumiOnlineBridge['onPresence']>[0]>()
  const accessListeners = new Set<Parameters<LumiOnlineBridge['onAccessRevoked']>[0]>()
  const pushDisposers: Array<() => void> = []

  const secureStorageReady = SecureStorage.setKeyPrefix('lumi-pocket_')

  async function login(input: { serverUrl: string, username: string, password: string, deviceId: string, deviceName: string }) {
    assertSecureCredentialPlatform()
    await secureStorageReady
    const serverUrl = normalizeServerUrl(input.serverUrl)
    const response = await fetch(`${serverUrl}/api/auth/sign-in/username`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: input.username, password: input.password }),
    })
    if (!response.ok)
      throw new Error(await responseError(response, 'Lumi login failed'))
    const body = await response.json() as { token?: unknown }
    const credential = { serverUrl, token: requiredText(response.headers.get('set-auth-token') ?? body.token, 'session token', 4_096) }
    device = normalizeDevice(input.deviceId, input.deviceName)
    explicitlyLoggedOut = false
    const next = await connect(credential)
    await SecureStorage.set('online-session', credential)
    return next
  }

  async function claimInvitation(input: { serverUrl: string, invitationCode: string, username: string, password: string, deviceId: string, deviceName: string }) {
    // Reject unsupported Web credential storage before consuming a one-time
    // invitation that could only be recovered by the server administrator.
    assertSecureCredentialPlatform()
    await secureStorageReady
    const serverUrl = normalizeServerUrl(input.serverUrl)
    const response = await fetch(`${serverUrl}/api/lumi/invitations/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: input.invitationCode, username: input.username, password: input.password }),
    })
    if (!response.ok)
      throw new Error(await responseError(response, 'Invitation claim failed'))
    return await login({ ...input, serverUrl })
  }

  async function connectStored(input: { deviceId: string, deviceName: string }) {
    assertSecureCredentialPlatform()
    await secureStorageReady
    device = normalizeDevice(input.deviceId, input.deviceName)
    const stored = await SecureStorage.get('online-session', false)
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || stored instanceof Date)
      return state
    const credential = {
      serverUrl: normalizeServerUrl(stored.serverUrl),
      token: requiredText(stored.token, 'stored session token', 4_096),
    }
    explicitlyLoggedOut = false
    return await connect(credential)
  }

  async function connect(credential: StoredCredential) {
    clearReconnect()
    disconnectSocket()
    setState({ status: reconnectAttempts ? 'reconnecting' : 'connecting', serverUrl: credential.serverUrl })
    try {
      const url = new URL(credential.serverUrl)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`
      url.searchParams.set('access_token', credential.token)
      const opened = await openWebSocket(url.toString())
      socket = opened
      const created = createWebSocketContext(opened)
      context = created.context
      attachPush(created.context)
      const hello = await defineInvoke(created.context, lumiOnlineHello)({
        protocolVersion: LUMI_ONLINE_PROTOCOL_VERSION,
        clientVersion: import.meta.env.VITE_AIRI_VERSION || '0.10.2',
        deviceId: device.id,
        deviceName: device.name,
        platform: Capacitor.getPlatform(),
      })
      reconnectAttempts = 0
      setState({ status: 'online', serverUrl: credential.serverUrl, person: hello.person, capabilities: hello.capabilities })
      opened.addEventListener('close', event => handleDisconnect(opened, event, credential), { once: true })
      return state
    }
    catch (error) {
      disconnectSocket()
      setState({ status: 'error', serverUrl: credential.serverUrl, error: errorMessageFrom(error) ?? 'Lumi Online connection failed' })
      throw error
    }
  }

  function attachPush(socketContext: SocketContext) {
    disposePush()
    pushDisposers.push(socketContext.on(lumiOnlineMessagesPushed, (event) => {
      if (event.body)
        notify(messageListeners, event.body)
    }))
    pushDisposers.push(socketContext.on(lumiOnlineGenerationPushed, (event) => {
      if (event.body) {
        projectLumiOnlineGeneration(event.body, sessions.activeSessionId, stream)
        notify(generationListeners, event.body)
      }
    }))
    pushDisposers.push(socketContext.on(lumiOnlinePresencePushed, (event) => {
      if (event.body)
        notify(presenceListeners, event.body)
    }))
    pushDisposers.push(socketContext.on(lumiOnlineAccessRevoked, (event) => {
      if (event.body)
        notify(accessListeners, event.body)
      setState({ status: 'error', serverUrl: state.serverUrl, error: event.body?.reason ?? 'Lumi Online access was revoked' })
      disconnectSocket()
    }))
  }

  function handleDisconnect(closed: WebSocket, event: CloseEvent, credential: StoredCredential) {
    if (socket !== closed)
      return
    disconnectSocket()
    if (explicitlyLoggedOut)
      return
    if (event.code === 4401) {
      setState({ status: 'error', serverUrl: credential.serverUrl, error: 'Lumi Online session expired. Please sign in again.' })
      return
    }
    reconnectAttempts += 1
    setState({ status: 'reconnecting', serverUrl: credential.serverUrl, person: state.person, capabilities: state.capabilities })
    reconnectTimer = setTimeout(() => void connect(credential).catch(() => {}), reconnectDelay(reconnectAttempts))
  }

  async function authenticatedHttp<TResult>(path: string, init?: RequestInit): Promise<TResult> {
    await secureStorageReady
    const stored = await SecureStorage.get('online-session', false)
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || stored instanceof Date)
      throw new Error('Lumi Online is not signed in')
    const serverUrl = normalizeServerUrl(stored.serverUrl)
    const token = requiredText(stored.token, 'stored session token', 4_096)
    const response = await fetch(`${serverUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init?.headers },
    })
    if (!response.ok)
      throw new Error(await responseError(response, 'Lumi account request failed'))
    return await response.json() as TResult
  }

  async function logout() {
    await secureStorageReady
    explicitlyLoggedOut = true
    clearReconnect()
    disconnectSocket()
    const stored = await SecureStorage.get('online-session', false)
    if (stored && typeof stored === 'object' && !Array.isArray(stored) && !(stored instanceof Date)) {
      const serverUrl = normalizeServerUrl(stored.serverUrl)
      const token = requiredText(stored.token, 'stored session token', 4_096)
      await fetch(`${serverUrl}/api/auth/sign-out`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => undefined)
    }
    await SecureStorage.remove('online-session')
    setState({ status: 'offline' })
    return state
  }

  function requiredContext() {
    if (!context || state.status !== 'online')
      throw new Error('Lumi Online is not connected')
    return context
  }

  return {
    getState: async () => state,
    login,
    claimInvitation,
    connectStored,
    logout,
    listConversations: async () => await defineInvoke(requiredContext(), lumiOnlineListConversations)(undefined),
    replayConversation: async input => await defineInvoke(requiredContext(), lumiOnlineReplayConversation)(input),
    sendMessage: async (input: PendingOnlineSend) => await defineInvoke(requiredContext(), lumiOnlineSendMessage)(input),
    listDevices: async () => await authenticatedHttp<{ devices: LumiOnlineDevice[] }>('/api/lumi/devices'),
    revokeDevice: async input => await authenticatedHttp<{ device: LumiOnlineDevice }>('/api/lumi/devices/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
    transcribeVoice: async input => await authenticatedHttp<{ text: string }>('/api/lumi/transcribe', {
      method: 'POST',
      headers: { 'content-type': input.mimeType, 'content-length': String(input.audio.byteLength) },
      body: Uint8Array.from(input.audio).buffer,
    }),
    onState: listener => subscribe(stateListeners, listener),
    onMessages: listener => subscribe(messageListeners, listener),
    onGeneration: listener => subscribe(generationListeners, listener),
    onPresence: listener => subscribe(presenceListeners, listener),
    onAccessRevoked: listener => subscribe(accessListeners, listener),
    projectSnapshot: snapshot => projectLumiOnlineSnapshot(snapshot, sessions),
    clearProjection: () => sessions.clearOnlineProjection(),
  }

  function setState(next: LumiOnlineClientState) {
    state = next
    notify(stateListeners, next)
  }

  function disconnectSocket() {
    disposePush()
    context = undefined
    const current = socket
    socket = undefined
    if (current && current.readyState < WebSocket.CLOSING)
      current.close(1000, 'Client disconnect')
  }

  function disposePush() {
    while (pushDisposers.length)
      pushDisposers.pop()?.()
  }

  function clearReconnect() {
    if (reconnectTimer)
      clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }
}

function assertSecureCredentialPlatform() {
  if (Capacitor.getPlatform() === 'web' && !import.meta.env.DEV)
    throw new Error('Lumi Pocket online accounts require native Android or iOS secure storage')
}

function subscribe<T>(listeners: Set<(value: T) => void>, listener: (value: T) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify<T>(listeners: Set<(value: T) => void>, value: T) {
  for (const listener of listeners)
    listener(value)
}

async function openWebSocket(url: string) {
  const socket = new WebSocket(url)
  return await new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Lumi Online connection timed out')), 15_000)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(socket)
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('Lumi Online WebSocket connection failed'))
    }, { once: true })
  })
}

function normalizeServerUrl(value: unknown) {
  const url = new URL(requiredText(value, 'server URL', 2_000))
  url.pathname = url.pathname.replace(/\/$/, '')
  url.search = ''
  url.hash = ''
  const local = ['127.0.0.1', '::1', 'localhost'].includes(url.hostname)
  if (url.protocol !== 'https:' && (!local || url.protocol !== 'http:'))
    throw new Error('Remote Lumi Server connections require HTTPS/WSS')
  return url.toString().replace(/\/$/, '')
}

function normalizeDevice(id: string, name: string) {
  return { id: requiredText(id, 'device id', 160), name: requiredText(name, 'device name', 200) }
}

function requiredText(value: unknown, field: string, maximum: number) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || text.length > maximum)
    throw new Error(`${field} is invalid`)
  return text
}

async function responseError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { error?: unknown, message?: unknown }
    return typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : fallback
  }
  catch {
    return fallback
  }
}

function reconnectDelay(attempt: number) {
  return Math.min(30_000, 1_000 * 2 ** Math.min(5, Math.max(0, attempt - 1)))
}
