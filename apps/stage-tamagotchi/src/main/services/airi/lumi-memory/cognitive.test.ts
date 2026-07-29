import type { LumiMemoryFragment } from '@proj-airi/lumi-runtime'

import type { SqliteDatabase } from './index'

import { DatabaseSync } from 'node:sqlite'

import { createContext, defineInvoke } from '@moeru/eventa'
import { migrateSocialLanguageSnapshot } from '@proj-airi/lumi-runtime'
import { describe, expect, it, vi } from 'vitest'

import {
  electronLumiCognitivePrepareTurn,
  electronLumiCognitiveRecordUse,
} from '../../../../shared/eventa'
import { createLumiDesktopCognitiveService } from './cognitive'

const identity = {
  actorId: 'lumi-user-doggy-test',
  personaId: 'lumi',
  conversationId: 'direct:doggy',
  conversationType: 'direct' as const,
  participantUserIds: ['lumi-user-doggy-test'],
}

function memory(id: string): LumiMemoryFragment {
  const now = new Date().toISOString()
  return {
    id,
    userId: identity.actorId,
    personaId: identity.personaId,
    conversationId: identity.conversationId,
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
      last_used_at TEXT
    );
  `)
  return db
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
    expect(db.prepare(`SELECT COUNT(*) AS count FROM lumi_cognitive_evidence WHERE origin = 'primary'`).get()?.count).toBe(2)
    expect(db.prepare(`SELECT phase FROM lumi_cognitive_migrations WHERE source_kind = 'legacy_desktop_cognition'`).get()?.phase).toBe('active')

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
})
