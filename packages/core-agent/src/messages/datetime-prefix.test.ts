import { describe, expect, it } from 'vitest'

import { formatTimePrefix } from './datetime-prefix'

/**
 * @example
 * formatTimePrefix(new Date(2026, 3, 25, 18, 47, 12).getTime())
 */
describe('formatTimePrefix', () => {
  /**
   * @example
   * Timestamp prefixes follow Lumi's `[本地时间 YYYY-MM-DD HH:MM:SS]\n` shape.
   */
  it('wraps `[本地时间 YYYY-MM-DD HH:MM:SS]` with trailing newline', () => {
    const ts = new Date(2026, 3, 25, 18, 47, 12).getTime()
    expect(formatTimePrefix(ts)).toBe('[本地时间 2026-04-25 18:47:12]\n')
  })

  /**
   * @example
   * Single-digit date parts are zero-padded.
   */
  it('zero-pads month, day, hour, minute, and second', () => {
    const ts = new Date(2026, 0, 5, 3, 7, 9).getTime()
    expect(formatTimePrefix(ts)).toBe('[本地时间 2026-01-05 03:07:09]\n')
  })

  /**
   * @example
   * Second-level timestamps match Lumi's original ChatSession.add_user_message behavior.
   */
  it('keeps second-level precision', () => {
    const a = new Date(2026, 3, 25, 18, 47, 12).getTime()
    const b = new Date(2026, 3, 25, 18, 47, 58).getTime()
    expect(formatTimePrefix(a)).not.toBe(formatTimePrefix(b))
  })
})
