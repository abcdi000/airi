import type {
  LumiBeliefHypothesis,
  LumiCognitiveProfileProjection,
  LumiMemoryFragment,
} from '@proj-airi/lumi-runtime'

import type { SqliteDatabase } from './index'

import { DatabaseSync } from 'node:sqlite'

import { createContext, defineInvoke } from '@moeru/eventa'
import { migrateSocialLanguageSnapshot } from '@proj-airi/lumi-runtime'
import { describe, expect, it, vi } from 'vitest'

import {
  electronLumiCognitiveConsolidateEpisode,
  electronLumiCognitiveLoadWorkingMemory,
  electronLumiCognitivePrepareTurn,
  electronLumiCognitiveRecordUse,
} from '../../../../shared/eventa'
import {
  consolidateMemoryIntoCognition,
  createLumiDesktopCognitiveService,
  deleteCognitiveActorData,
  exportCognitiveActorData,
  importCognitiveActorData,
  runDesktopCognitiveMaintenance,
} from './cognitive'

const identity = {
  actorId: 'lumi-user-doggy-test',
  personaId: 'lumi',
  conversationId: 'direct:doggy',
  conversationType: 'direct' as const,
  participantUserIds: ['lumi-user-doggy-test'],
}

const moussyIdentity = {
  actorId: 'lumi-user-moussy-test',
  personaId: 'lumi',
  conversationId: 'direct:moussy',
  conversationType: 'direct' as const,
  participantUserIds: ['lumi-user-moussy-test'],
}

function memory(id: string, patch: Partial<LumiMemoryFragment> = {}): LumiMemoryFragment {
  const now = new Date().toISOString()
  return {
    id,
    userId: identity.actorId,
    personaId: identity.personaId,
    conversationId: identity.conversationId,
    sourceMessageId: 'message:1',
    type: 'user_preference',
    content: '浏览器自动化默认使用 Patchright，特殊情况才使用 Playwright。',
    confidence: 0.9,
    importance: 0.8,
    emotionalIntensity: 0,
    relationshipRelevance: 0.5,
    createdAt: now,
    updatedAt: now,
    decay: 0,
    tags: ['browser'],
    status: 'active',
    scope: 'private',
    ownerType: 'user',
    ownerId: identity.actorId,
    visibility: 'private',
    participantUserIds: [identity.actorId],
    subjectUserIds: [identity.actorId],
    sensitivity: 'private',
    sourceActorId: identity.actorId,
    sourceConversationType: 'direct',
    ...patch,
  }
}

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE lumi_memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      scope TEXT NOT NULL,
      last_used_at TEXT,
      updated_at TEXT NOT NULL DEFAULT ''
    );
  `)
  return db
}

function persistTestMemory(db: SqliteDatabase, value: LumiMemoryFragment): void {
  db.prepare(`
    INSERT INTO lumi_memories (id, user_id, status, scope, last_used_at, updated_at)
    VALUES (?, ?, ?, ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      status = excluded.status,
      scope = excluded.scope,
      updated_at = excluded.updated_at
  `).run(value.id, value.userId, value.status, value.scope ?? 'relationship', value.updatedAt)
}

describe('desktop cognitive service', () => {
  it('persists evidence, reuses low-information recall, and records actual Planner use', async () => {
    const db = database()
    const context = createContext()
    const recalledMemory = memory('memory:patchright')
    const recall = vi.fn(async () => ({
      memories: [recalledMemory],
      trace: {
        ran: true,
        reusedPreviousState: false,
        aclInputCount: 1,
        aclOutputCount: 1,
        lexicalCandidateCount: 1,
        annCandidateCount: 1,
        mergedCandidateCount: 1,
        rerankedCandidateCount: 1,
        thresholdRejectedCount: 0,
        conflictRejectedCount: 0,
        injectedCount: 1,
        durationMs: 2,
      },
    }))
    const loadMemoriesByIds = vi.fn(async () => [recalledMemory])
    createLumiDesktopCognitiveService({
      context: context as never,
      getDatabase: async () => ({ db: db as SqliteDatabase }),
      persistMemory: persistTestMemory,
      recall,
      loadMemoriesByIds,
      getSocialLanguageSnapshot: async () => migrateSocialLanguageSnapshot({}),
      loadLegacyProfile: async () => [{
        id: 'profile:communication',
        layer: 'dynamic',
        key: 'communication_preference',
        value: '回复简短自然',
        confidence: 0.9,
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
      loadLegacyCurrentState: async () => ({
        recentTopics: ['浏览器自动化'],
        userRecentMood: '',
        recentImportantDecisions: [],
        activeProjects: [],
        unfinishedTasks: [],
        relationshipContext: '',
        lastContinuationPoint: '',
        sourceMessageIds: ['legacy:message'],
        updatedAt: new Date().toISOString(),
      }),
    })
    const consolidateEpisode = defineInvoke(context, electronLumiCognitiveConsolidateEpisode)
    const loadWorkingMemory = defineInvoke(context, electronLumiCognitiveLoadWorkingMemory)
    const prepareTurn = defineInvoke(context, electronLumiCognitivePrepareTurn)
    const recordUse = defineInvoke(context, electronLumiCognitiveRecordUse)

    const first = await prepareTurn({
      identity,
      sourceMessageId: 'message:1',
      userText: '默认用 Patchright，特殊情况用 Playwright。',
      recentTurns: [{
        id: 'message:1',
        role: 'user',
        content: '默认用 Patchright，特殊情况用 Playwright。',
      }],
      platform: 'lumi-desktop',
    })
    const second = await prepareTurn({
      identity,
      sourceMessageId: 'message:2',
      userText: '对',
      recentTurns: [
        {
          id: 'message:1',
          role: 'user',
          content: '默认用 Patchright，特殊情况用 Playwright。',
        },
        {
          id: 'reply:1',
          role: 'assistant',
          content: '你是说默认用 Patchright，特殊情况才用 Playwright吗？',
        },
        {
          id: 'message:2',
          role: 'user',
          content: '对',
        },
      ],
      platform: 'lumi-desktop',
    })

    expect(first.stableFacts.map(item => item.id)).toEqual(['memory:patchright'])
    expect(first.workingMemory.activeTopics.some(item => item.value === '浏览器自动化')).toBe(true)
    expect(first.userProfileProjection.communicationPreferences.map(item => item.value)).toEqual(['回复简短自然'])
    expect(second.recallTrace.reusedPreviousState).toBe(true)
    expect(recall).toHaveBeenCalledTimes(1)
    expect(loadMemoriesByIds).toHaveBeenCalledTimes(1)
    expect(second.workingMemory.continuationPoint).toContain('Patchright')
    expect(await loadWorkingMemory({ identity })).toEqual(second.workingMemory)
    expect(await loadWorkingMemory({ identity: moussyIdentity })).toMatchObject({
      personId: moussyIdentity.actorId,
      conversationId: moussyIdentity.conversationId,
    })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM lumi_cognitive_evidence WHERE origin = 'primary'`).get()?.count).toBe(2)
    expect(db.prepare(`SELECT phase FROM lumi_cognitive_migrations WHERE source_kind = 'legacy_desktop_cognition'`).get()?.phase).toBe('active')

    const episodeInput = {
      identity,
      episodeId: 'dialogue:1:summary:1',
      summary: 'Doggy and Lumi confirmed the Patchright default and kept the browser decision.',
      sourceMessageIds: ['message:1', 'reply:1', 'message:2'],
      occurredAt: '2026-07-29T08:05:00.000Z',
    }
    await consolidateEpisode(episodeInput)
    await consolidateEpisode(episodeInput)
    const episodeEvidence = db.prepare(`
      SELECT * FROM lumi_cognitive_evidence WHERE kind = 'conversation_episode'
    `).get()
    expect(episodeEvidence).toMatchObject({
      origin: 'derived',
      author_verified: 0,
      scope: 'private',
      sensitivity: 'private',
    })
    expect(JSON.parse(String(episodeEvidence?.derived_from_evidence_ids_json))).toHaveLength(2)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM lumi_memories
      WHERE user_id = ? AND scope = 'private'
    `).get(identity.actorId)?.count).toBe(1)

    db.prepare(`
      INSERT INTO lumi_memories (id, user_id, status, scope, last_used_at, use_count)
      VALUES (?, ?, 'active', 'private', NULL, 0)
    `).run(recalledMemory.id, identity.actorId)
    const usedAt = new Date().toISOString()
    await recordUse({
      identity,
      memoryIds: [recalledMemory.id],
      hypothesisIds: [],
      usedAt,
    })
    const usage = db.prepare('SELECT last_used_at, use_count FROM lumi_memories WHERE id = ?').get(recalledMemory.id)
    expect(usage?.last_used_at).toBe(usedAt)
    expect(usage?.use_count).toBe(1)
  })

  it('rejects a mutable or incomplete identity before writing evidence', async () => {
    const db = database()
    const context = createContext()
    createLumiDesktopCognitiveService({
      context: context as never,
      getDatabase: async () => ({ db: db as SqliteDatabase }),
      persistMemory: persistTestMemory,
      recall: async () => ({
        memories: [],
        trace: {
          ran: true,
          reusedPreviousState: false,
          aclInputCount: 0,
          aclOutputCount: 0,
          lexicalCandidateCount: 0,
          annCandidateCount: 0,
          mergedCandidateCount: 0,
          rerankedCandidateCount: 0,
          thresholdRejectedCount: 0,
          conflictRejectedCount: 0,
          injectedCount: 0,
          durationMs: 0,
        },
      }),
      loadMemoriesByIds: async () => [],
      getSocialLanguageSnapshot: async () => migrateSocialLanguageSnapshot({}),
    })
    const prepareTurn = defineInvoke(context, electronLumiCognitivePrepareTurn)

    await expect(prepareTurn({
      identity: {
        ...identity,
        participantUserIds: [],
      },
      sourceMessageId: 'message:invalid',
      userText: '测试',
      recentTurns: [],
      platform: 'lumi-desktop',
    })).rejects.toThrow('Desktop cognitive identity is invalid')
    expect(db.prepare('SELECT COUNT(*) AS count FROM lumi_cognitive_evidence').get()?.count).toBe(0)
  })

  it('consolidates curated memory and supersedes the old value after an explicit correction', async () => {
    const db = database()
    const context = createContext()
    createLumiDesktopCognitiveService({
      context: context as never,
      getDatabase: async () => ({ db: db as SqliteDatabase }),
      persistMemory: persistTestMemory,
      recall: async () => ({
        memories: [],
        trace: {
          ran: true,
          reusedPreviousState: false,
          aclInputCount: 0,
          aclOutputCount: 0,
          lexicalCandidateCount: 0,
          annCandidateCount: 0,
          mergedCandidateCount: 0,
          rerankedCandidateCount: 0,
          thresholdRejectedCount: 0,
          conflictRejectedCount: 0,
          injectedCount: 0,
          durationMs: 0,
        },
      }),
      loadMemoriesByIds: async () => [],
      getSocialLanguageSnapshot: async () => migrateSocialLanguageSnapshot({}),
    })
    const prepareTurn = defineInvoke(context, electronLumiCognitivePrepareTurn)
    await prepareTurn({
      identity,
      sourceMessageId: 'message:preference-old',
      userText: '我喜欢简短自然的回复。',
      recentTurns: [{
        id: 'message:preference-old',
        role: 'user',
        content: '我喜欢简短自然的回复。',
      }],
      platform: 'lumi-desktop',
    })
    const oldMemory = memory('memory:preference-old', {
      sourceMessageId: 'message:preference-old',
      content: 'Doggy 喜欢简短自然的回复。',
      tags: ['communication'],
    })
    db.prepare(`
      INSERT INTO lumi_memories (id, user_id, status, scope, last_used_at, updated_at)
      VALUES (?, ?, 'active', 'private', NULL, ?)
    `).run(oldMemory.id, identity.actorId, oldMemory.updatedAt)
    const first = consolidateMemoryIntoCognition(db as SqliteDatabase, oldMemory)

    await prepareTurn({
      identity,
      sourceMessageId: 'message:preference-correction',
      userText: '纠正一下，我现在需要详细解释。',
      recentTurns: [{
        id: 'message:preference-correction',
        role: 'user',
        content: '纠正一下，我现在需要详细解释。',
      }],
      platform: 'lumi-desktop',
    })
    const correctedMemory = memory('memory:preference-correction', {
      sourceMessageId: 'message:preference-correction',
      content: 'Doggy 现在需要详细解释。',
      tags: ['communication'],
      status: 'candidate',
    })
    db.prepare(`
      INSERT INTO lumi_memories (id, user_id, status, scope, last_used_at, updated_at)
      VALUES (?, ?, 'candidate', 'private', NULL, ?)
    `).run(correctedMemory.id, identity.actorId, correctedMemory.updatedAt)
    const corrected = consolidateMemoryIntoCognition(db as SqliteDatabase, correctedMemory)
    if (!first.beliefId || !correctedMemory.sourceMessageId)
      throw new Error('Expected the tested memory to retain cognitive lineage')

    const beliefRow = db.prepare('SELECT payload_json FROM lumi_cognitive_beliefs WHERE id = ?').get(first.beliefId)
    const belief = JSON.parse(String(beliefRow?.payload_json))
    const correctionEvidenceRow = db.prepare(`
      SELECT kind, origin, trust, author_verified FROM lumi_cognitive_evidence
      WHERE source_message_id = ?
    `).get(correctedMemory.sourceMessageId)
    expect(first.consolidated).toBe(true)
    expect(corrected.consolidated).toBe(true)
    expect(belief.status).toBe('supported')
    expect(correctionEvidenceRow).toMatchObject({
      kind: 'user_correction',
      origin: 'primary',
      trust: 1,
      author_verified: 1,
    })
    expect(corrected.projectionIds).toEqual([`profile:${corrected.beliefId}:dynamic`])
    expect(corrected.supersededMemoryIds).toEqual([oldMemory.id])

    const oldRow = db.prepare('SELECT status, superseded_by_id FROM lumi_memories WHERE id = ?').get(oldMemory.id)
    const correctedRow = db.prepare('SELECT status, supersedes_id, evidence_origin FROM lumi_memories WHERE id = ?').get(correctedMemory.id)
    const projectionRow = db.prepare(`
      SELECT status, payload_json FROM lumi_cognitive_profile_projections
      WHERE subject_id = ? ORDER BY updated_at DESC LIMIT 1
    `).get(identity.actorId)
    const projection = JSON.parse(String(projectionRow?.payload_json))

    expect(belief.value).toBe('Doggy 现在需要详细解释。')
    expect(belief.status).toBe('supported')
    expect(belief.evidenceIds).toEqual(['evidence:message:direct:doggy:message:preference-correction'])
    expect(belief.counterEvidenceIds).toEqual(['evidence:message:direct:doggy:message:preference-old'])
    expect(oldRow?.status).toBe('contradicted')
    expect(oldRow?.superseded_by_id).toBe(correctedMemory.id)
    expect(correctedRow?.status).toBe('active')
    expect(correctedRow?.supersedes_id).toBe(oldMemory.id)
    expect(correctedRow?.evidence_origin).toBe('derived')
    expect(projectionRow?.status).toBe('pending')
    expect(projection.value).toBe('Doggy 现在需要详细解释。')
  })

  it('deletes only the requested actor cognitive state', async () => {
    const db = database()
    const context = createContext()
    createLumiDesktopCognitiveService({
      context: context as never,
      getDatabase: async () => ({ db: db as SqliteDatabase }),
      persistMemory: persistTestMemory,
      recall: async () => ({
        memories: [],
        trace: {
          ran: true,
          reusedPreviousState: false,
          aclInputCount: 0,
          aclOutputCount: 0,
          lexicalCandidateCount: 0,
          annCandidateCount: 0,
          mergedCandidateCount: 0,
          rerankedCandidateCount: 0,
          thresholdRejectedCount: 0,
          conflictRejectedCount: 0,
          injectedCount: 0,
          durationMs: 0,
        },
      }),
      loadMemoriesByIds: async () => [],
      getSocialLanguageSnapshot: async () => migrateSocialLanguageSnapshot({}),
    })
    const prepareTurn = defineInvoke(context, electronLumiCognitivePrepareTurn)
    for (const actorIdentity of [identity, moussyIdentity]) {
      await prepareTurn({
        identity: actorIdentity,
        sourceMessageId: `message:${actorIdentity.actorId}`,
        userText: '这是一条私聊状态。',
        recentTurns: [],
        platform: 'lumi-desktop',
      })
    }

    deleteCognitiveActorData(db as SqliteDatabase, identity.actorId)

    expect(db.prepare('SELECT COUNT(*) AS count FROM lumi_cognitive_evidence WHERE actor_id = ?').get(identity.actorId)?.count).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS count FROM lumi_cognitive_working_memory WHERE person_id = ?').get(identity.actorId)?.count).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS count FROM lumi_cognitive_evidence WHERE actor_id = ?').get(moussyIdentity.actorId)?.count).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM lumi_cognitive_working_memory WHERE person_id = ?').get(moussyIdentity.actorId)?.count).toBe(1)
  })

  it('round-trips actor cognitive lineage without including another actor', async () => {
    const db = database()
    const context = createContext()
    createLumiDesktopCognitiveService({
      context: context as never,
      getDatabase: async () => ({ db: db as SqliteDatabase }),
      persistMemory: persistTestMemory,
      recall: async () => ({
        memories: [],
        trace: {
          ran: true,
          reusedPreviousState: false,
          aclInputCount: 0,
          aclOutputCount: 0,
          lexicalCandidateCount: 0,
          annCandidateCount: 0,
          mergedCandidateCount: 0,
          rerankedCandidateCount: 0,
          thresholdRejectedCount: 0,
          conflictRejectedCount: 0,
          injectedCount: 0,
          durationMs: 0,
        },
      }),
      loadMemoriesByIds: async () => [],
      getSocialLanguageSnapshot: async () => migrateSocialLanguageSnapshot({}),
    })
    const prepareTurn = defineInvoke(context, electronLumiCognitivePrepareTurn)
    for (const actorIdentity of [identity, moussyIdentity]) {
      await prepareTurn({
        identity: actorIdentity,
        sourceMessageId: `message:archive:${actorIdentity.actorId}`,
        userText: '我喜欢有证据来源的回答。',
        recentTurns: [],
        platform: 'lumi-desktop',
      })
    }
    const archivedMemory = memory('memory:archive', {
      sourceMessageId: `message:archive:${identity.actorId}`,
      content: 'Doggy 喜欢有证据来源的回答。',
      tags: ['evidence-backed-reply'],
    })
    db.prepare(`
      INSERT INTO lumi_memories (id, user_id, status, scope, last_used_at, updated_at)
      VALUES (?, ?, 'active', 'private', NULL, ?)
    `).run(archivedMemory.id, identity.actorId, archivedMemory.updatedAt)
    consolidateMemoryIntoCognition(db as SqliteDatabase, archivedMemory)
    const archive = exportCognitiveActorData(db as SqliteDatabase, identity.actorId)

    deleteCognitiveActorData(db as SqliteDatabase, identity.actorId)
    importCognitiveActorData(db as SqliteDatabase, identity.actorId, archive)

    expect(archive.version).toBe(1)
    expect(archive.evidence).toHaveLength(1)
    expect(archive.workingMemory).toHaveLength(1)
    expect(archive.beliefs).toHaveLength(1)
    expect(archive.evidence.every(row => row.actor_id === identity.actorId)).toBe(true)
    expect(db.prepare('SELECT COUNT(*) AS count FROM lumi_cognitive_evidence WHERE actor_id = ?').get(identity.actorId)?.count).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM lumi_cognitive_beliefs WHERE subject_id = ?').get(identity.actorId)?.count).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM lumi_cognitive_evidence WHERE actor_id = ?').get(moussyIdentity.actorId)?.count).toBe(1)
  })

  /** @example Daily maintenance expires Doggy state without touching Moussy state. */
  it('maintains only the requested actor and removes expired working memory', async () => {
    const db = database()
    const context = createContext()
    createLumiDesktopCognitiveService({
      context: context as never,
      getDatabase: async () => ({ db: db as SqliteDatabase }),
      persistMemory: persistTestMemory,
      recall: async () => ({
        memories: [],
        trace: {
          ran: true,
          reusedPreviousState: false,
          aclInputCount: 0,
          aclOutputCount: 0,
          lexicalCandidateCount: 0,
          annCandidateCount: 0,
          mergedCandidateCount: 0,
          rerankedCandidateCount: 0,
          thresholdRejectedCount: 0,
          conflictRejectedCount: 0,
          injectedCount: 0,
          durationMs: 0,
        },
      }),
      loadMemoriesByIds: async () => [],
      getSocialLanguageSnapshot: async () => migrateSocialLanguageSnapshot({}),
    })
    const prepareTurn = defineInvoke(context, electronLumiCognitivePrepareTurn)
    for (const actorIdentity of [identity, moussyIdentity]) {
      await prepareTurn({
        identity: actorIdentity,
        sourceMessageId: `message:maintenance:${actorIdentity.actorId}`,
        userText: '最近在测试认知维护。',
        recentTurns: [],
        platform: 'lumi-desktop',
      })
    }

    const belief = (actorId: string, expiresAt: string): LumiBeliefHypothesis => ({
      id: `belief:${actorId}`,
      subjectId: actorId,
      predicate: 'current_focus',
      value: '认知维护',
      confidence: 0.9,
      stability: 0.9,
      evidenceCount: 1,
      independentEvidenceCount: 1,
      familiarity: 0.5,
      ownership: 0,
      positiveFeedback: 0,
      negativeFeedback: 0,
      rejectionCount: 0,
      firstSeenAt: '2026-07-01T00:00:00.000Z',
      lastSeenAt: '2026-07-01T00:00:00.000Z',
      decay: 0,
      evidenceIds: [`evidence:message:${actorId === identity.actorId ? identity.conversationId : moussyIdentity.conversationId}:message:maintenance:${actorId}`],
      counterEvidenceIds: [],
      firstObservedAt: '2026-07-01T00:00:00.000Z',
      lastObservedAt: '2026-07-01T00:00:00.000Z',
      expiresAt,
      status: 'stable',
      scope: 'private',
      sensitivity: 'private',
      conversationId: actorId === identity.actorId ? identity.conversationId : moussyIdentity.conversationId,
      participantUserIds: [actorId],
    })
    const doggyBelief = belief(identity.actorId, '2026-07-02T00:00:00.000Z')
    const moussyBelief = belief(moussyIdentity.actorId, '2027-07-02T00:00:00.000Z')
    const doggyProjection: LumiCognitiveProfileProjection = {
      id: `profile:${doggyBelief.id}:daily`,
      subjectId: identity.actorId,
      layer: 'daily',
      key: doggyBelief.predicate,
      value: String(doggyBelief.value),
      beliefIds: [doggyBelief.id],
      evidenceIds: [...doggyBelief.evidenceIds],
      confidence: doggyBelief.confidence,
      stability: doggyBelief.stability,
      expiresAt: doggyBelief.expiresAt,
      status: 'active',
      scope: 'private',
      sensitivity: 'private',
      updatedAt: doggyBelief.lastObservedAt,
    }
    const insertBelief = db.prepare(`
      INSERT INTO lumi_cognitive_beliefs (id, subject_id, conversation_id, status, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const item of [doggyBelief, moussyBelief]) {
      insertBelief.run(
        item.id,
        item.subjectId,
        item.conversationId ?? null,
        item.status,
        JSON.stringify(item),
        item.lastObservedAt,
      )
    }
    db.prepare(`
      INSERT INTO lumi_cognitive_profile_projections
        (id, subject_id, layer, status, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      doggyProjection.id,
      doggyProjection.subjectId,
      doggyProjection.layer,
      doggyProjection.status,
      JSON.stringify(doggyProjection),
      doggyProjection.updatedAt,
    )
    db.prepare(`
      UPDATE lumi_cognitive_working_memory SET expires_at = ? WHERE person_id = ?
    `).run('2026-07-02T00:00:00.000Z', identity.actorId)

    const report = runDesktopCognitiveMaintenance(db as SqliteDatabase, {
      actorId: identity.actorId,
      now: '2026-07-29T00:00:00.000Z',
    })
    const maintainedDoggy = JSON.parse(String(db.prepare(`
      SELECT payload_json FROM lumi_cognitive_beliefs WHERE id = ?
    `).get(doggyBelief.id)?.payload_json)) as LumiBeliefHypothesis
    const untouchedMoussy = JSON.parse(String(db.prepare(`
      SELECT payload_json FROM lumi_cognitive_beliefs WHERE id = ?
    `).get(moussyBelief.id)?.payload_json)) as LumiBeliefHypothesis

    expect(report).toMatchObject({
      actorCount: 1,
      beliefCount: 1,
      expiredCount: 1,
      projectionCount: 0,
      expiredWorkingMemoryCount: 1,
    })
    expect(maintainedDoggy.status).toBe('expired')
    expect(untouchedMoussy.status).toBe('stable')
    expect(db.prepare(`
      SELECT status FROM lumi_cognitive_profile_projections WHERE id = ?
    `).get(doggyProjection.id)?.status).toBe('pending')
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM lumi_cognitive_working_memory WHERE person_id = ?
    `).get(identity.actorId)?.count).toBe(0)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM lumi_cognitive_working_memory WHERE person_id = ?
    `).get(moussyIdentity.actorId)?.count).toBe(1)
  })
})
