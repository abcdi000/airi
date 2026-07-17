export interface LumiMemoryContextMessage {
  role: string
  content: string
}

export interface LumiContextualMemoryQueryInput {
  currentMessage: string
  recentMessages?: LumiMemoryContextMessage[]
  maxMessages?: number
}

export interface LumiContextualMemoryQuery {
  query: string
  topicWindow: string
  topicHints: string[]
}

export interface LumiMemoryTopicAnalysis {
  topicWindow: string
  topicHints: string[]
  storagePrefix?: string
  confidence: number
}

const CONTEXT_DEPENDENT_MARKERS = [
  'entity',
  'level',
  'character',
  'role',
  'movie',
  'game',
  'item',
  'place',
  'backrooms',
  '\u5b9e\u4f53',
  '\u5c42\u7ea7',
  '\u89d2\u8272',
  '\u7535\u5f71',
  '\u6e38\u620f',
  '\u7269\u54c1',
  '\u5730\u65b9',
  '\u540e\u5ba4',
]

const TOPIC_HINTS: Array<[RegExp, string]> = [
  [/\bbackrooms?\b|\u540e\u5ba4/i, 'Backrooms / \u540e\u5ba4'],
  [/\bscp\b/i, 'SCP'],
  [/\bminecraft\b|\u6211\u7684\u4e16\u754c/i, 'Minecraft'],
  [/\bairi\b/i, 'AIRI'],
  [/\blumi\b/i, 'Lumi'],
]

export function buildLumiContextualMemoryQuery(input: LumiContextualMemoryQueryInput): LumiContextualMemoryQuery {
  const currentMessage = input.currentMessage.trim()
  const recent = (input.recentMessages ?? [])
    .filter(message => message.content.trim())
    .slice(-(input.maxMessages ?? 6))

  const topicHints = extractTopicHints(currentMessage, recent)
  const topicWindow = buildTopicWindow(recent, topicHints)
  const query = [
    currentMessage,
    topicHints.length ? `Resolved topic hints: ${topicHints.join(', ')}` : '',
    topicWindow ? `Recent topic window: ${topicWindow}` : '',
  ].filter(Boolean).join('\n')

  return { query, topicWindow, topicHints }
}

export function isContextDependentMemoryText(text: string): boolean {
  const lowered = text.toLowerCase()
  return CONTEXT_DEPENDENT_MARKERS.some(marker => lowered.includes(marker.toLowerCase()))
}

export function buildLumiMemoryTopicAnalyzerPrompt(): string {
  return [
    'You are PersonaOS memory topic analyzer, not Lumi. Do not chat with the user.',
    'Your job is to identify the active topic window for memory retrieval and storage.',
    'Read recent_messages and current_user_message. Decide the earliest recent message that still belongs to the active topic and summarize that topic.',
    'This is especially important for context-dependent words such as entity, level, character, item, place, movie, or their Chinese equivalents.',
    'Output JSON only. Do not use Markdown.',
    'Schema:',
    '{"topic_window":"short self-contained topic summary","topic_hints":["Backrooms"],"storage_prefix":"In the Backrooms context","confidence":0.86}',
    'Rules:',
    '- topic_window must be self-contained and should not include irrelevant old conflict, apology, or unrelated task context.',
    '- topic_hints should contain stable topic labels only, not every keyword.',
    '- storage_prefix should be a short English phrase that can prefix a memory if the user statement depends on the topic.',
    '- If no topic context is reliable, return empty topic_window/topic_hints and confidence below 0.5.',
  ].join('\n')
}

export function buildLumiMemoryTopicAnalyzerUserPayload(input: LumiContextualMemoryQueryInput): string {
  return JSON.stringify({
    recent_messages: (input.recentMessages ?? [])
      .filter(message => message.content.trim())
      .slice(-(input.maxMessages ?? 8)),
    current_user_message: input.currentMessage,
  }, null, 2)
}

export function parseLumiMemoryTopicAnalysis(raw: string): LumiMemoryTopicAnalysis | null {
  const payload = parseJsonLike(raw)
  if (!payload || typeof payload !== 'object')
    return null

  const record = payload as Record<string, unknown>
  const hints = Array.isArray(record.topic_hints ?? record.topicHints)
    ? (record.topic_hints ?? record.topicHints) as unknown[]
    : []
  const confidence = score(record.confidence, 0)
  return {
    topicWindow: String(record.topic_window ?? record.topicWindow ?? '').trim().slice(0, 900),
    topicHints: hints.map(hint => String(hint).trim()).filter(Boolean).slice(0, 8),
    storagePrefix: String(record.storage_prefix ?? record.storagePrefix ?? '').trim().slice(0, 120) || undefined,
    confidence,
  }
}

function extractTopicHints(currentMessage: string, recent: LumiMemoryContextMessage[]): string[] {
  const haystack = [currentMessage, ...recent.map(message => message.content)].join('\n')
  const hints = new Set<string>()
  for (const [pattern, label] of TOPIC_HINTS) {
    if (pattern.test(haystack))
      hints.add(label)
  }

  return [...hints]
}

function buildTopicWindow(recent: LumiMemoryContextMessage[], topicHints: string[]): string {
  const lines = recent
    .map(message => `${message.role}: ${message.content.replace(/\s+/g, ' ').trim().slice(0, 180)}`)
    .filter(Boolean)

  if (!lines.length && !topicHints.length)
    return ''

  return [
    topicHints.length ? `topics=${topicHints.join(', ')}` : '',
    ...lines,
  ].filter(Boolean).join(' | ').slice(0, 900)
}

function parseJsonLike(raw: string): unknown {
  const stripped = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  try {
    return JSON.parse(stripped)
  }
  catch {}

  const match = stripped.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
  if (!match)
    return null

  try {
    return JSON.parse(match[1])
  }
  catch {
    return null
  }
}

function score(value: unknown, fallback: number): number {
  const number = Number(value)
  if (!Number.isFinite(number))
    return fallback
  return Math.max(0, Math.min(1, number))
}
