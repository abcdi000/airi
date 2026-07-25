import type { LumiConversationContextMessage } from './conversation-context'

import { describe, expect, it, vi } from 'vitest'

import {
  compressLumiConversationContext,
  estimateLumiConversationTokens,
} from './conversation-context'

function messages(count: number, content = '一段需要保留的对话内容') {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `${content}-${index + 1}`,
  }))
}

const policy = {
  maxContextTokens: 32_000,
  outputReserveTokens: 2_000,
  promptReserveTokens: 2_000,
  compressionTriggerRatio: 0.5,
  compressionTargetRatio: 0.35,
  preserveRecentMessages: 8,
  summaryChunkTokens: 4_000,
}

/**
 * @example
 * Small conversations remain verbatim and never spend a summarizer call.
 */
describe('compressLumiConversationContext', () => {
  it('keeps history verbatim while it is below the compression trigger', async () => {
    const source = messages(6)
    const generateSummary = vi.fn()

    const result = await compressLumiConversationContext({
      conversationId: 'direct-doggy',
      messages: source,
      policy,
      generateSummary,
    })

    expect(result.messages).toEqual(source)
    expect(result.compressed).toBe(false)
    expect(generateSummary).not.toHaveBeenCalled()
  })

  /**
   * @example
   * Old messages become one model-authored prefix while recent turns stay raw.
   */
  it('summarizes old chunks and preserves recent messages verbatim', async () => {
    const source = messages(28, '很长的聊天'.repeat(300))
    const generateSummary = vi.fn(async () => '## 连续性\nDoggy 和 Lumi 仍在讨论同一个问题。')

    const result = await compressLumiConversationContext({
      conversationId: 'direct-doggy',
      messages: source,
      policy,
      generateSummary,
      now: 100,
    })

    expect(result.compressed).toBe(true)
    expect(result.summary?.conversationId).toBe('direct-doggy')
    expect(result.summary?.throughMessageId).toBe(`message-${result.summarizedMessageCount}`)
    expect(result.messages[0]?.role).toBe('system')
    expect(result.messages[0]?.content).toContain('Lumi conversation continuity summary')
    expect(result.messages.slice(-8)).toEqual(source.slice(-8))
    expect(generateSummary).toHaveBeenCalled()
  })

  /**
   * @example
   * A persisted coverage cursor prevents already summarized turns from being
   * sent verbatim or summarized again.
   */
  it('continues from a persisted summary cursor', async () => {
    const source = messages(14, '继续累积'.repeat(500))
    const previousSummary = {
      version: 1 as const,
      conversationId: 'direct-doggy',
      summary: '旧摘要',
      throughMessageId: 'message-4',
      sourceMessageCount: 4,
      estimatedSourceTokens: 100,
      updatedAt: 1,
    }
    let firstSummarizerMessages: LumiConversationContextMessage[] = []
    const generateSummary = vi.fn(async (messages: LumiConversationContextMessage[]) => {
      if (!firstSummarizerMessages.length)
        firstSummarizerMessages = messages
      return '合并后的摘要'
    })

    const result = await compressLumiConversationContext({
      conversationId: 'direct-doggy',
      messages: source,
      previousSummary,
      policy,
      generateSummary,
      now: 2,
    })

    expect(result.messages.some(message => message.id === 'message-1')).toBe(false)
    expect(result.summary?.sourceMessageCount).toBeGreaterThan(4)
    expect(firstSummarizerMessages[1]?.content).toContain('旧摘要')
  })

  /**
   * @example
   * Chinese text is conservatively estimated close to one token per character.
   */
  it('uses a conservative provider-independent token estimate', () => {
    expect(estimateLumiConversationTokens([{
      id: 'm1',
      role: 'user',
      content: '你好世界',
    }])).toBeGreaterThanOrEqual(12)
  })
})
