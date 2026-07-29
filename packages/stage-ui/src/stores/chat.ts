import type { ChatOrchestratorRuntimeState, ChatOrchestratorSendOptions, StreamEvent, StreamOptions } from '@proj-airi/core-agent'
import type { CognitiveContextPort } from '@proj-airi/lumi-agent-runtime'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type {
  LumiConversationContextMessage,
  LumiLanguageModelMessage,
  LumiReplyCharacterState,
  SocialLanguageEvidence,
  SocialLanguageGroupObservation,
} from '../../../lumi-runtime/src'
import type { ChatAssistantMessage, ChatHistoryItem, ChatInteractionContext, ChatStreamEventContext } from '../types/chat'
import type { LumiUserProfileEntry, LumiUserProfilePendingUpdate, LumiUserProfileSourceKind } from './lumi-user-profile'

import { errorMessageFrom } from '@moeru/std'
import { createChatOrchestratorRuntime } from '@proj-airi/core-agent'
import { IOAttributes, IOEvents, IOSpanNames, IOSubsystems } from '@proj-airi/stage-shared'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { ref, toRaw, watch } from 'vue'

import {
  analyzeLumiConversationGuard,
  assessLumiRelationshipFallback,
  buildLumiContextualMemoryQuery,
  buildLumiMemoryCuratorPrompt,
  buildLumiMemoryCuratorUserPayload,
  buildLumiMemoryTopicAnalyzerPrompt,
  buildLumiMemoryTopicAnalyzerUserPayload,
  buildLumiPlannerSystemPrompt,
  buildLumiPlannerTurnContext,
  buildLumiRelationshipAssessmentPrompt,
  buildLumiStickerClassificationMessages,
  buildLumiStickerSelectionMessages,
  buildObservedGroupLearningMessages,
  buildSocialLanguageFeedbackMessages,
  buildSocialLanguageLearningMessages,
  canCreateSocialLanguageCandidates,
  compressLumiConversationContext,
  createDefaultLumiPersonaAnchor,
  estimateLumiConversationTokens,
  estimateLumiLanguageTokens,
  flattenLumiVisibleReply,
  isContextDependentMemoryText,
  isLumiQuestionLikeMemorySource,
  mergeLumiRelationshipAssessmentWithSafetyFloor,
  parseLumiMemoryTopicAnalysis,
  parseLumiRelationshipAssessment,
  parseLumiStickerClassification,
  parseLumiStickerSelection,
  parseSocialLanguageFeedbackOutput,
  runLumiSocialLanguagePipeline,
  selectLumiAdaptiveContextBudget,
  selectPlannerSocialBehaviors,
} from '../../../lumi-runtime/src'
import { useAnalytics } from '../composables'
import { startSpan } from '../composables/use-io-tracer'
import { LUMI_AIRI_CARD_ID } from '../constants/lumi-card'
import { extractMessageText, isCloudSyncableMessage, stripInternalLumiOutput } from '../libs/chat-sync'
import { createLumiRemoteToolTransform } from '../libs/lumi-tool-permissions'
import { toStructuredCloneSnapshot } from '../utils/structured-clone'
import { createLumiContext, createMinecraftContext } from './chat/context-providers'
import { useChatContextStore } from './chat/context-store'
import { DesktopLumiAgentHost } from './chat/desktop-agent-runtime'
import { useChatSessionStore } from './chat/session-store'
import { replaySharedRuntimeStageHooks } from './chat/shared-runtime-stage-hooks'
import { useChatStreamStore } from './chat/stream-store'
import { useContextObservabilityStore } from './devtools/context-observability'
import { useLLM } from './llm'
import { useLlmToolsetPromptsStore } from './llm-toolset-prompts'
import { useLumiAgentRuntimeSettingsStore } from './lumi-agent-runtime-settings'
import { useLumiConsciousnessObservabilityStore } from './lumi-consciousness-observability'
import {
  buildLumiCurrentStateUpdatePrompt,
  buildLumiCurrentStateUpdateUserPayload,
  parseLumiCurrentStateUpdateOutput,
  useLumiCurrentStateStore,
} from './lumi-current-state'
import { useLumiEmotionStore } from './lumi-emotion'
import { useLumiIdentityStore } from './lumi-identity'
import { useLumiMainTimelineStore } from './lumi-main-timeline'
import { useLumiMemoryStore } from './lumi-memory'
import { bindLumiMemoryToolsForTurn, clearLumiMemoryTools, registerLumiMemoryTools } from './lumi-memory-tools'
import { useLumiOnlineStore } from './lumi-online'
import { useLumiSocialLanguageStore } from './lumi-social-language'
import { bindLumiToolMeshToolsForTurn } from './lumi-tool-mesh'
import {
  buildLumiUserProfileCuratorPrompt,
  buildLumiUserProfileCuratorUserPayload,
  buildLumiUserProfilePendingAutoReviewPrompt,
  buildLumiUserProfilePendingAutoReviewUserPayload,
  parseLumiUserProfilePendingAutoReviewOutput,
  useLumiUserProfileStore,
} from './lumi-user-profile'
import { useAiriCardStore } from './modules/airi-card'
import { useAutonomousArtistryStore } from './modules/artistry-autonomous'
import { useConsciousnessStore } from './modules/consciousness'
import { useProvidersStore } from './providers'

interface ForkOptions {
  fromSessionId?: string
  atIndex?: number
  reason?: string
  hidden?: boolean
}

type ProviderHistoryMessage = Exclude<ChatHistoryItem, { role: 'error' }>

function toProviderHistory(messages: ChatHistoryItem[]): Message[] {
  return messages.filter((message): message is ProviderHistoryMessage =>
    message.role !== 'error' && !isLumiMemoryDebugMessage(message),
  )
}

function isTextDelta(event: StreamEvent): event is Extract<StreamEvent, { type: 'text-delta' }> {
  return event.type === 'text-delta'
}

export type { QueuedSendSnapshot, ChatOrchestratorSendOptions as SendOptions } from '@proj-airi/core-agent'

export const useChatOrchestratorStore = defineStore('chat-orchestrator', () => {
  const llmStore = useLLM()
  const llmToolsetPromptsStore = useLlmToolsetPromptsStore()
  const consciousnessStore = useConsciousnessStore()
  const artistryAutonomousStore = useAutonomousArtistryStore()
  const providersStore = useProvidersStore()
  const lumiEmotionStore = useLumiEmotionStore()
  const lumiAgentRuntimeSettingsStore = useLumiAgentRuntimeSettingsStore()
  const lumiIdentityStore = useLumiIdentityStore()
  const lumiCurrentStateStore = useLumiCurrentStateStore()
  const lumiConsciousnessObservabilityStore = useLumiConsciousnessObservabilityStore()
  const lumiMemoryStore = useLumiMemoryStore()
  const lumiOnlineStore = useLumiOnlineStore()
  const lumiSocialLanguageStore = useLumiSocialLanguageStore()
  const lumiUserProfileStore = useLumiUserProfileStore()
  const lumiMainTimelineStore = useLumiMainTimelineStore()
  const { activeProvider, activeModel } = storeToRefs(consciousnessStore)
  const {
    trackFirstMessage,
    trackMessageSendStarted,
    trackLlmRequestStarted,
    trackLlmFirstToken,
    trackAssistantResponseRendered,
    trackMessageRound,
  } = useAnalytics()

  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatContext = useChatContextStore()
  const cardStore = useAiriCardStore()
  const contextObservability = useContextObservabilityStore()
  const { activeSessionId } = storeToRefs(chatSession)
  const { streamingMessage } = storeToRefs(chatStream)

  const sending = ref(false)
  const pendingQueuedSendCount = ref(0)
  const desktopLumiAgentHost = new DesktopLumiAgentHost()
  let lumiMemoryToolsRegistered = false
  let activeGroupObservationWorkers = 0
  let groupObservationCommitQueue = Promise.resolve()
  let runtime: ReturnType<typeof createChatOrchestratorRuntime>

  function syncLumiMemoryToolRegistration() {
    const shouldRegister = cardStore.activeCardId === LUMI_AIRI_CARD_ID
    if (shouldRegister && !lumiMemoryToolsRegistered) {
      registerLumiMemoryTools({
        appendDebug: appendLumiMemoryDebug,
      })
      lumiMemoryToolsRegistered = true
      return
    }

    if (!shouldRegister && lumiMemoryToolsRegistered) {
      clearLumiMemoryTools()
      lumiMemoryToolsRegistered = false
    }
  }

  watch(() => cardStore.activeCardId, syncLumiMemoryToolRegistration, { immediate: true })

  async function emitSharedRuntimeAssistantHooks(input: {
    sessionId: string
    sourceText: string
    sentMessageIds: readonly string[]
    transportInput?: ChatStreamEventContext['input']
  }): Promise<void> {
    if (input.sentMessageIds.length === 0)
      return

    const sessionMessages = chatSession.getSessionMessages(input.sessionId)
    const sourceMessage = [...sessionMessages]
      .reverse()
      .find(message => message.role === 'user')
    if (!sourceMessage)
      return
    const transportSourceMessage = toStructuredCloneSnapshot(sourceMessage)
    const transportInput = input.transportInput
      ? toStructuredCloneSnapshot(input.transportInput)
      : undefined

    for (const messageId of input.sentMessageIds) {
      const assistantMessage = sessionMessages.find(message =>
        message.id === messageId && message.role === 'assistant',
      )
      if (!assistantMessage)
        continue

      const messageText = stripInternalLumiOutput(extractMessageText(assistantMessage))
      if (!messageText.trim())
        continue

      // NOTICE:
      // The shared Lumi runtime owns generation but the existing Stage hooks
      // still own local TTS, Live2D motion, and external renderer broadcasts.
      // Replaying the final visible message through that stable boundary keeps
      // device capabilities without coupling the platform-neutral runtime to Vue.
      // This adapter can be removed once Stage consumes DirectOutbound events.
      const createContext = (): ChatStreamEventContext => ({
        message: transportSourceMessage,
        contexts: {},
        composedMessage: [],
        input: transportInput,
      })
      const transportAssistantMessage = toStructuredCloneSnapshot({
        ...assistantMessage,
        content: messageText,
        slices: [{ type: 'text', text: messageText }],
      }) as ChatAssistantMessage
      await replaySharedRuntimeStageHooks({
        hooks: runtime.hooks,
        sourceText: input.sourceText,
        messageText,
        assistantMessage: transportAssistantMessage,
        createContext,
        onError(name, error) {
          // NOTICE:
          // The reply is already committed, so a local integration failure
          // must not suppress transport completion or the remaining hooks.
          // This can be removed after Stage consumes DirectOutbound events.
          console.warn(
            `[lumi-agent-runtime:stage-hooks] ${name} failed; continuing reply delivery:`,
            errorMessageFrom(error) ?? 'Unknown hook error',
          )
        },
      })
    }
  }

  async function streamWithStageAdapters(
    model: string,
    chatProvider: ChatProvider,
    messages: Message[],
    options?: StreamOptions,
  ) {
    let llmTextLength = 0
    const turnSpan = startSpan(IOSpanNames.InteractionTurn)
    const llmSpan = startSpan(IOSpanNames.LLMInference, turnSpan, {
      [IOAttributes.Subsystem]: IOSubsystems.LLM,
      [IOAttributes.GenAIRequestModel]: model,
    })
    const llmRequestTs = performance.now()
    let llmFirstTokenEmitted = false

    try {
      await llmStore.stream(model, chatProvider, messages, {
        ...options,
        onStreamEvent: async (event: StreamEvent) => {
          if (isTextDelta(event)) {
            if (!llmFirstTokenEmitted) {
              llmFirstTokenEmitted = true
              llmSpan.addEvent(IOEvents.LLMFirstToken, {
                [IOAttributes.LLM_TTFT]: performance.now() - llmRequestTs,
              })
            }
            llmTextLength += event.text.length
          }

          await options?.onStreamEvent?.(event)
        },
      })

      llmSpan.setAttribute(IOAttributes.LLMTextLength, llmTextLength)
    }
    finally {
      llmSpan.end()
      turnSpan.end()
    }
  }

  function syncRuntimeState(state: ChatOrchestratorRuntimeState) {
    sending.value = state.sending
    pendingQueuedSendCount.value = state.pendingQueuedSendCount
  }

  runtime = createChatOrchestratorRuntime({
    session: {
      ensureSession: sessionId => chatSession.ensureSession(sessionId),
      getSessionMessages: sessionId => chatSession.getSessionMessages(sessionId).map(message => toRaw(message)),
      appendSessionMessage: (sessionId, message) => chatSession.appendSessionMessage(sessionId, message),
      getSessionGeneration: sessionId => chatSession.getSessionGeneration(sessionId),
    },
    context: {
      ingest: envelope => chatContext.ingestContextMessage(envelope),
      snapshot: () => chatContext.getContextsSnapshot(),
    },
    foregroundStream: {
      patch: (message) => {
        streamingMessage.value = message
      },
      reset: () => {
        streamingMessage.value = { role: 'assistant', content: '', slices: [], tool_results: [] }
      },
    },
    llm: {
      stream: streamWithStageAdapters,
    },
    getActiveSessionId: () => activeSessionId.value,
    getActiveProvider: () => activeProvider.value,
    getSystemPromptSupplement: () => llmToolsetPromptsStore.activeToolsetPrompt,
    runtimeContextProviders: [
      createLumiContext,
      createMinecraftContext,
    ],
    createId: nanoid,
    unwrapMessage: message => toRaw(message),
    onStateChange: syncRuntimeState,
    onTrackFirstMessage: trackFirstMessage,
    onMessageSendStarted: ({ source, model }) => trackMessageSendStarted({
      source,
      model,
    }),
    onLlmRequestStarted: ({ model, provider, hasVoice }) => trackLlmRequestStarted({
      model,
      provider,
      has_voice: hasVoice,
    }),
    onLlmFirstToken: ({ model, ttfbMs }) => trackLlmFirstToken({
      model,
      ttfb_ms: ttfbMs,
    }),
    onAssistantResponseRendered: ({ model, latencyMs }) => trackAssistantResponseRendered({
      model,
      latency_ms: latencyMs,
    }),
    onMessageRound: ({ durationMs, hasVoice, model }) => trackMessageRound({
      duration_ms: durationMs,
      has_voice: hasVoice,
      model,
    }),
    onLifecycle: record => contextObservability.recordLifecycle(record),
    onPromptProjection: payload => contextObservability.capturePromptProjection(payload),
    onUserMessageAppended: ({ sessionId, message, messageText }) => {
      if (isCloudSyncableMessage(message)) {
        void chatSession.pushMessageToCloud(sessionId, {
          id: message.id,
          role: 'user',
          content: messageText,
        })
      }
    },
    onAssistantMessageAppended: ({ sessionId, message }) => {
      if (isCloudSyncableMessage(message) && message.id) {
        void chatSession.pushMessageToCloud(sessionId, {
          id: message.id,
          role: 'assistant',
          content: stripInternalLumiOutput(extractMessageText(message)),
        })
      }
    },
    onUserTurnReady: async (event) => {
      const { messageText, sessionMessages, hasAttachments, interaction } = event
      const feedbackDecision = lumiSocialLanguageStore.pendingFeedbackDecision(
        event.sessionId,
        interaction?.actorId,
      )
      const languageFeedbackTask = (async () => {
        if (!feedbackDecision || !activeProvider.value || !activeModel.value)
          return undefined
        try {
          const chatProvider = await providersStore.getProviderInstance<ChatProvider>(activeProvider.value)
          const modelOutput = await generateSocialLanguageTextWithProvider({
            model: activeModel.value,
            chatProvider,
            messages: buildSocialLanguageFeedbackMessages({
              userText: messageText,
              decision: feedbackDecision,
            }),
            purpose: 'feedback',
          })
          return parseSocialLanguageFeedbackOutput(modelOutput)
        }
        catch (error) {
          console.warn('[lumi-social-language] feedback curator failed; feedback remains pending', error)
          return undefined
        }
      })()
      const [languageFeedback] = await Promise.all([
        languageFeedbackTask,
        prepareLumiRelationshipAssessment(messageText, sessionMessages, interaction),
      ])
      await lumiSocialLanguageStore.applyFeedbackFromUser({
        conversationId: event.sessionId,
        personId: interaction?.actorId,
        feedback: languageFeedback,
      })
      if (hasAttachments)
        return
      const autonomousTarget = cardStore.activeCard?.extensions?.airi?.modules?.artistry?.autonomousTarget || 'user'
      if (autonomousTarget === 'user')
        void artistryAutonomousStore.runArtistTask(messageText, toProviderHistory(sessionMessages))
    },
    onAssistantTurnReady: (event) => {
      const { messageText, sessionMessages, hasAttachments, hiddenUserMessage, interaction } = event
      const sessionId = getRuntimeEventSessionId(event)
      void runLumiUserProfileAfterTurn(
        messageText,
        sessionMessages,
        hiddenUserMessage ? 'screen_observation' : 'chat',
        interaction,
      )
      void runLumiCurrentStateAfterTurn(sessionMessages, false, interaction)
      if (hiddenUserMessage)
        return
      const artistry = cardStore.activeCard?.extensions?.airi?.modules?.artistry
      if (!hasAttachments && artistry?.autonomousEnabled && artistry?.autonomousTarget === 'assistant')
        void artistryAutonomousStore.runArtistTask(messageText, toProviderHistory(sessionMessages))
      runLumiEmotionAfterTurn(messageText, sessionMessages, interaction)
      void runLumiAutoMemoryAfterTurn(messageText, sessionMessages, sessionId, interaction)
      void runLumiSocialLanguageLearningAfterTurn(messageText, sessionMessages, sessionId, interaction)
    },
  })

  watch(sending, (next) => {
    if (runtime.getSending() !== next)
      runtime.setSending(next)
  })

  watch(
    () => lumiOnlineStore.generation[activeSessionId.value],
    (generation) => {
      if (lumiOnlineStore.runtimeMode !== 'online-client')
        return
      sending.value = generation?.state === 'started' || generation?.state === 'delta'
    },
  )

  watch(
    () => lumiOnlineStore.failedGeneration,
    (delivery, previous) => {
      if (
        lumiOnlineStore.runtimeMode !== 'online-client'
        || !delivery
        || delivery.deliveryId === previous?.deliveryId
      ) {
        return
      }
      chatSession.appendSessionMessage(delivery.payload.conversationId, {
        role: 'error',
        content: delivery.payload.error || 'Lumi Server 生成回复失败，请查看 Server Manager 日志。',
      })
    },
  )

  async function ingest(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    targetSessionId?: string,
  ) {
    const sessionId = targetSessionId ?? activeSessionId.value
    if (cardStore.activeCardId === LUMI_AIRI_CARD_ID && lumiOnlineStore.runtimeMode === 'online-client') {
      if (options.hiddenUserMessage)
        throw new Error('Online Lumi background tasks run on the server and cannot be started by the client')
      if (!lumiOnlineStore.isOnline)
        throw new Error('Lumi Server is disconnected. Reconnect before sending this online message.')
      sending.value = true
      try {
        await lumiOnlineStore.sendText(sessionId, sendingMessage)
      }
      catch (error) {
        sending.value = false
        throw error
      }
      return
    }
    const interaction: ChatInteractionContext | undefined = options.interaction ?? chatSession.getInteractionContext(sessionId)
    if (cardStore.activeCardId === LUMI_AIRI_CARD_ID && interaction?.actorId) {
      await Promise.all([
        lumiUserProfileStore.ensureUserProfileLoaded(interaction.actorId),
        lumiCurrentStateStore.ensureUserStateLoaded(interaction.actorId),
        lumiMemoryStore.ensureUserMemoryLoaded(interaction.actorId),
        lumiSocialLanguageStore.initialize(),
      ])
    }
    const sharedRuntimeEligible = cardStore.activeCardId === LUMI_AIRI_CARD_ID
      && interaction?.conversationType === 'direct'
      && Boolean(interaction.actorId)
      && !options.hiddenUserMessage
    if (sharedRuntimeEligible && interaction) {
      const mode = lumiAgentRuntimeSettingsStore.mode
      if (mode === 'maisaka') {
        sending.value = true
        const startedAt = performance.now()
        try {
          await prepareLumiRelationshipAssessment(
            sendingMessage,
            chatSession.getSessionMessages(sessionId),
            interaction,
          )
          const turnResult = await desktopLumiAgentHost.ingest({
            text: sendingMessage,
            sessionId,
            interaction,
            runtimeConfig: lumiAgentRuntimeSettingsStore.runtimeConfig(),
            mode,
            visible: true,
            onToolProgress: options.onAgentToolProgress,
          })
          if (
            turnResult.sentMessageIds.length === 0
            && options.input?.type === 'input:text'
            && options.input.data.perception
          ) {
            const failure = turnResult.failure
            throw new Error([
              `Lumi Agent Runtime produced no outbound message (${turnResult.endReason})`,
              failure ? `${failure.code}: ${failure.message}` : undefined,
            ].filter(Boolean).join(' - '))
          }
          await emitSharedRuntimeAssistantHooks({
            sessionId,
            sourceText: sendingMessage,
            sentMessageIds: turnResult.sentMessageIds,
            transportInput: options.input,
          })
          const sessionMessages = chatSession.getSessionMessages(sessionId)
          const assistantText = sessionMessages
            .filter(message => message.role === 'assistant')
            .slice(-3)
            .map(extractMessageText)
            .filter(Boolean)
            .join('\n\n')
          if (assistantText) {
            runLumiEmotionAfterTurn(assistantText, sessionMessages, interaction)
            void runLumiAutoMemoryAfterTurn(assistantText, sessionMessages, sessionId, interaction)
          }
          trackMessageRound({
            duration_ms: performance.now() - startedAt,
            has_voice: false,
            model: activeModel.value,
          })
          return
        }
        finally {
          sending.value = false
        }
      }
      if (mode === 'shadow') {
        void desktopLumiAgentHost.ingest({
          text: sendingMessage,
          sessionId,
          interaction,
          runtimeConfig: lumiAgentRuntimeSettingsStore.runtimeConfig(),
          mode,
          visible: false,
        }).catch(error =>
          console.warn('[lumi-agent-runtime:desktop] shadow turn failed', errorMessageFrom(error) ?? error),
        )
      }
    }
    const scopedOptions: ChatOrchestratorSendOptions = {
      ...options,
      interaction,
      ...(cardStore.activeCardId === LUMI_AIRI_CARD_ID
        ? {
            assistantActorId: LUMI_AIRI_CARD_ID,
            assistantActorDisplayName: 'Lumi',
            // Direct conversations serialize by actor; group conversations
            // serialize by timeline so two participants cannot interleave one
            // shared history while independent users can still run concurrently.
            executionLane: interaction?.conversationType === 'group'
              ? `lumi-conversation:${sessionId}`
              : `lumi-user:${interaction?.actorId ?? sessionId}`,
          }
        : {}),
    }
    if (cardStore.activeCardId === LUMI_AIRI_CARD_ID) {
      scopedOptions.tools = bindLumiMemoryToolsForTurn(scopedOptions.tools, {
        appendDebug: appendLumiMemoryDebug,
        interaction,
        sessionId,
      })
      const existingTransform = scopedOptions.toolTransform
      const remoteTransform = interaction?.toolScopes
        ? createLumiRemoteToolTransform(interaction.toolScopes, {
            actorId: interaction.actorId,
            conversationId: interaction.conversationId,
            deviceId: interaction.remoteDeviceId,
          })
        : undefined
      scopedOptions.toolTransform = async (tools) => {
        const transformed = existingTransform ? await existingTransform(tools) : tools
        const interactionBound = bindLumiToolMeshToolsForTurn(transformed, interaction, {
          allowPrivateLumiTools: Boolean(options.hiddenUserMessage),
        })
        return remoteTransform ? remoteTransform(interactionBound) : interactionBound
      }
    }
    const correctedOptions = withLumiCorrectionProviderTransform(sendingMessage, scopedOptions, sessionId)
    return runtime.ingest(
      sendingMessage,
      withLumiSocialLanguagePipeline(sendingMessage, correctedOptions, sessionId, interaction),
      sessionId,
    )
  }

  function withLumiSocialLanguagePipeline(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    sessionId: string,
    interaction?: ChatInteractionContext,
  ): ChatOrchestratorSendOptions {
    // Settings and chat are separate Electron renderer windows. Read the
    // shared value at turn start so prompt logging changes apply immediately.
    lumiSocialLanguageStore.refreshConfigFromStorage()
    if (
      cardStore.activeCardId !== LUMI_AIRI_CARD_ID
      || !lumiSocialLanguageStore.config.enabled
      || options.hiddenUserMessage
    ) {
      return options
    }

    const replyState = buildDesktopReplyCharacterState(sendingMessage, interaction)
    const character = replyState.character
    const plannerBehaviors = lumiSocialLanguageStore.config.behaviorLearningEnabled
      ? selectPlannerSocialBehaviors(lumiSocialLanguageStore.snapshot.behaviors, {
          personId: interaction?.actorId,
          conversationId: sessionId,
          platform: interaction?.platform ?? (interaction?.remoteDeviceId ? 'remote' : 'desktop'),
          conversationType: interaction?.conversationType ?? 'direct',
          currentUserText: sendingMessage,
        })
      : []
    const existingProviderTransform = options.providerMessageTransform
    const existingModelRequestStarted = options.onModelRequestStarted
    const existingModelStreamEvent = options.onModelStreamEvent
    const existingModelUsage = options.onModelUsage
    const existingModelRequestFinished = options.onModelRequestFinished
    let plannerTraceId: string | undefined
    return {
      ...options,
      deferAssistantText: true,
      providerMessageTransform(messages) {
        const transformed = existingProviderTransform ? existingProviderTransform(messages) : messages
        return appendPlannerContract(
          transformed,
          buildLumiPlannerSystemPrompt(),
          buildLumiPlannerTurnContext({
            character,
            conversationType: interaction?.conversationType ?? 'direct',
            selectedBehaviors: plannerBehaviors.map(candidate => candidate.behavior),
          }),
        )
      },
      onModelRequestStarted(input) {
        existingModelRequestStarted?.(input)
        if (!lumiSocialLanguageStore.config.promptLoggingEnabled)
          return
        plannerTraceId = nanoid()
        lumiConsciousnessObservabilityStore.begin({
          id: plannerTraceId,
          purpose: 'planner',
          model: input.model,
          provider: activeProvider.value,
          conversationId: sessionId,
          messages: input.messages,
          startedAt: input.startedAt,
        })
      },
      onModelStreamEvent(event) {
        existingModelStreamEvent?.(event)
        if (plannerTraceId && isTextDelta(event))
          lumiConsciousnessObservabilityStore.appendDelta(plannerTraceId, event.text)
      },
      onModelUsage(usage) {
        existingModelUsage?.(usage)
        if (plannerTraceId)
          lumiConsciousnessObservabilityStore.recordUsage(plannerTraceId, usage)
      },
      onModelRequestFinished(input) {
        existingModelRequestFinished?.(input)
        if (!plannerTraceId)
          return
        if (input.status === 'completed') {
          lumiConsciousnessObservabilityStore.complete(plannerTraceId, input)
        }
        else {
          lumiConsciousnessObservabilityStore.fail(
            plannerTraceId,
            input.error ?? 'Planner request failed',
            input,
          )
        }
      },
      async assistantResponseTransform({ rawText, providerMessages }) {
        try {
          const state = interaction?.conversationType === 'group' || !interaction?.actorId
            ? undefined
            : lumiEmotionStore.getStateForUser(interaction.actorId) ?? undefined
          const history = toLumiLanguageHistoryFromProvider(providerMessages)
          const configuredWindow = Number(options.providerConfig?.maxContextTokens)
          const providerMaxContextTokens = Number.isFinite(configuredWindow) && configuredWindow > 0
            ? Math.min(configuredWindow, lumiMainTimelineStore.normalizedMaxContextTokens)
            : lumiMainTimelineStore.normalizedMaxContextTokens
          const contextBudget = selectLumiAdaptiveContextBudget({
            providerMaxContextTokens,
            estimatedHistoryTokens: estimateLumiLanguageTokens(history),
            outputReserveTokens: lumiMainTimelineStore.normalizedOutputReserveTokens,
            promptReserveTokens: lumiMainTimelineStore.normalizedPromptReserveTokens,
            toolCount: Array.isArray(options.tools) ? options.tools.length : 0,
          })
          const result = await runLumiSocialLanguagePipeline({
            plannerOutput: rawText,
            legacyDraft: rawText,
            history,
            character,
            context: {
              now: Date.now(),
              personId: interaction?.actorId,
              conversationId: sessionId,
              platform: interaction?.platform ?? (interaction?.remoteDeviceId ? 'remote' : 'desktop'),
              conversationType: interaction?.conversationType ?? 'direct',
              currentUserText: sendingMessage,
              emotionTag: state?.dominantEmotion,
              emotionIntensity: state ? Math.max(state.mood.defensiveness, state.mood.sadness, state.mood.warmth) : 0.35,
              relationshipCloseness: state?.relationship.familiarity,
              defenseActive: Boolean(
                state?.relationship.repairRequired
                || state?.relationship.unresolvedConflict
                || (state?.mood.defensiveness && state.mood.defensiveness >= 0.55),
              ),
              refusalRequired: replyState.refusalRequired,
              recentAssistantTexts: history
                .filter(message => message.role === 'assistant')
                .slice(-24)
                .map(message => message.content),
            },
            expressions: lumiSocialLanguageStore.snapshot.expressions,
            jargon: lumiSocialLanguageStore.snapshot.jargon,
            behaviors: lumiSocialLanguageStore.snapshot.behaviors,
            config: lumiSocialLanguageStore.config,
            model: {
              generate: (messages, purpose) => generateSocialLanguageText(options, messages, purpose, sessionId),
            },
            createId: nanoid,
            replyerHistoryTokens: contextBudget.replyerHistoryTokens,
          })
          await lumiSocialLanguageStore.recordDecision(result.decision)
          if (lumiSocialLanguageStore.config.promptLoggingEnabled) {
            console.info('[lumi-social-language] decision', {
              id: result.decision.id,
              replyAct: result.intent.replyAct,
              selectedExpressions: result.selectedExpressionIds.map((id) => {
                const expression = lumiSocialLanguageStore.snapshot.expressions.find(item => item.id === id)
                return {
                  id,
                  reasons: result.decision.selectedExpressionReasons[id] ?? [],
                  source: expression?.origin.source,
                  sourcePersonId: expression?.origin.personId,
                  ownership: expression?.ownership,
                  affinity: expression?.affinity,
                }
              }),
              selectedBehaviors: result.selectedBehaviorIds,
              contextBudget,
              contextProjection: result.decision.contextProjection,
              validator: result.decision.validator,
            })
          }
          return flattenLumiVisibleReply(result.reply)
        }
        catch (error) {
          console.warn('[lumi-social-language] pipeline failed; suppressing reply instead of replaying model text', error)
          return ''
        }
      },
    }
  }

  function buildDesktopReplyCharacterState(
    userText: string,
    interaction?: ChatInteractionContext,
  ): {
    character: LumiReplyCharacterState
    refusalRequired: boolean
  } {
    const anchor = createDefaultLumiPersonaAnchor()
    const state = interaction?.conversationType === 'group' || !interaction?.actorId
      ? undefined
      : lumiEmotionStore.getStateForUser(interaction.actorId) ?? undefined
    const gate = interaction?.conversationType === 'group' || !interaction?.actorId
      ? undefined
      : lumiEmotionStore.previewRelationshipGate(userText, interaction.actorId)
    const personality = cardStore.activeCard?.personality?.trim()
    const corePersonality = personality || [
      anchor.identity,
      `Core traits: ${anchor.coreTraits.join('; ')}`,
      `Boundaries: ${anchor.boundaries.join('; ')}`,
    ].join('\n')
    const baseReplyStyle = [
      anchor.speechStyle.tone,
      anchor.speechStyle.sentenceLength,
      `Avoid: ${anchor.speechStyle.avoid.join('; ')}`,
    ].join('\n')
    const emotionSummary = state
      ? [
          state.dominantEmotion,
          `warmth=${state.mood.warmth.toFixed(2)}`,
          `sadness=${state.mood.sadness.toFixed(2)}`,
          `irritation=${state.mood.irritation.toFixed(2)}`,
          `defensiveness=${state.mood.defensiveness.toFixed(2)}`,
        ].join(', ')
      : 'neutral group-room presence; do not inherit a private relationship state'
    const relationshipSummary = state
      ? [
          `familiarity=${state.relationship.familiarity.toFixed(2)}`,
          `trust=${state.relationship.trust.toFixed(2)}`,
          `attachment=${state.relationship.attachment.toFixed(2)}`,
          `unresolvedConflict=${state.relationship.unresolvedConflict}`,
          `repairRequired=${state.relationship.repairRequired}`,
        ].join(', ')
      : interaction?.conversationType === 'group'
        ? 'shared group relationship; keep participant-specific private impressions out'
        : 'no persisted direct relationship state'
    const defenseSummary = gate?.blocked
      ? `${gate.reason}: ${gate.instruction ?? gate.action}`
      : state?.mood.defensiveness && state.mood.defensiveness >= 0.55
        ? `active defensiveness=${state.mood.defensiveness.toFixed(2)}`
        : 'none'

    return {
      character: {
        corePersonality,
        baseReplyStyle,
        state,
        emotionSummary,
        relationshipSummary,
        defenseSummary,
      },
      refusalRequired: gate?.refusalRequired === true,
    }
  }

  function appendPlannerContract(
    messages: Message[],
    systemPrompt: string,
    turnContext: string,
  ): Message[] {
    const result = messages.map(message => ({ ...message }))
    // DeepSeek V4 can persist multiple complete prefix units. Keeping the
    // canonical system and native dialogue untouched lets Planner and Replyer
    // reuse the same long prefix; only the stage-specific task tail changes.
    result.push({
      role: 'user',
      content: [
        '[Lumi trusted Planner task]',
        systemPrompt,
        turnContext,
        '[/Lumi trusted Planner task]',
      ].join('\n\n'),
    })
    return result
  }

  function toLumiLanguageHistory(messages: ChatHistoryItem[]): LumiLanguageModelMessage[] {
    const history: LumiLanguageModelMessage[] = []
    for (const message of messages
      .filter((message): message is ChatHistoryItem & { role: 'user' | 'assistant' } =>
        (message.role === 'user' || message.role === 'assistant')
        && !isLumiMemoryDebugMessage(message),
      )) {
      const content = extractMessageText(message).trim()
      if (content) {
        history.push({
          role: message.role,
          content,
          name: message.actorDisplayName,
        })
      }
    }
    return history
  }

  function toLumiLanguageHistoryFromProvider(messages: Message[]): LumiLanguageModelMessage[] {
    return messages.flatMap((message) => {
      if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant')
        return []
      const content = typeof message.content === 'string'
        ? message.content.trim()
        : Array.isArray(message.content)
          ? message.content
              .filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text')
              .map(part => part.text)
              .join('\n')
              .trim()
          : ''
      if (
        content.includes('[Lumi trusted Planner task]')
        || content.includes('[Lumi final-response planning contract]')
        || content.includes('[Lumi planner turn context]')
      ) {
        return []
      }
      return content
        ? [{
            role: message.role,
            content,
            name: 'name' in message && typeof message.name === 'string' ? message.name : undefined,
          }]
        : []
    })
  }

  async function generateSocialLanguageText(
    options: ChatOrchestratorSendOptions,
    messages: LumiLanguageModelMessage[],
    purpose: 'replyer' | 'replyer_retry' | 'expression_selector' | 'context_summary',
    conversationId?: string,
  ) {
    return generateSocialLanguageTextWithProvider({
      model: options.model,
      chatProvider: options.chatProvider,
      messages,
      headers: stringRecord(options.providerConfig?.headers),
      purpose,
      conversationId,
    })
  }

  async function generateSocialLanguageTextWithProvider(input: {
    model: string
    chatProvider: ChatProvider
    messages: LumiLanguageModelMessage[]
    headers?: Record<string, string>
    purpose: 'replyer' | 'replyer_retry' | 'expression_selector' | 'learning' | 'feedback' | 'sticker_classifier' | 'sticker_selector' | 'context_summary' | 'relationship_assessment' | 'current_state' | 'profile_curator' | 'profile_review' | 'memory_curator' | 'memory_topic'
    conversationId?: string
  }) {
    const traceId = lumiSocialLanguageStore.config.promptLoggingEnabled ? nanoid() : undefined
    const startedAt = Date.now()
    if (traceId) {
      lumiConsciousnessObservabilityStore.begin({
        id: traceId,
        purpose: input.purpose,
        model: input.model,
        provider: activeProvider.value,
        conversationId: input.conversationId,
        messages: input.messages,
        startedAt,
      })
    }
    let buffer = ''
    try {
      await llmStore.stream(input.model, input.chatProvider, input.messages as Message[], {
        headers: input.headers,
        supportsTools: false,
        waitForTools: false,
        maxSteps: 1,
        tools: [],
        onUsage: (usage) => {
          if (traceId)
            lumiConsciousnessObservabilityStore.recordUsage(traceId, usage)
        },
        onStreamEvent: (event) => {
          if (!isTextDelta(event))
            return
          buffer += event.text
          if (traceId)
            lumiConsciousnessObservabilityStore.appendDelta(traceId, event.text)
        },
      })
      if (!buffer.trim())
        throw new Error(`Lumi ${input.purpose} model returned an empty response`)
      if (traceId)
        lumiConsciousnessObservabilityStore.complete(traceId)
    }
    catch (error) {
      if (traceId)
        lumiConsciousnessObservabilityStore.fail(traceId, errorMessageFrom(error) ?? String(error))
      throw error
    }
    return buffer
  }

  async function runLumiSocialLanguageLearningAfterTurn(
    assistantText: string,
    sessionMessages: ChatHistoryItem[],
    sessionId: string,
    interaction?: ChatInteractionContext,
  ) {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID || !lumiSocialLanguageStore.config.enabled)
      return
    const userMessage = findLatestUserMessage(sessionMessages)
    if (!userMessage?.id)
      return
    const userText = extractMessageText(userMessage).trim()
    if (!userText)
      return

    const platform = interaction?.platform ?? (interaction?.remoteDeviceId ? 'remote' : 'desktop')
    const evidence: SocialLanguageEvidence = {
      messageId: userMessage.id,
      text: userText,
      personId: interaction?.actorId ?? userMessage.actorId,
      conversationId: sessionId,
      platform,
      timestamp: userMessage.createdAt ?? Date.now(),
      source: 'human',
      sourceKind: interaction?.conversationType === 'group' ? 'group_chat' : 'chat',
      authorVerified: Boolean(interaction?.actorId ?? userMessage.actorId),
    }
    if (!canCreateSocialLanguageCandidates({
      config: lumiSocialLanguageStore.config,
      evidence,
      ingress: 'direct_turn',
    })) {
      return
    }
    let modelOutput: string | undefined
    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (providerId && modelId) {
      try {
        const chatProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
        modelOutput = await generateSocialLanguageTextWithProvider({
          model: modelId,
          chatProvider,
          messages: buildSocialLanguageLearningMessages({
            evidence,
            recentContext: toLumiLanguageHistory(sessionMessages)
              .filter((message): message is LumiLanguageModelMessage & { role: 'user' | 'assistant' } =>
                message.role === 'user' || message.role === 'assistant',
              )
              .slice(-8)
              .map(message => ({ role: message.role, content: message.content })),
          }),
          purpose: 'learning',
        })
      }
      catch (error) {
        console.warn('[lumi-social-language] model curator failed; evidence remains pending', error)
      }
    }
    await lumiSocialLanguageStore.observeEvidence(evidence, modelOutput)

    const latestAssistant = [...sessionMessages].reverse().find(message =>
      message.role === 'assistant' && extractMessageText(message).trim() === assistantText.trim(),
    )
    if (assistantText.trim() && latestAssistant?.id) {
      await lumiSocialLanguageStore.observeEvidence({
        messageId: latestAssistant.id,
        text: assistantText.trim(),
        personId: interaction?.actorId,
        conversationId: sessionId,
        platform,
        timestamp: latestAssistant.createdAt ?? Date.now(),
        source: 'lumi',
        sourceKind: interaction?.conversationType === 'group' ? 'group_chat' : 'chat',
        authorVerified: true,
      })
    }
  }

  async function observeExternalGroupLanguage(
    observation: SocialLanguageGroupObservation,
    batchSize: number,
    historyLimit = 5_000,
    concurrentGroups = 3,
  ) {
    await lumiSocialLanguageStore.enqueueObservation(observation, batchSize, {
      claimBatch: false,
      maximumHistory: historyLimit,
    })
    scheduleExternalGroupLanguageDrain(batchSize, concurrentGroups)
    return { queued: true, batchProcessed: false }
  }

  /**
   * Starts available background curator workers for complete group batches.
   *
   * Incoming AstrBot requests return after persistence instead of waiting for
   * every model call in the backlog. Each source is claimed at most once, so
   * different groups can run concurrently while one group's order stays stable.
   */
  function scheduleExternalGroupLanguageDrain(batchSize: number, concurrentGroups: number) {
    const maximumWorkers = Math.max(1, Math.min(8, Math.floor(concurrentGroups)))
    while (activeGroupObservationWorkers < maximumWorkers) {
      const batch = lumiSocialLanguageStore.takeNextObservationBatch(batchSize)
      if (!batch.length)
        return

      activeGroupObservationWorkers += 1
      void curateExternalGroupLanguageBatch(batch)
        .catch((error) => {
          lumiSocialLanguageStore.releaseObservationBatch(batch[0]?.sourceId ?? 'unknown')
          console.warn('[lumi-social-language] background group curator stopped after an unexpected failure', error)
        })
        .finally(() => {
          activeGroupObservationWorkers -= 1
          scheduleExternalGroupLanguageDrain(batchSize, maximumWorkers)
        })
    }
  }

  /** Resumes persisted complete batches without requiring a new group message. */
  function resumeExternalGroupLanguageDrain(batchSize: number, concurrentGroups = 3) {
    scheduleExternalGroupLanguageDrain(batchSize, concurrentGroups)
  }

  async function curateExternalGroupLanguageBatch(
    batch: SocialLanguageGroupObservation[],
    recoveryBatchIds?: string[],
  ) {
    let modelOutput: string | undefined
    let curatorWarning: string | undefined
    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (providerId && modelId) {
      try {
        const chatProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
        modelOutput = await generateSocialLanguageTextWithProvider({
          model: modelId,
          chatProvider,
          messages: buildObservedGroupLearningMessages({
            observations: batch,
            recentContext: lumiSocialLanguageStore.recentObservationContext(
              batch[0]?.sourceId ?? '',
              batch.map(item => item.messageId),
            ),
          }),
          purpose: 'learning',
        })
      }
      catch (error) {
        curatorWarning = errorMessageFrom(error) ?? '模型归纳失败，证据保留待后续处理'
        console.warn('[lumi-social-language] group batch curator failed; evidence remains pending', error)
      }
    }
    const commit = groupObservationCommitQueue.then(() =>
      lumiSocialLanguageStore.completeObservationBatch({
        observations: batch,
        modelOutput,
        curatorWarning,
        consume: !recoveryBatchIds,
        recoveryBatchIds,
      }),
    )
    groupObservationCommitQueue = commit.then(() => undefined, () => undefined)
    return await commit
  }

  /**
   * Replays retained observations from batches that previously produced no
   * usable model-curated knowledge.
   */
  async function reprocessMissedExternalGroupLanguage() {
    const groups = lumiSocialLanguageStore.recoverableObservationGroups()
    let recoveredMessageCount = 0
    let changedKnowledgeCount = 0
    for (const group of groups) {
      const result = await curateExternalGroupLanguageBatch(group.observations, group.batchIds)
      if (!result.successful)
        continue
      recoveredMessageCount += group.observations.length
      changedKnowledgeCount += result.changeCount
    }

    let pendingBatch = lumiSocialLanguageStore.takeNextObservationBatch(10)
    while (pendingBatch.length) {
      const result = await curateExternalGroupLanguageBatch(pendingBatch)
      changedKnowledgeCount += result.changeCount
      pendingBatch = lumiSocialLanguageStore.takeNextObservationBatch(10)
    }
    return {
      groupCount: groups.length,
      recoveredMessageCount,
      changedKnowledgeCount,
    }
  }

  async function runExternalStickerIntelligence(
    operation: 'classify' | 'select',
    payload: {
      senderName?: string
      contextText?: string
      previousTags?: string[]
      inputText?: string
      replyText?: string
      candidates?: Array<{ id: string, tags: string[], observedCount: number, sentCount: number }>
    },
  ) {
    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (!providerId || !modelId)
      throw new Error('Lumi consciousness model is not configured')
    const chatProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
    if (operation === 'classify') {
      const raw = await generateSocialLanguageTextWithProvider({
        model: modelId,
        chatProvider,
        messages: buildLumiStickerClassificationMessages({
          senderName: payload.senderName?.trim() || 'unknown',
          contextText: payload.contextText?.trim() || '',
          previousTags: payload.previousTags ?? [],
        }),
        purpose: 'sticker_classifier',
      })
      const classification = parseLumiStickerClassification(raw)
      if (!classification)
        throw new Error('Lumi consciousness returned an invalid sticker classification')
      return { classification }
    }
    const raw = await generateSocialLanguageTextWithProvider({
      model: modelId,
      chatProvider,
      messages: buildLumiStickerSelectionMessages({
        inputText: payload.inputText?.trim() || '',
        replyText: payload.replyText?.trim() || '',
        candidates: payload.candidates ?? [],
      }),
      purpose: 'sticker_selector',
    })
    const selection = parseLumiStickerSelection(raw)
    if (!selection)
      throw new Error('Lumi consciousness returned an invalid sticker selection')
    return { selection }
  }

  async function ingestOnFork(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    forkOptions?: ForkOptions,
  ) {
    const baseSessionId = forkOptions?.fromSessionId ?? activeSessionId.value
    if (!forkOptions)
      return ingest(sendingMessage, options, baseSessionId)

    const forkSessionId = await chatSession.forkSession({
      fromSessionId: baseSessionId,
      atIndex: forkOptions.atIndex,
      reason: forkOptions.reason,
      hidden: forkOptions.hidden,
    })
    return ingest(sendingMessage, options, forkSessionId || baseSessionId)
  }

  function withLumiCorrectionProviderTransform(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    sessionId: string,
  ): ChatOrchestratorSendOptions {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
      return options

    const baseOptions: ChatOrchestratorSendOptions = {
      ...options,
      providerConfig: {
        ...options.providerConfig,
        // Lumi uses a token-aware rolling summary. A message-count limit would
        // discard older turns before the compressor can preserve them.
        maxContextMessages: 0,
      },
      async providerHistoryTransform(messages) {
        const transformed = options.providerHistoryTransform
          ? await options.providerHistoryTransform(messages)
          : messages
        const contextMessages = toConversationContextMessages(transformed)
        if (!contextMessages.length)
          return transformed

        const configuredWindow = Number(options.providerConfig?.maxContextTokens)
        const maxContextTokens = Number.isFinite(configuredWindow) && configuredWindow > 0
          ? Math.min(configuredWindow, lumiMainTimelineStore.normalizedMaxContextTokens)
          : lumiMainTimelineStore.normalizedMaxContextTokens
        const contextBudget = selectLumiAdaptiveContextBudget({
          providerMaxContextTokens: maxContextTokens,
          estimatedHistoryTokens: estimateLumiConversationTokens(contextMessages),
          outputReserveTokens: lumiMainTimelineStore.normalizedOutputReserveTokens,
          promptReserveTokens: lumiMainTimelineStore.normalizedPromptReserveTokens,
          toolCount: Array.isArray(options.tools) ? options.tools.length : 0,
        })
        const projection = await compressLumiConversationContext({
          conversationId: sessionId,
          messages: contextMessages,
          previousSummary: lumiMainTimelineStore.summaryFor(sessionId),
          policy: {
            maxContextTokens: contextBudget.plannerContextWindowTokens,
            outputReserveTokens: lumiMainTimelineStore.normalizedOutputReserveTokens,
            promptReserveTokens: lumiMainTimelineStore.normalizedPromptReserveTokens,
            compressionTriggerRatio: 0.82,
            compressionTargetRatio: 0.68,
            preserveRecentMessages: 48,
            summaryChunkTokens: 120_000,
          },
          generateSummary: messages => generateSocialLanguageText(
            options,
            messages.map(message => ({
              role: message.role,
              content: message.content,
              name: message.name,
            })),
            'context_summary',
            sessionId,
          ),
        })
        if (projection.summary)
          lumiMainTimelineStore.saveSummary(projection.summary)
        if (lumiSocialLanguageStore.config.promptLoggingEnabled) {
          console.info('[lumi-context] planner projection', {
            sessionId,
            providerMaxContextTokens: maxContextTokens,
            contextBudget,
            compressed: projection.compressed,
            estimatedInputTokens: projection.estimatedInputTokens,
            summarizedMessageCount: projection.summarizedMessageCount,
            continuitySummaryIncluded: Boolean(projection.summary),
          })
        }
        return projection.messages.map((message): ChatHistoryItem => message.role === 'assistant'
          ? {
              id: message.id,
              role: 'assistant',
              content: message.content,
              slices: [{ type: 'text', text: message.content, source: 'assistant' }],
              tool_results: [],
              actorDisplayName: message.name,
            }
          : {
              id: message.id,
              role: message.role,
              content: message.content,
              actorDisplayName: message.name,
            })
      },
    }

    const guard = analyzeLumiConversationGuard(sendingMessage)
    if (!guard.isCorrection)
      return baseOptions

    const existingTransform = options.providerMessageTransform
    return {
      ...baseOptions,
      providerMessageTransform(messages) {
        const transformed = existingTransform ? existingTransform(messages) : messages
        return suppressDisputedAssistantForCorrectionTurn(transformed)
      },
    }
  }

  function cancelPendingSends(sessionId?: string) {
    runtime.cancelPendingSends(sessionId)
  }

  function getPendingQueuedSendSnapshot() {
    return runtime.getPendingQueuedSendSnapshot()
  }

  function getRuntimeEventSessionId(event: unknown) {
    const sessionId = event && typeof event === 'object' && 'sessionId' in event
      ? event.sessionId
      : undefined
    return typeof sessionId === 'string' && sessionId
      ? sessionId
      : activeSessionId.value
  }

  function runLumiEmotionAfterTurn(
    assistantText: string,
    sessionMessages: ChatHistoryItem[],
    interaction?: ChatInteractionContext,
  ) {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
      return
    if (!interaction?.actorId)
      return
    if (interaction.conversationType === 'group')
      return

    const userMessage = findLatestUserMessage(sessionMessages)
    if (!userMessage)
      return

    const userText = extractMessageText(userMessage).trim()
    lumiEmotionStore.updateAfterTurn({
      userText,
      assistantText,
    }, interaction.actorId)
  }

  async function prepareLumiRelationshipAssessment(
    userText: string,
    sessionMessages: ChatHistoryItem[],
    interaction?: ChatInteractionContext,
  ) {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
      return
    if (!interaction?.actorId)
      return
    if (interaction.conversationType === 'group')
      return

    const userId = interaction.actorId
    lumiEmotionStore.initialize(userId)
    const state = lumiEmotionStore.getStateForUser(userId)
    if (!state)
      return

    const fallback = assessLumiRelationshipFallback(state, userText)
    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (!providerId || !modelId) {
      lumiEmotionStore.setPendingRelationshipAssessment(userText, fallback, userId)
      return
    }

    try {
      const chatProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
      if (!chatProvider) {
        lumiEmotionStore.setPendingRelationshipAssessment(userText, fallback, userId)
        return
      }

      const buffer = await generateSocialLanguageTextWithProvider({
        model: modelId,
        chatProvider,
        purpose: 'relationship_assessment',
        messages: [
          {
            role: 'system',
            content: buildLumiRelationshipAssessmentPrompt({
              state,
              recentMessages: toRecentRelationshipCuratorMessages(sessionMessages),
            }),
          },
          {
            role: 'user',
            content: userText,
          },
        ],
      })

      const parsed = parseLumiRelationshipAssessment(buffer)
      const assessment = parsed
        ? mergeLumiRelationshipAssessmentWithSafetyFloor(parsed, fallback, state)
        : fallback
      lumiEmotionStore.setPendingRelationshipAssessment(userText, assessment, userId)
    }
    catch (error) {
      console.warn('[lumi-emotion] relationship curator failed; using fallback', error)
      lumiEmotionStore.setPendingRelationshipAssessment(userText, fallback, userId)
    }
  }

  async function runLumiAutoMemoryAfterTurn(
    assistantText: string,
    sessionMessages: ChatHistoryItem[],
    sessionId: string,
    interaction?: ChatInteractionContext,
  ) {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
      return
    if (!interaction?.actorId)
      return

    const userMessage = findLatestUserMessage(sessionMessages)
    if (!userMessage)
      return

    const userText = extractMessageText(userMessage).trim()
    if (!shouldConsiderForMemory(userText)) {
      appendLumiMemoryDebug('memory_write', [
        'status: skipped',
        'reason: message too short or routine acknowledgement',
      ], sessionId)
      return
    }

    appendLumiMemoryDebug('memory_write', [
      'status: checking',
      `source: ${previewText(userText)}`,
    ], sessionId)

    const sourceMessageId = userMessage.id
    const contextual = buildLumiContextualMemoryQuery({
      currentMessage: userText,
      recentMessages: toRecentMemoryContextMessages(sessionMessages),
    })
    const cachedTopic = lumiMemoryStore.getLatestTopic(sessionId, userText)
    const memoryTopic = cachedTopic ?? await analyzeLumiMemoryTopicWithLlm({
      userText,
      sessionMessages,
      fallback: contextual,
    })
    if (!cachedTopic)
      lumiMemoryStore.setLatestTopic(sessionId, userText, memoryTopic)
    const memoryTopicStoragePrefix = 'storagePrefix' in memoryTopic && typeof memoryTopic.storagePrefix === 'string'
      ? memoryTopic.storagePrefix
      : undefined
    const candidates = contextualizeLumiMemoryCandidates([
      ...await curateLumiMemoriesWithLlm({
        userText,
        assistantText,
        sourceMessageId,
        sessionMessages,
        topicWindow: memoryTopic.topicWindow,
        sourceSignals: buildLumiMemorySourceSignals(userText),
        interaction,
      }),
    ], memoryTopic.topicHints, memoryTopicStoragePrefix)

    const uniqueCandidates = dedupeLumiMemoryCandidates(candidates)

    if (!uniqueCandidates.length) {
      appendLumiMemoryDebug('memory_write', [
        'status: no candidate',
        'reviewer: consciousness_model',
        'candidates: 0',
        'stored: 0',
      ], sessionId)
      return
    }

    const stored = []
    for (const candidate of uniqueCandidates) {
      const commonOptions = {
        conversationId: sessionId,
        conversationType: interaction.conversationType,
        participantUserIds: interaction.participantIds,
        sourceMessageId,
        userId: interaction.actorId,
        personaId: LUMI_AIRI_CARD_ID,
      }
      stored.push(...await lumiMemoryStore.rememberCandidatesForUser(interaction.actorId, [candidate], commonOptions))
    }

    appendLumiMemoryDebug('memory_write', [
      `status: ${stored.length ? 'stored' : 'rejected_or_duplicate'}`,
      memoryTopic.topicWindow ? `topic: ${previewText(memoryTopic.topicWindow)}` : 'topic: none',
      'reviewer: consciousness_model',
      `candidates: ${uniqueCandidates.length}`,
      `stored: ${stored.length}`,
      ...stored.slice(0, 3).map(memory => `- ${memory.type}/${memory.status}: ${previewText(memory.content, 90)}`),
    ], sessionId)
  }

  async function runLumiUserProfileAfterTurn(
    assistantText: string,
    sessionMessages: ChatHistoryItem[],
    sourceKind: LumiUserProfileSourceKind,
    interaction?: ChatInteractionContext,
  ) {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
      return
    if (!interaction?.actorId)
      return
    if (interaction.conversationType === 'group')
      return

    const userId = interaction.actorId
    await lumiUserProfileStore.ensureUserProfileLoaded(userId)
    if (!lumiUserProfileStore.isAutoUpdateEnabledForUser(userId))
      return

    const userMessage = findLatestUserMessage(sessionMessages)
    if (!userMessage)
      return

    const userText = extractMessageText(userMessage).trim()
    if (!shouldConsiderForProfile(userText)) {
      await runLumiUserProfileBacklogReviewNotice(sessionMessages, userId)
      return
    }

    const curated = await curateLumiUserProfileWithLlm({
      userText,
      assistantText,
      sessionMessages,
      sourceKind,
    })
    const candidates = dedupeProfileCandidates(curated)
    if (!candidates.length) {
      await runLumiUserProfileBacklogReviewNotice(sessionMessages, userId)
      return
    }

    const results = await lumiUserProfileStore.applyCandidatesForUser(userId, candidates, {
      sourceKind,
      sourceMessageId: userMessage.id,
    })
    const autoReview = userId === lumiIdentityStore.activeUserId
      ? await runLumiUserProfilePendingAutoReview(sessionMessages)
      : { consolidated: 0, reviewed: 0, approved: 0, rejected: 0, kept: 0 }
    const stored = results.filter(result => result.status === 'stored').length
    const pending = results.filter(result => result.status === 'pending').length
    const skipped = results.filter(result => result.status === 'skipped').length

    appendLumiSystemNotice([
      'title: 用户画像更新',
      `status: ${stored || pending ? 'updated' : 'skipped'}`,
      `source: ${sourceKind}`,
      `candidates: ${candidates.length}`,
      `stored: ${stored}`,
      `pending: ${pending}`,
      `auto_reviewed: ${autoReview.reviewed}`,
      `auto_approved: ${autoReview.approved}`,
      `skipped: ${skipped}`,
      ...candidates.slice(0, 4).map(candidate => `- ${candidate.layer}/${candidate.key}: ${previewText(candidate.value, 80)}`),
    ])
  }

  async function runLumiCurrentStateAfterTurn(
    sessionMessages: ChatHistoryItem[],
    force = false,
    interaction?: ChatInteractionContext,
  ) {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
      return { status: 'skipped:not_lumi' as const }
    if (!interaction?.actorId)
      return { status: 'skipped:missing_actor' as const }
    if (interaction.conversationType === 'group')
      return { status: 'skipped:group_uses_group_memory' as const }

    const userId = interaction.actorId
    await lumiCurrentStateStore.ensureUserStateLoaded(userId)
    const previousState = { ...lumiCurrentStateStore.getStateForUser(userId) }
    const nextTurnCount = previousState.turnCount + 1
    if (!force && nextTurnCount % lumiCurrentStateStore.normalizedUpdateEveryTurns !== 0) {
      await lumiCurrentStateStore.saveCurrentState({
        turnCount: nextTurnCount,
        updatedAt: previousState.updatedAt || new Date().toISOString(),
      }, userId)
      return { status: 'skipped:interval' as const }
    }

    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (!providerId || !modelId)
      return { status: 'skipped:no_model' as const }

    const latestUser = findLatestUserMessage(sessionMessages)
    const profileContext = lumiUserProfileStore.buildRelevantContext({
      messageText: latestUser ? extractMessageText(latestUser) : '',
      limit: 6,
    }, interaction?.actorId)
    const sourceMessageIds = sessionMessages
      .slice(-16)
      .map(message => message.id)
      .filter((id): id is string => typeof id === 'string' && !!id)

    try {
      const chatProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
      const buffer = await generateSocialLanguageTextWithProvider({
        model: modelId,
        chatProvider,
        purpose: 'current_state',
        messages: [
          {
            role: 'system',
            content: buildLumiCurrentStateUpdatePrompt(),
          },
          {
            role: 'user',
            content: buildLumiCurrentStateUpdateUserPayload({
              previousState,
              profileContext,
              recentMessages: sessionMessages,
              userDisplayName: interaction?.actorDisplayName
                ?? lumiIdentityStore.users.find(user => user.id === interaction?.actorId)?.displayName,
            }),
          },
        ],
      })

      const nextState = parseLumiCurrentStateUpdateOutput(buffer, previousState, sourceMessageIds)
      await lumiCurrentStateStore.saveCurrentState(nextState, userId)

      appendLumiSystemNotice([
        'title: 短期意识状态',
        'status: updated',
        `topics: ${nextState.recentTopics.slice(0, 3).join('；') || 'none'}`,
        `active_projects: ${nextState.activeProjects.length}`,
        `unfinished_tasks: ${nextState.unfinishedTasks.length}`,
        'profile_projection: cognitive_evidence_only',
      ])

      return { status: 'updated' as const, state: nextState }
    }
    catch (error) {
      console.warn('[lumi-current-state] update failed', error)
      appendLumiSystemNotice([
        'title: 短期意识状态',
        'status: failed',
        `error: ${errorMessageFrom(error) ?? 'Unknown error'}`,
      ])
      return { status: 'failed' as const }
    }
  }

  async function runLumiUserProfileBacklogReviewNotice(sessionMessages: ChatHistoryItem[], userId: string) {
    if (userId !== lumiIdentityStore.activeUserId)
      return
    const autoReview = await runLumiUserProfilePendingAutoReview(sessionMessages)
    if (!autoReview.reviewed && !autoReview.consolidated)
      return

    appendLumiSystemNotice([
      'title: 用户画像待处理印象整理',
      `status: ${autoReview.approved || autoReview.rejected ? 'updated' : 'reviewed'}`,
      `consolidated: ${autoReview.consolidated}`,
      `auto_reviewed: ${autoReview.reviewed}`,
      `auto_approved: ${autoReview.approved}`,
      `auto_rejected: ${autoReview.rejected}`,
      `kept_pending: ${autoReview.kept}`,
    ])
  }

  async function runLumiUserProfilePendingAutoReview(sessionMessages: ChatHistoryItem[]) {
    const consolidated = lumiUserProfileStore.consolidatePendingUpdates().merged
    const pending = lumiUserProfileStore.autoReviewPendingUpdates.slice(0, 2)
    if (!pending.length)
      return { consolidated, reviewed: 0, approved: 0, rejected: 0, kept: 0 }

    let reviewed = 0
    let approved = 0
    let rejected = 0
    let kept = 0

    for (const update of pending) {
      const currentEntry = lumiUserProfileStore.coreEntries.find(entry =>
        entry.id === update.targetEntryId || entry.key === update.key,
      )
      const decision = await reviewLumiUserProfilePendingWithLlm({
        pending: update,
        currentEntry,
        sessionMessages,
      })
      if (!decision)
        continue

      reviewed += 1
      if (decision.decision === 'approve') {
        const entry = lumiUserProfileStore.approvePendingAutomatically(update.id, decision)
        if (entry)
          approved += 1
      }
      else if (decision.decision === 'reject') {
        lumiUserProfileStore.markPendingAutoReview(update.id, decision)
        if (lumiUserProfileStore.rejectPending(update.id))
          rejected += 1
      }
      else {
        lumiUserProfileStore.markPendingAutoReview(update.id, decision)
        kept += 1
      }
    }

    return { consolidated, reviewed, approved, rejected, kept }
  }

  async function reviewAndApproveLumiUserProfilePending(pendingId: string) {
    const pending = lumiUserProfileStore.pendingActiveUpdates.find(update => update.id === pendingId)
    if (!pending)
      return { status: 'missing' as const }

    const currentEntry = lumiUserProfileStore.coreEntries.find(entry =>
      entry.id === pending.targetEntryId || entry.key === pending.key,
    )
    const decision = await reviewLumiUserProfilePendingWithLlm({
      pending,
      currentEntry,
      sessionMessages: chatSession.messages,
    })

    if (!decision)
      return { status: 'review_failed' as const }

    if (decision.decision === 'approve') {
      const entry = lumiUserProfileStore.approvePendingAutomatically(pending.id, decision)
      return entry
        ? { status: 'approved' as const, entry, decision }
        : { status: 'approve_failed' as const, decision }
    }

    lumiUserProfileStore.markPendingAutoReview(pending.id, decision)
    if (decision.decision === 'reject') {
      lumiUserProfileStore.rejectPending(pending.id)
      return { status: 'rejected' as const, decision }
    }

    return { status: 'kept_pending' as const, decision }
  }

  async function reviewLumiUserProfilePendingWithLlm(input: {
    pending: LumiUserProfilePendingUpdate
    currentEntry?: LumiUserProfileEntry
    sessionMessages: ChatHistoryItem[]
  }) {
    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (!providerId || !modelId)
      return null

    try {
      const chatProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
      const buffer = await generateSocialLanguageTextWithProvider({
        model: modelId,
        chatProvider,
        purpose: 'profile_review',
        messages: [
          {
            role: 'system',
            content: buildLumiUserProfilePendingAutoReviewPrompt(),
          },
          {
            role: 'user',
            content: buildLumiUserProfilePendingAutoReviewUserPayload({
              pending: input.pending,
              currentEntry: input.currentEntry,
              recentMessages: toRecentMemoryCuratorMessages(input.sessionMessages),
            }),
          },
        ],
      })

      return parseLumiUserProfilePendingAutoReviewOutput(buffer)
    }
    catch (error) {
      console.warn('[lumi-user-profile] pending auto review failed', error)
      return null
    }
  }

  async function curateLumiUserProfileWithLlm(input: {
    userText: string
    assistantText: string
    sessionMessages: ChatHistoryItem[]
    sourceKind: LumiUserProfileSourceKind
  }) {
    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (!providerId || !modelId)
      return []

    try {
      const chatProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
      const buffer = await generateSocialLanguageTextWithProvider({
        model: modelId,
        chatProvider,
        purpose: 'profile_curator',
        messages: [
          {
            role: 'system',
            content: buildLumiUserProfileCuratorPrompt(),
          },
          {
            role: 'user',
            content: buildLumiUserProfileCuratorUserPayload({
              userMessage: input.userText,
              assistantResponse: input.assistantText,
              recentMessages: toRecentMemoryCuratorMessages(input.sessionMessages),
              sourceKind: input.sourceKind,
            }),
          },
        ],
      })

      return lumiUserProfileStore.parseCuratorOutput(buffer)
    }
    catch (error) {
      console.warn('[lumi-user-profile] profile curator failed', error)
      return []
    }
  }

  function appendLumiMemoryDebug(kind: 'memory_search' | 'memory_write', lines: string[], targetSessionId?: string) {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
      return

    const sessionId = targetSessionId ?? activeSessionId.value
    if (!sessionId)
      return

    const text = [`[${kind}]`, ...lines].join('\n')
    chatSession.appendSessionMessage(sessionId, {
      role: 'system',
      content: text,
      id: `lumi-memory-debug-${nanoid()}`,
      createdAt: Date.now(),
    })
  }

  function appendLumiSystemNotice(lines: string[]) {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
      return

    const sessionId = activeSessionId.value
    if (!sessionId)
      return

    const text = ['[system_notice]', ...lines].join('\n')
    chatSession.appendSessionMessage(sessionId, {
      role: 'system',
      content: text,
      id: `lumi-system-notice-${nanoid()}`,
      createdAt: Date.now(),
    })
  }

  async function curateLumiMemoriesWithLlm(input: {
    userText: string
    assistantText: string
    sourceMessageId?: string
    sessionMessages: ChatHistoryItem[]
    retrievedMemories?: Array<{ content: string }>
    topicWindow?: string
    sourceSignals?: string[]
    interaction: ChatInteractionContext
  }) {
    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (!providerId || !modelId) {
      appendLumiMemoryDebug('memory_write', [
        'status: skipped',
        'reason: consciousness model is not configured for memory review',
        'stored: 0',
      ])
      return []
    }

    try {
      const chatProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
      const buffer = await generateSocialLanguageTextWithProvider({
        model: modelId,
        chatProvider,
        purpose: 'memory_curator',
        messages: [
          {
            role: 'system',
            content: buildLumiMemoryCuratorPrompt(),
          },
          {
            role: 'user',
            content: buildLumiMemoryCuratorUserPayload({
              userMessage: input.userText,
              assistantResponse: input.assistantText,
              recentMessages: toRecentMemoryCuratorMessages(input.sessionMessages, input.retrievedMemories),
              topicWindow: input.topicWindow,
              sourceSignals: input.sourceSignals,
              actorId: input.interaction.actorId,
              actorDisplayName: input.interaction.actorDisplayName,
              conversationId: input.interaction.conversationId,
              conversationType: input.interaction.conversationType,
              participantUserIds: input.interaction.participantIds,
            }),
          },
        ],
      })

      return lumiMemoryStore.parseCuratedCandidates(buffer, input.sourceMessageId)
    }
    catch (error) {
      console.warn('[lumi-memory] memory curator failed', error)
      return []
    }
  }

  async function analyzeLumiMemoryTopicWithLlm(input: {
    userText: string
    sessionMessages: ChatHistoryItem[]
    fallback: { query: string, topicWindow: string, topicHints: string[] }
  }) {
    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (!providerId || !modelId)
      return input.fallback

    try {
      const recentMessages = toRecentMemoryContextMessages(input.sessionMessages)
      const chatProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
      const buffer = await generateSocialLanguageTextWithProvider({
        model: modelId,
        chatProvider,
        purpose: 'memory_topic',
        messages: [
          {
            role: 'system',
            content: buildLumiMemoryTopicAnalyzerPrompt(),
          },
          {
            role: 'user',
            content: buildLumiMemoryTopicAnalyzerUserPayload({
              currentMessage: input.userText,
              recentMessages,
            }),
          },
        ],
      })

      const analysis = parseLumiMemoryTopicAnalysis(buffer)
      if (!analysis || analysis.confidence < 0.5)
        return input.fallback

      const mergedHints = [...new Set([...analysis.topicHints, ...input.fallback.topicHints])].slice(0, 8)
      const query = [
        input.userText,
        mergedHints.length ? `Resolved topic hints: ${mergedHints.join(', ')}` : '',
        analysis.topicWindow ? `Recent topic window: ${analysis.topicWindow}` : input.fallback.topicWindow ? `Recent topic window: ${input.fallback.topicWindow}` : '',
      ].filter(Boolean).join('\n')

      return {
        query,
        topicWindow: analysis.topicWindow || input.fallback.topicWindow,
        topicHints: mergedHints,
        storagePrefix: analysis.storagePrefix,
      }
    }
    catch (error) {
      console.warn('[lumi-memory] topic analyzer failed', error)
      return input.fallback
    }
  }

  /**
   * Removes local conversational context without touching Lumi's durable identity,
   * memory, profile, social-language assets, diary, notes, or sticker library.
   *
   * Use when:
   * - Development prompts or generated summaries polluted local private-chat context
   *
   * Expects:
   * - Online server projections are cleared from Server Manager instead
   *
   * Returns:
   * - Counts of deleted local direct sessions after every active runtime turn drains
   */
  async function clearLumiConversationContext() {
    if (chatSession.onlineProjectionActive)
      throw new Error('在线 Lumi 的上下文由服务器管理，请在 Server Manager 中清理。')

    cancelPendingSends()
    await desktopLumiAgentHost.clearConversationContexts()
    useLumiMainTimelineStore().clearAllSummaries()
    useLumiConsciousnessObservabilityStore().clear()

    const sessionIds = Object.entries(chatSession.sessionMetas)
      .filter(([, meta]) =>
        meta.characterId === LUMI_AIRI_CARD_ID
        && meta.conversationType !== 'group',
      )
      .map(([sessionId]) => sessionId)

    for (const sessionId of sessionIds)
      await chatSession.deleteSession(sessionId)

    return {
      deletedSessionCount: sessionIds.length,
    }
  }

  function setDesktopCognitivePort(port: CognitiveContextPort | undefined): void {
    desktopLumiAgentHost.setCognitivePort(port)
  }

  return {
    sending,
    pendingQueuedSendCount,

    ingest,
    ingestOnFork,
    reviewAndApproveLumiUserProfilePending,
    observeExternalGroupLanguage,
    resumeExternalGroupLanguageDrain,
    reprocessMissedExternalGroupLanguage,
    runExternalStickerIntelligence,
    refreshLumiCurrentStateNow: () => runLumiCurrentStateAfterTurn(chatSession.messages, true),
    setDesktopCognitivePort,
    clearLumiConversationContext,
    cancelPendingSends,
    getPendingQueuedSendSnapshot,

    clearHooks: runtime.hooks.clearHooks,

    emitBeforeMessageComposedHooks: runtime.hooks.emitBeforeMessageComposedHooks,
    emitAfterMessageComposedHooks: runtime.hooks.emitAfterMessageComposedHooks,
    emitBeforeSendHooks: runtime.hooks.emitBeforeSendHooks,
    emitAfterSendHooks: runtime.hooks.emitAfterSendHooks,
    emitTokenLiteralHooks: runtime.hooks.emitTokenLiteralHooks,
    emitTokenSpecialHooks: runtime.hooks.emitTokenSpecialHooks,
    emitStreamEndHooks: runtime.hooks.emitStreamEndHooks,
    emitAssistantResponseEndHooks: runtime.hooks.emitAssistantResponseEndHooks,
    emitAssistantMessageHooks: runtime.hooks.emitAssistantMessageHooks,
    emitChatTurnCompleteHooks: runtime.hooks.emitChatTurnCompleteHooks,

    onBeforeMessageComposed: runtime.hooks.onBeforeMessageComposed,
    onAfterMessageComposed: runtime.hooks.onAfterMessageComposed,
    onBeforeSend: runtime.hooks.onBeforeSend,
    onAfterSend: runtime.hooks.onAfterSend,
    onTokenLiteral: runtime.hooks.onTokenLiteral,
    onTokenSpecial: runtime.hooks.onTokenSpecial,
    onStreamEnd: runtime.hooks.onStreamEnd,
    onAssistantResponseEnd: runtime.hooks.onAssistantResponseEnd,
    onAssistantMessage: runtime.hooks.onAssistantMessage,
    onChatTurnComplete: runtime.hooks.onChatTurnComplete,
  }
})

function findLatestUserMessage(messages: ChatHistoryItem[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user')
      return message
  }
  return undefined
}

function toConversationContextMessages(messages: ChatHistoryItem[]): LumiConversationContextMessage[] {
  return messages.flatMap((message, index) => {
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant')
      return []
    const content = extractMessageText(message).trim()
    if (!content || isLumiMemoryDebugMessage(message))
      return []
    return [{
      id: message.id ?? `history:${index}`,
      role: message.role,
      content,
      name: message.actorDisplayName,
    }]
  })
}

/** Returns string-only provider headers without trusting arbitrary config values. */
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length ? Object.fromEntries(entries) : undefined
}

function isLumiMemoryDebugMessage(message: ChatHistoryItem) {
  return isLumiMemoryDebugText(extractMessageText(message))
}

function isLumiMemoryDebugText(text: string) {
  return /^\[(?:memory_search|memory_write|system_notice)\]/.test(text.trim())
}

function shouldConsiderForMemory(text: string) {
  if (text.length < 6)
    return false
  return !/^(?:hi|hello|hey|ok|thanks|\u597D\u7684|\u8C22\u8C22|\u55EF)$/i.test(text.trim())
}

function buildLumiMemorySourceSignals(text: string): string[] {
  const signals: string[] = []
  const normalized = text.trim()

  if (/\bremember that\b|\u8BB0\u4F4F|\u522B\u5FD8\u4E86|\u5E2E\u6211\u8BB0/i.test(normalized))
    signals.push('explicit_remember_request')
  if (/\bI (?:really )?(?:like|dislike|hate|prefer|enjoy)s?\b/i.test(normalized) || /\u6211(?:\u5F88|\u975E\u5E38|\u771F\u7684|\u6700)?(?:\u559C\u6B22|\u4E0D\u559C\u6B22|\u8BA8\u538C|\u5E0C\u671B|\u60F3|\u9700\u8981|\u4E0D\u60F3|\u4E0D\u5E0C\u671B|\u4E0D\u9700\u8981)|\u522B|\u4E0D\u8981|\u5C11/.test(normalized))
    signals.push('preference_keyword')
  if (/\u6211(?:\u73B0\u5728|\u6700\u8FD1|\u76EE\u524D|\u4ECA\u5929|\u6B63\u5728|\u5DF2\u7ECF|\u51C6\u5907|\u6253\u7B97|\u62A5\u540D|\u53C2\u52A0|\u5B66\u4E60|\u7814\u7A76|\u5F00\u53D1|\u6709|\u6CA1\u6709)/.test(normalized))
    signals.push('current_state_keyword')
  if (/\b(?:project|repo|backend|frontend|api|sqlite|fastapi|airi|lumi)\b|\u9879\u76EE|\u540E\u7AEF|\u524D\u7AEF|\u63A5\u53E3|\u8FC1\u79FB|\u63D2\u4EF6|\u8BB0\u5FC6|\u7528\u6237\u753B\u50CF/i.test(normalized))
    signals.push('project_keyword')
  if (/\u6211\u4EEC|\u4E00\u8D77|\u4E0A\u6B21|\u4ECA\u5929|\u6628\u5929|\u90A3\u5929|\u521A\u624D|\u4E4B\u524D|\u524D\u9762/.test(normalized))
    signals.push('relationship_or_shared_event_keyword')
  if (isLumiQuestionLikeMemorySource(normalized))
    signals.push('question_like_source_review_carefully')
  if (analyzeLumiConversationGuard(normalized).isCorrection)
    signals.push('correction_turn_review_carefully')

  return [...new Set(signals)]
}

function shouldConsiderForProfile(text: string) {
  if (text.length < 4)
    return false
  if (/^(?:hi|hello|hey|ok|thanks|\u597D\u7684|\u8C22\u8C22|\u55EF|\u54C8{2,})$/i.test(text.trim()))
    return false
  if (isLumiQuestionLikeMemorySource(text) && !/我现在|我最近|我目前|我今天|我在|压力|难受|崩溃|废了/.test(text))
    return false
  return true
}

function dedupeProfileCandidates<T extends { layer: string, key: string, value: string }>(candidates: T[]) {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const candidate of candidates) {
    const key = `${candidate.layer}:${candidate.key}:${candidate.value.toLowerCase().replace(/\s+/g, ' ').trim()}`
    if (seen.has(key))
      continue
    seen.add(key)
    unique.push(candidate)
  }
  return unique
}

function toRecentMemoryCuratorMessages(messages: ChatHistoryItem[], retrievedMemories: Array<{ content: string }> = []) {
  const recent = messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .filter(message => !isLumiMemoryDebugMessage(message))
    .slice(-8)
    .map(message => ({
      role: message.role,
      content: actorLabeledContent(message, 1200),
    }))
    .filter(message => message.content.trim())

  return [
    ...recent,
    ...retrievedMemories.slice(0, 8).map(memory => ({
      role: 'retrieved_memory',
      content: memory.content.slice(0, 1200),
    })),
  ]
}

function toRecentRelationshipCuratorMessages(messages: ChatHistoryItem[]) {
  return messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .filter(message => !isLumiMemoryDebugMessage(message))
    .slice(-6)
    .map(message => ({
      role: message.role,
      content: sanitizeRelationshipCuratorText(actorLabeledContent(message, 1200)),
    }))
    .filter(message => message.content.trim())
}

function sanitizeRelationshipCuratorText(text: string) {
  return text
    .replace(/[（(]\s*(?:声音|语气|轻声|低声|停顿|沉默|笑|叹气|看着|眨眼|voice|softly|pause|sigh|smile)[^）)]{0,48}[）)]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function toRecentMemoryContextMessages(messages: ChatHistoryItem[]) {
  return messages
    .filter(message => message.role === 'user')
    .filter(message => !isLumiMemoryDebugMessage(message))
    .slice(-8)
    .map(message => ({
      role: message.role,
      content: actorLabeledContent(message, 600),
    }))
    .filter(message => message.content.trim())
}

function actorLabeledContent(
  message: Extract<ChatHistoryItem, { role: 'user' | 'assistant' }>,
  limit: number,
) {
  const content = extractMessageText(message)
  const speaker = message.actorDisplayName || message.actorId
  return `${speaker ? `[Speaker: ${speaker}]\n` : ''}${content}`.slice(0, limit)
}

function suppressDisputedAssistantForCorrectionTurn(messages: Message[]): Message[] {
  const lastAssistantIndex = findLastAssistantMessageIndexBeforeFinalUser(messages)
  if (lastAssistantIndex < 0)
    return messages

  return messages.map((message, index) => {
    if (index !== lastAssistantIndex)
      return message

    return {
      ...message,
      content: '[Previous assistant reply omitted for this model call because the latest user message corrects or rejects it. Do not treat that omitted reply as factual memory, topic evidence, or wording to repeat.]',
    }
  })
}

function findLastAssistantMessageIndexBeforeFinalUser(messages: Message[]) {
  let finalUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      finalUserIndex = index
      break
    }
  }

  if (finalUserIndex < 0)
    return -1

  for (let index = finalUserIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant')
      return index
  }

  return -1
}

function previewText(text: string, maxLength = 120) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized
}

function dedupeLumiMemoryCandidates<T extends { type: string, content: string }>(candidates: T[]) {
  const seen = new Set<string>()
  const unique: T[] = []
  for (const candidate of candidates) {
    const key = `${candidate.type}:${candidate.content.toLowerCase().replace(/\s+/g, ' ').trim()}`
    if (seen.has(key))
      continue
    seen.add(key)
    unique.push(candidate)
  }
  return unique
}

function contextualizeLumiMemoryCandidates<T extends { content: string, tags?: string[] }>(candidates: T[], topicHints: string[], storagePrefix?: string): T[] {
  const primaryTopic = topicHints[0]
  const prefix = storagePrefix || (primaryTopic ? `In the ${primaryTopic.split('/')[0]?.trim() || primaryTopic} context` : '')
  if (!prefix)
    return candidates

  return candidates.map((candidate) => {
    if (!isContextDependentMemoryText(candidate.content))
      return candidate
    if (candidate.content.toLowerCase().includes(prefix.toLowerCase()))
      return candidate

    return {
      ...candidate,
      content: `${prefix}, ${candidate.content}`,
      tags: [...new Set([...(candidate.tags ?? []), ...topicHints.map(hint => hint.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, '_'))])],
    }
  })
}
