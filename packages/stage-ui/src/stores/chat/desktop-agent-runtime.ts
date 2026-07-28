import type { StreamUsage } from '@proj-airi/core-agent'
import type {
  AgentLanguageReference,
  AgentMemoryReference,
  AgentMemoryScope,
  AgentPersistencePort,
  AgentPersonProfile,
  AgentToolsPort,
  AgentTraceEvent,
  DirectOutboundAdapter,
  DirectPerceptionEnvelope,
  LanguageModelMessage,
  LanguageModelPort,
  LumiAgentContextMessage,
  LumiAgentRuntimeConfig,
  LumiAgentRuntimeMode,
  PersistedSessionState,
  PlannerMessage,
  PlannerModelPort,
  PlannerToolCall,
  PlannerToolDefinition,
  ReplyLanguageReferences,
  ReplyPolicyPort,
  SocialLanguagePort,
  ToolExecutionMode,
  ToolRiskLevel,
  ToolSideEffectType,
} from '@proj-airi/lumi-agent-runtime'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { AssistantMessage, Message, Tool } from '@xsai/shared-chat'

import type {
  LanguageDecisionLog,
  LumiMemoryFragment,
  LumiReplyIntent,
  SocialLanguageTurnContext,
} from '../../../../lumi-runtime/src'
import type { ChatHistoryItem, ChatInteractionContext } from '../../types/chat'

import localforage from 'localforage'

import { errorMessageFrom } from '@moeru/std'
import {
  buildDefaultPlannerSystemPrompt,
  buildDefaultReplyerSystemPrompt,
  LumiAgentRuntime,
  parsePlannerToolArguments,
  PlannerResponseFormatError,
} from '@proj-airi/lumi-agent-runtime'
import { chat } from '@xsai/shared-chat'
import { nanoid } from 'nanoid'
import { toRaw } from 'vue'

import {
  applyPreciseExpressionSelection,
  buildExpressionSelectorMessages,
  buildSocialLanguageFeedbackMessages,
  parseSocialLanguageFeedbackOutput,
  retrieveExpressionCandidates,
  selectExpressionsLocally,
  selectPlannerSocialBehaviors,
  selectRelevantJargon,
  selectSocialBehaviors,
} from '../../../../lumi-runtime/src'
import { LUMI_AIRI_CARD_ID } from '../../constants/lumi-card'
import { extractMessageText } from '../../libs/chat-sync'
import { useLLM } from '../llm'
import { useLlmToolsStore } from '../llm-tools'
import { useLumiAgentRuntimeSettingsStore } from '../lumi-agent-runtime-settings'
import { useLumiConsciousnessObservabilityStore } from '../lumi-consciousness-observability'
import { useLumiCurrentStateStore } from '../lumi-current-state'
import { useLumiEmotionStore } from '../lumi-emotion'
import { useLumiIdentityStore } from '../lumi-identity'
import { useLumiMemoryStore } from '../lumi-memory'
import { useLumiSocialLanguageStore } from '../lumi-social-language'
import { useLumiToolMeshStore } from '../lumi-tool-mesh'
import { useLumiUserProfileStore } from '../lumi-user-profile'
import { useAiriCardStore } from '../modules/airi-card'
import { useConsciousnessStore } from '../modules/consciousness'
import { useProvidersStore } from '../providers'
import { projectReplyStream } from './reply-stream-projection'
import { registerRuntimeTools } from './runtimeToolAdapter'
import { useChatSessionStore } from './session-store'
import { useChatStreamStore } from './stream-store'

interface PlannerResponseDocument {
  model?: string
  choices?: Array<{
    message?: AssistantMessage & {
      reasoning_content?: string
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }
}

type DeepSeekThinkingMode = 'auto' | 'enabled' | 'disabled'

export interface DesktopAgentIngestInput {
  text: string
  sessionId: string
  interaction: ChatInteractionContext
  runtimeConfig: LumiAgentRuntimeConfig
  mode: Exclude<LumiAgentRuntimeMode, 'legacy'>
  /** Shadow execution never appends user or assistant messages to the visible timeline. */
  visible: boolean
  /** Privacy-safe action progress forwarded to an authenticated remote transport. */
  onToolProgress?: (event: Extract<AgentTraceEvent, { type: 'tool_execution' }>) => void | Promise<void>
}

const desktopAgentStorage = localforage.createInstance({
  name: 'lumi-agent-runtime',
  storeName: 'direct_sessions',
})

/**
 * Desktop host for the platform-neutral Lumi Agent Runtime.
 *
 * It adapts existing Pinia-owned identity, memory, social-language, Tool Mesh,
 * provider, observability, and chat stores. None of those authoritative
 * subsystems are duplicated here.
 */
export class DesktopLumiAgentHost {
  readonly #runtimes = new Map<string, LumiAgentRuntime>()
  readonly #seedExclusions = new Map<string, string>()
  readonly #toolProgressListeners = new Map<string, DesktopAgentIngestInput['onToolProgress']>()
  #clearTask?: Promise<void>

  async ingest(input: DesktopAgentIngestInput) {
    await this.#clearTask
    const sourceMessageId = nanoid()
    const envelope: DirectPerceptionEnvelope = {
      eventId: sourceMessageId,
      conversationId: input.sessionId,
      personId: input.interaction.actorId,
      platform: input.interaction.platform ?? 'lumi-desktop',
      platformInstanceId: input.interaction.remoteDeviceId ?? 'local-desktop',
      externalUserId: input.interaction.actorId,
      timestamp: Date.now(),
      text: input.text,
      segments: [{ type: 'text', text: input.text }],
      attachments: [],
      sourceMessageId,
      participantPersonIds: [...input.interaction.participantIds],
      conversationType: 'direct',
    }
    this.#seedExclusions.set(this.#persistenceKey(input.mode, input.sessionId), sourceMessageId)
    if (input.visible)
      appendVisibleUserMessage(envelope, input.interaction)

    const runtime = this.#runtime(input)
    if (input.onToolProgress)
      this.#toolProgressListeners.set(input.sessionId, input.onToolProgress)
    try {
      return await runtime.ingestDirect(envelope)
    }
    finally {
      if (input.visible)
        resetVisibleReplyStream(input.sessionId)
      this.#seedExclusions.delete(this.#persistenceKey(input.mode, input.sessionId))
      if (this.#toolProgressListeners.get(input.sessionId) === input.onToolProgress)
        this.#toolProgressListeners.delete(input.sessionId)
    }
  }

  /**
   * Clears every persisted and in-memory desktop Agent Runtime conversation.
   *
   * Use when:
   * - The user explicitly resets polluted local conversation context
   *
   * Expects:
   * - The host caller separately clears visible Lumi chat sessions, otherwise
   *   the next runtime may seed itself from those messages again
   *
   * Returns:
   * - Resolves after active turns drain and the local runtime store is empty
   */
  async clearConversationContexts(): Promise<void> {
    if (this.#clearTask)
      return this.#clearTask

    const task = (async () => {
      await Promise.all([...this.#runtimes.values()].map(runtime => runtime.drain()))
      this.#runtimes.clear()
      this.#seedExclusions.clear()
      await desktopAgentStorage.clear()
    })()
    this.#clearTask = task
    try {
      await task
    }
    finally {
      if (this.#clearTask === task)
        this.#clearTask = undefined
    }
  }

  #runtime(input: DesktopAgentIngestInput): LumiAgentRuntime {
    const cardStore = useAiriCardStore()
    const personaPrompt = cardStore.agentRuntimeIdentityAnchor || '名字：Lumi'
    const key = [
      input.mode,
      input.sessionId,
      useConsciousnessStore().activeProvider,
      useConsciousnessStore().activeModel,
      stableHash(personaPrompt),
      input.runtimeConfig.promptLoggingEnabled ? 'prompt-log' : 'prompt-private',
    ].join(':')
    let runtime = this.#runtimes.get(key)
    if (runtime)
      return runtime

    const models = createDesktopModelPorts(input.sessionId, input.visible)
    runtime = new LumiAgentRuntime({
      config: {
        ...input.runtimeConfig,
        runtimeMode: input.mode,
        plannerSystemPrompt: buildDefaultPlannerSystemPrompt(personaPrompt),
        replyerSystemPrompt: buildDefaultReplyerSystemPrompt(personaPrompt),
      },
      plannerModel: models.plannerModel,
      languageModel: models.languageModel,
      persistence: this.#persistence(input.mode),
      identity: createDesktopIdentityPort(),
      memory: createDesktopMemoryPort(),
      replyPolicy: createDesktopReplyPolicy(),
      socialLanguage: createDesktopSocialLanguagePort(models.languageModel, input.mode === 'shadow'),
      tools: createDesktopToolsPort(),
      trace: {
        record: async (event) => {
          console.info('[lumi-agent-runtime:desktop]', event)
          if (input.visible)
            appendDesktopAgentToolNotice(input.sessionId, event)
          if (event.type === 'tool_execution')
            await this.#toolProgressListeners.get(input.sessionId)?.(event)
        },
      },
      outboundAdapter: createDesktopOutboundAdapter(input.visible),
      outboundAudit: {
        record(audit) {
          console.warn('[lumi-agent-runtime:desktop:outbound-audit]', audit)
        },
      },
    })
    this.#runtimes.set(key, runtime)
    return runtime
  }

  #persistence(mode: Exclude<LumiAgentRuntimeMode, 'legacy'>): AgentPersistencePort {
    return {
      loadSession: async (conversationId) => {
        const key = this.#persistenceKey(mode, conversationId)
        const stored = await desktopAgentStorage.getItem<PersistedSessionState>(key)
        if (stored)
          return stored
        return seedSessionFromVisibleHistory(
          conversationId,
          this.#seedExclusions.get(key),
        )
      },
      saveSession: async (state) => {
        await desktopAgentStorage.setItem(this.#persistenceKey(mode, state.conversationId), cloneData(state))
      },
      listWaitingSessionIds: async () => {
        const prefix = `${mode}:`
        const waiting: string[] = []
        await desktopAgentStorage.iterate<PersistedSessionState, void>((state, key) => {
          if (key.startsWith(prefix) && state.waitState)
            waiting.push(state.conversationId)
        })
        return waiting
      },
    }
  }

  #persistenceKey(mode: Exclude<LumiAgentRuntimeMode, 'legacy'>, conversationId: string): string {
    return `${mode}:${conversationId}`
  }
}

function createDesktopModelPorts(conversationId: string, visible: boolean): {
  plannerModel: PlannerModelPort
  languageModel: LanguageModelPort
} {
  return {
    plannerModel: {
      async generateStep(input) {
        const context = await activeModelContext()
        const requestedToolChoice = input.tools.length
          ? (input.toolChoice ?? 'required')
          : undefined
        const deepSeekThinkingActive = context.providerId === 'deepseek'
          && context.deepSeekThinkingMode !== 'disabled'
        const trace = beginTrace(
          'planner',
          context.model,
          context.providerId,
          conversationId,
          input.messages,
          {
            toolCount: input.tools.length,
            requestedToolChoice,
            effectiveToolChoice: requestedToolChoice
              ? deepSeekThinkingActive
                ? 'omitted'
                : requestedToolChoice
              : undefined,
            thinkingMode: context.providerId === 'deepseek'
              ? context.deepSeekThinkingMode
              : undefined,
          },
        )
        try {
          const response = await chat({
            ...context.chatProvider.chat(context.model),
            abortSignal: input.signal,
            messages: input.messages.map(message => toXsaiMessage(
              message,
              deepSeekThinkingActive,
            )),
            tools: input.tools.length ? input.tools.map(toXsaiTool) : undefined,
            toolChoice: input.tools.length
              ? (input.toolChoice ?? 'required')
              : undefined,
          })
          const document = await response.json() as PlannerResponseDocument
          const message = document.choices?.[0]?.message
          if (!message)
            throw new Error('Desktop Planner returned no message')
          const content = assistantText(message)
          const toolCalls = parseToolCalls(message)
          const observableResult = formatPlannerResult(content, toolCalls)
          if (observableResult)
            trace.append(observableResult)
          if (document.usage)
            trace.usage(document.usage)
          trace.complete()
          return {
            content,
            reasoning: message.reasoning ?? message.reasoning_content,
            toolCalls,
            usage: {
              inputTokens: document.usage?.prompt_tokens,
              outputTokens: document.usage?.completion_tokens,
              cacheHitTokens: document.usage?.prompt_cache_hit_tokens,
              cacheMissTokens: document.usage?.prompt_cache_miss_tokens,
            },
            modelName: document.model ?? context.model,
          }
        }
        catch (error) {
          trace.fail(error)
          throw error
        }
      },
    },
    languageModel: {
      async generate(messages, purpose, signal, options) {
        const context = await activeModelContext()
        const trace = beginTrace(observabilityPurpose(purpose), context.model, context.providerId, conversationId, messages)
        const projectsVisibleReply = visible && (purpose === 'replyer' || purpose === 'replyer_retry')
        let result = ''
        if (projectsVisibleReply)
          beginVisibleReplyStream(conversationId)
        try {
          await useLLM().stream(context.model, context.chatProvider, messages as Message[], {
            abortSignal: signal,
            maxOutputTokens: options?.maxOutputTokens,
            supportsTools: false,
            waitForTools: false,
            maxSteps: 1,
            tools: [],
            toolTransform: () => [],
            onUsage(usage) {
              trace.usage(usage)
            },
            onStreamEvent(event) {
              if (event.type !== 'text-delta')
                return
              result += event.text
              trace.append(event.text)
              if (projectsVisibleReply)
                updateVisibleReplyStream(conversationId, projectReplyStream(result))
            },
          })
          trace.complete()
          return result
        }
        catch (error) {
          if (projectsVisibleReply)
            resetVisibleReplyStream(conversationId)
          trace.fail(error)
          throw error
        }
      },
    },
  }
}

async function activeModelContext() {
  const consciousness = useConsciousnessStore()
  const providerId = consciousness.activeProvider
  const model = consciousness.activeModel
  if (!providerId || !model)
    throw new Error('Lumi consciousness provider and model must be configured')
  const providers = useProvidersStore()
  const chatProvider = await providers.getProviderInstance<ChatProvider>(providerId)
  const providerConfig = providers.getProviderConfig(providerId)
  const configuredThinkingMode = providerConfig?.thinkingMode
  const deepSeekThinkingMode: DeepSeekThinkingMode = configuredThinkingMode === 'enabled'
    || configuredThinkingMode === 'disabled'
    ? configuredThinkingMode
    : 'auto'
  return { providerId, model, chatProvider, deepSeekThinkingMode }
}

function createDesktopIdentityPort() {
  return {
    async getPersonProfile(input: {
      personId: string
      conversationId: string
      viewerPersonId: string
    }): Promise<AgentPersonProfile | undefined> {
      if (input.personId !== input.viewerPersonId)
        return undefined
      const identity = useLumiIdentityStore()
      const person = identity.users.find(candidate => candidate.id === input.personId)
      if (!person)
        return undefined
      const profile = useLumiUserProfileStore()
      await profile.ensureUserProfileLoaded(input.personId)
      const current = useLumiCurrentStateStore()
      await current.ensureUserStateLoaded(input.personId)
      const emotion = useLumiEmotionStore()
      emotion.initialize(input.personId)
      return {
        personId: person.id,
        displayName: person.displayName,
        facts: profile.activeEntries.map(entry => `${entry.key}: ${entry.value}`),
        relationshipState: emotion.getStateForUser(input.personId)?.relationship
          ? JSON.stringify(emotion.getStateForUser(input.personId)?.relationship)
          : undefined,
        shortTermState: current.getStateForUser(input.personId)
          ? JSON.stringify(current.getStateForUser(input.personId))
          : undefined,
        emotionState: emotion.getStateForUser(input.personId)
          ? JSON.stringify(emotion.getStateForUser(input.personId))
          : undefined,
      }
    },
  }
}

function createDesktopMemoryPort() {
  return {
    async query(input: {
      query: string
      personId: string
      conversationId: string
      participantPersonIds: readonly string[]
      scopes?: readonly AgentMemoryScope[]
      limit: number
      signal?: AbortSignal
    }): Promise<readonly AgentMemoryReference[]> {
      if (input.signal?.aborted)
        throw input.signal.reason ?? new Error('Desktop memory query aborted')
      const store = useLumiMemoryStore()
      await store.ensureUserMemoryLoaded(input.personId)
      const result = await store.retrieveSemantic({
        query: input.query,
        userId: input.personId,
        viewerUserId: input.personId,
        personaId: LUMI_AIRI_CARD_ID,
        limit: input.limit,
        conversationType: 'direct',
        conversationId: input.conversationId,
        participantUserIds: [...input.participantPersonIds],
      })
      const scopes = input.scopes ? new Set(input.scopes) : undefined
      return result.rankedMemories
        .map(item => memoryReference(item.memory))
        .filter(item => !scopes || scopes.has(item.scope))
        .slice(0, input.limit)
    },
  }
}

function createDesktopReplyPolicy(): ReplyPolicyPort {
  return {
    async resolveIntent({ proposal, envelope }): Promise<LumiReplyIntent> {
      const emotionStore = useLumiEmotionStore()
      emotionStore.initialize(envelope.personId)
      const state = emotionStore.getStateForUser(envelope.personId)
      const gate = emotionStore.previewRelationshipGate(envelope.text ?? '', envelope.personId)
      const refusalRequired = gate?.refusalRequired === true
      return {
        shouldReply: proposal.replyAct !== 'stay_silent',
        targetMessageId: proposal.targetMessageId,
        replyAct: proposal.replyAct,
        semanticGoal: proposal.semanticGoal,
        keyPoints: [...proposal.keyPoints],
        referenceInfo: [...proposal.referenceInfo],
        attitude: {
          stance: gate?.action,
          willingnessToHelp: refusalRequired ? 'refuse' : 'normal',
        },
        emotion: {
          primary: gate?.suggestedExpression ?? state?.dominantEmotion ?? 'neutral',
          intensity: state
            ? Math.max(state.mood.defensiveness, state.mood.sadness, state.mood.warmth)
            : 0.35,
        },
        defenseState: {
          active: Boolean(gate?.blocked || state?.relationship.unresolvedConflict),
          level: state?.mood.defensiveness,
          reason: gate?.reason,
          refusalRequired,
        },
        expressionIntent: {
          focus: proposal.expressionIntent?.focus ?? proposal.semanticGoal,
          scene: proposal.expressionIntent?.scene ?? 'private_chat',
          tone: proposal.expressionIntent?.tone ?? 'natural',
          desiredLength: proposal.expressionIntent?.desiredLength ?? 'short',
          preferredActs: [...(proposal.expressionIntent?.preferredActs ?? [])],
          avoid: [
            ...(proposal.expressionIntent?.avoid ?? []),
            '固定套话',
            '逐字重复以前的回复',
          ],
        },
        immutableConstraints: [
          '不得泄露其他人的私聊、人物资料或私密记忆。',
          ...(refusalRequired
            ? ['保持当前拒绝边界，但为本轮生成新的自然措辞。']
            : []),
        ],
      }
    },
    async forbiddenPrivacyTokens() {
      return []
    },
  }
}

function createDesktopSocialLanguagePort(model: LanguageModelPort, readOnly: boolean): SocialLanguagePort {
  return {
    async plannerReferences({ envelope, limit }) {
      const store = useLumiSocialLanguageStore()
      await store.initialize()
      if (!store.config.enabled)
        return []
      const behaviors = selectPlannerSocialBehaviors(store.snapshot.behaviors, {
        personId: envelope.personId,
        conversationId: envelope.conversationId,
        platform: envelope.platform,
        conversationType: 'direct',
        currentUserText: envelope.text ?? '',
      }, limit)
      return behaviors.map<AgentLanguageReference>(candidate => ({
        id: candidate.behavior.id,
        kind: 'behavior',
        content: `${candidate.behavior.situation} -> ${candidate.behavior.action}`,
        confidence: candidate.behavior.confidence,
      }))
    },
    async replyReferences({ envelope, intent, limit, expressionSelectorEnabled }) {
      const store = useLumiSocialLanguageStore()
      await store.initialize()
      if (!store.config.enabled)
        return emptyLanguageReferences()
      const context = socialTurnContext(envelope, intent)
      const broad = retrieveExpressionCandidates(store.snapshot.expressions, context, store.config)
      let expressions = selectExpressionsLocally(broad, context, store.config)
      if (expressionSelectorEnabled && store.config.preciseSelectorEnabled && broad.length) {
        try {
          expressions = applyPreciseExpressionSelection(
            await model.generate(
              buildExpressionSelectorMessages(context, broad.map(item => item.expression), limit),
              'expression_selector',
            ),
            broad,
            limit,
          ) ?? expressions
        }
        catch {
          // Precise model selection is optional; deterministic retrieval remains valid.
        }
      }
      const behaviors = selectSocialBehaviors(store.snapshot.behaviors, context, Math.min(2, limit))
      const jargon = selectRelevantJargon(store.snapshot.jargon, context, Math.min(4, limit))
      return {
        expressions: expressions.slice(0, limit).map(item => ({
          id: item.expression.id,
          kind: 'expression' as const,
          content: [item.expression.phrase, item.expression.situation, item.expression.pragmaticFunction].filter(Boolean).join(' | '),
          confidence: item.expression.confidence,
        })),
        behaviors: behaviors.map(item => ({
          id: item.behavior.id,
          kind: 'behavior' as const,
          content: `${item.behavior.situation} -> ${item.behavior.action}`,
          confidence: item.behavior.confidence,
        })),
        jargon: jargon.map(item => ({
          id: item.id,
          kind: 'jargon' as const,
          content: `${item.term}: ${item.meanings.map(meaning => meaning.meaning).join(' / ')}`,
          confidence: Math.max(0, ...item.meanings.map(meaning => meaning.confidence)),
        })),
      }
    },
    async observeDirectFeedback({ envelope }) {
      if (readOnly)
        return
      const store = useLumiSocialLanguageStore()
      const pending = store.pendingFeedbackDecision(envelope.conversationId, envelope.personId)
      if (!pending || !store.config.feedbackLearningEnabled)
        return
      try {
        const feedback = parseSocialLanguageFeedbackOutput(await model.generate(
          buildSocialLanguageFeedbackMessages({
            userText: envelope.text ?? '',
            decision: pending,
          }),
          'feedback',
        ))
        await store.applyFeedbackFromUser({
          conversationId: envelope.conversationId,
          personId: envelope.personId,
          feedback,
        })
      }
      catch {
        // Feedback curation must not block the user's direct reply.
      }
    },
    async recordSentReply({ envelope, intent, reply, selectedReferenceIds, replyerPromptSnapshot }) {
      if (readOnly)
        return
      const store = useLumiSocialLanguageStore()
      const selected = new Set(selectedReferenceIds)
      const expressions = store.snapshot.expressions.filter(item => selected.has(item.id))
      const behaviors = store.snapshot.behaviors.filter(item => selected.has(item.id))
      const jargon = store.snapshot.jargon.filter(item => selected.has(item.id))
      const decision: LanguageDecisionLog = {
        id: nanoid(),
        timestamp: Date.now(),
        personId: envelope.personId,
        conversationId: envelope.conversationId,
        platform: envelope.platform,
        plannerIntent: intent,
        retrievedExpressions: expressions.map(item => item.id),
        selectedExpressions: expressions.map(item => item.id),
        realizedExpressions: reply.appliedExpressionIds ?? [],
        selectedExpressionReasons: Object.fromEntries(expressions.map(item => [item.id, ['shared_agent_runtime:selected']])),
        selectedBehaviors: behaviors.map(item => item.id),
        selectedJargon: jargon.map(item => item.id),
        generatedReply: reply,
        actuallySentReply: reply,
        replyerPromptSnapshot: replyerPromptSnapshot
          ? cloneData([...replyerPromptSnapshot])
          : undefined,
        emotionState: intent.emotion,
        defenseState: intent.defenseState,
        relationshipSnapshot: intent.attitude,
        validator: {
          passed: true,
          attempts: 1,
          issues: [],
          fallbackUsed: false,
        },
      }
      await store.recordDecision(decision)
    },
  }
}

function createDesktopToolsPort(): AgentToolsPort {
  return {
    async registerTools(registry, context) {
      const mesh = useLumiToolMeshStore()
      mesh.initializeCoreTools()
      for (const definition of mesh.implementedDefinitions) {
        if (registry.get(definition.id))
          continue
        registry.register({
          name: definition.id,
          description: definition.description,
          inputSchema: schemaRecord(definition.inputSchema),
          provider: 'desktop-tool-mesh',
          visibility: isPrimaryDesktopTool(definition.id) ? 'visible' : 'deferred',
          stage: 'planner',
          chatScope: 'direct',
          riskLevel: toolRisk(definition.riskLevel),
          executionMode: toolExecutionMode(definition.executionMode),
          sideEffectType: toolSideEffect(definition),
          idempotencyPolicy: 'optional',
          requiredScopes: [],
          async handler({ invocation }) {
            const result = await mesh.executeTool(invocation.toolName, { ...invocation.arguments }, {
              scope: 'chat',
              source: 'shared_agent_runtime',
              conversationId: context.conversationId,
              conversationType: 'direct',
              actorId: context.personId,
              participantIds: [...context.participantPersonIds],
            })
            return {
              success: result.status === 'success',
              output: result.result,
              errorCode: result.status === 'success' ? undefined : result.status,
              errorMessage: result.error ?? result.blockedReason,
            }
          },
        })
      }

      const llmTools = useLlmToolsStore()
      await llmTools.awaitPendingRegistrations()
      registerRuntimeTools(registry, toRaw(llmTools.toolsByProvider), context)
    },
  }
}

function createDesktopOutboundAdapter(visible: boolean): DirectOutboundAdapter {
  const result = () => ({ messageId: nanoid(), timestamp: Date.now() })
  if (!visible) {
    return {
      sendText: async () => result(),
      sendImage: async () => result(),
      sendSticker: async () => result(),
      sendVoice: async () => result(),
      sendAt: async () => result(),
      sendQuote: async () => result(),
    }
  }
  return {
    async sendText(payload) {
      if (payload.delayMs)
        await delay(payload.delayMs)
      const delivery = result()
      useChatSessionStore().appendSessionMessage(payload.conversationId, {
        id: delivery.messageId,
        role: 'assistant',
        content: payload.text,
        slices: [{ type: 'text', text: payload.text, source: 'assistant' }],
        tool_results: [],
        actorId: LUMI_AIRI_CARD_ID,
        actorDisplayName: 'Lumi',
        createdAt: delivery.timestamp,
      })
      resetVisibleReplyStream(payload.conversationId)
      return delivery
    },
    async sendImage(payload) {
      const delivery = result()
      const url = payload.localPath ?? payload.sourceUrl
      if (!url)
        throw new Error('Desktop image output has no path or URL')
      useChatSessionStore().appendSessionMessage(payload.conversationId, {
        id: delivery.messageId,
        role: 'assistant',
        content: payload.caption ?? '',
        slices: [{ type: 'image', url, alt: payload.caption }],
        tool_results: [],
        actorId: LUMI_AIRI_CARD_ID,
        actorDisplayName: 'Lumi',
        createdAt: delivery.timestamp,
      })
      return delivery
    },
    async sendSticker(payload) {
      const delivery = result()
      useChatSessionStore().appendSessionMessage(payload.conversationId, {
        id: delivery.messageId,
        role: 'assistant',
        content: '',
        slices: [{ type: 'image', url: payload.localPath, alt: 'Lumi sticker' }],
        tool_results: [],
        actorId: LUMI_AIRI_CARD_ID,
        actorDisplayName: 'Lumi',
        createdAt: delivery.timestamp,
      })
      return delivery
    },
    async sendVoice() {
      throw new Error('Desktop shared runtime voice output is generated by the existing local TTS path')
    },
    async sendAt() {
      return result()
    },
    async sendQuote() {
      return result()
    },
  }
}

function appendVisibleUserMessage(envelope: DirectPerceptionEnvelope, interaction: ChatInteractionContext): void {
  useChatSessionStore().appendSessionMessage(envelope.conversationId, {
    id: envelope.sourceMessageId,
    role: 'user',
    content: envelope.text ?? '',
    actorId: interaction.actorId,
    actorDisplayName: interaction.actorDisplayName,
    createdAt: envelope.timestamp,
  })
}

function appendDesktopAgentToolNotice(sessionId: string, event: AgentTraceEvent): void {
  if (event.type !== 'tool_execution' || event.toolName === 'reply')
    return
  const status = {
    started: 'running',
    succeeded: 'completed',
    failed: 'failed',
    skipped: 'skipped',
  }[event.status]
  const memoryTool = /memory|current_state|user_profile|emotion_state/i.test(event.toolName)
  const kind = memoryTool ? 'memory_search' : 'system_notice'
  const title = memoryTool ? '记忆与状态查询' : '工具调用'
  useChatSessionStore().appendSessionMessage(sessionId, {
    id: `agent-tool:${event.turnId}:${event.stepId}:${event.status}`,
    role: 'system',
    content: [
      `[${kind}]`,
      `title: ${title}`,
      `status: ${status}`,
      'source: agent_runtime',
      `activity: ${event.toolName}`,
      ...(event.durationMs === undefined ? [] : [`duration_ms: ${event.durationMs}`]),
      ...(event.errorCode ? [`error: ${event.errorCode}`] : []),
    ].join('\n'),
    createdAt: event.timestamp,
  })
}

function beginVisibleReplyStream(conversationId: string): void {
  if (useChatSessionStore().activeSessionId !== conversationId)
    return
  useChatStreamStore().beginStream()
}

function updateVisibleReplyStream(conversationId: string, text: string): void {
  if (useChatSessionStore().activeSessionId !== conversationId)
    return
  const stream = useChatStreamStore()
  const createdAt = stream.streamingMessage.createdAt ?? Date.now()
  stream.streamingMessage = {
    role: 'assistant',
    content: text,
    slices: text ? [{ type: 'text', text }] : [],
    tool_results: [],
    createdAt,
  }
}

function resetVisibleReplyStream(conversationId: string): void {
  if (useChatSessionStore().activeSessionId !== conversationId)
    return
  useChatStreamStore().resetStream()
}

function seedSessionFromVisibleHistory(
  conversationId: string,
  excludedMessageId?: string,
): PersistedSessionState {
  const messages = useChatSessionStore().getSessionMessages(conversationId).filter(message => message.id !== excludedMessageId)
  return {
    conversationId,
    contextEpoch: 0,
    summaryVersion: 0,
    stablePrefixHash: '',
    dialogueSegmentId: 'dialogue:0',
    generation: 0,
    history: dialogueHistory(messages),
    completedEvents: [],
  }
}

function dialogueHistory(messages: readonly ChatHistoryItem[]): LumiAgentContextMessage[] {
  return messages.flatMap((message): LumiAgentContextMessage[] => {
    const text = extractMessageText(message).trim()
    if (!text || !message.id || message.role === 'error' || message.role === 'system' || message.role === 'tool')
      return []
    if (message.role === 'user') {
      return [{
        id: `user:${message.id}`,
        kind: 'dialogue_user',
        messageId: message.id,
        personId: message.actorId ?? useLumiIdentityStore().activeUserId,
        text,
        segments: [{ type: 'text', text }],
        attachments: [],
        timestamp: message.createdAt ?? Date.now(),
        countInContext: true,
        remainingUses: null,
        source: 'lumi-desktop-history',
        visibility: 'both',
        provenance: {
          origin: 'desktop_chat_history',
          sourceIds: [message.id],
        },
      }]
    }
    return [{
      id: `assistant:${message.id}`,
      kind: 'dialogue_assistant',
      messageIds: [message.id],
      textSegments: [text],
      appliedExpressionIds: [],
      timestamp: message.createdAt ?? Date.now(),
      countInContext: true,
      remainingUses: null,
      source: 'lumi',
      visibility: 'both',
      provenance: {
        origin: 'desktop_chat_history',
        sourceIds: [message.id],
      },
    }]
  })
}

function memoryReference(memory: LumiMemoryFragment): AgentMemoryReference {
  return {
    id: memory.id,
    content: memory.content,
    scope: memoryScope(memory),
    status: memory.status,
    confidence: memory.confidence,
    provenance: {
      sourceMessageId: memory.sourceMessageId,
      sourceActorId: memory.sourceActorId,
      sourceConversationType: memory.sourceConversationType,
      classificationReason: memory.classificationReason,
    },
    authorizationReason: memory.disclosureReason ?? memory.classificationReason ?? 'desktop_memory_scope_policy',
  }
}

function memoryScope(memory: LumiMemoryFragment): AgentMemoryScope {
  if (memory.scope === 'private')
    return 'private_person'
  if (memory.scope === 'relationship')
    return 'direct_shared'
  if (memory.scope === 'group')
    return 'group_public'
  if (memory.ownerType === 'lumi')
    return 'lumi_self'
  return 'global'
}

function socialTurnContext(envelope: DirectPerceptionEnvelope, intent: LumiReplyIntent): SocialLanguageTurnContext {
  return {
    now: Date.now(),
    personId: envelope.personId,
    conversationId: envelope.conversationId,
    platform: envelope.platform,
    conversationType: 'direct',
    currentUserText: envelope.text ?? '',
    replyIntent: intent,
    emotionTag: intent.emotion.primary,
    emotionIntensity: intent.emotion.intensity,
    defenseActive: intent.defenseState.active,
    refusalRequired: intent.defenseState.refusalRequired,
    recentAssistantTexts: [],
  }
}

function emptyLanguageReferences(): ReplyLanguageReferences {
  return { expressions: [], behaviors: [], jargon: [] }
}

function toXsaiMessage(
  message: PlannerMessage,
  deepSeekThinkingProtocol = false,
): Message {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
    }
  }
  if (message.role !== 'assistant')
    return { role: message.role, content: message.content }
  const toolCalls = message.toolCalls?.map(call => ({
    id: call.id,
    type: 'function' as const,
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    },
  }))
  const reasoning = message.reasoning
    ? deepSeekThinkingProtocol && toolCalls?.length
      ? { reasoning_content: message.reasoning }
      : { reasoning: message.reasoning }
    : {}
  return {
    role: 'assistant',
    content: message.content,
    ...reasoning,
    ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
  }
}

function toXsaiTool(definition: PlannerToolDefinition): Tool {
  return {
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description,
      parameters: { ...definition.inputSchema },
    },
    execute: () => {
      throw new Error('Planner tool execution belongs to LumiAgentRuntime')
    },
  }
}

function assistantText(message: AssistantMessage): string {
  if (typeof message.content === 'string')
    return message.content
  return message.content?.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') ?? ''
}

function parseToolCalls(message: AssistantMessage): PlannerToolCall[] {
  return (message.tool_calls ?? []).map((call) => {
    const name = call.function.name?.trim()
    if (!name)
      throw new Error(`Planner tool call ${call.id} has no function name`)
    const raw = call.function.arguments?.trim() || '{}'
    const argumentsValue = parsePlannerToolArguments(raw)
    if (!argumentsValue) {
      throw new PlannerResponseFormatError(
        `Planner tool call ${call.id} returned invalid JSON arguments`,
      )
    }
    return {
      id: call.id,
      name,
      arguments: argumentsValue,
    }
  })
}

/**
 * Formats the complete Planner result for the local Prompt inspector.
 *
 * Before:
 * - A tool-call-only Planner response appeared as an empty, still-waiting response.
 *
 * After:
 * - The inspector shows the selected tool names and their structured arguments.
 */
function formatPlannerResult(content: string, toolCalls: readonly PlannerToolCall[]) {
  const sections = content.trim() ? [content.trim()] : []
  if (toolCalls.length) {
    sections.push([
      '[Planner 工具调用]',
      ...toolCalls.map((call, index) =>
        `${index + 1}. ${call.name}\n${JSON.stringify(call.arguments, null, 2)}`),
    ].join('\n'))
  }
  return sections.join('\n\n')
}

function beginTrace(
  purpose: Parameters<ReturnType<typeof useLumiConsciousnessObservabilityStore>['begin']>[0]['purpose'],
  model: string,
  provider: string,
  conversationId: string,
  messages: readonly PlannerMessage[] | readonly LanguageModelMessage[],
  diagnostics: {
    toolCount?: number
    requestedToolChoice?: 'auto' | 'required'
    effectiveToolChoice?: 'auto' | 'required' | 'omitted'
    thinkingMode?: 'auto' | 'enabled' | 'disabled' | 'provider-default'
  } = {},
) {
  const store = useLumiConsciousnessObservabilityStore()
  const social = useLumiSocialLanguageStore()
  const runtimeSettings = useLumiAgentRuntimeSettingsStore()
  const enabled = social.config.promptLoggingEnabled || runtimeSettings.promptLoggingEnabled
  const id = nanoid()
  store.begin({
    id,
    purpose,
    model,
    provider,
    conversationId,
    ...diagnostics,
    messages: enabled
      ? messages.map(message => ({
          role: message.role === 'tool' ? 'system' : message.role,
          content: message.content,
        }))
      : undefined,
  })
  return {
    append(text: string) {
      if (enabled)
        store.appendDelta(id, text)
    },
    usage(usage: {
      prompt_tokens?: number
      completion_tokens?: number
      prompt_cache_hit_tokens?: number
      prompt_cache_miss_tokens?: number
    }) {
      store.recordUsage(id, usage as StreamUsage)
    },
    complete() {
      store.complete(id)
    },
    fail(error: unknown) {
      store.fail(id, errorMessageFrom(error) ?? String(error))
    },
  }
}

function observabilityPurpose(
  purpose: Parameters<LanguageModelPort['generate']>[1],
): Parameters<ReturnType<typeof useLumiConsciousnessObservabilityStore>['begin']>[0]['purpose'] {
  if (purpose === 'expression_learning' || purpose === 'jargon_learning' || purpose === 'behavior_learning' || purpose === 'public_knowledge_learning')
    return 'learning'
  if (purpose === 'replyer'
    || purpose === 'replyer_retry'
    || purpose === 'expression_selector'
    || purpose === 'feedback'
    || purpose === 'context_summary'
    || purpose === 'sticker_classifier'
    || purpose === 'sticker_selector') {
    return purpose
  }
  return 'other'
}

function schemaRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return cloneData(value as Record<string, unknown>)
  return { type: 'object', properties: {}, additionalProperties: true }
}

function isPrimaryDesktopTool(id: string): boolean {
  return [
    'search_long_memory',
    'search_short_memory',
    'read_current_state',
    'read_user_profile',
    'read_emotion_state',
  ].includes(id)
}

function toolRisk(value: string): ToolRiskLevel {
  return value === 'medium' || value === 'high' || value === 'critical' ? value : 'low'
}

function toolExecutionMode(value: string): ToolExecutionMode {
  return value === 'confirm' || value === 'blocked' ? 'confirm' : 'automatic'
}

function toolSideEffect(definition: {
  canWrite: boolean
  canExecuteProcess: boolean
  canAccessNetwork: boolean
}): ToolSideEffectType {
  if (definition.canExecuteProcess || definition.canAccessNetwork)
    return 'external'
  return definition.canWrite ? 'write' : 'read'
}

function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(toRaw(value))) as T
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, milliseconds)))
}
