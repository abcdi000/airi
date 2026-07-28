import { describe, expect, it } from 'vitest'

import { projectReplyStream } from './reply-stream-projection'

/**
 * @example
 * describe('projectReplyStream', () => {
 *   it('only exposes visible message text from an incomplete Replyer document', () => {})
 * })
 */
describe('projectReplyStream', () => {
  /**
   * @example
   * it('only exposes visible message text from an incomplete Replyer document', () => {
   *   expect(projectReplyStream('{"messages":[{"text":"我先看看')).toBe('我先看看')
   * })
   */
  it('only exposes visible message text from an incomplete Replyer document', () => {
    expect(projectReplyStream('{"messages":[{"text":"我先看看')).toBe('我先看看')
    expect(projectReplyStream('{"messages":[{"text":"第一条"},{"text":"第二条"}],"appliedExpressionIds":["secret"]}'))
      .toBe('第一条\n\n第二条')
  })

  it('waits for incomplete JSON escapes instead of leaking protocol text', () => {
    expect(projectReplyStream('{"messages":[{"text":"第一行\\')).toBe('第一行')
    expect(projectReplyStream('{"messages":[{"text":"第一行\\n第二行"}]}')).toBe('第一行\n第二行')
  })

  it('keeps legacy plain-text Replyer output visible', () => {
    expect(projectReplyStream('  我先打开网页看看')).toBe('我先打开网页看看')
  })
})
