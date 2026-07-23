import type { LumiStateSnapshot } from '../../../../lumi-runtime/src'
import type { LumiRoomLedgerSnapshot } from '../../database/repos/lumi-room-ledger.repo'
import type { BackgroundEntry } from '../../stores/background'
import type { LumiChannelDeviceArchiveSnapshot, LumiChannelDeviceArchiveSnapshotV2 } from '../../stores/lumi-channel-devices'
import type { LumiCurrentState } from '../../stores/lumi-current-state'
import type { LumiIdentitySnapshot } from '../../stores/lumi-identity'
import type { LumiMemoryPersistenceSnapshot } from '../../stores/lumi-memory'
import type { LumiUserProfileSnapshot } from '../../stores/lumi-user-profile'
import type { ChatSessionsExport } from '../../types/chat-session'

export const LUMI_DATA_ARCHIVE_FORMAT = 'lumi-data-archive:v6'
export const LUMI_DATA_ARCHIVE_FORMAT_V5 = 'lumi-data-archive:v5'
export const LUMI_DATA_ARCHIVE_FORMAT_V4 = 'lumi-data-archive:v4'
export const LUMI_DATA_ARCHIVE_FORMAT_V3 = 'lumi-data-archive:v3'
export const LUMI_DATA_ARCHIVE_FORMAT_V2 = 'lumi-data-archive:v2'
export const LUMI_DATA_ARCHIVE_FORMAT_V1 = 'lumi-data-archive:v1'

export const LUMI_ARCHIVE_LOCAL_STORAGE_KEYS = [
  'settings/lumi/current-state/update-every-turns',
  'settings/lumi/main-timeline/max-recent-chat-messages-for-prompt',
  'settings/lumi/tool-mesh/operator-present-mode',
  'runtime/lumi/tool-mesh/tool-use-logs',
  'runtime/lumi/tool-mesh/recent-plans',
  'settings/lumi/agent/enabled',
  'settings/lumi/agent/claude-command',
  'settings/lumi/agent/sandbox-root',
  'settings/lumi/agent/trusted-projects',
  'settings/lumi/agent/self-project-roots',
  'settings/lumi/agent/forbidden-paths',
  'settings/lumi/agent/default-permission-mode',
  'settings/lumi/agent/sandbox-auto-approve',
  'settings/lumi/agent/max-task-timeout-ms',
  'settings/lumi/agent/allowed-conda-envs',
  'settings/lumi/agent/default-conda-env',
  'settings/plugins/lumi-chat-mini/enabled',
  'settings/plugins/lumi-chat-mini/always-on-top',
  'settings/plugins/lumi-chat-mini/inactive-opacity',
  'settings/plugins/lumi-chat-mini/edge-dock-enabled',
  'settings/plugins/lumi-chat-mini/edge-dock-threshold',
  'settings/plugins/lumi-chat-mini/edge-dock-visible-size',
  'settings/plugins/lumi-diary/auto-write-enabled',
  'settings/plugins/lumi-diary/auto-write-time',
  'settings/plugins/lumi-diary/last-run-date',
  'settings/plugins/lumi-diary/last-run-at',
  'settings/plugins/lumi-proactive-vision/enabled',
  'settings/plugins/lumi-proactive-vision/source-id',
  'settings/plugins/lumi-proactive-vision/workload-id',
  'settings/plugins/lumi-proactive-vision/min-interval-ms',
  'settings/plugins/lumi-proactive-vision/max-interval-ms',
  'settings/plugins/lumi-proactive-vision/cooldown-ms',
  'settings/plugins/lumi-proactive-vision/only-lumi-card',
  'settings/plugins/lumi-proactive-vision/autonomous-enabled',
  'settings/plugins/lumi-proactive-vision/quiet-mode',
  'settings/plugins/lumi-proactive-vision/summary-mode',
  'settings/plugins/lumi-proactive-vision/idle-daily-max-messages',
  'settings/plugins/lumi-proactive-vision/agent-suggestion-cooldown-ms',
  'settings/plugins/lumi-proactive-vision/no-effect-threshold',
  'settings/plugins/lumi-proactive-vision/allow-autonomous-sandbox-tasks',
  'settings/plugins/lumi-proactive-vision/lumi-world-root',
  'settings/plugins/lumi-proactive-vision/decision-log',
  'settings/plugins/lumi-proactive-vision/private-notes',
  'settings/plugins/lumi-proactive-vision/runtime-logs',
  'settings/plugins/lumi-proactive-vision/setting-change-audit',
  'settings/plugins/lumi-proactive-vision/today-proactive-date',
  'settings/plugins/lumi-proactive-vision/today-proactive-message-count',
  'settings/plugins/lumi-proactive-vision/ignored-proactive-streak',
  'settings/plugins/lumi-proactive-vision/low-change-streak',
  'settings/plugins/lumi-proactive-vision/no-progress-streak',
  'settings/plugins/lumi-proactive-vision/awaiting-response-since',
  'settings/plugins/lumi-proactive-vision/last-autonomous-agent-at',
  'settings/plugins/lumi-proactive-vision/autonomous-life',
  'settings/plugins/lumi-proactive-vision/self-todo',
  'settings/plugins/lumi-proactive-vision/lumiworld-manifest',
  'settings/plugins/lumi-proactive-vision/life-tick-enabled',
  'settings/plugins/lumi-proactive-vision/life-tick-min-interval-ms',
  'settings/plugins/lumi-proactive-vision/life-tick-max-interval-ms',
  'settings/plugins/lumi-proactive-vision/life-daily-action-budget',
  'runtime/lumi-proactive-vision/status',
  'runtime/lumi-proactive-vision/return-context',
  'settings/plugins/lumi-self-adjustment/enabled',
  'settings/plugins/lumi-self-adjustment/allow-proactive-vision-timing',
  'settings/plugins/lumi-self-adjustment/allow-consciousness-model-switch',
  'settings/plugins/lumi-self-adjustment/allow-ollama-thinking-mode',
  'settings/plugins/lumi-self-adjustment/allow-speech-playback-volume',
  'settings/plugins/lumi-self-adjustment/allow-prompt-history-limit',
  'settings/plugins/lumi-self-adjustment/change-log',
] as const

export interface LumiEmotionArchiveSnapshot {
  snapshot: LumiStateSnapshot | null
  seedId: string
  exportedAt: string
}

export interface LumiCurrentStateArchiveSnapshot {
  state: LumiCurrentState | null
  updateEveryTurns: number
  exportedAt: string
  dbPath?: string
}

export interface SerializedBackgroundEntry {
  id: string
  type: 'scene' | 'journal' | 'selfie'
  characterId: string | null
  title: string
  prompt?: string
  remixId?: string
  createdAt: number
  mimeType: string
  dataBase64: string
}

export interface LumiUserDataArchiveSections {
  chatSessions: ChatSessionsExport
  lumiMemory: LumiMemoryPersistenceSnapshot
  lumiUserProfile: LumiUserProfileSnapshot
  lumiCurrentState: LumiCurrentStateArchiveSnapshot
  lumiEmotion: LumiEmotionArchiveSnapshot
}

export interface LumiDataArchiveV1 {
  format: typeof LUMI_DATA_ARCHIVE_FORMAT_V1
  version: 1
  source: 'lumi'
  exportedAt: string
  sections: LumiUserDataArchiveSections & {
    backgroundEntries: SerializedBackgroundEntry[]
    localStorage: Record<string, string>
  }
}

export interface LumiDataArchiveV2 {
  format: typeof LUMI_DATA_ARCHIVE_FORMAT_V2
  version: 2
  source: 'lumi'
  exportedAt: string
  sections: {
    identity: LumiIdentitySnapshot
    users: Record<string, LumiUserDataArchiveSections>
    backgroundEntries: SerializedBackgroundEntry[]
    localStorage: Record<string, string>
  }
}

export interface LumiDataArchiveV3 {
  format: typeof LUMI_DATA_ARCHIVE_FORMAT_V3
  version: 3
  source: 'lumi'
  exportedAt: string
  sections: LumiDataArchiveV2['sections'] & {
    roomLedgers: Record<string, LumiRoomLedgerSnapshot>
  }
}

export interface LumiDataArchiveV4 {
  format: typeof LUMI_DATA_ARCHIVE_FORMAT_V4
  version: 4
  source: 'lumi'
  exportedAt: string
  sections: LumiDataArchiveV3['sections'] & {
    channelDevices: null | {
      version: 1
      hostInstanceId: string
      devices: LumiChannelDeviceArchiveSnapshotV2['devices']
    }
  }
}

export interface LumiDataArchiveV5 {
  format: typeof LUMI_DATA_ARCHIVE_FORMAT_V5
  version: 5
  source: 'lumi'
  exportedAt: string
  sections: LumiDataArchiveV3['sections'] & {
    channelDevices: LumiChannelDeviceArchiveSnapshotV2 | null
  }
}

export interface LumiDataArchive {
  format: typeof LUMI_DATA_ARCHIVE_FORMAT
  version: 6
  source: 'lumi'
  exportedAt: string
  sections: LumiDataArchiveV3['sections'] & {
    channelDevices: LumiChannelDeviceArchiveSnapshot | null
  }
}

export function isLumiDataArchivePayload(payload: unknown): payload is LumiDataArchive | LumiDataArchiveV5 | LumiDataArchiveV4 | LumiDataArchiveV3 | LumiDataArchiveV2 | LumiDataArchiveV1 {
  if (!payload || typeof payload !== 'object')
    return false
  const record = payload as { format?: unknown, version?: unknown, sections?: unknown }
  const recognizedFormat = (record.format === LUMI_DATA_ARCHIVE_FORMAT && record.version === 6)
    || (record.format === LUMI_DATA_ARCHIVE_FORMAT_V5 && record.version === 5)
    || (record.format === LUMI_DATA_ARCHIVE_FORMAT_V4 && record.version === 4)
    || (record.format === LUMI_DATA_ARCHIVE_FORMAT_V3 && record.version === 3)
    || (record.format === LUMI_DATA_ARCHIVE_FORMAT_V2 && record.version === 2)
    || (record.format === LUMI_DATA_ARCHIVE_FORMAT_V1 && record.version === 1)
  return recognizedFormat && !!record.sections && typeof record.sections === 'object'
}

export function exportLumiLocalStorageSnapshot(keys: readonly string[] = LUMI_ARCHIVE_LOCAL_STORAGE_KEYS) {
  const snapshot: Record<string, string> = {}
  if (typeof localStorage === 'undefined')
    return snapshot

  for (const key of keys) {
    const value = localStorage.getItem(key)
    if (value !== null)
      snapshot[key] = value
  }
  return snapshot
}

export function restoreLumiLocalStorageSnapshot(
  snapshot: Record<string, unknown>,
  keys: readonly string[] = LUMI_ARCHIVE_LOCAL_STORAGE_KEYS,
) {
  if (typeof localStorage === 'undefined')
    return

  const allowedKeys = new Set(keys)
  for (const [key, value] of Object.entries(snapshot)) {
    if (!allowedKeys.has(key) || typeof value !== 'string')
      continue
    localStorage.setItem(key, value)
    if (typeof window !== 'undefined' && typeof StorageEvent !== 'undefined')
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: value, storageArea: localStorage }))
  }
}

export async function serializeBackgroundEntries(entries: BackgroundEntry[]): Promise<SerializedBackgroundEntry[]> {
  return Promise.all(entries
    .filter((entry): entry is BackgroundEntry & { type: 'scene' | 'journal' | 'selfie' } => entry.type !== 'builtin')
    .map(async entry => ({
      id: entry.id,
      type: entry.type,
      characterId: entry.characterId,
      title: entry.title,
      prompt: entry.prompt,
      remixId: entry.remixId,
      createdAt: entry.createdAt,
      mimeType: entry.blob.type || 'application/octet-stream',
      dataBase64: await blobToBase64(entry.blob),
    })))
}

export async function deserializeBackgroundEntries(entries: SerializedBackgroundEntry[]): Promise<BackgroundEntry[]> {
  return Promise.all(entries.map(async entry => ({
    id: entry.id,
    type: entry.type,
    characterId: entry.characterId,
    title: entry.title,
    prompt: entry.prompt,
    remixId: entry.remixId,
    createdAt: entry.createdAt,
    blob: await base64ToBlob(entry.dataBase64, entry.mimeType),
  })))
}

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return bytesToBase64(bytes)
}

async function base64ToBlob(base64: string, mimeType: string) {
  return new Blob([base64ToBytes(base64)], { type: mimeType })
}

function bytesToBase64(bytes: Uint8Array) {
  if (typeof btoa === 'function') {
    let binary = ''
    for (const byte of bytes)
      binary += String.fromCharCode(byte)
    return btoa(binary)
  }

  throw new Error('No Base64 encoder is available in this runtime')
}

function base64ToBytes(base64: string) {
  if (typeof atob === 'function') {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1)
      bytes[index] = binary.charCodeAt(index)
    return bytes
  }

  throw new Error('No Base64 decoder is available in this runtime')
}
