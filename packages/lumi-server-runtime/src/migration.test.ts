import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DOGGY_PERSON_ID, LumiServerDatabase, MOUSSY_PERSON_ID } from './database'
import { createLumiClientMigrationPackage, LumiServerMigrationService } from './migration'

function userData(userId: string, displayName: string) {
  const updatedAt = '2026-07-21T00:00:00.000Z'
  const content = `${displayName} likes testing migrations.`
  return {
    chatSessions: {
      format: 'chat-sessions-index:v1',
      index: { userId, characters: {} },
      sessions: {
        [`session-${userId}`]: {
          meta: {
            sessionId: `session-${userId}`,
            userId,
            characterId: 'lumi',
            conversationType: 'direct',
            participantUserIds: [userId],
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
          },
          messages: [{
            id: `message-${userId}`,
            role: 'user',
            actorId: userId,
            actorDisplayName: displayName,
            content: `Hello from ${displayName}`,
            createdAt: 1_700_000_000_000,
          }],
        },
      },
    },
    lumiMemory: {
      fragments: [{
        id: `memory-${userId}`,
        userId,
        personaId: 'lumi',
        type: 'user_fact',
        content,
        confidence: 1,
        importance: 0.8,
        emotionalIntensity: 0.2,
        relationshipRelevance: 0.8,
        decay: 0.1,
        tags: [],
        status: 'active',
        conversationId: `legacy-session-${userId}`,
        sourceConversationType: 'direct',
        createdAt: '2026-07-21T00:00:00.000Z',
        updatedAt,
      }],
      events: [],
      seedId: 'seed',
      vectors: [{
        memoryId: `memory-${userId}`,
        model: 'BAAI/bge-small-zh-v1.5',
        signature: userId === DOGGY_PERSON_ID
          ? [updatedAt, 'user_fact', 'active', '', content].join('\u001E')
          : 'tampered-signature',
        vector: [0.6, 0.8],
        device: 'cuda',
        updatedAt,
      }],
    },
    lumiUserProfile: { entries: [], pendingUpdates: [], events: [], autoUpdateEnabled: true, bootstrapVersion: 'v1', exportedAt: '2026-07-21T00:00:00.000Z' },
    lumiCurrentState: { state: { recentTopics: ['migration'] }, updateEveryTurns: 4, exportedAt: '2026-07-21T00:00:00.000Z' },
    lumiEmotion: { snapshot: { relationship: { trust: 0.8 }, mood: { warmth: 0.7 }, dominantEmotion: 'warm', updatedAt: '2026-07-21T00:00:00.000Z' }, seedId: 'seed', exportedAt: '2026-07-21T00:00:00.000Z' },
  }
}

function archive() {
  return {
    format: 'lumi-data-archive:v6',
    version: 6,
    source: 'lumi',
    exportedAt: '2026-07-21T00:00:00.000Z',
    sections: {
      identity: {
        users: [
          { id: DOGGY_PERSON_ID, displayName: 'Doggy', preferredAddress: 'Doggy', role: 'owner', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
          { id: MOUSSY_PERSON_ID, displayName: 'Moussy', preferredAddress: 'Moussy', role: 'member', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
        ],
        externalIdentities: [],
        activeUserId: DOGGY_PERSON_ID,
        migrationVersion: 'v1',
      },
      users: {
        [DOGGY_PERSON_ID]: userData(DOGGY_PERSON_ID, 'Doggy'),
        [MOUSSY_PERSON_ID]: userData(MOUSSY_PERSON_ID, 'Moussy'),
      },
      roomLedgers: {},
      channelDevices: null,
      backgroundEntries: [],
      localStorage: {
        'settings/plugins/lumi-proactive-vision/private-notes': JSON.stringify([{ id: 'note-1', content: 'Lumi private note' }]),
        'settings/plugins/lumi-proactive-vision/autonomous-life': JSON.stringify({ day: 3 }),
      },
    },
  }
}

describe('lumiServerMigrationService', () => {
  it('stages a privacy report and atomically appends a v6 archive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lumi-migration-'))
    const database = LumiServerDatabase.open(':memory:')
    const service = new LumiServerMigrationService(database, directory)
    try {
      const migration = createLumiClientMigrationPackage(archive())
      const report = await service.stage(migration)
      const imported = await service.commit(migration.packageId)

      expect(report.counts.messages).toBe(2)
      expect(report.counts.memoryVectors).toBe(1)
      expect(report.privacy.relationship).toBe(2)
      expect(imported.messages).toBe(2)
      expect(imported.memories).toBe(2)
      expect(imported.memoryVectors).toBe(1)
      expect(imported.privateNotes).toBe(1)
      expect(database.replay(`lumi-direct:${MOUSSY_PERSON_ID}`, MOUSSY_PERSON_ID, 0).messages[0].content).toBe('Hello from Moussy')
      expect(database.exportBackup().sections.memories.map(memory => memory.conversation_id)).toEqual([
        `lumi-direct:${DOGGY_PERSON_ID}`,
        `lumi-direct:${MOUSSY_PERSON_ID}`,
      ])
      expect(database.exportBackup().sections.memoryVectors).toHaveLength(1)
      await expect(service.commit(migration.packageId)).rejects.toThrow('Migration is not staged and validated')
    }
    finally {
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a package changed after its checksum was created', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lumi-migration-tamper-'))
    const database = LumiServerDatabase.open(':memory:')
    try {
      const migration = createLumiClientMigrationPackage(archive())
      migration.payload.diaryEntries.push({ content: 'tampered' })
      await expect(new LumiServerMigrationService(database, directory).stage(migration)).rejects.toThrow('checksum mismatch')
    }
    finally {
      database.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
