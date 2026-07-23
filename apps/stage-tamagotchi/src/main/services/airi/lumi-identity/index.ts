import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type { BrowserWindow } from 'electron'

import type { ElectronLumiExternalIdentityRecord, ElectronLumiIdentitySnapshot, ElectronLumiUserRecord } from '../../../../shared/eventa'

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { defineInvokeHandler } from '@moeru/eventa'
import { app } from 'electron'

import {

  electronLumiIdentityChanged,
  electronLumiIdentityCreateUser,
  electronLumiIdentityGetSnapshot,
  electronLumiIdentityLinkExternalIdentity,
  electronLumiIdentityReplaceSnapshot,
  electronLumiIdentitySetActiveUser,
  electronLumiIdentitySetRuntimeBusy,

  electronLumiIdentityUpdateUser,

} from '../../../../shared/eventa'

type SqliteValue = string | number | null

interface SqliteStatement {
  all: (...values: SqliteValue[]) => Record<string, unknown>[]
  get: (...values: SqliteValue[]) => Record<string, unknown> | undefined
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
const MOUSSY_USER_ID = 'lumi-user-00000000-0000-4000-8000-000000000002'
const IDENTITY_MIGRATION_VERSION = 'multi-user-v1'
const INTERNAL_USER_ID_PATTERN = /^lumi-user-[A-Za-z0-9-]{8,80}$/

let dbInstance: SqliteDatabase | null = null
let dbPathInstance = ''
const rendererContexts = new Map<number, ReturnType<typeof createContext>['context']>()
const busyRendererIds = new Set<number>()

async function loadSqlite(): Promise<SqliteModule> {
  // NOTICE:
  // Electron must resolve `node:sqlite` at runtime instead of bundling it into the main-process output.
  // A direct dynamic import is rewritten by the build pipeline, so this matches the existing Lumi SQLite services.
  // Source/context: `lumi-memory/index.ts`, `lumi-current-state/index.ts`, and `lumi-user-profile/index.ts`.
  // Removal condition: the Electron build externalizes `node:sqlite` without rewriting dynamic imports.
  // eslint-disable-next-line no-new-func
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<SqliteModule>
  return await dynamicImport('node:sqlite')
}

async function getDatabase() {
  if (dbInstance)
    return { db: dbInstance, path: dbPathInstance }

  const sqlite = await loadSqlite()
  dbPathInstance = join(app.getPath('userData'), 'lumi-users.sqlite3')
  mkdirSync(dirname(dbPathInstance), { recursive: true })
  dbInstance = new sqlite.DatabaseSync(dbPathInstance)
  migrate(dbInstance)
  seedKnownUsers(dbInstance)
  return { db: dbInstance, path: dbPathInstance }
}

function migrate(db: SqliteDatabase) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS lumi_users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      preferred_address TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lumi_external_identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES lumi_users(id) ON DELETE CASCADE,
      UNIQUE(provider, provider_instance_id, external_user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_lumi_external_identities_user
      ON lumi_external_identities(user_id);

    CREATE TABLE IF NOT EXISTS lumi_identity_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

function seedKnownUsers(db: SqliteDatabase) {
  const now = new Date().toISOString()
  const insert = db.prepare(`
    INSERT OR IGNORE INTO lumi_users (
      id, display_name, preferred_address, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?)
  `)
  insert.run(DOGGY_USER_ID, 'Doggy', 'Doggy', 'owner', now, now)
  insert.run(MOUSSY_USER_ID, 'Moussy', 'Moussy', 'member', now, now)

  setMetaIfMissing(db, 'active_user_id', DOGGY_USER_ID, now)
  setMetaIfMissing(db, 'migration_version', IDENTITY_MIGRATION_VERSION, now)
}

function setMetaIfMissing(db: SqliteDatabase, key: string, value: string, now: string) {
  db.prepare(`
    INSERT OR IGNORE INTO lumi_identity_meta (key, value, updated_at)
    VALUES (?, ?, ?)
  `).run(key, value, now)
}

export function createLumiIdentityService(params: {
  context: ReturnType<typeof createContext>['context']
  window: BrowserWindow
}) {
  const rendererId = params.window.webContents.id
  rendererContexts.set(rendererId, params.context)
  params.window.webContents.once('destroyed', () => {
    rendererContexts.delete(rendererId)
    busyRendererIds.delete(rendererId)
  })

  defineInvokeHandler(params.context, electronLumiIdentityGetSnapshot, async () => getSnapshot())
  defineInvokeHandler(params.context, electronLumiIdentityCreateUser, async input => mutateAndBroadcast(() => createUser(input)))
  defineInvokeHandler(params.context, electronLumiIdentityUpdateUser, async input => mutateAndBroadcast(() => updateUser(input)))
  defineInvokeHandler(params.context, electronLumiIdentitySetActiveUser, async (input) => {
    if (busyRendererIds.size > 0)
      throw new Error('Lumi is busy in another window. Wait for the current response or task to finish before switching users.')
    return await mutateAndBroadcast(() => setActiveUser(input.userId))
  })
  defineInvokeHandler(params.context, electronLumiIdentityLinkExternalIdentity, async input => linkLumiExternalIdentity(input))
  defineInvokeHandler(params.context, electronLumiIdentityReplaceSnapshot, async snapshot => mutateAndBroadcast(() => replaceSnapshot(snapshot)))
  defineInvokeHandler(params.context, electronLumiIdentitySetRuntimeBusy, async ({ busy }) => {
    if (busy)
      busyRendererIds.add(rendererId)
    else
      busyRendererIds.delete(rendererId)
  })
}

async function mutateAndBroadcast(operation: () => Promise<ElectronLumiIdentitySnapshot>) {
  const snapshot = await operation()
  for (const [rendererId, context] of rendererContexts) {
    try {
      context.emit(electronLumiIdentityChanged, snapshot)
    }
    catch {
      rendererContexts.delete(rendererId)
      busyRendererIds.delete(rendererId)
    }
  }
  return snapshot
}

async function replaceSnapshot(snapshot: ElectronLumiIdentitySnapshot) {
  const { db } = await getDatabase()
  validateSnapshot(snapshot)
  if (!snapshot.users.some(user => user.id === DOGGY_USER_ID && user.role === 'owner'))
    throw new Error('Lumi identity archive must contain the Doggy owner record')
  if (!snapshot.users.some(user => user.id === snapshot.activeUserId && user.status === 'active'))
    throw new Error('Lumi identity archive has an invalid active user')

  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('DELETE FROM lumi_external_identities; DELETE FROM lumi_users;')
    const insertUser = db.prepare(`
      INSERT INTO lumi_users (id, display_name, preferred_address, role, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const user of snapshot.users) {
      insertUser.run(
        normalizeIdentityPart(user.id),
        normalizeLabel(user.displayName),
        normalizeLabel(user.preferredAddress),
        user.role,
        user.status,
        user.createdAt,
        user.updatedAt,
      )
    }
    const insertExternal = db.prepare(`
      INSERT INTO lumi_external_identities (id, user_id, provider, provider_instance_id, external_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    for (const identity of snapshot.externalIdentities) {
      insertExternal.run(identity.id, identity.userId, identity.provider, identity.providerInstanceId, identity.externalUserId, identity.createdAt)
    }
    setMeta(db, 'active_user_id', snapshot.activeUserId)
    setMeta(db, 'migration_version', IDENTITY_MIGRATION_VERSION)
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return await getSnapshot()
}

function validateSnapshot(snapshot: ElectronLumiIdentitySnapshot) {
  const userIds = new Set<string>()
  for (const user of snapshot.users) {
    if (!INTERNAL_USER_ID_PATTERN.test(user.id))
      throw new Error('Lumi identity archive contains an invalid internal user ID')
    if (userIds.has(user.id))
      throw new Error('Lumi identity archive contains duplicate users')
    if (!normalizeLabel(user.displayName) || !normalizeLabel(user.preferredAddress))
      throw new Error('Lumi identity archive contains an unnamed user')
    if (!['owner', 'member', 'guest'].includes(user.role) || !['active', 'inactive'].includes(user.status))
      throw new Error('Lumi identity archive contains an invalid user role or status')
    userIds.add(user.id)
  }

  const externalKeys = new Set<string>()
  for (const identity of snapshot.externalIdentities) {
    const provider = normalizeIdentityPart(identity.provider)
    const providerInstanceId = normalizeIdentityPart(identity.providerInstanceId)
    const externalUserId = normalizeIdentityPart(identity.externalUserId)
    if (!userIds.has(identity.userId) || !provider || !providerInstanceId || !externalUserId)
      throw new Error('Lumi identity archive contains an invalid external identity')
    const key = `${provider}\u0000${providerInstanceId}\u0000${externalUserId}`
    if (externalKeys.has(key))
      throw new Error('Lumi identity archive contains duplicate external identities')
    externalKeys.add(key)
  }
}

async function getSnapshot(): Promise<ElectronLumiIdentitySnapshot> {
  const { db, path } = await getDatabase()
  const users = db.prepare(`
    SELECT * FROM lumi_users
    ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, created_at ASC
  `).all().map(rowToUser)
  const externalIdentities = db.prepare(`
    SELECT * FROM lumi_external_identities
    ORDER BY created_at ASC
  `).all().map(rowToExternalIdentity)
  const requestedActiveUserId = getMeta(db, 'active_user_id') || DOGGY_USER_ID
  const activeUserId = users.some(user => user.id === requestedActiveUserId && user.status === 'active')
    ? requestedActiveUserId
    : users.find(user => user.status === 'active')?.id ?? DOGGY_USER_ID

  return {
    users,
    externalIdentities,
    activeUserId,
    migrationVersion: getMeta(db, 'migration_version') || '',
    dbPath: path,
  }
}

async function createUser(input: { displayName: string, preferredAddress?: string }) {
  const { db } = await getDatabase()
  const displayName = normalizeLabel(input.displayName)
  if (!displayName)
    throw new Error('User display name is required')
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO lumi_users (
      id, display_name, preferred_address, role, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'member', 'active', ?, ?)
  `).run(`lumi-user-${randomUUID()}`, displayName, normalizeLabel(input.preferredAddress) || displayName, now, now)
  return await getSnapshot()
}

async function updateUser(input: { id: string, displayName?: string, preferredAddress?: string, status?: string }) {
  const { db } = await getDatabase()
  const current = db.prepare('SELECT * FROM lumi_users WHERE id = ?').get(input.id)
  if (!current)
    throw new Error('Lumi user was not found')

  const displayName = input.displayName === undefined ? String(current.display_name) : normalizeLabel(input.displayName)
  const preferredAddress = input.preferredAddress === undefined ? String(current.preferred_address) : normalizeLabel(input.preferredAddress)
  const status = input.status === 'inactive' ? 'inactive' : input.status === 'active' ? 'active' : String(current.status)
  if (!displayName || !preferredAddress)
    throw new Error('User name and preferred address are required')
  if (input.id === DOGGY_USER_ID && status === 'inactive')
    throw new Error('The owner user cannot be disabled')

  db.prepare(`
    UPDATE lumi_users
    SET display_name = ?, preferred_address = ?, status = ?, updated_at = ?
    WHERE id = ?
  `).run(displayName, preferredAddress, status, new Date().toISOString(), input.id)
  return await getSnapshot()
}

async function setActiveUser(userId: string) {
  const { db } = await getDatabase()
  const user = db.prepare('SELECT id FROM lumi_users WHERE id = ? AND status = ?').get(userId, 'active')
  if (!user)
    throw new Error('Active Lumi user was not found')
  setMeta(db, 'active_user_id', userId)
  return await getSnapshot()
}

/** Links a trusted channel-owned account to one active Lumi user and broadcasts the new snapshot. */
export async function linkLumiExternalIdentity(input: {
  userId: string
  provider: string
  providerInstanceId: string
  externalUserId: string
}) {
  return await mutateAndBroadcast(async () => {
    const { db } = await getDatabase()
    const user = db.prepare('SELECT id FROM lumi_users WHERE id = ? AND status = ?').get(input.userId, 'active')
    if (!user)
      throw new Error('Cannot link an identity to an unavailable Lumi user')
    const provider = normalizeIdentityPart(input.provider)
    const providerInstanceId = normalizeIdentityPart(input.providerInstanceId)
    const externalUserId = normalizeIdentityPart(input.externalUserId)
    if (!provider || !providerInstanceId || !externalUserId)
      throw new Error('External identity fields are required')

    db.prepare(`
      INSERT INTO lumi_external_identities (
        id, user_id, provider, provider_instance_id, external_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, provider_instance_id, external_user_id) DO UPDATE SET
        user_id = excluded.user_id
    `).run(`lumi-external-${randomUUID()}`, input.userId, provider, providerInstanceId, externalUserId, new Date().toISOString())
    return await getSnapshot()
  })
}

function setMeta(db: SqliteDatabase, key: string, value: string) {
  db.prepare(`
    INSERT INTO lumi_identity_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, new Date().toISOString())
}

function getMeta(db: SqliteDatabase, key: string) {
  const row = db.prepare('SELECT value FROM lumi_identity_meta WHERE key = ?').get(key)
  return typeof row?.value === 'string' ? row.value : ''
}

function rowToUser(row: Record<string, unknown>): ElectronLumiUserRecord {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    preferredAddress: String(row.preferred_address),
    role: row.role === 'owner' || row.role === 'guest' ? row.role : 'member',
    status: row.status === 'inactive' ? 'inactive' : 'active',
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function rowToExternalIdentity(row: Record<string, unknown>): ElectronLumiExternalIdentityRecord {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    provider: String(row.provider),
    providerInstanceId: String(row.provider_instance_id),
    externalUserId: String(row.external_user_id),
    createdAt: String(row.created_at),
  }
}

function normalizeLabel(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 80) : ''
}

function normalizeIdentityPart(value: unknown) {
  return typeof value === 'string' ? value.trim().slice(0, 160) : ''
}
