import type { LlmStreamingControlCallManifest } from '@proj-airi/pipelines-audio'
import type { LumiRoomAckEvent, LumiRoomSyncEvent, WebSocketEventOf } from '@proj-airi/server-sdk'
import type { ChatProvider, SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'
import type { UserMessage } from '@xsai/shared-chat'

import type { ChatInteractionContext, ChatStreamEvent, ChatStreamEventContext, ContextMessage } from '../../../types/chat'
import type { SparkNotifyPerformanceResult, SparkNotifyReactionOptions } from './spark-notify-reaction'

import { errorMessageFrom } from '@moeru/std'
import { isStageTamagotchi, isStageWeb } from '@proj-airi/stage-shared'
import { useBroadcastChannel } from '@vueuse/core'
import { Mutex } from 'es-toolkit'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { ref, toRaw, watch } from 'vue'

import { lumiRoomLedgerRepo } from '../../../database/repos/lumi-room-ledger.repo'
import { stripInternalLumiOutput } from '../../../libs/chat-sync'
import { getEventSourceKey } from '../../../utils/event-source'
import { toStructuredCloneSnapshot } from '../../../utils/structured-clone'
import { useCharacterOrchestratorStore } from '../../character'
import { useChatOrchestratorStore } from '../../chat'
import { CHAT_STREAM_CHANNEL_NAME, CONTEXT_CHANNEL_NAME } from '../../chat/constants'
import { useChatContextStore } from '../../chat/context-store'
import { useChatSessionStore } from '../../chat/session-store'
import { useChatStreamStore } from '../../chat/stream-store'
import { useContextObservabilityStore } from '../../devtools/context-observability'
import { useLlmStreamingControlStore } from '../../llm-streaming-control'
import { useLumiEyesStore } from '../../lumi-eyes'
import { useLumiIdentityStore } from '../../lumi-identity'
import { useConsciousnessStore } from '../../modules/consciousness'
import { useHearingSpeechInputPipeline, useHearingStore } from '../../modules/hearing'
import { useSpeechStore } from '../../modules/speech'
import { useVisionStore } from '../../modules/vision'
import { useProvidersStore } from '../../providers'
import { useModsServerChannelStore } from './channel-server'

type ExternalPerceptionFailureCode = 'vision_unavailable' | 'hearing_unavailable'

class ExternalPerceptionProcessingError extends Error {
  constructor(
    readonly code: ExternalPerceptionFailureCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ExternalPerceptionProcessingError'
  }
}

/**
 * Normalizes a renderer chat context for BroadcastChannel transport.
 *
 * Before:
 * - A context whose messages, input, or context entries may be Vue proxies.
 *
 * After:
 * - A detached data-only snapshot that can cross the structured-clone boundary.
 */
export function normalizeContextSnapshot<C extends Pick<ChatStreamEventContext, 'contexts'>>(context: C): C {
  return toStructuredCloneSnapshot(context)
}

function decodeExternalMedia(encoded: string, declaredSize: number, maximum: number) {
  if (!encoded || !Number.isInteger(declaredSize) || declaredSize <= 0 || declaredSize > maximum)
    throw new Error('External media size is invalid')

  let binary: string
  try {
    binary = atob(encoded)
  }
  catch {
    throw new Error('External media is not valid base64')
  }
  if (binary.length !== declaredSize || binary.length > maximum)
    throw new Error('External media size does not match its payload')

  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index)
  return bytes
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

function detectSpeechMime(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WAVE') {
    return 'audio/wav'
  }
  if (bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'OggS')
    return 'audio/ogg'
  if (bytes.length >= 3 && String.fromCharCode(...bytes.subarray(0, 3)) === 'ID3')
    return 'audio/mpeg'
  if (bytes.length >= 2 && bytes[0] === 0xFF && (bytes[1]! & 0xE0) === 0xE0)
    return 'audio/mpeg'
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp')
    return 'audio/mp4'
  return 'audio/mpeg'
}

export const useContextBridgeStore = defineStore('mods:api:context-bridge', () => {
  const consumerRegistrationEvents = [
    'input:text',
    'input:text:voice',
    'input:voice',
    'lumi:room:sync:request',
    'lumi:room:voice:cancel',
    'lumi:external:assistant-sticker',
    'lumi:external:runtime:status:request',
    'lumi:external:group-observation:request',
    'lumi:external:group-observation:resume',
    'lumi:external:sticker-intelligence:request',
    'lumi:external:speech:request',
  ] as const
  const mutex = new Mutex()

  const chatOrchestrator = useChatOrchestratorStore()
  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatContext = useChatContextStore()
  const serverChannelStore = useModsServerChannelStore()
  const contextObservability = useContextObservabilityStore()
  const lumiIdentityStore = useLumiIdentityStore()
  const characterOrchestratorStore = useCharacterOrchestratorStore()
  const consciousnessStore = useConsciousnessStore()
  const hearingStore = useHearingStore()
  const visionStore = useVisionStore()
  const hearingSpeechInputPipeline = useHearingSpeechInputPipeline()
  const speechStore = useSpeechStore()
  const providersStore = useProvidersStore()
  const { activeProvider, activeModel } = storeToRefs(consciousnessStore)
  const { configured: hearingConfigured } = storeToRefs(hearingStore)
  const { configured: visionConfigured } = storeToRefs(visionStore)
  const {
    activeSpeechModel,
    activeSpeechProvider,
    activeSpeechVoice,
    activeSpeechVoiceId,
    ssmlEnabled,
  } = storeToRefs(speechStore)
  const streamingControl = useLlmStreamingControlStore()
  const lumiEyes = useLumiEyesStore()

  const { post: broadcastContext, data: incomingContext } = useBroadcastChannel<ContextMessage, ContextMessage>({ name: CONTEXT_CHANNEL_NAME })
  const { post: broadcastStreamEvent, data: incomingStreamEvent } = useBroadcastChannel<ChatStreamEvent, ChatStreamEvent>({ name: CHAT_STREAM_CHANNEL_NAME })
  type SparkNotifyBridgeMessage
    = | {
      type: 'request'
      requestId: string
      fromInstanceId: string
      payload: SparkNotifyReactionOptions
      performance?: {
        callManifests: LlmStreamingControlCallManifest[]
        timeoutMs?: number
      }
    }
    | {
      type: 'response'
      requestId: string
      toInstanceId: string
      reaction: string
      performance?: SparkNotifyPerformanceResult
    }
  const SPARK_NOTIFY_BRIDGE_CHANNEL_NAME = 'airi-spark-notify-bridge'
  const sparkNotifyBridgeInstanceId = `spark-notify-${nanoid()}`
  const sparkNotifyHostRole = ref<'main' | 'client'>('client')
  const sparkNotifyBridgeWaiters = new Map<string, {
    resolve: (result: { reaction: string, performance?: SparkNotifyPerformanceResult }) => Promise<void> | void
    timeout?: ReturnType<typeof setTimeout>
  }>()
  const { post: postSparkNotifyBridgeMessage, data: incomingSparkNotifyBridgeMessage } = useBroadcastChannel<SparkNotifyBridgeMessage, SparkNotifyBridgeMessage>({ name: SPARK_NOTIFY_BRIDGE_CHANNEL_NAME })

  const disposeHookFns = ref<Array<() => void>>([])
  let remoteStreamGuard: { sessionId: string, generation: number } | null = null
  let initialized = false
  const activeRoomVoiceJobs = new Map<string, AbortController>()

  function recordContextIngestRejected(options: {
    channel: 'server' | 'broadcast' | 'input'
    contextMessage: ContextMessage
    details?: unknown
    error: unknown
    sourceLabel?: string
  }) {
    contextObservability.recordLifecycle({
      phase: 'store-ingest-rejected',
      channel: options.channel,
      sourceKey: getEventSourceKey(options.contextMessage),
      strategy: options.contextMessage.strategy,
      lane: options.contextMessage.lane,
      contextId: options.contextMessage.contextId,
      eventId: options.contextMessage.id,
      textPreview: options.contextMessage.text,
      sourceLabel: options.sourceLabel,
      details: {
        errorMessage: errorMessageFrom(options.error) ?? 'Unknown context ingest error',
        event: options.details,
      },
    })
  }

  function ingestContextMessageSafely(options: {
    channel: 'server' | 'broadcast' | 'input'
    contextMessage: ContextMessage
    details?: unknown
    sourceLabel?: string
  }) {
    try {
      return {
        ok: true as const,
        result: chatContext.ingestContextMessage(options.contextMessage),
      }
    }
    catch (error) {
      recordContextIngestRejected({
        ...options,
        error,
      })
      return {
        ok: false as const,
      }
    }
  }

  function withStreamingCallPrompt(options: SparkNotifyReactionOptions, callPrompt: string): SparkNotifyReactionOptions {
    if (!callPrompt) {
      return options
    }

    return {
      ...options,
      messageOverride: {
        ...options.messageOverride,
        appendSystemInstructions: [
          ...(options.messageOverride?.appendSystemInstructions ?? []),
          callPrompt,
        ],
      },
    }
  }

  async function handleSparkNotifyReactionLocal(options: SparkNotifyReactionOptions, identity?: { id?: string, eventId?: string }) {
    const event: WebSocketEventOf<'spark:notify'> = {
      type: 'spark:notify',
      source: options.source ?? 'plugin-module-host',
      data: {
        id: identity?.id ?? nanoid(),
        eventId: identity?.eventId ?? nanoid(),
        lane: options.lane,
        kind: options.kind ?? 'ping',
        urgency: options.urgency ?? 'immediate',
        headline: options.headline,
        note: options.note,
        payload: options.payload,
        ttlMs: options.ttlMs,
        requiresAck: options.requiresAck,
        destinations: options.destinations?.length ? options.destinations : ['character'],
        metadata: options.metadata,
      },
    }

    try {
      return await characterOrchestratorStore.handleSparkNotifyWithReaction(event, {
        fallbackText: options.fallbackResponseText,
        forceResponse: options.forceResponse,
        forceTextResponse: options.forceTextResponse,
        forceSparkCommandResponse: options.forceSparkCommandResponse,
        messageOverride: options.messageOverride,
      })
    }
    catch (error) {
      console.warn('[context-bridge] spark:notify handling failed; using fallback', error)
      return options.fallbackResponseText
    }
  }

  function setSparkNotifyHostRole(role: 'main' | 'client') {
    sparkNotifyHostRole.value = role
  }

  async function dispatchSparkNotifyReaction(options: SparkNotifyReactionOptions) {
    if (sparkNotifyHostRole.value === 'main') {
      return await handleSparkNotifyReactionLocal(options)
    }

    const requestId = nanoid()
    return await new Promise<string>((resolve) => {
      const timeout = setTimeout(() => {
        sparkNotifyBridgeWaiters.delete(requestId)
        resolve(options.fallbackResponseText)
      }, 5000)

      sparkNotifyBridgeWaiters.set(requestId, {
        resolve: ({ reaction }) => {
          clearTimeout(timeout)
          resolve(reaction || options.fallbackResponseText)
        },
        timeout,
      })

      postSparkNotifyBridgeMessage({
        type: 'request',
        requestId,
        fromInstanceId: sparkNotifyBridgeInstanceId,
        payload: options,
      })
    })
  }

  async function handleSparkNotifyPerformanceLocal(options: SparkNotifyReactionOptions): Promise<SparkNotifyPerformanceResult> {
    const calls = options.calls ?? []

    if (calls.length === 0) {
      const reaction = await handleSparkNotifyReactionLocal(options)
      return {
        type: 'completed',
        reaction,
      }
    }

    const sparkNotifyId = nanoid()
    const turn = streamingControl.beginTurn({ turnId: `spark:${sparkNotifyId}` })

    let latestReaction = ''
    let reactionPromise: Promise<string> | undefined
    let dispose: (() => void) | undefined

    const calledPromise = new Promise<SparkNotifyPerformanceResult>((resolve) => {
      const disposers = calls.map(call => turn.on(call.manifest, async (payload) => {
        await call.handler(payload)
        const reaction = await (reactionPromise ?? Promise.resolve(latestReaction || options.fallbackResponseText))
        resolve({
          type: 'called',
          name: call.manifest.name,
          payload,
          reaction,
        })
      }))
      dispose = () => {
        for (const item of disposers) {
          item()
        }
      }
    })

    reactionPromise = handleSparkNotifyReactionLocal(withStreamingCallPrompt(
      options,
      turn.renderManifestPrompt(),
    ), { id: sparkNotifyId })
      .then((reaction) => {
        latestReaction = reaction
        return reaction
      })
      .catch(() => {
        latestReaction = options.fallbackResponseText
        return options.fallbackResponseText
      })

    const turnDonePromise = turn.done.then(async (result): Promise<SparkNotifyPerformanceResult> => {
      const reaction = await (reactionPromise ?? Promise.resolve(latestReaction || options.fallbackResponseText))
      return {
        type: result.type === 'cancelled' ? 'cancelled' : 'completed',
        reaction: reaction || options.fallbackResponseText,
      }
    })

    const result = await Promise.race([calledPromise, turnDonePromise])
    dispose?.()
    return result
  }

  async function dispatchSparkNotifyPerformance(options: SparkNotifyReactionOptions): Promise<SparkNotifyPerformanceResult> {
    const calls = options.calls ?? []

    if (sparkNotifyHostRole.value === 'main') {
      return await handleSparkNotifyPerformanceLocal(options)
    }

    if (calls.length === 0) {
      const reaction = await dispatchSparkNotifyReaction(options)
      return {
        type: 'completed',
        reaction,
      }
    }

    const requestId = nanoid()
    return await new Promise<SparkNotifyPerformanceResult>((resolve) => {
      const timeout = setTimeout(() => {
        sparkNotifyBridgeWaiters.delete(requestId)
        resolve(createFallbackPerformanceResult(options, 'timeout'))
      }, Math.max(1, options.timeoutMs ?? 5000))

      sparkNotifyBridgeWaiters.set(requestId, {
        resolve: async ({ reaction, performance }) => {
          clearTimeout(timeout)
          if (performance?.type === 'called' && performance.name) {
            await findPerformanceCall(options, performance.name)?.handler(performance.payload)
          }

          resolve(performance ?? createFallbackPerformanceResult(options, 'completed', reaction))
        },
        timeout,
      })

      const { calls: _calls, timeoutMs: _timeoutMs, ...payload } = options
      postSparkNotifyBridgeMessage({
        type: 'request',
        requestId,
        fromInstanceId: sparkNotifyBridgeInstanceId,
        payload,
        performance: {
          callManifests: calls.map(call => call.manifest),
          timeoutMs: options.timeoutMs,
        },
      })
    })
  }

  function createFallbackPerformanceResult(
    options: SparkNotifyReactionOptions,
    type: Extract<SparkNotifyPerformanceResult['type'], 'completed' | 'timeout'>,
    reaction?: string,
  ): SparkNotifyPerformanceResult {
    return {
      type,
      reaction: reaction || options.fallbackResponseText,
    }
  }

  function findPerformanceCall(options: SparkNotifyReactionOptions, name: string) {
    return options.calls?.find(call => call.manifest.name === name)
  }

  function withContextBridgeLock<T>(key: string, callback: () => Promise<T>) {
    if (typeof navigator !== 'undefined' && 'locks' in navigator && typeof navigator.locks.request === 'function') {
      return navigator.locks.request(key, callback)
    }
    return callback()
  }

  function roomReplyRoute(sourceInstanceId: string | undefined) {
    if (!sourceInstanceId)
      return undefined
    return {
      destinations: [{ type: 'instance' as const, instances: [sourceInstanceId] }],
    }
  }

  function sendRoomAck(sourceInstanceId: string | undefined, data: LumiRoomAckEvent) {
    const route = roomReplyRoute(sourceInstanceId)
    if (!route)
      return
    serverChannelStore.send({ type: 'lumi:room:ack', data, route })
  }

  function sendRoomSync(sourceInstanceId: string | undefined, data: LumiRoomSyncEvent) {
    const route = roomReplyRoute(sourceInstanceId)
    if (!route)
      return
    serverChannelStore.send({ type: 'lumi:room:sync', data, route })
  }

  function sendRoomAccessRevoked(sourceInstanceId: string | undefined, conversationId: string, reason: string) {
    const route = roomReplyRoute(sourceInstanceId)
    if (!route)
      return
    serverChannelStore.send({
      type: 'lumi:room:access-revoked',
      data: { conversationId, reason, revokedAt: Date.now() },
      route,
    })
  }

  async function rejectReliableRoomInput(
    event: WebSocketEventOf<'input:text'> | WebSocketEventOf<'input:voice'>,
    reason: string,
    options?: { revokeAccess?: boolean },
  ) {
    const delivery = event.data.room
    const conversationId = event.data.overrides?.sessionId ?? event.metadata?.auth?.claims?.conversationId
    if (!delivery || !conversationId)
      return

    const latestSequence = (await lumiRoomLedgerRepo.get(conversationId)).latestSequence
    sendRoomAck(event.metadata?.source?.id, {
      conversationId,
      messageId: delivery.messageId,
      idempotencyKey: delivery.idempotencyKey,
      status: 'rejected',
      latestSequence,
      reason,
      acknowledgedAt: Date.now(),
    })
    if (options?.revokeAccess)
      sendRoomAccessRevoked(event.metadata?.source?.id, conversationId, reason)
  }

  function roomOutputRoute(context: ChatStreamEventContext) {
    if (context.input?.type === 'input:text' && context.input.data.perception)
      return roomReplyRoute(context.input.metadata?.source?.id)
    if (!context.input?.data.room)
      return undefined
    return roomReplyRoute(context.input.metadata?.source?.id)
  }

  function sendExternalPerceptionFailure(
    sourceInstanceId: string | undefined,
    eventId: string,
    code: 'invalid_event' | 'vision_unavailable' | 'hearing_unavailable' | 'generation_failed',
    message: string,
  ) {
    const route = roomReplyRoute(sourceInstanceId)
    if (!route)
      return
    serverChannelStore.send({
      type: 'lumi:external:perception:failed',
      data: { eventId, code, message },
      route,
    })
  }

  async function buildExternalPerception(
    perception: NonNullable<WebSocketEventOf<'input:text'>['data']['perception']>,
    userText: string,
  ) {
    if (!perception.eventId.trim() || !perception.segments.length || perception.segments.length > 32)
      throw new Error('External perception event is invalid')

    const ordered: Array<Record<string, unknown>> = []
    const displayTextSegments: string[] = []
    const agentTextSegments: string[] = []
    const attachments: Array<{ type: 'image', data: string, mimeType: string }> = []
    for (const segment of perception.segments) {
      if (segment.type === 'text') {
        if (!segment.text.trim())
          continue
        ordered.push({ type: 'text', text: segment.text, metadata: segment.metadata ?? {} })
        displayTextSegments.push(segment.text)
        agentTextSegments.push(`[用户文字]\n${segment.text}`)
        continue
      }

      const maximum = segment.type === 'image' ? 10 * 1024 * 1024 : 25 * 1024 * 1024
      const bytes = decodeExternalMedia(segment.dataBase64, segment.sizeBytes, maximum)
      if (segment.type === 'image') {
        if (!segment.mimeType.toLowerCase().startsWith('image/'))
          throw new Error('External image media type is invalid')
        let result: Awaited<ReturnType<typeof lumiEyes.analyzeAttachmentsForChat>>
        try {
          result = await lumiEyes.analyzeAttachmentsForChat({
            attachments: [{
              type: 'image',
              data: segment.dataBase64,
              mimeType: segment.mimeType,
            }],
            userMessage: userText,
            publishContext: false,
          })
          if (!result.results.length)
            throw new Error(result.errors[0] || 'Lumi vision returned no result')
        }
        catch (error) {
          throw new ExternalPerceptionProcessingError(
            'vision_unavailable',
            errorMessageFrom(error) ?? 'Lumi vision could not process the image.',
            { cause: error },
          )
        }
        attachments.push({
          type: 'image',
          data: segment.dataBase64,
          mimeType: segment.mimeType,
        })
        ordered.push({
          type: 'visual_perception',
          perception: result.results[0],
          metadata: segment.metadata ?? {},
        })
        const visualText = result.contextText?.trim() || JSON.stringify(result.results[0])
        agentTextSegments.push(`[Lumi 视觉感知]\n${visualText}`)
        continue
      }

      if (!segment.mimeType.toLowerCase().startsWith('audio/')
        && !['video/webm', 'video/mp4', 'application/ogg'].includes(segment.mimeType.toLowerCase())) {
        throw new Error('External audio media type is invalid')
      }
      let transcript = ''
      try {
        const result = await hearingSpeechInputPipeline.transcribeForRecording(
          new Blob([bytes], { type: segment.mimeType }),
          { throwOnError: true },
        )
        if (!result?.trim())
          throw new Error('Lumi hearing returned no transcription')
        transcript = result.trim()
      }
      catch (error) {
        throw new ExternalPerceptionProcessingError(
          'hearing_unavailable',
          errorMessageFrom(error) ?? 'Lumi hearing could not process the audio.',
          { cause: error },
        )
      }
      displayTextSegments.push(transcript.trim())
      agentTextSegments.push(`[Lumi 听觉感知]\n${transcript.trim()}`)
      ordered.push({
        type: 'auditory_perception',
        transcript: transcript.trim(),
        duration_ms: segment.durationMs,
        metadata: segment.metadata ?? {},
      })
    }

    if (!ordered.length)
      throw new Error('External perception event has no usable segments')
    return {
      attachments,
      displayText: displayTextSegments.join('\n').trim(),
      agentUserText: [
        '[Lumi 当前轮统一感知]',
        ...agentTextSegments,
        '[/Lumi 当前轮统一感知]',
      ].join('\n'),
      providerContext: [
        '[Lumi trusted ordered perception]',
        JSON.stringify(ordered),
        '[/Lumi trusted ordered perception]',
      ].join('\n'),
    }
  }

  function isCredentialBoundRoomActor(
    event: WebSocketEventOf<'input:text'> | WebSocketEventOf<'input:voice'> | WebSocketEventOf<'lumi:room:sync:request'> | WebSocketEventOf<'lumi:room:voice:cancel'>,
  ) {
    const actor = event.data.actor
    const auth = event.metadata?.auth
    const conversationId = event.type === 'input:text' || event.type === 'input:voice'
      ? event.data.overrides?.sessionId
      : event.data.conversationId
    if (!actor)
      return false
    return Boolean(
      auth
      && (auth.scopes.includes('*') || auth.scopes.includes('lumi:chat'))
      && auth.claims?.provider === actor.provider
      && auth.claims?.providerInstanceId === actor.providerInstanceId
      && auth.claims?.externalUserId === actor.externalUserId
      && auth.claims?.conversationId === conversationId,
    )
  }

  function toolScopesFor(event: WebSocketEventOf<'input:text'> | WebSocketEventOf<'input:voice'>): ChatInteractionContext['toolScopes'] {
    const scopes = event.metadata?.auth?.scopes
    if (!scopes)
      return undefined
    return scopes.includes('*') ? ['*'] : scopes.filter(scope => scope.startsWith('lumi:tool:'))
  }

  function roomVoiceJobKey(conversationId: string, idempotencyKey: string) {
    return `${conversationId}:${idempotencyKey}`
  }

  async function fingerprintRoomVoice(audio: ArrayBuffer) {
    const digest = await crypto.subtle.digest('SHA-256', audio)
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  }

  async function withContextBridgeExclusiveLock<T>(key: string, callback: () => Promise<T>) {
    if (typeof navigator !== 'undefined' && 'locks' in navigator && typeof navigator.locks.request === 'function') {
      // BroadcastChannel delivers the same bridge request to every Stage window.
      // `ifAvailable` makes non-owning windows skip instead of queueing and replaying
      // the same spark reaction after the first window finishes.
      return await navigator.locks.request(key, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          return undefined
        }
        return await callback()
      })
    }

    return await callback()
  }

  async function initialize() {
    await mutex.acquire()

    try {
      if (initialized)
        return

      const registerConsumers = () => {
        for (const consumerEvent of consumerRegistrationEvents) {
          serverChannelStore.send({
            type: 'module:consumer:register',
            data: {
              event: consumerEvent,
              mode: 'consumer-group',
              group: 'chat-ingestion',
            },
          })
        }
      }

      await serverChannelStore.ensureConnected()

      registerConsumers()
      disposeHookFns.value.push(serverChannelStore.onReconnected(() => registerConsumers()))

      let isProcessingRemoteStream = false

      const { stop } = watch(incomingContext, (event) => {
        if (!event)
          return

        contextObservability.recordLifecycle({
          phase: 'broadcast-received',
          channel: 'broadcast',
          sourceKey: getEventSourceKey(event),
          strategy: event.strategy,
          lane: event.lane,
          contextId: event.contextId,
          eventId: event.id,
          textPreview: event.text,
          sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id,
          details: event,
        })
        const ingestAttempt = ingestContextMessageSafely({
          channel: 'broadcast',
          contextMessage: event,
          sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id,
          details: event,
        })
        if (ingestAttempt.ok && ingestAttempt.result) {
          contextObservability.recordLifecycle({
            phase: 'store-ingested',
            channel: 'broadcast',
            sourceKey: ingestAttempt.result.sourceKey,
            strategy: event.strategy,
            lane: event.lane,
            contextId: event.contextId,
            eventId: event.id,
            mutation: ingestAttempt.result.mutation,
            textPreview: event.text,
            sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id,
            details: {
              entryCount: ingestAttempt.result.entryCount,
              event,
            },
          })
        }
      })
      disposeHookFns.value.push(stop)

      const { stop: stopSparkNotifyBridgeWatch } = watch(incomingSparkNotifyBridgeMessage, async (event) => {
        if (!event) {
          return
        }

        if (event.type === 'request') {
          if (sparkNotifyHostRole.value !== 'main' || event.fromInstanceId === sparkNotifyBridgeInstanceId) {
            return
          }

          await withContextBridgeExclusiveLock(`context-bridge:spark-notify:${event.requestId}`, async () => {
            const performance = event.performance?.callManifests.length
              ? await handleSparkNotifyPerformanceLocal({
                  ...event.payload,
                  calls: event.performance.callManifests.map(manifest => ({
                    manifest,
                    handler: async () => undefined,
                  })),
                  timeoutMs: event.performance.timeoutMs,
                })
              : undefined
            const reaction = performance?.reaction ?? await handleSparkNotifyReactionLocal(event.payload)
            postSparkNotifyBridgeMessage({
              type: 'response',
              requestId: event.requestId,
              toInstanceId: event.fromInstanceId,
              reaction,
              ...(performance ? { performance } : {}),
            })
          })
          return
        }

        if (event.type === 'response') {
          if (event.toInstanceId !== sparkNotifyBridgeInstanceId) {
            return
          }

          const waiter = sparkNotifyBridgeWaiters.get(event.requestId)
          if (!waiter) {
            return
          }

          sparkNotifyBridgeWaiters.delete(event.requestId)
          await waiter.resolve({
            reaction: event.reaction,
            performance: event.performance,
          })
        }
      })
      disposeHookFns.value.push(stopSparkNotifyBridgeWatch)

      disposeHookFns.value.push(serverChannelStore.onContextUpdate((event) => {
        contextObservability.recordLifecycle({
          phase: 'server-received',
          channel: 'server',
          sourceKey: getEventSourceKey(event),
          strategy: event.data.strategy,
          lane: event.data.lane,
          contextId: event.data.contextId,
          eventId: event.data.id,
          textPreview: event.data.text,
          sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id ?? event.source,
          details: event,
        })
        const contextMessage: ContextMessage = {
          ...event.data,
          metadata: event.metadata,
          createdAt: Date.now(),
        }
        const ingestAttempt = ingestContextMessageSafely({
          channel: 'server',
          contextMessage,
          sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id ?? event.source,
          details: event,
        })
        if (!ingestAttempt.ok)
          return

        if (ingestAttempt.result) {
          contextObservability.recordLifecycle({
            phase: 'store-ingested',
            channel: 'server',
            sourceKey: ingestAttempt.result.sourceKey,
            strategy: contextMessage.strategy,
            lane: contextMessage.lane,
            contextId: contextMessage.contextId,
            eventId: contextMessage.id,
            mutation: ingestAttempt.result.mutation,
            textPreview: contextMessage.text,
            sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id ?? event.source,
            details: {
              entryCount: ingestAttempt.result.entryCount,
              event,
            },
          })
        }
        broadcastContext(toRaw(contextMessage))
        contextObservability.recordLifecycle({
          phase: 'broadcast-posted',
          channel: 'broadcast',
          sourceKey: getEventSourceKey(contextMessage),
          strategy: contextMessage.strategy,
          lane: contextMessage.lane,
          contextId: contextMessage.contextId,
          eventId: contextMessage.id,
          textPreview: contextMessage.text,
          sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id ?? event.source,
          details: contextMessage,
        })
      }))

      disposeHookFns.value.push(serverChannelStore.onEvent('lumi:room:sync:request', async (event) => {
        const sourceInstanceId = event.metadata?.source?.id
        if (!isCredentialBoundRoomActor(event)) {
          console.warn('[context-bridge] rejected room sync whose actor claim is not bound to its device credential')
          return
        }
        const actor = lumiIdentityStore.resolveExternalIdentity(event.data.actor)
        if (!actor) {
          console.warn('[context-bridge] rejected room sync from an unknown or inactive external Lumi identity')
          sendRoomAccessRevoked(sourceInstanceId, event.data.conversationId, 'This device identity is no longer active.')
          return
        }

        try {
          const conversationId = await chatSession.ensureSessionForActor(actor.id, event.data.conversationId)
          chatSession.getInteractionContextForActor(conversationId, actor.id)
          await withContextBridgeLock(`lumi-room-ledger:${conversationId}`, async () => {
            const replay = await lumiRoomLedgerRepo.replay(conversationId, event.data.afterSequence)
            sendRoomSync(sourceInstanceId, replay)
          })
        }
        catch (error) {
          const reason = errorMessageFrom(error) ?? 'This user is no longer a participant in the Lumi room.'
          console.warn('[context-bridge] rejected unauthorized Lumi room sync:', reason)
          sendRoomAccessRevoked(sourceInstanceId, event.data.conversationId, reason)
        }
      }))

      disposeHookFns.value.push(serverChannelStore.onEvent('lumi:room:voice:cancel', async (event) => {
        const sourceInstanceId = event.metadata?.source?.id
        const { conversationId, idempotencyKey, messageId } = event.data
        if (!isCredentialBoundRoomActor(event)) {
          console.warn('[context-bridge] rejected voice cancellation whose actor claim is not bound to its device credential')
          return
        }

        const actor = lumiIdentityStore.resolveExternalIdentity(event.data.actor)
        if (!actor) {
          sendRoomAccessRevoked(sourceInstanceId, conversationId, 'This device identity is no longer active.')
          return
        }

        try {
          await chatSession.ensureSessionForActor(actor.id, conversationId)
          activeRoomVoiceJobs.get(roomVoiceJobKey(conversationId, idempotencyKey))?.abort(
            new DOMException('Room voice input was cancelled.', 'AbortError'),
          )
          const receipt = await withContextBridgeLock(`lumi-room-ledger:${conversationId}`, async () => {
            return await lumiRoomLedgerRepo.cancelInput(conversationId, idempotencyKey, 'Voice input was cancelled by its sender.')
          })
          const snapshot = await lumiRoomLedgerRepo.get(conversationId)
          sendRoomAck(sourceInstanceId, {
            conversationId,
            messageId,
            idempotencyKey,
            status: receipt?.status === 'cancelled' ? 'cancelled' : receipt?.status === 'completed' ? 'completed' : 'accepted',
            inputSequence: receipt?.inputSequence,
            outputSequence: receipt?.assistantSequence,
            latestSequence: snapshot.latestSequence,
            reason: receipt?.failureReason,
            acknowledgedAt: Date.now(),
          })
        }
        catch (error) {
          const reason = errorMessageFrom(error) ?? 'This user is no longer a participant in the Lumi room.'
          sendRoomAccessRevoked(sourceInstanceId, conversationId, reason)
        }
      }))

      disposeHookFns.value.push(serverChannelStore.onEvent('input:voice', async (event) => {
        const { actor: actorClaim, audio, mimeType, overrides, room: roomDelivery } = event.data
        const sourceInstanceId = event.metadata?.source?.id
        const conversationId = overrides?.sessionId
        if (!roomDelivery || !conversationId || !actorClaim) {
          console.warn('[context-bridge] ignored input:voice without reliable room metadata')
          return
        }
        if (!activeProvider.value || !activeModel.value) {
          await rejectReliableRoomInput(event, 'Lumi has no active consciousness model configured.')
          return
        }
        if (!isCredentialBoundRoomActor(event)) {
          await rejectReliableRoomInput(event, 'The device actor does not match its credential binding.')
          return
        }

        const actor = lumiIdentityStore.resolveExternalIdentity(actorClaim)
        if (!actor) {
          await rejectReliableRoomInput(event, 'This device identity is no longer active.', { revokeAccess: true })
          return
        }

        let targetSessionId: string
        let interaction: ChatInteractionContext
        let chatProvider: ChatProvider
        try {
          targetSessionId = await chatSession.ensureSessionForActor(actor.id, conversationId)
          interaction = {
            ...chatSession.getInteractionContextForActor(targetSessionId, actor.id),
            platform: actorClaim.provider,
            toolScopes: toolScopesFor(event),
            remoteDeviceId: event.metadata?.auth?.claims?.externalUserId,
          }
          chatProvider = await providersStore.getProviderInstance<ChatProvider>(activeProvider.value)
        }
        catch (error) {
          const reason = errorMessageFrom(error) ?? 'Lumi could not authorize or initialize this voice input.'
          await rejectReliableRoomInput(event, reason, { revokeAccess: true })
          return
        }

        const payloadFingerprint = await fingerprintRoomVoice(audio)
        const reservation = await withContextBridgeLock(`lumi-room-ledger:${targetSessionId}`, async () => {
          return await lumiRoomLedgerRepo.reserveVoiceInput({
            conversationId: targetSessionId,
            messageId: roomDelivery.messageId,
            idempotencyKey: roomDelivery.idempotencyKey,
            actorId: interaction.actorId,
            payloadFingerprint,
            createdAt: Date.now(),
          })
        })
        if (reservation.status === 'conflict') {
          sendRoomAck(sourceInstanceId, {
            conversationId: targetSessionId,
            messageId: roomDelivery.messageId,
            idempotencyKey: roomDelivery.idempotencyKey,
            status: 'rejected',
            latestSequence: reservation.latestSequence,
            reason: reservation.reason,
            acknowledgedAt: Date.now(),
          })
          return
        }
        if (reservation.status === 'duplicate') {
          const receipt = reservation.receipt
          sendRoomAck(sourceInstanceId, {
            conversationId: targetSessionId,
            messageId: roomDelivery.messageId,
            idempotencyKey: roomDelivery.idempotencyKey,
            status: receipt.status === 'accepted' ? 'duplicate' : receipt.status,
            inputSequence: receipt.inputSequence,
            outputSequence: receipt.assistantSequence,
            latestSequence: reservation.latestSequence,
            reason: receipt.failureReason,
            acknowledgedAt: Date.now(),
          })
          return
        }

        sendRoomAck(sourceInstanceId, {
          conversationId: targetSessionId,
          messageId: roomDelivery.messageId,
          idempotencyKey: roomDelivery.idempotencyKey,
          status: 'transcribing',
          latestSequence: reservation.latestSequence,
          acknowledgedAt: Date.now(),
        })

        const jobKey = roomVoiceJobKey(targetSessionId, roomDelivery.idempotencyKey)
        const abortController = new AbortController()
        activeRoomVoiceJobs.set(jobKey, abortController)
        try {
          const transcription = await hearingSpeechInputPipeline.transcribeForRecording(
            new Blob([audio], { type: mimeType }),
            { signal: abortController.signal },
          )
          abortController.signal.throwIfAborted()
          if (!transcription?.trim())
            throw new Error('The host transcription provider returned no speech text.')

          const accepted = await withContextBridgeLock(`lumi-room-ledger:${targetSessionId}`, async () => {
            return await lumiRoomLedgerRepo.acceptReservedVoiceInput({
              conversationId: targetSessionId,
              idempotencyKey: roomDelivery.idempotencyKey,
              actorDisplayName: interaction.actorDisplayName,
              content: transcription,
              createdAt: Date.now(),
            })
          })
          sendRoomAck(sourceInstanceId, {
            conversationId: targetSessionId,
            messageId: roomDelivery.messageId,
            idempotencyKey: roomDelivery.idempotencyKey,
            status: accepted.status,
            inputSequence: accepted.event.sequence,
            latestSequence: accepted.latestSequence,
            acknowledgedAt: Date.now(),
          })
          if (accepted.status === 'duplicate')
            return

          await withContextBridgeLock(`context-bridge:event:input:text:${targetSessionId}`, async () => {
            await chatOrchestrator.ingest(transcription, {
              model: activeModel.value,
              chatProvider,
              input: {
                type: 'input:text:voice',
                data: {
                  transcription,
                  actor: actorClaim,
                  room: roomDelivery,
                  overrides: { ...overrides, sessionId: targetSessionId },
                },
                metadata: event.metadata,
              },
              interaction,
            }, targetSessionId)
          })
        }
        catch (error) {
          const reason = abortController.signal.aborted
            ? 'Voice input was cancelled by its sender.'
            : errorMessageFrom(error) ?? 'Voice transcription failed.'
          const receipt = await withContextBridgeLock(`lumi-room-ledger:${targetSessionId}`, async () => {
            if (abortController.signal.aborted)
              return await lumiRoomLedgerRepo.cancelInput(targetSessionId, roomDelivery.idempotencyKey, reason)
            return await lumiRoomLedgerRepo.failInput(targetSessionId, roomDelivery.idempotencyKey, reason)
          })
          sendRoomAck(sourceInstanceId, {
            conversationId: targetSessionId,
            messageId: roomDelivery.messageId,
            idempotencyKey: roomDelivery.idempotencyKey,
            status: receipt?.status === 'cancelled' ? 'cancelled' : 'failed',
            inputSequence: receipt?.inputSequence,
            latestSequence: (await lumiRoomLedgerRepo.get(targetSessionId)).latestSequence,
            reason: receipt?.failureReason ?? reason,
            acknowledgedAt: Date.now(),
          })
        }
        finally {
          activeRoomVoiceJobs.delete(jobKey)
        }
      }))

      disposeHookFns.value.push(serverChannelStore.onEvent('input:text', async (event) => {
        const {
          text,
          textRaw,
          overrides,
          contextUpdates,
          room: roomDelivery,
        } = event.data
        const sourceInstanceId = event.metadata?.source?.id

        if (event.data.perception && (!activeProvider.value || !activeModel.value)) {
          sendExternalPerceptionFailure(
            sourceInstanceId,
            event.data.perception.eventId,
            'generation_failed',
            'Lumi has no active local consciousness model configured.',
          )
          return
        }

        if (roomDelivery && (!activeProvider.value || !activeModel.value)) {
          await rejectReliableRoomInput(event, 'Lumi has no active consciousness model configured.')
          return
        }

        const normalizedContextUpdates = contextUpdates?.map((update) => {
          const id = update.id ?? nanoid()
          const contextId = update.contextId ?? id
          return {
            ...update,
            id,
            contextId,
          }
        })
        const acceptedContextUpdates: typeof normalizedContextUpdates = normalizedContextUpdates ? [] : undefined

        if (normalizedContextUpdates?.length) {
          const createdAt = Date.now()
          for (const update of normalizedContextUpdates) {
            contextObservability.recordLifecycle({
              phase: 'input-context-update',
              channel: 'input',
              strategy: update.strategy,
              lane: update.lane,
              contextId: update.contextId,
              eventId: update.id,
              textPreview: update.text,
              sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id ?? event.source,
              details: {
                inputType: event.type,
                update,
              },
            })
            const contextMessage: ContextMessage = {
              ...update,
              metadata: event.metadata,
              createdAt,
            }
            const ingestAttempt = ingestContextMessageSafely({
              channel: 'input',
              contextMessage,
              sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id ?? event.source,
              details: {
                inputType: event.type,
                update: contextMessage,
              },
            })
            if (!ingestAttempt.ok)
              continue

            acceptedContextUpdates?.push(update)

            if (ingestAttempt.result) {
              contextObservability.recordLifecycle({
                phase: 'store-ingested',
                channel: 'input',
                sourceKey: ingestAttempt.result.sourceKey,
                strategy: contextMessage.strategy,
                lane: contextMessage.lane,
                contextId: contextMessage.contextId,
                eventId: contextMessage.id,
                mutation: ingestAttempt.result.mutation,
                textPreview: contextMessage.text,
                sourceLabel: event.metadata?.source?.plugin?.id ?? event.metadata?.source?.id ?? event.source,
                details: {
                  entryCount: ingestAttempt.result.entryCount,
                  inputType: event.type,
                  update: contextMessage,
                },
              })
            }
          }
        }

        if (activeProvider.value && activeModel.value) {
          let chatProvider: ChatProvider
          try {
            chatProvider = await providersStore.getProviderInstance<ChatProvider>(activeProvider.value)
          }
          catch (err) {
            console.error('[context-bridge] getProviderInstance failed for provider:', activeProvider.value, err)
            if (event.data.perception) {
              sendExternalPerceptionFailure(
                sourceInstanceId,
                event.data.perception.eventId,
                'generation_failed',
                errorMessageFrom(err) ?? 'Lumi could not initialize the active local model provider.',
              )
            }
            if (roomDelivery)
              await rejectReliableRoomInput(event, errorMessageFrom(err) ?? 'Lumi could not initialize the active model provider.')
            return
          }

          let messageText = text
          let externalPerception: Awaited<ReturnType<typeof buildExternalPerception>> | undefined
          let targetSessionId = overrides?.sessionId
          let interaction: ChatInteractionContext | undefined

          if (event.data.perception) {
            try {
              externalPerception = await buildExternalPerception(event.data.perception, text)
              messageText = externalPerception.displayText
            }
            catch (error) {
              const reason = errorMessageFrom(error) ?? 'Lumi could not process the external perception event.'
              sendExternalPerceptionFailure(
                sourceInstanceId,
                event.data.perception.eventId,
                error instanceof ExternalPerceptionProcessingError
                  ? error.code
                  : 'invalid_event',
                reason,
              )
              return
            }
          }

          if (roomDelivery && !event.data.actor) {
            console.warn('[context-bridge] rejected reliable room input without an external actor claim')
            await rejectReliableRoomInput(event, 'Reliable Lumi room input requires a device actor identity.')
            return
          }
          if (roomDelivery && !isCredentialBoundRoomActor(event)) {
            console.warn('[context-bridge] rejected reliable room input whose actor claim is not bound to its device credential')
            await rejectReliableRoomInput(event, 'The device actor does not match its credential binding.')
            return
          }

          if (event.data.actor) {
            const actor = lumiIdentityStore.resolveExternalIdentity(event.data.actor)
            if (!actor) {
              console.warn('[context-bridge] rejected input:text from an unknown or inactive external Lumi identity')
              if (roomDelivery)
                await rejectReliableRoomInput(event, 'This device identity is no longer active.', { revokeAccess: true })
              return
            }
            try {
              targetSessionId = await chatSession.ensureSessionForActor(actor.id, targetSessionId)
              interaction = {
                ...chatSession.getInteractionContextForActor(targetSessionId, actor.id),
                platform: event.data.perception?.platform ?? event.data.actor.provider,
                toolScopes: toolScopesFor(event),
                remoteDeviceId: event.metadata?.auth?.claims?.externalUserId,
              }
            }
            catch (error) {
              const reason = errorMessageFrom(error) ?? 'This user is no longer a participant in the Lumi room.'
              console.warn('[context-bridge] rejected input:text for an unauthorized Lumi conversation:', reason)
              if (roomDelivery)
                await rejectReliableRoomInput(event, reason, { revokeAccess: true })
              return
            }
          }

          if (overrides?.messagePrefix) {
            messageText = `${overrides.messagePrefix}${text}`
          }

          // TODO(@nekomeowww): This only guard for input:text events handling and doesn't cover the entire ingestion
          // process. Another critical path of spark:notify is affected too, I think for better future development
          // experience, we should discover and find either a leader election or distributed lock solution to
          // coordinate the modules that handles context bridge ingestion across multiple windows/tabs.
          //
          // Background behind this, as server-sdk is in fact integrated in every Stage Web window/tab, each
          // window/tab has its own connection & chat orchestrator instance, when multiple windows/tabs are open,
          // each of them will receive the same input:text event and process ingestion independently, causing
          // duplicated messages handling and output:* events emission.
          //
          // We don't have ability to control how many windows/tabs the user will open (sometimes) user will forget
          // to close the extra windows/tabs, so we need a way to coordinate the ingestion processing to
          // ensure only one window/tab is handling the ingestion at a time.
          //
          // SharedWorker solution was considered but it's completely disabled in Chromium based Android browsers
          // (which is a big portion of mobile Stage Web users as stage-ui serves as the unified / universal
          // api wrapper for most of the shared logic across Web, Pocket, and Tamagotchi).
          //
          // Read more here:
          // - https://chromestatus.com/feature/6265472244514816
          // - https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker
          // - https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
          await withContextBridgeLock(`context-bridge:event:input:text:${targetSessionId ?? 'active'}`, async () => {
            if (roomDelivery && interaction && targetSessionId) {
              try {
                const accepted = await withContextBridgeLock(`lumi-room-ledger:${targetSessionId}`, async () => {
                  return await lumiRoomLedgerRepo.acceptInput({
                    conversationId: targetSessionId,
                    messageId: roomDelivery.messageId,
                    idempotencyKey: roomDelivery.idempotencyKey,
                    actorId: interaction.actorId,
                    actorDisplayName: interaction.actorDisplayName,
                    content: messageText,
                    createdAt: Date.now(),
                  })
                })
                if (accepted.status === 'conflict') {
                  sendRoomAck(sourceInstanceId, {
                    conversationId: targetSessionId,
                    messageId: roomDelivery.messageId,
                    idempotencyKey: roomDelivery.idempotencyKey,
                    status: 'rejected',
                    latestSequence: accepted.latestSequence,
                    reason: accepted.reason,
                    acknowledgedAt: Date.now(),
                  })
                  return
                }

                sendRoomAck(sourceInstanceId, {
                  conversationId: targetSessionId,
                  messageId: roomDelivery.messageId,
                  idempotencyKey: roomDelivery.idempotencyKey,
                  status: accepted.status,
                  inputSequence: accepted.event.sequence,
                  outputSequence: accepted.receipt.assistantSequence,
                  latestSequence: accepted.latestSequence,
                  reason: accepted.receipt.failureReason,
                  acknowledgedAt: Date.now(),
                })
                if (accepted.status === 'duplicate')
                  return
              }
              catch (error) {
                console.warn('[context-bridge] rejected invalid reliable Lumi room input:', errorMessageFrom(error))
                await rejectReliableRoomInput(event, errorMessageFrom(error) ?? 'The reliable Lumi room input is invalid.')
                return
              }
            }

            try {
              await chatOrchestrator.ingest(messageText, {
                model: activeModel.value,
                chatProvider,
                attachments: externalPerception?.attachments,
                providerUserContext: externalPerception?.providerContext,
                agentUserText: externalPerception?.agentUserText,
                sendAttachmentsToProvider: externalPerception ? false : undefined,
                input: {
                  type: 'input:text',
                  data: {
                    ...event.data,
                    text,
                    textRaw,
                    overrides: {
                      ...overrides,
                      ...(targetSessionId ? { sessionId: targetSessionId } : {}),
                    },
                    contextUpdates: acceptedContextUpdates,
                  },
                  metadata: event.metadata,
                },
                interaction,
                ...(event.data.perception
                  ? {
                      onAgentToolProgress: (progress) => {
                        const route = roomReplyRoute(sourceInstanceId)
                        if (!route)
                          return
                        serverChannelStore.send({
                          type: 'lumi:external:agent-progress',
                          route,
                          data: {
                            eventId: event.data.perception!.eventId,
                            ...progress,
                          },
                        })
                      },
                    }
                  : {}),
              }, targetSessionId)
            }
            catch (err) {
              console.error('Error ingesting text input via context bridge:', err)
              if (event.data.perception) {
                sendExternalPerceptionFailure(
                  sourceInstanceId,
                  event.data.perception.eventId,
                  'generation_failed',
                  errorMessageFrom(err) ?? 'Lumi local generation failed.',
                )
              }
              if (roomDelivery && targetSessionId) {
                const receipt = await withContextBridgeLock(`lumi-room-ledger:${targetSessionId}`, async () => {
                  return await lumiRoomLedgerRepo.failInput(
                    targetSessionId,
                    roomDelivery.idempotencyKey,
                    errorMessageFrom(err) ?? 'Chat ingestion failed.',
                  )
                })
                sendRoomAck(sourceInstanceId, {
                  conversationId: targetSessionId,
                  messageId: roomDelivery.messageId,
                  idempotencyKey: roomDelivery.idempotencyKey,
                  status: 'failed',
                  inputSequence: receipt?.inputSequence,
                  latestSequence: (await lumiRoomLedgerRepo.get(targetSessionId)).latestSequence,
                  reason: receipt?.failureReason,
                  acknowledgedAt: Date.now(),
                })
              }
            }
          })
        }
      }))

      disposeHookFns.value.push(serverChannelStore.onEvent('lumi:external:runtime:status:request', (event) => {
        const route = roomReplyRoute(event.metadata?.source?.id)
        if (!route)
          return
        const consciousness = Boolean(activeProvider.value && activeModel.value)
        serverChannelStore.send({
          type: 'lumi:external:runtime:status',
          data: {
            requestId: event.data.requestId,
            available: consciousness,
            consciousness,
            vision: visionConfigured.value,
            hearing: hearingConfigured.value,
            ...(!consciousness
              ? { detail: 'Lumi local consciousness is not ready. Select and save an active provider and model.' }
              : {}),
          },
          route,
        })
      }))

      disposeHookFns.value.push(serverChannelStore.onEvent('lumi:external:assistant-sticker', (event) => {
        const data = event.data
        if (!data.conversationId || !data.dataBase64)
          return
        if (!['image/gif', 'image/jpeg', 'image/png', 'image/webp'].includes(data.mimeType))
          return
        try {
          const bytes = atob(data.dataBase64)
          if (!bytes.length || bytes.length > 10 * 1024 * 1024)
            return
        }
        catch {
          return
        }
        const messages = chatSession.getSessionMessages(data.conversationId)
        const messageId = `${data.eventId}:sticker:${data.stickerId}`
        if (messages.some(message => message.id === messageId))
          return
        chatSession.appendSessionMessage(data.conversationId, {
          id: messageId,
          role: 'assistant',
          content: '',
          slices: [{
            type: 'image',
            url: `data:${data.mimeType};base64,${data.dataBase64}`,
            alt: data.tags.length ? `Lumi 表情：${data.tags.join('、')}` : 'Lumi 表情',
          }],
          tool_results: [],
          createdAt: Date.now(),
        })
      }))

      disposeHookFns.value.push(serverChannelStore.onEvent('lumi:external:group-observation:request', async (event) => {
        const route = roomReplyRoute(event.metadata?.source?.id)
        if (!route)
          return
        try {
          const data = event.data
          if (data.authorVerified !== true || data.isLumi !== false || data.sourceKind !== 'human_message')
            throw new Error('Group observation author or source is not trusted')
          const text = data.text.trim()
          if (!text || text.length > 4_000)
            throw new Error('Group observation text is empty or too long')
          const result = await chatOrchestrator.observeExternalGroupLanguage({
            eventId: data.eventId,
            messageId: data.messageId,
            sourceId: data.sourceId,
            platform: data.platform,
            platformInstanceId: data.platformInstanceId,
            groupId: data.groupId,
            senderId: data.senderId,
            senderName: data.senderName,
            text,
            timestamp: data.timestamp,
          }, data.batchSize, data.historyLimit, data.concurrentGroups)
          serverChannelStore.send({
            type: 'lumi:external:group-observation:result',
            data: { requestId: data.requestId, ok: true, ...result },
            route,
          })
        }
        catch (error) {
          serverChannelStore.send({
            type: 'lumi:external:group-observation:result',
            data: {
              requestId: event.data.requestId,
              ok: false,
              queued: false,
              batchProcessed: false,
              message: errorMessageFrom(error) ?? 'Group observation failed',
            },
            route,
          })
        }
      }))

      disposeHookFns.value.push(serverChannelStore.onEvent('lumi:external:group-observation:resume', (event) => {
        chatOrchestrator.resumeExternalGroupLanguageDrain(
          event.data.batchSize,
          event.data.concurrentGroups,
        )
      }))

      disposeHookFns.value.push(serverChannelStore.onEvent('lumi:external:sticker-intelligence:request', async (event) => {
        const route = roomReplyRoute(event.metadata?.source?.id)
        if (!route)
          return
        try {
          const result = await chatOrchestrator.runExternalStickerIntelligence(
            event.data.operation,
            event.data.payload,
          )
          serverChannelStore.send({
            type: 'lumi:external:sticker-intelligence:result',
            data: {
              requestId: event.data.requestId,
              ok: true,
              ...result,
            },
            route,
          })
        }
        catch (error) {
          serverChannelStore.send({
            type: 'lumi:external:sticker-intelligence:result',
            data: {
              requestId: event.data.requestId,
              ok: false,
              message: errorMessageFrom(error) ?? 'Sticker consciousness task failed',
            },
            route,
          })
        }
      }))

      disposeHookFns.value.push(serverChannelStore.onEvent('lumi:external:speech:request', async (event) => {
        const route = roomReplyRoute(event.metadata?.source?.id)
        if (!route)
          return
        const requestId = event.data.requestId
        try {
          const text = event.data.text.trim()
          if (!text || text.length > 20_000)
            throw new Error('Speech text is empty or too long')
          const providerId = activeSpeechProvider.value
          if (!providerId || providerId === 'speech-noop')
            throw new Error('Lumi speech is not configured')
          const providerConfig = providersStore.getProviderConfig(providerId)
          const model = activeSpeechModel.value || String(providerConfig?.model || '')
          if (!model)
            throw new Error('Lumi speech model is not configured')
          const provider = await providersStore.getProviderInstance(providerId) as SpeechProviderWithExtraOptions
          const usesConfiguredVoice = speechStore.usesProviderConfiguredVoice(providerId, model)
          const voice = usesConfiguredVoice
            ? providerId === 'alibaba-cloud-model-studio'
              ? String(providerConfig?.customVoiceId || '')
              : ''
            : activeSpeechVoice.value?.id
              || activeSpeechVoiceId.value
              || String(providerConfig?.voice || providerConfig?.voiceId || '')
          if (!usesConfiguredVoice && !voice)
            throw new Error('Lumi speech voice is not configured')
          const input = ssmlEnabled.value && activeSpeechVoice.value
            ? speechStore.generateSSML(text, activeSpeechVoice.value, providerConfig)
            : text
          const audio = await speechStore.speech(provider, model, input, voice, providerConfig)
          if (!audio.byteLength)
            throw new Error('Lumi speech returned empty audio')
          serverChannelStore.send({
            type: 'lumi:external:speech:result',
            data: {
              requestId,
              ok: true,
              dataBase64: arrayBufferToBase64(audio),
              mimeType: detectSpeechMime(audio),
            },
            route,
          })
        }
        catch (error) {
          serverChannelStore.send({
            type: 'lumi:external:speech:result',
            data: {
              requestId,
              ok: false,
              message: errorMessageFrom(error) ?? 'Lumi speech synthesis failed',
            },
            route,
          })
        }
      }))

      disposeHookFns.value.push(
        chatOrchestrator.onBeforeMessageComposed(async (message, context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'before-compose', message, sessionId: chatSession.activeSessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),
        chatOrchestrator.onAfterMessageComposed(async (message, context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'after-compose', message, sessionId: chatSession.activeSessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),
        chatOrchestrator.onBeforeSend(async (message, context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'before-send', message, sessionId: chatSession.activeSessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),
        chatOrchestrator.onAfterSend(async (message, context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'after-send', message, sessionId: chatSession.activeSessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),
        chatOrchestrator.onTokenLiteral(async (literal, context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'token-literal', literal, sessionId: chatSession.activeSessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),
        chatOrchestrator.onTokenSpecial(async (special, context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'token-special', special, sessionId: chatSession.activeSessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),
        chatOrchestrator.onStreamEnd(async (context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'stream-end', sessionId: chatSession.activeSessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),
        chatOrchestrator.onAssistantResponseEnd(async (message, context) => {
          if (isProcessingRemoteStream)
            return

          broadcastStreamEvent({ type: 'assistant-end', message, sessionId: chatSession.activeSessionId, context: structuredClone(normalizeContextSnapshot(context)) })
        }),

        chatOrchestrator.onAssistantMessage(async (message, _messageText, context) => {
          const outputText = stripInternalLumiOutput(_messageText)
          if (!outputText)
            return
          serverChannelStore.send({
            type: 'output:gen-ai:chat:message',
            route: roomOutputRoute(context),
            data: {
              ...context.input?.data,
              'message': {
                ...message,
                content: outputText,
              },
              'stage-web': isStageWeb(),
              'stage-tamagotchi': isStageTamagotchi(),
              'gen-ai:chat': {
                message: context.message as UserMessage,
                composedMessage: context.composedMessage,
                contexts: context.contexts,
                input: context.input,
              },
            },
          })
        }),

        chatOrchestrator.onChatTurnComplete(async (chat, context) => {
          const outputText = stripInternalLumiOutput(chat.outputText)
          if (!outputText)
            return
          const roomDelivery = context.input?.data.room
          const conversationId = context.input?.data.overrides?.sessionId
          const sourceInstanceId = context.input?.metadata?.source?.id
          if (roomDelivery && conversationId) {
            try {
              const completed = await withContextBridgeLock(`lumi-room-ledger:${conversationId}`, async () => {
                return await lumiRoomLedgerRepo.completeInput({
                  conversationId,
                  idempotencyKey: roomDelivery.idempotencyKey,
                  messageId: chat.output.id ?? `${roomDelivery.messageId}:assistant`,
                  actorId: chat.output.actorId ?? 'lumi',
                  actorDisplayName: chat.output.actorDisplayName ?? 'Lumi',
                  content: outputText,
                  createdAt: chat.output.createdAt ?? Date.now(),
                })
              })
              sendRoomAck(sourceInstanceId, {
                conversationId,
                messageId: roomDelivery.messageId,
                idempotencyKey: roomDelivery.idempotencyKey,
                status: 'completed',
                inputSequence: completed.receipt.inputSequence,
                outputSequence: completed.event.sequence,
                latestSequence: completed.latestSequence,
                acknowledgedAt: Date.now(),
              })
            }
            catch (error) {
              console.error('[context-bridge] failed to finalize Lumi room delivery:', error)
            }
          }

          serverChannelStore.send({
            type: 'output:gen-ai:chat:complete',
            route: roomOutputRoute(context),
            data: {
              ...context.input?.data,
              'message': {
                ...chat.output,
                content: outputText,
              },
              'outputText': outputText,
              // TODO: tool calls should be captured properly
              'toolCalls': [],
              'stage-web': isStageWeb(),
              'stage-tamagotchi': isStageTamagotchi(),
              // TODO: Properly calculate usage data
              'usage': {
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                source: 'estimate-based',
              },
              'gen-ai:chat': {
                message: context.message as UserMessage,
                composedMessage: context.composedMessage,
                contexts: context.contexts,
                input: context.input,
              },
            },
          })
        }),
      )

      const { stop: stopIncomingStreamWatch } = watch(incomingStreamEvent, async (event) => {
        if (!event)
          return

        isProcessingRemoteStream = true

        try {
          // Use the receiver's active session to avoid clobbering chat state when events come from other windows/devtools.
          switch (event.type) {
            case 'before-compose':
              await chatOrchestrator.emitBeforeMessageComposedHooks(event.message, event.context)
              break
            case 'after-compose':
              await chatOrchestrator.emitAfterMessageComposedHooks(event.message, event.context)
              break
            case 'before-send':
              await chatOrchestrator.emitBeforeSendHooks(event.message, event.context)
              remoteStreamGuard = {
                sessionId: chatSession.activeSessionId,
                generation: chatSession.getSessionGenerationValue(chatSession.activeSessionId),
              }
              chatOrchestrator.sending = true
              chatStream.beginStream()
              break
            case 'after-send':
              await chatOrchestrator.emitAfterSendHooks(event.message, event.context)
              break
            case 'token-literal':
              if (!remoteStreamGuard)
                return
              if (remoteStreamGuard.sessionId !== chatSession.activeSessionId)
                return
              if (chatSession.getSessionGenerationValue(remoteStreamGuard.sessionId) !== remoteStreamGuard.generation)
                return
              chatStream.appendStreamLiteral(event.literal)
              await chatOrchestrator.emitTokenLiteralHooks(event.literal, event.context)
              break
            case 'token-special':
              await chatOrchestrator.emitTokenSpecialHooks(event.special, event.context)
              break
            case 'stream-end':
              if (!remoteStreamGuard)
                break
              if (remoteStreamGuard.sessionId !== chatSession.activeSessionId)
                break
              if (chatSession.getSessionGenerationValue(remoteStreamGuard.sessionId) !== remoteStreamGuard.generation)
                break
              await chatOrchestrator.emitStreamEndHooks(event.context)
              // NOTICE: Remote stream events are mirrored across renderer windows for UI feedback only.
              // Persisting them here would append assistant messages into the receiver's local session
              // without the corresponding user message, corrupting IndexedDB history across windows.
              chatStream.resetStream()
              chatOrchestrator.sending = false
              remoteStreamGuard = null
              break
            case 'assistant-end':
              if (!remoteStreamGuard)
                break
              if (remoteStreamGuard.sessionId !== chatSession.activeSessionId)
                break
              if (chatSession.getSessionGenerationValue(remoteStreamGuard.sessionId) !== remoteStreamGuard.generation)
                break
              await chatOrchestrator.emitAssistantResponseEndHooks(event.message, event.context)
              // NOTICE: The originating renderer already persists the final assistant message.
              // Receiver windows must not write it again, or they can overwrite the same session
              // with assistant-only history when their local session state is stale.
              chatStream.resetStream()
              chatOrchestrator.sending = false
              remoteStreamGuard = null
              break
          }
        }
        finally {
          isProcessingRemoteStream = false
        }
      })
      disposeHookFns.value.push(stopIncomingStreamWatch)
      initialized = true
    }
    finally {
      mutex.release()
    }
  }

  async function dispose() {
    await mutex.acquire()

    try {
      if (!initialized)
        return

      for (const consumerEvent of consumerRegistrationEvents) {
        serverChannelStore.send({
          type: 'module:consumer:unregister',
          data: {
            event: consumerEvent,
            mode: 'consumer-group',
            group: 'chat-ingestion',
          },
        })
      }

      for (const fn of disposeHookFns.value) {
        fn()
      }

      initialized = false
      remoteStreamGuard = null

      for (const [requestId, waiter] of sparkNotifyBridgeWaiters) {
        if (waiter.timeout)
          clearTimeout(waiter.timeout)
        sparkNotifyBridgeWaiters.delete(requestId)
      }
    }
    finally {
      mutex.release()
    }

    disposeHookFns.value = []
  }

  return {
    initialize,
    dispose,
    dispatchSparkNotifyReaction,
    dispatchSparkNotifyPerformance,
    setSparkNotifyHostRole,
  }
})
