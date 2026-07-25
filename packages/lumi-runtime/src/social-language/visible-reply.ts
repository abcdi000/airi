import type { LumiVisibleReply } from './types'

import { isRecord, parseJsonObject, stringArray, stringValue } from './json'

/** Parses the strict Replyer output and enforces message-count and delay limits. */
export function parseLumiVisibleReply(raw: string, options?: {
  multiMessageEnabled?: boolean
  maximumMessages?: number
  allowedExpressionIds?: string[]
}): LumiVisibleReply | null {
  const parsed = parseJsonObject(raw)
  if (!parsed || !Array.isArray(parsed.messages))
    return null
  const maximum = options?.multiMessageEnabled === false
    ? 1
    : Math.max(1, Math.min(3, options?.maximumMessages ?? 3))
  const messages = parsed.messages.flatMap((item) => {
    if (!isRecord(item))
      return []
    const text = stringValue(item.text, '', 20_000)
    if (!text)
      return []
    const delay = Number(item.delayMs ?? item.delay_ms)
    return [{
      text,
      delayMs: Number.isFinite(delay) ? Math.max(0, Math.min(5_000, Math.round(delay))) : undefined,
      quoteMessageId: stringValue(item.quoteMessageId ?? item.quote_message_id, '', 240) || undefined,
    }]
  }).slice(0, maximum)
  const allowedExpressionIds = new Set(options?.allowedExpressionIds ?? [])
  const appliedExpressionIds = stringArray(
    parsed.appliedExpressionIds ?? parsed.applied_expression_ids,
    32,
    240,
  ).filter(id => allowedExpressionIds.has(id))
  return {
    messages,
    appliedExpressionIds,
  }
}

/** Converts an old single-string reply into the current structured format. */
export function visibleReplyFromText(text: string): LumiVisibleReply {
  const normalized = text.trim()
  return { messages: normalized ? [{ text: normalized }] : [] }
}

/** Returns the text representation persisted by hosts that do not support bubble metadata. */
export function flattenLumiVisibleReply(reply: LumiVisibleReply) {
  return reply.messages.map(message => message.text.trim()).filter(Boolean).join('\n\n')
}
