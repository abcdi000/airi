import { describe, expect, it } from 'vitest'

import {
  completeGroupObservationBatch,
  createEmptySocialLanguageSnapshot,
  enqueueGroupObservation,
  migrateSocialLanguageSnapshot,
  nextGroupObservationBatch,
} from './index'

const observation = {
  eventId: 'default:1',
  messageId: '1',
  sourceId: 'default:100',
  platform: 'aiocqhttp',
  platformInstanceId: 'default',
  groupId: '100',
  senderId: '200',
  senderName: 'speaker',
  text: '这也太炸了',
  timestamp: 1,
}

describe('group observation queue', () => {
  it('deduplicates and processes a same-source batch without retaining raw audit text', () => {
    let snapshot = createEmptySocialLanguageSnapshot(0)
    snapshot = enqueueGroupObservation(snapshot, observation)
    snapshot = enqueueGroupObservation(snapshot, observation)
    snapshot = enqueueGroupObservation(snapshot, {
      ...observation,
      eventId: 'default:2',
      messageId: '2',
      timestamp: 2,
    })

    expect(snapshot.observationBuffer).toHaveLength(2)
    expect(snapshot.observationHistory).toHaveLength(2)
    const batch = nextGroupObservationBatch(snapshot, 2)
    expect(batch.map(item => item.messageId)).toEqual(['1', '2'])

    snapshot = completeGroupObservationBatch(snapshot, batch, {
      id: 'batch-1',
      sourceId: observation.sourceId,
      messageIds: ['1', '2'],
      messageCount: 2,
      processedAt: 3,
      curator: 'pending',
      expressionIds: [],
      jargonIds: [],
      behaviorIds: [],
      publicKnowledgeIds: [],
    })
    expect(snapshot.observationBuffer).toEqual([])
    expect(snapshot.observationHistory.map(item => item.messageId)).toEqual(['1', '2'])
    expect(snapshot.observationBatches[0]).not.toHaveProperty('text')
  })

  it('preserves v3 batch audits while adding monitor change lists', () => {
    const snapshot = migrateSocialLanguageSnapshot({
      version: 3,
      expressions: [],
      jargon: [],
      behaviors: [],
      decisions: [],
      observationBuffer: [],
      observationBatches: [{
        id: 'legacy-batch',
        sourceId: 'default:100',
        messageIds: ['1'],
        messageCount: 1,
        processedAt: 2,
        curator: 'pending',
      }],
      updatedAt: 2,
    })

    expect(snapshot.version).toBe(4)
    expect(snapshot.observationBatches[0]?.expressionIds).toEqual([])
    expect(snapshot.observationBatches[0]?.jargonIds).toEqual([])
    expect(snapshot.observationBatches[0]?.behaviorIds).toEqual([])
  })

  it('does not let an incomplete quiet source block a complete busy source', () => {
    let snapshot = createEmptySocialLanguageSnapshot(0)
    snapshot = enqueueGroupObservation(snapshot, observation)
    for (let index = 1; index <= 3; index++) {
      snapshot = enqueueGroupObservation(snapshot, {
        ...observation,
        eventId: `busy:${index}`,
        messageId: `busy-${index}`,
        sourceId: 'default:busy',
        groupId: 'busy',
        timestamp: index + 1,
      })
    }

    const batch = nextGroupObservationBatch(snapshot, 3)

    expect(batch.map(item => item.messageId)).toEqual(['busy-1', 'busy-2', 'busy-3'])
  })

  it('bounds retained monitor history without discarding pending evidence', () => {
    let snapshot = createEmptySocialLanguageSnapshot(0)
    for (let index = 1; index <= 3; index++) {
      snapshot = enqueueGroupObservation(snapshot, {
        ...observation,
        eventId: `event:${index}`,
        messageId: String(index),
        timestamp: index,
      }, 2)
    }

    expect(snapshot.observationBuffer.map(item => item.messageId)).toEqual(['1', '2', '3'])
    expect(snapshot.observationHistory.map(item => item.messageId)).toEqual(['2', '3'])
  })
})
