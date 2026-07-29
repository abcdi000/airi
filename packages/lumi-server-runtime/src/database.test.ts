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
  patch: Partial<LumiCognitiveEvidence> = {},
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
    ...patch,
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

  /** @example A server checkpoint becomes one private episode and remains actor-isolated. */
  it('persists context compaction as idempotent derived episodic cognition', () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      const identity = cognitiveIdentity()
      for (const [messageId, content] of [
        ['episode-message-1', 'Continue the Patchright migration.'],
        ['episode-message-2', 'Keep the unresolved browser decision.'],
      ] as const) {
        database.acceptUserMessage({
          conversationId: doggyDirectId,
          actorPersonId: DOGGY_PERSON_ID,
          messageId,
          idempotencyKey: messageId,
          content,
          createdAt: Date.parse('2026-07-29T08:00:00.000Z'),
        })
        database.commitCognitiveFastLoop({
          identity,
          evidence: cognitiveEvidence(messageId, content),
          feedback: [],
          workingMemory: createLumiWorkingMemory({
            personId: identity.actorId,
            personaId: identity.personaId,
            conversationId: identity.conversationId,
            conversationType: identity.conversationType,
            now: '2026-07-29T08:00:00.000Z',
          }),
        })
      }

      const input = {
        identity,
        episodeId: 'dialogue:1:summary:1',
        summary: 'Doggy and Lumi kept the Patchright migration and its unresolved browser decision.',
        sourceMessageIds: ['episode-message-1', 'assistant-message-1', 'episode-message-2'],
        occurredAt: '2026-07-29T08:05:00.000Z',
      }
      const memory = database.consolidateCognitiveEpisode(input)
      const repeated = database.consolidateCognitiveEpisode(input)

      expect(repeated.id).toBe(memory.id)
      expect(database.loadAccessibleMemoriesByIds(identity, [memory.id])).toEqual([
        expect.objectContaining({
          id: memory.id,
          type: 'shared_event',
          scope: 'private',
          visibility: 'private',
          sourceEpisodeStartMessageId: 'episode-message-1',
          sourceEpisodeEndMessageId: 'episode-message-2',
          evidenceOrigin: 'derived',
        }),
      ])
      expect(database.loadAccessibleMemoriesByIds(cognitiveIdentity(
        MOUSSY_PERSON_ID,
        moussyDirectId,
      ), [memory.id])).toEqual([])
      const archive = database.exportBackup()
      expect(archive.sections.cognitiveEvidence).toContainEqual(expect.objectContaining({
        kind: 'conversation_episode',
        origin: 'derived',
        author_verified: 0,
      }))
      expect(archive.sections.cognitiveEvidenceLineage).toHaveLength(2)
    }
    finally {
      database.close()
    }
  })

  it('consolidates an explicit correction and supersedes only its prior evidence-backed memory', () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      database.acceptUserMessage({
        conversationId: doggyDirectId,
        actorPersonId: DOGGY_PERSON_ID,
        messageId: 'preference-old',
        idempotencyKey: 'preference-old',
        content: 'I like concise replies.',
        createdAt: Date.parse('2026-07-29T06:00:00.000Z'),
      })
      const identity = cognitiveIdentity()
      const oldEvidence = cognitiveEvidence('preference-old', 'I like concise replies.')
      database.commitCognitiveFastLoop({
        identity,
        evidence: oldEvidence,
        feedback: [],
        workingMemory: createLumiWorkingMemory({
          personId: identity.actorId,
          personaId: identity.personaId,
          conversationId: identity.conversationId,
          conversationType: identity.conversationType,
          now: oldEvidence.occurredAt,
        }),
      })
      const oldMemory = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: doggyDirectId,
        candidate: memoryCandidate({
          type: 'user_preference',
          content: 'Doggy likes concise replies.',
          sourceMessageId: 'preference-old',
          tags: ['communication'],
        }),
      })

      database.acceptUserMessage({
        conversationId: doggyDirectId,
        actorPersonId: DOGGY_PERSON_ID,
        messageId: 'preference-correction',
        idempotencyKey: 'preference-correction',
        content: 'Correction: I dislike concise replies.',
        createdAt: Date.parse('2026-07-29T06:05:00.000Z'),
      })
      const correctionEvidence = cognitiveEvidence(
        'preference-correction',
        'Correction: I dislike concise replies.',
        {
          kind: 'user_correction',
          occurredAt: '2026-07-29T06:05:00.000Z',
        },
      )
      database.commitCognitiveFastLoop({
        identity,
        evidence: correctionEvidence,
        feedback: [],
        workingMemory: createLumiWorkingMemory({
          personId: identity.actorId,
          personaId: identity.personaId,
          conversationId: identity.conversationId,
          conversationType: identity.conversationType,
          now: correctionEvidence.occurredAt,
        }),
      })
      const correctedMemory = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: doggyDirectId,
        candidate: memoryCandidate({
          type: 'user_preference',
          content: 'Doggy dislikes concise replies.',
          sourceMessageId: 'preference-correction',
          tags: ['communication'],
        }),
      })

      const backup = database.exportBackup()
      const oldRow = backup.sections.memories.find(row => row.id === oldMemory.id)
      const correctedRow = backup.sections.memories.find(row => row.id === correctedMemory.id)
      const beliefRow = backup.sections.cognitiveBeliefs?.find(row => row.subject_id === DOGGY_PERSON_ID)
      const projectionRow = backup.sections.cognitiveProfileProjections?.find(row => row.subject_id === DOGGY_PERSON_ID)

      expect(oldMemory.status).toBe('active')
      expect(correctedMemory).toMatchObject({
        status: 'active',
        supersedesId: oldMemory.id,
      })
      expect(oldRow).toMatchObject({
        status: 'contradicted',
        superseded_by_id: correctedMemory.id,
      })
      expect(correctedRow).toMatchObject({
        status: 'active',
        supersedes_id: oldMemory.id,
      })
      expect(JSON.parse(String(beliefRow?.value_json))).toBe('Doggy dislikes concise replies.')
      expect(JSON.parse(String(beliefRow?.counter_evidence_ids_json))).toEqual([oldEvidence.id])
      expect(projectionRow).toMatchObject({
        layer: 'dynamic',
        status: 'pending',
      })
      expect(database.loadAccessibleMemoriesByIds(identity, [oldMemory.id])).toEqual([])
      expect(database.loadAccessibleMemoriesByIds(identity, [correctedMemory.id]).map(item => item.id))
        .toEqual([correctedMemory.id])
    }
    finally {
      database.close()
    }
  })

  it('does not let another user private memory affect candidate conflict status', () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      const doggyMemory = database.storeMemoryCandidate({
        actorPersonId: DOGGY_PERSON_ID,
        conversationId: doggyDirectId,
        candidate: memoryCandidate({
          type: 'user_preference',
          content: 'Doggy likes cooperative games.',
          tags: ['games'],
        }),
      })
      const moussyMemory = database.storeMemoryCandidate({
        actorPersonId: MOUSSY_PERSON_ID,
        conversationId: moussyDirectId,
        candidate: memoryCandidate({
          type: 'user_preference',
          content: 'Moussy dislikes cooperative games.',
          tags: ['games'],
        }),
      })

      const doggyVisibleMemoryIds = database
        .listAccessibleMemories(memoryRequest(DOGGY_PERSON_ID, doggyDirectId))
        .map(item => item.id)
      expect(doggyMemory.status).toBe('active')
      expect(moussyMemory.status).toBe('active')
      expect(doggyVisibleMemoryIds).toContain(doggyMemory.id)
      expect(doggyVisibleMemoryIds).not.toContain(moussyMemory.id)
    }
    finally {
      database.close()
    }
  })

  /** @example Erasing Doggy cognition leaves Moussy cognition and both timelines intact. */
  it('atomically deletes only the requested actor cognitive data', () => {
    const database = LumiServerDatabase.open(':memory:')
    try {
      const actors = [
        { actorId: DOGGY_PERSON_ID, conversationId: doggyDirectId },
        { actorId: MOUSSY_PERSON_ID, conversationId: moussyDirectId },
      ]
      const memories = actors.map(({ actorId, conversationId }, index) => {
        const messageId = `cognitive-erasure-${index}`
        const content = `${actorId} private cognitive material`
        database.acceptUserMessage({
          conversationId,
          actorPersonId: actorId,
          messageId,
          idempotencyKey: messageId,
          content,
          createdAt: Date.parse('2026-07-29T12:00:00.000Z') + index,
        })
        const identity = cognitiveIdentity(actorId, conversationId)
        database.commitCognitiveFastLoop({
          identity,
          evidence: cognitiveEvidence(messageId, content, {
            id: `evidence:message:${conversationId}:${messageId}`,
            actorId,
            subjectUserIds: [actorId],
            conversationId,
            participantUserIds: [actorId],
          }),
          feedback: [],
          workingMemory: createLumiWorkingMemory({
            personId: actorId,
            personaId: identity.personaId,
            conversationId,
            conversationType: 'direct',
            now: '2026-07-29T12:00:00.000Z',
          }),
        })
        database.writePersonState({
          personId: actorId,
          kind: 'relationship',
          payload: { trust: index + 1 },
        })
        const memory = database.storeMemoryCandidate({
          actorPersonId: actorId,
          conversationId,
          candidate: memoryCandidate({ content, sourceMessageId: messageId }),
        })
        database.upsertMemoryVector({
          memoryId: memory.id,
          model: 'test-model',
          dimensions: 2,
          vector: [1, index],
          contentDigest: `digest-${index}`,
          updatedAt: Date.now(),
        })
        return memory
      })

      const report = database.deleteCognitiveActorData(DOGGY_PERSON_ID)
      const backup = database.exportBackup()

      expect(report).toMatchObject({
        actorPersonId: DOGGY_PERSON_ID,
        evidenceCount: 1,
        workingMemoryCount: 1,
        memoryCount: 1,
        memoryVectorCount: 1,
        personStateCount: 1,
      })
      expect(backup.sections.cognitiveEvidence?.some(row => row.actor_id === DOGGY_PERSON_ID)).toBe(false)
      expect(backup.sections.cognitiveWorkingMemory?.some(row => row.person_id === DOGGY_PERSON_ID)).toBe(false)
      expect(backup.sections.memories.some(row => row.user_id === DOGGY_PERSON_ID)).toBe(false)
      expect(backup.sections.memoryVectors.some(row => row.memory_id === memories[0].id)).toBe(false)
      expect(backup.sections.personStates.some(row => row.person_id === DOGGY_PERSON_ID)).toBe(false)
      expect(backup.sections.cognitiveEvidence?.some(row => row.actor_id === MOUSSY_PERSON_ID)).toBe(true)
      expect(backup.sections.cognitiveWorkingMemory?.some(row => row.person_id === MOUSSY_PERSON_ID)).toBe(true)
      expect(backup.sections.memories.some(row => row.id === memories[1].id)).toBe(true)
      expect(backup.sections.memoryVectors.some(row => row.memory_id === memories[1].id)).toBe(true)
      expect(backup.sections.personStates.some(row => row.person_id === MOUSSY_PERSON_ID)).toBe(true)
      expect(database.replay(doggyDirectId, DOGGY_PERSON_ID, 0).messages).toHaveLength(1)
      expect(database.replay(moussyDirectId, MOUSSY_PERSON_ID, 0).messages).toHaveLength(1)
    }
    finally {
      database.close()
    }
  })
})
