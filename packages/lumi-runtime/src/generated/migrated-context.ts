import type { LumiMemoryFragment, LumiStateSnapshot, LumiUserProfile } from '../types'

export const migratedLumiContextManifest = {
  source: 'local-only',
  generatedAt: 'not-generated',
  memoryCount: 0,
  activeMemoryCount: 0,
  profileCount: 0,
  stateCount: 0,
  notes: [
    'Private Lumi memories are intentionally excluded from source control.',
    'Run scripts/lumi/export_lumi_migration.py locally to regenerate this file when needed.',
    'Do not commit regenerated private memory content to public or shared branches.',
  ],
} as const

export const migratedLumiAllMemories = [] as LumiMemoryFragment[]
export const migratedLumiMemories = [] as LumiMemoryFragment[]
export const migratedLumiUserProfiles = [] as LumiUserProfile[]
export const migratedLumiStateSnapshots = [] as LumiStateSnapshot[]
