import type { Rectangle } from 'electron'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { WindowBoundsAnimator } from './window-bounds-animator'

interface FakeBoundsWindow {
  destroyed: boolean
  getBounds: () => Rectangle
  isDestroyed: () => boolean
  setBounds: ReturnType<typeof vi.fn<(bounds: Rectangle, animate?: boolean) => void>>
}

function createWindow(): FakeBoundsWindow {
  const window: FakeBoundsWindow = {
    destroyed: false,
    getBounds: () => ({ x: 0, y: 0, width: 320, height: 240 }),
    isDestroyed: () => window.destroyed,
    setBounds: vi.fn<(bounds: Rectangle, animate?: boolean) => void>(),
  }
  return window
}

/**
 * @example
 * describe('WindowBoundsAnimator', () => {})
 */
describe('window bounds animator', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * @example
   * it('stops without touching a window destroyed during animation', async () => {})
   */
  it('stops without touching a window destroyed during animation', async () => {
    vi.useFakeTimers()
    const window = createWindow()
    const animator = new WindowBoundsAnimator(window)
    const completion = animator.animate({ x: 10, y: 20, width: 640, height: 480 }, 150)

    window.destroyed = true
    await vi.advanceTimersByTimeAsync(16)
    await completion

    // ROOT CAUSE:
    //
    // The previous interval kept calling BrowserWindow.setBounds after a
    // settings/main window had closed, producing an uncaught main-process
    // "Object has been destroyed" error on the next animation frame.
    //
    // The animator now observes destruction and settles without another write.
    expect(window.setBounds).not.toHaveBeenCalled()
  })

  /**
   * @example
   * it('settles when Electron reports a native destruction race', async () => {})
   */
  it('settles when Electron reports a native destruction race', async () => {
    vi.useFakeTimers()
    const window = createWindow()
    window.setBounds.mockImplementation(() => {
      throw new TypeError('Object has been destroyed')
    })
    const animator = new WindowBoundsAnimator(window)
    const completion = animator.animate({ x: 10, y: 20, width: 640, height: 480 }, 150)

    await vi.advanceTimersByTimeAsync(16)

    await expect(completion).resolves.toBeUndefined()
    expect(window.setBounds).toHaveBeenCalledTimes(1)
  })
})
