import type { DialogueAssistantMessage, DialogueUserMessage, LanguageModelPort } from '../index'

import { describe, expect, it, vi } from 'vitest'

import { compactContext, selectPlannerHistory } from './compactor'

function user(index: number, text = `用户消息 ${index}`): DialogueUserMessage {
  return {
    id: `user:${index}`,
    kind: 'dialogue_user',
    messageId: `message-user-${index}`,
    personId: 'doggy',
    text,
    segments: [{ type: 'text', text }],
    attachments: [],
    timestamp: index + 1,
    countInContext: true,
    remainingUses: null,
    source: 'test',
    visibility: 'both',
    provenance: {
      origin: 'test',
      sourceIds: [`message-user-${index}`],
    },
  }
}

function assistant(index: number, text = `Lumi消息 ${index}`): DialogueAssistantMessage {
  return {
    id: `assistant:${index}`,
    kind: 'dialogue_assistant',
    messageIds: [`message-assistant-${index}`],
    textSegments: [text],
    appliedExpressionIds: [],
    timestamp: index + 1,
    countInContext: true,
    remainingUses: null,
    source: 'test',
    visibility: 'both',
    provenance: {
      origin: 'test',
      sourceIds: [`message-assistant-${index}`],
    },
  }
}

function groundedSummaryModel(): LanguageModelPort {
  return {
    generate: vi.fn(async (messages) => {
      const payload = JSON.parse(messages[1]?.content ?? '{}') as {
        coverageToken?: string
      }
      return JSON.stringify({
        summary: 'Doggy和Lumi持续讨论同一件事，并保留了尚未完成的约定。',
        coverageToken: payload.coverageToken,
      })
    }),
  }
}

describe('context compactor', () => {
  it('compacts a roughly 100k-token dialogue into one grounded immutable checkpoint', async () => {
    const largeText = '上下文内容'.repeat(180)
    const history = Array.from({ length: 500 }, (_, index) =>
      index % 2 === 0 ? user(index, largeText) : assistant(index, largeText))
    const result = await compactContext({
      history,
      config: {
        plannerHistoryBudgetTokens: 100_000,
        compactionThresholdTokens: 80_000,
        recentHistoryTokens: 10_000,
      },
      model: groundedSummaryModel(),
      stableSystemPrompt: 'stable Lumi system',
      contextEpoch: 0,
      summaryVersion: 0,
    })

    expect(result.compacted).toBe(true)
    expect(result.contextEpoch).toBe(1)
    expect(result.summaryVersion).toBe(1)
    expect(result.summarizedSourceIds.length).toBeGreaterThan(0)
    expect(result.summarizedSourceIds.length).toBeLessThan(history.length)
    expect(result.history[0]).toMatchObject({
      kind: 'reference',
      referenceType: 'continuity_summary',
    })
    expect(result.history.length).toBeLessThan(history.length)
    expect(result.stablePrefixHash).toMatch(/^fnv1a32:/)
  })

  it('keeps the checkpoint hash stable during ordinary append-only dialogue', async () => {
    const initial = await compactContext({
      history: [
        user(1, 'A'.repeat(4_000)),
        assistant(2, 'B'.repeat(4_000)),
        user(3, '最新消息'),
      ],
      config: {
        plannerHistoryBudgetTokens: 10_000,
        compactionThresholdTokens: 1_000,
        recentHistoryTokens: 100,
      },
      model: groundedSummaryModel(),
      stableSystemPrompt: 'stable Lumi system',
      contextEpoch: 0,
      summaryVersion: 0,
    })
    const appended = await compactContext({
      history: [...initial.history, assistant(4, '普通追加')],
      config: {
        plannerHistoryBudgetTokens: 10_000,
        compactionThresholdTokens: 1_000_000,
        recentHistoryTokens: 100,
      },
      model: groundedSummaryModel(),
      stableSystemPrompt: 'stable Lumi system',
      contextEpoch: initial.contextEpoch,
      summaryVersion: initial.summaryVersion,
    })

    expect(initial.compacted).toBe(true)
    expect(appended.compacted).toBe(false)
    expect(appended.contextEpoch).toBe(initial.contextEpoch)
    expect(appended.summaryVersion).toBe(initial.summaryVersion)
    expect(appended.stablePrefixHash).toBe(initial.stablePrefixHash)
  })

  it('falls back to safe atomic selection when summary provenance is invalid', async () => {
    const model: LanguageModelPort = {
      generate: vi.fn(async () => JSON.stringify({
        summary: '没有可靠来源的摘要',
        coverageToken: 'invented-batch',
      })),
    }
    const history = [
      user(1, 'A'.repeat(4_000)),
      assistant(2, 'B'.repeat(4_000)),
      user(3, 'C'.repeat(4_000)),
    ]
    const result = await compactContext({
      history,
      config: {
        plannerHistoryBudgetTokens: 1_000,
        compactionThresholdTokens: 1_000,
        recentHistoryTokens: 200,
      },
      model,
      stableSystemPrompt: 'stable Lumi system',
      contextEpoch: 2,
      summaryVersion: 2,
    })

    expect(result.compacted).toBe(false)
    expect(result.contextEpoch).toBe(2)
    expect(result.warning).toContain('来源批次')
    expect(result.history).toEqual(selectPlannerHistory(history, {
      plannerHistoryBudgetTokens: 1_000,
      compactionThresholdTokens: 1_000,
      recentHistoryTokens: 200,
    }))
  })

  it('caps Planner history by message count when token estimates are too optimistic', () => {
    const history = Array.from({ length: 20 }, (_, index) => user(index, `消息 ${index}`))

    const selected = selectPlannerHistory(history, {
      plannerHistoryBudgetTokens: 100_000,
      plannerHistoryMaxMessages: 6,
      compactionThresholdTokens: 200_000,
      recentHistoryTokens: 100_000,
    })

    expect(selected).toHaveLength(6)
    expect(selected.map(message => message.id)).toEqual(
      history.slice(-6).map(message => message.id),
    )
  })

  it('summarizes a bounded oldest prefix instead of submitting the entire oversized history', async () => {
    const generate = vi.fn(async (messages) => {
      const payload = JSON.parse(messages[1]?.content ?? '{}') as {
        records?: Array<{ text: string }>
        coverageToken?: string
      }
      expect(messages[1]?.content.length).toBeLessThan(900_000)
      expect(payload.records?.length).toBeGreaterThan(0)
      return JSON.stringify({
        summary: 'A bounded checkpoint.',
        coverageToken: payload.coverageToken,
      })
    })
    const largeChineseText = '中文上下文'.repeat(10_000)
    const history = Array.from({ length: 30 }, (_, index) =>
      index % 2 === 0
        ? user(index, largeChineseText)
        : assistant(index, largeChineseText))

    const result = await compactContext({
      history,
      config: {
        plannerHistoryBudgetTokens: 700_000,
        compactionThresholdTokens: 100_000,
        recentHistoryTokens: 20_000,
      },
      model: { generate },
      stableSystemPrompt: 'stable Lumi system',
      contextEpoch: 0,
      summaryVersion: 0,
    })

    expect(result.warning).toBeUndefined()
    expect(result.compacted).toBe(true)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.history.length).toBeGreaterThan(2)
    expect(result.summarizedSourceIds.length).toBeLessThan(history.length)
    expect(generate).toHaveBeenCalledWith(
      expect.any(Array),
      'context_summary',
      undefined,
      { maxOutputTokens: 2_048 },
    )
  })
})
