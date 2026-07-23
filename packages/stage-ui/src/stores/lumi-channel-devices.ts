import type { LumiChannelDeviceScope } from '@proj-airi/stage-shared/server-channel-qr'

import { defineStore } from 'pinia'
import { shallowRef } from 'vue'

export interface LumiChannelDeviceArchiveRecord {
  id: string
  name: string
  userId: string
  conversationId: string
  roomTitle: string
  scopes: LumiChannelDeviceScope[]
  createdAt: string
  revokedAt: string | null
  tokenHash: string
}

export interface LumiChannelDeviceArchiveSnapshot {
  version: 3
  hostInstanceId: string
  devices: LumiChannelDeviceArchiveRecord[]
  audit: LumiChannelAuditEntry[]
}

export interface LumiChannelDeviceArchiveSnapshotV2 {
  version: 2
  hostInstanceId: string
  devices: Array<Omit<LumiChannelDeviceArchiveRecord, 'scopes'> & { scopes: string[] }>
  audit: LumiChannelAuditEntry[]
}

export interface LumiChannelAuditEntry {
  id: string
  createdAt: string
  kind: 'device-created' | 'device-revoked' | 'authenticated' | 'authentication-failed' | 'disconnected' | 'event-accepted' | 'event-rejected' | 'tool-resource-started' | 'tool-resource-finished' | 'tool-resource-terminated'
  deviceId?: string
  deviceName?: string
  userId?: string
  conversationId?: string
  eventType?: string
  code?: string
  reason?: string
  retryAfterMs?: number
  remoteAddress?: string
}

export interface LumiChannelDeviceArchiveBridge {
  exportSnapshot: () => Promise<LumiChannelDeviceArchiveSnapshot>
  importSnapshot: (snapshot: LumiChannelDeviceArchiveSnapshot | LumiChannelDeviceArchiveSnapshotV2) => Promise<LumiChannelDeviceArchiveSnapshot>
  clear: () => Promise<void>
}

/** Provides the desktop-only device registry to the cross-platform Lumi archive workflow. */
export const useLumiChannelDevicesStore = defineStore('lumi-channel-devices', () => {
  const bridge = shallowRef<LumiChannelDeviceArchiveBridge | null>(null)

  function setArchiveBridge(nextBridge: LumiChannelDeviceArchiveBridge | null) {
    bridge.value = nextBridge
  }

  async function exportArchive() {
    return bridge.value ? await bridge.value.exportSnapshot() : null
  }

  async function importArchive(snapshot: LumiChannelDeviceArchiveSnapshot | LumiChannelDeviceArchiveSnapshotV2 | null) {
    if (!snapshot)
      return null
    if (!bridge.value)
      throw new Error('Lumi channel device archive requires the desktop host.')
    return await bridge.value.importSnapshot(snapshot)
  }

  async function clear() {
    await bridge.value?.clear()
  }

  return {
    setArchiveBridge,
    exportArchive,
    importArchive,
    clear,
  }
})
