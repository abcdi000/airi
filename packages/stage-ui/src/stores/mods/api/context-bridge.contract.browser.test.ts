import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

import { CHAT_STREAM_CHANNEL_NAME, CONTEXT_CHANNEL_NAME } from '../../chat/constants'

type HookCallback = (...args: unknown[]) => Promise<void> | void
type UseContextBridgeStore = typeof import('./context-bridge')['useContextBridgeStore']

const contextUpdateHooks: HookCallback[] = []
const serverEventHooks = new Map<string, HookCallback[]>()

const chatContextIngestMock = vi.fn()
const beginStreamMock = vi.fn()
const appendStreamLiteralMock = vi.fn()
const finalizeStreamMock = vi.fn()
const resetStreamMock = vi.fn()
const serverSendMock = vi.fn()
const ensureConnectedMock = vi.fn().mockResolvedValue(undefined)
const onReconnectedMock = vi.fn(() => () => {})
const onContextUpdateMock = vi.fn((callback: HookCallback) => registerHook(contextUpdateHooks, callback))
const onEventMock = vi.fn((eventName: string, callback: HookCallback) => registerServerEventHook(eventName, callback))
const getProviderInstanceMock = vi.fn()
const getProviderConfigMock = vi.fn(() => ({}))
const recordLifecycleMock = vi.fn()
const ensureSessionForActorMock = vi.fn()
const getInteractionContextForActorMock = vi.fn()
const resolveExternalIdentityMock = vi.fn()
const transcribeForRecordingMock = vi.fn()
const analyzeAttachmentsForChatMock = vi.fn()

const activeProviderRef = ref<string | null>(null)
const activeModelRef = ref<string | null>(null)
const hearingConfiguredRef = ref(false)
const visionConfiguredRef = ref(false)
const activeSpeechProviderRef = ref('speech-noop')
const activeSpeechModelRef = ref('')
const activeSpeechVoiceRef = ref<{ id: string } | undefined>(undefined)
const activeSpeechVoiceIdRef = ref('')
const ssmlEnabledRef = ref(false)
const synthesizeSpeechMock = vi.fn()

const beforeComposeHooks: HookCallback[] = []
const afterComposeHooks: HookCallback[] = []
const beforeSendHooks: HookCallback[] = []
const afterSendHooks: HookCallback[] = []
const tokenLiteralHooks: HookCallback[] = []
const tokenSpecialHooks: HookCallback[] = []
const streamEndHooks: HookCallback[] = []
const assistantEndHooks: HookCallback[] = []
const assistantMessageHooks: HookCallback[] = []
const turnCompleteHooks: HookCallback[] = []

const activeSessionIdRef = ref('session-1')
let currentGeneration = 7
const testChannels: BroadcastChannel[] = []
let useContextBridgeStore: UseContextBridgeStore

function registerHook(target: HookCallback[], callback: HookCallback) {
  target.push(callback)
  return () => {
    const index = target.indexOf(callback)
    if (index >= 0)
      target.splice(index, 1)
  }
}

function registerServerEventHook(eventName: string, callback: HookCallback) {
  const hooks = serverEventHooks.get(eventName) ?? []
  serverEventHooks.set(eventName, hooks)
  return registerHook(hooks, callback)
}

function createTestChannel(name: string) {
  const channel = new BroadcastChannel(name)
  testChannels.push(channel)
  return channel
}

function collectChannelMessages<T>(name: string) {
  const messages: T[] = []
  const channel = createTestChannel(name)
  channel.addEventListener('message', (event) => {
    messages.push((event as MessageEvent<T>).data)
  })
  return messages
}

function closeTestChannels() {
  for (const channel of testChannels) {
    channel.close()
  }
  testChannels.length = 0
}

async function waitForBroadcastDelivery() {
  await new Promise(resolve => setTimeout(resolve, 50))
}

async function emitHooks(target: HookCallback[], ...args: unknown[]) {
  for (const callback of target) {
    await callback(...args)
  }
}

async function emitContextUpdate(event: unknown) {
  await emitHooks(contextUpdateHooks, event)
}

async function emitServerEvent(eventName: string, event: unknown) {
  await emitHooks(serverEventHooks.get(eventName) ?? [], event)
}

function createMetadata(pluginId: string, instanceId: string) {
  return {
    source: {
      id: instanceId,
      kind: 'plugin',
      plugin: {
        id: pluginId,
      },
    },
  }
}

function createContextMessage(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === 'string' ? overrides.id : 'context-1'

  return {
    id,
    contextId: typeof overrides.contextId === 'string' ? overrides.contextId : id,
    strategy: ContextUpdateStrategy.AppendSelf,
    text: 'context text',
    createdAt: 1,
    ...overrides,
  }
}

function createContextUpdateEvent(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === 'string' ? overrides.id : 'context-1'

  return {
    type: 'context:update',
    source: 'plugin-module-host',
    metadata: createMetadata('weather', 'station-1'),
    data: {
      id,
      contextId: id,
      strategy: ContextUpdateStrategy.AppendSelf,
      text: 'weather changed',
      ...overrides,
    },
  }
}

const chatOrchestratorMock = {
  sending: false,
  ingest: vi.fn(),

  onBeforeMessageComposed: (callback: HookCallback) => registerHook(beforeComposeHooks, callback),
  onAfterMessageComposed: (callback: HookCallback) => registerHook(afterComposeHooks, callback),
  onBeforeSend: (callback: HookCallback) => registerHook(beforeSendHooks, callback),
  onAfterSend: (callback: HookCallback) => registerHook(afterSendHooks, callback),
  onTokenLiteral: (callback: HookCallback) => registerHook(tokenLiteralHooks, callback),
  onTokenSpecial: (callback: HookCallback) => registerHook(tokenSpecialHooks, callback),
  onStreamEnd: (callback: HookCallback) => registerHook(streamEndHooks, callback),
  onAssistantResponseEnd: (callback: HookCallback) => registerHook(assistantEndHooks, callback),
  onAssistantMessage: (callback: HookCallback) => registerHook(assistantMessageHooks, callback),
  onChatTurnComplete: (callback: HookCallback) => registerHook(turnCompleteHooks, callback),

  emitBeforeMessageComposedHooks: (...args: unknown[]) => emitHooks(beforeComposeHooks, ...args),
  emitAfterMessageComposedHooks: (...args: unknown[]) => emitHooks(afterComposeHooks, ...args),
  emitBeforeSendHooks: (...args: unknown[]) => emitHooks(beforeSendHooks, ...args),
  emitAfterSendHooks: (...args: unknown[]) => emitHooks(afterSendHooks, ...args),
  emitTokenLiteralHooks: (...args: unknown[]) => emitHooks(tokenLiteralHooks, ...args),
  emitTokenSpecialHooks: (...args: unknown[]) => emitHooks(tokenSpecialHooks, ...args),
  emitStreamEndHooks: (...args: unknown[]) => emitHooks(streamEndHooks, ...args),
  emitAssistantResponseEndHooks: (...args: unknown[]) => emitHooks(assistantEndHooks, ...args),
}

vi.mock('pinia', async () => {
  const actual = await vi.importActual<typeof import('pinia')>('pinia')
  return {
    ...actual,
    storeToRefs: (store: unknown) => store,
  }
})

vi.mock('@proj-airi/stage-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@proj-airi/stage-shared')>()
  return {
    ...actual,
    isStageWeb: () => true,
    isStageTamagotchi: () => false,
  }
})

vi.mock('es-toolkit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('es-toolkit')>()
  return {
    ...actual,
    Mutex: class {
      async acquire() {}
      release() {}
    },
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../../character', () => ({
  useCharacterOrchestratorStore: () => ({
    handleSparkNotifyWithReaction: vi.fn(async (_event: unknown, options: { fallbackText: string }) => options.fallbackText),
  }),
}))

vi.mock('../../chat', () => ({
  useChatOrchestratorStore: () => chatOrchestratorMock,
}))

vi.mock('../../chat/context-store', () => ({
  useChatContextStore: () => ({
    ingestContextMessage: chatContextIngestMock,
  }),
}))

vi.mock('../../chat/session-store', () => ({
  useChatSessionStore: () => ({
    get activeSessionId() {
      return activeSessionIdRef.value
    },
    ensureSessionForActor: ensureSessionForActorMock,
    getInteractionContextForActor: getInteractionContextForActorMock,
    getSessionGenerationValue: () => currentGeneration,
  }),
}))

vi.mock('../../chat/stream-store', () => ({
  useChatStreamStore: () => ({
    beginStream: beginStreamMock,
    appendStreamLiteral: appendStreamLiteralMock,
    finalizeStream: finalizeStreamMock,
    resetStream: resetStreamMock,
  }),
}))

vi.mock('../../devtools/context-observability', () => ({
  useContextObservabilityStore: () => ({
    recordLifecycle: recordLifecycleMock,
  }),
}))

vi.mock('../../modules/consciousness', () => ({
  useConsciousnessStore: () => ({
    activeProvider: activeProviderRef,
    activeModel: activeModelRef,
  }),
}))

vi.mock('../../modules/hearing', () => ({
  useHearingStore: () => ({
    configured: hearingConfiguredRef,
  }),
  useHearingSpeechInputPipeline: () => ({
    transcribeForRecording: transcribeForRecordingMock,
  }),
}))

vi.mock('../../modules/speech', () => ({
  useSpeechStore: () => ({
    activeSpeechProvider: activeSpeechProviderRef,
    activeSpeechModel: activeSpeechModelRef,
    activeSpeechVoice: activeSpeechVoiceRef,
    activeSpeechVoiceId: activeSpeechVoiceIdRef,
    ssmlEnabled: ssmlEnabledRef,
    generateSSML: vi.fn((text: string) => text),
    speech: synthesizeSpeechMock,
    usesProviderConfiguredVoice: vi.fn(() => false),
  }),
}))

vi.mock('../../modules/vision', () => ({
  useVisionStore: () => ({
    configured: visionConfiguredRef,
  }),
}))

vi.mock('../../lumi-eyes', () => ({
  useLumiEyesStore: () => ({
    analyzeAttachmentsForChat: analyzeAttachmentsForChatMock,
  }),
}))

vi.mock('../../lumi-identity', () => ({
  useLumiIdentityStore: () => ({
    resolveExternalIdentity: resolveExternalIdentityMock,
  }),
}))

vi.mock('../../providers', () => ({
  useProvidersStore: () => ({
    configuredSpeechProvidersMetadata: [],
    getProviderConfig: getProviderConfigMock,
    getProviderInstance: getProviderInstanceMock,
    getProviderMetadata: vi.fn(() => ({
      capabilities: {},
    })),
    providerRuntimeState: {},
  }),
}))

vi.mock('./channel-server', () => ({
  useModsServerChannelStore: () => ({
    ensureConnected: ensureConnectedMock,
    onReconnected: onReconnectedMock,
    onContextUpdate: onContextUpdateMock,
    onEvent: onEventMock,
    send: serverSendMock,
  }),
}))

describe('context bridge contract', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    ;({ useContextBridgeStore } = await import('./context-bridge'))

    chatContextIngestMock.mockReset()
    beginStreamMock.mockReset()
    appendStreamLiteralMock.mockReset()
    finalizeStreamMock.mockReset()
    resetStreamMock.mockReset()
    serverSendMock.mockReset()
    ensureConnectedMock.mockClear()
    ensureConnectedMock.mockResolvedValue(undefined)
    onReconnectedMock.mockClear()
    onContextUpdateMock.mockClear()
    onEventMock.mockClear()
    getProviderInstanceMock.mockReset()
    getProviderConfigMock.mockReset()
    getProviderConfigMock.mockReturnValue({})
    recordLifecycleMock.mockReset()
    ensureSessionForActorMock.mockReset()
    getInteractionContextForActorMock.mockReset()
    resolveExternalIdentityMock.mockReset()
    transcribeForRecordingMock.mockReset()
    analyzeAttachmentsForChatMock.mockReset()
    chatOrchestratorMock.ingest.mockReset()

    activeProviderRef.value = null
    activeModelRef.value = null
    hearingConfiguredRef.value = false
    visionConfiguredRef.value = false
    activeSpeechProviderRef.value = 'speech-noop'
    activeSpeechModelRef.value = ''
    activeSpeechVoiceRef.value = undefined
    activeSpeechVoiceIdRef.value = ''
    ssmlEnabledRef.value = false
    synthesizeSpeechMock.mockReset()
    activeSessionIdRef.value = 'session-1'
    currentGeneration = 7
    chatOrchestratorMock.sending = false

    beforeComposeHooks.length = 0
    afterComposeHooks.length = 0
    beforeSendHooks.length = 0
    afterSendHooks.length = 0
    tokenLiteralHooks.length = 0
    tokenSpecialHooks.length = 0
    streamEndHooks.length = 0
    assistantEndHooks.length = 0
    assistantMessageHooks.length = 0
    turnCompleteHooks.length = 0
    contextUpdateHooks.length = 0
    serverEventHooks.clear()
  })

  afterEach(() => {
    closeTestChannels()
  })

  /**
   * @example
   * The local integration receives renderer-owned readiness rather than a port-only health result.
   */
  it('reports local Lumi runtime readiness to the requesting integration', async () => {
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    hearingConfiguredRef.value = true
    visionConfiguredRef.value = true
    const store = useContextBridgeStore()
    await store.initialize()

    await emitServerEvent('lumi:external:runtime:status:request', {
      type: 'lumi:external:runtime:status:request',
      source: 'plugin-module-host',
      metadata: createMetadata('astrbot', 'local-gateway'),
      data: {
        requestId: 'runtime-status-1',
      },
    })

    expect(serverSendMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'lumi:external:runtime:status',
      data: {
        requestId: 'runtime-status-1',
        available: true,
        consciousness: true,
        vision: true,
        hearing: true,
      },
      route: expect.any(Object),
    }))

    await store.dispose()
  })

  /**
   * @example
   * The local integration gets an actionable not-ready reason before submitting a turn.
   */
  it('reports an unavailable local consciousness before its provider is restored', async () => {
    const store = useContextBridgeStore()
    await store.initialize()

    await emitServerEvent('lumi:external:runtime:status:request', {
      type: 'lumi:external:runtime:status:request',
      source: 'plugin-module-host',
      metadata: createMetadata('astrbot', 'local-gateway'),
      data: {
        requestId: 'runtime-status-2',
      },
    })

    expect(serverSendMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'lumi:external:runtime:status',
      data: expect.objectContaining({
        requestId: 'runtime-status-2',
        available: false,
        consciousness: false,
        detail: expect.stringContaining('not ready'),
      }),
    }))

    await store.dispose()
  })

  /**
   * @example
   * AstrBot receives one complete audio payload synthesized with the desktop speech selection.
   */
  it('synthesizes a complete external reply with the configured speech module', async () => {
    activeSpeechProviderRef.value = 'mock-speech'
    activeSpeechModelRef.value = 'mock-tts'
    activeSpeechVoiceRef.value = { id: 'lumi-voice' }
    activeSpeechVoiceIdRef.value = 'lumi-voice'
    getProviderInstanceMock.mockResolvedValue({})
    synthesizeSpeechMock.mockResolvedValue(
      new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]).buffer,
    )
    const store = useContextBridgeStore()
    await store.initialize()

    await emitServerEvent('lumi:external:speech:request', {
      type: 'lumi:external:speech:request',
      source: 'plugin-module-host',
      metadata: createMetadata('astrbot', 'local-gateway'),
      data: {
        requestId: 'speech-1',
        text: '完整的一条回复',
      },
    })

    expect(synthesizeSpeechMock).toHaveBeenCalledWith(
      {},
      'mock-tts',
      '完整的一条回复',
      'lumi-voice',
      {},
    )
    expect(serverSendMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'lumi:external:speech:result',
      data: expect.objectContaining({
        requestId: 'speech-1',
        ok: true,
        mimeType: 'audio/wav',
      }),
    }))

    await store.dispose()
  })

  /**
   * @example
   * Broadcast context updates record store-ingested with core result fields.
   */
  it('records core ingest result for broadcast context updates', async () => {
    chatContextIngestMock.mockReturnValueOnce({
      sourceKey: 'weather:station-1',
      mutation: 'append',
      entryCount: 2,
    })
    const store = useContextBridgeStore()
    await store.initialize()
    const contextSender = createTestChannel(CONTEXT_CHANNEL_NAME)

    contextSender.postMessage(createContextMessage({
      id: 'broadcast-context',
      metadata: createMetadata('weather', 'station-1'),
      text: 'broadcast weather',
    }))

    await vi.waitFor(() => {
      expect(chatContextIngestMock).toHaveBeenCalledTimes(1)
    })
    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'store-ingested',
      channel: 'broadcast',
      sourceKey: 'weather:station-1',
      mutation: 'append',
      details: expect.objectContaining({
        entryCount: 2,
      }),
    }))

    await store.dispose()
  })

  /**
   * @example
   * Server context updates record store-ingested before broadcast-posted.
   */
  it('records core ingest result for server context updates before broadcasting', async () => {
    chatContextIngestMock.mockReturnValueOnce({
      sourceKey: 'weather:station-1',
      mutation: 'replace',
      entryCount: 1,
    })
    const store = useContextBridgeStore()
    await store.initialize()

    await emitContextUpdate(createContextUpdateEvent({
      id: 'server-context',
      strategy: ContextUpdateStrategy.ReplaceSelf,
      text: 'server weather',
    }))

    expect(chatContextIngestMock).toHaveBeenCalledTimes(1)
    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'store-ingested',
      channel: 'server',
      sourceKey: 'weather:station-1',
      mutation: 'replace',
      details: expect.objectContaining({
        entryCount: 1,
      }),
    }))
    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'broadcast-posted',
      channel: 'broadcast',
      contextId: 'server-context',
    }))

    await store.dispose()
  })

  /**
   * @example
   * Input context updates record store-ingested and stay in chat input payload.
   */
  it('records core ingest result for input context updates and forwards accepted updates', async () => {
    chatContextIngestMock.mockReturnValueOnce({
      sourceKey: 'weather:station-1',
      mutation: 'append',
      entryCount: 1,
    })
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    getProviderInstanceMock.mockResolvedValueOnce({})
    const store = useContextBridgeStore()
    await store.initialize()

    await emitServerEvent('input:text', {
      type: 'input:text',
      source: 'plugin-module-host',
      metadata: createMetadata('weather', 'station-1'),
      data: {
        text: 'hello',
        contextUpdates: [
          {
            strategy: ContextUpdateStrategy.AppendSelf,
            text: 'input weather',
          },
        ],
      },
    })

    expect(chatContextIngestMock).toHaveBeenCalledTimes(1)
    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'store-ingested',
      channel: 'input',
      sourceKey: 'weather:station-1',
      mutation: 'append',
      details: expect.objectContaining({
        entryCount: 1,
        inputType: 'input:text',
      }),
    }))
    expect(chatOrchestratorMock.ingest).toHaveBeenCalledTimes(1)
    expect(chatOrchestratorMock.ingest.mock.calls[0]?.[1]?.input?.data.contextUpdates).toEqual([
      expect.objectContaining({
        contextId: expect.any(String),
        id: expect.any(String),
        text: 'input weather',
      }),
    ])

    await store.dispose()
  })

  /**
   * @example
   * AstrBot text, image, and audio segments remain ordered while using local Lumi senses.
   */
  it('processes external perception through local vision and hearing before one consciousness turn', async () => {
    // ROOT CAUSE:
    //
    // The server-only bridge could accept media, but the desktop runtime had no path that reused
    // the renderer-owned Lumi Eyes and hearing modules. Sending media directly to consciousness
    // would either lose it or create a second, inconsistent perception implementation.
    //
    // We fixed this by carrying an ordered perception event over Server Channel and resolving each
    // media segment with the existing local senses before making exactly one orchestrator call.
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    getProviderInstanceMock.mockResolvedValue({})
    resolveExternalIdentityMock.mockReturnValue({ id: 'doggy', displayName: 'Doggy' })
    ensureSessionForActorMock.mockResolvedValue('lumi-direct:doggy')
    getInteractionContextForActorMock.mockReturnValue({
      actorId: 'doggy',
      actorDisplayName: 'Doggy',
      conversationId: 'lumi-direct:doggy',
    })
    analyzeAttachmentsForChatMock.mockResolvedValue({
      results: ['画面里是一张游戏截图。'],
      errors: [],
    })
    transcribeForRecordingMock.mockResolvedValue('语音里说：一起玩吧。')
    const store = useContextBridgeStore()
    await store.initialize()

    await emitServerEvent('input:text', {
      type: 'input:text',
      source: 'plugin-module-host',
      metadata: createMetadata('astrbot', 'local-gateway'),
      data: {
        text: '看看这个',
        actor: {
          provider: 'astrbot',
          providerInstanceId: 'qq-main',
          externalUserId: '1770249418',
        },
        perception: {
          eventId: 'astrbot:event-1',
          platform: 'aiocqhttp',
          conversationId: 'qq:private:1770249418',
          senderId: '1770249418',
          senderName: 'Doggy',
          isPrivate: true,
          isGroup: false,
          segments: [
            { type: 'text', text: '先看图片' },
            {
              type: 'image',
              dataBase64: 'iVBORw0KGgo=',
              mimeType: 'image/png',
              sizeBytes: 8,
            },
            { type: 'text', text: '再听语音' },
            {
              type: 'audio',
              dataBase64: 'UklGRg==',
              mimeType: 'audio/wav',
              sizeBytes: 4,
              durationMs: 1_200,
            },
          ],
        },
      },
    })

    expect(analyzeAttachmentsForChatMock).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [{
        type: 'image',
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
      }],
      userMessage: '看看这个',
      publishContext: false,
    }))
    expect(transcribeForRecordingMock).toHaveBeenCalledTimes(1)
    expect(transcribeForRecordingMock).toHaveBeenCalledWith(
      expect.any(Blob),
      { throwOnError: true },
    )
    expect(ensureSessionForActorMock).toHaveBeenCalledWith('doggy', undefined)
    expect(chatOrchestratorMock.ingest).toHaveBeenCalledTimes(1)
    const submittedText = chatOrchestratorMock.ingest.mock.calls[0]?.[0] as string
    const submittedOptions = chatOrchestratorMock.ingest.mock.calls[0]?.[1]
    const providerContext = submittedOptions?.providerUserContext as string
    const agentUserText = submittedOptions?.agentUserText as string
    expect(submittedText).toBe('先看图片\n再听语音\n语音里说：一起玩吧。')
    expect(providerContext.indexOf('"type":"text","text":"先看图片"')).toBeLessThan(
      providerContext.indexOf('"type":"visual_perception"'),
    )
    expect(providerContext.indexOf('"type":"visual_perception"')).toBeLessThan(
      providerContext.indexOf('"type":"text","text":"再听语音"'),
    )
    expect(providerContext.indexOf('"type":"text","text":"再听语音"')).toBeLessThan(
      providerContext.indexOf('"type":"auditory_perception"'),
    )
    expect(agentUserText).toContain('[Lumi 当前轮统一感知]')
    expect(agentUserText).toContain('[Lumi 视觉感知]')
    expect(agentUserText).toContain('[Lumi 听觉感知]')
    expect(agentUserText).not.toContain('undefined')
    expect(agentUserText.indexOf('[用户文字]')).toBeLessThan(agentUserText.indexOf('[Lumi 视觉感知]'))
    expect(agentUserText.indexOf('[Lumi 视觉感知]')).toBeLessThan(agentUserText.indexOf('[Lumi 听觉感知]'))
    expect(chatOrchestratorMock.ingest).toHaveBeenCalledWith(
      submittedText,
      expect.objectContaining({
        attachments: [{
          type: 'image',
          data: 'iVBORw0KGgo=',
          mimeType: 'image/png',
        }],
        interaction: expect.objectContaining({ actorId: 'doggy' }),
        providerUserContext: providerContext,
        agentUserText,
        sendAttachmentsToProvider: false,
      }),
      'lumi-direct:doggy',
    )

    await store.dispose()
  })

  /**
   * @example
   * A pure QQ image remains meaningful to the shared Agent Runtime even when
   * the user-visible text is empty.
   */
  it('projects a pure external image into non-empty Agent Runtime text', async () => {
    // ROOT CAUSE:
    //
    // External vision completed successfully, but only providerUserContext
    // received its result. The shared Agent Runtime consumed displayText,
    // which is empty for an image-only message, so every cognitive stage saw
    // an empty user turn.
    //
    // We fixed this by carrying a separate semantic agentUserText projection.
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    getProviderInstanceMock.mockResolvedValue({})
    resolveExternalIdentityMock.mockReturnValue({ id: 'doggy', displayName: 'Doggy' })
    ensureSessionForActorMock.mockResolvedValue('lumi-direct:doggy')
    getInteractionContextForActorMock.mockReturnValue({
      actorId: 'doggy',
      actorDisplayName: 'Doggy',
      conversationId: 'lumi-direct:doggy',
    })
    analyzeAttachmentsForChatMock.mockResolvedValue({
      results: ['vision-result'],
      errors: [],
      contextText: '[Current-turn image context]\nImage 1: description=two people sharing ice cream',
    })
    const store = useContextBridgeStore()
    await store.initialize()

    await emitServerEvent('input:text', {
      type: 'input:text',
      source: 'plugin-module-host',
      metadata: createMetadata('astrbot', 'local-gateway'),
      data: {
        text: '',
        actor: {
          provider: 'astrbot',
          providerInstanceId: 'qq-main',
          externalUserId: '1770249418',
        },
        perception: {
          eventId: 'astrbot:image-only',
          platform: 'aiocqhttp',
          conversationId: 'qq:private:1770249418',
          senderId: '1770249418',
          senderName: 'Doggy',
          isPrivate: true,
          isGroup: false,
          segments: [{
            type: 'image',
            dataBase64: 'iVBORw0KGgo=',
            mimeType: 'image/png',
            sizeBytes: 8,
          }],
        },
      },
    })

    expect(chatOrchestratorMock.ingest).toHaveBeenCalledTimes(1)
    expect(chatOrchestratorMock.ingest.mock.calls[0]?.[0]).toBe('')
    expect(chatOrchestratorMock.ingest.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      agentUserText: expect.stringContaining('Image 1: description=two people sharing ice cream'),
      sendAttachmentsToProvider: false,
    }))

    await store.dispose()
  })

  /**
   * @example
   * A provider error without hearing-related words is still reported as a hearing failure.
   */
  it('classifies external audio provider failures by processing stage instead of error text', async () => {
    // ROOT CAUSE:
    //
    // The bridge previously inferred the modality from words in the provider error. Errors such as
    // "model is unavailable" therefore became invalid_event even though audio decoding and routing
    // had succeeded, hiding the actionable provider detail from the AstrBot plugin.
    //
    // We fixed this by assigning a typed failure at the hearing boundary and preserving its cause.
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    getProviderInstanceMock.mockResolvedValue({})
    transcribeForRecordingMock.mockRejectedValue(new Error('Model whisper-1 is unavailable for this account'))
    const store = useContextBridgeStore()
    await store.initialize()

    await emitServerEvent('input:text', {
      type: 'input:text',
      source: 'plugin-module-host',
      metadata: createMetadata('astrbot', 'local-gateway'),
      data: {
        text: '',
        perception: {
          eventId: 'astrbot:hearing-provider-error',
          platform: 'aiocqhttp',
          conversationId: 'qq:private:1770249418',
          senderId: '1770249418',
          senderName: 'Doggy',
          isPrivate: true,
          isGroup: false,
          segments: [{
            type: 'audio',
            dataBase64: 'UklGRg==',
            mimeType: 'audio/wav',
            sizeBytes: 4,
          }],
        },
      },
    })

    expect(serverSendMock).toHaveBeenCalledWith({
      type: 'lumi:external:perception:failed',
      data: {
        eventId: 'astrbot:hearing-provider-error',
        code: 'hearing_unavailable',
        message: 'Model whisper-1 is unavailable for this account',
      },
      route: {
        destinations: [{
          type: 'instance',
          instances: ['local-gateway'],
        }],
      },
    })
    expect(chatOrchestratorMock.ingest).not.toHaveBeenCalled()

    await store.dispose()
  })

  /**
   * @example
   * A reconnect that resends the same room voice payload does not transcribe or ingest it twice.
   */
  it('transcribes and ingests one reliable room voice delivery exactly once', async () => {
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    getProviderInstanceMock.mockResolvedValue({})
    resolveExternalIdentityMock.mockReturnValue({ id: 'moussy', displayName: 'Moussy' })
    ensureSessionForActorMock.mockResolvedValue('voice-room-contract')
    getInteractionContextForActorMock.mockReturnValue({
      actorId: 'moussy',
      actorDisplayName: 'Moussy',
      conversationId: 'voice-room-contract',
    })
    transcribeForRecordingMock.mockResolvedValue('Lumi，今天一起玩吗？')
    const store = useContextBridgeStore()
    await store.initialize()

    const audio = new Uint8Array([1, 2, 3, 4]).buffer
    const event = {
      type: 'input:voice',
      source: 'plugin-module-host',
      metadata: {
        ...createMetadata('lumi-pocket', 'moussy-phone'),
        auth: {
          subject: 'device-moussy',
          scopes: ['lumi:chat'],
          claims: {
            provider: 'lumi-lan',
            providerInstanceId: 'home-host',
            externalUserId: 'moussy-device',
            conversationId: 'voice-room-contract',
          },
        },
      },
      data: {
        audio,
        mimeType: 'audio/wav',
        byteLength: audio.byteLength,
        durationMs: 1_000,
        actor: {
          provider: 'lumi-lan',
          providerInstanceId: 'home-host',
          externalUserId: 'moussy-device',
        },
        room: {
          messageId: 'voice-message-contract',
          idempotencyKey: 'voice-delivery-contract',
        },
        overrides: { sessionId: 'voice-room-contract' },
      },
    }

    await emitServerEvent('input:voice', event)
    await emitServerEvent('input:voice', event)

    expect(transcribeForRecordingMock).toHaveBeenCalledTimes(1)
    expect(chatOrchestratorMock.ingest).toHaveBeenCalledTimes(1)
    expect(chatOrchestratorMock.ingest).toHaveBeenCalledWith(
      'Lumi，今天一起玩吗？',
      expect.objectContaining({
        input: expect.objectContaining({ type: 'input:text:voice' }),
        interaction: expect.objectContaining({ actorId: 'moussy' }),
      }),
      'voice-room-contract',
    )
    expect(serverSendMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'lumi:room:ack',
      data: expect.objectContaining({ status: 'duplicate' }),
    }))

    await store.dispose()
  })

  /**
   * @example
   * Broadcast context ingest failures record store-ingest-rejected instead of escaping.
   */
  it('records rejected lifecycle for broadcast ingest failures without interrupting the watcher', async () => {
    chatContextIngestMock.mockImplementationOnce(() => {
      throw new Error('Cannot clone broadcast context')
    })
    const store = useContextBridgeStore()
    await store.initialize()
    const contextSender = createTestChannel(CONTEXT_CHANNEL_NAME)

    contextSender.postMessage(createContextMessage({
      id: 'bad-broadcast-context',
      metadata: createMetadata('weather', 'station-1'),
      text: 'bad broadcast weather',
    }))

    await vi.waitFor(() => {
      expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'store-ingest-rejected',
        channel: 'broadcast',
        contextId: 'bad-broadcast-context',
        details: expect.objectContaining({
          errorMessage: 'Cannot clone broadcast context',
        }),
      }))
    })

    await store.dispose()
  })

  /**
   * @example
   * Server context ingest failures are not rebroadcast.
   */
  it('records rejected lifecycle and skips broadcast when server context ingest fails', async () => {
    chatContextIngestMock.mockImplementationOnce(() => {
      throw new Error('Cannot clone server context')
    })
    const postedContexts = collectChannelMessages(CONTEXT_CHANNEL_NAME)
    const store = useContextBridgeStore()
    await store.initialize()

    await emitContextUpdate(createContextUpdateEvent({
      id: 'bad-server-context',
      text: 'bad server weather',
    }))
    await waitForBroadcastDelivery()

    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'store-ingest-rejected',
      channel: 'server',
      contextId: 'bad-server-context',
      details: expect.objectContaining({
        errorMessage: 'Cannot clone server context',
      }),
    }))
    expect(recordLifecycleMock).not.toHaveBeenCalledWith(expect.objectContaining({
      phase: 'broadcast-posted',
      contextId: 'bad-server-context',
    }))
    expect(postedContexts).toHaveLength(0)

    await store.dispose()
  })

  /**
   * @example
   * Input context ingest failures drop only the failed context update.
   */
  it('records rejected lifecycle and continues text ingestion when input context ingest fails', async () => {
    chatContextIngestMock.mockImplementationOnce(() => {
      throw new Error('Cannot clone input context')
    })
    activeProviderRef.value = 'mock-provider'
    activeModelRef.value = 'mock-model'
    getProviderInstanceMock.mockResolvedValueOnce({})
    const store = useContextBridgeStore()
    await store.initialize()

    await emitServerEvent('input:text', {
      type: 'input:text',
      source: 'plugin-module-host',
      metadata: createMetadata('weather', 'station-1'),
      data: {
        text: 'hello',
        contextUpdates: [
          {
            strategy: ContextUpdateStrategy.AppendSelf,
            text: 'bad input weather',
          },
        ],
      },
    })

    expect(recordLifecycleMock).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'store-ingest-rejected',
      channel: 'input',
      details: expect.objectContaining({
        errorMessage: 'Cannot clone input context',
      }),
    }))
    expect(chatOrchestratorMock.ingest).toHaveBeenCalledTimes(1)
    expect(chatOrchestratorMock.ingest.mock.calls[0]?.[1]?.input?.data.contextUpdates).toEqual([])

    await store.dispose()
  })

  it('replays remote stream lifecycle into sending and stream store APIs', async () => {
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)

    const context = {
      message: { role: 'user', content: 'ping' },
      contexts: {},
      composedMessage: [],
    }

    streamSender.postMessage({ type: 'before-send', message: 'ping', sessionId: 'remote-session', context })
    await vi.waitFor(() => {
      expect(chatOrchestratorMock.sending).toBe(true)
      expect(beginStreamMock).toHaveBeenCalledTimes(1)
    })

    streamSender.postMessage({ type: 'token-literal', literal: 'hello', sessionId: 'remote-session', context })
    await vi.waitFor(() => {
      expect(appendStreamLiteralMock).toHaveBeenCalledWith('hello')
    })

    streamSender.postMessage({ type: 'assistant-end', message: 'final answer', sessionId: 'remote-session', context })
    await vi.waitFor(() => {
      expect(resetStreamMock).toHaveBeenCalledTimes(1)
    })

    // The bridge should call resetStream on follower tabs, not finalizeStream,
    // to avoid corrupting history by persisting a duplicate assistant message.
    expect(finalizeStreamMock).not.toHaveBeenCalled()
    expect(chatOrchestratorMock.sending).toBe(false)

    await store.dispose()
  })

  it('suppresses outbound broadcast while processing remote stream events', async () => {
    const outgoingStreamMessages = collectChannelMessages<{ sessionId: string }>(CHAT_STREAM_CHANNEL_NAME)
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)

    const context = {
      message: { role: 'user', content: 'ping' },
      contexts: {},
      composedMessage: [],
    }

    await chatOrchestratorMock.emitTokenSpecialHooks('manual-special', context)
    await vi.waitFor(() => {
      expect(outgoingStreamMessages).toHaveLength(1)
    })

    streamSender.postMessage({ type: 'token-special', special: 'remote-special', sessionId: 'remote-session', context })
    await waitForBroadcastDelivery()

    expect(outgoingStreamMessages.filter(message => message.sessionId === 'session-1')).toHaveLength(1)

    await store.dispose()
  })

  it('ignores remote literal and end events when generation guard is stale', async () => {
    const store = useContextBridgeStore()
    await store.initialize()
    const streamSender = createTestChannel(CHAT_STREAM_CHANNEL_NAME)

    const context = {
      message: { role: 'user', content: 'ping' },
      contexts: {},
      composedMessage: [],
    }

    streamSender.postMessage({ type: 'before-send', message: 'ping', sessionId: 'remote-session', context })
    await vi.waitFor(() => {
      expect(beginStreamMock).toHaveBeenCalledTimes(1)
    })

    currentGeneration = 8
    streamSender.postMessage({ type: 'token-literal', literal: 'stale-literal', sessionId: 'remote-session', context })
    await waitForBroadcastDelivery()

    streamSender.postMessage({ type: 'stream-end', sessionId: 'remote-session', context })
    await waitForBroadcastDelivery()

    expect(appendStreamLiteralMock).not.toHaveBeenCalledWith('stale-literal')
    expect(finalizeStreamMock).not.toHaveBeenCalled()
    expect(chatOrchestratorMock.sending).toBe(true)

    await store.dispose()
  })
})
