import type { DirectPerceptionEnvelope } from '../input'
import type { AgentTracePort } from '../observability/trace'
import type { OutboundSecurityAuditPort } from '../policy/outbound-guard'
import type { CognitiveContextPort } from '../ports/cognitive'
import type { IdentityPort } from '../ports/identity'
import type { MemoryPort } from '../ports/memory'
import type { LanguageModelPort, PlannerModelPort } from '../ports/model'
import type { DirectOutboundAdapter } from '../ports/outbound'
import type { AgentPersistencePort } from '../ports/persistence'
import type { ReplyPolicyPort } from '../ports/reply'
import type { SocialLanguagePort } from '../ports/social-language'
import type { StickerPort } from '../ports/stickers'
import type { AgentToolsPort } from '../ports/tools'
import type { DirectTurnResult, LumiAgentRuntimeMode, PlannerFinalizationMode } from './session-runtime'

import { validateDirectPerceptionEnvelope } from '../input'
import { DirectOutboundAuthority } from '../policy/outbound-guard'
import {
  buildDefaultPlannerSystemPrompt,
  buildDefaultReplyerSystemPrompt,
  DEFAULT_CONTEXT_SUMMARY_SYSTEM_PROMPT,
} from '../prompts/defaults'
import { createLumiPromptTemplate } from '../prompts/templates'
import { ReplyerService } from '../replyer/replyer-service'
import { SessionRuntime } from './session-runtime'

/** Configuration for the platform-neutral direct Lumi Agent Runtime. */
export interface LumiAgentRuntimeConfig {
  /** @default maisaka */
  runtimeMode?: LumiAgentRuntimeMode
  /** @default 10 */
  plannerMaxRounds?: number
  /** Consecutive no-tool Planner results retried before the runtime requests a natural Replyer response. @default 2 */
  plannerNoToolRetryLimit?: number
  /** @default stop_after_successful_reply */
  plannerFinalizationMode?: PlannerFinalizationMode
  /** @default 80 */
  mergeWindowMs?: number
  /** @default 4 */
  toolMaxConcurrency?: number
  /** @default 30000 */
  toolStepTimeoutMs?: number
  /** Maximum time for one Planner model request. @default 90000 */
  plannerRequestTimeoutMs?: number
  /** Maximum time allowed for automatic shallow recall and cognitive assembly. @default 3000 */
  cognitiveContextTimeoutMs?: number
  /** Allows `tool_search` to discover deferred MCP, plugin, and Tool Mesh tools. @default true */
  deferredToolsEnabled?: boolean
  /** Allows the social-language port to run its model-backed precise expression selector. @default true */
  expressionSelectorEnabled?: boolean
  /** Allows verified direct messages to update existing group-learned candidate weights. @default true */
  directLanguageFeedbackEnabled?: boolean
  /** Allows private prompt bodies in host-owned traces after recursive redaction. @default false */
  promptLoggingEnabled?: boolean
  /** Stable Planner behavior prompt, excluding current-time and turn data. */
  plannerSystemPrompt?: string
  /** @default lumi-planner:v2 */
  plannerPromptVersion?: string
  /** Stable no-tool Replyer persona and language prompt. */
  replyerSystemPrompt?: string
  /** @default lumi-replyer:v2 */
  replyerPromptVersion?: string
  /** Stable context checkpoint prompt. */
  contextSummarySystemPrompt?: string
  /** @default lumi-context-summary:v2 */
  contextSummaryPromptVersion?: string
  /** @default true */
  multiMessageReplyEnabled?: boolean
  /** @default 700000 */
  plannerHistoryBudgetTokens?: number
  /** Hard history-message cap independent of approximate token counting. @default 120 */
  plannerHistoryMaxMessages?: number
  /** @default 760000 */
  contextCompactionThresholdTokens?: number
  /** @default 160000 */
  contextRecentTokens?: number
  /** Starts compaction when context-bearing history exceeds this count. @default 160 */
  contextCompactionThresholdMessages?: number
  /** Newest context-bearing messages retained verbatim after compaction. @default 96 */
  contextRecentMessages?: number
  /** Idle time before background context compaction may use the model. @default 15000 */
  contextCompactionIdleMs?: number
}

/**
 * Coordinates isolated per-conversation Lumi direct sessions.
 *
 * Use when:
 * - Desktop Lumi or Lumi Server has authenticated a direct perception
 * - The host supplies platform, model, persistence, identity, and policy ports
 *
 * Expects:
 * - Group observations are routed to GroupObservationRuntime instead
 *
 * Returns:
 * - One structured turn result after visible output or a safe terminal state
 */
export class LumiAgentRuntime {
  readonly #sessions = new Map<string, SessionRuntime>()
  readonly #options: {
    config: Required<LumiAgentRuntimeConfig>
    plannerModel: PlannerModelPort
    languageModel: LanguageModelPort
    persistence: AgentPersistencePort
    identity: IdentityPort
    cognitive?: CognitiveContextPort
    memory?: MemoryPort
    replyPolicy: ReplyPolicyPort
    socialLanguage?: SocialLanguagePort
    sticker?: StickerPort
    tools?: AgentToolsPort
    trace?: AgentTracePort
    outbound: DirectOutboundAuthority
  }

  constructor(options: {
    config?: LumiAgentRuntimeConfig
    plannerModel: PlannerModelPort
    languageModel: LanguageModelPort
    persistence: AgentPersistencePort
    identity: IdentityPort
    cognitive?: CognitiveContextPort
    memory?: MemoryPort
    replyPolicy: ReplyPolicyPort
    socialLanguage?: SocialLanguagePort
    sticker?: StickerPort
    tools?: AgentToolsPort
    trace?: AgentTracePort
    outboundAdapter: DirectOutboundAdapter
    outboundAudit: OutboundSecurityAuditPort
  }) {
    this.#options = {
      config: normalizeConfig(options.config),
      plannerModel: options.plannerModel,
      languageModel: options.languageModel,
      persistence: options.persistence,
      identity: options.identity,
      cognitive: options.cognitive,
      memory: options.memory,
      replyPolicy: options.replyPolicy,
      socialLanguage: options.socialLanguage,
      sticker: options.sticker,
      tools: options.tools,
      trace: options.trace,
      outbound: new DirectOutboundAuthority(options.outboundAdapter, options.outboundAudit),
    }
  }

  ingestDirect(envelope: DirectPerceptionEnvelope): Promise<DirectTurnResult> {
    validateDirectPerceptionEnvelope(envelope)
    return this.#session(envelope.conversationId).ingest(envelope)
  }

  /**
   * Re-arms waits persisted before a host restart.
   *
   * Hosts should call this once after constructing their persistence adapter.
   */
  async resumePersistedSessions(): Promise<void> {
    const conversationIds = await this.#options.persistence.listWaitingSessionIds?.() ?? []
    await Promise.all(conversationIds.map(async conversationId =>
      await this.#session(conversationId).resume(),
    ))
  }

  async drain(): Promise<void> {
    await Promise.all([...this.#sessions.values()].map(session => session.drain()))
  }

  #session(conversationId: string): SessionRuntime {
    let session = this.#sessions.get(conversationId)
    if (!session) {
      const replyer = new ReplyerService({
        model: this.#options.languageModel,
        prompt: createLumiPromptTemplate(
          'replyer',
          this.#options.config.replyerSystemPrompt,
          this.#options.config.replyerPromptVersion,
        ),
        promptLoggingEnabled: this.#options.config.promptLoggingEnabled,
        multiMessageEnabled: this.#options.config.multiMessageReplyEnabled,
        maximumMessages: 3,
        historyBudgetTokens: Math.min(256_000, this.#options.config.plannerHistoryBudgetTokens),
        trace: this.#options.trace,
      })
      session = new SessionRuntime({
        conversationId,
        config: this.#options.config,
        plannerModel: this.#options.plannerModel,
        languageModel: this.#options.languageModel,
        replyer,
        persistence: this.#options.persistence,
        identity: this.#options.identity,
        cognitive: this.#options.cognitive,
        memory: this.#options.memory,
        replyPolicy: this.#options.replyPolicy,
        socialLanguage: this.#options.socialLanguage,
        sticker: this.#options.sticker,
        tools: this.#options.tools,
        trace: this.#options.trace,
        outbound: this.#options.outbound,
      })
      this.#sessions.set(conversationId, session)
    }
    return session
  }
}

function normalizeConfig(config: LumiAgentRuntimeConfig = {}): Required<LumiAgentRuntimeConfig> {
  return {
    runtimeMode: config.runtimeMode ?? 'maisaka',
    plannerMaxRounds: boundedInteger(config.plannerMaxRounds, 10, 1, 32),
    plannerNoToolRetryLimit: boundedInteger(config.plannerNoToolRetryLimit, 2, 0, 8),
    plannerFinalizationMode: config.plannerFinalizationMode ?? 'stop_after_successful_reply',
    mergeWindowMs: boundedInteger(config.mergeWindowMs, 80, 0, 5_000),
    toolMaxConcurrency: boundedInteger(config.toolMaxConcurrency, 4, 1, 32),
    toolStepTimeoutMs: boundedInteger(config.toolStepTimeoutMs, 30_000, 10, 600_000),
    plannerRequestTimeoutMs: boundedInteger(config.plannerRequestTimeoutMs, 90_000, 1_000, 300_000),
    cognitiveContextTimeoutMs: boundedInteger(config.cognitiveContextTimeoutMs, 3_000, 100, 30_000),
    deferredToolsEnabled: config.deferredToolsEnabled ?? true,
    expressionSelectorEnabled: config.expressionSelectorEnabled ?? true,
    directLanguageFeedbackEnabled: config.directLanguageFeedbackEnabled ?? true,
    promptLoggingEnabled: config.promptLoggingEnabled ?? false,
    plannerSystemPrompt: config.plannerSystemPrompt ?? buildDefaultPlannerSystemPrompt(),
    plannerPromptVersion: config.plannerPromptVersion ?? 'lumi-planner:v3',
    replyerSystemPrompt: config.replyerSystemPrompt ?? buildDefaultReplyerSystemPrompt(),
    replyerPromptVersion: config.replyerPromptVersion ?? 'lumi-replyer:v3',
    contextSummarySystemPrompt: config.contextSummarySystemPrompt
      ?? DEFAULT_CONTEXT_SUMMARY_SYSTEM_PROMPT,
    contextSummaryPromptVersion: config.contextSummaryPromptVersion ?? 'lumi-context-summary:v2',
    multiMessageReplyEnabled: config.multiMessageReplyEnabled ?? true,
    contextCompactionIdleMs: boundedInteger(config.contextCompactionIdleMs, 15_000, 0, 600_000),
    ...normalizeContextBudgets(config),
  }
}

function normalizeContextBudgets(config: LumiAgentRuntimeConfig): Pick<
  Required<LumiAgentRuntimeConfig>,
  | 'plannerHistoryBudgetTokens'
  | 'plannerHistoryMaxMessages'
  | 'contextCompactionThresholdTokens'
  | 'contextRecentTokens'
  | 'contextCompactionThresholdMessages'
  | 'contextRecentMessages'
> {
  const plannerHistoryBudgetTokens = boundedInteger(
    config.plannerHistoryBudgetTokens,
    700_000,
    1_000,
    1_000_000,
  )
  const requestedThreshold = boundedInteger(
    config.contextCompactionThresholdTokens,
    760_000,
    2_000,
    1_000_000,
  )
  // Older development builds persisted thresholds only slightly above 70k.
  // A threshold below the Planner budget causes every ordinary turn to launch
  // another background summary. Keep at least 60k of headroom.
  const contextCompactionThresholdTokens = Math.max(
    requestedThreshold,
    Math.min(1_000_000, plannerHistoryBudgetTokens + 60_000),
  )
  const requestedRecentTokens = boundedInteger(
    config.contextRecentTokens,
    160_000,
    1_000,
    900_000,
  )
  const contextRecentTokens = Math.min(
    requestedRecentTokens,
    Math.max(1_000, Math.floor(contextCompactionThresholdTokens / 2)),
  )
  const plannerHistoryMaxMessages = boundedInteger(
    config.plannerHistoryMaxMessages,
    120,
    8,
    2_000,
  )
  const contextCompactionThresholdMessages = boundedInteger(
    config.contextCompactionThresholdMessages,
    160,
    16,
    4_000,
  )
  const contextRecentMessages = Math.min(
    boundedInteger(config.contextRecentMessages, 96, 8, 2_000),
    Math.max(8, contextCompactionThresholdMessages - 1),
  )
  return {
    plannerHistoryBudgetTokens,
    plannerHistoryMaxMessages,
    contextCompactionThresholdTokens,
    contextRecentTokens,
    contextCompactionThresholdMessages,
    contextRecentMessages,
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value === undefined ? fallback : Math.floor(value)
  if (!Number.isFinite(candidate) || candidate < minimum || candidate > maximum)
    throw new RangeError(`Expected an integer between ${minimum} and ${maximum}`)
  return candidate
}
