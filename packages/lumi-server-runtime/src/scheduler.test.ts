import { describe, expect, it } from 'vitest'

import { LumiConversationScheduler } from './scheduler'

describe('lumiConversationScheduler', () => {
  it('runs jobs FIFO within one conversation', async () => {
    const scheduler = new LumiConversationScheduler(2)
    const firstRelease = deferred<void>()
    const order: string[] = []

    const first = scheduler.run('shared-room', async () => {
      order.push('first-start')
      await firstRelease.promise
      order.push('first-end')
    })
    const second = scheduler.run('shared-room', async () => {
      order.push('second')
    })

    await nextTurn()
    expect(order).toEqual(['first-start'])
    firstRelease.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
  })

  it('allows bounded work across independent conversations', async () => {
    const scheduler = new LumiConversationScheduler(2)
    const release = deferred<void>()
    const started: string[] = []

    const jobs = ['doggy-direct', 'moussy-direct', 'group'].map(lane => scheduler.run(lane, async () => {
      started.push(lane)
      await release.promise
    }))

    await nextTurn()
    expect(started).toEqual(['doggy-direct', 'moussy-direct'])
    release.resolve()
    await Promise.all(jobs)
    expect(started).toEqual(['doggy-direct', 'moussy-direct', 'group'])
  })

  it('drains every accepted lane before shutdown continues', async () => {
    const scheduler = new LumiConversationScheduler(2)
    let release: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => markStarted = resolve)
    let drained = false
    void scheduler.run('conversation-a', async () => {
      markStarted?.()
      await new Promise<void>(resolve => release = resolve)
    })
    const draining = scheduler.drain().then(() => drained = true)

    await started
    expect(drained).toBe(false)
    release?.()
    await draining
    expect(drained).toBe(true)
    expect(scheduler.pendingLaneCount).toBe(0)
  })
})

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {}
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

async function nextTurn() {
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}
