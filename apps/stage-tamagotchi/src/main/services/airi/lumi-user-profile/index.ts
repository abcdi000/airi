import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type { ElectronLumiUserProfileSnapshot } from '../../../../shared/eventa'

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { app } from 'electron'

import {
  electronLumiUserProfileApprovePendingUpdate,
  electronLumiUserProfileArchiveEntry,
  electronLumiUserProfileClear,
  electronLumiUserProfileDeleteEntry,
  electronLumiUserProfileGetSnapshot,
  electronLumiUserProfileRejectPendingUpdate,
  electronLumiUserProfileReplaceSnapshot,
  electronLumiUserProfileSaveEntry,
  electronLumiUserProfileSaveEvidence,
  electronLumiUserProfileSaveHistory,
  electronLumiUserProfileSavePendingUpdate,
  electronLumiUserProfileSetMeta,

  electronLumiUserProfileUpdateEntry,
} from '../../../../shared/eventa'
import { decodeProfileMeta, normalizeLegacySourceMode } from './profileMeta'

type SqliteValue = string | number | null

interface SqliteStatement {
  all: (...values: SqliteValue[]) => Record<string, any>[]
  get: (...values: SqliteValue[]) => Record<string, any> | undefined
  run: (...values: SqliteValue[]) => void
}

interface SqliteDatabase {
  close?: () => void
  exec: (sql: string) => void
  prepare: (sql: string) => SqliteStatement
}

interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase
}

const DOGGY_USER_ID = 'lumi-user-00000000-0000-4000-8000-000000000001'
const INTERNAL_USER_ID_PATTERN = /^lumi-user-[A-Za-z0-9-]{8,80}$/
const LEGACY_SOURCE_MODE_KEY = 'legacy_source_mode_v1'
const databaseByUser = new Map<string, { db: SqliteDatabase, path: string }>()

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

async function getDatabase(userId: string): Promise<{ db: SqliteDatabase, path: string }> {
  if (!INTERNAL_USER_ID_PATTERN.test(userId))
    throw new Error('Invalid Lumi user ID for profile storage')
  const existing = databaseByUser.get(userId)
  if (existing)
    return existing

  const sqlite = await loadSqlite()
  const dbPath = join(app.getPath('userData'), userId === DOGGY_USER_ID ? 'lumi-user-profile.sqlite3' : `lumi-user-profile.${userId}.sqlite3`)
  const databaseExisted = existsSync(dbPath)
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new sqlite.DatabaseSync(dbPath)
  migrate(db)
  repairOversizedLegacySourceMode(db, databaseExisted ? 'recover' : 'fresh')
  const legacySourceMode = normalizeLegacySourceMode(
    getMeta(db, LEGACY_SOURCE_MODE_KEY),
    databaseExisted ? 'recover' : 'fresh',
  )
  setMetaWithDb(db, LEGACY_SOURCE_MODE_KEY, legacySourceMode)
  if (userId === DOGGY_USER_ID && legacySourceMode === 'recover')
    mergeLegacyProfileSources(sqlite, db, dbPath)
  const result = { db, path: dbPath }
  databaseByUser.set(userId, result)
  return result
}

function migrate(db: SqliteDatabase) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS profile_entries (
      id TEXT PRIMARY KEY,
      profile_type TEXT NOT NULL,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      confidence REAL NOT NULL,
      weight REAL NOT NULL,
      source TEXT NOT NULL,
      protected INTEGER NOT NULL,
      archived INTEGER NOT NULL,
      bootstrap_id TEXT,
      bootstrap_version TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      last_seen_at TEXT,
      status TEXT NOT NULL,
      manually_modified_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_profile_entries_type ON profile_entries(profile_type);
    CREATE INDEX IF NOT EXISTS idx_profile_entries_key ON profile_entries(key);
    CREATE INDEX IF NOT EXISTS idx_profile_entries_status ON profile_entries(status);
    CREATE INDEX IF NOT EXISTS idx_profile_entries_updated_at ON profile_entries(updated_at);

    CREATE TABLE IF NOT EXISTS profile_evidence (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT,
      excerpt TEXT NOT NULL,
      confidence REAL NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(entry_id) REFERENCES profile_entries(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_profile_evidence_entry ON profile_evidence(entry_id);
    CREATE INDEX IF NOT EXISTS idx_profile_evidence_source ON profile_evidence(source_type);

    CREATE TABLE IF NOT EXISTS profile_history (
      id TEXT PRIMARY KEY,
      entry_id TEXT,
      action TEXT NOT NULL,
      old_value_json TEXT,
      new_value_json TEXT,
      reason TEXT,
      actor TEXT NOT NULL,
      source_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(entry_id) REFERENCES profile_entries(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_profile_history_entry ON profile_history(entry_id);
    CREATE INDEX IF NOT EXISTS idx_profile_history_action ON profile_history(action);
    CREATE INDEX IF NOT EXISTS idx_profile_history_created_at ON profile_history(created_at);

    CREATE TABLE IF NOT EXISTS pending_profile_updates (
      id TEXT PRIMARY KEY,
      target_key TEXT NOT NULL,
      target_category TEXT NOT NULL,
      proposed_value_json TEXT NOT NULL,
      current_value_json TEXT,
      reason TEXT NOT NULL,
      confidence REAL NOT NULL,
      source_json TEXT NOT NULL,
      target_entry_id TEXT,
      bootstrap_version TEXT,
      auto_review_json TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_pending_profile_updates_status ON pending_profile_updates(status);
    CREATE INDEX IF NOT EXISTS idx_pending_profile_updates_key ON pending_profile_updates(target_key);

    CREATE TABLE IF NOT EXISTS profile_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS profile_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      entry_id TEXT,
      pending_id TEXT,
      key TEXT,
      preview TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_profile_events_created_at ON profile_events(created_at);
  `)
  addOptionalColumn(db, 'pending_profile_updates', 'auto_review_json', 'TEXT')
}

function repairOversizedLegacySourceMode(db: SqliteDatabase, fallback: 'fresh' | 'recover') {
  const row = db.prepare('SELECT length(value_json) AS value_length FROM profile_meta WHERE key = ?').get(LEGACY_SOURCE_MODE_KEY)
  const valueLength = typeof row?.value_length === 'number' ? row.value_length : 0
  if (valueLength <= 4096)
    return

  // NOTICE:
  // The old startup path read JSON text as a plain string and JSON-encoded it
  // again. Its size doubled on every launch and eventually exhausted renderer
  // memory. Repair the known mode inside SQLite before loading the oversized
  // value into V8. This can be removed after affected Lumi profiles have been
  // migrated in a future major data-format version.
  setMetaWithDb(db, LEGACY_SOURCE_MODE_KEY, fallback)
  console.warn(`[lumi-user-profile] repaired oversized ${LEGACY_SOURCE_MODE_KEY} metadata (${valueLength} bytes)`)
}

function addOptionalColumn(db: SqliteDatabase, table: string, column: string, type: string) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`)
  }
  catch {
    // Column already exists on migrated databases.
  }
}

export function createLumiUserProfileService(params: {
  context: ReturnType<typeof createContext>['context']
}) {
  defineInvokeHandler(params.context, electronLumiUserProfileGetSnapshot, async ({ userId }) => loadProfileFromDatabase(userId))
  defineInvokeHandler(params.context, electronLumiUserProfileReplaceSnapshot, async ({ userId, snapshot }) => migrateLocalProfileToDatabase(userId, snapshot))
  defineInvokeHandler(params.context, electronLumiUserProfileSaveEntry, async ({ userId, entry }) => saveProfileEntry(userId, entry))
  defineInvokeHandler(params.context, electronLumiUserProfileUpdateEntry, async ({ userId, entry }) => updateProfileEntry(userId, entry))
  defineInvokeHandler(params.context, electronLumiUserProfileArchiveEntry, async ({ userId, id }) => archiveProfileEntry(userId, id))
  defineInvokeHandler(params.context, electronLumiUserProfileDeleteEntry, async ({ userId, id }) => deleteProfileEntry(userId, id))
  defineInvokeHandler(params.context, electronLumiUserProfileSaveEvidence, async payload => saveEvidence(payload.userId, payload.entryId, payload.evidence))
  defineInvokeHandler(params.context, electronLumiUserProfileSaveHistory, async payload => saveHistory(payload.userId, payload))
  defineInvokeHandler(params.context, electronLumiUserProfileSavePendingUpdate, async ({ userId, pending }) => savePendingUpdate(userId, pending))
  defineInvokeHandler(params.context, electronLumiUserProfileApprovePendingUpdate, async payload => approvePendingUpdate(payload.userId, payload.id, payload.entry))
  defineInvokeHandler(params.context, electronLumiUserProfileRejectPendingUpdate, async ({ userId, id }) => rejectPendingUpdate(userId, id))
  defineInvokeHandler(params.context, electronLumiUserProfileSetMeta, async payload => setMeta(payload.userId, payload.key, payload.value))
  defineInvokeHandler(params.context, electronLumiUserProfileClear, async ({ userId }) => clearDatabase(userId))
}

function legacyProfileSourcePaths(targetPath: string) {
  const appData = app.getPath('appData')
  const normalizedTarget = resolve(targetPath).toLowerCase()
  return [...new Set([
    join(appData, 'lumi', 'lumi-user-profile.sqlite3'),
    join(appData, '@proj-airi', 'stage-tamagotchi', 'lumi-user-profile.sqlite3'),
  ].map(path => resolve(path)))]
    .filter(path => path.toLowerCase() !== normalizedTarget && existsSync(path))
}

/** Imports missing or newer historical Doggy profile records from read-only databases. */
function mergeLegacyProfileSources(sqlite: SqliteModule, target: SqliteDatabase, targetPath: string) {
  for (const sourcePath of legacyProfileSourcePaths(targetPath)) {
    const sourceStat = statSync(sourcePath)
    const fingerprint = `${sourceStat.size}:${sourceStat.mtimeMs}`
    const markerKey = `legacy_profile_source:${sourcePath.toLowerCase()}`
    if (getMeta(target, markerKey) === fingerprint)
      continue

    const source = new sqlite.DatabaseSync(sourcePath, { readOnly: true })
    try {
      const hasEntries = source.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'profile_entries\'').get()
      if (!hasEntries)
        continue

      const sourceEvidence = loadEvidenceByEntry(source)
      const sourceHistory = loadHistoryByEntry(source)
      target.exec('BEGIN IMMEDIATE')
      try {
        for (const row of source.prepare('SELECT * FROM profile_entries').all()) {
          const entry = rowToEntry(row, sourceEvidence, sourceHistory)
          const current = target.prepare('SELECT updated_at FROM profile_entries WHERE id = ?').get(entry.id)
          if (current && stringField(current.updated_at) >= entry.updatedAt)
            continue
          saveProfileEntryWithDb(target, entry)
        }

        for (const row of source.prepare('SELECT * FROM pending_profile_updates').all()) {
          const pending = rowToPendingUpdate(row)
          if (!target.prepare('SELECT id FROM pending_profile_updates WHERE id = ?').get(pending.id))
            savePendingUpdateWithDb(target, pending)
        }

        for (const row of source.prepare('SELECT * FROM profile_events ORDER BY created_at DESC LIMIT 200').all()) {
          const event = rowToEvent(row)
          if (!target.prepare('SELECT id FROM profile_events WHERE id = ?').get(event.id))
            saveEventWithDb(target, event)
        }

        for (const row of source.prepare('SELECT key, value_json FROM profile_meta').all()) {
          const key = stringField(row.key)
          if (key && getMeta(target, key) === undefined)
            setMetaWithDb(target, key, parseJson(row.value_json, null))
        }
        setMetaWithDb(target, markerKey, fingerprint)
        target.exec('COMMIT')
      }
      catch (error) {
        target.exec('ROLLBACK')
        throw error
      }
    }
    catch (error) {
      console.warn(`[lumi-user-profile] failed to merge legacy source ${sourcePath}`, error)
    }
    finally {
      source.close?.()
    }
  }
}

export async function loadProfileFromDatabase(userId: string): Promise<ElectronLumiUserProfileSnapshot> {
  const { db, path } = await getDatabase(userId)
  cleanupExpiredDailyState(db)

  const sourcesByEntry = loadEvidenceByEntry(db)
  const historyByEntry = loadHistoryByEntry(db)
  const entries = db.prepare(`
    SELECT * FROM profile_entries
    ORDER BY updated_at DESC, created_at DESC
  `).all().map(row => rowToEntry(row, sourcesByEntry, historyByEntry))

  return {
    entries,
    pendingUpdates: db.prepare(`
      SELECT * FROM pending_profile_updates
      ORDER BY created_at DESC
    `).all().map(rowToPendingUpdate),
    events: db.prepare(`
      SELECT * FROM profile_events
      ORDER BY created_at DESC
      LIMIT 200
    `).all().map(rowToEvent),
    autoUpdateEnabled: getMeta(db, 'auto_update_enabled', true),
    bootstrapVersion: getMeta(db, 'bootstrap_version', ''),
    dbPath: path,
    meta: loadMeta(db),
    canImportLegacyLocalData: userId === DOGGY_USER_ID,
  }
}

export async function migrateLocalProfileToDatabase(userId: string, snapshot: ElectronLumiUserProfileSnapshot): Promise<ElectronLumiUserProfileSnapshot> {
  const { db } = await getDatabase(userId)
  replaceSnapshotWithDb(db, snapshot)
  setMetaWithDb(db, 'last_migration_at', new Date().toISOString())
  return await loadProfileFromDatabase(userId)
}

function replaceSnapshotWithDb(db: SqliteDatabase, snapshot: ElectronLumiUserProfileSnapshot) {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
      DELETE FROM profile_events;
      DELETE FROM pending_profile_updates;
      DELETE FROM profile_history;
      DELETE FROM profile_evidence;
      DELETE FROM profile_entries;
    `)
    for (const entry of snapshot.entries ?? [])
      saveProfileEntryWithDb(db, entry)
    for (const pending of snapshot.pendingUpdates ?? [])
      savePendingUpdateWithDb(db, pending)
    for (const event of snapshot.events ?? [])
      saveEventWithDb(db, event)
    setMetaWithDb(db, 'auto_update_enabled', snapshot.autoUpdateEnabled ?? true)
    setMetaWithDb(db, 'bootstrap_version', snapshot.bootstrapVersion ?? '')
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export async function saveProfileEntry(userId: string, entry: Record<string, any>) {
  const { db } = await getDatabase(userId)
  saveProfileEntryWithDb(db, entry)
}

export async function updateProfileEntry(userId: string, entry: Record<string, any>) {
  await saveProfileEntry(userId, entry)
}

export async function archiveProfileEntry(userId: string, id: string) {
  const { db } = await getDatabase(userId)
  db.prepare(`
    UPDATE profile_entries
    SET status = 'archived', archived = 1, updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), id)
  saveHistoryWithDb(db, {
    id: createId('profile_history'),
    entryId: id,
    action: 'archive',
    reason: 'archive_profile_entry',
    actor: 'user',
    createdAt: new Date().toISOString(),
  })
}

export async function deleteProfileEntry(userId: string, id: string) {
  const { db } = await getDatabase(userId)
  const row = db.prepare('SELECT value_json FROM profile_entries WHERE id = ?').get(id)
  db.prepare('DELETE FROM profile_entries WHERE id = ?').run(id)
  saveHistoryWithDb(db, {
    id: createId('profile_history'),
    entryId: id,
    action: 'delete',
    oldValue: row?.value_json,
    reason: 'delete_profile_entry',
    actor: 'user',
    createdAt: new Date().toISOString(),
  })
}

export async function saveEvidence(userId: string, entryId: string, evidence: Record<string, any>) {
  const { db } = await getDatabase(userId)
  saveEvidenceWithDb(db, entryId, evidence, 1)
}

export async function saveHistory(userId: string, payload: {
  userId?: string
  entryId?: string
  history?: Record<string, any>
  event?: Record<string, any>
}) {
  const { db } = await getDatabase(userId)
  if (payload.history)
    saveHistoryWithDb(db, { ...payload.history, entryId: payload.entryId ?? payload.history.entryId })
  if (payload.event)
    saveEventWithDb(db, payload.event)
}

export async function loadPendingUpdates(userId: string) {
  const { db } = await getDatabase(userId)
  return db.prepare(`
    SELECT * FROM pending_profile_updates
    ORDER BY created_at DESC
  `).all().map(rowToPendingUpdate)
}

export async function savePendingUpdate(userId: string, pending: Record<string, any>) {
  const { db } = await getDatabase(userId)
  savePendingUpdateWithDb(db, pending)
}

export async function approvePendingUpdate(userId: string, id: string, entry?: Record<string, any>) {
  const { db } = await getDatabase(userId)
  db.prepare(`
    UPDATE pending_profile_updates
    SET status = 'approved', resolved_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), id)
  if (entry)
    saveProfileEntryWithDb(db, entry)
  saveHistoryWithDb(db, {
    id: createId('profile_history'),
    action: 'approve',
    reason: `approve_pending:${id}`,
    actor: 'user',
    createdAt: new Date().toISOString(),
  })
}

export async function rejectPendingUpdate(userId: string, id: string) {
  const { db } = await getDatabase(userId)
  db.prepare(`
    UPDATE pending_profile_updates
    SET status = 'rejected', resolved_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), id)
  saveHistoryWithDb(db, {
    id: createId('profile_history'),
    action: 'reject',
    reason: `reject_pending:${id}`,
    actor: 'user',
    createdAt: new Date().toISOString(),
  })
}

async function setMeta(userId: string, key: string, value: unknown) {
  const { db } = await getDatabase(userId)
  setMetaWithDb(db, key, value)
}

async function clearDatabase(userId: string) {
  const { db } = await getDatabase(userId)
  db.exec(`
    DELETE FROM profile_events;
    DELETE FROM pending_profile_updates;
    DELETE FROM profile_history;
    DELETE FROM profile_evidence;
    DELETE FROM profile_entries;
    DELETE FROM profile_meta;
  `)
}

function saveProfileEntryWithDb(db: SqliteDatabase, entry: Record<string, any>) {
  const now = new Date().toISOString()
  const sources = Array.isArray(entry.source) ? entry.source : []
  const history = Array.isArray(entry.history) ? entry.history : []
  const bootstrapSource = sources.find((source: Record<string, any>) => source?.kind === 'bootstrap_profile')

  db.prepare(`
    INSERT INTO profile_entries (
      id,
      profile_type,
      category,
      key,
      value_json,
      confidence,
      weight,
      source,
      protected,
      archived,
      bootstrap_id,
      bootstrap_version,
      created_at,
      updated_at,
      expires_at,
      last_seen_at,
      status,
      manually_modified_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      profile_type = excluded.profile_type,
      category = excluded.category,
      key = excluded.key,
      value_json = excluded.value_json,
      confidence = excluded.confidence,
      weight = excluded.weight,
      source = excluded.source,
      protected = excluded.protected,
      archived = excluded.archived,
      bootstrap_id = excluded.bootstrap_id,
      bootstrap_version = excluded.bootstrap_version,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      expires_at = excluded.expires_at,
      last_seen_at = excluded.last_seen_at,
      status = excluded.status,
      manually_modified_at = excluded.manually_modified_at
  `).run(
    stringField(entry.id, createId('profile')),
    stringField(entry.layer, 'dynamic'),
    stringField(entry.category, stringField(entry.layer, 'dynamic')),
    stringField(entry.key),
    JSON.stringify(stringField(entry.value)),
    numberField(entry.confidence, 0.5),
    numberField(entry.weight, 0.5),
    JSON.stringify(sources),
    entry.protected ? 1 : 0,
    entry.status === 'archived' || entry.status === 'deleted' ? 1 : 0,
    nullableString(bootstrapSource?.id),
    nullableString(entry.bootstrapVersion),
    stringField(entry.createdAt, now),
    stringField(entry.updatedAt, now),
    nullableString(entry.expiresAt ?? expiresAtForEntry(entry)),
    nullableString(entry.lastSeenAt),
    stringField(entry.status, 'active'),
    nullableString(entry.manuallyModifiedAt),
  )

  db.prepare('DELETE FROM profile_evidence WHERE entry_id = ?').run(stringField(entry.id))
  for (const source of sources)
    saveEvidenceWithDb(db, stringField(entry.id), source, numberField(entry.confidence, 0.5))

  db.prepare('DELETE FROM profile_history WHERE entry_id = ? AND action IN (\'create\', \'update\', \'rollback\')').run(stringField(entry.id))
  for (const item of history)
    saveHistoryWithDb(db, { ...item, entryId: entry.id, action: historyActionFromItem(item), actor: actorFromSource(item.source) })
}

function saveEvidenceWithDb(db: SqliteDatabase, entryId: string, evidence: Record<string, any>, confidence: number) {
  db.prepare(`
    INSERT OR REPLACE INTO profile_evidence (
      id,
      entry_id,
      source_type,
      source_ref,
      excerpt,
      confidence,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    evidenceId(entryId, evidence),
    entryId,
    stringField(evidence.kind, 'manual'),
    nullableString(evidence.id),
    stringField(evidence.quote),
    confidence,
    stringField(evidence.createdAt, new Date().toISOString()),
  )
}

function saveHistoryWithDb(db: SqliteDatabase, history: Record<string, any>) {
  db.prepare(`
    INSERT OR REPLACE INTO profile_history (
      id,
      entry_id,
      action,
      old_value_json,
      new_value_json,
      reason,
      actor,
      source_json,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    stringField(history.id, createId('profile_history')),
    nullableString(history.entryId),
    stringField(history.action, history.previousValue || history.nextValue ? 'update' : 'create'),
    jsonOrNull(history.oldValue ?? history.previousValue),
    jsonOrNull(history.newValue ?? history.nextValue),
    nullableString(history.reason),
    stringField(history.actor, actorFromSource(history.source)),
    JSON.stringify(Array.isArray(history.source) ? history.source : []),
    stringField(history.createdAt, new Date().toISOString()),
  )
}

function savePendingUpdateWithDb(db: SqliteDatabase, pending: Record<string, any>) {
  db.prepare(`
    INSERT INTO pending_profile_updates (
      id,
      target_key,
      target_category,
      proposed_value_json,
      current_value_json,
      reason,
      confidence,
      source_json,
      target_entry_id,
      bootstrap_version,
      auto_review_json,
      status,
      created_at,
      resolved_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      target_key = excluded.target_key,
      target_category = excluded.target_category,
      proposed_value_json = excluded.proposed_value_json,
      current_value_json = excluded.current_value_json,
      reason = excluded.reason,
      confidence = excluded.confidence,
      source_json = excluded.source_json,
      target_entry_id = excluded.target_entry_id,
      bootstrap_version = excluded.bootstrap_version,
      auto_review_json = excluded.auto_review_json,
      status = excluded.status,
      created_at = excluded.created_at,
      resolved_at = excluded.resolved_at
  `).run(
    stringField(pending.id, createId('profile_pending')),
    stringField(pending.key),
    stringField(pending.targetLayer, 'core'),
    JSON.stringify(stringField(pending.value)),
    jsonOrNull(pending.currentValue),
    stringField(pending.reason, 'pending_profile_update'),
    numberField(pending.confidence, 0.5),
    JSON.stringify(Array.isArray(pending.source) ? pending.source : []),
    nullableString(pending.targetEntryId),
    nullableString(pending.bootstrapVersion),
    jsonOrNull(pending.autoReview),
    stringField(pending.status, 'pending'),
    stringField(pending.createdAt, new Date().toISOString()),
    nullableString(pending.resolvedAt),
  )
}

function saveEventWithDb(db: SqliteDatabase, event: Record<string, any>) {
  db.prepare(`
    INSERT OR REPLACE INTO profile_events (
      id,
      kind,
      entry_id,
      pending_id,
      key,
      preview,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    stringField(event.id, createId('profile_event')),
    stringField(event.kind, 'update'),
    nullableString(event.entryId),
    nullableString(event.pendingId),
    nullableString(event.key),
    nullableString(event.preview),
    stringField(event.createdAt, new Date().toISOString()),
  )

  saveHistoryWithDb(db, {
    id: `history:${stringField(event.id, createId('profile_event'))}`,
    entryId: event.entryId,
    action: stringField(event.kind, 'update'),
    reason: event.preview,
    actor: event.kind === 'bootstrap_import' ? 'bootstrap' : event.kind === 'auto_update_toggle' ? 'user' : 'system',
    createdAt: stringField(event.createdAt, new Date().toISOString()),
  })

  pruneEvents(db)
}

function rowToEntry(
  row: Record<string, any>,
  sourcesByEntry: Map<string, Record<string, any>[]>,
  historyByEntry: Map<string, Record<string, any>[]>,
) {
  const id = stringField(row.id)
  const source = sourcesByEntry.get(id) ?? parseJsonArray(row.source)
  return {
    id,
    layer: stringField(row.profile_type, 'dynamic'),
    key: stringField(row.key),
    value: parseJson(row.value_json, ''),
    confidence: numberField(row.confidence, 0.5),
    weight: numberField(row.weight, 0.5),
    source,
    protected: Boolean(row.protected),
    bootstrapVersion: row.bootstrap_version ?? undefined,
    manuallyModifiedAt: row.manually_modified_at ?? undefined,
    createdAt: stringField(row.created_at),
    updatedAt: stringField(row.updated_at),
    lastSeenAt: stringField(row.last_seen_at, stringField(row.updated_at)),
    status: stringField(row.status, row.archived ? 'archived' : 'active'),
    history: historyByEntry.get(id) ?? [],
  }
}

function rowToPendingUpdate(row: Record<string, any>) {
  return {
    id: stringField(row.id),
    targetLayer: stringField(row.target_category, 'core'),
    key: stringField(row.target_key),
    value: parseJson(row.proposed_value_json, ''),
    confidence: numberField(row.confidence, 0.5),
    impact: 'high',
    reason: stringField(row.reason),
    source: parseJsonArray(row.source_json),
    bootstrapVersion: row.bootstrap_version ?? undefined,
    targetEntryId: row.target_entry_id ?? undefined,
    autoReview: parseJson(row.auto_review_json, undefined),
    createdAt: stringField(row.created_at),
    status: stringField(row.status, 'pending'),
  }
}

function rowToEvent(row: Record<string, any>) {
  return {
    id: stringField(row.id),
    kind: stringField(row.kind),
    entryId: row.entry_id ?? undefined,
    pendingId: row.pending_id ?? undefined,
    key: row.key ?? undefined,
    preview: row.preview ?? undefined,
    createdAt: stringField(row.created_at),
  }
}

function loadEvidenceByEntry(db: SqliteDatabase) {
  const result = new Map<string, Record<string, any>[]>()
  for (const row of db.prepare(`
    SELECT * FROM profile_evidence
    ORDER BY created_at DESC
  `).all()) {
    const entryId = stringField(row.entry_id)
    const list = result.get(entryId) ?? []
    list.push({
      kind: stringField(row.source_type, 'manual'),
      id: row.source_ref ?? undefined,
      quote: stringField(row.excerpt),
      createdAt: stringField(row.created_at),
    })
    result.set(entryId, list)
  }
  return result
}

function loadHistoryByEntry(db: SqliteDatabase) {
  const result = new Map<string, Record<string, any>[]>()
  for (const row of db.prepare(`
    SELECT * FROM profile_history
    WHERE entry_id IS NOT NULL
    ORDER BY created_at DESC
  `).all()) {
    const entryId = stringField(row.entry_id)
    const list = result.get(entryId) ?? []
    const oldValue = parseJson(row.old_value_json, '')
    const newValue = parseJson(row.new_value_json, '')
    if (oldValue || newValue) {
      list.push({
        id: stringField(row.id),
        previousValue: oldValue,
        nextValue: newValue,
        reason: stringField(row.reason),
        source: parseJsonArray(row.source_json),
        createdAt: stringField(row.created_at),
      })
      result.set(entryId, list.slice(0, 30))
    }
  }
  return result
}

function setMetaWithDb(db: SqliteDatabase, key: string, value: unknown) {
  db.prepare(`
    INSERT INTO profile_meta(key, value_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), new Date().toISOString())
}

function getMeta<T>(db: SqliteDatabase, key: string, fallback: T): T
function getMeta(db: SqliteDatabase, key: string): unknown | undefined
function getMeta<T>(db: SqliteDatabase, key: string, fallback?: T): T | unknown | undefined {
  const row = db.prepare('SELECT value_json FROM profile_meta WHERE key = ?').get(key)
  if (typeof row?.value_json !== 'string')
    return fallback
  return decodeProfileMeta(row.value_json, fallback)
}

function loadMeta(db: SqliteDatabase) {
  const meta: Record<string, any> = {}
  for (const row of db.prepare('SELECT key, value_json FROM profile_meta').all())
    meta[stringField(row.key)] = decodeProfileMeta(row.value_json, null)
  return meta
}

function cleanupExpiredDailyState(db: SqliteDatabase) {
  db.prepare(`
    UPDATE profile_entries
    SET status = 'archived', archived = 1, updated_at = ?
    WHERE profile_type = 'daily'
      AND status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at < ?
  `).run(new Date().toISOString(), new Date().toISOString())
}

function pruneEvents(db: SqliteDatabase) {
  db.exec(`
    DELETE FROM profile_events
    WHERE id NOT IN (
      SELECT id FROM profile_events
      ORDER BY created_at DESC
      LIMIT 200
    );
  `)
}

function expiresAtForEntry(entry: Record<string, any>) {
  if (entry.layer !== 'daily')
    return undefined
  const base = new Date(stringField(entry.lastSeenAt, stringField(entry.updatedAt, new Date().toISOString())))
  if (!Number.isFinite(base.getTime()))
    return undefined
  base.setHours(23, 59, 59, 999)
  return base.toISOString()
}

function historyActionFromItem(history: Record<string, any>) {
  if (typeof history.action === 'string')
    return history.action
  if (history.reason === 'manual_edit')
    return 'update'
  if (typeof history.reason === 'string' && history.reason.includes('rollback'))
    return 'rollback'
  return 'update'
}

function actorFromSource(source: unknown) {
  const sources = Array.isArray(source) ? source : []
  if (sources.some(item => item?.kind === 'manual'))
    return 'user'
  if (sources.some(item => item?.kind === 'bootstrap_profile'))
    return 'bootstrap'
  return 'system'
}

function evidenceId(entryId: string, evidence: Record<string, any>) {
  return `${entryId}:${stringField(evidence.kind, 'manual')}:${stringField(evidence.id)}:${hashText(stringField(evidence.quote))}`
}

function jsonOrNull(value: unknown) {
  if (value == null)
    return null
  if (typeof value === 'string' && value.length === 0)
    return null
  return JSON.stringify(value)
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string')
    return fallback
  try {
    return JSON.parse(value) as T
  }
  catch {
    return fallback
  }
}

function parseJsonArray(value: unknown) {
  const parsed = parseJson(value, [])
  return Array.isArray(parsed) ? parsed : []
}

function stringField(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function nullableString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberField(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function hashText(text: string) {
  let hash = 0
  for (let index = 0; index < text.length; index += 1)
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0
  return Math.abs(hash).toString(36)
}
