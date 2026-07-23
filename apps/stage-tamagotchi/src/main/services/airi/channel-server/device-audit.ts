import type { ElectronLumiChannelAuditEntry, ElectronLumiChannelAuditKind } from '../../../../shared/eventa'

import { randomUUID } from 'node:crypto'

import { array, literal, nullable, number, object, optional, safeParse, string, union } from 'valibot'

import { createConfig } from '../../../libs/electron/persistence'

const auditKindSchema = union([
  literal('device-created'),
  literal('device-revoked'),
  literal('authenticated'),
  literal('authentication-failed'),
  literal('disconnected'),
  literal('event-accepted'),
  literal('event-rejected'),
  literal('tool-resource-started'),
  literal('tool-resource-finished'),
  literal('tool-resource-terminated'),
])
const auditEntrySchema = object({
  id: string(),
  createdAt: string(),
  kind: auditKindSchema,
  deviceId: optional(string()),
  deviceName: optional(string()),
  userId: optional(string()),
  conversationId: optional(string()),
  eventType: optional(string()),
  code: optional(string()),
  reason: optional(string()),
  retryAfterMs: optional(number()),
  remoteAddress: optional(string()),
})
const auditStore = createConfig('server-channel', 'device-audit.json', object({
  version: literal(1),
  entries: array(auditEntrySchema),
  lastClearedAt: nullable(string()),
}), {
  default: {
    version: 1,
    entries: [],
    lastClearedAt: null,
  },
  autoHeal: true,
})
const MAX_AUDIT_ENTRIES = 2_000

export interface RecordLumiChannelAuditInput {
  kind: ElectronLumiChannelAuditKind
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

/** Initializes the bounded, content-free Lumi device audit store. */
export function setupLumiChannelDeviceAudit() {
  auditStore.setup()
}

/** Records device activity metadata without persisting credentials or message content. */
export function recordLumiChannelAudit(input: RecordLumiChannelAuditInput) {
  const snapshot = getSnapshot()
  const entry: ElectronLumiChannelAuditEntry = {
    id: `lumi-audit-${randomUUID()}`,
    createdAt: new Date().toISOString(),
    kind: input.kind,
    ...boundedFields(input),
  }
  snapshot.entries.push(entry)
  snapshot.entries = snapshot.entries.slice(-MAX_AUDIT_ENTRIES)
  auditStore.update(snapshot)
  return structuredClone(entry)
}

/** Returns newest-first audit entries for host diagnostics. */
export function listLumiChannelAudit() {
  return [...getSnapshot().entries].reverse().map(entry => structuredClone(entry))
}

/** Clears operational history while preserving device credentials. */
export function clearLumiChannelAudit() {
  auditStore.update({
    version: 1,
    entries: [],
    lastClearedAt: new Date().toISOString(),
  })
}

/** Returns chronological audit entries for trusted full-data export. */
export function exportLumiChannelAudit() {
  return getSnapshot().entries.map(entry => structuredClone(entry))
}

/** Replaces audit history from a validated trusted full-data archive. */
export function importLumiChannelAudit(entries: ElectronLumiChannelAuditEntry[]) {
  const parsed = safeParse(array(auditEntrySchema), entries)
  if (!parsed.success)
    throw new Error('Lumi channel device archive contains invalid audit entries.')
  auditStore.update({
    version: 1,
    entries: parsed.output.slice(-MAX_AUDIT_ENTRIES),
    lastClearedAt: null,
  })
}

function getSnapshot() {
  return auditStore.get() || { version: 1 as const, entries: [], lastClearedAt: null }
}

function boundedFields(input: RecordLumiChannelAuditInput): Omit<RecordLumiChannelAuditInput, 'kind'> {
  return {
    deviceId: boundedText(input.deviceId, 160),
    deviceName: boundedText(input.deviceName, 80),
    userId: boundedText(input.userId, 160),
    conversationId: boundedText(input.conversationId, 240),
    eventType: boundedText(input.eventType, 160),
    code: boundedText(input.code, 160),
    reason: boundedText(input.reason, 500),
    retryAfterMs: typeof input.retryAfterMs === 'number' && Number.isFinite(input.retryAfterMs)
      ? Math.max(0, Math.round(input.retryAfterMs))
      : undefined,
    remoteAddress: boundedText(input.remoteAddress, 160),
  }
}

function boundedText(value: string | undefined, maxLength: number) {
  const normalized = value?.trim()
  return normalized ? normalized.slice(0, maxLength) : undefined
}
