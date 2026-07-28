import type { ChatAssistantMessage } from '../../../../types/chat'

import { describe, expect, it } from 'vitest'

import { stripInternalLumiOutput } from '../../../../libs/chat-sync'
import { parseAssistantDiagnostic } from './assistant-diagnostic'

/**
 * @example
 * describe('parseAssistantDiagnostic', () => {
 *   it('parses notices before visible-text sanitization', () => {})
 * })
 */
describe('parseAssistantDiagnostic', () => {
  /**
   * @example
   * it('parses notices before visible-text sanitization', () => {
   *   expect(parseAssistantDiagnostic(message)?.title).toBe('系统提示')
   * })
   */
  it('parses runtime notices before visible-text sanitization removes them', () => {
    const text = '[system_notice]\nstatus: running\nactivity: browser_navigate'
    const message: ChatAssistantMessage = {
      role: 'assistant',
      content: text,
      slices: [{ type: 'text', text }],
      tool_results: [],
    }

    expect(stripInternalLumiOutput(text)).toBe('')
    expect(parseAssistantDiagnostic(message)).toEqual({
      title: '系统提示',
      summary: '状态 running · 活动 browser_navigate',
      body: 'status: running\nactivity: browser_navigate',
    })
  })

  it('does not classify an ordinary assistant reply as a diagnostic', () => {
    const message: ChatAssistantMessage = {
      role: 'assistant',
      content: '我先打开网页看看',
      slices: [{ type: 'text', text: '我先打开网页看看' }],
      tool_results: [],
    }

    expect(parseAssistantDiagnostic(message)).toBeNull()
  })
})
