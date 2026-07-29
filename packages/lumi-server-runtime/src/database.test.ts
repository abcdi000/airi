import type { PersistedSessionState } from '@proj-airi/lumi-agent-runtime'
import type {
  LumiBeliefHypothesis,
  LumiCognitiveEvidence,
  LumiCognitiveIdentity,
} from '@proj-airi/lumi-runtime'

import { createLumiWorkingMemory } from '@proj-airi/lumi-runtime'
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

function cognitiveIdentity(
  actorId = DOGGY_PERSON_ID,
  conversationId = doggyDirectId,
  conversationType: LumiCognitiveIdentity['conversationType'] = 'direct',
  participantUserIds = [actorId],
): LumiCognitiveIdentity {
  return {
    actorId,
    personaId: 'lumi',
    conversationId,
    conversationType,
    participantUserIds,
  }
}

function cognitiveEvidence(
  sourceMessageId: string,
  content = '继续处理 Patchright 的默认浏览器方案。',
): LumiCognitiveEvidence {
  const identity = cognitiveIdentity()
  return {
    id: `evidence:message:${identity.conversationId}:${sourceMessageId}`,
    actorId: identity.actorId,
    subjectUserIds: [identity.actorId],
    conversationId: identity.conversationId,
    conversationType: identity.conversationType,
    kind: 'user_statement',
    origin: 'primary',
    content,
    sourceId: sourceMessageId,
    sourceMessageId,
    occurredAt: '2026-07-29T06:00:00.000Z',
    trust: 1,
    authorVerified: true,
    scope: 'private',
    sensitivity: 'private',
    participantUserIds: [...identity.participantUserIds],
    derivedFromEvidenceIds: [],
    schemaVersion: 1,
  }
}

function belief(evidenceId: string): LumiBeliefHypothesis {
  return {
    id: 'belief:doggy:browser-default',
    subjectId: DOGGY_PERSON_ID,
    predicate: 'browser.default_engine',
    value: 'patchright',
    confidence: 0.82,
    stability: 0.66,
    evidenceIds: [evidenceId],
    counterEvidenceIds: [],
    firstObservedAt: '2026-07-29T06:00:00.000Z',
    lastObservedAt: '2026-07-29T06:00:00.000Z',
    expiresAt: '2026-08-29T06:00:00.000Z',
    status: 'supported',
    scope: 'private',
    sensitivity: 'private',
    conversationId: doggyDirectId,
    participantUserIds: [DOGGY_PERSON_ID],
    evidenceCount: 1,
    independentEvidenceCount: 1,
    familiarity: 0.5,
    ownership: 0,
    positiveFeedback: 0,
    negativeFeedback: 0,
    rejectionCount: 0,
    firstSeenAt: '2026-07-29T06:00:00.000Z',
    lastSeenAt: '2026-07-29T06:00:00.000Z',
    decay: 0.05,
  }
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

  it('persists and restores the host-managed Agent Runtime ledger', () => {
    const source = LumiServerDatabase.open(':memory:')
    const restored = LumiServerDatabase.open(':memory:')
    try {
      const state: PersistedSessionState = {
        conversationId: doggyDirectId,
        contextEpoch: 2,
        summaryVersion: 1,
        stablePrefixHash: 'fnv1a32:test',
        dialogueSegmentId: 'dialogue:2',
        generation: 7,
        history: [{
          id: 'user:message-7',
          kind: 'dialogue_user',
          messageId: 'message-7',
          personId: DOGGY_PERSON_ID,
          text: '继续',
          segments: [{ type: 'text', text: '继续' }],
          attachments: [],
          timestamp: 7,
          countInContext: true,
          remainingUses: null,
          source: 'lumi-online',
          visibility: 'both',
          provenance: {
            origin: 'direct_perception',
            sourceIds: ['event-7', 'message-7'],
          },
        }],
        completedEvents: [{
          eventId: 'event-6',
          sourceMessageId: 'message-6',
          completedAt: 6,
          result: {
            turnId: 'event-6:g6',
            conversationId: doggyDirectId,
            generation: 6,
            endReason: 'reply_sent',
            sentMessageIds: ['assistant-6'],
          },
        }],
      }
      source.saveAgentSession(state)

      expect(source.loadAgentSession(doggyDirectId)).toEqual(state)
      const backup = source.exportBackup()
      expect(backup.sections.agentSessions).toHaveLength(1)

      restored.restoreBackup(backup)
      expect(restored.loadAgentSession(doggyDirectId)).toEqual(state)
    }
    finally {
      source.close()
      restored.close()
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

  it('atomically persists cognitive evidence and working memory through backup restore', () => {
    const source = LumiServerDatabase.open(':memory:')
    const restored = LumiServerDatabase.open(':memory:')
    try {
      source.acceptUserMessage({
        conversationId: doggyDirectId,
        actorPersonId: DOGGY_PERSON_ID,
        messageId: 'cognitive-source',
        idempotencyKey: 'cognitive-source',
        content: '继续处理 Patchright 的默认浏览器方案。',
        createdAt: Date.parse('2026-07-29T06:00:00.000Z'),
      })
      const identity = cognitiveIdentity()
      const evidence = cognitiveEvidence('cognitive-source')
      const workingMemory = {
        ...createLumiWorkingMemory({
          personId: identity.actorId,
          personaId: identity.personaId,
          conversationId: identity.conversationId,
          conversationType: identity.conversationType,
          now: evidence.occurredAt,
        }),
        continuationPoint: '默认使用 Patchright，特殊情况使用 Playwright。',
      }
      source.commitCognitiveFastLoop({ identity, evidence, feedback: [], workingMemory })

      expect(source.loadCognitiveWorkingMemory(identity)?.continuationPoint)
        .toBe('默认使用 Patchright，特殊情况使用 Playwright。')
      const backup = source.exportBackup()
      expect(backup.sections.cognitiveEvidence).toHaveLength(1)
      expect(backup.sections.cognitiveWorkingMemory).toHaveLength(1)
      expect(backup.sections.cognitiveMigrations?.[0]?.phase).toBe('active')

      restored.restoreBackup(backup)
      expect(restored.loadCognitiveWorkingMemory(identity)).toEqual(workingMemory)
      expect(restored.exportBackup().sections.cognitiveEvidence).toEqual(backup.sections.cognitiveEvidence)
    }
    finally {
      source.close()
      restored.close()
    }
  })

  it('rejects cognitive id reuse and keeps direct cognition out of other users and groups', () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      database.acceptUserMessage({
        conversationId: doggyDirectId,
        actorPersonId: DOGGY_PERSON_ID,
        messageId: 'private-cognitive-source',
        idempotencyKey: 'private-cognitive-source',
        content: '默认使用 Patchright。',
        createdAt: Date.parse('2026-07-29T06:00:00.000Z'),
      })
      const identity = cognitiveIdentity()
      const evidence = cognitiveEvidence('private-cognitive-source', '默认使用 Patchright。')
      const workingMemory = createLumiWorkingMemory({
        personId: identity.actorId,
        personaId: identity.personaId,
        conversationId: identity.conversationId,
        conversationType: identity.conversationType,
        now: evidence.occurredAt,
      })
      database.commitCognitiveFastLoop({ identity, evidence, feedback: [], workingMemory })
      expect(() => database.commitCognitiveFastLoop({
        identity,
        evidence: { ...evidence, content: '篡改后的内容' },
        feedback: [],
        workingMemory,
      })).toThrow('id was reused for different content')

      const hypothesis = belief(evidence.id)
      database.upsertCognitiveBelief(identity, hypothesis)
      database.upsertCognitiveProfileProjection(identity, {
        id: 'profile:doggy:daily-browser',
        subjectId: DOGGY_PERSON_ID,
        layer: 'daily',
        key: 'current_browser_work',
        value: '正在处理 Patchright 默认方案',
        beliefIds: [hypothesis.id],
        evidenceIds: [evidence.id],
        confidence: 0.8,
        stability: 0.6,
        expiresAt: '2026-08-01T06:00:00.000Z',
        status: 'active',
        scope: 'private',
        sensitivity: 'private',
        updatedAt: '2026-07-29T06:00:00.000Z',
      })

      expect(database.loadCognitiveProjectionState(cognitiveIdentity(
        MOUSSY_PERSON_ID,
        moussyDirectId,
      )).hypotheses).toEqual([])
      const group = database.loadCognitiveProjectionState(cognitiveIdentity(
        DOGGY_PERSON_ID,
        DOGGY_MOUSSY_GROUP_ID,
        'group',
        [DOGGY_PERSON_ID, MOUSSY_PERSON_ID],
      ))
      expect(group.hypotheses).toEqual([])
      expect(group.profile).toEqual([])
      expect(group.relationshipState).toBeUndefined()
    }
    finally {
      database.close()
    }
  })

  it('marks injected memory use and migrates legacy state without claiming primary evidence', () => {
    const source = LumiServerDatabase.open(':memory:')
    const restored = LumiServerDatabase.open(':memory:')
    try {
      source.acceptUserMessage({
        conversationId: doggyDirectId,
        actorPersonId: DOGGY_PERSON_ID,
        messageId: 'memory-evidence-source',
        idempotencyKey: 'memory-evidence-source',
        content: '我喜欢合作游戏。',
        createdAt: Date.parse('2026-07-29T06:00:00.000Z'),
      })
      const identity = cognitiveIdentity()
      const evidence = cognitiveEvidence('memory-evidence-source', '我喜欢合作游戏。')
      source.commitCognitiveFastLoop({
        identity,
        evidence,
        feedback: [],
        workingMemory: createLumiWorkingMemory({
          personId: identity.actorId,
          personaId: identity.personaId,
          conversationId: identity.conversationId,
          conversationType: identity.conversationType,
          now: evidence.occurredAt,
        }),
      })
      const memory = source.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: doggyDirectId,
        candidate: memoryCandidate({ sourceMessageId: 'memory-evidence-source' }),
      })
      source.setMemoryStatus(memory.id, 'active')
      source.recordCognitiveContextUse({
        identity,
        memoryIds: [memory.id],
        hypothesisIds: [],
        usedAt: '2026-07-29T06:05:00.000Z',
      })
      expect(source.loadAccessibleMemoriesByIds(identity, [memory.id])[0]).toMatchObject({
        useCount: 1,
        lastUsedAt: '2026-07-29T06:05:00.000Z',
        evidenceOrigin: 'derived',
        derivedFromEvidenceIds: [evidence.id],
      })

      source.writePersonState({
        personId: DOGGY_PERSON_ID,
        kind: 'profile',
        payload: { oldInference: 'legacy only' },
      })
      const legacyBackup = source.exportBackup()
      legacyBackup.sections.memories = []
      legacyBackup.sections.memoryVectors = []
      legacyBackup.sections.cognitiveEvidence = []
      legacyBackup.sections.cognitiveEvidenceSubjects = []
      legacyBackup.sections.cognitiveEvidenceLineage = []
      legacyBackup.sections.cognitiveWorkingMemory = []
      legacyBackup.sections.cognitiveBeliefs = []
      legacyBackup.sections.cognitiveBeliefEvidence = []
      legacyBackup.sections.cognitiveFeedback = []
      legacyBackup.sections.cognitiveFeedbackTargets = []
      legacyBackup.sections.cognitiveProfileProjections = []
      legacyBackup.sections.cognitiveProjectionBeliefs = []
      legacyBackup.sections.cognitiveProjectionEvidence = []
      legacyBackup.sections.cognitiveMigrations = []
      restored.restoreBackup(legacyBackup)

      const migrated = restored.exportBackup()
      expect(migrated.sections.cognitiveEvidence).toEqual([
        expect.objectContaining({
          actor_id: 'lumi',
          kind: 'legacy_import',
          origin: 'legacy_import',
          author_verified: 0,
        }),
      ])
      expect(migrated.sections.cognitiveMigrations?.[0]).toMatchObject({ phase: 'active' })
    }
    finally {
      source.close()
      restored.close()
    }
  })
})
