import type { Lifecycle } from 'injeca'

import type {
  ElectronLumiAstrBotGatewayConfig,
  ElectronLumiAstrBotGatewayState,
} from '../../../../shared/eventa'

import { Buffer } from 'node:buffer'
import { randomBytes, timingSafeEqual } from 'node:crypto'

import { useLogg } from '@guiiai/logg'
import { defineInvokeHandler } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/electron/main'
import { errorMessageFrom } from '@moeru/std'
import { Client } from '@proj-airi/server-sdk'
import { ipcMain } from 'electron'
import { H3 } from 'h3'
import { array, boolean, number, object, safeParse, string } from 'valibot'

import {
  electronLumiAstrBotGatewayGetState,
  electronLumiAstrBotGatewayRotateToken,
  electronLumiAstrBotGatewayUpdateConfig,
} from '../../../../shared/eventa'
import { createConfig } from '../../../libs/electron/persistence'
import { getChannelServerConfig } from '../channel-server'
import { createH3Server } from '../http-server/server'
import { linkLumiExternalIdentity } from '../lumi-identity'
import { readLumiClientRuntimeMode } from '../lumi-online/runtime-role'

const DOGGY_PERSON_ID = 'lumi-user-00000000-0000-4000-8000-000000000001'
const MOUSSY_PERSON_ID = 'lumi-user-00000000-0000-4000-8000-000000000002'
const MAX_REQUEST_BYTES = 50 * 1024 * 1024
const RESPONSE_TIMEOUT_MS = 120_000
const RUNTIME_STATUS_TIMEOUT_MS = 5_000
const SPEECH_TIMEOUT_MS = 120_000

const gatewayConfigSchema = object({
  enabled: boolean(),
  port: number(),
  apiToken: string(),
  identityBindings: array(object({
    platformInstanceId: string(),
    externalUserId: string(),
    personId: string(),
  })),
})

function createDefaultConfig(): ElectronLumiAstrBotGatewayConfig {
  return {
    enabled: false,
    port: 6132,
    apiToken: randomBytes(32).toString('base64url'),
    identityBindings: [
      ...['1770249418', '1931972861', '2986464928'].map(externalUserId => ({
        platformInstanceId: 'default',
        externalUserId,
        personId: DOGGY_PERSON_ID,
      })),
      ...['1428755063', '3884583060', '3274405364'].map(externalUserId => ({
        platformInstanceId: 'default',
        externalUserId,
        personId: MOUSSY_PERSON_ID,
      })),
    ],
  }
}

const gatewayConfigStore = createConfig('lumi-astrbot-gateway', 'config.json', gatewayConfigSchema, {
  default: createDefaultConfig(),
  autoHeal: true,
})

interface GatewayResponse {
  response_id: string
  text: string
  segments: Array<{ type: 'text', text: string }>
  metadata: {
    actor_person_id: string
    conversation_id: string
    runtime_role: 'offline-client'
  }
}

interface PendingResponse {
  reject: (error: Error) => void
  resolve: (response: GatewayResponse) => void
  timer: ReturnType<typeof setTimeout>
}

interface RuntimeStatus {
  available: boolean
  consciousness: boolean
  vision: boolean
  hearing: boolean
  detail?: string
}

interface PendingRuntimeStatus {
  reject: (error: Error) => void
  resolve: (status: RuntimeStatus) => void
  timer: ReturnType<typeof setTimeout>
}

interface GatewaySpeechResponse {
  data_base64: string
  mime_type: string
}

interface PendingSpeech {
  reject: (error: Error) => void
  resolve: (speech: GatewaySpeechResponse) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Hosts the loopback AstrBot API and forwards ordered perception into the
 * existing offline desktop runtime over Lumi's authenticated Server Channel.
 *
 * Call stack:
 *
 * AstrBot HTTP request
 *   -> {@link createLocalGateway}
 *     -> {@link Client.sendOrThrow}
 *       -> Stage renderer context bridge
 *         -> Lumi local vision / hearing / consciousness
 */
export function setupLumiAstrBotGateway(params: { lifecycle: Lifecycle }) {
  const log = useLogg('main/lumi-astrbot-gateway').useGlobalConfig()
  const setup = gatewayConfigStore.setup()
  if (setup.status === 'missing' && setup.value)
    gatewayConfigStore.update(setup.value)

  let httpServer: ReturnType<typeof createH3Server> | undefined
  let channelClient: Client | undefined
  let running = false
  let lastError = ''
  const pending = new Map<string, PendingResponse>()
  const pendingRuntimeStatuses = new Map<string, PendingRuntimeStatus>()
  const pendingSpeech = new Map<string, PendingSpeech>()
  const completed = new Map<string, GatewayResponse>()
  const { context } = createContext(ipcMain)

  async function getState(): Promise<ElectronLumiAstrBotGatewayState> {
    const config = currentConfig()
    return {
      config,
      running,
      endpoint: `http://127.0.0.1:${config.port}`,
      runtimeMode: await readLumiClientRuntimeMode(),
      ...(lastError ? { lastError } : {}),
    }
  }

  async function start() {
    const config = currentConfig()
    if (!config.enabled || running)
      return
    try {
      await syncIdentityBindings(config)
      await ensureChannelClient()
      httpServer = createLocalGateway(config)
      await httpServer.start()
      running = true
      lastError = ''
      log.withFields({ port: config.port }).log('Lumi local AstrBot gateway started')
    }
    catch (error) {
      lastError = errorMessageFrom(error) ?? 'Failed to start the local AstrBot gateway'
      await stop()
      log.withError(error).error('Failed to start Lumi local AstrBot gateway')
      throw error
    }
  }

  async function stop() {
    running = false
    await httpServer?.stop()
    httpServer = undefined
    channelClient?.close()
    channelClient = undefined
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Lumi local AstrBot gateway stopped'))
    }
    pending.clear()
    for (const waiter of pendingRuntimeStatuses.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Lumi local AstrBot gateway stopped'))
    }
    pendingRuntimeStatuses.clear()
    for (const waiter of pendingSpeech.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Lumi local AstrBot gateway stopped'))
    }
    pendingSpeech.clear()
  }

  async function applyConfig(input: ElectronLumiAstrBotGatewayConfig) {
    const config = normalizeConfig(input)
    await stop()
    gatewayConfigStore.update(config)
    await syncIdentityBindings(config)
    if (config.enabled)
      await start()
    return await getState()
  }

  async function rotateToken() {
    const next = {
      ...currentConfig(),
      apiToken: randomBytes(32).toString('base64url'),
    }
    return await applyConfig(next)
  }

  async function ensureChannelClient() {
    if (channelClient?.isReady)
      return channelClient
    channelClient?.close()
    const channel = await getChannelServerConfig()
    channelClient = new Client({
      name: 'lumi-local-astrbot-gateway',
      url: 'ws://127.0.0.1:6121/ws',
      token: channel.authToken || undefined,
      autoConnect: false,
      possibleEvents: [
        'output:gen-ai:chat:complete',
        'lumi:external:perception:failed',
        'lumi:external:runtime:status',
        'lumi:external:speech:result',
      ],
    })
    channelClient.onEvent('output:gen-ai:chat:complete', (event) => {
      const input = event.data['gen-ai:chat']?.input
      const perception = input?.type === 'input:text' ? input.data.perception : undefined
      if (!perception || !input || input.type !== 'input:text')
        return
      const waiter = pending.get(perception.eventId)
      if (!waiter)
        return
      const actor = input.data.actor
      const response: GatewayResponse = {
        response_id: `${perception.eventId}:assistant`,
        text: assistantText(event.data.message),
        segments: [{ type: 'text', text: assistantText(event.data.message) }],
        metadata: {
          actor_person_id: personForActor(actor?.providerInstanceId, actor?.externalUserId),
          conversation_id: input.data.overrides?.sessionId || '',
          runtime_role: 'offline-client',
        },
      }
      clearTimeout(waiter.timer)
      pending.delete(perception.eventId)
      rememberCompleted(perception.eventId, response)
      waiter.resolve(response)
    })
    channelClient.onEvent('lumi:external:perception:failed', (event) => {
      const waiter = pending.get(event.data.eventId)
      if (!waiter)
        return
      clearTimeout(waiter.timer)
      pending.delete(event.data.eventId)
      waiter.reject(new GatewayRequestError(event.data.code, event.data.message))
    })
    channelClient.onEvent('lumi:external:runtime:status', (event) => {
      const waiter = pendingRuntimeStatuses.get(event.data.requestId)
      if (!waiter)
        return
      clearTimeout(waiter.timer)
      pendingRuntimeStatuses.delete(event.data.requestId)
      waiter.resolve(event.data)
    })
    channelClient.onEvent('lumi:external:speech:result', (event) => {
      const waiter = pendingSpeech.get(event.data.requestId)
      if (!waiter)
        return
      clearTimeout(waiter.timer)
      pendingSpeech.delete(event.data.requestId)
      if (!event.data.ok || !event.data.dataBase64 || !event.data.mimeType) {
        waiter.reject(new GatewayRequestError(
          'speech_unavailable',
          event.data.message || 'Lumi speech synthesis failed',
        ))
        return
      }
      waiter.resolve({
        data_base64: event.data.dataBase64,
        mime_type: event.data.mimeType,
      })
    })
    await channelClient.ready({ timeout: 15_000 })
    return channelClient
  }

  function createLocalGateway(config: ElectronLumiAstrBotGatewayConfig) {
    const app = new H3()
    app.get('/api/lumi/integrations/astrbot/health', async (event) => {
      if (!hasToken(event.req.headers, currentConfig().apiToken))
        return Response.json({ error: 'Authentication required' }, { status: 401 })
      if (await readLumiClientRuntimeMode() !== 'offline-client')
        return Response.json({ error: 'The desktop client is currently using Lumi Server mode' }, { status: 409 })
      try {
        const status = await probeRuntimeStatus()
        return Response.json({
          status: status.available ? 'ok' : 'not_ready',
          server_version: 'lumi-desktop-local-v1',
          runtime_role: 'offline-client',
          consciousness: status.consciousness,
          vision: status.vision,
          hearing: status.hearing,
          ...(status.detail ? { detail: status.detail } : {}),
        }, { status: status.available ? 200 : 503 })
      }
      catch (error) {
        return Response.json({
          status: 'not_ready',
          code: 'runtime_not_ready',
          error: errorMessageFrom(error) ?? 'Lumi renderer runtime is not ready',
          server_version: 'lumi-desktop-local-v1',
          runtime_role: 'offline-client',
          consciousness: false,
          vision: false,
          hearing: false,
        }, { status: 503 })
      }
    })
    app.post('/api/lumi/integrations/astrbot/perceive', async (event) => {
      if (!hasToken(event.req.headers, currentConfig().apiToken))
        return Response.json({ error: 'Authentication required' }, { status: 401 })
      const contentLength = Number(event.req.headers.get('content-length') ?? 0)
      if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > MAX_REQUEST_BYTES)
        return Response.json({ error: 'AstrBot perception request size is invalid' }, { status: 413 })
      try {
        return await perceiveAndRespond(await event.req.json())
      }
      catch (error) {
        if (error instanceof GatewayRequestError)
          return Response.json({ error: error.message, code: error.code }, { status: gatewayErrorStatus(error.code) })
        log.withError(error).error('Lumi local AstrBot perception failed')
        return Response.json({ error: 'Lumi desktop failed to process the AstrBot event' }, { status: 500 })
      }
    })
    app.post('/api/lumi/integrations/astrbot/speech', async (event) => {
      if (!hasToken(event.req.headers, currentConfig().apiToken))
        return Response.json({ error: 'Authentication required' }, { status: 401 })
      try {
        const body = await event.req.json() as { text?: unknown }
        const text = requiredText(body.text, 'speech text', 20_000)
        return Response.json(await synthesizeSpeech(text))
      }
      catch (error) {
        if (error instanceof GatewayRequestError)
          return Response.json({ error: error.message, code: error.code }, { status: gatewayErrorStatus(error.code) })
        return Response.json({ error: errorMessageFrom(error) ?? 'Lumi speech synthesis failed' }, { status: 500 })
      }
    })
    return createH3Server({ app, host: '127.0.0.1', port: config.port })
  }

  async function perceiveAndRespond(input: unknown): Promise<GatewayResponse> {
    if (await readLumiClientRuntimeMode() !== 'offline-client')
      throw new GatewayRequestError('runtime_mode_conflict', 'The desktop client is currently using Lumi Server mode')
    const runtimeStatus = await probeRuntimeStatus()
    if (!runtimeStatus.available) {
      throw new GatewayRequestError(
        'runtime_not_ready',
        runtimeStatus.detail ?? 'Lumi local consciousness is not ready',
      )
    }
    const event = validatePerceptionEvent(input)
    const cached = completed.get(event.event_id)
    if (cached)
      return cached
    if (pending.has(event.event_id))
      throw new GatewayRequestError('duplicate_event', 'This AstrBot event is already being processed')

    const binding = currentConfig().identityBindings.find(candidate =>
      candidate.platformInstanceId === event.platform_instance_id
      && candidate.externalUserId === event.sender_id,
    )
    if (!binding)
      throw new GatewayRequestError('identity_unbound', 'AstrBot identity is not bound to a local Lumi person')

    await linkLumiExternalIdentity({
      userId: binding.personId,
      provider: 'astrbot',
      providerInstanceId: binding.platformInstanceId,
      externalUserId: binding.externalUserId,
    })
    const client = await ensureChannelClient()
    const response = new Promise<GatewayResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(event.event_id)
        reject(new GatewayRequestError('generation_timeout', 'Lumi local generation timed out'))
      }, RESPONSE_TIMEOUT_MS)
      pending.set(event.event_id, { reject, resolve, timer })
    })

    try {
      client.sendOrThrow({
        type: 'input:text',
        data: {
          text: event.segments
            .filter((segment): segment is LocalTextSegment => segment.type === 'text')
            .map(segment => segment.text)
            .join('\n'),
          textRaw: event.segments
            .filter((segment): segment is LocalTextSegment => segment.type === 'text')
            .map(segment => segment.text)
            .join('\n'),
          actor: {
            provider: 'astrbot',
            providerInstanceId: event.platform_instance_id,
            externalUserId: event.sender_id,
          },
          perception: {
            eventId: event.event_id,
            segments: event.segments.map(toChannelSegment),
          },
        },
      })
    }
    catch (error) {
      const waiter = pending.get(event.event_id)
      if (waiter)
        clearTimeout(waiter.timer)
      pending.delete(event.event_id)
      throw error
    }
    return await response
  }

  async function probeRuntimeStatus(): Promise<RuntimeStatus> {
    const client = await ensureChannelClient()
    const requestId = randomBytes(16).toString('hex')
    const response = new Promise<RuntimeStatus>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRuntimeStatuses.delete(requestId)
        reject(new GatewayRequestError(
          'runtime_not_ready',
          'Lumi renderer did not report readiness. Wait for the desktop UI to finish loading.',
        ))
      }, RUNTIME_STATUS_TIMEOUT_MS)
      pendingRuntimeStatuses.set(requestId, { reject, resolve, timer })
    })
    try {
      client.sendOrThrow({
        type: 'lumi:external:runtime:status:request',
        data: { requestId },
      })
    }
    catch (error) {
      const waiter = pendingRuntimeStatuses.get(requestId)
      if (waiter)
        clearTimeout(waiter.timer)
      pendingRuntimeStatuses.delete(requestId)
      throw error
    }
    return await response
  }

  async function synthesizeSpeech(text: string): Promise<GatewaySpeechResponse> {
    const client = await ensureChannelClient()
    const requestId = randomBytes(16).toString('hex')
    const response = new Promise<GatewaySpeechResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingSpeech.delete(requestId)
        reject(new GatewayRequestError('speech_unavailable', 'Lumi speech synthesis timed out'))
      }, SPEECH_TIMEOUT_MS)
      pendingSpeech.set(requestId, { reject, resolve, timer })
    })
    try {
      client.sendOrThrow({
        type: 'lumi:external:speech:request',
        data: { requestId, text },
      })
    }
    catch (error) {
      const waiter = pendingSpeech.get(requestId)
      if (waiter)
        clearTimeout(waiter.timer)
      pendingSpeech.delete(requestId)
      throw error
    }
    return await response
  }

  defineInvokeHandler(context, electronLumiAstrBotGatewayGetState, getState)
  defineInvokeHandler(context, electronLumiAstrBotGatewayUpdateConfig, applyConfig)
  defineInvokeHandler(context, electronLumiAstrBotGatewayRotateToken, rotateToken)

  params.lifecycle.appHooks.onStart(async () => {
    if (currentConfig().enabled)
      await start().catch(() => {})
  })
  params.lifecycle.appHooks.onStop(stop)

  return { getState, start, stop }

  function currentConfig() {
    return normalizeConfig(gatewayConfigStore.get() ?? createDefaultConfig())
  }

  async function syncIdentityBindings(config: ElectronLumiAstrBotGatewayConfig) {
    for (const binding of config.identityBindings) {
      await linkLumiExternalIdentity({
        userId: binding.personId,
        provider: 'astrbot',
        providerInstanceId: binding.platformInstanceId,
        externalUserId: binding.externalUserId,
      })
    }
  }

  function personForActor(platformInstanceId: string | undefined, externalUserId: string | undefined) {
    return currentConfig().identityBindings.find(binding =>
      binding.platformInstanceId === platformInstanceId
      && binding.externalUserId === externalUserId,
    )?.personId ?? ''
  }

  function rememberCompleted(eventId: string, response: GatewayResponse) {
    completed.set(eventId, response)
    if (completed.size > 512)
      completed.delete(completed.keys().next().value!)
  }
}

interface LocalTextSegment {
  type: 'text'
  text: string
  metadata?: Record<string, unknown>
}

interface LocalMediaSegment {
  type: 'image' | 'audio'
  data_base64: string
  mime_type: string
  size_bytes: number
  duration_ms?: number
  metadata?: Record<string, unknown>
}

interface LocalPerceptionEvent {
  event_id: string
  platform_instance_id: string
  conversation_id: string
  sender_id: string
  is_private: boolean
  is_group: boolean
  group_id?: string | null
  segments: Array<LocalTextSegment | LocalMediaSegment>
}

function validatePerceptionEvent(value: unknown): LocalPerceptionEvent {
  if (!value || typeof value !== 'object')
    throw new GatewayRequestError('invalid_event', 'Invalid AstrBot perception event')
  const event = value as Partial<LocalPerceptionEvent>
  const eventId = requiredText(event.event_id, 'event id', 500)
  const platformInstanceId = requiredText(event.platform_instance_id, 'platform instance id', 160)
  const conversationId = requiredText(event.conversation_id, 'conversation id', 500)
  const senderId = requiredText(event.sender_id, 'sender id', 240)
  if (!event.is_private || event.is_group || event.group_id)
    throw new GatewayRequestError('invalid_event', 'AstrBot group events are disabled')
  if (!Array.isArray(event.segments) || !event.segments.length || event.segments.length > 32)
    throw new GatewayRequestError('invalid_event', 'AstrBot perception segments are invalid')

  const segments = event.segments.map((segment): LocalTextSegment | LocalMediaSegment => {
    if (!segment || typeof segment !== 'object')
      throw new GatewayRequestError('invalid_event', 'AstrBot perception segment is invalid')
    if (segment.type === 'text') {
      return {
        type: 'text',
        text: requiredText(segment.text, 'text segment', 100_000),
        metadata: safeMetadata(segment.metadata),
      }
    }
    if (segment.type !== 'image' && segment.type !== 'audio')
      throw new GatewayRequestError('invalid_event', 'AstrBot perception segment type is unsupported')
    const maximum = segment.type === 'image' ? 10 * 1024 * 1024 : 25 * 1024 * 1024
    const encoded = requiredText(segment.data_base64, `${segment.type} data`, Math.ceil(maximum * 4 / 3) + 8)
    const data = Buffer.from(encoded, 'base64')
    if (!data.byteLength || data.byteLength > maximum || data.byteLength !== segment.size_bytes)
      throw new GatewayRequestError('media_too_large', `${segment.type} size is invalid`)
    return {
      type: segment.type,
      data_base64: encoded,
      mime_type: requiredText(segment.mime_type, `${segment.type} media type`, 120),
      size_bytes: data.byteLength,
      duration_ms: finiteOptionalInteger(segment.duration_ms),
      metadata: safeMetadata(segment.metadata),
    }
  })
  return {
    event_id: eventId,
    platform_instance_id: platformInstanceId,
    conversation_id: conversationId,
    sender_id: senderId,
    is_private: true,
    is_group: false,
    group_id: null,
    segments,
  }
}

function toChannelSegment(segment: LocalTextSegment | LocalMediaSegment) {
  if (segment.type === 'text')
    return segment
  return {
    type: segment.type,
    dataBase64: segment.data_base64,
    mimeType: segment.mime_type,
    sizeBytes: segment.size_bytes,
    durationMs: segment.duration_ms,
    metadata: segment.metadata,
  }
}

function normalizeConfig(input: ElectronLumiAstrBotGatewayConfig): ElectronLumiAstrBotGatewayConfig {
  const parsed = safeParse(gatewayConfigSchema, input)
  if (!parsed.success)
    throw new Error('Lumi AstrBot gateway configuration is invalid')
  if (!Number.isInteger(parsed.output.port) || parsed.output.port < 1024 || parsed.output.port > 65_535)
    throw new Error('Lumi AstrBot gateway port must be between 1024 and 65535')
  const apiToken = parsed.output.apiToken.trim()
  if (apiToken.length < 32 || apiToken.length > 512)
    throw new Error('Lumi AstrBot gateway token must contain at least 32 characters')

  const identityKeys = new Set<string>()
  const identityBindings = parsed.output.identityBindings.map((binding) => {
    const platformInstanceId = requiredText(binding.platformInstanceId, 'platform instance id', 160)
    const externalUserId = requiredText(binding.externalUserId, 'external user id', 160)
    const personId = requiredText(binding.personId, 'Lumi person id', 160)
    if (![DOGGY_PERSON_ID, MOUSSY_PERSON_ID].includes(personId))
      throw new Error('Lumi AstrBot gateway identity must map to Doggy or Moussy')
    const key = `${platformInstanceId}\0${externalUserId}`
    if (identityKeys.has(key))
      throw new Error('The same AstrBot account cannot be assigned more than once')
    identityKeys.add(key)
    return { platformInstanceId, externalUserId, personId }
  })
  return {
    enabled: parsed.output.enabled,
    port: parsed.output.port,
    apiToken,
    identityBindings,
  }
}

function assistantText(message: unknown) {
  if (!message || typeof message !== 'object')
    return ''
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string')
    return content.trim()
  if (!Array.isArray(content))
    return ''
  return content
    .map((part) => {
      if (typeof part === 'string')
        return part
      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string')
        return part.text
      return ''
    })
    .filter(Boolean)
    .join('')
    .trim()
}

function safeMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return {}
  const serialized = JSON.stringify(value)
  return serialized.length <= 8_192 ? value as Record<string, unknown> : {}
}

function finiteOptionalInteger(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function requiredText(value: unknown, field: string, maximum: number) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > maximum)
    throw new GatewayRequestError('invalid_event', `${field} is invalid`)
  return normalized
}

function hasToken(headers: Headers, expected: string) {
  const authorization = headers.get('authorization') ?? ''
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  const suppliedBuffer = Buffer.from(supplied)
  const expectedBuffer = Buffer.from(expected)
  return suppliedBuffer.byteLength === expectedBuffer.byteLength
    && suppliedBuffer.byteLength > 0
    && timingSafeEqual(suppliedBuffer, expectedBuffer)
}

class GatewayRequestError extends Error {
  constructor(
    readonly code: 'duplicate_event' | 'generation_timeout' | 'hearing_unavailable' | 'identity_unbound' | 'invalid_event' | 'media_too_large' | 'runtime_mode_conflict' | 'runtime_not_ready' | 'speech_unavailable' | 'vision_unavailable' | 'generation_failed',
    message: string,
  ) {
    super(message)
  }
}

function gatewayErrorStatus(code: GatewayRequestError['code']) {
  if (code === 'identity_unbound')
    return 403
  if (code === 'media_too_large')
    return 413
  if (code === 'runtime_mode_conflict' || code === 'duplicate_event')
    return 409
  if (code === 'generation_timeout')
    return 504
  if (code === 'vision_unavailable' || code === 'hearing_unavailable' || code === 'speech_unavailable' || code === 'runtime_not_ready')
    return 503
  if (code === 'invalid_event')
    return 400
  return 500
}
