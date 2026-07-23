import type { createContext as createElectronContext } from '@moeru/eventa/adapters/electron/main'
import type { LumiOnlineDevice } from '@proj-airi/lumi-online'
import type { BrowserWindow } from 'electron'

import type { ElectronLumiOnlineState } from '../../../../shared/eventa'
import type { McpStdioManager } from '../mcp-servers'

import process from 'node:process'

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { defineInvoke, defineInvokeHandler } from '@moeru/eventa'
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
import { app, safeStorage } from 'electron'

import {
  electronLumiOnlineAccessRevoked,
  electronLumiOnlineClaimInvitation,
  electronLumiOnlineConnectStored,
  electronLumiOnlineGenerationPushed,
  electronLumiOnlineGetState,
  electronLumiOnlineListConversations,
  electronLumiOnlineListDevices,
  electronLumiOnlineLogin,
  electronLumiOnlineLogout,
  electronLumiOnlineMessagesPushed,
  electronLumiOnlinePresencePushed,
  electronLumiOnlineReplayConversation,
  electronLumiOnlineRevokeDevice,
  electronLumiOnlineSendMessage,
  electronLumiOnlineStateChanged,
  electronLumiOnlineTranscribeVoice,
} from '../../../../shared/eventa'
import { readLumiClientRuntimeMode, writeLumiClientRuntimeMode } from './runtime-role'

interface StoredCredential {
  serverUrl: string
  token: string
}

type ElectronContext = ReturnType<typeof createElectronContext>['context']
type WebSocketContext = ReturnType<typeof createWebSocketContext>['context']

let sharedClient: ReturnType<typeof createSharedLumiOnlineClient> | undefined

/** Registers one renderer against the process-wide Lumi Online transport. */
export function createLumiOnlineClientService(params: { context: ElectronContext, window: BrowserWindow, mcpStdioManager?: McpStdioManager }) {
  sharedClient ??= createSharedLumiOnlineClient(params.mcpStdioManager)
  sharedClient.register(params.context, params.window)
  return { logout: sharedClient.logout }
}

/** Owns the single encrypted credential and WebSocket allowed in one Electron process. */
function createSharedLumiOnlineClient(mcpStdioManager?: McpStdioManager) {
  let state: ElectronLumiOnlineState = { status: 'offline' }
  let socket: WebSocket | undefined
  let webSocketContext: WebSocketContext | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let reconnectAttempts = 0
  let explicitLogout = false
  let device = { id: '', name: '' }
  const pushDisposers: Array<() => void> = []
  const renderers = new Map<BrowserWindow, ElectronContext>()

  const setState = (next: ElectronLumiOnlineState) => {
    state = next
    emitToRenderers(electronLumiOnlineStateChanged, state)
  }

  async function login(input: { serverUrl: string, username: string, password: string, deviceId: string, deviceName: string }) {
    const serverUrl = normalizeServerUrl(input.serverUrl)
    const response = await fetch(`${serverUrl}/api/auth/sign-in/username`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: input.username, password: input.password }),
    })
    if (!response.ok)
      throw new Error(await responseError(response, 'Lumi login failed'))
    const body = await response.json() as { token?: unknown }
    const credential = {
      serverUrl,
      token: requiredText(response.headers.get('set-auth-token') ?? body.token, 'session token', 4_096),
    }
    device = normalizeDevice(input.deviceId, input.deviceName)
    explicitLogout = false
    const next = await connect(credential)
    await saveCredential(credential)
    await writeLumiClientRuntimeMode('online-client')
    await mcpStdioManager?.stopAll()
    return next
  }

  async function claimInvitation(input: { serverUrl: string, invitationCode: string, username: string, password: string, deviceId: string, deviceName: string }) {
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
    device = normalizeDevice(input.deviceId, input.deviceName)
    const credential = await loadCredential()
    if (!credential)
      return state
    explicitLogout = false
    return await connect(credential)
  }

  async function connect(credential: StoredCredential) {
    clearReconnect()
    disconnectSocket()
    setState({ status: reconnectAttempts > 0 ? 'reconnecting' : 'connecting', serverUrl: credential.serverUrl })
    try {
      const url = new URL(credential.serverUrl)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`
      url.searchParams.set('access_token', credential.token)
      const opened = await openWebSocket(url.toString())
      socket = opened
      const created = createWebSocketContext(opened)
      webSocketContext = created.context
      attachPushEvents(created.context)
      const hello = await defineInvoke(created.context, lumiOnlineHello)({
        protocolVersion: LUMI_ONLINE_PROTOCOL_VERSION,
        clientVersion: app.getVersion(),
        deviceId: device.id,
        deviceName: device.name,
        platform: process.platform,
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

  function attachPushEvents(context: WebSocketContext) {
    disposePushEvents()
    pushDisposers.push(context.on(lumiOnlineMessagesPushed, event => emitToRenderers(electronLumiOnlineMessagesPushed, event.body)))
    pushDisposers.push(context.on(lumiOnlineGenerationPushed, event => emitToRenderers(electronLumiOnlineGenerationPushed, event.body)))
    pushDisposers.push(context.on(lumiOnlinePresencePushed, event => emitToRenderers(electronLumiOnlinePresencePushed, event.body)))
    pushDisposers.push(context.on(lumiOnlineAccessRevoked, (event) => {
      emitToRenderers(electronLumiOnlineAccessRevoked, event.body)
      setState({ status: 'error', serverUrl: state.serverUrl, error: event.body?.reason ?? 'Lumi Online access was revoked' })
      disconnectSocket()
    }))
  }

  function handleDisconnect(disconnected: WebSocket, event: CloseEvent, credential: StoredCredential) {
    if (socket !== disconnected)
      return
    disconnectSocket()
    if (explicitLogout)
      return
    if (event.code === 4401) {
      setState({ status: 'error', serverUrl: credential.serverUrl, error: 'Lumi Online session expired. Please sign in again.' })
      return
    }
    reconnectAttempts += 1
    setState({ status: 'reconnecting', serverUrl: credential.serverUrl, person: state.person, capabilities: state.capabilities })
    scheduleReconnect(credential)
  }

  function scheduleReconnect(credential: StoredCredential) {
    if (explicitLogout || reconnectTimer)
      return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void connect(credential).catch(() => {
        reconnectAttempts += 1
        scheduleReconnect(credential)
      })
    }, reconnectDelay(reconnectAttempts))
  }

  async function logout() {
    explicitLogout = true
    clearReconnect()
    disconnectSocket()
    const credential = await loadCredential()
    if (credential) {
      await fetch(`${credential.serverUrl}/api/auth/sign-out`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential.token}` },
      }).catch(() => undefined)
    }
    await clearCredential()
    await writeLumiClientRuntimeMode('offline-client')
    setState({ status: 'offline' })
    return state
  }

  function requireOnlineContext() {
    if (!webSocketContext || state.status !== 'online')
      throw new Error('Lumi Online is not connected')
    return webSocketContext
  }

  function register(context: ElectronContext, window: BrowserWindow) {
    if (renderers.has(window))
      return
    renderers.set(window, context)
    window.once('closed', () => renderers.delete(window))
    defineInvokeHandler(context, electronLumiOnlineGetState, async () => {
      const credential = await loadCredential()
      return {
        ...state,
        runtimeMode: await readLumiClientRuntimeMode(),
        serverUrl: state.serverUrl ?? credential?.serverUrl,
      }
    })
    defineInvokeHandler(context, electronLumiOnlineLogin, async input => await login(input))
    defineInvokeHandler(context, electronLumiOnlineClaimInvitation, async input => await claimInvitation(input))
    defineInvokeHandler(context, electronLumiOnlineConnectStored, async input => await connectStored(input))
    defineInvokeHandler(context, electronLumiOnlineLogout, async () => await logout())
    defineInvokeHandler(context, electronLumiOnlineListConversations, async () => await defineInvoke(requireOnlineContext(), lumiOnlineListConversations)(undefined))
    defineInvokeHandler(context, electronLumiOnlineReplayConversation, async input => await defineInvoke(requireOnlineContext(), lumiOnlineReplayConversation)(input))
    defineInvokeHandler(context, electronLumiOnlineSendMessage, async input => await defineInvoke(requireOnlineContext(), lumiOnlineSendMessage)(input))
    defineInvokeHandler(context, electronLumiOnlineListDevices, async () => await authenticatedHttp<{ devices: LumiOnlineDevice[] }>('/api/lumi/devices'))
    defineInvokeHandler(context, electronLumiOnlineRevokeDevice, async input => await authenticatedHttp<{ device: LumiOnlineDevice }>('/api/lumi/devices/revoke', input))
    defineInvokeHandler(context, electronLumiOnlineTranscribeVoice, async input => await authenticatedBinaryHttp<{ text: string }>('/api/lumi/transcribe', input.audio, input.mimeType))
  }

  function emitToRenderers<T>(event: Parameters<ElectronContext['emit']>[0], body: T) {
    for (const [window, context] of renderers) {
      if (!window.isDestroyed())
        context.emit(event, body)
    }
  }

  function disconnectSocket() {
    disposePushEvents()
    webSocketContext = undefined
    const current = socket
    socket = undefined
    if (current && current.readyState < WebSocket.CLOSING)
      current.close(1000, 'Client disconnect')
  }

  function disposePushEvents() {
    while (pushDisposers.length)
      pushDisposers.pop()?.()
  }

  function clearReconnect() {
    if (reconnectTimer)
      clearTimeout(reconnectTimer)
    reconnectTimer = undefined
  }

  async function authenticatedHttp<TResult>(path: string, body?: unknown): Promise<TResult> {
    const credential = await loadCredential()
    if (!credential)
      throw new Error('Lumi Online is not signed in')
    const response = await fetch(`${credential.serverUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${credential.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok)
      throw new Error(await responseError(response, 'Lumi account request failed'))
    return await response.json() as TResult
  }

  async function authenticatedBinaryHttp<TResult>(path: string, body: Uint8Array, mimeType: string): Promise<TResult> {
    const credential = await loadCredential()
    if (!credential)
      throw new Error('Lumi Online is not signed in')
    const response = await fetch(`${credential.serverUrl}${path}`, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${credential.token}`,
        'content-type': requiredText(mimeType, 'voice mime type', 160),
        'content-length': String(body.byteLength),
      },
      body: Uint8Array.from(body).buffer,
    })
    if (!response.ok)
      throw new Error(await responseError(response, 'Lumi voice transcription failed'))
    return await response.json() as TResult
  }

  return { register, logout }
}

async function openWebSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('Lumi Online WebSocket connection timed out'))
    }, 15_000)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(socket)
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('Lumi Online WebSocket connection failed'))
    }, { once: true })
    socket.addEventListener('close', (event) => {
      clearTimeout(timer)
      reject(new Error(`Lumi Online WebSocket closed during handshake (${event.code})`))
    }, { once: true })
  })
}

function credentialPath() {
  return join(app.getPath('userData'), 'lumi-online-session.bin')
}

async function saveCredential(credential: StoredCredential) {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('Windows secure credential storage is unavailable')
  const path = credentialPath()
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  await writeFile(temporary, safeStorage.encryptString(JSON.stringify(credential)), { flag: 'w', mode: 0o600 })
  await rename(temporary, path)
}

async function loadCredential(): Promise<StoredCredential | undefined> {
  const path = credentialPath()
  if (!existsSync(path))
    return undefined
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('Windows secure credential storage is unavailable')
  const parsed = JSON.parse(safeStorage.decryptString(await readFile(path))) as Record<string, unknown>
  return {
    serverUrl: normalizeServerUrl(parsed.serverUrl),
    token: requiredText(parsed.token, 'stored session token', 4_096),
  }
}

async function clearCredential() {
  await rm(credentialPath(), { force: true })
}

function normalizeServerUrl(value: unknown) {
  const url = new URL(requiredText(value, 'server URL', 2_000))
  url.pathname = url.pathname.replace(/\/$/, '')
  url.search = ''
  url.hash = ''
  const local = url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost'
  if (url.protocol !== 'https:' && (!local || url.protocol !== 'http:'))
    throw new Error('Remote Lumi Server connections require HTTPS/WSS')
  return url.toString().replace(/\/$/, '')
}

function normalizeDevice(id: string, name: string) {
  return { id: requiredText(id, 'deviceId', 160), name: requiredText(name, 'deviceName', 200) }
}

async function responseError(response: Response, fallback: string) {
  try {
    const body = await response.json() as { message?: unknown, error?: unknown }
    return typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : fallback
  }
  catch {
    return fallback
  }
}

function requiredText(value: unknown, field: string, maxLength: number) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized)
    throw new Error(`${field} is required`)
  if (normalized.length > maxLength)
    throw new Error(`${field} is too long`)
  return normalized
}

function reconnectDelay(attempt: number) {
  return Math.min(30_000, 1_000 * 2 ** Math.min(5, Math.max(0, attempt - 1)))
}
