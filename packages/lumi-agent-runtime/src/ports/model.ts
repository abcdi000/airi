/**
 * JSON-schema-shaped model tool definition.
 */
export interface PlannerToolDefinition {
  name: string
  description: string
  inputSchema: Readonly<Record<string, unknown>>
}

/** One tool call emitted by a single Planner model step. */
export interface PlannerToolCall {
  id: string
  name: string
  arguments: Readonly<Record<string, unknown>>
  /** Optional dependency call IDs declared by a host-aware model adapter. */
  dependsOn?: readonly string[]
}

/** Provider token and cache telemetry for one completed model step. */
export interface ModelUsage {
  inputTokens?: number
  outputTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
}

/** Provider-neutral Planner message. */
export type PlannerMessage
  = | { role: 'system', content: string }
    | { role: 'user', content: string }
    | { role: 'assistant', content: string, reasoning?: string, toolCalls?: readonly PlannerToolCall[] }
    | { role: 'tool', content: string, toolCallId: string, toolName: string }

/**
 * Runs exactly one Planner model step.
 *
 * Implementations must not execute tools or automatically continue to another
 * model step.
 */
export interface PlannerModelPort {
  generateStep: (input: {
    messages: readonly PlannerMessage[]
    tools: readonly PlannerToolDefinition[]
    signal?: AbortSignal
  }) => Promise<{
    content: string
    reasoning?: string
    toolCalls: readonly PlannerToolCall[]
    usage?: ModelUsage
    modelName?: string
  }>
}

/** Purpose labels used for tool-free language model requests. */
export type LanguageModelPurpose
  = | 'replyer'
    | 'replyer_retry'
    | 'expression_selector'
    | 'expression_learning'
    | 'jargon_learning'
    | 'behavior_learning'
    | 'public_knowledge_learning'
    | 'feedback'
    | 'context_summary'
    | 'sticker_classifier'
    | 'sticker_selector'

/** A provider-neutral no-tool language message. */
export interface LanguageModelMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Generates text for a named, tool-free language task.
 */
export interface LanguageModelPort {
  generate: (
    messages: readonly LanguageModelMessage[],
    purpose: LanguageModelPurpose,
    signal?: AbortSignal,
  ) => Promise<string>
}
