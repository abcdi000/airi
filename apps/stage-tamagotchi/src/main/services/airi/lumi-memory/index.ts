import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type {
  LumiCognitiveIdentity,
  LumiMemoryFragment,
  LumiMemorySearchRequest,
  LumiMemoryStatus,
  LumiMemoryType,
  LumiRecallTrace,
} from '@proj-airi/lumi-runtime'

import type { ElectronLumiMemorySnapshot, ElectronLumiMemoryVectorRecord, ElectronLumiMemoryVectorSearchResult, ElectronLumiMemoryVectorStatus, ElectronLumiSocialLanguageSnapshot } from '../../../../shared/eventa'

import process from 'node:process'

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { defineInvokeHandler } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import {
  canAccessLumiMemory,
  migrateSocialLanguageSnapshot,
} from '@proj-airi/lumi-runtime'
import { app } from 'electron'

import {
  electronLumiMemoryBackfillVectors,
  electronLumiMemoryClear,
  electronLumiMemoryDeleteMemory,
  electronLumiMemoryDeleteVector,
  electronLumiMemoryGetSnapshot,
  electronLumiMemoryGetVectors,
  electronLumiMemoryReplaceSnapshot,
  electronLumiMemorySaveEvent,
  electronLumiMemorySearchVectors,
  electronLumiMemorySetSeedId,

  electronLumiMemorySyncVector,
  electronLumiMemoryUpsertMemory,
  electronLumiMemoryUpsertVector,

  electronLumiMemoryVectorStatus,
  electronLumiSocialLanguageGetSnapshot,
  electronLumiSocialLanguageReplaceSnapshot,

} from '../../../../shared/eventa'
import { loadCurrentStateFromDatabase } from '../lumi-current-state'
import { loadProfileFromDatabase } from '../lumi-user-profile'
import {
  consolidateMemoryIntoCognition,
  createLumiDesktopCognitiveService,
  deleteCognitiveActorData,
  exportCognitiveActorData,
  importCognitiveActorData,
} from './cognitive'

type SqliteValue = string | number | null
const LUMI_MEMORY_EMBEDDING_MODEL = 'BAAI/bge-small-zh-v1.5'
const LUMI_MEMORY_EMBEDDING_BATCH_SIZE = 32
const LUMI_MEMORY_VECTOR_SEARCH_LIMIT = 800
const LUMI_MEMORY_VECTOR_BACKFILL_LIMIT = 2000
const LUMI_MEMORY_VECTOR_REQUEST_TIMEOUT_MS = 1_800_000
const MAIN_MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const LUMI_MEMORY_VECTOR_DEVICE = process.env.LUMI_MEMORY_VECTOR_DEVICE || 'auto'
const DOGGY_USER_ID = 'lumi-user-00000000-0000-4000-8000-000000000001'
const INTERNAL_USER_ID_PATTERN = /^lumi-user-[A-Za-z0-9-]{8,80}$/
const MEMORY_OWNER_MIGRATION_KEY = 'multi_user_owner_migration_v1'
const MEMORY_SCOPE_MIGRATION_KEY = 'memory_scope_migration_v1'
const LUMI_GLOBAL_SELF_FACTS_MIGRATION_KEY = 'lumi_global_self_facts_migration_v1'
const LEGACY_SOURCE_MODE_KEY = 'legacy_source_mode_v1'
const MEMORY_ACCESS_SQL = `(
  (m.scope IN ('global', 'shared') AND m.sensitivity != 'private')
  OR (
    m.scope NOT IN ('global', 'shared')
    AND (
      m.owner_id = ?
      OR EXISTS (
        SELECT 1 FROM json_each(m.participant_user_ids_json) audience
        WHERE audience.value = ?
      )
    )
  )
)`

export interface SqliteStatement {
  all: (...values: SqliteValue[]) => Record<string, any>[]
  get: (...values: SqliteValue[]) => Record<string, any> | undefined
  run: (...values: SqliteValue[]) => void
}

export interface SqliteDatabase {
  close?: () => void
  exec: (sql: string) => void
  prepare: (sql: string) => SqliteStatement
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase
}

interface LumiVectorWorkerResponse<T = any> {
  id?: string
  ok: boolean
  result?: T
  error?: string
}

interface LumiVectorWorkerEmbedResult {
  model: string
  device: string
  dimensions: number
  vectors: number[][]
}

let dbInstance: SqliteDatabase | null = null
let dbPathInstance = ''
let vectorWorker: ChildProcessWithoutNullStreams | null = null
let vectorWorkerRequestId = 0
let vectorWorkerStarting = false
let vectorWorkerLastError = ''
let vectorWorkerProgress = ''
let vectorWorkerDevice = 'unknown'
let vectorWorkerPhase = ''
let vectorWorkerDownloadPercent: number | undefined
let vectorWorkerDownloadedBytes: number | undefined
let vectorWorkerDownloadTotalBytes: number | undefined
let vectorWorkerDownloadSpeedBytesPerSecond: number | undefined
const vectorWorkerPending = new Map<string, {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}>()

async function loadSqlite(): Promise<SqliteModule> {
  // NOTICE:
  // The Function constructor keeps `node:sqlite` opaque to electron-vite so the
  // runtime builtin is not rewritten into an application dependency.
  // Static or directly analyzable imports were bundled incorrectly in packaged builds.
  // Source/context: the desktop main-process SQLite loader in this file.
  // Removal condition: electron-vite can preserve `node:sqlite` as a runtime builtin.
  // eslint-disable-next-line no-new-func
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<SqliteModule>
  return await dynamicImport('node:sqlite')
}

async function getDatabase(): Promise<{ db: SqliteDatabase, path: string }> {
  if (dbInstance) {
    return { db: dbInstance, path: dbPathInstance }
  }

  const sqlite = await loadSqlite()
  dbPathInstance = join(app.getPath('userData'), 'lumi-memory.sqlite3')
  const databaseExisted = existsSync(dbPathInstance)
  mkdirSync(dirname(dbPathInstance), { recursive: true })
  dbInstance = new sqlite.DatabaseSync(dbPathInstance)
  migrate(dbInstance)
  const legacySourceMode = getMeta(dbInstance, LEGACY_SOURCE_MODE_KEY) ?? (databaseExisted ? 'recover' : 'fresh')
  setMetaWithDb(dbInstance, LEGACY_SOURCE_MODE_KEY, legacySourceMode)
  if (legacySourceMode === 'recover')
    mergeLegacyMemorySources(sqlite, dbInstance, dbPathInstance)
  return { db: dbInstance, path: dbPathInstance }
}

function legacyMemorySourcePaths(targetPath: string) {
  const appData = app.getPath('appData')
  const normalizedTarget = resolve(targetPath).toLowerCase()
  return [...new Set([
    join(appData, 'lumi', 'lumi-memory.sqlite3'),
    join(appData, '@proj-airi', 'stage-tamagotchi', 'lumi-memory.sqlite3'),
  ].map(path => resolve(path)))]
    .filter(path => path.toLowerCase() !== normalizedTarget && existsSync(path))
}

function legacySourceFingerprint(path: string) {
  const sourceStat = statSync(path)
  return `${sourceStat.size}:${sourceStat.mtimeMs}`
}

function normalizedLegacyMemory(row: Record<string, any>) {
  const memory = rowToMemory(row)
  const userId = INTERNAL_USER_ID_PATTERN.test(memory.userId) ? memory.userId : DOGGY_USER_ID
  const relationshipScoped = memory.scope === 'relationship' || memory.scope === 'private'
  return {
    ...memory,
    userId,
    ownerId: relationshipScoped ? userId : memory.ownerId,
    participantUserIds: relationshipScoped ? [userId] : memory.participantUserIds,
    subjectUserIds: relationshipScoped && (memory.subjectUserIds?.length ?? 0) === 0 ? [userId] : memory.subjectUserIds,
    sourceActorId: memory.sourceActorId === 'local' ? userId : memory.sourceActorId,
  }
}

/** Imports historical Lumi memory databases into the active database without modifying their files. */
function mergeLegacyMemorySources(sqlite: SqliteModule, target: SqliteDatabase, targetPath: string) {
  for (const sourcePath of legacyMemorySourcePaths(targetPath)) {
    const markerKey = `legacy_memory_source_v2:${sourcePath.toLowerCase()}`
    const fingerprint = legacySourceFingerprint(sourcePath)
    if (getMeta(target, markerKey) === fingerprint)
      continue

    const source = new sqlite.DatabaseSync(sourcePath, { readOnly: true })
    try {
      const hasMemories = source.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'lumi_memories\'').get()
      if (!hasMemories)
        continue

      target.exec('BEGIN IMMEDIATE')
      try {
        for (const row of source.prepare('SELECT * FROM lumi_memories').all()) {
          const memory = normalizedLegacyMemory(row)
          const current = target.prepare('SELECT user_id, updated_at FROM lumi_memories WHERE id = ?').get(memory.id)
          if (current && INTERNAL_USER_ID_PATTERN.test(stringField(current.user_id)) && stringField(current.updated_at) >= memory.updatedAt)
            continue
          upsertMemoryWithDb(target, memory)
        }

        const hasVectors = source.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'lumi_memory_vectors\'').get()
        if (hasVectors) {
          for (const row of source.prepare('SELECT * FROM lumi_memory_vectors').all()) {
            const vector = rowToVectorRecord(row)
            const memoryExists = target.prepare('SELECT id FROM lumi_memories WHERE id = ?').get(vector.memoryId)
            if (!memoryExists)
              continue
            const current = target.prepare('SELECT updated_at FROM lumi_memory_vectors WHERE memory_id = ? AND model = ?').get(vector.memoryId, vector.model)
            if (current && stringField(current.updated_at) >= vector.updatedAt)
              continue
            upsertVectorWithDb(target, vector)
          }
        }

        const hasEvents = source.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'lumi_memory_events\'').get()
        if (hasEvents) {
          for (const row of source.prepare('SELECT * FROM lumi_memory_events ORDER BY created_at DESC LIMIT 200').all())
            saveEventWithDb(target, DOGGY_USER_ID, rowToEvent(row))
        }
        const legacySeedId = source.prepare('SELECT value FROM lumi_meta WHERE key = \'seed_id\'').get()
        if (typeof legacySeedId?.value === 'string' && !getMeta(target, `seed_id:${DOGGY_USER_ID}`))
          setMetaWithDb(target, `seed_id:${DOGGY_USER_ID}`, legacySeedId.value)
        setMetaWithDb(target, markerKey, fingerprint)
        target.exec('COMMIT')
      }
      catch (error) {
        target.exec('ROLLBACK')
        throw error
      }
    }
    catch (error) {
      console.warn(`[lumi-memory] failed to merge legacy source ${sourcePath}`, error)
    }
    finally {
      source.close?.()
    }
  }
}

function migrate(db: SqliteDatabase) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS lumi_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lumi_memories (
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
      status TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'relationship',
      owner_type TEXT NOT NULL DEFAULT 'user',
      owner_id TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'participants',
      participant_user_ids_json TEXT NOT NULL DEFAULT '[]',
      subject_user_ids_json TEXT NOT NULL DEFAULT '[]',
      sensitivity TEXT NOT NULL DEFAULT 'normal',
      source_actor_id TEXT,
      source_conversation_type TEXT NOT NULL DEFAULT 'import',
      classification_reason TEXT NOT NULL DEFAULT '',
      disclosure_reason TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_lumi_memories_status ON lumi_memories(status);
    CREATE INDEX IF NOT EXISTS idx_lumi_memories_type ON lumi_memories(type);
    CREATE INDEX IF NOT EXISTS idx_lumi_memories_user_persona ON lumi_memories(user_id, persona_id);
    CREATE INDEX IF NOT EXISTS idx_lumi_memories_updated_at ON lumi_memories(updated_at);
    CREATE TABLE IF NOT EXISTS lumi_memory_vectors (
      memory_id TEXT NOT NULL,
      model TEXT NOT NULL,
      signature TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      device TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(memory_id, model),
      FOREIGN KEY(memory_id) REFERENCES lumi_memories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_lumi_memory_vectors_model ON lumi_memory_vectors(model);
    CREATE INDEX IF NOT EXISTS idx_lumi_memory_vectors_updated_at ON lumi_memory_vectors(updated_at);

    CREATE TABLE IF NOT EXISTS lumi_memory_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '${DOGGY_USER_ID}',
      kind TEXT NOT NULL,
      memory_id TEXT,
      related_memory_ids_json TEXT,
      query TEXT,
      route TEXT,
      result_count INTEGER,
      before_status TEXT,
      after_status TEXT,
      preview TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lumi_memory_events_created_at ON lumi_memory_events(created_at);

    CREATE TABLE IF NOT EXISTS lumi_social_language_snapshot (
      id TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)

  const eventColumns = db.prepare('PRAGMA table_info(lumi_memory_events)').all()
  if (!eventColumns.some(column => column.name === 'user_id'))
    db.exec(`ALTER TABLE lumi_memory_events ADD COLUMN user_id TEXT NOT NULL DEFAULT '${DOGGY_USER_ID}'`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_lumi_memory_events_user_created ON lumi_memory_events(user_id, created_at)')

  if (getMeta(db, MEMORY_OWNER_MIGRATION_KEY) !== 'complete') {
    db.prepare('UPDATE lumi_memories SET user_id = ?').run(DOGGY_USER_ID)
    db.prepare('UPDATE lumi_memory_events SET user_id = ?').run(DOGGY_USER_ID)
    const legacySeedId = getMeta(db, 'seed_id')
    if (legacySeedId)
      setMetaWithDb(db, `seed_id:${DOGGY_USER_ID}`, legacySeedId)
    setMetaWithDb(db, MEMORY_OWNER_MIGRATION_KEY, 'complete')
  }

  migrateMemoryScopes(db)
}

function migrateMemoryScopes(db: SqliteDatabase) {
  const columns = db.prepare('PRAGMA table_info(lumi_memories)').all()
  const additions = [
    ['scope', `TEXT NOT NULL DEFAULT 'relationship'`],
    ['owner_type', `TEXT NOT NULL DEFAULT 'user'`],
    ['owner_id', `TEXT NOT NULL DEFAULT ''`],
    ['visibility', `TEXT NOT NULL DEFAULT 'participants'`],
    ['participant_user_ids_json', `TEXT NOT NULL DEFAULT '[]'`],
    ['subject_user_ids_json', `TEXT NOT NULL DEFAULT '[]'`],
    ['sensitivity', `TEXT NOT NULL DEFAULT 'normal'`],
    ['source_actor_id', 'TEXT'],
    ['source_conversation_type', `TEXT NOT NULL DEFAULT 'import'`],
    ['classification_reason', `TEXT NOT NULL DEFAULT ''`],
    ['disclosure_reason', `TEXT NOT NULL DEFAULT ''`],
    ['derived_from_evidence_ids_json', `TEXT NOT NULL DEFAULT '[]'`],
    ['valid_from', 'TEXT'],
    ['valid_until', 'TEXT'],
    ['last_confirmed_at', 'TEXT'],
    ['supersedes_id', 'TEXT'],
    ['superseded_by_id', 'TEXT'],
    ['contradicts_ids_json', `TEXT NOT NULL DEFAULT '[]'`],
    ['source_episode_start_message_id', 'TEXT'],
    ['source_episode_end_message_id', 'TEXT'],
    ['use_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['evidence_origin', `TEXT NOT NULL DEFAULT 'legacy_import'`],
  ] as const
  for (const [name, definition] of additions) {
    if (!columns.some(column => column.name === name))
      db.exec(`ALTER TABLE lumi_memories ADD COLUMN ${name} ${definition}`)
  }
  db.exec(`
    UPDATE lumi_memories
    SET source_actor_id = COALESCE(NULLIF(source_actor_id, ''), user_id),
        source_conversation_type = CASE
          WHEN source_conversation_type IN ('direct', 'group', 'manual', 'import') THEN source_conversation_type
          ELSE 'import'
        END,
        classification_reason = CASE
          WHEN classification_reason = '' THEN 'Legacy memory normalized under the current access policy.'
          ELSE classification_reason
        END,
        disclosure_reason = CASE
          WHEN disclosure_reason != '' THEN disclosure_reason
          WHEN scope = 'global' THEN 'Legacy Lumi-owned memory available in every authorized conversation.'
          WHEN scope = 'shared' THEN 'Legacy non-private memory marked shareable across relationships.'
          WHEN scope = 'group' THEN 'Legacy group memory visible only in its owning conversation.'
          WHEN scope = 'private' THEN 'Private memory; never disclose outside its source relationship.'
          ELSE 'Relationship memory visible only to its owning user.'
        END
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_lumi_memories_scope_owner ON lumi_memories(scope, owner_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_lumi_memories_current_validity ON lumi_memories(status, superseded_by_id, valid_until)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_lumi_memories_conversation_scope ON lumi_memories(conversation_id, scope)')

  if (getMeta(db, MEMORY_SCOPE_MIGRATION_KEY) !== 'complete') {
    const legacyRows = db.prepare('SELECT id, user_id FROM lumi_memories').all()
    const update = db.prepare(`
      UPDATE lumi_memories
      SET scope = 'relationship', owner_type = 'user', owner_id = ?, visibility = 'participants',
          participant_user_ids_json = ?, subject_user_ids_json = ?, sensitivity = 'normal'
      WHERE id = ?
    `)
    for (const row of legacyRows) {
      const userId = stringField(row.user_id, DOGGY_USER_ID)
      update.run(userId, JSON.stringify([userId]), JSON.stringify([userId]), stringField(row.id))
    }
    setMetaWithDb(db, MEMORY_SCOPE_MIGRATION_KEY, 'complete')
  }

  migrateLumiGlobalSelfFacts(db)
}

function migrateLumiGlobalSelfFacts(db: SqliteDatabase) {
  if (getMeta(db, LUMI_GLOBAL_SELF_FACTS_MIGRATION_KEY) === 'complete')
    return

  const existing = db.prepare('SELECT id FROM lumi_memories WHERE id = ?').get('lumi-global:self:birthday')
  if (existing) {
    setMetaWithDb(db, LUMI_GLOBAL_SELF_FACTS_MIGRATION_KEY, 'complete')
    return
  }

  const rows = db.prepare('SELECT id, persona_id, content, status, created_at, updated_at FROM lumi_memories').all()
  const birthday = findLumiSelfBirthday(rows)
  if (birthday) {
    upsertMemoryWithDb(db, {
      id: 'lumi-global:self:birthday',
      userId: DOGGY_USER_ID,
      personaId: birthday.personaId,
      type: 'persona_fact',
      content: `Lumi 的生日是${birthday.date}。`,
      confidence: 0.92,
      importance: 0.95,
      emotionalIntensity: 0.35,
      relationshipRelevance: 0.45,
      createdAt: birthday.createdAt,
      updatedAt: birthday.updatedAt,
      decay: 0,
      tags: ['lumi_self', 'birthday', `derived_from:${birthday.sourceId}`],
      status: 'active',
      scope: 'global',
      ownerType: 'lumi',
      ownerId: birthday.personaId,
      visibility: 'global',
      participantUserIds: [],
      subjectUserIds: ['lumi'],
      sensitivity: 'normal',
      sourceActorId: DOGGY_USER_ID,
      sourceConversationType: 'import',
      classificationReason: 'Migrated an explicit Lumi self birthday into global persona memory.',
      disclosureReason: 'Lumi-owned self knowledge is available in every authorized conversation.',
    })
    setMetaWithDb(db, LUMI_GLOBAL_SELF_FACTS_MIGRATION_KEY, 'complete')
  }
}

function findLumiSelfBirthday(rows: Record<string, any>[]) {
  for (const row of rows) {
    if (row.status !== 'active')
      continue
    const match = stringField(row.content).match(/Lumi.{0,8}生日(?:是|为)?\s*(\d{1,2}\s*月\s*\d{1,2}\s*日)/i)
    if (!match)
      continue
    return {
      date: match[1].replace(/\s+/g, ''),
      personaId: stringField(row.persona_id, 'lumi'),
      sourceId: stringField(row.id),
      createdAt: stringField(row.created_at, new Date().toISOString()),
      updatedAt: stringField(row.updated_at, new Date().toISOString()),
    }
  }
  return null
}

export function createLumiMemoryService(params: {
  context: ReturnType<typeof createContext>['context']
}) {
  defineInvokeHandler(params.context, electronLumiMemoryGetSnapshot, async ({ userId, includeCognitive }) => getSnapshot(userId, includeCognitive))
  defineInvokeHandler(params.context, electronLumiMemoryReplaceSnapshot, async ({ userId, snapshot }) => replaceSnapshot(userId, snapshot))
  defineInvokeHandler(params.context, electronLumiMemoryUpsertMemory, async memory => upsertMemory(memory))
  defineInvokeHandler(params.context, electronLumiMemoryDeleteMemory, async ({ id, userId }) => deleteMemory(id, userId))
  defineInvokeHandler(params.context, electronLumiMemoryGetVectors, async payload => getVectors(payload.model, payload.userId))
  defineInvokeHandler(params.context, electronLumiMemoryUpsertVector, async record => upsertVector(record))
  defineInvokeHandler(params.context, electronLumiMemoryDeleteVector, async payload => deleteVector(payload.memoryId, payload.model))
  defineInvokeHandler(params.context, electronLumiMemoryVectorStatus, async ({ userId }) => getVectorStatus(userId))
  defineInvokeHandler(params.context, electronLumiMemoryBackfillVectors, async payload => backfillVectors(payload.userId, payload.limit))
  defineInvokeHandler(params.context, electronLumiMemorySearchVectors, async payload => searchVectors(payload.userId, payload.query, payload.limit))
  defineInvokeHandler(params.context, electronLumiMemorySyncVector, async memory => syncVectorForMemory(memory))
  defineInvokeHandler(params.context, electronLumiMemorySaveEvent, async ({ userId, event }) => saveEvent(userId, event))
  defineInvokeHandler(params.context, electronLumiMemorySetSeedId, async ({ userId, seedId }) => setMeta(`seed_id:${userId}`, seedId))
  defineInvokeHandler(params.context, electronLumiMemoryClear, async ({ userId }) => clearDatabase(userId))
  defineInvokeHandler(params.context, electronLumiSocialLanguageGetSnapshot, async () => getSocialLanguageSnapshot())
  defineInvokeHandler(params.context, electronLumiSocialLanguageReplaceSnapshot, async snapshot => replaceSocialLanguageSnapshot(snapshot))
  createLumiDesktopCognitiveService({
    context: params.context,
    getDatabase,
    recall: recallCognitiveMemories,
    loadMemoriesByIds: loadCognitiveMemoriesByIds,
    getSocialLanguageSnapshot: async () => migrateSocialLanguageSnapshot(await getSocialLanguageSnapshot()),
    loadLegacyCurrentState: async actorId => (await loadCurrentStateFromDatabase(actorId)).state,
    loadLegacyProfile: async actorId => (await loadProfileFromDatabase(actorId)).entries,
  })
}

async function getSocialLanguageSnapshot(): Promise<ElectronLumiSocialLanguageSnapshot> {
  const { db } = await getDatabase()
  const row = db.prepare('SELECT snapshot_json FROM lumi_social_language_snapshot WHERE id = ?').get('default')
  if (typeof row?.snapshot_json !== 'string') {
    return {
      version: 4,
      expressions: [],
      jargon: [],
      behaviors: [],
      decisions: [],
      observationBuffer: [],
      observationHistory: [],
      observationBatches: [],
      updatedAt: Date.now(),
      lastMaintenanceAt: Date.now(),
    }
  }
  try {
    const parsed = JSON.parse(row.snapshot_json) as ElectronLumiSocialLanguageSnapshot
    return toPlainIpcObject(parsed)
  }
  catch {
    throw new Error('Stored Lumi social-language snapshot is invalid JSON')
  }
}

async function replaceSocialLanguageSnapshot(snapshot: ElectronLumiSocialLanguageSnapshot) {
  const { db } = await getDatabase()
  const plain = toPlainIpcObject(snapshot)
  db.prepare(`
    INSERT INTO lumi_social_language_snapshot (id, snapshot_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      snapshot_json = excluded.snapshot_json,
      updated_at = excluded.updated_at
  `).run('default', JSON.stringify(plain), plain.updatedAt)
}

async function getSnapshot(userId: string, includeCognitive = false): Promise<ElectronLumiMemorySnapshot> {
  const { db, path } = await getDatabase()
  const fragments = db.prepare(`
    SELECT m.* FROM lumi_memories m
    WHERE ${MEMORY_ACCESS_SQL}
    ORDER BY updated_at DESC, created_at DESC
  `).all(userId, userId).map(rowToMemory)
  const events = db.prepare(`
    SELECT * FROM lumi_memory_events
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 200
  `).all(userId).map(rowToEvent)
  const seedId = getMeta(db, `seed_id:${userId}`) ?? ''

  return {
    fragments,
    events,
    seedId,
    dbPath: path,
    cognitive: includeCognitive ? exportCognitiveActorData(db, userId) : undefined,
  } satisfies ElectronLumiMemorySnapshot
}

async function recallCognitiveMemories(input: {
  identity: LumiCognitiveIdentity
  query: string
  limit: number
  signal?: AbortSignal
}): Promise<{ memories: LumiMemoryFragment[], trace: LumiRecallTrace }> {
  const startedAt = Date.now()
  throwIfAborted(input.signal)
  const { db } = await getDatabase()
  const lexicalRows = cognitiveLexicalCandidates(db, input.identity, input.query, Math.max(input.limit * 4, 20))
  const lexicalIds = lexicalRows.map(row => stringField(row.id)).filter(Boolean)
  const embeddingStartedAt = Date.now()
  const semantic = await searchVectors(
    input.identity.actorId,
    input.query,
    LUMI_MEMORY_VECTOR_SEARCH_LIMIT,
  )
  const embeddingDurationMs = Date.now() - embeddingStartedAt
  throwIfAborted(input.signal)

  const semanticEntries = Object.entries(semantic.scores)
    .filter((entry): entry is [string, number] => Number.isFinite(entry[1]) && entry[1] >= 0.2)
    .sort((left, right) => right[1] - left[1])
    .slice(0, Math.max(input.limit * 6, 30))
  const candidateIds = [...new Set([
    ...lexicalIds,
    ...semanticEntries.map(([id]) => id),
  ])]
  const accessible = await loadCognitiveMemoriesByIds({
    identity: input.identity,
    memoryIds: candidateIds,
    signal: input.signal,
  })
  const lexicalRank = new Map(lexicalIds.map((id, index) => [id, 1 - index / Math.max(1, lexicalIds.length)]))
  const semanticScore = new Map(semanticEntries)
  const ranked = accessible
    .map(memory => ({
      memory,
      score: (semanticScore.get(memory.id) ?? 0) * 0.62
        + (lexicalRank.get(memory.id) ?? 0) * 0.23
        + memory.confidence * 0.08
        + memory.importance * 0.07,
    }))
    .filter(item => item.score >= 0.24)
    .sort((left, right) => right.score - left.score)
  const memories = ranked.slice(0, Math.max(0, Math.min(input.limit, 5))).map(item => item.memory)
  const conflictRejectedCount = Math.max(0, candidateIds.length - accessible.length)

  return {
    memories,
    trace: {
      ran: true,
      reusedPreviousState: false,
      aclInputCount: candidateIds.length,
      aclOutputCount: accessible.length,
      lexicalCandidateCount: lexicalIds.length,
      annCandidateCount: semanticEntries.length,
      mergedCandidateCount: candidateIds.length,
      rerankedCandidateCount: ranked.length,
      thresholdRejectedCount: Math.max(0, accessible.length - ranked.length),
      conflictRejectedCount,
      injectedCount: memories.length,
      durationMs: Date.now() - startedAt,
      embeddingDurationMs,
      vectorIndexStatus: semantic.status.available
        ? `${semantic.status.model}:${semantic.status.indexedCount}/${semantic.status.totalCount}`
        : 'structured_lexical_fallback',
      fallbackReason: semantic.status.available ? undefined : semantic.status.lastError ?? 'semantic_index_unavailable',
    },
  }
}

async function loadCognitiveMemoriesByIds(input: {
  identity: LumiCognitiveIdentity
  memoryIds: readonly string[]
  signal?: AbortSignal
}): Promise<LumiMemoryFragment[]> {
  throwIfAborted(input.signal)
  const ids = [...new Set(input.memoryIds.map(id => id.trim()).filter(Boolean))].slice(0, 100)
  if (ids.length === 0)
    return []
  const { db } = await getDatabase()
  const placeholders = ids.map(() => '?').join(', ')
  const request = cognitiveMemoryRequest(input.identity)
  const byId = new Map(
    db.prepare(`SELECT * FROM lumi_memories WHERE id IN (${placeholders})`)
      .all(...ids)
      .map(rowToMemory)
      .filter(memory => isCurrentCognitiveMemory(memory) && canAccessLumiMemory(memory, request))
      .map(memory => [memory.id, memory] as const),
  )
  throwIfAborted(input.signal)
  return ids.flatMap(id => byId.get(id) ? [byId.get(id)!] : [])
}

function cognitiveLexicalCandidates(
  db: SqliteDatabase,
  identity: LumiCognitiveIdentity,
  query: string,
  limit: number,
) {
  const tokens = cognitiveQueryTokens(query)
  if (tokens.length === 0)
    return []
  const access = cognitiveAccessClause(identity)
  const lexical = tokens.map(() => `(m.content LIKE ? ESCAPE '\\' OR m.tags_json LIKE ? ESCAPE '\\')`).join(' OR ')
  const patterns = tokens.flatMap(token => [`%${escapeLikePattern(token)}%`, `%${escapeLikePattern(token)}%`])
  return db.prepare(`
    SELECT m.* FROM lumi_memories m
    WHERE m.status = 'active'
      AND m.superseded_by_id IS NULL
      AND (m.valid_until IS NULL OR m.valid_until > ?)
      AND (${access.sql})
      AND (${lexical})
    ORDER BY m.importance DESC, m.confidence DESC, m.updated_at DESC
    LIMIT ?
  `).all(new Date().toISOString(), ...access.values, ...patterns, Math.max(1, limit))
}

function cognitiveAccessClause(identity: LumiCognitiveIdentity): {
  sql: string
  values: SqliteValue[]
} {
  if (identity.conversationType === 'group') {
    return {
      sql: `(
        (m.scope IN ('global', 'shared') AND m.sensitivity != 'private')
        OR (m.scope = 'group' AND m.conversation_id = ? AND m.sensitivity != 'private')
      )`,
      values: [identity.conversationId],
    }
  }
  return {
    sql: `(
      (m.scope IN ('global', 'shared') AND m.sensitivity != 'private')
      OR (
        m.scope IN ('relationship', 'private')
        AND (
          m.user_id = ?
          OR m.owner_id = ?
          OR EXISTS (
            SELECT 1 FROM json_each(m.participant_user_ids_json) participant
            WHERE participant.value = ?
          )
        )
      )
    )`,
    values: [identity.actorId, identity.actorId, identity.actorId],
  }
}

function cognitiveMemoryRequest(identity: LumiCognitiveIdentity): LumiMemorySearchRequest {
  return {
    query: '',
    userId: identity.actorId,
    viewerUserId: identity.actorId,
    personaId: identity.personaId,
    limit: 100,
    conversationType: identity.conversationType === 'group' ? 'group' : 'direct',
    conversationId: identity.conversationId,
    participantUserIds: [...identity.participantUserIds],
  }
}

function isCurrentCognitiveMemory(memory: LumiMemoryFragment): boolean {
  return memory.status === 'active'
    && !memory.supersededById
    && (!memory.validUntil || Date.parse(memory.validUntil) > Date.now())
}

function cognitiveQueryTokens(query: string): string[] {
  const normalized = query.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
  if (!normalized)
    return []
  const matches = normalized.match(/[\p{L}\p{N}_-]{2,}/gu) ?? []
  return [...new Set(matches)]
    .sort((left, right) => right.length - left.length)
    .slice(0, 8)
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason ?? new Error('Desktop cognitive recall aborted')
}

async function replaceSnapshot(userId: string, snapshot: ElectronLumiMemorySnapshot): Promise<ElectronLumiMemorySnapshot> {
  const { db } = await getDatabase()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM lumi_memory_events WHERE user_id = ?').run(userId)
    db.prepare(`DELETE FROM lumi_memory_vectors WHERE memory_id IN (
      SELECT id FROM lumi_memories WHERE user_id = ? AND scope IN ('relationship', 'shared', 'private')
    )`).run(userId)
    db.prepare(`DELETE FROM lumi_memories WHERE user_id = ? AND scope IN ('relationship', 'shared', 'private')`).run(userId)
    for (const memory of snapshot.fragments) {
      const scope = memoryScopeField(memory.scope)
      upsertMemoryWithDb(db, {
        ...memory,
        userId: scope === 'global' || scope === 'shared' || scope === 'group' ? memory.userId : userId,
      })
    }
    for (const event of snapshot.events)
      saveEventWithDb(db, userId, event)
    setMetaWithDb(db, `seed_id:${userId}`, snapshot.seedId ?? '')
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  if (snapshot.cognitive)
    importCognitiveActorData(db, userId, snapshot.cognitive)
  return await getSnapshot(userId, Boolean(snapshot.cognitive))
}

async function upsertMemory(memory: Record<string, any>) {
  const { db } = await getDatabase()
  upsertMemoryWithDb(db, memory)
  consolidateMemoryIntoCognition(db, rowLikeMemory(memory))
  void syncVectorForMemory(memory).catch(error => console.warn('[lumi-memory] failed to sync vector after memory upsert', error))
}

function upsertMemoryWithDb(db: SqliteDatabase, memory: Record<string, any>) {
  db.prepare(`
    INSERT INTO lumi_memories (
      id,
      user_id,
      persona_id,
      conversation_id,
      type,
      content,
      source_message_id,
      confidence,
      importance,
      emotional_intensity,
      relationship_relevance,
      created_at,
      updated_at,
      last_used_at,
      decay,
      tags_json,
      status,
      scope,
      owner_type,
      owner_id,
      visibility,
      participant_user_ids_json,
      subject_user_ids_json,
      sensitivity,
      source_actor_id,
      source_conversation_type,
      classification_reason,
      disclosure_reason,
      derived_from_evidence_ids_json,
      valid_from,
      valid_until,
      last_confirmed_at,
      supersedes_id,
      superseded_by_id,
      contradicts_ids_json,
      source_episode_start_message_id,
      source_episode_end_message_id,
      use_count,
      evidence_origin
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      user_id = excluded.user_id,
      persona_id = excluded.persona_id,
      conversation_id = excluded.conversation_id,
      type = excluded.type,
      content = excluded.content,
      source_message_id = excluded.source_message_id,
      confidence = excluded.confidence,
      importance = excluded.importance,
      emotional_intensity = excluded.emotional_intensity,
      relationship_relevance = excluded.relationship_relevance,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      last_used_at = excluded.last_used_at,
      decay = excluded.decay,
      tags_json = excluded.tags_json,
      status = excluded.status,
      scope = excluded.scope,
      owner_type = excluded.owner_type,
      owner_id = excluded.owner_id,
      visibility = excluded.visibility,
      participant_user_ids_json = excluded.participant_user_ids_json,
      subject_user_ids_json = excluded.subject_user_ids_json,
      sensitivity = excluded.sensitivity,
      source_actor_id = excluded.source_actor_id,
      source_conversation_type = excluded.source_conversation_type,
      classification_reason = excluded.classification_reason,
      disclosure_reason = excluded.disclosure_reason,
      derived_from_evidence_ids_json = excluded.derived_from_evidence_ids_json,
      valid_from = excluded.valid_from,
      valid_until = excluded.valid_until,
      last_confirmed_at = excluded.last_confirmed_at,
      supersedes_id = excluded.supersedes_id,
      superseded_by_id = excluded.superseded_by_id,
      contradicts_ids_json = excluded.contradicts_ids_json,
      source_episode_start_message_id = excluded.source_episode_start_message_id,
      source_episode_end_message_id = excluded.source_episode_end_message_id,
      use_count = excluded.use_count,
      evidence_origin = excluded.evidence_origin
  `).run(
    stringField(memory.id),
    stringField(memory.userId, 'local'),
    stringField(memory.personaId, 'lumi'),
    nullableString(memory.conversationId),
    stringField(memory.type, 'user_fact'),
    stringField(memory.content),
    nullableString(memory.sourceMessageId),
    numberField(memory.confidence),
    numberField(memory.importance),
    numberField(memory.emotionalIntensity),
    numberField(memory.relationshipRelevance),
    stringField(memory.createdAt, new Date().toISOString()),
    stringField(memory.updatedAt, new Date().toISOString()),
    nullableString(memory.lastUsedAt),
    numberField(memory.decay),
    JSON.stringify(Array.isArray(memory.tags) ? memory.tags : []),
    stringField(memory.status, 'candidate'),
    memoryScopeField(memory.scope),
    ownerTypeField(memory.ownerType ?? memory.owner_type, memory.scope),
    stringField(memory.ownerId ?? memory.owner_id, defaultMemoryOwnerId(memory)),
    visibilityField(memory.visibility, memory.scope),
    JSON.stringify(stringArrayField(memory.participantUserIds ?? memory.participant_user_ids_json, memory.scope === 'global' || memory.scope === 'shared' ? [] : [stringField(memory.userId, DOGGY_USER_ID)])),
    JSON.stringify(stringArrayField(memory.subjectUserIds ?? memory.subject_user_ids_json)),
    sensitivityField(memory.sensitivity, memory.scope),
    nullableString(memory.sourceActorId ?? memory.source_actor_id),
    sourceConversationTypeField(memory.sourceConversationType ?? memory.source_conversation_type),
    stringField(memory.classificationReason ?? memory.classification_reason),
    stringField(memory.disclosureReason ?? memory.disclosure_reason),
    JSON.stringify(stringArrayField(memory.derivedFromEvidenceIds ?? memory.derived_from_evidence_ids_json)),
    nullableString(memory.validFrom ?? memory.valid_from),
    nullableString(memory.validUntil ?? memory.valid_until),
    nullableString(memory.lastConfirmedAt ?? memory.last_confirmed_at),
    nullableString(memory.supersedesId ?? memory.supersedes_id),
    nullableString(memory.supersededById ?? memory.superseded_by_id),
    JSON.stringify(stringArrayField(memory.contradictsIds ?? memory.contradicts_ids_json)),
    nullableString(memory.sourceEpisodeStartMessageId ?? memory.source_episode_start_message_id),
    nullableString(memory.sourceEpisodeEndMessageId ?? memory.source_episode_end_message_id),
    numberField(memory.useCount ?? memory.use_count),
    evidenceOriginField(memory.evidenceOrigin ?? memory.evidence_origin),
  )
}

async function deleteMemory(id: string, userId: string) {
  const { db } = await getDatabase()
  const owned = db.prepare('SELECT id FROM lumi_memories WHERE id = ? AND user_id = ?').get(id, userId)
  if (!owned)
    return
  db.prepare('DELETE FROM lumi_memory_vectors WHERE memory_id = ?').run(id)
  db.prepare('DELETE FROM lumi_memories WHERE id = ?').run(id)
}

async function getVectors(model: string, userId: string): Promise<ElectronLumiMemoryVectorRecord[]> {
  const { db } = await getDatabase()
  return db.prepare(`
    SELECT v.memory_id, v.model, v.signature, v.vector_json, v.device, v.updated_at
    FROM lumi_memory_vectors v
    INNER JOIN lumi_memories m ON m.id = v.memory_id
    WHERE v.model = ? AND ${MEMORY_ACCESS_SQL}
    ORDER BY v.updated_at DESC
  `).all(stringField(model), userId, userId).map(rowToVectorRecord)
}

async function upsertVector(record: ElectronLumiMemoryVectorRecord) {
  const { db } = await getDatabase()
  const vector = Array.isArray(record.vector)
    ? record.vector.filter(value => typeof value === 'number' && Number.isFinite(value))
    : []
  if (!record.memoryId || !record.model || !record.signature || vector.length === 0)
    return

  db.prepare(`
    INSERT INTO lumi_memory_vectors (
      memory_id,
      model,
      signature,
      vector_json,
      device,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_id, model) DO UPDATE SET
      signature = excluded.signature,
      vector_json = excluded.vector_json,
      device = excluded.device,
      updated_at = excluded.updated_at
  `).run(
    stringField(record.memoryId),
    stringField(record.model),
    stringField(record.signature),
    JSON.stringify(vector),
    nullableString(record.device),
    stringField(record.updatedAt, new Date().toISOString()),
  )
}

async function deleteVector(memoryId: string, model?: string) {
  const { db } = await getDatabase()
  if (model)
    db.prepare('DELETE FROM lumi_memory_vectors WHERE memory_id = ? AND model = ?').run(memoryId, model)
  else
    db.prepare('DELETE FROM lumi_memory_vectors WHERE memory_id = ?').run(memoryId)
}

async function getVectorStatus(userId: string): Promise<ElectronLumiMemoryVectorStatus> {
  const { db } = await getDatabase()
  return vectorStatusWithDb(db, userId)
}

async function syncVectorForMemory(memory: Record<string, any>): Promise<ElectronLumiMemoryVectorStatus> {
  const { db } = await getDatabase()
  const normalized = rowLikeMemory(memory)
  if (!normalized.id)
    return vectorStatusWithDb(db, normalized.userId)

  if (normalized.status === 'rejected') {
    db.prepare('DELETE FROM lumi_memory_vectors WHERE memory_id = ? AND model = ?').run(normalized.id, LUMI_MEMORY_EMBEDDING_MODEL)
    return vectorStatusWithDb(db, normalized.userId)
  }

  try {
    vectorWorkerProgress = `正在更新向量: ${previewText(normalized.content, 40)}`
    const [vector] = await embedTexts([memoryVectorText(normalized)])
    upsertVectorWithDb(db, {
      memoryId: normalized.id,
      model: LUMI_MEMORY_EMBEDDING_MODEL,
      signature: memoryVectorSignature(normalized),
      vector,
      device: vectorWorkerDevice,
      updatedAt: new Date().toISOString(),
    })
  }
  catch (error) {
    vectorWorkerLastError = errorMessageFrom(error) ?? String(error)
    console.warn('[lumi-memory] failed to sync memory vector', error)
  }
  return vectorStatusWithDb(db, normalized.userId)
}

async function backfillVectors(userId: string, limit = LUMI_MEMORY_VECTOR_BACKFILL_LIMIT): Promise<ElectronLumiMemoryVectorStatus> {
  const { db } = await getDatabase()
  const memories = vectorBackfillCandidates(db, userId, limit)
  if (memories.length === 0) {
    vectorWorkerProgress = '向量已经补齐'
    return vectorStatusWithDb(db, userId)
  }

  let completed = 0
  for (let index = 0; index < memories.length; index += LUMI_MEMORY_EMBEDDING_BATCH_SIZE) {
    const batch = memories.slice(index, index + LUMI_MEMORY_EMBEDDING_BATCH_SIZE)
    vectorWorkerProgress = `正在补向量 ${Math.min(index + batch.length, memories.length)}/${memories.length}: ${previewText(batch[0]?.content ?? '', 36)}`
    try {
      const vectors = await embedTexts(batch.map(memoryVectorText))
      const now = new Date().toISOString()
      for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
        const memory = batch[batchIndex]
        const vector = vectors[batchIndex]
        if (!isFiniteVector(vector))
          continue
        upsertVectorWithDb(db, {
          memoryId: memory.id,
          model: LUMI_MEMORY_EMBEDDING_MODEL,
          signature: memoryVectorSignature(memory),
          vector,
          device: vectorWorkerDevice,
          updatedAt: now,
        })
        completed += 1
      }
    }
    catch (error) {
      vectorWorkerLastError = errorMessageFrom(error) ?? String(error)
      vectorWorkerProgress = `补向量失败: ${vectorWorkerLastError}`
      console.warn('[lumi-memory] vector backfill failed', error)
      return vectorStatusWithDb(db, userId)
    }
  }

  vectorWorkerProgress = `补向量完成 ${completed}/${memories.length}`
  return vectorStatusWithDb(db, userId)
}

async function searchVectors(userId: string, query: string, limit = LUMI_MEMORY_VECTOR_SEARCH_LIMIT): Promise<ElectronLumiMemoryVectorSearchResult> {
  const { db } = await getDatabase()
  const safeQuery = stringField(query).trim()
  if (!safeQuery)
    return { scores: {}, status: vectorStatusWithDb(db, userId) }

  const status = vectorStatusWithDb(db, userId)
  if (status.indexedCount === 0) {
    // NOTICE:
    // Vector backfill is a background maintenance task and can include model
    // startup plus hundreds of embeddings. Running it inside an interactive
    // search consumed the AstrBot reply budget before Planner could answer.
    // Source/context: prewarmSemanticIndex() already owns startup backfill.
    // Removal condition: interactive search gains a cancellable priority queue.
    vectorWorkerProgress = status.missingCount > 0
      ? `向量索引正在后台补全，当前检索先使用词法记忆（缺失 ${status.missingCount}）`
      : '当前没有可用于语义检索的记忆'
    return { scores: {}, status }
  }

  try {
    vectorWorkerProgress = `正在检索向量: ${previewText(safeQuery, 40)}`
    const [queryVector] = await embedTexts([safeQuery])
    const rows = db.prepare(`
      SELECT v.memory_id, v.vector_json
      FROM lumi_memory_vectors v
      INNER JOIN lumi_memories m ON m.id = v.memory_id
      WHERE v.model = ? AND ${MEMORY_ACCESS_SQL}
      ORDER BY v.updated_at DESC
      LIMIT ?
    `).all(LUMI_MEMORY_EMBEDDING_MODEL, userId, userId, Math.max(1, limit))

    const scores: Record<string, number> = {}
    for (const row of rows) {
      const vector = parseJsonNumberArray(row.vector_json)
      if (!isFiniteVector(vector))
        continue
      scores[stringField(row.memory_id)] = cosineSimilarity(queryVector, vector)
    }
    vectorWorkerProgress = `检索完成: ${Object.keys(scores).length} 条向量`
    return { scores, status: vectorStatusWithDb(db, userId) }
  }
  catch (error) {
    vectorWorkerLastError = errorMessageFrom(error) ?? String(error)
    vectorWorkerProgress = `检索失败: ${vectorWorkerLastError}`
    console.warn('[lumi-memory] vector search failed', error)
    return { scores: {}, status: vectorStatusWithDb(db, userId) }
  }
}
function vectorStatusWithDb(db: SqliteDatabase, userId?: string): ElectronLumiMemoryVectorStatus {
  const rows = userId
    ? db.prepare(`
    SELECT m.id, m.updated_at, m.type, m.status, m.tags_json, m.content, v.signature
    FROM lumi_memories m
    LEFT JOIN lumi_memory_vectors v ON v.memory_id = m.id AND v.model = ?
    WHERE m.status != 'rejected' AND ${MEMORY_ACCESS_SQL}
  `).all(LUMI_MEMORY_EMBEDDING_MODEL, userId, userId)
    : db.prepare(`
      SELECT m.id, m.updated_at, m.type, m.status, m.tags_json, m.content, v.signature
      FROM lumi_memories m
      LEFT JOIN lumi_memory_vectors v ON v.memory_id = m.id AND v.model = ?
      WHERE m.status != 'rejected'
    `).all(LUMI_MEMORY_EMBEDDING_MODEL)
  let indexedCount = 0
  for (const row of rows) {
    if (row.signature === memoryVectorSignature(rowToMemory(row)))
      indexedCount += 1
  }
  const running = Boolean(vectorWorker && !vectorWorker.killed)
  return {
    available: running && !vectorWorkerLastError,
    running,
    model: LUMI_MEMORY_EMBEDDING_MODEL,
    device: vectorWorkerDevice,
    phase: vectorWorkerPhase || undefined,
    indexedCount,
    totalCount: rows.length,
    missingCount: Math.max(0, rows.length - indexedCount),
    downloadPercent: vectorWorkerDownloadPercent,
    downloadedBytes: vectorWorkerDownloadedBytes,
    downloadTotalBytes: vectorWorkerDownloadTotalBytes,
    downloadSpeedBytesPerSecond: vectorWorkerDownloadSpeedBytesPerSecond,
    progress: vectorWorkerProgress,
    lastError: vectorWorkerLastError || undefined,
  }
}

function vectorBackfillCandidates(db: SqliteDatabase, userId: string, limit: number) {
  return db.prepare(`
    SELECT m.*
    FROM lumi_memories m
    LEFT JOIN lumi_memory_vectors v ON v.memory_id = m.id AND v.model = ?
    WHERE m.status != 'rejected' AND ${MEMORY_ACCESS_SQL}
    ORDER BY m.updated_at DESC, m.created_at DESC
    LIMIT ?
  `).all(LUMI_MEMORY_EMBEDDING_MODEL, userId, userId, Math.max(1, limit)).map(rowToMemory).filter((memory) => {
    const row = db.prepare(`
        SELECT signature
        FROM lumi_memory_vectors
        WHERE memory_id = ? AND model = ?
      `).get(memory.id, LUMI_MEMORY_EMBEDDING_MODEL)
    return row?.signature !== memoryVectorSignature(memory)
  })
}

function upsertVectorWithDb(db: SqliteDatabase, record: ElectronLumiMemoryVectorRecord) {
  const vector = Array.isArray(record.vector)
    ? record.vector.filter(value => typeof value === 'number' && Number.isFinite(value))
    : []
  if (!record.memoryId || !record.model || !record.signature || vector.length === 0)
    return

  db.prepare(`
    INSERT INTO lumi_memory_vectors (
      memory_id,
      model,
      signature,
      vector_json,
      device,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_id, model) DO UPDATE SET
      signature = excluded.signature,
      vector_json = excluded.vector_json,
      device = excluded.device,
      updated_at = excluded.updated_at
  `).run(
    stringField(record.memoryId),
    stringField(record.model),
    stringField(record.signature),
    JSON.stringify(vector),
    nullableString(record.device),
    stringField(record.updatedAt, new Date().toISOString()),
  )
}

async function embedTexts(texts: string[]): Promise<number[][]> {
  const params = {
    model: LUMI_MEMORY_EMBEDDING_MODEL,
    texts,
    batchSize: LUMI_MEMORY_EMBEDDING_BATCH_SIZE,
    device: LUMI_MEMORY_VECTOR_DEVICE,
  }
  let result: LumiVectorWorkerEmbedResult
  try {
    result = await requestVectorWorker<LumiVectorWorkerEmbedResult>('embed', { ...params, localFilesOnly: true })
  }
  catch {
    vectorWorkerProgress = '本地向量模型不完整，正在检查配置的模型来源'
    result = await requestVectorWorker<LumiVectorWorkerEmbedResult>('embed', { ...params, localFilesOnly: false })
  }
  vectorWorkerDevice = result.device || vectorWorkerDevice
  return result.vectors
}

async function requestVectorWorker<T>(method: string, params: Record<string, any>): Promise<T> {
  const child = await ensureVectorWorker()
  const id = `vec_${Date.now().toString(36)}_${(vectorWorkerRequestId += 1).toString(36)}`
  const request = JSON.stringify({ id, method, params })
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      vectorWorkerPending.delete(id)
      reject(new Error(`Lumi memory vector worker request timed out after ${LUMI_MEMORY_VECTOR_REQUEST_TIMEOUT_MS}ms`))
    }, LUMI_MEMORY_VECTOR_REQUEST_TIMEOUT_MS)
    vectorWorkerPending.set(id, { resolve, reject, timer })
    child.stdin.write(`${request}\n`, (error) => {
      if (error) {
        clearTimeout(timer)
        vectorWorkerPending.delete(id)
        reject(error)
      }
    })
  })
}

async function ensureVectorWorker(): Promise<ChildProcessWithoutNullStreams> {
  if (vectorWorker && !vectorWorker.killed)
    return vectorWorker
  if (vectorWorkerStarting) {
    // NOTICE:
    // A competing ensureVectorWorker call changes this flag in its finally block.
    // The lint rule cannot observe that asynchronous cross-invocation mutation.
    // Source/context: concurrent renderer requests can start vector backfill together.
    // Removal condition: startup coordination moves to a shared startup Promise.
    // eslint-disable-next-line no-unmodified-loop-condition
    while (vectorWorkerStarting)
      await new Promise(resolve => setTimeout(resolve, 50))
    if (vectorWorker && !vectorWorker.killed)
      return vectorWorker
  }

  vectorWorkerStarting = true
  try {
    const script = resolveVectorWorkerScript()
    const command = resolveVectorPythonCommand()
    const modelCacheRoot = resolveVectorModelCacheRoot()
    vectorWorkerLastError = ''
    vectorWorkerPhase = 'starting'
    vectorWorkerDownloadPercent = undefined
    vectorWorkerDownloadedBytes = undefined
    vectorWorkerDownloadTotalBytes = undefined
    vectorWorkerDownloadSpeedBytesPerSecond = undefined
    vectorWorkerProgress = `正在启动向量服务: ${command.command} ${command.args.join(' ')}`
    vectorWorker = spawn(command.command, [...command.args, script], {
      cwd: dirname(script),
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        HF_HOME: modelCacheRoot,
        HF_HUB_DISABLE_PROGRESS_BARS: '1',
        SENTENCE_TRANSFORMERS_HOME: modelCacheRoot,
        TQDM_DISABLE: '1',
        TRANSFORMERS_CACHE: join(modelCacheRoot, 'transformers'),
        LUMI_MEMORY_VECTOR_DEVICE,
      },
      windowsHide: true,
    })
    const stdout = createInterface({ input: vectorWorker.stdout })
    stdout.on('line', line => handleVectorWorkerLine(line))
    vectorWorker.stderr.on('data', (chunk) => {
      handleVectorWorkerStderr(String(chunk))
    })
    vectorWorker.on('error', (error) => {
      vectorWorkerLastError = error.message
      rejectAllVectorRequests(error)
    })
    vectorWorker.on('exit', (code, signal) => {
      vectorWorkerLastError = `向量服务已退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`
      vectorWorker = null
      rejectAllVectorRequests(new Error(vectorWorkerLastError))
    })
    await requestVectorWorker('health', { model: LUMI_MEMORY_EMBEDDING_MODEL })
    if (!vectorWorker || vectorWorker.killed)
      throw new Error(vectorWorkerLastError || 'Lumi memory vector worker exited before health check completed')
    vectorWorkerProgress = '向量服务已启动'
    return vectorWorker
  }
  finally {
    vectorWorkerStarting = false
  }
}

function handleVectorWorkerLine(line: string) {
  let response: LumiVectorWorkerResponse
  try {
    response = JSON.parse(line)
  }
  catch {
    return
  }
  if (!response.id)
    return
  const pending = vectorWorkerPending.get(response.id)
  if (!pending)
    return
  clearTimeout(pending.timer)
  vectorWorkerPending.delete(response.id)
  if (response.ok) {
    pending.resolve(response.result)
  }
  else {
    const error = new Error(response.error || 'Lumi memory vector worker failed')
    vectorWorkerLastError = error.message
    pending.reject(error)
  }
}

function rejectAllVectorRequests(error: Error) {
  for (const [id, pending] of vectorWorkerPending.entries()) {
    clearTimeout(pending.timer)
    pending.reject(error)
    vectorWorkerPending.delete(id)
  }
}

function resolveVectorWorkerScript() {
  const candidates = uniquePaths([
    ...candidateServicePaths(process.cwd()),
    ...candidateServicePaths(app.getAppPath()),
    ...candidateServicePaths(dirname(app.getAppPath())),
    ...candidateServicePaths(MAIN_MODULE_DIR),
    join(process.resourcesPath ?? '', 'services', 'lumi-memory-vector', 'server.py'),
  ])
  const found = candidates.find(candidate => existsSync(candidate))
  if (!found)
    throw new Error(`Lumi memory vector worker not found: ${candidates.join('; ')}`)
  return found
}

function candidateServicePaths(start: string) {
  const candidates: string[] = []
  let current = resolve(start)
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(join(current, 'services', 'lumi-memory-vector', 'server.py'))
    candidates.push(join(current, 'airi', 'services', 'lumi-memory-vector', 'server.py'))
    const parent = dirname(current)
    if (parent === current)
      break
    current = parent
  }
  return candidates
}

function uniquePaths(paths: string[]) {
  return [...new Set(paths.filter(Boolean).map(path => resolve(path)))]
}

function resolveVectorModelCacheRoot() {
  const userCacheRoot = join(app.getPath('userData'), 'lumi-vector-model-cache')
  const bundledCacheRoot = bundledVectorModelCacheCandidates().find(candidate => existsSync(candidate))
  const expectedUserModelCache = join(userCacheRoot, 'hub', modelCacheFolderName(LUMI_MEMORY_EMBEDDING_MODEL))
  if (bundledCacheRoot && !existsSync(expectedUserModelCache)) {
    vectorWorkerProgress = '正在准备向量模型缓存'
    mkdirSync(userCacheRoot, { recursive: true })
    // NOTICE:
    // The installed resources directory can be read-only under Program Files.
    // Hugging Face writes lock files and refs next to cached snapshots, so Lumi
    // seeds the per-user cache once and lets the worker read/write there.
    // Remove this copy step only after the vector worker supports read-only cache
    // overlays or another immutable model-loading mechanism.
    cpSync(bundledCacheRoot, userCacheRoot, {
      recursive: true,
      force: true,
    })
  }
  return userCacheRoot
}

function bundledVectorModelCacheCandidates() {
  return uniquePaths([
    process.resourcesPath ? join(process.resourcesPath, 'vector-model-cache') : '',
    join(dirname(app.getAppPath()), 'vector-model-cache'),
    join(app.getAppPath(), 'vector-model-cache'),
  ])
}

/**
 * Normalizes Hugging Face model IDs into cache folder names.
 *
 * Before:
 * - "BAAI/bge-small-zh-v1.5"
 *
 * After:
 * - "models--BAAI--bge-small-zh-v1.5"
 */
function modelCacheFolderName(modelId: string) {
  return `models--${modelId.replaceAll('/', '--')}`
}

function resolveVectorPythonCommand() {
  const configured = process.env.LUMI_MEMORY_VECTOR_PYTHON
  if (configured && existsSync(configured))
    return { command: configured, args: [] as string[] }

  const bundled = bundledVectorPythonCandidates().find(candidate => existsSync(candidate))
  if (bundled)
    return { command: bundled, args: [] as string[] }

  const candidates = [
    'D:\\anaconda3\\envs\\airi\\python.exe',
    'C:\\ProgramData\\anaconda3\\envs\\airi\\python.exe',
    'C:\\Users\\abcdi000\\anaconda3\\envs\\airi\\python.exe',
  ]
  const found = candidates.find(candidate => existsSync(candidate))
  if (found)
    return { command: found, args: [] as string[] }

  return { command: 'conda', args: ['run', '-n', 'airi', 'python'] }
}

function bundledVectorPythonCandidates() {
  const resourceRoots = uniquePaths([
    process.resourcesPath ?? '',
    dirname(app.getAppPath()),
    app.getAppPath(),
  ])

  if (process.platform === 'win32') {
    return resourceRoots.flatMap(root => [
      join(root, 'python', 'python.exe'),
      join(root, 'python', 'Scripts', 'python.exe'),
    ])
  }

  return resourceRoots.flatMap(root => [
    join(root, 'python', 'bin', 'python3'),
    join(root, 'python', 'bin', 'python'),
  ])
}

function handleVectorWorkerStderr(chunk: string) {
  const lines = chunk.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (const line of lines) {
    const prefix = '[lumi-memory-vector-progress] '
    if (line.startsWith(prefix)) {
      try {
        const payload = JSON.parse(line.slice(prefix.length)) as Record<string, any>
        vectorWorkerPhase = typeof payload.phase === 'string' ? payload.phase : vectorWorkerPhase
        vectorWorkerProgress = typeof payload.message === 'string' ? payload.message : vectorWorkerProgress
        vectorWorkerDownloadPercent = numberOrUndefined(payload.percent)
        vectorWorkerDownloadedBytes = numberOrUndefined(payload.downloadedBytes)
        vectorWorkerDownloadTotalBytes = numberOrUndefined(payload.totalBytes)
        vectorWorkerDownloadSpeedBytesPerSecond = numberOrUndefined(payload.speedBytesPerSecond)
        if (typeof payload.device === 'string')
          vectorWorkerDevice = payload.device
        continue
      }
      catch (error) {
        vectorWorkerLastError = errorMessageFrom(error) ?? String(error)
      }
    }
    vectorWorkerProgress = line
    console.warn(line)
  }
}

function numberOrUndefined(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

async function saveEvent(userId: string, event: Record<string, any>) {
  const { db } = await getDatabase()
  saveEventWithDb(db, userId, event)
  pruneEvents(db, userId)
}

function saveEventWithDb(db: SqliteDatabase, userId: string, event: Record<string, any>) {
  db.prepare(`
    INSERT OR REPLACE INTO lumi_memory_events (
      id,
      user_id,
      kind,
      memory_id,
      related_memory_ids_json,
      query,
      route,
      result_count,
      before_status,
      after_status,
      preview,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    stringField(event.id),
    userId,
    stringField(event.kind, 'search'),
    nullableString(event.memoryId),
    JSON.stringify(Array.isArray(event.relatedMemoryIds) ? event.relatedMemoryIds : []),
    nullableString(event.query),
    nullableString(event.route),
    event.resultCount == null ? null : numberField(event.resultCount),
    nullableString(event.beforeStatus),
    nullableString(event.afterStatus),
    nullableString(event.preview),
    stringField(event.createdAt, new Date().toISOString()),
  )
}

async function setMeta(key: string, value: string) {
  const { db } = await getDatabase()
  setMetaWithDb(db, key, value)
}

function setMetaWithDb(db: SqliteDatabase, key: string, value: string) {
  db.prepare(`
    INSERT INTO lumi_meta(key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value)
}

function getMeta(db: SqliteDatabase, key: string) {
  const row = db.prepare('SELECT value FROM lumi_meta WHERE key = ?').get(key)
  return typeof row?.value === 'string' ? row.value : undefined
}

async function clearDatabase(userId: string) {
  const { db } = await getDatabase()
  deleteCognitiveActorData(db, userId)
  db.prepare('DELETE FROM lumi_memory_events WHERE user_id = ?').run(userId)
  db.prepare(`DELETE FROM lumi_memory_vectors WHERE memory_id IN (
    SELECT id FROM lumi_memories WHERE user_id = ? AND scope IN ('relationship', 'shared', 'private')
  )`).run(userId)
  db.prepare(`DELETE FROM lumi_memories WHERE user_id = ? AND scope IN ('relationship', 'shared', 'private')`).run(userId)
  db.prepare('DELETE FROM lumi_meta WHERE key = ?').run(`seed_id:${userId}`)
}

function pruneEvents(db: SqliteDatabase, userId: string) {
  db.prepare(`
    DELETE FROM lumi_memory_events
    WHERE user_id = ? AND id NOT IN (
      SELECT id FROM lumi_memory_events
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 200
    );
  `).run(userId, userId)
}

function rowLikeMemory(value: Record<string, any>): LumiMemoryFragment {
  return {
    id: stringField(value.id),
    userId: stringField(value.userId ?? value.user_id, 'local'),
    personaId: stringField(value.personaId ?? value.persona_id, 'lumi'),
    conversationId: value.conversationId ?? value.conversation_id ?? undefined,
    type: memoryTypeField(value.type),
    content: stringField(value.content),
    sourceMessageId: value.sourceMessageId ?? value.source_message_id ?? undefined,
    confidence: numberField(value.confidence),
    importance: numberField(value.importance),
    emotionalIntensity: numberField(value.emotionalIntensity ?? value.emotional_intensity),
    relationshipRelevance: numberField(value.relationshipRelevance ?? value.relationship_relevance),
    createdAt: stringField(value.createdAt ?? value.created_at),
    updatedAt: stringField(value.updatedAt ?? value.updated_at),
    lastUsedAt: value.lastUsedAt ?? value.last_used_at ?? undefined,
    decay: numberField(value.decay),
    tags: Array.isArray(value.tags) ? value.tags.filter(item => typeof item === 'string') : parseJsonArray(value.tags_json),
    status: memoryStatusField(value.status),
    scope: memoryScopeField(value.scope),
    ownerType: ownerTypeField(value.ownerType ?? value.owner_type, value.scope),
    ownerId: stringField(value.ownerId ?? value.owner_id, defaultMemoryOwnerId(value)),
    visibility: visibilityField(value.visibility, value.scope),
    participantUserIds: stringArrayField(value.participantUserIds ?? value.participant_user_ids_json, value.scope === 'global' || value.scope === 'shared' ? [] : [stringField(value.userId ?? value.user_id, DOGGY_USER_ID)]),
    subjectUserIds: stringArrayField(value.subjectUserIds ?? value.subject_user_ids_json),
    sensitivity: sensitivityField(value.sensitivity, value.scope),
    sourceActorId: value.sourceActorId ?? value.source_actor_id ?? undefined,
    sourceConversationType: sourceConversationTypeField(value.sourceConversationType ?? value.source_conversation_type),
    classificationReason: stringField(value.classificationReason ?? value.classification_reason),
    disclosureReason: stringField(value.disclosureReason ?? value.disclosure_reason),
    derivedFromEvidenceIds: stringArrayField(value.derivedFromEvidenceIds ?? value.derived_from_evidence_ids_json),
    validFrom: value.validFrom ?? value.valid_from ?? undefined,
    validUntil: value.validUntil ?? value.valid_until ?? undefined,
    lastConfirmedAt: value.lastConfirmedAt ?? value.last_confirmed_at ?? undefined,
    supersedesId: value.supersedesId ?? value.supersedes_id ?? undefined,
    supersededById: value.supersededById ?? value.superseded_by_id ?? undefined,
    contradictsIds: stringArrayField(value.contradictsIds ?? value.contradicts_ids_json),
    sourceEpisodeStartMessageId: value.sourceEpisodeStartMessageId ?? value.source_episode_start_message_id ?? undefined,
    sourceEpisodeEndMessageId: value.sourceEpisodeEndMessageId ?? value.source_episode_end_message_id ?? undefined,
    useCount: numberField(value.useCount ?? value.use_count),
    evidenceOrigin: evidenceOriginField(value.evidenceOrigin ?? value.evidence_origin),
  }
}

function rowToMemory(row: Record<string, any>) {
  return toPlainIpcObject(rowLikeMemory(row))
}

function rowToEvent(row: Record<string, any>) {
  return toPlainIpcObject({
    id: stringField(row.id),
    kind: stringField(row.kind),
    memoryId: row.memory_id ?? undefined,
    relatedMemoryIds: parseJsonArray(row.related_memory_ids_json),
    query: row.query ?? undefined,
    route: row.route ?? undefined,
    resultCount: row.result_count == null ? undefined : numberField(row.result_count),
    beforeStatus: row.before_status ?? undefined,
    afterStatus: row.after_status ?? undefined,
    preview: row.preview ?? undefined,
    createdAt: stringField(row.created_at),
  })
}

function rowToVectorRecord(row: Record<string, any>): ElectronLumiMemoryVectorRecord {
  return toPlainIpcObject({
    memoryId: stringField(row.memory_id),
    model: stringField(row.model),
    signature: stringField(row.signature),
    vector: parseJsonNumberArray(row.vector_json),
    device: row.device ?? undefined,
    updatedAt: stringField(row.updated_at),
  })
}

function toPlainIpcObject<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function stringField(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function memoryScopeField(value: unknown) {
  return value === 'global' || value === 'shared' || value === 'group' || value === 'private' ? value : 'relationship'
}

function ownerTypeField(value: unknown, scope: unknown) {
  if (value === 'lumi' || value === 'user' || value === 'group')
    return value
  if (scope === 'global')
    return 'lumi'
  if (scope === 'group')
    return 'group'
  return 'user'
}

function visibilityField(value: unknown, scope: unknown) {
  if (value === 'global' || value === 'shared' || value === 'participants' || value === 'private')
    return value
  if (scope === 'global')
    return 'global'
  if (scope === 'shared')
    return 'shared'
  if (scope === 'private')
    return 'private'
  return 'participants'
}

function sensitivityField(value: unknown, scope: unknown) {
  return value === 'private' || scope === 'private' ? 'private' : 'normal'
}

function sourceConversationTypeField(value: unknown) {
  return value === 'direct' || value === 'group' || value === 'manual' ? value : 'import'
}

function evidenceOriginField(value: unknown) {
  return value === 'primary' || value === 'derived' ? value : 'legacy_import'
}

function memoryTypeField(value: unknown): LumiMemoryType {
  switch (value) {
    case 'user_preference':
    case 'user_fact':
    case 'persona_fact':
    case 'relationship_event':
    case 'shared_event':
    case 'persona_preference':
    case 'conflict_event':
    case 'promise':
    case 'project_context':
    case 'temporary_context':
    case 'emotional_echo':
      return value
    default:
      return 'user_fact'
  }
}

function memoryStatusField(value: unknown): LumiMemoryStatus {
  switch (value) {
    case 'candidate':
    case 'active':
    case 'rejected':
    case 'contradicted':
    case 'archived':
      return value
    default:
      return 'candidate'
  }
}

function defaultMemoryOwnerId(value: Record<string, any>) {
  const scope = memoryScopeField(value.scope)
  if (scope === 'global')
    return stringField(value.personaId ?? value.persona_id, 'lumi')
  if (scope === 'group')
    return stringField(value.conversationId ?? value.conversation_id, 'unassigned-group')
  return stringField(value.userId ?? value.user_id, DOGGY_USER_ID)
}

function stringArrayField(value: unknown, fallback: string[] = []) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? parseJsonArray(value) : fallback
  return [...new Set(values.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))]
}

function nullableString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberField(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parseJsonArray(value: unknown) {
  if (typeof value !== 'string')
    return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : []
  }
  catch {
    return []
  }
}

function parseJsonNumberArray(value: unknown) {
  if (typeof value !== 'string')
    return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter(item => typeof item === 'number' && Number.isFinite(item))
      : []
  }
  catch {
    return []
  }
}

function memoryVectorSignature(memory: Record<string, any>) {
  const normalized = rowLikeMemory(memory)
  return [
    normalized.updatedAt,
    normalized.type,
    normalized.status,
    normalized.tags.join('\u001F'),
    normalized.content,
  ].join('\u001E')
}

function memoryVectorText(memory: Record<string, any>) {
  const normalized = rowLikeMemory(memory)
  return normalizeEmbeddingText([
    `type: ${normalized.type}`,
    normalized.tags.length ? `tags: ${normalized.tags.join(', ')}` : '',
    `content: ${normalized.content}`,
  ].filter(Boolean).join('\n'))
}

function normalizeEmbeddingText(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function normalizeVector(vector: number[]) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map(value => value / norm)
}

function isFiniteVector(vector: unknown): vector is number[] {
  return Array.isArray(vector) && vector.length > 0 && vector.every(value => typeof value === 'number' && Number.isFinite(value))
}

function cosineSimilarity(leftInput: number[], rightInput: number[]) {
  const left = normalizeVector(leftInput)
  const right = normalizeVector(rightInput)
  let dot = 0
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1)
    dot += left[index] * right[index]
  return Math.max(0, Math.min(1, dot))
}

function previewText(text: string, maxLength: number) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized
}
