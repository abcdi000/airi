import type { FileHandle } from 'node:fs/promises'

import process from 'node:process'

import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

import { BrowserProfileInUseError } from './browser-contracts'

export interface BrowserProfileLease {
  release: () => Promise<void>
}

interface LeaseRecord {
  pid: number
  token: string
  createdAt: string
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0)
    return false

  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EPERM'
  }
}

async function readLeaseRecord(path: string): Promise<LeaseRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<LeaseRecord>
    if (typeof parsed.pid !== 'number' || typeof parsed.token !== 'string')
      return undefined
    return {
      pid: parsed.pid,
      token: parsed.token,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    }
  }
  catch {
    return undefined
  }
}

async function writeLease(handle: FileHandle, record: LeaseRecord): Promise<void> {
  await handle.writeFile(JSON.stringify(record), 'utf8')
  await handle.sync()
}

/**
 * Acquires an inter-process lease for one persistent browser profile.
 *
 * Use when:
 * - Starting either browser backend with a persistent context
 * - Preventing two Lumi processes from opening the same Chrome profile
 *
 * Expects:
 * - `profilePath` identifies the exact persistent profile directory
 *
 * Returns:
 * - A lease whose release method only removes its own lock token
 */
export async function acquireBrowserProfileLease(profilePath: string): Promise<BrowserProfileLease> {
  await mkdir(profilePath, { recursive: true })
  const lockPath = join(profilePath, '.lumi-profile.lock')
  const token = randomUUID()
  const record: LeaseRecord = {
    pid: process.pid,
    token,
    createdAt: new Date().toISOString(),
  }

  let handle: FileHandle
  try {
    handle = await open(lockPath, 'wx')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw error

    const existing = await readLeaseRecord(lockPath)
    if (existing && processIsAlive(existing.pid)) {
      throw new BrowserProfileInUseError(
        `Browser profile is already in use by process ${existing.pid}: ${profilePath}`,
      )
    }

    await rm(lockPath, { force: true })
    handle = await open(lockPath, 'wx')
  }

  await writeLease(handle, record)
  await handle.close()
  let released = false

  return {
    release: async () => {
      if (released)
        return
      released = true
      const current = await readLeaseRecord(lockPath)
      if (current?.token === token)
        await rm(lockPath, { force: true })
    },
  }
}
