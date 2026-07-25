import type { ContextUpdate, MetadataEventSource, WebSocketEventInputs } from '@proj-airi/server-shared/types'
import type { AssistantMessage, CommonContentPart, CompletionToolCall, Message, SystemMessage, ToolMessage, UserMessage } from '@xsai/shared-chat'

export interface ChatSlicesText {
  type: 'text'
  text: string
  source?: 'assistant' | 'tool-progress'
}

/** Image authored by the assistant and rendered as part of chat history. */
export interface ChatSlicesImage {
  type: 'image'
  url: string
  alt?: string
}

export interface ChatSlicesToolCall {
  type: 'tool-call'
  toolCall: CompletionToolCall
}

export interface ChatSlicesToolCallResult {
  type: 'tool-call-result'
  id: string
  isError?: boolean
  result?: string | CommonContentPart[]
}

export type ChatSlices = ChatSlicesText | ChatSlicesImage | ChatSlicesToolCall | ChatSlicesToolCallResult

export interface ChatAssistantMessage extends AssistantMessage {
  slices: ChatSlices[]
  tool_results: {
    id: string
    isError?: boolean
    result?: string | CommonContentPart[]
  }[]
  categorization?: {
    speech: string
    reasoning: string
  }
}

export type ChatMessage = ChatAssistantMessage | SystemMessage | ToolMessage | UserMessage

export interface ErrorMessage {
  role: 'error'
  content: string
}

export interface ContextMessage extends ContextUpdate<Record<string, unknown>, unknown> {
  metadata?: {
    source: MetadataEventSource
  }
  createdAt: number
}

/** Identifies the speaker that authored one persisted chat history item. */
export interface ChatActorMetadata {
  /** Stable actor ID. Human actors use Lumi's internal user ID; the assistant uses its persona ID. */
  actorId?: string
  /** Display label captured for provider projection and historical rendering. */
  actorDisplayName?: string
}

/** Immutable interaction identity passed through one conversation turn. */
export interface ChatInteractionContext {
  /** Stable conversation ID. */
  conversationId: string
  /**
   * Transport or social platform that originated the turn.
   *
   * This is a language-affinity and observability hint only. It must never be
   * used as an authentication or memory-authorization claim.
   */
  platform?: string
  /** Direct conversations have one human participant; group conversations have multiple. */
  conversationType: 'direct' | 'group'
  /** Actor sending the current user turn. */
  actorId: string
  /** Human-readable actor label used in group prompt projection. */
  actorDisplayName?: string
  /** Complete human participant audience for this conversation. */
  participantIds: string[]
  /** Authenticated remote tool scopes. Undefined means a trusted local turn; an empty list denies every tool. */
  toolScopes?: string[]
  /** Authenticated remote device ID. Undefined for trusted local turns. */
  remoteDeviceId?: string
}

export type ChatHistoryItem = (ChatMessage | ErrorMessage) & { context?: ContextMessage } & ChatActorMetadata & { createdAt?: number, id?: string }

export interface ChatStreamEventContext {
  message: ChatHistoryItem
  contexts: Record<string, ContextMessage[]>
  composedMessage: Array<Message>
  input?: WebSocketEventInputs
}

export type ChatStreamEvent
  = | { type: 'before-compose', message: string, sessionId: string, context: Omit<ChatStreamEventContext, 'composedMessage'> }
    | { type: 'after-compose', message: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'before-send', message: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'after-send', message: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'token-literal', literal: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'token-special', special: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'stream-end', sessionId: string, context: ChatStreamEventContext }
    | { type: 'assistant-end', message: string, sessionId: string, context: ChatStreamEventContext }
    | { type: 'assistant-message', message: ChatAssistantMessage, sessionId: string, messageText: string, context: ChatStreamEventContext }

export type StreamingAssistantMessage = ChatAssistantMessage & { context?: ContextMessage } & ChatActorMetadata & { createdAt?: number, id?: string }
