import type { Hooks as CrossWebSocketHooks } from 'crossws'
import type { WebSocketMessage, WebSocketPeer } from 'h3'

import type { LumiVisionAnalyzer } from './astrbotIntegration'
import type { LumiManagerApiOptions } from './managerApi'
import type { LumiReplyContext, LumiReplyGenerator } from './onlineServer'
import type { LumiStickerLibrary } from './stickerLibrary'
import type { LumiVoiceTranscriber } from './transcription'

import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'

import { defineInvokeHandler } from '@moeru/eventa'
import { createPeerContext } from '@moeru/eventa/adapters/websocket/h3'
import { errorMessageFrom } from '@moeru/std'
import {
  lumiOnlineAccessRevoked,
  lumiOnlineGenerationPushed,
  lumiOnlineHello,
  lumiOnlineListConversations,
  lumiOnlineMessagesPushed,
  lumiOnlinePresencePushed,
  lumiOnlineReplayConversation,
  lumiOnlineSendMessage,
} from '@proj-airi/lumi-online'
import { plugin as websocketPlugin } from 'crossws/server'
import { defineWebSocketHandler, H3, serve } from 'h3'

import {
  LumiAstrBotIntegration,
  LumiAstrBotIntegrationError,
} from './astrbotIntegration'
import { createLumiAuthentication } from './auth'
import { LumiServerDatabase } from './database'
import { createLumiManagerApi } from './managerApi'
import { LumiOnlineServer } from './onlineServer'

export interface LumiNetworkServerOptions {
  /** Absolute path to the authoritative server database. */
  databasePath: string
  /** Persistent Better Auth secret with at least 32 bytes of entropy. */
  authSecret: string
  /** Public origin used for Better Auth URL generation. */
  publicBaseURL: string
  /** Creates server-side consciousness after the authoritative database exists. */
  createReplyGenerator: (database: LumiServerDatabase) => LumiReplyGenerator | Promise<LumiReplyGenerator>
  /** Stops database-backed services after generations drain and before SQLite closes. */
  beforeDatabaseClose?: (database: LumiServerDatabase) => Promise<void>
  /** Version exposed during protocol negotiation. */
  serverVersion: string
  /** @default "127.0.0.1" */
  hostname?: string
  /** @default 6130 */
  port?: number
  /** Browser origins allowed to use authentication endpoints. */
  trustedOrigins?: string[]
  /** Optional server-owned speech-to-text provider. */
  voiceTranscriber?: LumiVoiceTranscriber
  /** @default 26214400 */
  maxVoiceBytes?: number
  /** Optional trusted AstrBot event bridge. */
  astrbot?: {
    apiToken: string
    identityBindings: Array<{
      platformInstanceId: string
      externalUserId: string
      personId: string
    }>
    visionAnalyzer?: LumiVisionAnalyzer
    /** @default 10485760 */
    maxImageBytes?: number
    /** @default 26214400 */
    maxAudioBytes?: number
    /** @default 120000 */
    responseTimeoutMs?: number
    /** Maximum base64 JSON request size. @default 52428800 */
    maxRequestBytes?: number
    learningMode?: 'normal' | 'observe_only'
    studyGroups?: Array<{
      id: string
      platformInstanceId: string
      groupId: string
      displayName: string
      enabled: boolean
      priority: 'normal' | 'high'
    }>
    observationBatchSize?: number
    stickerLibrary?: LumiStickerLibrary
    observeGroup?: (input: {
      eventId: string
      messageId: string
      sourceId: string
      platform: string
      platformInstanceId: string
      groupId: string
      senderId: string
      senderName: string
      text: string
      timestamp: number
      batchSize: number
    }) => Promise<void>
  }
  /** Reports an accepted turn that failed during asynchronous generation. */
  onGenerationError?: (error: Error, context: LumiReplyContext) => void
  /** TLS certificate contents for direct public listening. */
  tls?: {
    cert: string
    key: string
    passphrase?: string
  }
  /** Optional local control plane; it is always hard-bound to loopback. */
  manager?: {
    token: string
    /** @default 6131 */
    port?: number
    toolControl?: LumiManagerApiOptions['toolControl']
    pluginControl?: LumiManagerApiOptions['pluginControl']
    dataControl?: LumiManagerApiOptions['dataControl']
  }
}

export interface LumiNetworkServer {
  /** Public HTTP/WebSocket application, exposed for integration tests. */
  app: H3
  /** Local-only management application when enabled. */
  managerApp?: H3
  /** Starts the standalone server listener. */
  start: () => Promise<void>
  /** Returns the bound public URL after {@link start}, including an assigned ephemeral port. */
  url: () => string | undefined
  /** Stops peers, checkpoints SQLite, and closes all server resources. */
  stop: () => Promise<void>
}

/**
 * Creates the standalone Lumi Online HTTP and WebSocket server.
 *
 * Use when:
 * - Starting `server-runtime` from Server Manager or a console runner
 * - Running authenticated transport integration tests
 *
 * Expects:
 * - Public non-loopback listeners use TLS
 * - Exactly one process owns the database and server resource lease
 *
 * Returns:
 * - A lifecycle-controlled server; construction performs migrations but does not listen
 */
export async function createLumiNetworkServer(options: LumiNetworkServerOptions): Promise<LumiNetworkServer> {
  const hostname = options.hostname ?? '127.0.0.1'
  const port = options.port ?? 6130
  if (!isLoopbackHost(hostname) && !options.tls)
    throw new Error('Lumi refuses plaintext HTTP/WS on a non-loopback listener')

  const database = LumiServerDatabase.open(options.databasePath)
  let authentication: Awaited<ReturnType<typeof createLumiAuthentication>>
  let replyGenerator: LumiReplyGenerator
  try {
    authentication = await createLumiAuthentication(database, {
      databasePath: options.databasePath,
      baseURL: options.publicBaseURL,
      secret: options.authSecret,
      trustedOrigins: options.trustedOrigins,
    })
    replyGenerator = await options.createReplyGenerator(database)
  }
  catch (error) {
    database.close()
    throw error
  }
  const onlineServer = new LumiOnlineServer({
    database,
    replyGenerator,
    serverVersion: options.serverVersion,
    voiceInput: Boolean(options.voiceTranscriber),
    maxVoiceBytes: options.maxVoiceBytes,
    onGenerationError: options.onGenerationError,
  })
  const astrbotIntegration = options.astrbot
    ? new LumiAstrBotIntegration({
        database,
        onlineServer,
        identityBindings: options.astrbot.identityBindings,
        visionAnalyzer: options.astrbot.visionAnalyzer,
        voiceTranscriber: options.voiceTranscriber,
        maxImageBytes: options.astrbot.maxImageBytes,
        maxAudioBytes: options.astrbot.maxAudioBytes,
        responseTimeoutMs: options.astrbot.responseTimeoutMs,
        stickerLibrary: options.astrbot.stickerLibrary,
      })
    : undefined
  const managerApi = options.manager
    ? createLumiManagerApi({
        database,
        authentication,
        token: options.manager.token,
        port: options.manager.port,
        toolControl: options.manager.toolControl,
        pluginControl: options.manager.pluginControl,
        dataControl: options.manager.dataControl,
        deviceControl: { revokeDevice: (accountId, deviceId) => revokeConnectedDevice(accountId, deviceId) },
      })
    : undefined
  const app = new H3()
  const invitationClaims = new SlidingWindowLimiter(5, 60_000)
  const loginAttempts = new SlidingWindowLimiter(10, 10 * 60_000)
  const peers = new Map<string, {
    accountId: string
    personId: string
    deviceId?: string
    message: ReturnType<typeof createPeerContext>['hooks']['message']
    emit: ReturnType<typeof createPeerContext>['context']['emit']
    close: (code: number, reason: string) => void
  }>()
  const pendingPeerMessages = new Map<string, Array<{ peer: WebSocketPeer, message: WebSocketMessage }>>()

  function revokeConnectedDevice(accountId: string, deviceId: string) {
    const device = database.revokeDevice(accountId, deviceId)
    for (const [peerId, connected] of peers) {
      if (connected.accountId !== accountId || connected.deviceId !== deviceId)
        continue
      connected.emit(lumiOnlineAccessRevoked, { reason: 'Device access was revoked' })
      connected.close(4401, 'Device access was revoked')
      removePeer(peerId)
    }
    return device
  }

  app.get('/health', () => ({ status: 'ok', role: 'server-runtime' }))
  app.get('/api/lumi/integrations/astrbot/health', (event) => {
    if (!astrbotIntegration)
      return Response.json({ error: 'AstrBot integration is disabled' }, { status: 404 })
    if (!hasIntegrationToken(event.req.headers, options.astrbot!.apiToken))
      return Response.json({ error: 'Authentication required' }, { status: 401 })
    return astrbotIntegration.health(options.serverVersion)
  })
  app.get('/api/lumi/integrations/astrbot/learning-policy', (event) => {
    if (!astrbotIntegration)
      return Response.json({ error: 'AstrBot integration is disabled' }, { status: 404 })
    if (!hasIntegrationToken(event.req.headers, options.astrbot!.apiToken))
      return Response.json({ error: 'Authentication required' }, { status: 401 })
    return {
      mode: options.astrbot!.learningMode ?? 'normal',
      groups: (options.astrbot!.studyGroups ?? [])
        .filter(group => group.enabled)
        .map(group => ({
          source_id: group.id,
          platform_instance_id: group.platformInstanceId,
          group_id: group.groupId,
          priority: group.priority,
        })),
    }
  })
  app.post('/api/lumi/integrations/astrbot/perceive', async (event) => {
    if (!astrbotIntegration)
      return Response.json({ error: 'AstrBot integration is disabled' }, { status: 404 })
    if (!hasIntegrationToken(event.req.headers, options.astrbot!.apiToken))
      return Response.json({ error: 'Authentication required' }, { status: 401 })
    const maximum = options.astrbot!.maxRequestBytes ?? 50 * 1024 * 1024
    const contentLength = Number(event.req.headers.get('content-length') ?? 0)
    if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > maximum)
      return Response.json({ error: 'AstrBot perception request size is invalid' }, { status: 413 })
    try {
      const body = await event.req.json()
      return await astrbotIntegration.perceiveAndRespond(body)
    }
    catch (error) {
      if (error instanceof LumiAstrBotIntegrationError)
        return Response.json({ error: error.message, code: error.code }, { status: integrationErrorStatus(error.code) })
      return Response.json({ error: 'Lumi failed to process the AstrBot event' }, { status: 500 })
    }
  })
  app.post('/api/lumi/integrations/astrbot/observe', async (event) => {
    if (!astrbotIntegration)
      return Response.json({ error: 'AstrBot integration is disabled' }, { status: 404 })
    if (!hasIntegrationToken(event.req.headers, options.astrbot!.apiToken))
      return Response.json({ error: 'Authentication required' }, { status: 401 })
    if ((options.astrbot!.learningMode ?? 'normal') !== 'observe_only')
      return Response.json({ error: 'Lumi learning mode is not active', code: 'invalid_event' }, { status: 409 })
    try {
      const body = await event.req.json() as Record<string, unknown>
      const platformInstanceId = requiredNetworkText(body.platform_instance_id, 'platform instance id', 160)
      const groupId = requiredNetworkText(body.group_id, 'group id', 240)
      const source = (options.astrbot!.studyGroups ?? []).find(group =>
        group.enabled
        && group.platformInstanceId === platformInstanceId
        && group.groupId === groupId,
      )
      if (!source)
        return Response.json({ error: 'AstrBot group is not authorized for learning', code: 'identity_unbound' }, { status: 403 })
      const segments = Array.isArray(body.segments) ? body.segments : []
      if (!segments.length || segments.some(segment => !isLearningSegment(segment)))
        return Response.json({ error: 'Learning mode accepts text and image group messages', code: 'invalid_event' }, { status: 400 })
      const eventId = requiredNetworkText(body.event_id, 'event id', 500)
      const messageId = requiredNetworkText(body.message_id, 'message id', 500)
      const senderName = requiredNetworkText(body.sender_name, 'sender name', 240)
      const timestamp = typeof body.timestamp === 'number' && Number.isFinite(body.timestamp) ? body.timestamp : Date.now()
      const text = segments
        .filter((segment): segment is { type: 'text', text: unknown } => (segment as { type?: unknown }).type === 'text')
        .map(segment => requiredNetworkText(segment.text, 'observation text', 4_000))
        .join('\n')
      if (text && options.astrbot!.observeGroup) {
        await options.astrbot!.observeGroup({
          eventId,
          messageId,
          sourceId: source.id,
          platform: requiredNetworkText(body.platform, 'platform', 160),
          platformInstanceId,
          groupId,
          senderId: requiredNetworkText(body.sender_id, 'sender id', 240),
          senderName,
          text,
          timestamp,
          batchSize: options.astrbot!.observationBatchSize ?? 20,
        })
      }
      if (text)
        await options.astrbot!.stickerLibrary?.observeContext(source.id, text, timestamp)
      for (const segment of segments) {
        if ((segment as { type?: unknown }).type !== 'image')
          continue
        const image = segment as { data_base64?: unknown, mime_type?: unknown }
        await options.astrbot!.stickerLibrary?.collect({
          dataBase64: requiredNetworkText(image.data_base64, 'sticker image', options.astrbot!.maxRequestBytes ?? 50 * 1024 * 1024),
          mimeType: requiredNetworkText(image.mime_type, 'sticker MIME type', 100),
          sourceId: source.id,
          senderName,
          contextText: text,
          timestamp,
        })
      }
      if (!options.astrbot!.observeGroup && !options.astrbot!.stickerLibrary)
        return Response.json({ error: 'Lumi group observation runtime is unavailable', code: 'unavailable' }, { status: 503 })
      return Response.json({ accepted: true, reply_suppressed: true }, { status: 202 })
    }
    catch (error) {
      return Response.json({ error: errorMessageFrom(error) ?? 'Invalid group observation', code: 'invalid_event' }, { status: 400 })
    }
  })
  app.get('/api/lumi/devices', async (event) => {
    const session = await authentication.sessionFromHeaders(event.req.headers)
    if (!session)
      return Response.json({ error: 'Authentication required' }, { status: 401 })
    return { devices: database.listDevices(session.accountId) }
  })
  app.post('/api/lumi/transcribe', async (event) => {
    const session = await authentication.sessionFromHeaders(event.req.headers)
    if (!session)
      return Response.json({ error: 'Authentication required' }, { status: 401 })
    if (!options.voiceTranscriber)
      return Response.json({ error: 'Server voice transcription is disabled' }, { status: 503 })
    const maximum = options.maxVoiceBytes ?? 25 * 1024 * 1024
    const contentLength = Number(event.req.headers.get('content-length') ?? 0)
    if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > maximum)
      return Response.json({ error: `Voice recording must be between 1 and ${maximum} bytes` }, { status: 413 })
    const mimeType = normalizeVoiceMimeType(event.req.headers.get('content-type'))
    const audio = new Uint8Array(await event.req.arrayBuffer())
    if (!audio.byteLength || audio.byteLength > maximum)
      return Response.json({ error: `Voice recording must be between 1 and ${maximum} bytes` }, { status: 413 })
    const text = await options.voiceTranscriber.transcribe({
      audio,
      mimeType,
      fileName: `lumi-voice.${voiceExtension(mimeType)}`,
    })
    database.recordSecurityAudit('voice-transcribed', { accountId: session.accountId, bytes: String(audio.byteLength) })
    return { text }
  })
  app.post('/api/lumi/devices/revoke', async (event) => {
    const session = await authentication.sessionFromHeaders(event.req.headers)
    if (!session)
      return Response.json({ error: 'Authentication required' }, { status: 401 })
    const body = await event.req.json() as Record<string, unknown>
    const deviceId = requiredNetworkText(body.deviceId, 'device id', 160)
    return { device: revokeConnectedDevice(session.accountId, deviceId) }
  })
  app.post('/api/lumi/invitations/claim', async (event) => {
    const key = event.req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    if (!invitationClaims.accept(key))
      return Response.json({ error: 'Too many invitation attempts' }, { status: 429 })
    const contentLength = Number(event.req.headers.get('content-length') ?? 0)
    if (contentLength > 16_384)
      return Response.json({ error: 'Invitation request is too large' }, { status: 413 })
    const body = await event.req.json() as Record<string, unknown>
    const result = await authentication.claimInvitation({
      code: requiredNetworkText(body.code, 'invitation code', 512),
      username: requiredNetworkText(body.username, 'username', 64),
      password: requiredNetworkText(body.password, 'password', 128),
    })
    return { person: result.person }
  })
  app.use('/api/auth/**', async (event) => {
    const requestURL = new URL(event.req.url)
    const isLogin = event.req.method === 'POST' && requestURL.pathname.endsWith('/sign-in/username')
    const contentLength = Number(event.req.headers.get('content-length') ?? 0)
    if (contentLength > 16_384)
      return Response.json({ error: 'Authentication request is too large' }, { status: 413 })
    const source = event.req.headers.get('x-real-ip')?.trim() || 'direct'
    if (isLogin && !loginAttempts.accept(source)) {
      database.recordSecurityAudit('login-rate-limited', { source })
      return Response.json({ error: 'Too many login attempts' }, { status: 429 })
    }
    const response = await authentication.handler(event.req)
    if (isLogin && response.status >= 400)
      database.recordSecurityAudit('login-failed', { source, status: String(response.status) })
    return response
  })

  const websocketHandler = defineWebSocketHandler({
    async open(peer) {
      const sessionHeaders = authenticationHeaders(peer.request)
      const session = await authentication.sessionFromHeaders(sessionHeaders)
      if (!session) {
        peer.close(4401, 'Authentication required')
        return
      }

      const peerContext = createPeerContext(toEventaPeer(peer))
      let deviceId: string | undefined
      peers.set(peer.id, {
        accountId: session.accountId,
        personId: session.person.id,
        message: peerContext.hooks.message,
        emit: peerContext.context.emit.bind(peerContext.context),
        close: (code, reason) => peer.close(code, reason),
      })
      broadcastPresence(session.person.id, 'online')

      const currentSession = async () => {
        const resolved = await authentication.sessionFromHeaders(sessionHeaders)
        if (!resolved) {
          peer.close(4401, 'Session expired or revoked')
          throw new Error('Authentication session is no longer valid')
        }
        if (deviceId && !database.isDeviceActive(resolved.accountId, deviceId)) {
          peer.close(4401, 'Device access was revoked')
          throw new Error('Device access was revoked')
        }
        return resolved
      }

      defineInvokeHandler(peerContext.context, lumiOnlineHello, async (request) => {
        const current = await currentSession()
        const response = onlineServer.hello(current, request)
        deviceId = request.deviceId
        const connected = peers.get(peer.id)
        if (connected)
          connected.deviceId = request.deviceId
        database.registerDevice({
          id: request.deviceId,
          accountId: current.accountId,
          sessionId: current.sessionId,
          name: request.deviceName,
          platform: request.platform ?? 'unknown',
        })
        return response
      })
      defineInvokeHandler(peerContext.context, lumiOnlineListConversations, async () => onlineServer.listConversations(await currentSession()))
      defineInvokeHandler(peerContext.context, lumiOnlineReplayConversation, async request => onlineServer.replayConversation(await currentSession(), request))
      defineInvokeHandler(peerContext.context, lumiOnlineSendMessage, async request => onlineServer.sendMessage(await currentSession(), request))
      for (const pending of pendingPeerMessages.get(peer.id) ?? [])
        peerContext.hooks.message(toEventaPeer(pending.peer), toEventaMessage(pending.message))
      pendingPeerMessages.delete(peer.id)
    },
    message(peer, message) {
      const connected = peers.get(peer.id)
      if (connected) {
        connected.message(toEventaPeer(peer), toEventaMessage(message))
        return
      }
      const pending = pendingPeerMessages.get(peer.id) ?? []
      if (pending.length >= 16) {
        peer.close(4408, 'Too many messages before authentication completed')
        pendingPeerMessages.delete(peer.id)
        return
      }
      pending.push({ peer, message })
      pendingPeerMessages.set(peer.id, pending)
    },
    close(peer) {
      removePeer(peer.id)
    },
    error(peer) {
      removePeer(peer.id)
    },
  })
  app.get('/ws', websocketHandler)

  const removeDeliveryListener = onlineServer.onDelivery((delivery) => {
    for (const peer of peers.values()) {
      if (!delivery.personIds.includes(peer.personId))
        continue
      if (delivery.type === 'messages') {
        peer.emit(lumiOnlineMessagesPushed, {
          conversationId: delivery.conversationId,
          messages: delivery.messages,
        })
      }
      else {
        peer.emit(lumiOnlineGenerationPushed, delivery.event)
      }
    }
  })

  function removePeer(peerId: string) {
    pendingPeerMessages.delete(peerId)
    const removed = peers.get(peerId)
    peers.delete(peerId)
    if (removed && ![...peers.values()].some(peer => peer.personId === removed.personId))
      broadcastPresence(removed.personId, 'offline')
  }

  function broadcastPresence(personId: string, state: 'online' | 'offline') {
    for (const connected of peers.values())
      connected.emit(lumiOnlinePresencePushed, { personId, state, changedAt: Date.now() })
  }

  let listener: ReturnType<typeof serve> | undefined
  let stopped = false
  return {
    app,
    managerApp: managerApi?.app,
    async start() {
      if (stopped)
        throw new Error('A stopped Lumi server cannot be restarted')
      if (listener)
        return
      listener = serve(app, {
        // NOTICE:
        // H3 exposes CrossWS upgrade metadata through its fetch response. srvx needs
        // the CrossWS plugin to consume that metadata and perform the actual upgrade.
        // Source/context: packages/server-runtime/src/server/index.ts.
        // Removal condition: H3/srvx provides first-class WebSocket startup without a plugin.
        plugins: [websocketPlugin({
          resolve: async (request) => {
            const response = await app.fetch(request) as Response & { crossws?: Partial<CrossWebSocketHooks> }
            if (!response.crossws)
              throw new Error('H3 did not provide WebSocket upgrade hooks')
            return response.crossws
          },
        })],
        hostname,
        port,
        tls: options.tls,
        manual: true,
        silent: true,
        // Lumi owns shutdown order so generations drain before SQLite closes.
        // srvx's signal handler would race this lifecycle and call close twice.
        gracefulShutdown: false,
      })
      await listener.serve()
      await managerApi?.start()
    },
    url() {
      return listener?.url
    },
    async stop() {
      if (stopped)
        return
      stopped = true
      removeDeliveryListener()
      await managerApi?.stop()
      await onlineServer.shutdown()
      await options.beforeDatabaseClose?.(database)
      for (const connected of peers.values())
        connected.close(1001, 'Lumi Server is shutting down')
      // WebSocket upgrades are not terminated by Node's closeAllConnections().
      // Give CrossWS one event-loop window to observe the close frames before srvx
      // waits for its in-flight connection tracker during listener shutdown.
      for (let attempt = 0; peers.size > 0 && attempt < 100; attempt += 1)
        await new Promise<void>(resolve => setTimeout(resolve, 10))
      peers.clear()
      await listener?.close(true)
      authentication.close()
      database.close()
    },
  }
}

function isLearningSegment(value: unknown): value is { type: 'text' | 'image' } {
  if (!value || typeof value !== 'object')
    return false
  const type = (value as { type?: unknown }).type
  return type === 'text' || type === 'image'
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase()
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost'
}

function authenticationHeaders(request: Request) {
  const headers = new Headers(request.headers)
  const accessToken = new URL(request.url).searchParams.get('access_token')
  if (!headers.has('authorization') && accessToken)
    headers.set('authorization', `Bearer ${accessToken}`)
  return headers
}

class SlidingWindowLimiter {
  private readonly attempts = new Map<string, number[]>()

  constructor(private readonly maximum: number, private readonly windowMs: number) {}

  accept(key: string) {
    const now = Date.now()
    const retained = (this.attempts.get(key) ?? []).filter(at => at > now - this.windowMs)
    if (retained.length >= this.maximum) {
      this.attempts.set(key, retained)
      return false
    }
    retained.push(now)
    this.attempts.set(key, retained)
    return true
  }
}

function requiredNetworkText(value: unknown, field: string, maximum: number) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > maximum)
    throw new Error(`${field} is invalid`)
  return normalized
}

function normalizeVoiceMimeType(value: string | null) {
  const mimeType = value?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!['audio/wav', 'audio/x-wav', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp4'].includes(mimeType))
    throw new Error('Unsupported voice recording format')
  return mimeType
}

function voiceExtension(mimeType: string) {
  return ({
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
  } as Record<string, string>)[mimeType] ?? 'audio'
}

function toEventaPeer(peer: WebSocketPeer): Parameters<typeof createPeerContext>[0] {
  // NOTICE:
  // Eventa 1.0.0-beta.5 copies CrossWS's nominal Peer declaration into its generated
  // adapter declarations. H3 and Eventa therefore expose the same runtime peer through
  // incompatible private TypeScript identities.
  // Source/context: @moeru/eventa/dist/adapters/websocket/h3/index.d.mts.
  // Removal condition: Eventa imports CrossWS's public Peer type instead of bundling it.
  return peer as unknown as Parameters<typeof createPeerContext>[0]
}

function toEventaMessage(message: WebSocketMessage): Parameters<ReturnType<typeof createPeerContext>['hooks']['message']>[1] {
  // NOTICE:
  // This is the Message half of the same generated Eventa/CrossWS nominal type split
  // documented in {@link toEventaPeer}. Both values come from the same H3 adapter.
  // Removal condition: Eventa imports CrossWS's public Message type instead of bundling it.
  return message as unknown as Parameters<ReturnType<typeof createPeerContext>['hooks']['message']>[1]
}

function hasIntegrationToken(headers: Headers, expected: string) {
  const configured = expected.trim()
  const authorization = headers.get('authorization') ?? ''
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (configured.length < 32 || !supplied)
    return false
  const left = Buffer.from(configured)
  const right = Buffer.from(supplied)
  return left.length === right.length && timingSafeEqual(left, right)
}

function integrationErrorStatus(code: LumiAstrBotIntegrationError['code']) {
  if (code === 'identity_unbound')
    return 403
  if (code === 'vision_unavailable' || code === 'hearing_unavailable')
    return 424
  if (code === 'media_too_large')
    return 413
  if (code === 'generation_timeout')
    return 504
  if (code === 'generation_failed')
    return 502
  return 400
}
