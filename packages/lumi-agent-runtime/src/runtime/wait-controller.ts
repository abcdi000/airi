import type { PersistedWaitState } from '../ports/persistence'

/** Result returned to the Planner after a wait tool resumes. */
export interface WaitResult<TMessage = unknown> {
  reason: 'timeout' | 'message'
  waitedMs: number
  message?: TMessage
}

interface ActiveWait<TMessage> {
  state: PersistedWaitState
  startedAt: number
  resolve: (result: WaitResult<TMessage>) => void
  reject: (error: unknown) => void
  timeout: ReturnType<typeof setTimeout>
  removeAbort?: () => void
}

/**
 * Owns the single resumable wait state of one direct conversation.
 */
export class WaitController<TMessage = unknown> {
  readonly #onStateChanged?: (state: PersistedWaitState | undefined) => Promise<void> | void
  #active?: ActiveWait<TMessage>

  constructor(options: {
    onStateChanged?: (state: PersistedWaitState | undefined) => Promise<void> | void
  } = {}) {
    this.#onStateChanged = options.onStateChanged
  }

  get state(): PersistedWaitState | undefined {
    return this.#active?.state
  }

  get waiting(): boolean {
    return this.#active !== undefined
  }

  async wait(input: {
    toolCallId: string
    targetSeconds: number
    continuation?: PersistedWaitState['continuation']
    signal?: AbortSignal
  }): Promise<WaitResult<TMessage>> {
    if (this.#active)
      throw new Error('A direct session cannot start a second wait while one is active')
    const targetSeconds = Math.max(0, Math.min(3_600, input.targetSeconds))
    const startedAt = Date.now()
    const state: PersistedWaitState = {
      toolCallId: input.toolCallId,
      startedAt,
      targetSeconds,
      deadlineAt: startedAt + targetSeconds * 1_000,
      continuation: input.continuation,
    }
    return await this.#activate(state, targetSeconds * 1_000, input.signal)
  }

  /**
   * Re-arms one persisted wait without resetting its original deadline.
   */
  async restore(
    state: PersistedWaitState,
    signal?: AbortSignal,
  ): Promise<WaitResult<TMessage>> {
    if (this.#active)
      throw new Error('A direct session cannot restore a second wait while one is active')
    const remainingMs = Math.max(0, state.deadlineAt - Date.now())
    return await this.#activate(state, remainingMs, signal)
  }

  #activate(
    state: PersistedWaitState,
    remainingMs: number,
    signal?: AbortSignal,
  ): Promise<WaitResult<TMessage>> {
    const startedAt = state.startedAt
    return new Promise<WaitResult<TMessage>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const active = this.#active
        if (!active)
          return
        this.#clearActive()
        resolve({
          reason: 'timeout',
          waitedMs: Date.now() - startedAt,
        })
      }, remainingMs)
      const abort = () => {
        this.#clearActive()
        reject(signal?.reason ?? new Error('Wait aborted'))
      }
      if (signal?.aborted) {
        clearTimeout(timeout)
        reject(signal.reason ?? new Error('Wait aborted'))
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.#active = {
        state,
        startedAt,
        resolve,
        reject,
        timeout,
        removeAbort: () => signal?.removeEventListener('abort', abort),
      }
      void this.#onStateChanged?.(state)
    })
  }

  /** Wakes the active wait and returns whether a wait consumed the message. */
  wakeByMessage(message: TMessage): boolean {
    const active = this.#active
    if (!active)
      return false
    this.#clearActive()
    active.resolve({
      reason: 'message',
      waitedMs: Date.now() - active.startedAt,
      message,
    })
    return true
  }

  abort(reason: unknown = new Error('Wait aborted')): void {
    const active = this.#active
    if (!active)
      return
    this.#clearActive()
    active.reject(reason)
  }

  #clearActive(): void {
    const active = this.#active
    if (!active)
      return
    clearTimeout(active.timeout)
    active.removeAbort?.()
    this.#active = undefined
    void this.#onStateChanged?.(undefined)
  }
}
