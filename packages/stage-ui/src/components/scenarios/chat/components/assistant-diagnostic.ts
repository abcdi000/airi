import type { ChatAssistantMessage, ChatSlicesText } from '../../../../types/chat'

export interface AssistantDiagnostic {
  title: string
  summary: string
  body: string
}

/**
 * Parses an internal Lumi runtime notice before normal chat text is sanitized.
 *
 * Use when:
 * - Rendering persisted memory and tool progress as a diagnostic card
 * - Distinguishing internal notices from visible assistant replies
 *
 * Expects:
 * - Runtime notices begin with a supported marker on their first line
 *
 * Returns:
 * - A presentational diagnostic, or `null` for an ordinary assistant message
 */
export function parseAssistantDiagnostic(message: ChatAssistantMessage): AssistantDiagnostic | null {
  const text = extractRawText(message)
  const lines = text.trim().split(/\r?\n/)
  const match = lines[0]?.match(/^\[(memory_search|memory_write|system_notice)\]$/)
  if (!match)
    return null

  const kind = match[1] as 'memory_search' | 'memory_write' | 'system_notice'
  const body = lines.slice(1).join('\n').trim()
  const status = lines.slice(1).find(line => /^status:/.test(line))?.replace(/^status:\s*/, '')
  const found = lines.slice(1).find(line => /^found:/.test(line))?.replace(/^found:\s*/, '')
  const stored = lines.slice(1).find(line => /^stored:/.test(line))?.replace(/^stored:\s*/, '')
  const activity = lines.slice(1).find(line => /^activity:/.test(line))?.replace(/^activity:\s*/, '')
  const decision = lines.slice(1).find(line => /^decision:/.test(line))?.replace(/^decision:\s*/, '')

  return {
    title: kind === 'memory_search'
      ? '记忆检索'
      : kind === 'memory_write'
        ? '记忆写入'
        : '系统提示',
    summary: [
      status ? `状态 ${status}` : undefined,
      found ? `命中 ${found}` : undefined,
      stored ? `写入 ${stored}` : undefined,
      activity ? `活动 ${activity}` : undefined,
      decision ? `决策 ${decision}` : undefined,
    ]
      .filter(Boolean)
      .join(' · '),
    body,
  }
}

function extractRawText(message: ChatAssistantMessage): string {
  if (message.slices?.length) {
    const text = message.slices
      .filter((slice): slice is ChatSlicesText => slice.type === 'text')
      .map(slice => slice.text)
      .join('\n')
      .trim()
    if (text)
      return text
  }

  if (typeof message.content === 'string')
    return message.content.trim()

  if (!Array.isArray(message.content))
    return ''

  return message.content
    .filter((part): part is Extract<typeof part, { type: 'text' }> => 'type' in part && part.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim()
}
