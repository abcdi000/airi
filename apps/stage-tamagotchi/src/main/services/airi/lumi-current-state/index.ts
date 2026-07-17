import type { createContext } from '@moeru/eventa/adapters/electron/main'

import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { app } from 'electron'

import {
  electronLumiCurrentStateClear,
  electronLumiCurrentStateGetSnapshot,
  electronLumiCurrentStateSaveSnapshot,
  type ElectronLumiCurrentStateSnapshot,
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

let dbInstance: SqliteDatabase | null = null
let dbPathInstance = ''

async function loadSqlite(): Promise<SqliteModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<SqliteModule>
  return await dynamicImport('node:sqlite')
}

async function getDatabase(): Promise<{ db: SqliteDatabase, path: string }> {
  if (dbInstance)
    return { db: dbInstance, path: dbPathInstance }

  const sqlite = await loadSqlite()
  dbPathInstance = join(app.getPath('userData'), 'lumi-current-state.sqlite3')
  mkdirSync(dirname(dbPathInstance), { recursive: true })
  dbInstance = new sqlite.DatabaseSync(dbPathInstance)
  migrate(dbInstance)
  return { db: dbInstance, path: dbPathInstance }
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
  defineInvokeHandler(params.context, electronLumiCurrentStateGetSnapshot, async () => loadCurrentStateFromDatabase())
  defineInvokeHandler(params.context, electronLumiCurrentStateSaveSnapshot, async snapshot => saveCurrentState(snapshot))
  defineInvokeHandler(params.context, electronLumiCurrentStateClear, async () => clearCurrentState())
}

export async function loadCurrentStateFromDatabase(): Promise<ElectronLumiCurrentStateSnapshot> {
  const { db, path } = await getDatabase()
  const row = db.prepare('SELECT value_json FROM lumi_current_state WHERE id = ?').get('current')
  return {
    state: row?.value_json ? JSON.parse(String(row.value_json)) : null,
    dbPath: path,
  }
}

export async function saveCurrentState(snapshot: ElectronLumiCurrentStateSnapshot): Promise<ElectronLumiCurrentStateSnapshot> {
  const { db } = await getDatabase()
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO lumi_current_state (id, value_json, created_at, updated_at)
    VALUES ('current', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(JSON.stringify(snapshot.state ?? null), now, now)
  return await loadCurrentStateFromDatabase()
}

export async function clearCurrentState() {
  const { db } = await getDatabase()
  db.prepare('DELETE FROM lumi_current_state WHERE id = ?').run('current')
}
