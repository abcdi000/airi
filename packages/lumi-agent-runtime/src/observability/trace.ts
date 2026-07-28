import type { ModelUsage, PlannerToolCall } from '../ports/model'
import type { LumiPromptTemplateMetadata } from '../prompts/templates'

/** Redacted prompt message retained only when private prompt logging is enabled. */
export interface AgentTracePromptMessage {
  role: string
  content: string
}

/** End reasons emitted by one host-managed direct turn. */
export type AgentTurnEndReason
  = | 'planner_finished'
    | 'reply_sent'
    | 'max_rounds'
    | 'interrupted'
    | 'failed'

/** Privacy-safe trace event produced by the shared Agent Runtime. */
export type AgentTraceEvent
  = | {
    type: 'turn_started'
    turnId: string
    conversationId: string
    personId: string
    generation: number
    timestamp: number
  }
  | {
    type: 'planner_step'
    turnId: string
    round: number
    durationMs: number
    toolCalls: readonly Pick<PlannerToolCall, 'id' | 'name' | 'dependsOn'>[]
    usage?: ModelUsage
    modelName?: string
    timestamp: number
  }
  | {
    type: 'tool_execution'
    turnId: string
    stepId: string
    toolName: string
    status: 'started' | 'succeeded' | 'failed' | 'skipped'
    durationMs?: number
    errorCode?: string
    timestamp: number
  }
  | {
    type: 'model_request'
    turnId: string
    purpose: 'planner' | 'replyer' | 'replyer_retry' | 'context_summary'
    status: 'completed' | 'error'
    durationMs: number
    prompt: LumiPromptTemplateMetadata
    messageCount: number
    toolCount?: number
    requestedToolChoice?: 'auto' | 'required'
    messages?: readonly AgentTracePromptMessage[]
    usage?: ModelUsage
    modelName?: string
    errorMessage?: string
    timestamp: number
  }
  | {
    type: 'reply_validation'
    turnId: string
    passed: boolean
    issues: readonly string[]
    retryCount: number
    timestamp: number
  }
  | {
    type: 'turn_finished'
    turnId: string
    reason: AgentTurnEndReason
    sentMessageIds: readonly string[]
    timestamp: number
  }

/** Host-owned sink for private-runtime telemetry. */
export interface AgentTracePort {
  record: (event: AgentTraceEvent) => Promise<void> | void
}
