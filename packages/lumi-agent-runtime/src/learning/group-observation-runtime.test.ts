import type { GroupObservationEnvelope } from '../input'
import type { GroupObservationBatch } from './group-observation-runtime'

import { describe, expect, it, vi } from 'vitest'

import { GroupObservationRuntime } from './group-observation-runtime'

function observation(overrides: Partial<GroupObservationEnvelope> = {}): GroupObservationEnvelope {
  return {
    eventId: 'event-1',
    messageId: 'message-1',
    sourceId: 'source-a',
    groupId: 'group-a',
    platform: 'qq',
    platformInstanceId: 'qq-main',
    senderId: 'user-1',
    senderName: 'User',
    timestamp: 1,
    authorVerified: true,
    isLumi: false,
    sourceKind: 'human_message',
    text: '这也太炸了',
    images: [],
    segments: [{ type: 'text', text: '这也太炸了' }],
    conversationType: 'group_observation',
    ...overrides,
  }
}

function runtime(
  consume?: (batch: GroupObservationBatch) => Promise<void>,
  restored: readonly GroupObservationEnvelope[] = [],
) {
  const events = new Set(restored.map(item => item.eventId))
  const consumeMock = vi.fn(consume ?? (async (_batch: GroupObservationBatch) => undefined))
  return {
    consume: consumeMock,
    instance: new GroupObservationRuntime({
      policy: {
        enabled: true,
        batchSize: 2,
        maximumTextLength: 2000,
        studyGroups: [
          {
            sourceId: 'source-a',
            platformInstanceId: 'qq-main',
            groupId: 'group-a',
            enabled: true,
          },
          {
            sourceId: 'source-b',
            platformInstanceId: 'qq-main',
            groupId: 'group-b',
            enabled: true,
          },
        ],
      },
      persistence: {
        hasEvent: async eventId => events.has(eventId),
        loadPending: async () => restored,
        append: async (item) => {
          events.add(item.eventId)
        },
      },
      consumer: { consume: consumeMock },
    }),
  }
}

describe('groupObservationRuntime', () => {
  /**
   * @example
   * Group evidence returns acknowledgement metadata and never reply content.
   */
  it('accepts allowlisted human evidence with a reply-suppressed receipt', async () => {
    const { instance } = runtime()

    const receipt = await instance.observe(observation())

    expect(receipt).toEqual({
      accepted: true,
      replySuppressed: true,
      sourceId: 'source-a',
      pendingInSource: 1,
      batchQueued: false,
    })
    expect('text' in receipt).toBe(false)
    expect('segments' in receipt).toBe(false)
  })

  /**
   * @example
   * Commands, unverified authors, and non-allowlisted groups are dropped.
   */
  it('enforces the group learning admission policy before persistence', async () => {
    const { instance } = runtime()

    await expect(instance.observe(observation({
      eventId: 'command',
      sourceKind: 'command',
    }))).resolves.toMatchObject({ accepted: false, reason: 'unsupported_source' })
    await expect(instance.observe(observation({
      eventId: 'unverified',
      authorVerified: false,
    }))).resolves.toMatchObject({ accepted: false, reason: 'unverified_author' })
    await expect(instance.observe(observation({
      eventId: 'unknown-group',
      sourceId: 'source-x',
      groupId: 'group-x',
    }))).resolves.toMatchObject({ accepted: false, reason: 'source_not_allowed' })
  })

  /**
   * @example
   * A platform retry with the same event ID cannot create a second batch item.
   */
  it('deduplicates accepted events', async () => {
    const { instance } = runtime()

    await instance.observe(observation())
    const duplicate = await instance.observe(observation())

    expect(duplicate).toMatchObject({
      accepted: false,
      replySuppressed: true,
      reason: 'duplicate',
      pendingInSource: 1,
    })
  })

  /**
   * @example
   * Source A can be learning while source B starts its own independent batch.
   */
  it('batches each group independently and allows different groups to run concurrently', async () => {
    const releases = new Map<string, () => void>()
    const started: string[] = []
    const consume = async (batch: GroupObservationBatch) => {
      started.push(batch.sourceId)
      await new Promise<void>((resolve) => {
        releases.set(batch.sourceId, resolve)
      })
    }
    const { consume: consumeMock, instance } = runtime(consume)

    await instance.observe(observation({ eventId: 'a-1', messageId: 'a-1' }))
    await instance.observe(observation({ eventId: 'a-2', messageId: 'a-2' }))
    await instance.observe(observation({
      eventId: 'b-1',
      messageId: 'b-1',
      sourceId: 'source-b',
      groupId: 'group-b',
    }))
    await instance.observe(observation({
      eventId: 'b-2',
      messageId: 'b-2',
      sourceId: 'source-b',
      groupId: 'group-b',
    }))
    await vi.waitFor(() => {
      expect(started).toEqual(expect.arrayContaining(['source-a', 'source-b']))
    })

    releases.get('source-a')?.()
    releases.get('source-b')?.()
    await instance.drain()

    expect(consumeMock).toHaveBeenCalledTimes(2)
    expect(consumeMock.mock.calls[0]?.[0].observations.map(item => item.eventId)).toEqual(['a-1', 'a-2'])
    expect(consumeMock.mock.calls[1]?.[0].observations.map(item => item.eventId)).toEqual(['b-1', 'b-2'])
  })

  /**
   * @example
   * One learner failure does not reject later observations or throw into AstrBot.
   */
  it('contains asynchronous batch failures inside the read-only runtime', async () => {
    const consume = async (_batch: GroupObservationBatch) => {
      throw new Error('curator unavailable')
    }
    const { instance } = runtime(consume)

    await instance.observe(observation({ eventId: 'a-1', messageId: 'a-1' }))
    await expect(instance.observe(observation({
      eventId: 'a-2',
      messageId: 'a-2',
    }))).resolves.toMatchObject({
      accepted: true,
      replySuppressed: true,
      batchQueued: true,
    })
    await expect(instance.drain()).resolves.toBeUndefined()
  })

  /**
   * @example
   * A host restart resumes persisted evidence without requiring a new message.
   */
  it('restores complete pending batches after restart', async () => {
    const restored = [
      observation({ eventId: 'restored-1', messageId: 'restored-1', timestamp: 10 }),
      observation({ eventId: 'restored-2', messageId: 'restored-2', timestamp: 20 }),
    ]
    const { consume, instance } = runtime(undefined, restored)

    await instance.resume()
    await instance.drain()

    expect(consume).toHaveBeenCalledTimes(1)
    expect(consume.mock.calls[0]?.[0].observations.map(item => item.eventId)).toEqual([
      'restored-1',
      'restored-2',
    ])
  })

  /**
   * @example
   * A failed oldest batch remains ahead of later evidence until explicitly retried.
   */
  it('requeues a failed batch without processing newer same-source evidence first', async () => {
    let attempt = 0
    const consume = vi.fn(async (_batch: GroupObservationBatch) => {
      attempt += 1
      if (attempt === 1)
        throw new Error('curator offline')
    })
    const restored = [
      observation({ eventId: 'old-1', messageId: 'old-1', timestamp: 10 }),
      observation({ eventId: 'old-2', messageId: 'old-2', timestamp: 20 }),
      observation({ eventId: 'new-1', messageId: 'new-1', timestamp: 30 }),
      observation({ eventId: 'new-2', messageId: 'new-2', timestamp: 40 }),
    ]
    const { instance } = runtime(consume, restored)

    await instance.resume()
    await instance.drain()
    expect(consume).toHaveBeenCalledTimes(1)
    expect(consume.mock.calls[0]?.[0].observations.map(item => item.eventId)).toEqual(['old-1', 'old-2'])

    await instance.resume()
    await instance.drain()
    expect(consume).toHaveBeenCalledTimes(3)
    expect(consume.mock.calls[1]?.[0].observations.map(item => item.eventId)).toEqual(['old-1', 'old-2'])
    expect(consume.mock.calls[2]?.[0].observations.map(item => item.eventId)).toEqual(['new-1', 'new-2'])
  })
})
