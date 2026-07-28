import type { AgentTracePort } from '../observability/trace'
import type { LanguageModelPort } from '../ports/model'
import type { LumiPromptTemplate } from '../prompts/templates'
import type { LumiAgentContextMessage, ReferenceMessage } from './messages'

import { errorMessageFrom } from '@moeru/std'

import {
  createLumiPromptTemplate,
  lumiPromptTemplateMetadata,
  redactPromptMessages,
} from '../prompts/templates'
import {
  buildAtomicContextSegments,
  selectContextWithinBudget,
} from './history'

/** Token and checkpoint policy for one direct session. */
export interface ContextCompactionConfig {
  /** Maximum typed history selected for a Planner request. */
  plannerHistoryBudgetTokens: number
  /** Maximum context-bearing messages selected even when token estimates are low. */
  plannerHistoryMaxMessages?: number
  /** Starts asynchronous checkpoint generation above this estimate. */
  compactionThresholdTokens: number
  /** Newest atomic history retained verbatim after a checkpoint. */
  recentHistoryTokens: number
  /** Message-count threshold used alongside approximate token counting. */
  compactionThresholdMessages?: number
  /** Newest context-bearing messages retained verbatim after compaction. */
  recentHistoryMessages?: number
}

/** Result of one attempted immutable checkpoint transition. */
export interface ContextCompactionResult {
  history: readonly LumiAgentContextMessage[]
  compacted: boolean
  contextEpoch: number
  summaryVersion: number
  stablePrefixHash: string
  dialogueSegmentId: string
  summarizedSourceIds: readonly string[]
  warning?: string
}

/**
 * Selects a bounded Planner window without splitting tool call/result pairs.
 */
export function selectPlannerHistory(
  history: readonly LumiAgentContextMessage[],
  config: ContextCompactionConfig,
): readonly LumiAgentContextMessage[] {
  const selected = selectContextWithinBudget(history, config.plannerHistoryBudgetTokens)
  const bounded = newestSegmentsByMessageCount(
    buildAtomicContextSegments(selected),
    config.plannerHistoryMaxMessages ?? 120,
  ).flatMap(segment => segment.messages)
  const continuitySummary = history.findLast(message =>
    message.kind === 'reference' && message.referenceType === 'continuity_summary')
  if (!continuitySummary || bounded.some(message => message.id === continuitySummary.id))
    return bounded
  return [continuitySummary, ...bounded]
}

/**
 * Freezes an old append-only segment into a grounded continuity checkpoint.
 *
 * Use when:
 * - Estimated history crossed the configured compaction threshold
 *
 * Expects:
 * - The caller applies the result only if its conversation generation is still current
 *
 * Returns:
 * - A new immutable epoch, or a safe selected window when summarization fails
 */
export async function compactContext(input: {
  history: readonly LumiAgentContextMessage[]
  config: ContextCompactionConfig
  model: LanguageModelPort
  stableSystemPrompt: string
  summaryPrompt?: LumiPromptTemplate
  promptLoggingEnabled?: boolean
  trace?: AgentTracePort
  traceTurnId?: string
  contextEpoch: number
  summaryVersion: number
  signal?: AbortSignal
}): Promise<ContextCompactionResult> {
  const segments = buildAtomicContextSegments(input.history)
  const totalTokens = segments.reduce((sum, segment) => sum + segment.estimatedTokens, 0)
  const contextMessageCount = input.history.filter(message => message.countInContext).length
  if (
    totalTokens < input.config.compactionThresholdTokens
    && contextMessageCount < (input.config.compactionThresholdMessages ?? 160)
  ) {
    return unchanged(input, input.history)
  }

  const retainedByTokens = newestSegmentsWithin(segments, input.config.recentHistoryTokens)
  const retainedIdsByMessageCount = new Set(
    newestSegmentsByMessageCount(
      segments,
      input.config.recentHistoryMessages ?? 96,
    ).map(segment => segment.id),
  )
  const retained = retainedByTokens.filter(segment => retainedIdsByMessageCount.has(segment.id))
  const retainedIds = new Set(retained.map(segment => segment.id))
  const frozen = segments.filter(segment => !retainedIds.has(segment.id))
  // Background compaction must remain small enough to finish without competing
  // with the next visible reply. Large backlogs are drained in multiple idle
  // batches instead of one long model request.
  const summarySourceBudgetTokens = Math.min(
    Math.max(input.config.plannerHistoryBudgetTokens, 8_000),
    128_000,
  )
  const selectedFrozen = oldestSegmentsWithin(frozen, summarySourceBudgetTokens)
  const selectedFrozenIds = new Set(selectedFrozen.map(segment => segment.id))
  const frozenMessages = selectedFrozen.flatMap(segment => segment.messages)
  const summaryMaterial = frozenMessages.flatMap(toSummaryMaterial)
  const sourceIds = [...new Set(summaryMaterial.flatMap(item => item.sourceIds))]
  const coverageToken = stableHash(sourceIds.join('\0'))
  if (summaryMaterial.length === 0 || sourceIds.length === 0) {
    return unchanged(
      input,
      selectPlannerHistory(input.history, input.config),
      '没有可用于生成连续性摘要的对话内容。',
    )
  }

  try {
    const summaryPrompt = input.summaryPrompt ?? createLumiPromptTemplate(
      'context_summary',
      [
        '只根据提供的私聊记录生成事实连续性摘要。',
        '不得虚构事件、意图、关系、承诺或私密事实。',
        '保留未完成事项、约定、情绪变化和后续仍需知道的背景。',
        '按指定 JSON 格式返回。',
      ].join('\n'),
    )
    const messages = [
      {
        role: 'system' as const,
        content: [
          summaryPrompt.content,
          '摘要不超过 1200 个汉字。',
          '只返回 JSON：{"summary":"...","coverageToken":"..."}。',
          '原样复制给定的 coverageToken，不要输出来源标识列表。',
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: JSON.stringify({
          records: summaryMaterial,
          coverageToken,
        }),
      },
    ]
    const startedAt = Date.now()
    let raw: string
    try {
      raw = await input.model.generate(
        messages,
        'context_summary',
        input.signal,
        { maxOutputTokens: 2_048 },
      )
    }
    catch (error) {
      await input.trace?.record({
        type: 'model_request',
        turnId: input.traceTurnId ?? `context-summary:${input.contextEpoch + 1}`,
        purpose: 'context_summary',
        status: 'error',
        durationMs: Date.now() - startedAt,
        prompt: lumiPromptTemplateMetadata(summaryPrompt),
        messageCount: messages.length,
        toolCount: 0,
        messages: input.promptLoggingEnabled
          ? redactPromptMessages(messages)
          : undefined,
        errorMessage: (errorMessageFrom(error) ?? 'Context summary request failed').slice(0, 2_000),
        timestamp: Date.now(),
      })
      throw error
    }
    await input.trace?.record({
      type: 'model_request',
      turnId: input.traceTurnId ?? `context-summary:${input.contextEpoch + 1}`,
      purpose: 'context_summary',
      status: 'completed',
      durationMs: Date.now() - startedAt,
      prompt: lumiPromptTemplateMetadata(summaryPrompt),
      messageCount: messages.length,
      toolCount: 0,
      messages: input.promptLoggingEnabled
        ? redactPromptMessages(messages)
        : undefined,
      timestamp: Date.now(),
    })
    const parsed = parseSummary(raw, coverageToken)
    if (!parsed)
      throw new Error('上下文摘要没有正确确认指定的来源批次')

    const nextEpoch = input.contextEpoch + 1
    const nextSummaryVersion = input.summaryVersion + 1
    const summary: ReferenceMessage = {
      id: `continuity:${nextEpoch}:${nextSummaryVersion}`,
      kind: 'reference',
      referenceType: 'continuity_summary',
      content: parsed.summary,
      authorizationReason: '由已授权私聊记录生成的连续性摘要',
      confidence: 1,
      timestamp: Date.now(),
      countInContext: true,
      remainingUses: null,
      source: 'context_compactor',
      visibility: 'both',
      provenance: {
        origin: 'context_summary',
        sourceIds,
        metadata: {
          contextEpoch: nextEpoch,
          summaryVersion: nextSummaryVersion,
        },
      },
    }
    const history = [
      summary,
      ...frozen
        .filter(segment => !selectedFrozenIds.has(segment.id))
        .flatMap(segment => segment.messages),
      ...retained.flatMap(segment => segment.messages),
    ]
    return {
      history,
      compacted: true,
      contextEpoch: nextEpoch,
      summaryVersion: nextSummaryVersion,
      stablePrefixHash: stablePrefixHash(input.stableSystemPrompt, summary),
      dialogueSegmentId: `dialogue:${nextEpoch}`,
      summarizedSourceIds: sourceIds,
    }
  }
  catch (error) {
    return unchanged(
      input,
      selectPlannerHistory(input.history, input.config),
      errorMessageFrom(error) ?? 'context compaction failed',
    )
  }
}

function unchanged(
  input: {
    contextEpoch: number
    summaryVersion: number
    stableSystemPrompt: string
  },
  history: readonly LumiAgentContextMessage[],
  warning?: string,
): ContextCompactionResult {
  const summary = history.find((message): message is ReferenceMessage =>
    message.kind === 'reference' && message.referenceType === 'continuity_summary')
  return {
    history,
    compacted: false,
    contextEpoch: input.contextEpoch,
    summaryVersion: input.summaryVersion,
    stablePrefixHash: summary ? stablePrefixHash(input.stableSystemPrompt, summary) : stableHash(input.stableSystemPrompt),
    dialogueSegmentId: `dialogue:${input.contextEpoch}`,
    summarizedSourceIds: [],
    warning,
  }
}

function newestSegmentsWithin(
  segments: ReturnType<typeof buildAtomicContextSegments>,
  budgetTokens: number,
) {
  const selected: typeof segments[number][] = []
  let used = 0
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (!segment)
      continue
    if (selected.length > 0 && used + segment.estimatedTokens > budgetTokens)
      break
    selected.push(segment)
    used += segment.estimatedTokens
  }
  return selected.reverse()
}

function oldestSegmentsWithin(
  segments: ReturnType<typeof buildAtomicContextSegments>,
  budgetTokens: number,
) {
  const selected: typeof segments[number][] = []
  let used = 0
  for (const segment of segments) {
    if (used + segment.estimatedTokens > budgetTokens)
      break
    selected.push(segment)
    used += segment.estimatedTokens
  }
  return selected
}

function newestSegmentsByMessageCount(
  segments: ReturnType<typeof buildAtomicContextSegments>,
  maximumMessages: number,
) {
  const selected: typeof segments[number][] = []
  let used = 0
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (!segment)
      continue
    if (selected.length > 0 && used + segment.messages.length > maximumMessages)
      break
    selected.push(segment)
    used += segment.messages.length
  }
  return selected.reverse()
}

function toSummaryMaterial(message: LumiAgentContextMessage): Array<{
  role: 'user' | 'assistant' | 'summary'
  text: string
  sourceIds: readonly string[]
  timestamp: number
}> {
  if (message.kind === 'dialogue_user') {
    return [{
      role: 'user',
      text: message.text,
      sourceIds: [message.messageId],
      timestamp: message.timestamp,
    }]
  }
  if (message.kind === 'dialogue_assistant') {
    return [{
      role: 'assistant',
      text: message.textSegments.join('\n\n'),
      sourceIds: message.messageIds,
      timestamp: message.timestamp,
    }]
  }
  if (message.kind === 'reference' && message.referenceType === 'continuity_summary') {
    return [{
      role: 'summary',
      text: message.content,
      sourceIds: message.provenance.sourceIds,
      timestamp: message.timestamp,
    }]
  }
  return []
}

function parseSummary(
  raw: string,
  requiredCoverageToken: string,
): { summary: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return undefined
    const record = parsed as Record<string, unknown>
    const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
    const coverageToken = typeof record.coverageToken === 'string'
      ? record.coverageToken.trim()
      : ''
    if (!summary || summary.length > 8_000 || coverageToken !== requiredCoverageToken)
      return undefined
    return { summary }
  }
  catch {
    return undefined
  }
}

function stablePrefixHash(systemPrompt: string, summary: ReferenceMessage): string {
  return stableHash(`${systemPrompt}\0${summary.content}\0${summary.provenance.sourceIds.join('\0')}`)
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}
