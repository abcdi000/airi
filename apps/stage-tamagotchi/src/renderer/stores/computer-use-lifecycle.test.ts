import { describe, expect, it } from 'vitest'

import { didComputerUseSendingEnd, didComputerUseSendingStart } from './computer-use-lifecycle'

describe('Computer Use chat lifecycle', () => {
  it('activates for both an already-sending mount and a normal false-to-true transition', () => {
    expect(didComputerUseSendingStart(true, undefined)).toBe(true)
    expect(didComputerUseSendingStart(true, false)).toBe(true)
    expect(didComputerUseSendingStart(true, true)).toBe(false)
    expect(didComputerUseSendingStart(false, undefined)).toBe(false)
  })

  it('deactivates only when an active send actually ends', () => {
    expect(didComputerUseSendingEnd(false, true)).toBe(true)
    expect(didComputerUseSendingEnd(false, undefined)).toBe(false)
    expect(didComputerUseSendingEnd(false, false)).toBe(false)
    expect(didComputerUseSendingEnd(true, true)).toBe(false)
  })
})
