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
import { array, boolean, number, object, optional, picklist, safeParse, string } from 'valibot'

import {
  electronLumiAstrBotGatewayGetState,
  electronLumiAstrBotGatewayResumeLearning,
  electronLumiAstrBotGatewayRotateToken,
  electronLumiAstrBotGatewayUpdateConfig,
  electronLumiStickerDelete,
  electronLumiStickerGetPreview,
  electronLumiStickerUpdate,
} from '../../../../shared/eventa'
import { createConfig } from '../../../libs/electron/persistence'
import { getChannelServerConfig } from '../channel-server'
import { createH3Server } from '../http-server/server'
import { linkLumiExternalIdentity } from '../lumi-identity'
import { readLumiClientRuntimeMode } from '../lumi-online/runtime-role'
import { LumiStickerLibrary } from './sticker-library'

const DOGGY_PERSON_ID = 'lumi-user-00000000-0000-4000-8000-000000000001'
const MOUSSY_PERSON_ID = 'lumi-user-00000000-0000-4000-8000-000000000002'
const MAX_REQUEST_BYTES = 50 * 1024 * 1024
const RESPONSE_TIMEOUT_MS = 300_000
const RUNTIME_STATUS_TIMEOUT_MS = 5_000
const SPEECH_TIMEOUT_MS = 120_000
const STICKER_INTELLIGENCE_TIMEOUT_MS = 120_000

const gatewayConfigSchema = object({
  enabled: boolean(),
  port: number(),
  apiToken: string(),
  identityBindings: array(object({
    platformInstanceId: string(),
    externalUserId: string(),
    personId: string(),
  })),
  privateReplyEnabled: optional(boolean()),
  groupObservationEnabled: optional(boolean()),
  // NOTICE:
  // Kept only so persisted v1 desktop settings can be migrated during normalization.
  // New settings must never write this mutually exclusive field.
  learningMode: optional(picklist(['normal', 'observe_only'])),
  studyGroups: optional(array(object({
    id: string(),
    platformInstanceId: string(),
    groupId: string(),
    displayName: string(),
    enabled: boolean(),
    priority: picklist(['normal', 'high']),
  }))),
  observationBatchSize: optional(number()),
  observationHistoryLimit: optional(number()),
  observationConcurrentGroups: optional(number()),
  stickerLibrary: optional(object({
    enabled: boolean(),
    collectFromStudyGroups: boolean(),
    relativePath: string(),
    maximumItems: number(),
    sendProbability: number(),
    cooldownMessages: number(),
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
    privateReplyEnabled: true,
    groupObservationEnabled: false,
    studyGroups: [],
    observationBatchSize: 20,
    observationHistoryLimit: 5_000,
    observationConcurrentGroups: 3,
    stickerLibrary: {
      enabled: true,
      collectFromStudyGroups: true,
      relativePath: 'data/lumi-stickers',
      maximumItems: 256,
      sendProbability: 0.18,
      cooldownMessages: 3,
    },
  }
}

const gatewayConfigStore = createConfig('lumi-astrbot-gateway', 'config.json', gatewayConfigSchema, {
  default: createDefaultConfig(),
  autoHeal: true,
})

interface GatewayResponse {
  response_id: string
  text: string
  segments: Array<
    | { type: 'text', text: string }
    | {
      type: 'image'
      data_base64: string
      mime_type: string
      metadata: { sticker_id: string, tags: string[] }
    }
  >
  metadata: {
    actor_person_id: string
    conversation_id: string
    runtime_role: 'offline-client'
  }
}

interface PendingResponse {
  inputText: string
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

interface GatewayProgressEvent {
  sequence: number
  tool_name: string
  status: 'started' | 'succeeded' | 'failed' | 'skipped'
  message: string
  timestamp: number
  duration_ms?: number
  error_code?: string
}

interface GatewayProgressState {
  complete: boolean
  events: GatewayProgressEvent[]
}

interface StickerIntelligenceResult {
  classification?: {
    tags: string[]
    summary: string
    confidence: number
  }
  selection?: {
    stickerId?: string
    reason: string
  }
}

interface PendingStickerIntelligence {
  reject: (error: Error) => void
  resolve: (result: StickerIntelligenceResult) => void
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
  const progressByEvent = new Map<string, GatewayProgressState>()
  const pendingRuntimeStatuses = new Map<string, PendingRuntimeStatus>()
  const pendingSpeech = new Map<string, PendingSpeech>()
  const pendingStickerIntelligence = new Map<string, PendingStickerIntelligence>()
  const completed = new Map<string, GatewayResponse>()
  const { context } = createContext(ipcMain)
  const stickerLibrary = new LumiStickerLibrary(
    () => currentConfig().stickerLibrary,
    undefined,
    {
      async classify(input) {
        const result = await requestStickerIntelligence('classify', input)
        if (!result.classification)
          throw new Error('Lumi consciousness returned no sticker classification')
        return result.classification
      },
      async select(input) {
        const result = await requestStickerIntelligence('select', input)
        if (!result.selection)
          throw new Error('Lumi consciousness returned no sticker selection')
        return result.selection
      },
    },
  )

  async function getState(): Promise<ElectronLumiAstrBotGatewayState> {
    const config = currentConfig()
    return {
      config,
      running,
      endpoint: `http://127.0.0.1:${config.port}`,
      runtimeMode: await readLumiClientRuntimeMode(),
      stickerLibrary: await stickerLibrary.snapshot(),
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
    progressByEvent.clear()
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
    for (const waiter of pendingStickerIntelligence.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('Lumi local AstrBot gateway stopped'))
    }
    pendingStickerIntelligence.clear()
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

  async function resumeLearning() {
    const config = currentConfig()
    const client = await ensureChannelClient()
    client.sendOrThrow({
      type: 'lumi:external:group-observation:resume',
      data: {
        batchSize: config.observationBatchSize,
        concurrentGroups: config.observationConcurrentGroups,
      },
    })
    return await getState()
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
        'lumi:external:agent-progress',
        'lumi:external:runtime:status',
        'lumi:external:group-observation:result',
        'lumi:external:sticker-intelligence:result',
        'lumi:external:speech:result',
      ],
    })
    channelClient.onEvent('output:gen-ai:chat:complete', async (event) => {
      const input = event.data['gen-ai:chat']?.input
      const perception = input?.type === 'input:text' ? input.data.perception : undefined
      if (!perception || !input || input.type !== 'input:text')
        return
      const outputText = stripInternalLumiOutput(event.data.outputText)
      if (!outputText)
        return
      const waiter = pending.get(perception.eventId)
      if (!waiter)
        return
      clearTimeout(waiter.timer)
      pending.delete(perception.eventId)
      const actor = input.data.actor
      let sticker: Awaited<ReturnType<typeof stickerLibrary.selectForReply>> = null
      try {
        sticker = await stickerLibrary.selectForReply({
          eventId: perception.eventId,
          inputText: waiter.inputText,
          replyText: outputText,
        })
      }
      catch (error) {
        log.withError(error).warn('Lumi sticker selection failed; continuing with the text response')
      }
      const conversationId = input.data.overrides?.sessionId || ''
      if (sticker && conversationId) {
        channelClient?.sendOrThrow({
          type: 'lumi:external:assistant-sticker',
          data: {
            eventId: perception.eventId,
            conversationId,
            stickerId: sticker.id,
            dataBase64: sticker.dataBase64,
            mimeType: sticker.mimeType,
            tags: sticker.tags,
          },
        })
      }
      const response: GatewayResponse = {
        response_id: `${perception.eventId}:assistant`,
        text: outputText,
        segments: [
          ...(outputText ? [{ type: 'text' as const, text: outputText }] : []),
          ...(sticker
            ? [{
                type: 'image' as const,
                data_base64: sticker.dataBase64,
                mime_type: sticker.mimeType,
                metadata: {
                  sticker_id: sticker.id,
                  tags: sticker.tags,
                },
              }]
            : []),
        ],
        metadata: {
          actor_person_id: personForActor(actor?.providerInstanceId, actor?.externalUserId),
          conversation_id: conversationId,
          runtime_role: 'offline-client',
        },
      }
      rememberCompleted(perception.eventId, response)
      completeProgress(perception.eventId)
      waiter.resolve(response)
    })
    channelClient.onEvent('lumi:external:agent-progress', (event) => {
      const state = progressByEvent.get(event.data.eventId)
      if (!state || state.complete || event.data.toolName === 'reply')
        return
      if (event.data.status !== 'started')
        return
      const message = sanitizePublicProgressText(event.data.publicProgressText)
      if (!message)
        return
      if (state.events.some(item => item.message === message))
        return
      state.events.push({
        sequence: state.events.length + 1,
        tool_name: event.data.toolName,
        status: event.data.status,
        message,
        timestamp: event.data.timestamp,
        ...(event.data.durationMs === undefined ? {} : { duration_ms: event.data.durationMs }),
        ...(event.data.errorCode ? { error_code: event.data.errorCode } : {}),
      })
    })
    channelClient.onEvent('lumi:external:perception:failed', (event) => {
      const waiter = pending.get(event.data.eventId)
      if (!waiter)
        return
      clearTimeout(waiter.timer)
      pending.delete(event.data.eventId)
      completeProgress(event.data.eventId)
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
    channelClient.onEvent('lumi:external:sticker-intelligence:result', (event) => {
      const waiter = pendingStickerIntelligence.get(event.data.requestId)
      if (!waiter)
        return
      clearTimeout(waiter.timer)
      pendingStickerIntelligence.delete(event.data.requestId)
      if (!event.data.ok) {
        waiter.reject(new GatewayRequestError(
          'sticker_intelligence_unavailable',
          event.data.message || 'Lumi consciousness did not complete the sticker task',
        ))
        return
      }
      waiter.resolve({
        classification: event.data.classification,
        selection: event.data.selection,
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
    app.get('/api/lumi/integrations/astrbot/learning-policy', (event) => {
      if (!hasToken(event.req.headers, currentConfig().apiToken))
        return Response.json({ error: 'Authentication required' }, { status: 401 })
      const current = currentConfig()
      return Response.json({
        private_reply_enabled: current.privateReplyEnabled,
        group_observation_enabled: current.groupObservationEnabled,
        // Older installed plugins can still read this projection while the
        // authoritative policy remains the two independent booleans above.
        mode: current.groupObservationEnabled && !current.privateReplyEnabled
          ? 'observe_only'
          : 'normal',
        groups: current.studyGroups
          .filter(group => group.enabled)
          .map(group => ({
            source_id: group.id,
            platform_instance_id: group.platformInstanceId,
            group_id: group.groupId,
            priority: group.priority,
          })),
      })
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
    app.post('/api/lumi/integrations/astrbot/observe', async (event) => {
      if (!hasToken(event.req.headers, currentConfig().apiToken))
        return Response.json({ error: 'Authentication required' }, { status: 401 })
      try {
        const observation = validateGroupObservation(await event.req.json(), currentConfig())
        if (observation.text)
          await stickerLibrary.observeContext(observation.sourceId, observation.text, observation.timestamp)
        await Promise.all(observation.images.map(image => stickerLibrary.collect({
          dataBase64: image.dataBase64,
          mimeType: image.mimeType,
          sourceId: observation.sourceId,
          senderName: observation.senderName,
          contextText: observation.text,
          timestamp: observation.timestamp,
        })))
        if (observation.text) {
          const client = await ensureChannelClient()
          client.sendOrThrow({
            type: 'lumi:external:group-observation:request',
            data: {
              requestId: randomBytes(16).toString('hex'),
              eventId: observation.eventId,
              messageId: observation.messageId,
              sourceId: observation.sourceId,
              platform: observation.platform,
              platformInstanceId: observation.platformInstanceId,
              groupId: observation.groupId,
              senderId: observation.senderId,
              senderName: observation.senderName,
              authorVerified: observation.authorVerified,
              isLumi: observation.isLumi,
              sourceKind: observation.sourceKind,
              text: observation.text,
              timestamp: observation.timestamp,
              batchSize: currentConfig().observationBatchSize,
              historyLimit: currentConfig().observationHistoryLimit,
              concurrentGroups: currentConfig().observationConcurrentGroups,
            },
          })
        }
        return Response.json({ accepted: true, reply_suppressed: true }, { status: 202 })
      }
      catch (error) {
        if (error instanceof GatewayRequestError)
          return Response.json({ error: error.message, code: error.code }, { status: gatewayErrorStatus(error.code) })
        return Response.json({ error: errorMessageFrom(error) ?? 'Group observation failed' }, { status: 500 })
      }
    })
    app.get('/api/lumi/integrations/astrbot/progress', (event) => {
      if (!hasToken(event.req.headers, currentConfig().apiToken))
        return Response.json({ error: 'Authentication required' }, { status: 401 })
      const url = new URL(event.req.url)
      const eventId = url.searchParams.get('event_id')?.trim()
      const after = Number(url.searchParams.get('after') ?? 0)
      if (!eventId || !Number.isInteger(after) || after < 0)
        return Response.json({ error: 'Progress cursor is invalid' }, { status: 400 })
      const state = progressByEvent.get(eventId)
      return Response.json({
        events: state?.events.filter(item => item.sequence > after) ?? [],
        complete: state?.complete ?? false,
      })
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
    if (!currentConfig().privateReplyEnabled)
      throw new GatewayRequestError('invalid_event', 'Lumi private replies are disabled')
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
        completeProgress(event.event_id)
        reject(new GatewayRequestError('generation_timeout', 'Lumi local generation timed out'))
      }, RESPONSE_TIMEOUT_MS)
      pending.set(event.event_id, {
        inputText: event.segments
          .filter((segment): segment is LocalTextSegment => segment.type === 'text')
          .map(segment => segment.text)
          .join('\n'),
        reject,
        resolve,
        timer,
      })
    })
    progressByEvent.set(event.event_id, { complete: false, events: [] })

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
      completeProgress(event.event_id)
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

  async function requestStickerIntelligence(
    operation: 'classify' | 'select',
    payload: {
      senderName?: string
      contextText?: string
      previousTags?: string[]
      inputText?: string
      replyText?: string
      candidates?: Array<{ id: string, tags: string[], observedCount: number, sentCount: number }>
    },
  ): Promise<StickerIntelligenceResult> {
    const client = await ensureChannelClient()
    const requestId = randomBytes(16).toString('hex')
    const response = new Promise<StickerIntelligenceResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingStickerIntelligence.delete(requestId)
        reject(new GatewayRequestError(
          'sticker_intelligence_unavailable',
          'Lumi consciousness timed out while interpreting sticker context',
        ))
      }, STICKER_INTELLIGENCE_TIMEOUT_MS)
      pendingStickerIntelligence.set(requestId, { reject, resolve, timer })
    })
    try {
      client.sendOrThrow({
        type: 'lumi:external:sticker-intelligence:request',
        data: { requestId, operation, payload },
      })
    }
    catch (error) {
      const waiter = pendingStickerIntelligence.get(requestId)
      if (waiter)
        clearTimeout(waiter.timer)
      pendingStickerIntelligence.delete(requestId)
      throw error
    }
    return await response
  }

  function completeProgress(eventId: string) {
    const state = progressByEvent.get(eventId)
    if (state)
      state.complete = true
    const timer = setTimeout(() => progressByEvent.delete(eventId), 60_000)
    timer.unref()
  }

  defineInvokeHandler(context, electronLumiAstrBotGatewayGetState, getState)
  defineInvokeHandler(context, electronLumiAstrBotGatewayUpdateConfig, applyConfig)
  defineInvokeHandler(context, electronLumiAstrBotGatewayRotateToken, rotateToken)
  defineInvokeHandler(context, electronLumiAstrBotGatewayResumeLearning, resumeLearning)
  defineInvokeHandler(context, electronLumiStickerGetPreview, payload => stickerLibrary.readPreview(payload.id))
  defineInvokeHandler(context, electronLumiStickerUpdate, async (payload) => {
    await stickerLibrary.updateRecord(payload.id, {
      ...(payload.tags ? { tags: payload.tags } : {}),
      ...(payload.status ? { status: payload.status } : {}),
    })
    return await getState()
  })
  defineInvokeHandler(context, electronLumiStickerDelete, async (payload) => {
    await stickerLibrary.deleteRecord(payload.id)
    return await getState()
  })

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

function normalizeConfig(input: unknown): ElectronLumiAstrBotGatewayConfig {
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
  const groupKeys = new Set<string>()
  const studyGroups = (parsed.output.studyGroups ?? []).map((group) => {
    const platformInstanceId = requiredText(group.platformInstanceId, 'study group platform instance id', 160)
    const groupId = requiredText(group.groupId, 'study group id', 240)
    const key = `${platformInstanceId}\0${groupId}`
    if (groupKeys.has(key))
      throw new Error('The same AstrBot study group cannot be configured twice')
    groupKeys.add(key)
    return {
      id: requiredText(group.id, 'study group source id', 500),
      platformInstanceId,
      groupId,
      displayName: requiredText(group.displayName, 'study group display name', 160),
      enabled: group.enabled,
      priority: group.priority,
    }
  })
  const observationBatchSize = Math.floor(parsed.output.observationBatchSize ?? 20)
  if (observationBatchSize < 8 || observationBatchSize > 60)
    throw new Error('AstrBot observation batch size must be between 8 and 60')
  const observationHistoryLimit = Math.floor(parsed.output.observationHistoryLimit ?? 5_000)
  if (observationHistoryLimit < 100 || observationHistoryLimit > 50_000)
    throw new Error('AstrBot observation history limit must be between 100 and 50000')
  const observationConcurrentGroups = Math.floor(parsed.output.observationConcurrentGroups ?? 3)
  if (observationConcurrentGroups < 1 || observationConcurrentGroups > 8)
    throw new Error('AstrBot concurrent observation groups must be between 1 and 8')
  const stickerInput = parsed.output.stickerLibrary ?? createDefaultConfig().stickerLibrary
  const relativePath = stickerInput.relativePath.trim().replaceAll('\\', '/')
  if (!relativePath || relativePath.startsWith('/') || /^[a-z]:/i.test(relativePath) || relativePath.split('/').includes('..'))
    throw new Error('Lumi sticker library path must be relative and cannot contain parent traversal')
  const maximumItems = Math.floor(stickerInput.maximumItems)
  if (maximumItems < 16 || maximumItems > 2_000)
    throw new Error('Lumi sticker library capacity must be between 16 and 2000')
  if (!Number.isFinite(stickerInput.sendProbability) || stickerInput.sendProbability < 0 || stickerInput.sendProbability > 1)
    throw new Error('Lumi sticker send probability must be between 0 and 1')
  const cooldownMessages = Math.floor(stickerInput.cooldownMessages)
  if (cooldownMessages < 0 || cooldownMessages > 100)
    throw new Error('Lumi sticker cooldown must be between 0 and 100 messages')
  const legacyMode = parsed.output.learningMode
  return {
    enabled: parsed.output.enabled,
    port: parsed.output.port,
    apiToken,
    identityBindings,
    privateReplyEnabled: parsed.output.privateReplyEnabled ?? legacyMode !== 'observe_only',
    groupObservationEnabled: parsed.output.groupObservationEnabled ?? legacyMode === 'observe_only',
    studyGroups,
    observationBatchSize,
    observationHistoryLimit,
    observationConcurrentGroups,
    stickerLibrary: {
      enabled: stickerInput.enabled,
      collectFromStudyGroups: stickerInput.collectFromStudyGroups,
      relativePath,
      maximumItems,
      sendProbability: stickerInput.sendProbability,
      cooldownMessages,
    },
  }
}

/**
 * Normalizes Planner-authored progress at the authenticated gateway boundary.
 *
 * Before:
 * - "  第5个账号也拉黑成功！  "
 *
 * After:
 * - "第5个账号也拉黑成功！"
 */
function sanitizePublicProgressText(value: unknown): string | undefined {
  if (typeof value !== 'string')
    return undefined
  const message = value.trim().slice(0, 320).trim()
  if (!message)
    return undefined
  if (/\[(?:memory_search|memory_write|system_notice|tool_execution|planner_trace)\]/i.test(message))
    return undefined
  return message
}

function stripInternalLumiOutput(text: string): string {
  const markerIndexes = ['[memory_search]', '[memory_write]', '[system_notice]']
    .map(marker => text.indexOf(marker))
    .filter(index => index >= 0)
  if (markerIndexes.length === 0)
    return text.trim()

  return text.slice(0, Math.min(...markerIndexes)).trim()
}

function validateGroupObservation(value: unknown, config: ElectronLumiAstrBotGatewayConfig) {
  if (!config.groupObservationEnabled)
    throw new GatewayRequestError('invalid_event', 'Lumi group observation is disabled')
  if (!value || typeof value !== 'object')
    throw new GatewayRequestError('invalid_event', 'Invalid AstrBot group observation')
  const event = value as Record<string, unknown>
  if (event.conversation_type !== 'group_observation')
    throw new GatewayRequestError('invalid_event', 'Observation conversation type is invalid')
  if (event.author_verified !== true || event.is_lumi !== false || event.source_kind !== 'human_message')
    throw new GatewayRequestError('invalid_event', 'Observation source is not an eligible verified human message')
  const platformInstanceId = requiredText(event.platform_instance_id, 'platform instance id', 160)
  const groupId = requiredText(event.group_id, 'group id', 240)
  const source = config.studyGroups.find(group =>
    group.enabled
    && group.platformInstanceId === platformInstanceId
    && group.groupId === groupId,
  )
  if (!source)
    throw new GatewayRequestError('identity_unbound', 'AstrBot group is not authorized for learning')
  if (event.is_group !== true || event.is_private === true)
    throw new GatewayRequestError('invalid_event', 'Observation must be a group message')
  const segments = Array.isArray(event.segments) ? event.segments : []
  if (!segments.length || segments.length > 32)
    throw new GatewayRequestError('invalid_event', 'Learning observation segments are invalid')
  if (segments.some(segment =>
    !segment
    || typeof segment !== 'object'
    || !['text', 'image'].includes(String((segment as { type?: unknown }).type)),
  )) {
    throw new GatewayRequestError('invalid_event', 'Learning mode accepts only text and image observations')
  }
  const text = segments
    .filter(segment => (segment as { type?: unknown }).type === 'text')
    .map(segment => requiredText((segment as { text?: unknown }).text, 'observation text', 4_000))
    .join('\n')
    .trim()
  const images = segments
    .filter(segment => (segment as { type?: unknown }).type === 'image')
    .map((segment) => {
      const media = segment as Record<string, unknown>
      const encoded = requiredText(media.data_base64, 'sticker image data', Math.ceil(10 * 1024 * 1024 * 4 / 3) + 8)
      const bytes = Buffer.from(encoded, 'base64')
      if (!bytes.length || bytes.length > 10 * 1024 * 1024 || bytes.length !== media.size_bytes)
        throw new GatewayRequestError('media_too_large', 'Sticker image size is invalid')
      return {
        dataBase64: encoded,
        mimeType: requiredText(media.mime_type, 'sticker image media type', 120),
      }
    })
  if (!text && !images.length)
    throw new GatewayRequestError('invalid_event', 'Learning observation has no text or image')
  return {
    eventId: requiredText(event.event_id, 'event id', 500),
    messageId: requiredText(event.message_id, 'message id', 500),
    sourceId: source.id,
    platform: requiredText(event.platform, 'platform', 160),
    platformInstanceId,
    groupId,
    senderId: requiredText(event.sender_id, 'sender id', 240),
    senderName: requiredText(event.sender_name, 'sender name', 240),
    authorVerified: true as const,
    isLumi: false as const,
    sourceKind: 'human_message' as const,
    text,
    images,
    timestamp: finiteOptionalInteger(event.timestamp) ?? Date.now(),
  }
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
    readonly code: 'duplicate_event' | 'generation_timeout' | 'hearing_unavailable' | 'identity_unbound' | 'invalid_event' | 'media_too_large' | 'runtime_mode_conflict' | 'runtime_not_ready' | 'speech_unavailable' | 'sticker_intelligence_unavailable' | 'vision_unavailable' | 'generation_failed',
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
  if (code === 'vision_unavailable' || code === 'hearing_unavailable' || code === 'speech_unavailable' || code === 'sticker_intelligence_unavailable' || code === 'runtime_not_ready')
    return 503
  if (code === 'invalid_event')
    return 400
  return 500
}
