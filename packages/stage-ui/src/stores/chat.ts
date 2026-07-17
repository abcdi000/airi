import type { ChatOrchestratorRuntimeState, ChatOrchestratorSendOptions, StreamEvent, StreamOptions } from '@proj-airi/core-agent'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { ChatHistoryItem } from '../types/chat'
import type { LumiUserProfileEntry, LumiUserProfilePendingUpdate, LumiUserProfileSourceKind } from './lumi-user-profile'

import {
  analyzeLumiConversationGuard,
  assessLumiRelationshipFallback,
  buildLumiRelationshipAssessmentPrompt,
  buildLumiMemoryTopicAnalyzerPrompt,
  buildLumiMemoryTopicAnalyzerUserPayload,
  buildLumiContextualMemoryQuery,
  buildLumiMemoryCuratorPrompt,
  buildLumiMemoryCuratorUserPayload,
  mergeLumiRelationshipAssessmentWithSafetyFloor,
  isLumiQuestionLikeMemorySource,
  isContextDependentMemoryText,
  parseLumiRelationshipAssessment,
  parseLumiMemoryTopicAnalysis,
} from '../../../lumi-runtime/src'
import { createChatOrchestratorRuntime } from '@proj-airi/core-agent'
import { IOAttributes, IOEvents, IOSpanNames, IOSubsystems } from '@proj-airi/stage-shared'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { ref, toRaw, watch } from 'vue'

import { useAnalytics } from '../composables'
import { activeTurnSpan, startSpan } from '../composables/use-io-tracer'
import { LUMI_AIRI_CARD_ID } from '../constants/lumi-card'
import { extractMessageText, isCloudSyncableMessage } from '../libs/chat-sync'
import { createLumiContext, createMinecraftContext } from './chat/context-providers'
import { useChatContextStore } from './chat/context-store'
import { useChatSessionStore } from './chat/session-store'
import { useChatStreamStore } from './chat/stream-store'
import { useContextObservabilityStore } from './devtools/context-observability'
import { useLLM } from './llm'
import { useLlmToolsetPromptsStore } from './llm-toolset-prompts'
import { clearLumiMemoryTools, registerLumiMemoryTools } from './lumi-memory-tools'
import {
  buildLumiCurrentStateUpdatePrompt,
  buildLumiCurrentStateUpdateUserPayload,
  parseLumiCurrentStateUpdateOutput,
  useLumiCurrentStateStore,
} from './lumi-current-state'
import { useLumiEmotionStore } from './lumi-emotion'
import { useLumiMainTimelineStore } from './lumi-main-timeline'
import { useLumiMemoryStore } from './lumi-memory'
import {
  buildLumiUserProfilePendingAutoReviewPrompt,
  buildLumiUserProfilePendingAutoReviewUserPayload,
  buildLumiUserProfileCuratorPrompt,
  buildLumiUserProfileCuratorUserPayload,
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
  const lumiCurrentStateStore = useLumiCurrentStateStore()
  const lumiMemoryStore = useLumiMemoryStore()
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
  let ownedActiveTurnSpan: typeof activeTurnSpan.value
  let lumiMemoryToolsRegistered = false

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

  async function streamWithStageAdapters(
    model: string,
    chatProvider: ChatProvider,
    messages: Message[],
    options?: StreamOptions,
  ) {
    let llmTextLength = 0

    const hadExistingTurn = !!activeTurnSpan.value
    if (!hadExistingTurn) {
      const turnSpan = startSpan(IOSpanNames.InteractionTurn)
      activeTurnSpan.value = turnSpan
      ownedActiveTurnSpan = turnSpan
    }

    const llmSpan = startSpan(IOSpanNames.LLMInference, activeTurnSpan.value, {
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
    }
  }

  function syncRuntimeState(state: ChatOrchestratorRuntimeState) {
    sending.value = state.sending
    pendingQueuedSendCount.value = state.pendingQueuedSendCount
  }

  function settleOwnedActiveTurnSpan() {
    if (!ownedActiveTurnSpan)
      return

    ownedActiveTurnSpan.end()
    if (activeTurnSpan.value === ownedActiveTurnSpan)
      activeTurnSpan.value = undefined
    ownedActiveTurnSpan = undefined
  }

  const runtime = createChatOrchestratorRuntime({
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
    onSendSettled: settleOwnedActiveTurnSpan,
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
          content: extractMessageText(message),
        })
      }
    },
    onUserTurnReady: async (event) => {
      const { messageText, sessionMessages, hasAttachments } = event
      await prepareLumiRelationshipAssessment(messageText, sessionMessages)
      if (hasAttachments)
        return
      const autonomousTarget = cardStore.activeCard?.extensions?.airi?.modules?.artistry?.autonomousTarget || 'user'
      if (autonomousTarget === 'user')
        void artistryAutonomousStore.runArtistTask(messageText, toProviderHistory(sessionMessages))
    },
    onAssistantTurnReady: (event) => {
      const { messageText, sessionMessages, hasAttachments, hiddenUserMessage } = event
      const sessionId = getRuntimeEventSessionId(event)
      void runLumiUserProfileAfterTurn(
        messageText,
        sessionMessages,
        hiddenUserMessage ? 'screen_observation' : 'chat',
      )
      void runLumiCurrentStateAfterTurn(sessionMessages)
      if (hiddenUserMessage)
        return
      const artistry = cardStore.activeCard?.extensions?.airi?.modules?.artistry
      if (!hasAttachments && artistry?.autonomousEnabled && artistry?.autonomousTarget === 'assistant')
        void artistryAutonomousStore.runArtistTask(messageText, toProviderHistory(sessionMessages))
      runLumiEmotionAfterTurn(messageText, sessionMessages)
      void runLumiAutoMemoryAfterTurn(messageText, sessionMessages, sessionId)
    },
  })

  watch(sending, (next) => {
    if (runtime.getSending() !== next)
      runtime.setSending(next)
  })

  async function ingest(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    targetSessionId?: string,
  ) {
    return runtime.ingest(sendingMessage, withLumiCorrectionProviderTransform(sendingMessage, options), targetSessionId)
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
  ): ChatOrchestratorSendOptions {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
      return options

    const baseOptions: ChatOrchestratorSendOptions = {
      ...options,
      providerConfig: {
        ...(options.providerConfig ?? {}),
        maxContextMessages: lumiMainTimelineStore.normalizedMaxRecentChatMessagesForPrompt,
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

  function runLumiEmotionAfterTurn(assistantText: string, sessionMessages: ChatHistoryItem[]) {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
      return

    const userMessage = findLatestUserMessage(sessionMessages)
    if (!userMessage)
      return

    const userText = extractMessageText(userMessage).trim()
    lumiEmotionStore.updateAfterTurn({
      userText,
      assistantText,
    })
  }

  async function prepareLumiRelationshipAssessment(userText: string, sessionMessages: ChatHistoryItem[]) {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
      return

    lumiEmotionStore.initialize()
    const state = lumiEmotionStore.currentState
    if (!state)
      return

    const fallback = assessLumiRelationshipFallback(state, userText)
    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (!providerId || !modelId) {
      lumiEmotionStore.setPendingRelationshipAssessment(userText, fallback)
      return
    }

    try {
      const chatProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
      if (!chatProvider) {
        lumiEmotionStore.setPendingRelationshipAssessment(userText, fallback)
        return
      }

      let buffer = ''
      await llmStore.stream(modelId, chatProvider, [
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
      ], {
        onStreamEvent: (event) => {
          if (isTextDelta(event))
            buffer += event.text
        },
      })

      const parsed = parseLumiRelationshipAssessment(buffer)
      const assessment = parsed
        ? mergeLumiRelationshipAssessmentWithSafetyFloor(parsed, fallback, state)
        : fallback
      lumiEmotionStore.setPendingRelationshipAssessment(userText, assessment)
    }
    catch (error) {
      console.warn('[lumi-emotion] relationship curator failed; using fallback', error)
      lumiEmotionStore.setPendingRelationshipAssessment(userText, fallback)
    }
  }

  async function runLumiAutoMemoryAfterTurn(assistantText: string, sessionMessages: ChatHistoryItem[], sessionId: string) {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
      return

    const userMessage = findLatestUserMessage(sessionMessages)
    if (!userMessage)
      return

    const userText = extractMessageText(userMessage).trim()
    if (!shouldConsiderForMemory(userText)) {
      appendLumiMemoryDebug('memory_write', [
        'status: skipped',
        'reason: message too short or routine acknowledgement',
      ])
      return
    }

    appendLumiMemoryDebug('memory_write', [
      'status: checking',
      `source: ${previewText(userText)}`,
    ])

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
      }),
    ], memoryTopic.topicHints, memoryTopicStoragePrefix)

    const uniqueCandidates = dedupeLumiMemoryCandidates(candidates)

    if (!uniqueCandidates.length) {
      appendLumiMemoryDebug('memory_write', [
        'status: no candidate',
        'reviewer: consciousness_model',
        'candidates: 0',
        'stored: 0',
      ])
      return
    }

    const stored = lumiMemoryStore.rememberCandidates(uniqueCandidates, {
      conversationId: sessionId,
      sourceMessageId,
      userId: 'local',
      personaId: LUMI_AIRI_CARD_ID,
    })

    appendLumiMemoryDebug('memory_write', [
      `status: ${stored.length ? 'stored' : 'rejected_or_duplicate'}`,
      memoryTopic.topicWindow ? `topic: ${previewText(memoryTopic.topicWindow)}` : 'topic: none',
      'reviewer: consciousness_model',
      `candidates: ${uniqueCandidates.length}`,
      `stored: ${stored.length}`,
      ...stored.slice(0, 3).map(memory => `- ${memory.type}/${memory.status}: ${previewText(memory.content, 90)}`),
    ])
  }

  async function runLumiUserProfileAfterTurn(
    assistantText: string,
    sessionMessages: ChatHistoryItem[],
    sourceKind: LumiUserProfileSourceKind,
  ) {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
      return
    if (!lumiUserProfileStore.autoUpdateEnabled)
      return

    const userMessage = findLatestUserMessage(sessionMessages)
    if (!userMessage)
      return

    const userText = extractMessageText(userMessage).trim()
    if (!shouldConsiderForProfile(userText)) {
      await runLumiUserProfileBacklogReviewNotice(sessionMessages)
      return
    }

    const deterministic = lumiUserProfileStore.extractDeterministicCandidates(userText)
    const curated = await curateLumiUserProfileWithLlm({
      userText,
      assistantText,
      sessionMessages,
      sourceKind,
    })
    const candidates = dedupeProfileCandidates([...deterministic, ...curated])
    if (!candidates.length) {
      await runLumiUserProfileBacklogReviewNotice(sessionMessages)
      return
    }

    const results = lumiUserProfileStore.applyCandidates(candidates, {
      sourceKind,
      sourceMessageId: userMessage.id,
    })
    const autoReview = await runLumiUserProfilePendingAutoReview(sessionMessages)
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

  async function runLumiCurrentStateAfterTurn(sessionMessages: ChatHistoryItem[], force = false) {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
      return { status: 'skipped:not_lumi' as const }

    await lumiCurrentStateStore.initializePersistence()
    const previousState = { ...lumiCurrentStateStore.currentState }
    const nextTurnCount = previousState.turnCount + 1
    if (!force && nextTurnCount % lumiCurrentStateStore.normalizedUpdateEveryTurns !== 0) {
      await lumiCurrentStateStore.saveCurrentState({
        turnCount: nextTurnCount,
        updatedAt: previousState.updatedAt || new Date().toISOString(),
      })
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
    })
    const sourceMessageIds = sessionMessages
      .slice(-16)
      .map(message => message.id)
      .filter((id): id is string => typeof id === 'string' && !!id)

    try {
      const chatProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
      let buffer = ''
      await llmStore.stream(modelId, chatProvider, [
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
          }),
        },
      ], {
        onStreamEvent: (event) => {
          if (isTextDelta(event))
            buffer += event.text
        },
      })

      const nextState = parseLumiCurrentStateUpdateOutput(buffer, previousState, sourceMessageIds)
      await lumiCurrentStateStore.saveCurrentState(nextState)

      const candidates = lumiCurrentStateStore.buildProfileCandidatesFromState()
      const results = candidates.length
        ? lumiUserProfileStore.applyCandidates(candidates, {
          sourceKind: 'current_state',
          sourceMessageId: sourceMessageIds.at(-1),
        })
        : []

      appendLumiSystemNotice([
        'title: 短期意识状态',
        'status: updated',
        `topics: ${nextState.recentTopics.slice(0, 3).join('；') || 'none'}`,
        `active_projects: ${nextState.activeProjects.length}`,
        `unfinished_tasks: ${nextState.unfinishedTasks.length}`,
        `profile_candidates: ${candidates.length}`,
        `profile_stored: ${results.filter(result => result.status === 'stored').length}`,
        `profile_pending: ${results.filter(result => result.status === 'pending').length}`,
      ])

      return { status: 'updated' as const, state: nextState }
    }
    catch (error) {
      console.warn('[lumi-current-state] update failed', error)
      appendLumiSystemNotice([
        'title: 短期意识状态',
        'status: failed',
        `error: ${error instanceof Error ? error.message : String(error)}`,
      ])
      return { status: 'failed' as const }
    }
  }

  async function runLumiUserProfileBacklogReviewNotice(sessionMessages: ChatHistoryItem[]) {
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
      let buffer = ''
      await llmStore.stream(modelId, chatProvider, [
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
      ], {
        onStreamEvent: (event) => {
          if (isTextDelta(event))
            buffer += event.text
        },
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
      let buffer = ''
      await llmStore.stream(modelId, chatProvider, [
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
      ], {
        onStreamEvent: (event) => {
          if (isTextDelta(event))
            buffer += event.text
        },
      })

      return lumiUserProfileStore.parseCuratorOutput(buffer)
    }
    catch (error) {
      console.warn('[lumi-user-profile] profile curator failed', error)
      return []
    }
  }

  function appendLumiMemoryDebug(kind: 'memory_search' | 'memory_write', lines: string[]) {
    if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
      return

    const sessionId = activeSessionId.value
    if (!sessionId)
      return

    const text = [`[${kind}]`, ...lines].join('\n')
    chatSession.appendSessionMessage(sessionId, {
      role: 'assistant',
      content: text,
      slices: [{ type: 'text', text }],
      tool_results: [],
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
      role: 'assistant',
      content: text,
      slices: [{ type: 'text', text }],
      tool_results: [],
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
      let buffer = ''
      await llmStore.stream(modelId, chatProvider, [
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
          }),
        },
      ], {
        onStreamEvent: (event) => {
          if (isTextDelta(event))
            buffer += event.text
        },
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
      let buffer = ''
      await llmStore.stream(modelId, chatProvider, [
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
      ], {
        onStreamEvent: (event) => {
          if (isTextDelta(event))
            buffer += event.text
        },
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

  return {
    sending,
    pendingQueuedSendCount,

    ingest,
    ingestOnFork,
    reviewAndApproveLumiUserProfilePending,
    refreshLumiCurrentStateNow: () => runLumiCurrentStateAfterTurn(chatSession.messages, true),
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

function isLumiMemoryDebugMessage(message: ChatHistoryItem) {
  return message.role === 'assistant' && isLumiMemoryDebugText(extractMessageText(message))
}

function isLumiMemoryDebugText(text: string) {
  return /^\[(?:memory_search|memory_write|system_notice)\]/.test(text.trim())
}

function shouldConsiderForMemory(text: string) {
  if (text.length < 6)
    return false
  return !/^(hi|hello|hey|ok|thanks|\u597d\u7684|\u8c22\u8c22|\u55ef)$/i.test(text.trim())
}

function buildLumiMemorySourceSignals(text: string): string[] {
  const signals: string[] = []
  const normalized = text.trim()

  if (/\bremember that\b|\u8bb0\u4f4f|\u522b\u5fd8\u4e86|\u5e2e\u6211\u8bb0/i.test(normalized))
    signals.push('explicit_remember_request')
  if (/\bI (?:really )?(?:like|dislike|hate|prefer|enjoy)s?\b/i.test(normalized) || /\u6211(?:\u5f88|\u975e\u5e38|\u771f\u7684|\u6700)?(?:\u559c\u6b22|\u4e0d\u559c\u6b22|\u8ba8\u538c|\u5e0c\u671b|\u60f3|\u9700\u8981|\u4e0d\u60f3|\u4e0d\u5e0c\u671b|\u4e0d\u9700\u8981)|\u522b|\u4e0d\u8981|\u5c11/.test(normalized))
    signals.push('preference_keyword')
  if (/\u6211(?:\u73b0\u5728|\u6700\u8fd1|\u76ee\u524d|\u4eca\u5929|\u6b63\u5728|\u5df2\u7ecf|\u51c6\u5907|\u6253\u7b97|\u62a5\u540d|\u53c2\u52a0|\u5b66\u4e60|\u7814\u7a76|\u5f00\u53d1|\u6709|\u6ca1\u6709)/.test(normalized))
    signals.push('current_state_keyword')
  if (/\b(project|repo|backend|frontend|api|sqlite|fastapi|airi|lumi)\b|\u9879\u76ee|\u540e\u7aef|\u524d\u7aef|\u63a5\u53e3|\u8fc1\u79fb|\u63d2\u4ef6|\u8bb0\u5fc6|\u7528\u6237\u753b\u50cf/i.test(normalized))
    signals.push('project_keyword')
  if (/\u6211\u4eec|\u4e00\u8d77|\u4e0a\u6b21|\u4eca\u5929|\u6628\u5929|\u90a3\u5929|\u521a\u624d|\u4e4b\u524d|\u524d\u9762/.test(normalized))
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
  if (/^(hi|hello|hey|ok|thanks|\u597d\u7684|\u8c22\u8c22|\u55ef|\u54c8\u54c8+)$/i.test(text.trim()))
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
      content: extractMessageText(message).slice(0, 1200),
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
      content: sanitizeRelationshipCuratorText(extractMessageText(message)).slice(0, 1200),
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
      content: extractMessageText(message).slice(0, 600),
    }))
    .filter(message => message.content.trim())
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
