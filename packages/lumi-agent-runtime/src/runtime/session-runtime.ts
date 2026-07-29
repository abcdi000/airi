import type { LumiCognitiveContextBundle, LumiFeedbackEvent, LumiVisibleReply } from '@proj-airi/lumi-runtime'

import type {
  DialogueAssistantMessage,
  DialogueUserMessage,
  LumiAgentContextMessage,
  PlannerAssistantMessage,
  ReferenceMessage,
  ToolResultMessage,
} from '../context/messages'
import type { DirectPerceptionEnvelope } from '../input'
import type { AgentTracePort, AgentTurnEndReason } from '../observability/trace'
import type { DirectOutboundAuthority } from '../policy/outbound-guard'
import type { CognitiveContextPort, CognitiveDialogueTurn } from '../ports/cognitive'
import type { IdentityPort } from '../ports/identity'
import type { MemoryPort } from '../ports/memory'
import type { LanguageModelPort, PlannerModelPort, PlannerToolCall } from '../ports/model'
import type {
  AgentPersistencePort,
  PersistedDirectEventResult,
  PersistedSessionState,
  PersistedWaitContinuation,
  PersistedWaitState,
} from '../ports/persistence'
import type { ReplyPolicyPort } from '../ports/reply'
import type { SocialLanguagePort } from '../ports/social-language'
import type { StickerPort } from '../ports/stickers'
import type { AgentToolsPort } from '../ports/tools'
import type { ReplyerService } from '../replyer/replyer-service'
import type { ToolPlanStep } from '../tools/executor'
import type { ToolAvailabilityContext, ToolRegistry } from '../tools/registry'
import type { WaitResult } from './wait-controller'

import { errorMessageFrom } from '@moeru/std'
import {
  formatLumiPlannerCognitiveContext,
  formatLumiReplyerCognitiveContext,
} from '@proj-airi/lumi-runtime'

import { compactContext, selectPlannerHistory } from '../context/compactor'
import { consumeReferenceUses } from '../context/history'
import { validateDirectPerceptionEnvelope } from '../input'
import { buildPlannerMessages } from '../planner/planner-prompt'
import { PlannerResponseFormatError } from '../ports/model'
import {
  createLumiPromptTemplate,
  lumiPromptTemplateMetadata,
  redactPromptMessages,
} from '../prompts/templates'
import { createQueryMemoryTool } from '../tools/builtin/query-memory'
import { createQueryPersonProfileTool } from '../tools/builtin/query-person-profile'
import { createQueryPublicGroupKnowledgeTool } from '../tools/builtin/query-public-group-knowledge'
import { createReplyTool } from '../tools/builtin/reply'
import { createToolSearchTool } from '../tools/builtin/tool-search'
import { createWaitTool } from '../tools/builtin/wait'
import { executeToolPlan } from '../tools/executor'
import { ToolRegistry as RuntimeToolRegistry } from '../tools/registry'
import { WaitController } from './wait-controller'

/** Runtime mode used while migrating one host to the shared runtime. */
export type LumiAgentRuntimeMode = 'legacy' | 'shadow' | 'maisaka'

/** Planner behavior after a successful explicit reply. */
export type PlannerFinalizationMode = 'maibot' | 'stop_after_successful_reply'

/** Configuration shared by every direct session. */
export interface SessionRuntimeConfig {
  runtimeMode: LumiAgentRuntimeMode
  plannerMaxRounds: number
  plannerNoToolRetryLimit: number
  plannerFinalizationMode: PlannerFinalizationMode
  mergeWindowMs: number
  toolMaxConcurrency: number
  toolStepTimeoutMs: number
  plannerRequestTimeoutMs: number
  cognitiveContextTimeoutMs: number
  deferredToolsEnabled: boolean
  expressionSelectorEnabled: boolean
  directLanguageFeedbackEnabled: boolean
  promptLoggingEnabled: boolean
  plannerSystemPrompt: string
  plannerPromptVersion: string
  contextSummarySystemPrompt: string
  contextSummaryPromptVersion: string
  plannerHistoryBudgetTokens: number
  plannerHistoryMaxMessages: number
  contextCompactionThresholdTokens: number
  contextRecentTokens: number
  contextCompactionThresholdMessages: number
  contextRecentMessages: number
  contextCompactionIdleMs: number
}

/** Public completion result for one or more merged direct inputs. */
export interface DirectTurnResult {
  turnId: string
  conversationId: string
  generation: number
  endReason: AgentTurnEndReason
  sentMessageIds: readonly string[]
  failure?: {
    code: string
    message: string
  }
}

interface PendingInput {
  envelope: DirectPerceptionEnvelope
  resolve: (result: DirectTurnResult) => void
  reject: (error: unknown) => void
}

interface ActiveTurn {
  turnId: string
  envelope: DirectPerceptionEnvelope
  capability: ReturnType<DirectOutboundAuthority['issue']>
  generation: number
  replyAttempted: boolean
  replyFailure?: {
    code: string
    message: string
  }
  replied: boolean
  sentMessageIds: string[]
  pendingInputs: PendingInput[]
}

/**
 * Owns FIFO, interruption, wait, typed history, and Planner rounds for one direct conversation.
 */
export class SessionRuntime {
  readonly #conversationId: string
  readonly #config: SessionRuntimeConfig
  readonly #plannerModel: PlannerModelPort
  readonly #languageModel: LanguageModelPort
  readonly #replyer: ReplyerService
  readonly #identity: IdentityPort
  readonly #cognitive?: CognitiveContextPort
  readonly #memory?: MemoryPort
  readonly #persistence: AgentPersistencePort
  readonly #outbound: DirectOutboundAuthority
  readonly #replyPolicy: ReplyPolicyPort
  readonly #socialLanguage?: SocialLanguagePort
  readonly #sticker?: StickerPort
  readonly #tools?: AgentToolsPort
  readonly #trace?: AgentTracePort
  readonly #wait: WaitController<PendingInput>
  readonly #pending: PendingInput[] = []
  readonly #inflightEvents = new Map<string, Promise<DirectTurnResult>>()
  readonly #completedEvents = new Map<string, PersistedDirectEventResult>()
  readonly #discoveredToolNames = new Set<string>()
  #history: LumiAgentContextMessage[] = []
  #generation = 0
  #contextEpoch = 0
  #summaryVersion = 0
  #stablePrefixHash = ''
  #dialogueSegmentId = 'dialogue:0'
  #processing?: Promise<void>
  #activeController?: AbortController
  #activeTurn?: ActiveTurn
  #activePlannerRound = 0
  #registry?: ToolRegistry
  #loaded?: Promise<void>
  #compaction?: Promise<void>
  #compactionTimer?: ReturnType<typeof setTimeout>
  #compactionController?: AbortController
  #activeCognitiveContext?: LumiCognitiveContextBundle

  constructor(options: {
    conversationId: string
    config: SessionRuntimeConfig
    plannerModel: PlannerModelPort
    languageModel: LanguageModelPort
    replyer: ReplyerService
    identity: IdentityPort
    cognitive?: CognitiveContextPort
    memory?: MemoryPort
    persistence: AgentPersistencePort
    outbound: DirectOutboundAuthority
    replyPolicy: ReplyPolicyPort
    socialLanguage?: SocialLanguagePort
    sticker?: StickerPort
    tools?: AgentToolsPort
    trace?: AgentTracePort
  }) {
    this.#conversationId = options.conversationId
    this.#config = options.config
    this.#plannerModel = options.plannerModel
    this.#languageModel = options.languageModel
    this.#replyer = options.replyer
    this.#identity = options.identity
    this.#cognitive = options.cognitive
    this.#memory = options.memory
    this.#persistence = options.persistence
    this.#outbound = options.outbound
    this.#replyPolicy = options.replyPolicy
    this.#socialLanguage = options.socialLanguage
    this.#sticker = options.sticker
    this.#tools = options.tools
    this.#trace = options.trace
    this.#wait = new WaitController<PendingInput>({
      onStateChanged: async () => await this.#save(),
    })
  }

  /**
   * Enqueues one authenticated direct event and interrupts stale generation.
   */
  ingest(envelope: DirectPerceptionEnvelope): Promise<DirectTurnResult> {
    validateDirectPerceptionEnvelope(envelope)
    if (envelope.conversationId !== this.#conversationId)
      return Promise.reject(new TypeError('Direct envelope does not belong to this session'))
    return this.#ingestLoaded(envelope)
  }

  async #ingestLoaded(envelope: DirectPerceptionEnvelope): Promise<DirectTurnResult> {
    await this.#load()
    const completed = this.#completedEvents.get(envelope.eventId)
    if (completed)
      return completed.result
    const inflight = this.#inflightEvents.get(envelope.eventId)
    if (inflight)
      return await inflight

    this.#cancelCompactionForForeground()
    const result = new Promise<DirectTurnResult>((resolve, reject) => {
      const pending = { envelope, resolve, reject }
      if (this.#wait.wakeByMessage(pending))
        return
      this.#pending.push(pending)
      this.#activeController?.abort(new AgentTurnInterruptedError())
      this.#startProcessing()
    })
    const tracked = result.then(async (turnResult) => {
      this.#recordCompletedEvent(envelope, turnResult)
      await this.#save()
      return turnResult
    }).finally(() => {
      this.#inflightEvents.delete(envelope.eventId)
    })
    this.#inflightEvents.set(envelope.eventId, tracked)
    return await tracked
  }

  async drain(): Promise<void> {
    while (true) {
      const processing = this.#processing
      if (processing) {
        await processing
        continue
      }
      if (this.#pending.length > 0) {
        this.#startProcessing()
        continue
      }
      const compaction = this.#compaction
      if (compaction) {
        await compaction
        continue
      }
      return
    }
  }

  /** Loads persisted state and re-arms a pending wait without awaiting it. */
  async resume(): Promise<void> {
    await this.#load()
  }

  #startProcessing(): void {
    if (this.#processing)
      return
    const tracked = this.#drain().finally(() => {
      if (this.#processing === tracked)
        this.#processing = undefined
      if (this.#pending.length > 0)
        this.#startProcessing()
    })
    this.#processing = tracked
  }

  async #drain(): Promise<void> {
    await this.#load()
    while (this.#pending.length > 0) {
      if (this.#config.mergeWindowMs > 0)
        await delay(this.#config.mergeWindowMs)
      const inputs = this.#pending.splice(0)
      const latest = inputs.at(-1)
      if (!latest)
        continue
      for (const input of inputs)
        this.#appendUserMessage(input.envelope)
      this.#generation += 1
      const turn: ActiveTurn = {
        turnId: `${latest.envelope.eventId}:g${this.#generation}`,
        envelope: latest.envelope,
        capability: this.#outbound.issue(latest.envelope),
        generation: this.#generation,
        replyAttempted: false,
        replied: false,
        sentMessageIds: [],
        pendingInputs: [...inputs],
      }
      this.#activeTurn = turn
      await this.#ensureRegistry(turn.envelope)
      await this.#save()
      await this.#trace?.record({
        type: 'turn_started',
        turnId: turn.turnId,
        conversationId: this.#conversationId,
        personId: turn.envelope.personId,
        generation: turn.generation,
        timestamp: Date.now(),
      })

      let result: DirectTurnResult
      try {
        result = await this.#runTurn(turn)
      }
      catch (error) {
        const interrupted = error instanceof AgentTurnInterruptedError
          || this.#activeController?.signal.aborted
        if (interrupted) {
          result = this.#turnResult(turn, 'interrupted')
        }
        else if (error instanceof PlannerToolSelectionError) {
          turn.replyFailure = {
            code: error.code,
            message: error.message,
          }
          result = this.#turnResult(turn, 'failed')
        }
        else if (turn.sentMessageIds.length > 0) {
          // Delivery already succeeded. A later persistence or trace failure
          // must not make the platform send a contradictory failure message.
          result = this.#turnResult(turn, 'reply_sent')
        }
        else {
          const originalFailure = errorMessageFrom(error) ?? 'Direct turn execution failed'
          turn.replyFailure = {
            code: 'TURN_EXECUTION_FAILED',
            message: originalFailure,
          }
          console.error('[lumi-agent-runtime] direct turn failed', originalFailure)
          result = await this.#recoverFailedTurn(turn)
        }
      }
      finally {
        this.#activeController = undefined
        this.#outbound.revoke(turn.capability)
        this.#activeTurn = undefined
      }
      await this.#trace?.record({
        type: 'turn_finished',
        turnId: result.turnId,
        reason: result.endReason,
        sentMessageIds: result.sentMessageIds,
        timestamp: Date.now(),
      })
      turn.pendingInputs.forEach(input => input.resolve(result))
      this.#scheduleCompaction()
    }
  }

  async #runTurn(turn: ActiveTurn, startRound = 1): Promise<DirectTurnResult> {
    const cognitivePrepared = await this.#prepareCognitiveContext(turn)
    if (!cognitivePrepared) {
      const profile = await this.#identity.getPersonProfile({
        personId: turn.envelope.personId,
        conversationId: turn.envelope.conversationId,
        viewerPersonId: turn.envelope.personId,
      })
      if (profile)
        this.#replaceCurrentProfileReference(profile)
      await this.#refreshPlannerLanguageReferences(turn.envelope)
    }
    this.#scheduleDirectFeedback(turn.envelope, this.#activeCognitiveContext?.feedbackEvents ?? [])

    let consecutiveNoToolSteps = 0
    let responseFormatRetries = 0
    let cognitiveContextUseRecorded = false
    for (let round = startRound; round <= this.#config.plannerMaxRounds; round += 1) {
      this.#activePlannerRound = round
      const controller = new AbortController()
      this.#activeController = controller
      const availability = this.#availabilityContext(turn.envelope)
      const availableTools = await this.#registry!.listAvailable(availability, {
        stage: 'planner',
        discoveredToolNames: this.#config.deferredToolsEnabled
          ? this.#discoveredToolNames
          : undefined,
      })
      const explicitlyRequestedTools = this.#currentTurnToolEvidence(turn).length === 0
        ? this.#registry!.matchExplicitRequests(turn.envelope.text ?? '', availableTools)
        : []
      const plannerTools = explicitlyRequestedTools.length > 0
        ? explicitlyRequestedTools
        : availableTools
      const startedAt = Date.now()
      const plannerMessages = buildPlannerMessages({
        systemPrompt: this.#config.plannerSystemPrompt,
        history: selectPlannerHistory(this.#history, {
          plannerHistoryBudgetTokens: this.#config.plannerHistoryBudgetTokens,
          plannerHistoryMaxMessages: this.#config.plannerHistoryMaxMessages,
          compactionThresholdTokens: this.#config.contextCompactionThresholdTokens,
          recentHistoryTokens: this.#config.contextRecentTokens,
          compactionThresholdMessages: this.#config.contextCompactionThresholdMessages,
          recentHistoryMessages: this.#config.contextRecentMessages,
        }),
        envelope: turn.envelope,
        round,
        now: startedAt,
        noToolRetry: consecutiveNoToolSteps > 0,
        responseFormatRetry: responseFormatRetries > 0,
        requiredToolNames: explicitlyRequestedTools.map(tool => tool.name),
      })
      let step: Awaited<ReturnType<PlannerModelPort['generateStep']>>
      try {
        step = await executeAbortableRequest({
          label: 'Planner request',
          parentSignal: controller.signal,
          timeoutMs: this.#config.plannerRequestTimeoutMs,
          execute: async signal => await this.#plannerModel.generateStep({
            messages: plannerMessages,
            tools: this.#registry!.toPlannerDefinitions(plannerTools),
            toolChoice: 'required',
            signal,
          }),
        })
      }
      catch (error) {
        await this.#trace?.record({
          type: 'model_request',
          turnId: turn.turnId,
          purpose: 'planner',
          status: 'error',
          durationMs: Date.now() - startedAt,
          prompt: lumiPromptTemplateMetadata(createLumiPromptTemplate(
            'planner',
            this.#config.plannerSystemPrompt,
            this.#config.plannerPromptVersion,
          )),
          messageCount: plannerMessages.length,
          toolCount: plannerTools.length,
          requestedToolChoice: 'required',
          messages: this.#config.promptLoggingEnabled
            ? redactPromptMessages(plannerMessages)
            : undefined,
          errorMessage: (errorMessageFrom(error) ?? 'Planner request failed').slice(0, 2_000),
          timestamp: Date.now(),
        })
        if (
          error instanceof PlannerResponseFormatError
          && responseFormatRetries < this.#config.plannerNoToolRetryLimit
        ) {
          responseFormatRetries += 1
          await this.#finishRound()
          continue
        }
        throw error
      }
      if (controller.signal.aborted)
        throw new AgentTurnInterruptedError()
      if (!cognitiveContextUseRecorded) {
        cognitiveContextUseRecorded = true
        this.#recordCognitiveContextUse(turn.envelope)
      }
      responseFormatRetries = 0
      this.#history.push({
        id: `planner:${turn.turnId}:${round}`,
        kind: 'planner_assistant',
        round,
        content: step.content,
        reasoningSummary: step.reasoning,
        toolCalls: step.toolCalls,
        timestamp: Date.now(),
        countInContext: true,
        remainingUses: null,
        source: 'planner',
        visibility: 'planner',
        provenance: {
          origin: 'planner_model',
          sourceIds: [turn.envelope.sourceMessageId],
        },
      } satisfies PlannerAssistantMessage)
      await this.#trace?.record({
        type: 'model_request',
        turnId: turn.turnId,
        purpose: 'planner',
        status: 'completed',
        durationMs: Date.now() - startedAt,
        prompt: lumiPromptTemplateMetadata(createLumiPromptTemplate(
          'planner',
          this.#config.plannerSystemPrompt,
          this.#config.plannerPromptVersion,
        )),
        messageCount: plannerMessages.length,
        toolCount: plannerTools.length,
        requestedToolChoice: 'required',
        messages: this.#config.promptLoggingEnabled
          ? redactPromptMessages(plannerMessages)
          : undefined,
        usage: step.usage,
        modelName: step.modelName,
        timestamp: Date.now(),
      })
      await this.#trace?.record({
        type: 'planner_step',
        turnId: turn.turnId,
        round,
        durationMs: Date.now() - startedAt,
        toolCalls: step.toolCalls.map(call => ({
          id: call.id,
          name: call.name,
          dependsOn: call.dependsOn,
        })),
        usage: step.usage,
        modelName: step.modelName,
        timestamp: Date.now(),
      })
      if (step.toolCalls.length === 0) {
        await this.#finishRound()
        if (
          !turn.replied
          && consecutiveNoToolSteps < this.#config.plannerNoToolRetryLimit
          && round < this.#config.plannerMaxRounds
        ) {
          consecutiveNoToolSteps += 1
          continue
        }
        if (!turn.replied && this.#currentTurnToolEvidence(turn).length > 0) {
          await this.#executeRecoveryReply(turn, availability, controller)
          await this.#finishRound()
        }
        if (!turn.replied)
          throw new PlannerToolSelectionError()
        return this.#turnResult(turn, turn.replied ? 'reply_sent' : 'planner_finished')
      }
      consecutiveNoToolSteps = 0

      await this.#executeToolCalls(
        step.toolCalls,
        turn,
        availability,
        controller,
        extractPlannerPublicProgressText(step.content),
      )
      await this.#finishRound()
      if (!turn.replyAttempted && round === this.#config.plannerMaxRounds) {
        await this.#executeRecoveryReply(turn, availability, controller)
        await this.#finishRound()
        return this.#turnResult(turn, turn.replied ? 'reply_sent' : 'planner_finished')
      }
      // A Replyer invocation already contains its own bounded correction pass.
      // Re-entering Planner after that attempt can only duplicate visible output
      // or amplify one turn into repeated Planner/Replyer model requests.
      if (turn.replyAttempted)
        return this.#turnResult(turn, turn.replied ? 'reply_sent' : 'planner_finished')
    }
    return this.#turnResult(turn, 'max_rounds')
  }

  async #executeRecoveryReply(
    turn: ActiveTurn,
    availability: ToolAvailabilityContext,
    controller: AbortController,
  ): Promise<void> {
    const referenceInfo = this.#currentTurnToolEvidence(turn)
    await this.#executeToolCalls([{
      id: `runtime-reply:${turn.turnId}:final`,
      name: 'reply',
      arguments: {
        targetMessageId: turn.envelope.sourceMessageId,
        replyAct: '回应',
        semanticGoal: '根据当前私聊内容和本轮已经获得的工具结果，自然、准确地回应用户；不要提及内部运行机制。',
        keyPoints: ['优先使用已经取得的工具事实或执行结果，不要假装没有查询或操作过。'],
        referenceInfo,
        expressionIntent: {
          scene: '日常私聊',
          tone: '自然',
          desiredLength: 'short',
          avoid: ['内部系统术语', '任务框架说明', '固定兜底话术'],
        },
      },
    }], turn, availability, controller)
  }

  async #recoverFailedTurn(turn: ActiveTurn): Promise<DirectTurnResult> {
    const controller = new AbortController()
    this.#activeController = controller
    try {
      await this.#executeRecoveryReply(
        turn,
        this.#availabilityContext(turn.envelope),
        controller,
      )
      if (turn.replied) {
        try {
          await this.#finishRound()
        }
        catch (error) {
          // The visible reply already succeeded. Keep it authoritative while
          // retaining a diagnostic for storage failures.
          console.error(
            '[lumi-agent-runtime] failed to persist recovered direct turn',
            errorMessageFrom(error) ?? error,
          )
        }
        return this.#turnResult(turn, 'reply_sent')
      }
    }
    catch (error) {
      const recoveryFailure = errorMessageFrom(error) ?? 'Recovery reply failed'
      turn.replyFailure = {
        code: 'TURN_RECOVERY_FAILED',
        message: recoveryFailure,
      }
      console.error('[lumi-agent-runtime] direct turn recovery failed', recoveryFailure)
    }
    return this.#turnResult(turn, 'failed')
  }

  #currentTurnToolEvidence(turn: ActiveTurn): string[] {
    const prefix = `tool-result:${turn.turnId}:`
    const references: string[] = []
    let totalLength = 0
    for (const message of this.#history) {
      if (
        message.kind !== 'tool_result'
        || !message.id.startsWith(prefix)
        || message.toolName === 'reply'
      ) {
        continue
      }
      const status = message.success ? '成功' : '失败'
      const serialized = serializeToolEvidence(message.result)
      const reference = `工具 ${message.toolName} ${status}：${serialized}`.slice(0, 6_000)
      if (totalLength + reference.length > 20_000)
        break
      references.push(reference)
      totalLength += reference.length
      if (references.length >= 8)
        break
    }
    return references
  }

  async #executeToolCalls(
    calls: readonly PlannerToolCall[],
    turn: ActiveTurn,
    availability: ToolAvailabilityContext,
    controller: AbortController,
    publicProgressText?: string,
  ): Promise<void> {
    const executionStartedAt = Date.now()
    await Promise.all(calls.map(async call => await this.#trace?.record({
      type: 'tool_execution',
      turnId: turn.turnId,
      stepId: call.id,
      toolName: call.name,
      status: 'started',
      ...(publicProgressText ? { publicProgressText } : {}),
      timestamp: executionStartedAt,
    })))
    let execution
    try {
      execution = await executeToolPlan(
        this.#registry!,
        calls.map(call => this.#toolPlanStep(call, turn)),
        availability,
        {
          maxConcurrency: this.#config.toolMaxConcurrency,
          maxSteps: Math.max(1, calls.length),
          stepTimeoutMs: this.#config.toolStepTimeoutMs,
        },
        controller.signal,
      )
    }
    catch (error) {
      await Promise.all(calls.map(async call => await this.#trace?.record({
        type: 'tool_execution',
        turnId: turn.turnId,
        stepId: call.id,
        toolName: call.name,
        status: 'failed',
        durationMs: Date.now() - executionStartedAt,
        errorCode: 'TOOL_PLAN_FAILED',
        timestamp: Date.now(),
      })))
      throw error
    }
    if (controller.signal.aborted)
      throw new AgentTurnInterruptedError()
    for (const toolResult of execution.steps) {
      await this.#trace?.record({
        type: 'tool_execution',
        turnId: turn.turnId,
        stepId: toolResult.stepId,
        toolName: toolResult.toolName,
        status: toolResult.skipped
          ? 'skipped'
          : toolResult.success
            ? 'succeeded'
            : 'failed',
        durationMs: toolResult.finishedAt - toolResult.startedAt,
        errorCode: toolResult.errorCode,
        timestamp: toolResult.finishedAt,
      })
      if (toolResult.toolName === 'reply' && !toolResult.success) {
        turn.replyFailure = {
          code: toolResult.errorCode ?? 'REPLY_FAILED',
          message: toolResult.errorMessage ?? 'Reply tool failed without a detailed reason.',
        }
      }
      this.#history.push({
        id: `tool-result:${turn.turnId}:${toolResult.stepId}`,
        kind: 'tool_result',
        toolCallId: toolResult.stepId,
        toolName: toolResult.toolName,
        success: toolResult.success,
        result: toolResult.result?.output ?? {
          errorCode: toolResult.errorCode,
          errorMessage: toolResult.errorMessage,
        },
        timestamp: toolResult.finishedAt,
        countInContext: true,
        remainingUses: null,
        source: 'tool',
        visibility: 'planner',
        provenance: {
          origin: toolResult.toolName,
          sourceIds: [toolResult.stepId],
        },
      } satisfies ToolResultMessage)
    }
  }

  #toolPlanStep(call: PlannerToolCall, turn: ActiveTurn): ToolPlanStep {
    const spec = this.#registry?.get(call.name)
    return {
      id: call.id,
      toolName: call.name,
      arguments: call.arguments,
      dependsOn: call.dependsOn,
      idempotencyKey: spec?.idempotencyPolicy === 'required'
        ? `${turn.turnId}:${call.id}`
        : undefined,
    }
  }

  async #ensureRegistry(envelope: DirectPerceptionEnvelope): Promise<void> {
    // MCP and plugin registrations can change while Lumi is running. Rebuild
    // once per direct turn, while keeping one stable registry within the turn.
    const registry = new RuntimeToolRegistry()
    registry.register(createReplyTool({
      context: () => this.#replyToolContext(),
      replyPolicy: this.#replyPolicy,
      replyer: this.#replyer,
      outbound: this.#outbound,
      socialLanguage: this.#socialLanguage,
      expressionSelectorEnabled: this.#config.expressionSelectorEnabled,
      sticker: this.#sticker
        ? {
            port: this.#sticker,
            cooldownMs: 10 * 60 * 1_000,
            minimumScore: 0.55,
          }
        : undefined,
    }))
    registry.register(createWaitTool({
      controller: this.#wait,
      onResumedMessage: async pending => await this.#resumeWithMessage(pending),
      continuation: () => this.#waitContinuation(),
    }))
    registry.register(createQueryPersonProfileTool({
      identity: this.#identity,
      envelope: () => this.#requireActiveTurn().envelope,
    }))
    if (this.#memory) {
      registry.register(createQueryMemoryTool({
        memory: this.#memory,
        envelope: () => this.#requireActiveTurn().envelope,
      }))
      registry.register(createQueryPublicGroupKnowledgeTool({
        memory: this.#memory,
        envelope: () => this.#requireActiveTurn().envelope,
      }))
    }
    if (this.#config.deferredToolsEnabled) {
      registry.register(createToolSearchTool({
        registry,
        discoveredToolNames: this.#discoveredToolNames,
      }))
    }
    await this.#tools?.registerTools(registry, {
      conversationId: envelope.conversationId,
      personId: envelope.personId,
      participantPersonIds: envelope.participantPersonIds,
    })
    this.#registry = registry
  }

  #replyToolContext() {
    const turn = this.#requireActiveTurn()
    const expectedGeneration = turn.generation
    const signal = this.#activeController?.signal
    return {
      turnId: turn.turnId,
      envelope: turn.envelope,
      capability: turn.capability,
      history: this.#history,
      signal,
      alreadyReplied: turn.replied,
      claimReplyAttempt: () => {
        if (turn.replyAttempted)
          return false
        turn.replyAttempted = true
        return true
      },
      isCurrentGeneration: () =>
        this.#activeTurn === turn
        && turn.generation === expectedGeneration
        && signal?.aborted !== true,
      onSent: async (input: {
        reply: LumiVisibleReply
        messageIds: readonly string[]
        feedbackTargetIds: readonly string[]
        stickerId?: string
      }) => {
        turn.replied = true
        turn.sentMessageIds.push(...input.messageIds)
        this.#history.push({
          id: `assistant:${turn.turnId}`,
          kind: 'dialogue_assistant',
          messageIds: input.messageIds,
          textSegments: input.reply.messages.map(message => message.text),
          appliedExpressionIds: input.reply.appliedExpressionIds ?? [],
          feedbackTargetIds: [...input.feedbackTargetIds],
          stickerId: input.stickerId,
          timestamp: Date.now(),
          countInContext: true,
          remainingUses: null,
          source: 'lumi',
          visibility: 'both',
          provenance: {
            origin: 'reply_tool',
            sourceIds: [turn.envelope.sourceMessageId],
          },
        } satisfies DialogueAssistantMessage)
        await this.#save()
      },
    }
  }

  #waitContinuation(): PersistedWaitContinuation {
    const turn = this.#requireActiveTurn()
    return {
      turnId: turn.turnId,
      generation: turn.generation,
      plannerRound: this.#activePlannerRound,
      envelope: structuredClone(turn.envelope),
      replied: turn.replied,
      sentMessageIds: [...turn.sentMessageIds],
    }
  }

  async #resumeWithMessage(pending: PendingInput): Promise<void> {
    const turn = this.#requireActiveTurn()
    this.#appendUserMessage(pending.envelope)
    this.#outbound.revoke(turn.capability)
    turn.envelope = pending.envelope
    turn.capability = this.#outbound.issue(pending.envelope)
    turn.pendingInputs.push(pending)
    await this.#save()
  }

  #appendUserMessage(envelope: DirectPerceptionEnvelope): void {
    this.#history.push({
      id: `user:${envelope.sourceMessageId}`,
      kind: 'dialogue_user',
      messageId: envelope.sourceMessageId,
      personId: envelope.personId,
      text: envelope.text ?? envelope.segments
        .flatMap(segment => segment.type === 'text' ? [segment.text] : [])
        .join('\n'),
      segments: envelope.segments,
      attachments: envelope.attachments,
      timestamp: envelope.timestamp,
      countInContext: true,
      remainingUses: null,
      source: envelope.platform,
      visibility: 'both',
      provenance: {
        origin: 'direct_perception',
        sourceIds: [envelope.eventId, envelope.sourceMessageId],
      },
    } satisfies DialogueUserMessage)
  }

  async #prepareCognitiveContext(turn: ActiveTurn): Promise<boolean> {
    this.#activeCognitiveContext = undefined
    this.#history = this.#history.filter(message =>
      message.kind !== 'reference'
      || (message.referenceType !== 'cognitive_context'
        && message.referenceType !== 'cognitive_expression'))
    const startedAt = Date.now()
    if (!this.#cognitive) {
      await this.#recordAutomaticRecallFallback(turn.turnId, 'cognitive_port_unavailable', startedAt)
      return false
    }

    const controller = new AbortController()
    this.#activeController = controller
    try {
      const bundle = await executeAbortableRequest({
        label: 'Cognitive context preparation',
        parentSignal: controller.signal,
        timeoutMs: this.#config.cognitiveContextTimeoutMs,
        execute: async signal => await this.#cognitive!.prepareTurn({
          envelope: turn.envelope,
          recentTurns: this.#recentCognitiveTurns(),
          signal,
        }),
      })
      validateCognitiveBundleIdentity(bundle, turn.envelope)
      this.#activeCognitiveContext = bundle
      this.#replaceCognitiveReferences(bundle)
      await this.#trace?.record({
        type: 'automatic_recall',
        turnId: turn.turnId,
        status: 'completed',
        recall: {
          ...bundle.recallTrace,
          query: this.#config.promptLoggingEnabled ? bundle.recallTrace.query : undefined,
          durationMs: Date.now() - startedAt,
        },
        timestamp: Date.now(),
      })
      return true
    }
    catch (error) {
      if (error instanceof AgentTurnInterruptedError || this.#activeTurn !== turn)
        throw error
      this.#activeCognitiveContext = undefined
      await this.#recordAutomaticRecallFallback(turn.turnId, 'cognitive_context_unavailable', startedAt)
      return false
    }
    finally {
      if (this.#activeController === controller)
        this.#activeController = undefined
    }
  }

  #recentCognitiveTurns(): CognitiveDialogueTurn[] {
    return this.#history
      .filter((message): message is DialogueUserMessage | DialogueAssistantMessage =>
        message.kind === 'dialogue_user' || message.kind === 'dialogue_assistant')
      .slice(-12)
      .map(message => message.kind === 'dialogue_user'
        ? {
            role: 'user',
            personId: message.personId,
            messageIds: [message.messageId],
            textSegments: [message.text],
            timestamp: message.timestamp,
          }
        : {
            role: 'assistant',
            messageIds: message.messageIds,
            textSegments: message.textSegments,
            feedbackTargetIds: message.feedbackTargetIds,
            timestamp: message.timestamp,
          })
  }

  #replaceCognitiveReferences(bundle: LumiCognitiveContextBundle): void {
    this.#history = this.#history.filter(message =>
      message.kind !== 'reference'
      || (message.referenceType !== 'person_profile'
        && message.referenceType !== 'behavior'
        && message.referenceType !== 'jargon'))
    const sourceIds = [
      ...bundle.stableFacts.map(memory => memory.id),
      ...bundle.relevantEpisodes.map(memory => memory.id),
      ...bundle.tentativeImpressions.map(hypothesis => hypothesis.id),
    ]
    this.#history.push({
      id: `cognitive:planner:${this.#generation}:${bundle.identity.actorId}`,
      kind: 'reference',
      referenceType: 'cognitive_context',
      content: formatLumiPlannerCognitiveContext(bundle),
      authorizationReason: 'Prepared and ACL-revalidated by the host cognitive context port',
      confidence: 1,
      timestamp: Date.now(),
      countInContext: true,
      remainingUses: null,
      source: 'cognitive_context',
      visibility: 'planner',
      provenance: {
        origin: 'cognitive_context_port',
        sourceIds,
      },
    }, {
      id: `cognitive:replyer:${this.#generation}:${bundle.identity.actorId}`,
      kind: 'reference',
      referenceType: 'cognitive_expression',
      content: formatLumiReplyerCognitiveContext(bundle),
      authorizationReason: 'Narrow Replyer projection from the same authorized cognitive bundle',
      confidence: 1,
      timestamp: Date.now(),
      countInContext: true,
      remainingUses: null,
      source: 'cognitive_context',
      visibility: 'replyer',
      provenance: {
        origin: 'cognitive_context_port',
        sourceIds: [],
      },
    })
  }

  async #recordAutomaticRecallFallback(
    turnId: string,
    fallbackReason: string,
    startedAt: number,
  ): Promise<void> {
    await this.#trace?.record({
      type: 'automatic_recall',
      turnId,
      status: 'fallback',
      recall: {
        ran: false,
        reusedPreviousState: false,
        aclInputCount: 0,
        aclOutputCount: 0,
        lexicalCandidateCount: 0,
        annCandidateCount: 0,
        mergedCandidateCount: 0,
        rerankedCandidateCount: 0,
        thresholdRejectedCount: 0,
        conflictRejectedCount: 0,
        injectedCount: 0,
        durationMs: Date.now() - startedAt,
        fallbackReason,
      },
      timestamp: Date.now(),
    })
  }

  #recordCognitiveContextUse(envelope: DirectPerceptionEnvelope): void {
    if (!this.#cognitive?.recordContextUse || !this.#activeCognitiveContext)
      return
    const bundle = this.#activeCognitiveContext
    void this.#cognitive.recordContextUse({
      envelope,
      memoryIds: [
        ...bundle.stableFacts.map(memory => memory.id),
        ...bundle.relevantEpisodes.map(memory => memory.id),
      ],
      hypothesisIds: bundle.tentativeImpressions.map(hypothesis => hypothesis.id),
      usedAt: new Date().toISOString(),
    }).catch(error => console.warn(
      '[lumi-agent-runtime] failed to record cognitive context usage',
      (errorMessageFrom(error) ?? 'unknown error').slice(0, 500),
    ))
  }

  #replaceCurrentProfileReference(profile: Awaited<ReturnType<IdentityPort['getPersonProfile']>> & {}) {
    const reference: ReferenceMessage = {
      id: `profile:${this.#generation}:${profile.personId}`,
      kind: 'reference',
      referenceType: 'person_profile',
      content: JSON.stringify(profile),
      authorizationReason: 'Current authenticated direct-chat person',
      confidence: 1,
      timestamp: Date.now(),
      countInContext: true,
      remainingUses: 2,
      source: 'identity',
      visibility: 'planner',
      provenance: {
        origin: 'identity_port',
        sourceIds: [profile.personId],
      },
    }
    this.#history = [
      ...this.#history.filter(message =>
        message.kind !== 'reference' || message.referenceType !== 'person_profile'),
      reference,
    ]
  }

  async #refreshPlannerLanguageReferences(envelope: DirectPerceptionEnvelope): Promise<void> {
    if (!this.#socialLanguage)
      return
    const references = await this.#socialLanguage.plannerReferences({
      envelope,
      limit: 4,
    })
    this.#history = this.#history.filter(message =>
      message.kind !== 'reference'
      || (message.referenceType !== 'behavior' && message.referenceType !== 'jargon'))
    for (const reference of references) {
      if (reference.kind === 'expression')
        continue
      this.#history.push({
        id: `language:${this.#generation}:${reference.kind}:${reference.id}`,
        kind: 'reference',
        referenceType: reference.kind,
        content: reference.content,
        confidence: reference.confidence,
        authorizationReason: 'Selected from group-learned social language for this direct turn',
        timestamp: Date.now(),
        countInContext: true,
        remainingUses: 2,
        source: 'social_language',
        visibility: reference.kind === 'behavior' ? 'planner' : 'both',
        provenance: {
          origin: 'social_language_port',
          sourceIds: [reference.id],
        },
      })
    }
  }

  #scheduleDirectFeedback(
    envelope: DirectPerceptionEnvelope,
    feedbackEvents: readonly LumiFeedbackEvent[],
  ): void {
    if (!this.#socialLanguage || !this.#config.directLanguageFeedbackEnabled)
      return
    const recentAssistant = this.#history
      .filter(message => message.kind === 'dialogue_assistant')
      .slice(-3)
    void this.#socialLanguage.observeDirectFeedback({
      envelope,
      recentAssistantMessageIds: recentAssistant.flatMap(message => message.messageIds),
      recentAssistantTexts: recentAssistant.flatMap(message => message.textSegments),
      feedbackEvents,
    }).catch(error => console.warn(
      '[lumi-agent-runtime] failed to apply direct social-language feedback',
      error,
    ))
  }

  async #finishRound(): Promise<void> {
    this.#history = [...consumeReferenceUses(this.#history)]
    await this.#save()
  }

  #availabilityContext(envelope: DirectPerceptionEnvelope): ToolAvailabilityContext {
    return {
      conversationId: envelope.conversationId,
      personId: envelope.personId,
      grantedScopes: new Set<string>(),
      runtimeMode: this.#config.runtimeMode,
    }
  }

  #requireActiveTurn(): ActiveTurn {
    if (!this.#activeTurn)
      throw new Error('No active direct turn')
    return this.#activeTurn
  }

  #turnResult(turn: ActiveTurn, endReason: AgentTurnEndReason): DirectTurnResult {
    const failure = turn.sentMessageIds.length > 0
      ? undefined
      : turn.replyFailure ?? {
        code: turn.replyAttempted ? 'REPLY_FAILED' : 'PLANNER_NO_REPLY',
        message: turn.replyAttempted
          ? 'Replyer did not produce a deliverable message.'
          : 'Planner finished without invoking the reply tool.',
      }
    return {
      turnId: turn.turnId,
      conversationId: this.#conversationId,
      generation: turn.generation,
      endReason,
      sentMessageIds: [...turn.sentMessageIds],
      failure,
    }
  }

  #load(): Promise<void> {
    this.#loaded ??= this.#restore()
    return this.#loaded
  }

  async #restore(): Promise<void> {
    const persisted = await this.#persistence.loadSession(this.#conversationId)
    if (!persisted)
      return
    this.#history = [...persisted.history]
    this.#generation = persisted.generation
    this.#contextEpoch = persisted.contextEpoch
    this.#summaryVersion = persisted.summaryVersion
    this.#stablePrefixHash = persisted.stablePrefixHash
    this.#dialogueSegmentId = persisted.dialogueSegmentId
    for (const completed of persisted.completedEvents)
      this.#completedEvents.set(completed.eventId, completed)
    if (persisted.waitState?.continuation)
      this.#startPersistedWait(persisted.waitState)
  }

  #startPersistedWait(state: PersistedWaitState): void {
    const continuation = state.continuation
    if (!continuation)
      return
    const wait = this.#wait.restore(state)
    const tracked = this.#resumePersistedWait(continuation, state.toolCallId, wait)
      .catch(error => console.error(
        '[lumi-agent-runtime] failed to resume persisted wait',
        errorMessageFrom(error) ?? error,
      ))
      .finally(() => {
        if (this.#processing === tracked)
          this.#processing = undefined
        if (this.#pending.length > 0)
          this.#startProcessing()
      })
    this.#processing = tracked
  }

  async #resumePersistedWait(
    continuation: PersistedWaitContinuation,
    toolCallId: string,
    wait: Promise<WaitResult<PendingInput>>,
  ): Promise<void> {
    const resumed = await wait
    let envelope = continuation.envelope
    const pendingInputs: PendingInput[] = []
    if (resumed.reason === 'message' && resumed.message) {
      envelope = resumed.message.envelope
      pendingInputs.push(resumed.message)
      this.#appendUserMessage(envelope)
    }
    const turn: ActiveTurn = {
      turnId: continuation.turnId,
      envelope,
      capability: this.#outbound.issue(envelope),
      generation: continuation.generation,
      replyAttempted: continuation.replied,
      replied: continuation.replied,
      sentMessageIds: [...continuation.sentMessageIds],
      pendingInputs,
    }
    this.#activeTurn = turn
    this.#generation = Math.max(this.#generation, continuation.generation)
    await this.#ensureRegistry(envelope)
    this.#history.push({
      id: `tool-result:${turn.turnId}:${toolCallId}:restored`,
      kind: 'tool_result',
      toolCallId,
      toolName: 'wait',
      success: true,
      result: {
        reason: resumed.reason,
        waitedMs: resumed.waitedMs,
        receivedNewMessage: resumed.reason === 'message',
        restoredAfterRestart: true,
      },
      timestamp: Date.now(),
      countInContext: true,
      remainingUses: null,
      source: 'tool',
      visibility: 'planner',
      provenance: {
        origin: 'wait_restore',
        sourceIds: [toolCallId],
      },
    } satisfies ToolResultMessage)

    let result: DirectTurnResult
    try {
      result = await this.#runTurn(turn, continuation.plannerRound + 1)
    }
    catch (error) {
      const interrupted = error instanceof AgentTurnInterruptedError
        || this.#activeController?.signal.aborted
      result = this.#turnResult(turn, interrupted ? 'interrupted' : 'failed')
      if (!interrupted)
        throw error
    }
    finally {
      this.#activeController = undefined
      this.#outbound.revoke(turn.capability)
      this.#activeTurn = undefined
    }
    await this.#trace?.record({
      type: 'turn_finished',
      turnId: result.turnId,
      reason: result.endReason,
      sentMessageIds: result.sentMessageIds,
      timestamp: Date.now(),
    })
    this.#recordCompletedEvent(continuation.envelope, result)
    for (const pending of pendingInputs) {
      this.#recordCompletedEvent(pending.envelope, result)
      pending.resolve(result)
    }
    await this.#save()
    this.#scheduleCompaction()
  }

  async #save(): Promise<void> {
    const state: PersistedSessionState = {
      conversationId: this.#conversationId,
      contextEpoch: this.#contextEpoch,
      summaryVersion: this.#summaryVersion,
      stablePrefixHash: this.#stablePrefixHash,
      dialogueSegmentId: this.#dialogueSegmentId,
      generation: this.#generation,
      history: this.#history,
      waitState: this.#wait.state,
      completedEvents: [...this.#completedEvents.values()],
    }
    await this.#persistence.saveSession(state)
  }

  #recordCompletedEvent(
    envelope: DirectPerceptionEnvelope,
    result: DirectTurnResult,
  ): void {
    this.#completedEvents.delete(envelope.eventId)
    this.#completedEvents.set(envelope.eventId, {
      eventId: envelope.eventId,
      sourceMessageId: envelope.sourceMessageId,
      completedAt: Date.now(),
      result,
    })
    while (this.#completedEvents.size > 512) {
      const oldest = this.#completedEvents.keys().next().value
      if (oldest === undefined)
        break
      this.#completedEvents.delete(oldest)
    }
  }

  #scheduleCompaction(): void {
    if (this.#compaction || this.#compactionTimer)
      return
    this.#compactionTimer = setTimeout(() => {
      this.#compactionTimer = undefined
      if (this.#processing || this.#pending.length > 0) {
        this.#scheduleCompaction()
        return
      }
      this.#startCompaction()
    }, this.#config.contextCompactionIdleMs)
  }

  #startCompaction(): void {
    if (this.#compaction)
      return
    const expectedGeneration = this.#generation
    const snapshot = this.#history
    const controller = new AbortController()
    this.#compactionController = controller
    this.#compaction = compactContext({
      history: snapshot,
      config: {
        plannerHistoryBudgetTokens: this.#config.plannerHistoryBudgetTokens,
        plannerHistoryMaxMessages: this.#config.plannerHistoryMaxMessages,
        compactionThresholdTokens: this.#config.contextCompactionThresholdTokens,
        recentHistoryTokens: this.#config.contextRecentTokens,
        compactionThresholdMessages: this.#config.contextCompactionThresholdMessages,
        recentHistoryMessages: this.#config.contextRecentMessages,
      },
      model: this.#languageModel,
      stableSystemPrompt: this.#config.plannerSystemPrompt,
      summaryPrompt: createLumiPromptTemplate(
        'context_summary',
        this.#config.contextSummarySystemPrompt,
        this.#config.contextSummaryPromptVersion,
      ),
      promptLoggingEnabled: this.#config.promptLoggingEnabled,
      trace: this.#trace,
      traceTurnId: `context-summary:${this.#conversationId}:${this.#summaryVersion + 1}`,
      contextEpoch: this.#contextEpoch,
      summaryVersion: this.#summaryVersion,
      signal: controller.signal,
    }).then(async (result) => {
      if (!result.compacted || this.#generation !== expectedGeneration || this.#history !== snapshot)
        return
      this.#history = [...result.history]
      this.#contextEpoch = result.contextEpoch
      this.#summaryVersion = result.summaryVersion
      this.#stablePrefixHash = result.stablePrefixHash
      this.#dialogueSegmentId = result.dialogueSegmentId
      await this.#save()
    }).catch(error => console.warn(
      '[lumi-agent-runtime] context compaction failed safely',
      error,
    )).finally(() => {
      this.#compaction = undefined
      if (this.#compactionController === controller)
        this.#compactionController = undefined
    })
  }

  #cancelCompactionForForeground(): void {
    if (this.#compactionTimer) {
      clearTimeout(this.#compactionTimer)
      this.#compactionTimer = undefined
    }
    this.#compactionController?.abort(new AgentTurnInterruptedError())
  }
}

function validateCognitiveBundleIdentity(
  bundle: LumiCognitiveContextBundle,
  envelope: DirectPerceptionEnvelope,
): void {
  const identity = bundle.identity
  if (identity.actorId !== envelope.personId)
    throw new TypeError('Cognitive context actor does not match the immutable turn actor')
  if (identity.conversationId !== envelope.conversationId || identity.conversationType !== 'direct')
    throw new TypeError('Cognitive context conversation does not match the direct turn')
  const expectedParticipants = [...envelope.participantPersonIds].sort()
  const actualParticipants = [...identity.participantUserIds].sort()
  if (
    expectedParticipants.length !== actualParticipants.length
    || expectedParticipants.some((personId, index) => personId !== actualParticipants[index])
  ) {
    throw new TypeError('Cognitive context participants do not match the authorized turn')
  }
  if (
    bundle.workingMemory.personId !== envelope.personId
    || bundle.workingMemory.conversationId !== envelope.conversationId
    || bundle.workingMemory.conversationType !== 'direct'
  ) {
    throw new TypeError('Cognitive working memory does not match the authorized turn')
  }
}

/** Interrupt marker used to discard stale model output without sending it. */
export class AgentTurnInterruptedError extends Error {
  constructor() {
    super('A newer direct message interrupted the active generation')
    this.name = 'AgentTurnInterruptedError'
  }
}

class PlannerToolSelectionError extends Error {
  readonly code = 'PLANNER_TOOL_SELECTION_REQUIRED'

  constructor() {
    super('Planner returned no tool call while the runtime required one')
    this.name = 'PlannerToolSelectionError'
  }
}

/**
 * Extracts the first user-visible sentence from one Planner step.
 *
 * Before:
 * - "第6个账号未封禁，继续处理。\n后面的内部说明"
 *
 * After:
 * - "第6个账号未封禁，继续处理。"
 */
function extractPlannerPublicProgressText(content: string): string | undefined {
  let visible = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n').trim()
  if (!visible)
    return undefined

  const internalMarkerIndex = visible.search(
    /\[(?:memory_search|memory_write|system_notice|tool_execution|planner_trace)\]/i,
  )
  if (internalMarkerIndex === 0)
    return undefined
  if (internalMarkerIndex > 0)
    visible = visible.slice(0, internalMarkerIndex).trim()
  if (!visible)
    return undefined

  if (visible.startsWith('{') || visible.startsWith('[')) {
    try {
      const structured = JSON.parse(visible)
      if (structured !== null && typeof structured === 'object')
        return undefined
    }
    catch {
      // Normal conversational text may begin with punctuation resembling JSON.
    }
  }

  const lineEnd = visible.indexOf('\n')
  const sentenceEnd = visible.search(/[。！？!?]/u)
  let end = visible.length
  if (lineEnd >= 0)
    end = Math.min(end, lineEnd)
  if (sentenceEnd >= 0)
    end = Math.min(end, sentenceEnd + 1)

  const sentence = visible.slice(0, end).trim()
  if (!sentence)
    return undefined
  return sentence.slice(0, 320).trim()
}

async function executeAbortableRequest<T>(options: {
  label: string
  parentSignal: AbortSignal
  timeoutMs: number
  execute: (signal: AbortSignal) => Promise<T>
}): Promise<T> {
  if (options.parentSignal.aborted)
    throw options.parentSignal.reason ?? new AgentTurnInterruptedError()

  const controller = new AbortController()
  const abortFromParent = (): void => {
    controller.abort(options.parentSignal.reason ?? new AgentTurnInterruptedError())
  }
  options.parentSignal.addEventListener('abort', abortFromParent, { once: true })

  let rejectOnAbort: (() => void) | undefined
  const aborted = new Promise<T>((_resolve, reject) => {
    rejectOnAbort = () => {
      reject(controller.signal.reason ?? new AgentTurnInterruptedError())
    }
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
  })
  const timeout = setTimeout(() => {
    controller.abort(new Error(`${options.label} timed out after ${options.timeoutMs} ms`))
  }, options.timeoutMs)

  try {
    return await Promise.race([
      options.execute(controller.signal),
      aborted,
    ])
  }
  finally {
    clearTimeout(timeout)
    if (rejectOnAbort)
      controller.signal.removeEventListener('abort', rejectOnAbort)
    options.parentSignal.removeEventListener('abort', abortFromParent)
  }
}

function serializeToolEvidence(value: unknown): string {
  if (typeof value === 'string')
    return value
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, milliseconds))
}
