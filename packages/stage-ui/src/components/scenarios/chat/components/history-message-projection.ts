import type { ChatHistoryItem } from '../../../../types/chat'

/**
 * Projects persisted chat entries into the roles understood by the history UI.
 *
 * Use when:
 * - Rendering runtime memory and tool diagnostics stored as system messages.
 * - Preserving original array positions for retry and delete actions.
 *
 * Expects:
 * - Runtime diagnostics begin with a supported bracketed marker.
 *
 * Returns:
 * - The original message, or an assistant-shaped diagnostic message that uses
 *   the green debug-card renderer.
 */
export function projectHistoryMessage(message: ChatHistoryItem): ChatHistoryItem {
  const content = typeof message.content === 'string' ? message.content : ''
  if (!/^\[(?:memory_search|memory_write|system_notice)\]/.test(content.trim()))
    return message

  return {
    role: 'assistant',
    content,
    slices: [{ type: 'text', text: content }],
    tool_results: [],
    id: message.id,
    createdAt: message.createdAt,
  }
}
