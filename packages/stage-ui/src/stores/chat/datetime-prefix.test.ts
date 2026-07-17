import { describe, expect, it } from 'vitest'

import { formatTimePrefix } from './datetime-prefix'

describe('formatTimePrefix', () => {
  it('wraps `[本地时间 YYYY-MM-DD HH:MM:SS]` with trailing newline', () => {
    const ts = new Date(2026, 3, 25, 18, 47, 12).getTime()
    expect(formatTimePrefix(ts)).toBe('[本地时间 2026-04-25 18:47:12]\n')
  })

  it('zero-pads month, day, hour, minute, second', () => {
    const ts = new Date(2026, 0, 5, 3, 7, 9).getTime() // 5 January 2026, 03:07:09 local
    expect(formatTimePrefix(ts)).toBe('[本地时间 2026-01-05 03:07:09]\n')
  })

  it('produces stable output for the same input (cache-friendly)', () => {
    const ts = new Date(2026, 3, 25, 18, 47, 0).getTime()
    expect(formatTimePrefix(ts)).toBe(formatTimePrefix(ts))
  })

  it('produces different output across day boundaries (lets the model see day changes)', () => {
    const day1 = new Date(2026, 3, 25, 12, 0, 0).getTime()
    const day2 = new Date(2026, 3, 26, 12, 0, 0).getTime()
    expect(formatTimePrefix(day1)).not.toBe(formatTimePrefix(day2))
    expect(formatTimePrefix(day1)).toContain('2026-04-25')
    expect(formatTimePrefix(day2)).toContain('2026-04-26')
  })

  it('keeps second-level precision like Lumi', () => {
    const a = new Date(2026, 3, 25, 18, 47, 12).getTime()
    const b = new Date(2026, 3, 25, 18, 47, 58).getTime()
    expect(formatTimePrefix(a)).not.toBe(formatTimePrefix(b))
  })
})
