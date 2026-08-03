import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { createContext, defineInvoke } from '@moeru/eventa'
import { describe, expect, it, vi } from 'vitest'

import {
  electronLumiMemoryGetSnapshot,
  electronLumiMemoryGetVectors,
  electronLumiMemoryReplaceSnapshot,
  electronLumiMemoryVectorStatus,
} from '../../../../shared/eventa'
import { createLumiMemoryService } from './index'

const appMock = vi.hoisted(() => ({
  getPath: vi.fn(),
}))

vi.mock('electron', () => ({
  app: appMock,
}))

const actorId = 'lumi-user-00000000-0000-4000-8000-000000000001'
const embeddingModel = 'BAAI/bge-small-zh-v1.5'

function createLegacyDatabase(path: string) {
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE lumi_memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      conversation_id TEXT,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      source_message_id TEXT,
      confidence REAL NOT NULL,
      importance REAL NOT NULL,
      emotional_intensity REAL NOT NULL,
      relationship_relevance REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_used_at TEXT,
      decay REAL NOT NULL,
      tags_json TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE lumi_memory_vectors (
      memory_id TEXT NOT NULL,
      model TEXT NOT NULL,
      signature TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      device TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(memory_id, model)
    );
  `)
  const updatedAt = '2026-07-29T00:00:00.000Z'
  const content = '旧向量应直接迁移签名，不重新生成 embedding。'
  const source = [updatedAt, 'user_fact', 'active', 'migration', content].join('\u001E')
  db.prepare(`
    INSERT INTO lumi_memories (
      id, user_id, persona_id, conversation_id, type, content, source_message_id,
      confidence, importance, emotional_intensity, relationship_relevance,
      created_at, updated_at, last_used_at, decay, tags_json, status
    ) VALUES (?, ?, 'lumi', 'direct:migration', 'user_fact', ?, 'message:legacy',
      0.9, 0.8, 0.1, 0.7, ?, ?, NULL, 0, '["migration"]', 'active')
  `).run('memory:legacy', actorId, content, updatedAt, updatedAt)
  db.prepare(`
    INSERT INTO lumi_memory_vectors (memory_id, model, signature, vector_json, device, updated_at)
    VALUES ('memory:legacy', ?, ?, '[1,0,0]', 'cpu', ?)
  `).run(embeddingModel, source, updatedAt)
  db.close()
  return createHash('sha256').update(source).digest('hex')
}

describe('desktop Lumi memory database migration', () => {
  it('migrates legacy vector signatures and persists the complete memory schema', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'lumi-memory-test-'))
    const databasePath = join(userData, 'lumi-memory.sqlite3')
    const expectedSignature = createLegacyDatabase(databasePath)
    appMock.getPath.mockImplementation(name => name === 'userData' ? userData : userData)

    const context = createContext()
    createLumiMemoryService({ context: context as never })
    const getSnapshot = defineInvoke(context, electronLumiMemoryGetSnapshot)
    const getVectors = defineInvoke(context, electronLumiMemoryGetVectors)
    const getVectorStatus = defineInvoke(context, electronLumiMemoryVectorStatus)
    const replaceSnapshot = defineInvoke(context, electronLumiMemoryReplaceSnapshot)

    const migratedVectors = await getVectors({ model: embeddingModel, userId: actorId })
    expect(migratedVectors).toHaveLength(1)
    expect(migratedVectors[0]?.signature).toBe(expectedSignature)

    const migratedStatus = await getVectorStatus({ userId: actorId })
    expect(migratedStatus.totalCount).toBe(1)
    expect(migratedStatus.indexedCount).toBe(1)
    expect(migratedStatus.missingCount).toBe(0)

    const snapshot = await getSnapshot({ userId: actorId })
    const replacement = {
      ...snapshot,
      fragments: [{
        ...snapshot.fragments[0]!,
        id: 'memory:replacement',
        content: '完整字段写入需要在真实 SQLite 中通过。',
        updatedAt: '2026-07-29T01:00:00.000Z',
        derivedFromEvidenceIds: ['evidence:1'],
        contradictsIds: ['memory:old'],
        evidenceOrigin: 'user_statement' as const,
      }],
      events: [],
    }
    const replaced = await replaceSnapshot({ userId: actorId, snapshot: replacement })
    expect(replaced.fragments).toHaveLength(1)
    expect(replaced.fragments[0]?.id).toBe('memory:replacement')
    expect(replaced.fragments[0]?.derivedFromEvidenceIds).toEqual(['evidence:1'])
    expect(replaced.fragments[0]?.contradictsIds).toEqual(['memory:old'])

    const replacementStatus = await getVectorStatus({ userId: actorId })
    expect(replacementStatus.totalCount).toBe(1)
    expect(replacementStatus.indexedCount).toBe(0)
    expect(replacementStatus.missingCount).toBe(1)
  })
})
