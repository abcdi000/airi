import { describe, expect, it } from 'vitest'

import { LumiServerResourceRegistry } from './resourceLeases'

describe('lumiServerResourceRegistry', () => {
  it('serializes one physical resource across conversations', async () => {
    const registry = new LumiServerResourceRegistry()
    const order: string[] = []
    let releaseFirst = () => {}
    let markFirstStarted = () => {}
    const firstStarted = new Promise<void>(resolve => markFirstStarted = resolve)
    const first = registry.run('browser', {
      toolName: 'browser_navigate',
      actorPersonId: 'doggy',
      conversationId: 'doggy-direct',
    }, async () => {
      order.push('first-start')
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
        markFirstStarted()
      })
      order.push('first-end')
    })
    const second = registry.run('browser', {
      toolName: 'browser_click',
      actorPersonId: 'moussy',
      conversationId: 'group',
    }, async () => order.push('second'))

    await firstStarted
    expect(registry.list()).toHaveLength(1)
    expect(order).toEqual(['first-start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
    expect(registry.list()).toEqual([])
  })

  it('aborts a running lease without exposing tool arguments', async () => {
    const registry = new LumiServerResourceRegistry()
    const running = registry.run('minecraft', {
      toolName: 'minecraft_move',
      actorPersonId: 'doggy',
      conversationId: 'group',
    }, async signal => await new Promise<void>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    while (!registry.list().length)
      await Promise.resolve()
    const lease = registry.list()[0]
    expect(lease).not.toHaveProperty('arguments')
    expect(registry.terminate(lease.id).terminationRequestedAt).toBeTypeOf('number')
    await expect(running).rejects.toThrow('terminated by server owner')
  })
})
