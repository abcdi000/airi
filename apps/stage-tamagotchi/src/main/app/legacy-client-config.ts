import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

const MIGRATION_VERSION = 1
const MARKER_FILE = '.lumi-client-config-migration-v1.json'
const CONFIG_ITEMS = [
  'Local Storage',
  'IndexedDB',
  'WebStorage',
  'File System',
  'plugins',
  'mcp',
  'app-config.json',
  'app-options.json',
  'artistry-options.json',
  'mcp.json',
  'plugins-v1.json',
  'server-channel-config.json',
  'server-channel-devices.json',
  'windows-caption-config.json',
  'windows-minecraft-mcp-monitor-config.json',
  'windows-mini-chat-config.json',
  'windows-widgets-config.json',
] as const

/** Describes a completed legacy renderer-configuration migration. */
export interface LegacyClientConfigMigrationResult {
  /** Whether this invocation copied legacy configuration. */
  migrated: boolean
  /** Human-readable reason when migration was skipped. */
  reason?: 'same-directory' | 'already-migrated' | 'legacy-config-missing'
  /** Backup created before replacing any existing target configuration. */
  backupPath?: string
  /** Profile items restored from the legacy client. */
  copiedItems?: string[]
}

/**
 * Restores legacy Chromium and desktop configuration into a new Lumi client profile.
 *
 * Use when:
 * - Product renaming or an explicit `APP_USER_DATA_PATH` points Lumi at a fresh profile.
 * - Existing model, module, plugin, and MCP settings must survive that profile change.
 *
 * Expects:
 * - Both paths are absolute user-data directories.
 * - No BrowserWindow has opened the target Chromium profile yet.
 *
 * Returns:
 * - A migration report, including the rollback backup when files were copied.
 */
export async function migrateLegacyClientConfig(input: { legacyUserDataPath: string, targetUserDataPath: string }): Promise<LegacyClientConfigMigrationResult> {
  const source = resolve(input.legacyUserDataPath)
  const target = resolve(input.targetUserDataPath)
  if (source === target)
    return { migrated: false, reason: 'same-directory' }

  if (await pathExists(join(target, MARKER_FILE)))
    return { migrated: false, reason: 'already-migrated' }

  // Renderer module/provider settings live in Chromium LevelDB. Copying only the
  // SQLite memory databases leaves the settings UI looking like a fresh install.
  if (!await pathExists(join(source, 'Local Storage', 'leveldb')))
    return { migrated: false, reason: 'legacy-config-missing' }

  await mkdir(target, { recursive: true })
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const backupRoot = join(target, 'pre-migration-backups', `client-config-${timestamp}`)
  const stageRoot = join(target, `.lumi-client-config-stage-${timestamp}`)
  const copiedItems: string[] = []

  try {
    for (const item of CONFIG_ITEMS) {
      const sourceItem = join(source, item)
      if (!await pathExists(sourceItem))
        continue

      const targetItem = join(target, item)
      if (await pathExists(targetItem))
        await copyProfileItem(targetItem, join(backupRoot, item))
      await copyProfileItem(sourceItem, join(stageRoot, item))
      copiedItems.push(item)
    }

    for (const item of copiedItems) {
      await rm(join(target, item), { recursive: true, force: true })
      await mkdir(dirname(join(target, item)), { recursive: true })
      await rename(join(stageRoot, item), join(target, item))
    }

    await rm(stageRoot, { recursive: true, force: true })
    await writeFile(join(target, MARKER_FILE), JSON.stringify({
      version: MIGRATION_VERSION,
      source,
      migratedAt: new Date().toISOString(),
      backupPath: backupRoot,
      copiedItems,
    }, null, 2), 'utf8')
    return { migrated: true, backupPath: backupRoot, copiedItems }
  }
  catch (error) {
    await restoreBackup(target, backupRoot, copiedItems)
    await rm(stageRoot, { recursive: true, force: true })
    throw error
  }
}

async function copyProfileItem(source: string, destination: string) {
  await mkdir(join(destination, '..'), { recursive: true })
  await cp(source, destination, {
    recursive: true,
    force: true,
    // Chromium recreates LevelDB lock files. Copying a live/stale lock into a
    // different profile can prevent the restored database from opening.
    filter: path => basename(path).toUpperCase() !== 'LOCK',
  })
}

async function restoreBackup(target: string, backupRoot: string, copiedItems: string[]) {
  for (const item of copiedItems) {
    const targetItem = join(target, item)
    const backupItem = join(backupRoot, item)
    await rm(targetItem, { recursive: true, force: true })
    if (await pathExists(backupItem))
      await copyProfileItem(backupItem, targetItem)
  }
}

async function pathExists(path: string) {
  try {
    await stat(path)
    return true
  }
  catch {
    return false
  }
}

/** Reads the migration marker for diagnostics without exposing profile contents. */
export async function readLegacyClientConfigMigrationMarker(targetUserDataPath: string) {
  try {
    return JSON.parse(await readFile(join(targetUserDataPath, MARKER_FILE), 'utf8')) as Record<string, unknown>
  }
  catch {
    return undefined
  }
}
