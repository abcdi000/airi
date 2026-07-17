import {
  migratedLumiContextManifest,
  migratedLumiMemories,
  migratedLumiStateSnapshots,
  migratedLumiUserProfiles,
} from '../../../lumi-runtime/src'

export const LUMI_MIGRATED_CHAT_EXPORT_PATH = 'docs/lumi/migrated-data/airi-chat-sessions-lumi.json'

export interface LumiMigrationSummary {
  activeMemoryCount: number
  memoryCount: number
  profileCount: number
  stateCount: number
  chatSessionCount: number
  generatedAt: string
  chatExportPath: string
  sampleMemories: string[]
}

export function getLumiMigrationSummary(): LumiMigrationSummary {
  return {
    activeMemoryCount: migratedLumiContextManifest.activeMemoryCount,
    memoryCount: migratedLumiContextManifest.memoryCount,
    profileCount: migratedLumiContextManifest.profileCount,
    stateCount: migratedLumiContextManifest.stateCount,
    chatSessionCount: 125,
    generatedAt: migratedLumiContextManifest.generatedAt,
    chatExportPath: LUMI_MIGRATED_CHAT_EXPORT_PATH,
    sampleMemories: migratedLumiMemories
      .slice(0, 4)
      .map(memory => memory.content),
  }
}

export function hasLumiMigratedRuntimeContext(): boolean {
  return (
    migratedLumiContextManifest.activeMemoryCount > 0
    && migratedLumiMemories.length > 0
    && migratedLumiUserProfiles.length > 0
    && migratedLumiStateSnapshots.length > 0
  )
}
