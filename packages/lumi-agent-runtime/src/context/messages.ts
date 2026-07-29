import type { DirectAttachment, DirectPerceptionSegment } from '../input'
import type { PlannerToolCall } from '../ports/model'

/** Visibility rules applied when selecting context for a model request. */
export type ContextVisibility = 'planner' | 'replyer' | 'both' | 'internal'

/** Provenance retained for every context record. */
export interface ContextProvenance {
  origin: string
  sourceIds: readonly string[]
  metadata?: Readonly<Record<string, unknown>>
}

/** Fields shared by every typed Lumi context message. */
export interface ContextMessageBase {
  id: string
  timestamp: number
  countInContext: boolean
  remainingUses: number | null
  source: string
  visibility: ContextVisibility
  provenance: ContextProvenance
}

/** A real user message in a direct conversation. */
export interface DialogueUserMessage extends ContextMessageBase {
  kind: 'dialogue_user'
  messageId: string
  personId: string
  text: string
  segments: readonly DirectPerceptionSegment[]
  attachments: readonly DirectAttachment[]
}

/** One or more messages that Lumi actually sent to a direct user. */
export interface DialogueAssistantMessage extends ContextMessageBase {
  kind: 'dialogue_assistant'
  messageIds: readonly string[]
  textSegments: readonly string[]
  appliedExpressionIds: readonly string[]
  /** Exact expression and behavior assets eligible for later user feedback. */
  feedbackTargetIds?: readonly string[]
  stickerId?: string
}

/** A host-recorded Planner step that is never itself visible to the user. */
export interface PlannerAssistantMessage extends ContextMessageBase {
  kind: 'planner_assistant'
  round: number
  content: string
  reasoningSummary?: string
  toolCalls: readonly PlannerToolCall[]
}

/** Structured result paired with one Planner tool call. */
export interface ToolResultMessage extends ContextMessageBase {
  kind: 'tool_result'
  toolCallId: string
  toolName: string
  success: boolean
  result: unknown
}

/** Authorized context material projected from an external domain store. */
export interface ReferenceMessage extends ContextMessageBase {
  kind: 'reference'
  referenceType:
    | 'person_profile'
    | 'cognitive_context'
    | 'cognitive_expression'
    | 'memory'
    | 'public_group_knowledge'
    | 'behavior'
    | 'jargon'
    | 'continuity_summary'
    | 'context_restore'
    | 'tool_hint'
  content: string
  authorizationReason?: string
  confidence?: number
}

/** Typed message union stored by one direct Lumi session. */
export type LumiAgentContextMessage
  = | DialogueUserMessage
    | DialogueAssistantMessage
    | PlannerAssistantMessage
    | ToolResultMessage
    | ReferenceMessage

/** Returns whether a message may be projected to the named model stage. */
export function isVisibleTo(
  message: LumiAgentContextMessage,
  target: 'planner' | 'replyer',
): boolean {
  return message.visibility === 'both' || message.visibility === target
}
