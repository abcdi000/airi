import type { DialogueAssistantMessage, DialogueUserMessage, LumiAgentContextMessage, ReferenceMessage } from './messages'

import { isVisibleTo } from './messages'

/** Context shape allowed to cross into the no-tool Replyer. */
export type ReplyerHistoryMessage = DialogueUserMessage | DialogueAssistantMessage | ReferenceMessage

/**
 * Projects context into the strict Replyer visibility boundary.
 *
 * Planner records, tool calls, tool results, and internal references are
 * excluded even when accidentally marked with a broad visibility value.
 */
export function projectReplyerHistory(
  messages: readonly LumiAgentContextMessage[],
): readonly ReplyerHistoryMessage[] {
  return messages.filter((message): message is ReplyerHistoryMessage => {
    if (!isVisibleTo(message, 'replyer'))
      return false
    if (message.kind === 'dialogue_user' || message.kind === 'dialogue_assistant')
      return true
    return message.kind === 'reference'
      && (message.referenceType === 'continuity_summary'
        || message.referenceType === 'behavior'
        || message.referenceType === 'jargon')
  })
}
