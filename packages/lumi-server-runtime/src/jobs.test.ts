import { describe, expect, it } from 'vitest'

import { LumiServerDatabase } from './database'
import { LumiServerJobWorker } from './jobs'

describe('lumiServerJobWorker', () => {
  it('persists, claims, and completes jobs through registered handlers', async () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      database.enqueueJob('vector-backfill', { memoryId: 'memory-1' }, 1)
      const worker = new LumiServerJobWorker({
        database,
        handlers: {
          'vector-backfill': async job => ({ embedded: job.payload.memoryId }),
        },
        pollIntervalMs: 60_000,
      })
      worker.start()
      await worker.runDueNow()
      expect(database.managerOverview().jobs.completed).toBe(1)
      expect(database.managerOverview().jobs.pending).toBe(0)
      await worker.stop()
    }
    finally {
      database.close()
    }
  })

  it('recovers interrupted jobs and eventually marks unknown work failed', async () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      database.enqueueJob('unknown-work', {}, 1)
      expect(database.claimDueJob(2)?.status).toBe('running')
      expect(database.recoverInterruptedJobs(3)).toBe(1)
      const worker = new LumiServerJobWorker({ database, handlers: {}, pollIntervalMs: 60_000 })
      worker.start()
      await worker.runDueNow()
      expect(database.managerOverview().jobs.failed).toBe(1)
      await worker.stop()
    }
    finally {
      database.close()
    }
  })
})
