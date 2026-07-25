import { describe, expect, it } from 'vitest'

import {
  DOGGY_MOUSSY_GROUP_ID,
  DOGGY_PERSON_ID,
  LUMI_SERVER_BACKUP_FORMAT,
  LumiServerDatabase,
  MOUSSY_PERSON_ID,
} from './database'

const doggyDirectId = `lumi-direct:${DOGGY_PERSON_ID}`
const moussyDirectId = `lumi-direct:${MOUSSY_PERSON_ID}`

function memoryCandidate(overrides: Partial<Parameters<LumiServerDatabase['storeMemoryCandidate']>[0]['candidate']> = {}) {
  return {
    type: 'user_fact' as const,
    content: 'Doggy likes cooperative games.',
    confidence: 0.9,
    importance: 0.8,
    emotionalIntensity: 0.4,
    relationshipRelevance: 0.8,
    decay: 0.1,
    tags: ['daily'],
    status: 'candidate' as const,
    reason: 'Test candidate',
    ...overrides,
  }
}

function memoryRequest(userId: string, conversationId: string, conversationType: 'direct' | 'group' = 'direct') {
  return {
    query: 'memory',
    userId,
    personaId: 'lumi',
    limit: 100,
    conversationType,
    viewerUserId: userId,
    conversationId,
  } as const
}

describe('lumiServerDatabase', () => {
  it('keeps direct histories private while sharing the explicit group', () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      expect(database.listConversations(DOGGY_PERSON_ID).map(item => item.id)).toEqual([
        doggyDirectId,
        DOGGY_MOUSSY_GROUP_ID,
      ])
      expect(database.listConversations(MOUSSY_PERSON_ID).map(item => item.id)).toEqual([
        `lumi-direct:${MOUSSY_PERSON_ID}`,
        DOGGY_MOUSSY_GROUP_ID,
      ])
      expect(() => database.replay(doggyDirectId, MOUSSY_PERSON_ID, 0)).toThrow(
        'Authenticated person is not a member of this conversation',
      )
    }
    finally {
      database.close()
    }
  })

  it('deduplicates reliable input without generating another sequence', () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      const input = {
        conversationId: DOGGY_MOUSSY_GROUP_ID,
        actorPersonId: DOGGY_PERSON_ID,
        messageId: 'message-1',
        idempotencyKey: 'device-1:message-1',
        content: 'Hello Lumi',
        createdAt: 1_700_000_000_000,
      }
      const accepted = database.acceptUserMessage(input)
      const duplicate = database.acceptUserMessage(input)

      expect(accepted.status).toBe('accepted')
      expect(duplicate.status).toBe('duplicate')
      expect(duplicate.message.sequence).toBe(accepted.message.sequence)
      expect(database.replay(DOGGY_MOUSSY_GROUP_ID, MOUSSY_PERSON_ID, 0).messages).toHaveLength(1)
      expect(() => database.acceptUserMessage({ ...input, content: 'Changed payload' })).toThrow(
        'Idempotency key was already used for different input',
      )
    }
    finally {
      database.close()
    }
  })

  it('binds an invitation to its server-selected person exactly once', () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      const invitation = database.createInvitation(MOUSSY_PERSON_ID)
      expect(database.inspectInvitation(invitation.code).personId).toBe(MOUSSY_PERSON_ID)

      database.consumeInvitation({ code: invitation.code, authUserId: 'better-auth-user-moussy' })
      expect(database.personForAccount('better-auth-user-moussy')?.id).toBe(MOUSSY_PERSON_ID)
      expect(() => database.inspectInvitation(invitation.code)).toThrow('Invitation is invalid or expired')
    }
    finally {
      database.close()
    }
  })

  it('exports server data without authentication sessions', () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      database.acceptUserMessage({
        conversationId: doggyDirectId,
        actorPersonId: DOGGY_PERSON_ID,
        messageId: 'summary-source',
        idempotencyKey: 'summary-source',
        content: 'old context',
        createdAt: 1,
      })
      database.saveConversationSummary({
        version: 1,
        conversationId: doggyDirectId,
        summary: 'model-authored summary',
        throughMessageId: 'summary-source',
        sourceMessageCount: 1,
        estimatedSourceTokens: 12,
        updatedAt: 2,
      })
      const backup = database.exportBackup()
      expect(backup.format).toBe(LUMI_SERVER_BACKUP_FORMAT)
      expect(backup.sections.people).toHaveLength(2)
      expect(backup.sections.conversationSummaries).toHaveLength(1)
      expect(backup.sections).not.toHaveProperty('sessions')
    }
    finally {
      database.close()
    }
  })

  it('shares Lumi self facts while isolating relationship memories', () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      const birthday = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: doggyDirectId,
        candidate: memoryCandidate({
          type: 'persona_fact',
          content: 'Lumi\'s birthday is July 21.',
          tags: ['lumi_self'],
          scope: 'global',
        }),
      })
      const doggyPreference = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: doggyDirectId,
        candidate: memoryCandidate(),
      })
      database.setMemoryStatus(birthday.id, 'active')
      database.setMemoryStatus(doggyPreference.id, 'active')

      expect(database.listAccessibleMemories(memoryRequest(DOGGY_PERSON_ID, doggyDirectId)).map(item => item.id)).toEqual(
        expect.arrayContaining([birthday.id, doggyPreference.id]),
      )
      expect(database.listAccessibleMemories(memoryRequest(MOUSSY_PERSON_ID, moussyDirectId)).map(item => item.id)).toEqual([
        birthday.id,
      ])
    }
    finally {
      database.close()
    }
  })

  it('keeps group memories inside their exact group conversation', () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      const groupMemory = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: DOGGY_MOUSSY_GROUP_ID,
        candidate: memoryCandidate({ type: 'shared_event', content: 'We played a game together.' }),
      })
      database.setMemoryStatus(groupMemory.id, 'active')

      expect(groupMemory.scope).toBe('group')
      expect(database.listAccessibleMemories(memoryRequest(
        MOUSSY_PERSON_ID,
        DOGGY_MOUSSY_GROUP_ID,
        'group',
      )).map(item => item.id)).toEqual([groupMemory.id])
      expect(database.listAccessibleMemories(memoryRequest(MOUSSY_PERSON_ID, moussyDirectId))).toEqual([])
    }
    finally {
      database.close()
    }
  })

  it('downgrades unsafe model scope proposals and detects state write conflicts', () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      const unsafeGlobal = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: doggyDirectId,
        candidate: memoryCandidate({ scope: 'global' }),
      })
      expect(unsafeGlobal.scope).toBe('relationship')
      expect(unsafeGlobal.ownerId).toBe(DOGGY_PERSON_ID)

      expect(database.writePersonState({
        personId: DOGGY_PERSON_ID,
        kind: 'short-term',
        payload: { focus: 'server refactor' },
        expectedVersion: 0,
      }).version).toBe(1)
      expect(() => database.writePersonState({
        personId: DOGGY_PERSON_ID,
        kind: 'short-term',
        payload: { focus: 'stale write' },
        expectedVersion: 0,
      })).toThrow('Person state version conflict')
      expect(database.readPersonState(DOGGY_PERSON_ID, 'short-term')?.payload).toEqual({ focus: 'server refactor' })
    }
    finally {
      database.close()
    }
  })
})
