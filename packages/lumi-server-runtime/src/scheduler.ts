/**
 * Serializes turns within each conversation while allowing bounded cross-conversation work.
 *
 * Use when:
 * - Doggy and Moussy may send concurrently in different conversations
 * - A single group timeline must preserve model-turn order
 *
 * Expects:
 * - `laneId` is the canonical server conversation id
 * - Jobs settle without recursively awaiting another job in the same lane
 *
 * Returns:
 * - The result of each scheduled job in FIFO order for its lane
 */
export class LumiConversationScheduler {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly waiters: Array<() => void> = []
  private activeCount = 0

  constructor(private readonly maxConcurrentConversations = 2) {
    if (!Number.isInteger(maxConcurrentConversations) || maxConcurrentConversations < 1)
      throw new Error('maxConcurrentConversations must be a positive integer')
  }

  run<TResult>(laneId: string, job: () => Promise<TResult>): Promise<TResult> {
    const normalizedLaneId = laneId.trim()
    if (!normalizedLaneId)
      return Promise.reject(new Error('laneId is required'))

    const previous = this.tails.get(normalizedLaneId) ?? Promise.resolve()
    const result = previous.catch(() => {}).then(async () => {
      await this.acquire()
      try {
        return await job()
      }
      finally {
        this.release()
      }
    })
    const tail = result.then(() => {}, () => {})
    this.tails.set(normalizedLaneId, tail)
    void tail.finally(() => {
      if (this.tails.get(normalizedLaneId) === tail)
        this.tails.delete(normalizedLaneId)
    })
    return result
  }

  get pendingLaneCount() {
    return this.tails.size
  }

  /** Waits until every lane scheduled before and during this call has settled. */
  async drain(): Promise<void> {
    while (this.tails.size > 0)
      await Promise.all([...this.tails.values()])
  }

  private async acquire() {
    if (this.activeCount < this.maxConcurrentConversations) {
      this.activeCount += 1
      return
    }
    await new Promise<void>(resolve => this.waiters.push(resolve))
    this.activeCount += 1
  }

  private release() {
    this.activeCount -= 1
    this.waiters.shift()?.()
  }
}
