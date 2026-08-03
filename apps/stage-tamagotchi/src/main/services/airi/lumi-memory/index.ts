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
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { defineInvokeHandler } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import {
  buildLumiMemoryLexicalQuery,
  canAccessLumiMemory,
  LumiQueryEmbeddingCache,
  migrateSocialLanguageSnapshot,
  retrieveLumiMemories,
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
  runDesktopCognitiveMaintenance,
} from './cognitive'

type SqliteValue = string | number | null
const LUMI_MEMORY_EMBEDDING_MODEL = 'BAAI/bge-small-zh-v1.5'
const LUMI_MEMORY_EMBEDDING_BATCH_SIZE = 32
const LUMI_MEMORY_VECTOR_SEARCH_LIMIT = 800
const LUMI_MEMORY_VECTOR_BACKFILL_PAGE_SIZE = 256
const LUMI_MEMORY_VECTOR_REQUEST_TIMEOUT_MS = 1_800_000
const LUMI_COGNITIVE_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000
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

let cognitiveMaintenanceTimer: ReturnType<typeof setTimeout> | undefined
let cognitiveMaintenanceRunning = false

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

interface LumiAnnIndexStatus {
  ready: boolean
  needsRebuild: boolean
  model: string
  dimensions: number
  sequence: number
  count: number
  reason?: string
}

interface LumiAnnSearchResult extends LumiAnnIndexStatus {
  keys: number[]
  scores: number[]
}

interface DesktopMemoryAnnRecord {
  annKey: number
  memoryId: string
  model: string
  vector: number[]
}

interface DesktopMemoryAnnChangeBatch {
  sequence: number
  hasMore: boolean
  upserts: DesktopMemoryAnnRecord[]
  removeKeys: number[]
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
let vectorAnnReady = false
let vectorAnnCount = 0
let vectorAnnDimensions = 0
let vectorAnnSequence = 0
let vectorAnnReason = ''
let vectorAnnSynchronization: Promise<boolean> | undefined
const vectorWorkerPending = new Map<string, {
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}>()
const queryEmbeddingCache = new LumiQueryEmbeddingCache()

async function loadSqlite(): Promise<SqliteModule> {
  // NOTICE:
  // Runtime builtin lookup keeps `node:sqlite` opaque to electron-vite so it is
  // not rewritten into an application dependency, while remaining testable.
  // Static imports were bundled incorrectly and Function-based dynamic imports
  // cannot run in Vitest's VM without a dynamic-import callback.
  // Source/context: the desktop main-process SQLite loader in this file.
  // Removal condition: electron-vite can preserve `node:sqlite` as a runtime builtin.
  return process.getBuiltinModule('node:sqlite') as SqliteModule
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
      disclosure_reason TEXT NOT NULL DEFAULT '',
      vector_signature TEXT NOT NULL DEFAULT ''
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
      ann_key INTEGER,
      PRIMARY KEY(memory_id, model),
      FOREIGN KEY(memory_id) REFERENCES lumi_memories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_lumi_memory_vectors_model ON lumi_memory_vectors(model);
    CREATE INDEX IF NOT EXISTS idx_lumi_memory_vectors_updated_at ON lumi_memory_vectors(updated_at);

    CREATE TABLE IF NOT EXISTS lumi_memory_vector_changes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      ann_key INTEGER NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('upsert', 'remove')),
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lumi_memory_vector_changes_model_sequence
      ON lumi_memory_vector_changes(model, sequence);

    CREATE TABLE IF NOT EXISTS lumi_memory_vector_revisions (
      model TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL
    );

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

  const vectorColumns = db.prepare('PRAGMA table_info(lumi_memory_vectors)').all()
  if (!vectorColumns.some(column => column.name === 'ann_key'))
    db.exec('ALTER TABLE lumi_memory_vectors ADD COLUMN ann_key INTEGER')
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lumi_memory_vectors_model_ann_key
      ON lumi_memory_vectors(model, ann_key) WHERE ann_key IS NOT NULL;

    DROP TRIGGER IF EXISTS lumi_memory_vectors_ann_insert;
    DROP TRIGGER IF EXISTS lumi_memory_vectors_ann_update_same_model;
    DROP TRIGGER IF EXISTS lumi_memory_vectors_ann_update_model_remove;
    DROP TRIGGER IF EXISTS lumi_memory_vectors_ann_update_model_upsert;
    DROP TRIGGER IF EXISTS lumi_memory_vectors_ann_delete;

    CREATE TRIGGER lumi_memory_vectors_ann_insert
    AFTER INSERT ON lumi_memory_vectors
    WHEN NEW.ann_key IS NOT NULL
    BEGIN
      INSERT INTO lumi_memory_vector_changes(model, memory_id, ann_key, operation, created_at)
      VALUES (NEW.model, NEW.memory_id, NEW.ann_key, 'upsert', unixepoch() * 1000);
      INSERT INTO lumi_memory_vector_revisions(model, sequence)
      VALUES (NEW.model, last_insert_rowid())
      ON CONFLICT(model) DO UPDATE SET sequence = excluded.sequence;
    END;

    CREATE TRIGGER lumi_memory_vectors_ann_update_same_model
    AFTER UPDATE ON lumi_memory_vectors
    WHEN NEW.ann_key IS NOT NULL AND OLD.model = NEW.model
    BEGIN
      INSERT INTO lumi_memory_vector_changes(model, memory_id, ann_key, operation, created_at)
      VALUES (NEW.model, NEW.memory_id, NEW.ann_key, 'upsert', unixepoch() * 1000);
      INSERT INTO lumi_memory_vector_revisions(model, sequence)
      VALUES (NEW.model, last_insert_rowid())
      ON CONFLICT(model) DO UPDATE SET sequence = excluded.sequence;
    END;

    CREATE TRIGGER lumi_memory_vectors_ann_update_model_remove
    AFTER UPDATE ON lumi_memory_vectors
    WHEN OLD.ann_key IS NOT NULL AND OLD.model != NEW.model
    BEGIN
      INSERT INTO lumi_memory_vector_changes(model, memory_id, ann_key, operation, created_at)
      VALUES (OLD.model, OLD.memory_id, OLD.ann_key, 'remove', unixepoch() * 1000);
      INSERT INTO lumi_memory_vector_revisions(model, sequence)
      VALUES (OLD.model, last_insert_rowid())
      ON CONFLICT(model) DO UPDATE SET sequence = excluded.sequence;
    END;

    CREATE TRIGGER lumi_memory_vectors_ann_update_model_upsert
    AFTER UPDATE ON lumi_memory_vectors
    WHEN NEW.ann_key IS NOT NULL AND OLD.model != NEW.model
    BEGIN
      INSERT INTO lumi_memory_vector_changes(model, memory_id, ann_key, operation, created_at)
      VALUES (NEW.model, NEW.memory_id, NEW.ann_key, 'upsert', unixepoch() * 1000);
      INSERT INTO lumi_memory_vector_revisions(model, sequence)
      VALUES (NEW.model, last_insert_rowid())
      ON CONFLICT(model) DO UPDATE SET sequence = excluded.sequence;
    END;

    CREATE TRIGGER lumi_memory_vectors_ann_delete
    AFTER DELETE ON lumi_memory_vectors
    WHEN OLD.ann_key IS NOT NULL
    BEGIN
      INSERT INTO lumi_memory_vector_changes(model, memory_id, ann_key, operation, created_at)
      VALUES (OLD.model, OLD.memory_id, OLD.ann_key, 'remove', unixepoch() * 1000);
      INSERT INTO lumi_memory_vector_revisions(model, sequence)
      VALUES (OLD.model, last_insert_rowid())
      ON CONFLICT(model) DO UPDATE SET sequence = excluded.sequence;
    END;
  `)
  ensureDesktopAnnKeys(db)

  ensureMemoryFtsIndex(db)

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
  migrateMemoryVectorSignatures(db)
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
    ['vector_signature', `TEXT NOT NULL DEFAULT ''`],
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

function migrateMemoryVectorSignatures(db: SqliteDatabase) {
  const rows = db.prepare(`
    SELECT m.*, v.signature AS persisted_vector_signature
    FROM lumi_memories m
    LEFT JOIN lumi_memory_vectors v
      ON v.memory_id = m.id AND v.model = ?
    WHERE m.vector_signature = ''
  `).all(LUMI_MEMORY_EMBEDDING_MODEL)
  const updateMemory = db.prepare('UPDATE lumi_memories SET vector_signature = ? WHERE id = ?')
  const updateVector = db.prepare(`
    UPDATE lumi_memory_vectors SET signature = ?
    WHERE memory_id = ? AND model = ? AND signature = ?
  `)
  for (const row of rows) {
    const source = memoryVectorSignatureSource(row)
    const signature = memoryVectorSignature(row)
    const memoryId = stringField(row.id)
    updateMemory.run(signature, memoryId)
    if (row.persisted_vector_signature === source)
      updateVector.run(signature, memoryId, LUMI_MEMORY_EMBEDDING_MODEL, source)
  }
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
  defineInvokeHandler(params.context, electronLumiMemoryBackfillVectors, async payload => backfillVectors(payload.userId, payload.pageSize))
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
    persistMemory: (db, memory) => upsertMemoryWithDb(db, memory),
    onMemoryPersisted: (memory) => {
      void syncVectorForMemory(memory).catch(error => console.warn(
        '[lumi-cognitive] failed to index consolidated episode',
        error,
      ))
    },
    loadLegacyCurrentState: async actorId => (await loadCurrentStateFromDatabase(actorId)).state,
    loadLegacyProfile: async actorId => (await loadProfileFromDatabase(actorId)).entries,
  })
  scheduleDesktopCognitiveMaintenance()
}

function scheduleDesktopCognitiveMaintenance(): void {
  if (cognitiveMaintenanceTimer)
    return
  const schedule = (delayMs: number) => {
    cognitiveMaintenanceTimer = setTimeout(() => {
      cognitiveMaintenanceTimer = undefined
      if (cognitiveMaintenanceRunning) {
        schedule(LUMI_COGNITIVE_MAINTENANCE_INTERVAL_MS)
        return
      }
      cognitiveMaintenanceRunning = true
      void getDatabase()
        .then(({ db }) => runDesktopCognitiveMaintenance(db))
        .catch(error => console.warn('[lumi-cognitive] background maintenance failed', error))
        .finally(() => {
          cognitiveMaintenanceRunning = false
          schedule(LUMI_COGNITIVE_MAINTENANCE_INTERVAL_MS)
        })
    }, delayMs)
    cognitiveMaintenanceTimer.unref?.()
  }
  // Startup delay keeps schema and profile maintenance away from first-paint IO.
  schedule(60_000)
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
  const retrieval = retrieveLumiMemories(accessible, {
    ...cognitiveMemoryRequest(input.identity),
    query: input.query,
    limit: Math.max(0, Math.min(input.limit, 5)),
  }, {
    externalVectorScores: Object.fromEntries(semanticEntries),
    vectorEnabled: semantic.status.available,
    now: new Date(),
  })
  const memories = retrieval.rankedMemories.map(item => item.memory)
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
      rerankedCandidateCount: retrieval.rankedMemories.length,
      thresholdRejectedCount: Math.max(0, accessible.length - retrieval.rankedMemories.length),
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
  const lexicalQuery = buildLumiMemoryLexicalQuery(query)
  if (!lexicalQuery.matchExpression && lexicalQuery.fallbackTerms.length === 0)
    return []
  const access = cognitiveAccessClause(identity)
  const boundedLimit = Math.max(1, limit)
  const rows = lexicalQuery.matchExpression
    ? db.prepare(`
        SELECT m.*, bm25(lumi_memories_fts, 1.0, 0.35) AS lexical_rank
        FROM lumi_memories_fts
        INNER JOIN lumi_memories m ON m.rowid = lumi_memories_fts.rowid
        WHERE lumi_memories_fts MATCH ?
          AND m.status = 'active'
          AND m.superseded_by_id IS NULL
          AND (m.valid_until IS NULL OR m.valid_until > ?)
          AND (${access.sql})
        ORDER BY lexical_rank, m.importance DESC, m.confidence DESC
        LIMIT ?
      `).all(lexicalQuery.matchExpression, new Date().toISOString(), ...access.values, boundedLimit)
    : []
  if (lexicalQuery.fallbackTerms.length === 0 || rows.length >= boundedLimit)
    return rows

  const fallback = lexicalQuery.fallbackTerms
    .map(() => `(m.content LIKE ? ESCAPE '\\' OR m.tags_json LIKE ? ESCAPE '\\')`)
    .join(' OR ')
  const patterns = lexicalQuery.fallbackTerms
    .flatMap(token => [`%${escapeLikePattern(token)}%`, `%${escapeLikePattern(token)}%`])
  const fallbackRows = db.prepare(`
    SELECT m.* FROM lumi_memories m
    WHERE m.status = 'active'
      AND m.superseded_by_id IS NULL
      AND (m.valid_until IS NULL OR m.valid_until > ?)
      AND (${access.sql})
      AND (${fallback})
    ORDER BY m.importance DESC, m.confidence DESC, m.updated_at DESC
    LIMIT ?
  `).all(new Date().toISOString(), ...access.values, ...patterns, boundedLimit)
  return [...new Map([...rows, ...fallbackRows].map(row => [stringField(row.id), row])).values()]
    .slice(0, boundedLimit)
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

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`)
}

function ensureMemoryFtsIndex(db: SqliteDatabase): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS lumi_memories_fts USING fts5(
      content,
      tags_json,
      content = 'lumi_memories',
      content_rowid = 'rowid',
      tokenize = 'trigram'
    );

    CREATE TRIGGER IF NOT EXISTS lumi_memories_fts_after_insert
    AFTER INSERT ON lumi_memories BEGIN
      INSERT INTO lumi_memories_fts(rowid, content, tags_json)
      VALUES (new.rowid, new.content, new.tags_json);
    END;

    CREATE TRIGGER IF NOT EXISTS lumi_memories_fts_after_delete
    AFTER DELETE ON lumi_memories BEGIN
      INSERT INTO lumi_memories_fts(lumi_memories_fts, rowid, content, tags_json)
      VALUES ('delete', old.rowid, old.content, old.tags_json);
    END;

    CREATE TRIGGER IF NOT EXISTS lumi_memories_fts_after_update
    AFTER UPDATE OF content, tags_json ON lumi_memories BEGIN
      INSERT INTO lumi_memories_fts(lumi_memories_fts, rowid, content, tags_json)
      VALUES ('delete', old.rowid, old.content, old.tags_json);
      INSERT INTO lumi_memories_fts(rowid, content, tags_json)
      VALUES (new.rowid, new.content, new.tags_json);
    END;
  `)
  const memoryCount = Number(db.prepare('SELECT COUNT(*) AS count FROM lumi_memories').get()?.count ?? 0)
  const indexCount = Number(db.prepare('SELECT COUNT(*) AS count FROM lumi_memories_fts').get()?.count ?? 0)
  let requiresRebuild = memoryCount !== indexCount
  if (!requiresRebuild) {
    try {
      // External-content FTS reads COUNT(*) from the content table, so equal
      // counts alone cannot prove that the inverted index still exists.
      db.prepare('INSERT INTO lumi_memories_fts(lumi_memories_fts, rank) VALUES (\'integrity-check\', 1)').run()
    }
    catch {
      requiresRebuild = true
    }
  }
  if (requiresRebuild)
    db.prepare('INSERT INTO lumi_memories_fts(lumi_memories_fts) VALUES (\'rebuild\')').run()
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
      evidence_origin,
      vector_signature
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      evidence_origin = excluded.evidence_origin,
      vector_signature = excluded.vector_signature
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
    memoryVectorSignature(memory),
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
  upsertVectorWithDb(db, record)
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

async function backfillVectors(userId: string, requestedPageSize = LUMI_MEMORY_VECTOR_BACKFILL_PAGE_SIZE): Promise<ElectronLumiMemoryVectorStatus> {
  const { db } = await getDatabase()
  const normalizedPageSize = Number.isFinite(requestedPageSize)
    ? Math.floor(requestedPageSize)
    : LUMI_MEMORY_VECTOR_BACKFILL_PAGE_SIZE
  const pageSize = Math.max(
    LUMI_MEMORY_EMBEDDING_BATCH_SIZE,
    Math.min(2_000, normalizedPageSize),
  )
  let scanned = 0
  let completed = 0
  let offset = 0
  while (true) {
    const page = vectorBackfillCandidates(db, userId, pageSize, offset)
    if (page.scanned === 0)
      break
    scanned += page.scanned
    offset += page.scanned

    for (let index = 0; index < page.memories.length; index += LUMI_MEMORY_EMBEDDING_BATCH_SIZE) {
      const batch = page.memories.slice(index, index + LUMI_MEMORY_EMBEDDING_BATCH_SIZE)
      vectorWorkerProgress = `正在扫描向量 ${scanned} 条，已补 ${completed}: ${previewText(batch[0]?.content ?? '', 36)}`
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

    if (page.scanned < pageSize)
      break
  }

  vectorWorkerProgress = completed > 0
    ? `向量补全完成：扫描 ${scanned} 条，更新 ${completed} 条`
    : `向量已经补齐：扫描 ${scanned} 条`
  await synchronizeDesktopAnn(db, true)
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
    const head = desktopAnnHead(db)
    const ready = await withTimeout(synchronizeDesktopAnn(db, false), 4_000, 'ANN synchronization')
    if (!ready)
      return { scores: {}, status: vectorStatusWithDb(db, userId) }
    const queryVector = await withTimeout(queryEmbeddingCache.resolve(
      LUMI_MEMORY_EMBEDDING_MODEL,
      safeQuery,
      async () => {
        const [vector] = await embedTexts([safeQuery])
        if (!isFiniteVector(vector))
          throw new Error('Lumi memory vector worker returned no query embedding')
        return vector
      },
    ), 4_000, 'query embedding')
    const matches = await withTimeout(searchDesktopAnn(
      head.dimensions,
      queryVector,
      Math.min(2_000, Math.max(1_024, limit * 32)),
    ), 4_000, 'ANN search')
    if (matches.keys.length === 0)
      return { scores: {}, status: vectorStatusWithDb(db, userId) }
    const placeholders = matches.keys.map(() => '?').join(', ')
    const rows = db.prepare(`
      SELECT v.ann_key, v.signature, m.*
      FROM lumi_memory_vectors v
      INNER JOIN lumi_memories m ON m.id = v.memory_id
      WHERE v.model = ? AND v.ann_key IN (${placeholders}) AND ${MEMORY_ACCESS_SQL}
        AND m.status = 'active'
        AND m.superseded_by_id IS NULL
        AND (m.valid_until IS NULL OR m.valid_until > ?)
    `).all(LUMI_MEMORY_EMBEDDING_MODEL, ...matches.keys, userId, userId, new Date().toISOString())
    const byKey = new Map(rows.map(row => [safeAnnInteger(row.ann_key, 'ANN key'), row]))

    const scores: Record<string, number> = {}
    for (let index = 0; index < matches.keys.length; index += 1) {
      const row = byKey.get(matches.keys[index]!)
      if (!row || row.signature !== row.vector_signature)
        continue
      scores[stringField(row.id)] = matches.scores[index] ?? 0
      if (Object.keys(scores).length >= limit)
        break
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
  const row = userId
    ? db.prepare(`
      SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN v.signature = m.vector_signature THEN 1 ELSE 0 END) AS indexed_count
      FROM lumi_memories m
      LEFT JOIN lumi_memory_vectors v ON v.memory_id = m.id AND v.model = ?
      WHERE m.status != 'rejected' AND ${MEMORY_ACCESS_SQL}
    `).get(LUMI_MEMORY_EMBEDDING_MODEL, userId, userId)
    : db.prepare(`
      SELECT
        COUNT(*) AS total_count,
        SUM(CASE WHEN v.signature = m.vector_signature THEN 1 ELSE 0 END) AS indexed_count
      FROM lumi_memories m
      LEFT JOIN lumi_memory_vectors v ON v.memory_id = m.id AND v.model = ?
      WHERE m.status != 'rejected'
    `).get(LUMI_MEMORY_EMBEDDING_MODEL)
  const totalCount = numberField(row?.total_count)
  const indexedCount = numberField(row?.indexed_count)
  const running = Boolean(vectorWorker && !vectorWorker.killed)
  return {
    available: running && !vectorWorkerLastError,
    running,
    model: LUMI_MEMORY_EMBEDDING_MODEL,
    device: vectorWorkerDevice,
    phase: vectorWorkerPhase || undefined,
    indexedCount,
    totalCount,
    missingCount: Math.max(0, totalCount - indexedCount),
    annReady: vectorAnnReady,
    annCount: vectorAnnCount,
    annDimensions: vectorAnnDimensions,
    annSequence: vectorAnnSequence,
    annReason: vectorAnnReason || undefined,
    downloadPercent: vectorWorkerDownloadPercent,
    downloadedBytes: vectorWorkerDownloadedBytes,
    downloadTotalBytes: vectorWorkerDownloadTotalBytes,
    downloadSpeedBytesPerSecond: vectorWorkerDownloadSpeedBytesPerSecond,
    progress: vectorWorkerProgress,
    lastError: vectorWorkerLastError || undefined,
  }
}

function vectorBackfillCandidates(db: SqliteDatabase, userId: string, pageSize: number, offset: number) {
  const rows = db.prepare(`
    SELECT m.*, v.signature AS persisted_vector_signature
    FROM lumi_memories m
    LEFT JOIN lumi_memory_vectors v ON v.memory_id = m.id AND v.model = ?
    WHERE m.status != 'rejected' AND ${MEMORY_ACCESS_SQL}
    ORDER BY m.updated_at DESC, m.created_at DESC, m.id DESC
    LIMIT ? OFFSET ?
  `).all(LUMI_MEMORY_EMBEDDING_MODEL, userId, userId, pageSize, offset)
  return {
    scanned: rows.length,
    memories: rows.flatMap((row) => {
      const memory = rowToMemory(row)
      return row.persisted_vector_signature === row.vector_signature ? [] : [memory]
    }),
  }
}

function upsertVectorWithDb(db: SqliteDatabase, record: ElectronLumiMemoryVectorRecord) {
  const vector = Array.isArray(record.vector)
    ? record.vector.filter(value => typeof value === 'number' && Number.isFinite(value))
    : []
  if (!record.memoryId || !record.model || !record.signature || vector.length === 0)
    return

  const memoryId = stringField(record.memoryId)
  const model = stringField(record.model)
  const annKey = ensureDesktopAnnKey(db, memoryId, model)

  db.prepare(`
    INSERT INTO lumi_memory_vectors (
      memory_id,
      model,
      signature,
      vector_json,
      device,
      updated_at,
      ann_key
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_id, model) DO UPDATE SET
      signature = excluded.signature,
      vector_json = excluded.vector_json,
      device = excluded.device,
      updated_at = excluded.updated_at,
      ann_key = COALESCE(lumi_memory_vectors.ann_key, excluded.ann_key)
  `).run(
    memoryId,
    model,
    stringField(record.signature),
    JSON.stringify(vector),
    nullableString(record.device),
    stringField(record.updatedAt, new Date().toISOString()),
    annKey,
  )
}

function ensureDesktopAnnKeys(db: SqliteDatabase, model?: string) {
  const rows = model
    ? db.prepare('SELECT memory_id, model FROM lumi_memory_vectors WHERE model = ? AND ann_key IS NULL').all(model)
    : db.prepare('SELECT memory_id, model FROM lumi_memory_vectors WHERE ann_key IS NULL').all()
  for (const row of rows) {
    const memoryId = stringField(row.memory_id)
    const rowModel = stringField(row.model)
    const annKey = nextDesktopAnnKey(db, memoryId, rowModel)
    db.prepare(`
      UPDATE lumi_memory_vectors SET ann_key = ?
      WHERE memory_id = ? AND model = ? AND ann_key IS NULL
    `).run(annKey, memoryId, rowModel)
  }
}

function ensureDesktopAnnKey(db: SqliteDatabase, memoryId: string, model: string) {
  const existing = db.prepare(`
    SELECT ann_key FROM lumi_memory_vectors WHERE memory_id = ? AND model = ?
  `).get(memoryId, model)?.ann_key
  if (existing !== undefined && existing !== null)
    return safeAnnInteger(existing, 'ANN key')
  return nextDesktopAnnKey(db, memoryId, model)
}

function nextDesktopAnnKey(db: SqliteDatabase, memoryId: string, model: string) {
  for (let attempt = 0; attempt < 4096; attempt += 1) {
    const digest = createHash('sha256').update(`${model}\u001F${memoryId}\u001F${attempt}`).digest('hex')
    const annKey = Number.parseInt(digest.slice(0, 13), 16) || 1
    const collision = db.prepare(`
      SELECT memory_id FROM lumi_memory_vectors WHERE model = ? AND ann_key = ?
    `).get(model, annKey)
    if (!collision || stringField(collision.memory_id) === memoryId)
      return annKey
  }
  throw new Error('Unable to allocate a collision-safe ANN key')
}

function desktopAnnHead(db: SqliteDatabase) {
  ensureDesktopAnnKeys(db, LUMI_MEMORY_EMBEDDING_MODEL)
  const row = db.prepare(`
    SELECT COUNT(*) AS count, MIN(json_array_length(vector_json)) AS min_dimensions,
      MAX(json_array_length(vector_json)) AS max_dimensions
    FROM lumi_memory_vectors WHERE model = ?
  `).get(LUMI_MEMORY_EMBEDDING_MODEL)
  const count = numberField(row?.count)
  const minimum = count > 0 ? numberField(row?.min_dimensions) : 0
  const maximum = count > 0 ? numberField(row?.max_dimensions) : 0
  if (minimum !== maximum)
    throw new Error('ANN index requires one consistent vector dimension')
  const revision = db.prepare(`
    SELECT sequence FROM lumi_memory_vector_revisions WHERE model = ?
  `).get(LUMI_MEMORY_EMBEDDING_MODEL)
  return {
    count,
    dimensions: minimum,
    sequence: safeAnnInteger(revision?.sequence ?? 0, 'ANN revision'),
  }
}

function desktopAnnRecords(db: SqliteDatabase, afterMemoryId: string, limit = 512) {
  ensureDesktopAnnKeys(db, LUMI_MEMORY_EMBEDDING_MODEL)
  return db.prepare(`
    SELECT memory_id, model, ann_key, vector_json
    FROM lumi_memory_vectors
    WHERE model = ? AND memory_id > ?
    ORDER BY memory_id ASC
    LIMIT ?
  `).all(LUMI_MEMORY_EMBEDDING_MODEL, afterMemoryId, limit).map(desktopAnnRecordFromRow)
}

function desktopAnnChanges(db: SqliteDatabase, afterSequence: number, limit = 512): DesktopMemoryAnnChangeBatch {
  const rows = db.prepare(`
    SELECT sequence, ann_key FROM lumi_memory_vector_changes
    WHERE model = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?
  `).all(LUMI_MEMORY_EMBEDDING_MODEL, afterSequence, limit + 1)
  const visibleRows = rows.slice(0, limit)
  const sequence = visibleRows.length > 0
    ? safeAnnInteger(visibleRows.at(-1)?.sequence, 'ANN change sequence')
    : afterSequence
  const keys = [...new Set(visibleRows.map(row => safeAnnInteger(row.ann_key, 'ANN key')))]
  if (keys.length === 0)
    return { sequence, hasMore: rows.length > limit, upserts: [], removeKeys: [] }
  const placeholders = keys.map(() => '?').join(', ')
  const records = db.prepare(`
    SELECT memory_id, model, ann_key, vector_json FROM lumi_memory_vectors
    WHERE model = ? AND ann_key IN (${placeholders})
  `).all(LUMI_MEMORY_EMBEDDING_MODEL, ...keys).map(desktopAnnRecordFromRow)
  const currentKeys = new Set(records.map(record => record.annKey))
  return {
    sequence,
    hasMore: rows.length > limit,
    upserts: records,
    removeKeys: keys.filter(key => !currentKeys.has(key)),
  }
}

function desktopAnnRecordFromRow(row: Record<string, any>): DesktopMemoryAnnRecord {
  const vector = parseJsonNumberArray(row.vector_json)
  if (!isFiniteVector(vector))
    throw new Error('SQLite contains an invalid ANN vector')
  return {
    annKey: safeAnnInteger(row.ann_key, 'ANN key'),
    memoryId: stringField(row.memory_id),
    model: stringField(row.model),
    vector,
  }
}

function annWorkerParams(dimensions: number) {
  if (!Number.isInteger(dimensions) || dimensions <= 0)
    throw new Error('ANN dimensions must be a positive integer')
  const indexRoot = join(app.getPath('userData'), 'lumi-memory-ann')
  mkdirSync(indexRoot, { recursive: true })
  const modelDigest = createHash('sha256').update(LUMI_MEMORY_EMBEDDING_MODEL).digest('hex').slice(0, 16)
  return {
    path: join(indexRoot, `${modelDigest}-${dimensions}.usearch`),
    model: LUMI_MEMORY_EMBEDDING_MODEL,
    dimensions,
  }
}

async function openDesktopAnn(dimensions: number) {
  return updateDesktopAnnStatus(parseAnnIndexStatus(await requestVectorWorker('ann_open', annWorkerParams(dimensions))))
}

async function rebuildDesktopAnn(db: SqliteDatabase) {
  const head = desktopAnnHead(db)
  if (head.dimensions <= 0)
    throw new Error('Cannot rebuild an ANN index without vectors')
  const params = annWorkerParams(head.dimensions)
  await requestVectorWorker('ann_rebuild_begin', params)
  try {
    let afterMemoryId = ''
    let added = 0
    while (true) {
      const batch = desktopAnnRecords(db, afterMemoryId)
      if (batch.length === 0)
        break
      await requestVectorWorker('ann_rebuild_add', {
        ...params,
        keys: batch.map(record => record.annKey),
        vectors: batch.map(record => record.vector),
      })
      added += batch.length
      afterMemoryId = batch.at(-1)!.memoryId
      if (batch.length < 512)
        break
    }
    if (added !== head.count)
      throw new Error('Authoritative vectors changed during ANN rebuild')
    return updateDesktopAnnStatus(parseAnnIndexStatus(await requestVectorWorker('ann_rebuild_commit', {
      ...params,
      sequence: head.sequence,
    })))
  }
  catch (error) {
    await requestVectorWorker('ann_rebuild_abort', params).catch(() => undefined)
    throw error
  }
}

async function applyDesktopAnnChanges(dimensions: number, changes: DesktopMemoryAnnChangeBatch) {
  return updateDesktopAnnStatus(parseAnnIndexStatus(await requestVectorWorker('ann_apply', {
    ...annWorkerParams(dimensions),
    keys: changes.upserts.map(record => record.annKey),
    vectors: changes.upserts.map(record => record.vector),
    removeKeys: changes.removeKeys,
    sequence: changes.sequence,
  })))
}

async function searchDesktopAnn(dimensions: number, vector: number[], count: number) {
  const result = parseAnnSearchResult(await requestVectorWorker('ann_search', {
    ...annWorkerParams(dimensions),
    vector,
    count,
  }))
  updateDesktopAnnStatus(result)
  return result
}

async function synchronizeDesktopAnn(db: SqliteDatabase, allowRebuild: boolean): Promise<boolean> {
  if (vectorAnnSynchronization) {
    const ready = await vectorAnnSynchronization
    if (ready || !allowRebuild)
      return ready
  }
  vectorAnnSynchronization = synchronizeDesktopAnnInternal(db, allowRebuild).finally(() => {
    vectorAnnSynchronization = undefined
  })
  return await vectorAnnSynchronization
}

async function synchronizeDesktopAnnInternal(db: SqliteDatabase, allowRebuild: boolean) {
  let head = desktopAnnHead(db)
  if (head.count === 0 || head.dimensions === 0)
    return false
  let status = await openDesktopAnn(head.dimensions)
  if (!status.ready) {
    if (!allowRebuild)
      return false
    status = await rebuildDesktopAnn(db)
    head = desktopAnnHead(db)
  }
  if (status.sequence > head.sequence || status.dimensions !== head.dimensions) {
    if (!allowRebuild)
      return false
    status = await rebuildDesktopAnn(db)
    head = desktopAnnHead(db)
  }
  let processed = 0
  while (true) {
    head = desktopAnnHead(db)
    if (status.sequence >= head.sequence)
      break
    const changes = desktopAnnChanges(db, status.sequence)
    if (changes.sequence === status.sequence || (processed >= 2_000 && changes.hasMore)) {
      if (!allowRebuild)
        return false
      status = await rebuildDesktopAnn(db)
      head = desktopAnnHead(db)
      break
    }
    status = await applyDesktopAnnChanges(head.dimensions, changes)
    processed += changes.upserts.length + changes.removeKeys.length
  }
  head = desktopAnnHead(db)
  if (status.count !== head.count) {
    if (!allowRebuild)
      return false
    status = await rebuildDesktopAnn(db)
    head = desktopAnnHead(db)
  }
  return status.ready && status.sequence === head.sequence && status.count === head.count
}

function updateDesktopAnnStatus(status: LumiAnnIndexStatus) {
  vectorAnnReady = status.ready
  vectorAnnCount = status.count
  vectorAnnDimensions = status.dimensions
  vectorAnnSequence = status.sequence
  vectorAnnReason = status.reason ?? ''
  return status
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
  if (configured)
    return { command: configured, args: [] as string[] }

  const bundled = bundledVectorPythonCandidates().find(candidate => existsSync(candidate))
  if (bundled)
    return { command: bundled, args: [] as string[] }

  // Active virtual environments are portable development fallbacks. Packaged
  // builds resolve the private runtime above and never depend on a user path.
  const activeEnvironment = activeVectorPythonCandidates().find(candidate => existsSync(candidate))
  if (activeEnvironment)
    return { command: activeEnvironment, args: [] as string[] }

  return { command: process.platform === 'win32' ? 'python.exe' : 'python3', args: [] as string[] }
}

function activeVectorPythonCandidates() {
  const roots = uniquePaths([
    process.env.CONDA_PREFIX ?? '',
    process.env.VIRTUAL_ENV ?? '',
  ])
  if (process.platform === 'win32') {
    return roots.flatMap(root => [
      join(root, 'python.exe'),
      join(root, 'Scripts', 'python.exe'),
    ])
  }
  return roots.flatMap(root => [
    join(root, 'bin', 'python3'),
    join(root, 'bin', 'python'),
  ])
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

function parseAnnIndexStatus(value: unknown): LumiAnnIndexStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Vector worker returned an invalid ANN status')
  const record = value as Record<string, unknown>
  return {
    ready: record.ready === true,
    needsRebuild: record.needsRebuild === true,
    model: typeof record.model === 'string' ? record.model : '',
    dimensions: safeAnnInteger(record.dimensions, 'ANN dimensions'),
    sequence: safeAnnInteger(record.sequence, 'ANN sequence'),
    count: safeAnnInteger(record.count, 'ANN count'),
    reason: typeof record.reason === 'string' ? record.reason : undefined,
  }
}

function parseAnnSearchResult(value: unknown): LumiAnnSearchResult {
  const status = parseAnnIndexStatus(value)
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.keys) || !Array.isArray(record.scores) || record.keys.length !== record.scores.length)
    throw new Error('Vector worker returned invalid ANN matches')
  return {
    ...status,
    keys: record.keys.map(value => safeAnnInteger(value, 'ANN key')),
    scores: record.scores.map((value) => {
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error('Vector worker returned a non-finite ANN score')
      return value
    }),
  }
}

function safeAnnInteger(value: unknown, field: string) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0)
    throw new Error(`${field} must be a non-negative safe integer`)
  return number
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
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
  return createHash('sha256').update(memoryVectorSignatureSource(memory)).digest('hex')
}

function memoryVectorSignatureSource(memory: Record<string, any>) {
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

function isFiniteVector(vector: unknown): vector is number[] {
  return Array.isArray(vector) && vector.length > 0 && vector.every(value => typeof value === 'number' && Number.isFinite(value))
}

function previewText(text: string, maxLength: number) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized
}
