import type { LumiRuntimeRole } from '@proj-airi/lumi-online'

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app } from 'electron'

export type LumiClientRuntimeMode = Extract<LumiRuntimeRole, 'offline-client' | 'online-client'>

interface PersistedRuntimeRole {
  mode: LumiClientRuntimeMode
}

/** Reads the client role before local model and tool processes are started. */
export async function readLumiClientRuntimeMode(): Promise<LumiClientRuntimeMode> {
  try {
    const parsed = JSON.parse(await readFile(runtimeRolePath(), 'utf8')) as Partial<PersistedRuntimeRole>
    return parsed.mode === 'online-client' ? 'online-client' : 'offline-client'
  }
  catch {
    return 'offline-client'
  }
}

/** Atomically persists the client role used during the next desktop startup. */
export async function writeLumiClientRuntimeMode(mode: LumiClientRuntimeMode) {
  const target = runtimeRolePath()
  const temporary = `${target}.tmp`
  await writeFile(temporary, JSON.stringify({ mode } satisfies PersistedRuntimeRole), 'utf8')
  await rename(temporary, target)
}

function runtimeRolePath() {
  return join(app.getPath('userData'), 'lumi-runtime-role.json')
}
