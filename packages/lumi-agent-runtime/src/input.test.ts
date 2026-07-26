import { describe, expect, it } from 'vitest'

import {
  validateDirectPerceptionEnvelope,
  validateGroupObservationEnvelope,
} from './input'

describe('perception envelope boundaries', () => {
  it('accepts a fully resolved direct envelope', () => {
    expect(() => validateDirectPerceptionEnvelope({
      eventId: 'event-1',
      conversationId: 'direct-doggy',
      personId: 'doggy',
      platform: 'desktop',
      platformInstanceId: 'desktop-main',
      externalUserId: 'doggy-local',
      timestamp: 1,
      text: 'hello',
      segments: [{ type: 'text', text: 'hello' }],
      attachments: [],
      sourceMessageId: 'message-1',
      participantPersonIds: ['doggy'],
      conversationType: 'direct',
    })).not.toThrow()
  })

  it('rejects a direct envelope whose authenticated person is not a participant', () => {
    expect(() => validateDirectPerceptionEnvelope({
      eventId: 'event-1',
      conversationId: 'direct-doggy',
      personId: 'doggy',
      platform: 'desktop',
      platformInstanceId: 'desktop-main',
      externalUserId: 'doggy-local',
      timestamp: 1,
      segments: [],
      attachments: [],
      sourceMessageId: 'message-1',
      participantPersonIds: ['moussy'],
      conversationType: 'direct',
    })).toThrow('participantPersonIds')
  })

  it('validates a group observation without introducing outbound data', () => {
    const observation = {
      eventId: 'event-2',
      messageId: 'group-message-1',
      sourceId: 'qq:group:42',
      groupId: '42',
      platform: 'qq',
      platformInstanceId: 'qq-main',
      senderId: '10001',
      senderName: 'member',
      timestamp: 2,
      text: 'group evidence',
      images: [],
      segments: [{ type: 'text' as const, text: 'group evidence' }],
      conversationType: 'group_observation' as const,
    }

    expect(() => validateGroupObservationEnvelope(observation)).not.toThrow()
    expect('outbound' in observation).toBe(false)
    expect('replyChannel' in observation).toBe(false)
  })
})
