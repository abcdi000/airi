export interface LumiConversationContextMessage {
  /** Stable persisted message identifier used as the summary coverage cursor. */
  id: string
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Optional stable speaker label for shared timelines. */
  name?: string
}

/** Persisted rolling summary for one privacy-isolated conversation. */
export interface LumiConversationSummary {
  version: 1
  conversationId: string
  summary: string
  throughMessageId: string
  sourceMessageCount: number
  estimatedSourceTokens: number
  updatedAt: number
}

/** Token and retention policy for Lumi's rolling conversation context. */
export interface LumiConversationContextPolicy {
  /** Provider/model context window. @default 1000000 */
  maxContextTokens: number
  /** Space kept for the visible answer and model reasoning. @default 64000 */
  outputReserveTokens: number
  /** Space kept for persona, memories, tools, and runtime context. @default 32000 */
  promptReserveTokens: number
  /** Compression starts before the hard boundary so a failed summary can retry safely. @default 0.82 */
  compressionTriggerRatio: number
  /** Target after compression, preventing a summary call on every turn. @default 0.68 */
  compressionTargetRatio: number
  /** Preferred number of recent verbatim messages. At least eight remain when the preferred window itself is oversized. @default 48 */
  preserveRecentMessages: number
  /** Maximum source size of one summarizer call. @default 120000 */
  summaryChunkTokens: number
}

export interface LumiConversationContextProjection {
  messages: LumiConversationContextMessage[]
  summary?: LumiConversationSummary
  compressed: boolean
  estimatedInputTokens: number
  summarizedMessageCount: number
}

export interface CompressLumiConversationContextInput {
  conversationId: string
  messages: LumiConversationContextMessage[]
  previousSummary?: LumiConversationSummary
  policy: LumiConversationContextPolicy
  generateSummary: (messages: LumiConversationContextMessage[]) => Promise<string>
  now?: number
}

/**
 * Estimates chat tokens without importing a provider-specific tokenizer.
 *
 * Before:
 * - Chinese UTF-8 text (roughly three bytes per character)
 * - English UTF-8 text (roughly four characters per token)
 *
 * After:
 * - A conservative upper estimate suitable for enforcing a hard context budget
 */
export function estimateLumiConversationTokens(messages: LumiConversationContextMessage[]) {
  return messages.reduce((total, message) => total + estimateTextTokens(message.content) + 8, 0)
}

/**
 * Builds a provider projection with a rolling model-authored summary.
 *
 * Use when:
 * - A conversation approaches its model context window
 * - Earlier turns must remain available without sending all verbatim history
 *
 * Expects:
 * - Messages are chronological and carry stable IDs
 * - The caller persists the returned summary within the same conversation scope
 *
 * Returns:
 * - A summary prefix plus untouched recent messages
 */
export async function compressLumiConversationContext(
  input: CompressLumiConversationContextInput,
): Promise<LumiConversationContextProjection> {
  const policy = normalizePolicy(input.policy)
  const state = validSummaryForMessages(input.previousSummary, input.messages)
  const uncovered = uncoveredMessages(input.messages, state)
  const availableTokens = policy.maxContextTokens - policy.outputReserveTokens - policy.promptReserveTokens
  const summaryTokens = state ? estimateTextTokens(state.summary) + 16 : 0
  const uncoveredTokens = estimateLumiConversationTokens(uncovered)
  const estimatedInputTokens = summaryTokens + uncoveredTokens
  const triggerTokens = Math.floor(availableTokens * policy.compressionTriggerRatio)

  if (estimatedInputTokens <= triggerTokens) {
    return {
      messages: projectMessages(state, uncovered),
      summary: state,
      compressed: false,
      estimatedInputTokens,
      summarizedMessageCount: 0,
    }
  }

  const preferredSummarizable = Math.max(0, uncovered.length - policy.preserveRecentMessages)
  const maximumSummarizable = Math.max(preferredSummarizable, uncovered.length - 8)
  if (maximumSummarizable === 0) {
    return {
      messages: projectMessages(state, uncovered),
      summary: state,
      compressed: false,
      estimatedInputTokens,
      summarizedMessageCount: 0,
    }
  }

  const targetTokens = Math.floor(availableTokens * policy.compressionTargetRatio)
  let splitIndex = 0
  let remainingTokens = uncoveredTokens
  while (splitIndex < maximumSummarizable && summaryTokens + remainingTokens > targetTokens) {
    remainingTokens -= estimateLumiConversationTokens([uncovered[splitIndex]!])
    splitIndex += 1
  }
  if (splitIndex === 0)
    splitIndex = Math.min(maximumSummarizable, 1)

  const source = uncovered.slice(0, splitIndex)
  const summary = await summarizeInChunks({
    conversationId: input.conversationId,
    source,
    previousSummary: state,
    chunkTokens: policy.summaryChunkTokens,
    generateSummary: input.generateSummary,
    now: input.now ?? Date.now(),
  })
  const recent = uncovered.slice(splitIndex)
  const projected = projectMessages(summary, recent)

  return {
    messages: projected,
    summary,
    compressed: true,
    estimatedInputTokens: estimateLumiConversationTokens(projected),
    summarizedMessageCount: source.length,
  }
}

/** Creates the summarizer prompt for one cumulative compression chunk. */
export function buildLumiConversationSummaryMessages(input: {
  previousSummary?: string
  source: LumiConversationContextMessage[]
}): LumiConversationContextMessage[] {
  return [
    {
      id: 'context-summary-system',
      role: 'system',
      content: [
        'You maintain Lumi\'s durable conversation continuity summary.',
        'Summarize only the supplied conversation evidence. Do not invent facts, motives, memories, or relationships.',
        'Preserve speaker attribution, chronology, unresolved questions, promises, corrections, emotional changes, decisions, and references needed to understand later turns.',
        'Keep private details scoped to this conversation. Do not turn uncertain claims into facts.',
        'Merge the previous summary with the new segment. Remove repetition while retaining concrete names, dates, quoted terms, and causal links.',
        'Output only the updated summary in concise structured Markdown. Do not address the user.',
      ].join('\n'),
    },
    {
      id: 'context-summary-source',
      role: 'user',
      content: JSON.stringify({
        previous_summary: input.previousSummary ?? '',
        new_segment: input.source.map(message => ({
          id: message.id,
          role: message.role,
          name: message.name,
          content: message.content,
        })),
      }),
    },
  ]
}

async function summarizeInChunks(input: {
  conversationId: string
  source: LumiConversationContextMessage[]
  previousSummary?: LumiConversationSummary
  chunkTokens: number
  generateSummary: (messages: LumiConversationContextMessage[]) => Promise<string>
  now: number
}) {
  let summaryText = input.previousSummary?.summary ?? ''
  let cursor = 0
  while (cursor < input.source.length) {
    let end = cursor
    let tokens = 0
    while (end < input.source.length) {
      const nextTokens = estimateLumiConversationTokens([input.source[end]!])
      if (end > cursor && tokens + nextTokens > input.chunkTokens)
        break
      tokens += nextTokens
      end += 1
    }
    const chunk = input.source.slice(cursor, end)
    const generated = (await input.generateSummary(buildLumiConversationSummaryMessages({
      previousSummary: summaryText,
      source: chunk,
    }))).trim()
    if (!generated)
      throw new Error('Lumi context summarizer returned an empty summary')
    summaryText = generated.slice(0, 120_000)
    cursor = end
  }

  const last = input.source.at(-1)!
  return {
    version: 1 as const,
    conversationId: input.conversationId,
    summary: summaryText,
    throughMessageId: last.id,
    sourceMessageCount: (input.previousSummary?.sourceMessageCount ?? 0) + input.source.length,
    estimatedSourceTokens: (input.previousSummary?.estimatedSourceTokens ?? 0)
      + estimateLumiConversationTokens(input.source),
    updatedAt: input.now,
  }
}

function projectMessages(
  summary: LumiConversationSummary | undefined,
  messages: LumiConversationContextMessage[],
) {
  if (!summary)
    return messages
  return [
    {
      id: `context-summary:${summary.throughMessageId}`,
      role: 'system' as const,
      content: [
        '[Lumi conversation continuity summary]',
        'This model-authored summary represents older turns in this same authorized conversation. Recent verbatim messages follow it.',
        summary.summary,
      ].join('\n'),
    },
    ...messages,
  ]
}

function uncoveredMessages(
  messages: LumiConversationContextMessage[],
  summary?: LumiConversationSummary,
) {
  if (!summary)
    return messages
  const cursor = messages.findIndex(message => message.id === summary.throughMessageId)
  return cursor >= 0 ? messages.slice(cursor + 1) : messages
}

function validSummaryForMessages(
  summary: LumiConversationSummary | undefined,
  messages: LumiConversationContextMessage[],
) {
  if (!summary)
    return undefined
  return messages.some(message => message.id === summary.throughMessageId)
    ? summary
    : undefined
}

function estimateTextTokens(text: string) {
  const bytes = new TextEncoder().encode(text).byteLength
  return Math.max(1, Math.ceil(bytes / 3))
}

function normalizePolicy(policy: LumiConversationContextPolicy): LumiConversationContextPolicy {
  const maxContextTokens = boundedInteger(policy.maxContextTokens, 32_000, 1_000_000)
  const outputReserveTokens = boundedInteger(policy.outputReserveTokens, 1_024, Math.floor(maxContextTokens * 0.4))
  const promptReserveTokens = boundedInteger(policy.promptReserveTokens, 1_024, Math.floor(maxContextTokens * 0.4))
  return {
    maxContextTokens,
    outputReserveTokens,
    promptReserveTokens,
    compressionTriggerRatio: boundedRatio(policy.compressionTriggerRatio, 0.5, 0.95),
    compressionTargetRatio: boundedRatio(
      policy.compressionTargetRatio,
      0.35,
      Math.min(0.9, policy.compressionTriggerRatio - 0.05),
    ),
    preserveRecentMessages: boundedInteger(policy.preserveRecentMessages, 8, 500),
    summaryChunkTokens: boundedInteger(policy.summaryChunkTokens, 4_000, Math.floor(maxContextTokens * 0.5)),
  }
}

function boundedInteger(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value))
    return minimum
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}

function boundedRatio(value: number, minimum: number, maximum: number) {
  if (!Number.isFinite(value))
    return minimum
  return Math.min(maximum, Math.max(minimum, value))
}
