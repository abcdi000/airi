import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type { ElectronLumiCurrentStateSnapshot } from '../../../../shared/eventa'

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { app } from 'electron'

import {
  electronLumiCurrentStateClear,
  electronLumiCurrentStateGetSnapshot,
  electronLumiCurrentStateSaveSnapshot,

} from '../../../../shared/eventa'

type SqliteValue = string | number | null

interface SqliteStatement {
  all: (...values: SqliteValue[]) => Record<string, any>[]
  get: (...values: SqliteValue[]) => Record<string, any> | undefined
  run: (...values: SqliteValue[]) => void
}

interface SqliteDatabase {
  exec: (sql: string) => void
  prepare: (sql: string) => SqliteStatement
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase
}

const DOGGY_USER_ID = 'lumi-user-00000000-0000-4000-8000-000000000001'
const INTERNAL_USER_ID_PATTERN = /^lumi-user-[A-Za-z0-9-]{8,80}$/
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
    throw new Error('Invalid Lumi user ID for current-state storage')
  const existing = databaseByUser.get(userId)
  if (existing)
    return existing

  const sqlite = await loadSqlite()
  const dbPath = join(app.getPath('userData'), userId === DOGGY_USER_ID ? 'lumi-current-state.sqlite3' : `lumi-current-state.${userId}.sqlite3`)
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new sqlite.DatabaseSync(dbPath)
  migrate(db)
  const result = { db, path: dbPath }
  databaseByUser.set(userId, result)
  return result
}

function migrate(db: SqliteDatabase) {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS lumi_current_state (
      id TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

export function createLumiCurrentStateService(params: {
  context: ReturnType<typeof createContext>['context']
}) {
  defineInvokeHandler(params.context, electronLumiCurrentStateGetSnapshot, async ({ userId }) => loadCurrentStateFromDatabase(userId))
  defineInvokeHandler(params.context, electronLumiCurrentStateSaveSnapshot, async ({ userId, snapshot }) => saveCurrentState(userId, snapshot))
  defineInvokeHandler(params.context, electronLumiCurrentStateClear, async ({ userId }) => clearCurrentState(userId))
}

export async function loadCurrentStateFromDatabase(userId: string): Promise<ElectronLumiCurrentStateSnapshot> {
  const { db, path } = await getDatabase(userId)
  const row = db.prepare('SELECT value_json FROM lumi_current_state WHERE id = ?').get('current')
  return {
    state: row?.value_json ? JSON.parse(String(row.value_json)) : null,
    dbPath: path,
  }
}

export async function saveCurrentState(userId: string, snapshot: ElectronLumiCurrentStateSnapshot): Promise<ElectronLumiCurrentStateSnapshot> {
  const { db } = await getDatabase(userId)
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO lumi_current_state (id, value_json, created_at, updated_at)
    VALUES ('current', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(JSON.stringify(snapshot.state ?? null), now, now)
  return await loadCurrentStateFromDatabase(userId)
}

export async function clearCurrentState(userId: string) {
  const { db } = await getDatabase(userId)
  db.prepare('DELETE FROM lumi_current_state WHERE id = ?').run('current')
}
