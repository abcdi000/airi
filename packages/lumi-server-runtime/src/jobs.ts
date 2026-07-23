import type { LumiServerDatabase, LumiServerJob } from './database'

import { errorMessageFrom } from '@moeru/std'

export type LumiServerJobHandler = (job: LumiServerJob, signal: AbortSignal) => Promise<Record<string, unknown> | void>

export interface LumiServerJobWorkerOptions {
  database: LumiServerDatabase
  handlers: Record<string, LumiServerJobHandler>
  /** @default 2 */
  concurrency?: number
  /** @default 1000 */
  pollIntervalMs?: number
  /** @default 3 */
  maxAttempts?: number
}

/** Runs durable server jobs with bounded concurrency and restart recovery. */
export class LumiServerJobWorker {
  private readonly controller = new AbortController()
  private readonly running = new Set<Promise<void>>()
  private timer?: ReturnType<typeof setInterval>
  private stopping = false

  constructor(private readonly options: LumiServerJobWorkerOptions) {
    boundedInteger(options.concurrency ?? 2, 1, 16, 'concurrency')
    boundedInteger(options.pollIntervalMs ?? 1_000, 50, 60_000, 'pollIntervalMs')
    boundedInteger(options.maxAttempts ?? 3, 1, 20, 'maxAttempts')
  }

  start(): void {
    if (this.timer)
      return
    this.options.database.recoverInterruptedJobs()
    this.timer = setInterval(() => void this.pump(), this.options.pollIntervalMs ?? 1_000)
    void this.pump()
  }

  async stop(): Promise<void> {
    if (this.stopping)
      return await Promise.all([...this.running]).then(() => {})
    this.stopping = true
    if (this.timer)
      clearInterval(this.timer)
    this.timer = undefined
    this.controller.abort(new Error('Lumi Server job worker is shutting down'))
    await Promise.all([...this.running])
  }

  async runDueNow(): Promise<void> {
    await this.pump()
    await Promise.all([...this.running])
  }

  private async pump(): Promise<void> {
    if (this.stopping)
      return
    const concurrency = this.options.concurrency ?? 2
    while (this.running.size < concurrency) {
      const job = this.options.database.claimDueJob()
      if (!job)
        return
      const running = this.execute(job)
      this.running.add(running)
      void running.finally(() => this.running.delete(running))
    }
  }

  private async execute(job: LumiServerJob): Promise<void> {
    const handler = this.options.handlers[job.kind]
    if (!handler) {
      this.options.database.failJob(job.id, { error: `No handler registered for ${job.kind}` })
      return
    }
    try {
      const result = await handler(job, this.controller.signal)
      this.options.database.finishJob(job.id, result ?? {})
    }
    catch (error) {
      const maxAttempts = this.options.maxAttempts ?? 3
      const retryAt = job.attempts < maxAttempts
        ? Date.now() + Math.min(60_000, 1_000 * 2 ** (job.attempts - 1))
        : undefined
      this.options.database.failJob(job.id, {
        error: errorMessageFrom(error) ?? 'Background job failed',
      }, retryAt)
    }
    finally {
      if (!this.stopping)
        queueMicrotask(() => void this.pump())
    }
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${field} must be between ${minimum} and ${maximum}`)
}
