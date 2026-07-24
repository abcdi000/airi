import type { Rectangle } from 'electron'

import { errorMessageFrom } from '@moeru/std'

export interface BoundsWindow {
  getBounds: () => Rectangle
  isDestroyed: () => boolean
  setBounds: (bounds: Rectangle, animate?: boolean) => void
}

/**
 * Animates an Electron window while treating destruction as a normal lifecycle end.
 *
 * Use when:
 * - A renderer requests a smooth bounds transition
 * - A reusable window may close while a transition is still running
 *
 * Expects:
 * - `stop()` is called when the owner window closes
 * - Non-destruction errors from Electron remain actionable
 *
 * Returns:
 * - A promise that settles when the animation completes, is stopped, or loses its window
 */
export class WindowBoundsAnimator {
  private completion: (() => void) | undefined
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly window: BoundsWindow) {}

  stop() {
    if (this.timer)
      clearInterval(this.timer)

    this.timer = undefined
    this.completion?.()
    this.completion = undefined
  }

  animate(target: Rectangle, durationMs = 150) {
    this.stop()

    if (this.window.isDestroyed())
      return Promise.resolve()

    const from = this.window.getBounds()
    const duration = Math.max(0, Math.min(260, Math.round(durationMs)))
    if (duration <= 0) {
      this.applyBounds(target)
      return Promise.resolve()
    }

    const startedAt = Date.now()
    let lastSerialized = ''

    return new Promise<void>((resolve, reject) => {
      this.completion = resolve
      this.timer = setInterval(() => {
        if (this.window.isDestroyed()) {
          this.stop()
          return
        }

        try {
          const progress = Math.min(1, (Date.now() - startedAt) / duration)
          const eased = 1 - (1 - progress) ** 3
          const next = {
            x: Math.round(from.x + (target.x - from.x) * eased),
            y: Math.round(from.y + (target.y - from.y) * eased),
            width: Math.round(from.width + (target.width - from.width) * eased),
            height: Math.round(from.height + (target.height - from.height) * eased),
          }
          const serialized = `${next.x},${next.y},${next.width},${next.height}`
          if (serialized !== lastSerialized) {
            if (!this.applyBounds(next)) {
              this.stop()
              return
            }
            lastSerialized = serialized
          }

          if (progress >= 1) {
            if (!this.applyBounds(target)) {
              this.stop()
              return
            }
            this.stop()
          }
        }
        catch (error) {
          this.reject(error, reject)
        }
      }, 16)
    })
  }

  private applyBounds(bounds: Rectangle): boolean {
    if (this.window.isDestroyed())
      return false

    try {
      this.window.setBounds(bounds, false)
      return true
    }
    catch (error) {
      // Electron may destroy the native window between `isDestroyed()` and
      // `setBounds()`. Only this explicit lifecycle race is safe to ignore.
      if (this.window.isDestroyed() || (errorMessageFrom(error) ?? '').includes('Object has been destroyed'))
        return false

      throw error
    }
  }

  private reject(error: unknown, reject: (reason?: unknown) => void) {
    if (this.timer)
      clearInterval(this.timer)

    this.timer = undefined
    this.completion = undefined
    reject(error)
  }
}
