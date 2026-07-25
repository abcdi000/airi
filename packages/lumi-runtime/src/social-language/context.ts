import type { LumiLanguageModelMessage } from './types'

const CONTINUITY_SUMMARY_MARKER = '[Lumi conversation continuity summary]'

/** Inputs used to divide one provider context window between Lumi stages. */
export interface LumiAdaptiveContextBudgetInput {
  /** Hard provider/model context ceiling. */
  providerMaxContextTokens: number
  /** Estimated tokens in the persisted conversation projection. */
  estimatedHistoryTokens: number
  /** Tokens reserved for model reasoning and output. */
  outputReserveTokens: number
  /** Tokens reserved for persona, memories, runtime context, and tool schemas. */
  promptReserveTokens: number
  /** Number of currently exposed tools. */
  toolCount: number
}

/** Token budgets selected for Planner and Replyer. */
export interface LumiAdaptiveContextBudget {
  /** Context window passed to the rolling Planner compressor. */
  plannerContextWindowTokens: number
  /** Approximate Planner history target after compression. */
  plannerHistoryTokens: number
  /** Maximum verbatim history carried into final wording. */
  replyerHistoryTokens: number
}

/** Replyer projection separated from Planner-only instructions. */
export interface LumiReplyerContextProjection {
  /** Canonical system prompt shared by Planner and Replyer. */
  sharedSystemPrompt?: string
  /** Native user/assistant turns retained for wording and rhythm. */
  history: LumiLanguageModelMessage[]
  /** Existing model-authored summary of older authorized turns. */
  continuitySummary?: string
  /** Number of dialogue messages omitted from the wording stage. */
  omittedMessageCount: number
  /** Conservative token estimate for retained dialogue. */
  estimatedHistoryTokens: number
}

/**
 * Selects continuously scaling stage budgets below the provider ceiling.
 *
 * Use when:
 * - Planner needs broad semantic and tool context
 * - Replyer needs a smaller wording-focused projection
 *
 * Expects:
 * - The provider ceiling includes output and prompt reserves
 * - Persisted history remains available outside this active projection
 *
 * Returns:
 * - A larger Planner window and a smaller Replyer history budget
 */
export function selectLumiAdaptiveContextBudget(
  input: LumiAdaptiveContextBudgetInput,
): LumiAdaptiveContextBudget {
  const providerMaximum = boundedInteger(input.providerMaxContextTokens, 32_000, 1_000_000)
  const outputReserve = boundedInteger(input.outputReserveTokens, 1_024, Math.floor(providerMaximum * 0.4))
  const promptReserve = boundedInteger(input.promptReserveTokens, 1_024, Math.floor(providerMaximum * 0.4))
  const historyTokens = Math.max(0, Math.round(input.estimatedHistoryTokens))
  const toolOverhead = Math.min(48_000, Math.max(0, Math.round(input.toolCount)) * 640)

  // Square-root growth lets longer conversations retain progressively more
  // verbatim context without making the provider maximum an input target.
  const desiredPlannerHistory = boundedInteger(
    32_000 + Math.sqrt(historyTokens) * 128 + toolOverhead,
    48_000,
    256_000,
  )
  const availableProviderHistory = Math.max(8_000, providerMaximum - outputReserve - promptReserve)
  const plannerHistoryTokens = Math.min(desiredPlannerHistory, availableProviderHistory)

  // The compressor targets 68% of its available history space. Account for
  // that ratio here so the resulting projection lands near the desired size.
  const plannerContextWindowTokens = Math.min(
    providerMaximum,
    Math.max(
      32_000,
      outputReserve + promptReserve + Math.ceil(plannerHistoryTokens / 0.68),
    ),
  )
  const replyerHistoryTokens = Math.min(
    plannerHistoryTokens,
    boundedInteger(16_000 + Math.sqrt(historyTokens) * 64, 24_000, 64_000),
  )

  return {
    plannerContextWindowTokens,
    plannerHistoryTokens,
    replyerHistoryTokens,
  }
}

/**
 * Projects Planner history into Replyer's wording context.
 *
 * Use when:
 * - Planner has already selected the semantic reply intent
 * - Internal system/tool protocol must not be repeated to Replyer
 *
 * Expects:
 * - History is chronological
 * - Any durable summary uses Lumi's continuity-summary marker
 *
 * Returns:
 * - The durable summary plus newest native dialogue within the token budget
 */
export function projectLumiReplyerContext(input: {
  history: LumiLanguageModelMessage[]
  maxHistoryTokens: number
}): LumiReplyerContextProjection {
  const sharedSystemPrompt = input.history.find(
    message => message.role === 'system' && !message.content.includes(CONTINUITY_SUMMARY_MARKER),
  )?.content
  const canonicalSystemPrompt = sharedSystemPrompt
    ? stripPlannerContract(sharedSystemPrompt)
    : undefined
  const continuitySummary = input.history
    .filter(message => message.role === 'system' && message.content.includes(CONTINUITY_SUMMARY_MARKER))
    .map(message => message.content.slice(message.content.indexOf(CONTINUITY_SUMMARY_MARKER) + CONTINUITY_SUMMARY_MARKER.length).trim())
    .filter(Boolean)
    .join('\n\n')
  const dialogue = input.history.filter(
    (message): message is LumiLanguageModelMessage & { role: 'user' | 'assistant' } =>
      message.role === 'user' || message.role === 'assistant',
  )
  const maximum = Math.max(256, Math.round(input.maxHistoryTokens))
  const selected: LumiLanguageModelMessage[] = []
  let tokens = 0

  for (let index = dialogue.length - 1; index >= 0; index -= 1) {
    const message = dialogue[index]!
    const messageTokens = estimateLumiLanguageMessageTokens(message)
    if (selected.length > 0 && tokens + messageTokens > maximum)
      break
    selected.unshift(message)
    tokens += messageTokens
  }

  return {
    sharedSystemPrompt: canonicalSystemPrompt,
    history: selected,
    continuitySummary: continuitySummary || undefined,
    omittedMessageCount: Math.max(0, dialogue.length - selected.length),
    estimatedHistoryTokens: tokens,
  }
}

/**
 * Normalizes a system prompt by removing the legacy inline Planner contract.
 *
 * Before:
 * - `"Persona\n[Lumi final-response planning contract]\n...\n[/Lumi final-response planning contract]"`
 *
 * After:
 * - `"Persona"`
 */
function stripPlannerContract(value: string) {
  return value
    .replace(
      /\s*\[Lumi final-response planning contract\][\s\S]*?(?:\[\/Lumi final-response planning contract\]\s*|$)/gu,
      '\n',
    )
    .trim()
}

/** Estimates native language-message tokens without a provider tokenizer. */
export function estimateLumiLanguageMessageTokens(message: LumiLanguageModelMessage) {
  const bytes = new TextEncoder().encode(message.content).byteLength
  return Math.max(1, Math.ceil(bytes / 3)) + 8
}

/** Estimates a chronological native language-message list. */
export function estimateLumiLanguageTokens(messages: LumiLanguageModelMessage[]) {
  return messages.reduce((total, message) => total + estimateLumiLanguageMessageTokens(message), 0)
}

function boundedInteger(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value))
    return minimum
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}
