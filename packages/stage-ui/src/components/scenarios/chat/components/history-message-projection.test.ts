import type { ChatHistoryItem } from '../../../../types/chat'

import { describe, expect, it } from 'vitest'

import { projectHistoryMessage } from './history-message-projection'

/**
 * @example
 * describe('projectHistoryMessage', () => {
 *   it('makes persisted runtime diagnostics visible', () => {})
 * })
 */
describe('projectHistoryMessage', () => {
  /**
   * @example
   * it('makes persisted runtime diagnostics visible', () => {
   *   expect(projectHistoryMessage(message).role).toBe('assistant')
   * })
   */
  it('makes persisted runtime diagnostics visible without changing their position metadata', () => {
    const message: ChatHistoryItem = {
      id: 'notice-1',
      role: 'system',
      content: '[system_notice]\nstatus: running\nactivity: browser_navigate',
      createdAt: 42,
    }

    expect(projectHistoryMessage(message)).toEqual({
      id: 'notice-1',
      role: 'assistant',
      content: '[system_notice]\nstatus: running\nactivity: browser_navigate',
      slices: [{ type: 'text', text: '[system_notice]\nstatus: running\nactivity: browser_navigate' }],
      tool_results: [],
      createdAt: 42,
    })
  })

  it('keeps ordinary system entries out of the assistant renderer', () => {
    const message: ChatHistoryItem = {
      role: 'system',
      content: 'internal context only',
    }

    expect(projectHistoryMessage(message)).toBe(message)
  })
})
