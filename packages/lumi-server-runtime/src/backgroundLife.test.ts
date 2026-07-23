import { describe, expect, it, vi } from 'vitest'

import { LumiBackgroundLife, nextDailyTime } from './backgroundLife'
import { DOGGY_PERSON_ID, LumiServerDatabase } from './database'

describe('lumiBackgroundLife', () => {
  it('writes diary and life state without any connected client', async () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      database.acceptUserMessage({
        conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
        actorPersonId: DOGGY_PERSON_ID,
        messageId: 'background-input',
        idempotencyKey: 'background-input-key',
        content: 'Today we finished the server migration.',
        createdAt: Date.now(),
      })
      const generate = vi.fn(async request => ({
        text: request.conversationId === 'lumi-background' ? 'A quiet, productive day.' : 'unused',
      }))
      const background = new LumiBackgroundLife({
        database,
        model: { generate },
        personaPrompt: 'You are Lumi.',
        diary: { enabled: false, dailyTime: '23:00' },
        autonomousLife: { enabled: false, minimumIntervalMs: 60_000, maximumIntervalMs: 60_000 },
      })
      const handlers = background.handlers()
      const job = database.enqueueJob('test', {})

      await handlers['diary-daily']!({ ...job, attempts: 1, status: 'running' }, new AbortController().signal)
      await handlers['autonomous-life-tick']!({ ...job, attempts: 1, status: 'running' }, new AbortController().signal)

      expect(database.managerOverview().diaryEntries).toBe(1)
      expect(database.readAutonomousState('life')?.lastReflection).toBe('A quiet, productive day.')
      expect(generate).toHaveBeenCalledTimes(2)
    }
    finally {
      database.close()
    }
  })

  it('schedules the next local diary time in the future', () => {
    const from = new Date(2026, 6, 21, 23, 30, 0, 0)
    expect(new Date(nextDailyTime('23:00', from)).getDate()).toBe(22)
    expect(new Date(nextDailyTime('23:00', from)).getHours()).toBe(23)
  })
})
