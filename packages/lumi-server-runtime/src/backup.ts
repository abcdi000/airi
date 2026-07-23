import type { LumiServerBackupV1, LumiServerDatabase } from './database'

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const LUMI_SERVER_BACKUP_MANIFEST_FORMAT = 'lumi-server-backup-manifest:v1'

export interface LumiServerBackupManifest {
  format: typeof LUMI_SERVER_BACKUP_MANIFEST_FORMAT
  createdAt: string
  backupFile: string
  sha256: string
  byteLength: number
  sectionCounts: Record<keyof LumiServerBackupV1['sections'], number>
}

/** Writes a checksummed, atomic server disaster-recovery archive. */
export async function writeLumiServerBackup(database: LumiServerDatabase, directory: string) {
  const targetDirectory = resolve(directory)
  await mkdir(targetDirectory, { recursive: true })
  const backup = database.exportBackup()
  const bytes = Buffer.from(`${JSON.stringify(backup, null, 2)}\n`, 'utf8')
  const stamp = backup.exportedAt.replaceAll(':', '-').replaceAll('.', '-')
  const backupFile = `lumi-server-backup-${stamp}.json`
  const manifestFile = `lumi-server-backup-${stamp}.manifest.json`
  const manifest: LumiServerBackupManifest = {
    format: LUMI_SERVER_BACKUP_MANIFEST_FORMAT,
    createdAt: backup.exportedAt,
    backupFile,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    sectionCounts: Object.fromEntries(
      Object.entries(backup.sections).map(([key, rows]) => [key, rows.length]),
    ) as LumiServerBackupManifest['sectionCounts'],
  }
  const backupPath = join(targetDirectory, backupFile)
  const manifestPath = join(targetDirectory, manifestFile)
  await atomicWrite(backupPath, bytes)
  await atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))
  return { backupPath, manifestPath, manifest }
}

/** Verifies the manifest, payload hash, format, and all declared section counts. */
export async function verifyLumiServerBackup(manifestPath: string) {
  const absoluteManifestPath = resolve(manifestPath)
  const manifest = JSON.parse(await readFile(absoluteManifestPath, 'utf8')) as LumiServerBackupManifest
  if (manifest.format !== LUMI_SERVER_BACKUP_MANIFEST_FORMAT)
    throw new Error('Unsupported Lumi Server backup manifest')
  const backupPath = join(resolve(absoluteManifestPath, '..'), manifest.backupFile)
  const bytes = await readFile(backupPath)
  if (bytes.byteLength !== manifest.byteLength || sha256(bytes) !== manifest.sha256)
    throw new Error('Lumi Server backup checksum mismatch')
  const backup = JSON.parse(bytes.toString('utf8')) as LumiServerBackupV1
  if (backup.format !== 'lumi-server-backup:v1' || backup.version !== 1)
    throw new Error('Unsupported Lumi Server backup payload')
  for (const [section, expected] of Object.entries(manifest.sectionCounts)) {
    const rows = backup.sections[section as keyof LumiServerBackupV1['sections']]
    if (!Array.isArray(rows) || rows.length !== expected)
      throw new Error(`Lumi Server backup section count mismatch: ${section}`)
  }
  return { backupPath, manifest, backup }
}

/** Restores a verified backup; call only while public and manager listeners are stopped. */
export async function restoreLumiServerBackup(database: LumiServerDatabase, manifestPath: string) {
  const verified = await verifyLumiServerBackup(manifestPath)
  database.restoreBackup(verified.backup)
  return verified.manifest
}

async function atomicWrite(path: string, bytes: Uint8Array) {
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 })
  await rename(temporaryPath, path)
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}
