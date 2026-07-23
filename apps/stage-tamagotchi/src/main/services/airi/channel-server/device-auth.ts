import type { ConnectionAuthIdentity, WebSocketEvent } from '@proj-airi/server-runtime'
import type { LumiChannelToolScope } from '@proj-airi/stage-shared/server-channel-qr'

import type { ElectronLumiChannelDevice, ElectronLumiChannelDeviceArchiveSnapshot, ElectronLumiChannelDeviceArchiveSnapshotV2 } from '../../../../shared/eventa'

import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import { LUMI_CHANNEL_CHAT_SCOPE, LUMI_CHANNEL_DEVICE_SCOPES, LUMI_CHANNEL_TOOL_SCOPES, LUMI_ROOM_VOICE_MAX_BYTES, LUMI_ROOM_VOICE_MAX_DURATION_MS, LUMI_ROOM_VOICE_MIME_TYPES } from '@proj-airi/stage-shared/server-channel-qr'
import { array, literal, nullable, object, string } from 'valibot'

import { createConfig } from '../../../libs/electron/persistence'
import { linkLumiExternalIdentity } from '../lumi-identity'
import {
  clearLumiChannelAudit,
  exportLumiChannelAudit,
  importLumiChannelAudit,
  listLumiChannelAudit,
  recordLumiChannelAudit,
  setupLumiChannelDeviceAudit,
} from './device-audit'
import { LumiChannelDeviceEventPolicy } from './device-policy'

interface StoredLumiChannelDevice extends Omit<ElectronLumiChannelDevice, 'scopes'> {
  scopes: string[]
  tokenHash: string
}

interface LumiChannelDeviceRegistry {
  version: 1
  hostInstanceId: string
  devices: StoredLumiChannelDevice[]
}

const registrySchema = object({
  version: literal(1),
  hostInstanceId: string(),
  devices: array(object({
    id: string(),
    name: string(),
    userId: string(),
    conversationId: string(),
    roomTitle: string(),
    scopes: array(string()),
    createdAt: string(),
    revokedAt: nullable(string()),
    tokenHash: string(),
  })),
})

const registryStore = createConfig('server-channel', 'devices.json', registrySchema, {
  default: {
    version: 1,
    hostInstanceId: '',
    devices: [],
  },
  autoHeal: true,
})
const eventPolicy = new LumiChannelDeviceEventPolicy()

/** Initializes the persistent per-device credential registry and returns its host identity. */
export function setupLumiChannelDeviceRegistry() {
  registryStore.setup()
  setupLumiChannelDeviceAudit()
  const registry = getRegistry()
  let registryChanged = false
  for (const device of registry.devices) {
    const scopes = normalizeDeviceScopes(device.scopes, true)
    if (scopes.join('\0') !== device.scopes.join('\0')) {
      device.scopes = scopes
      registryChanged = true
    }
  }
  if (!registry.hostInstanceId) {
    registry.hostInstanceId = `lumi-host-${randomUUID()}`
    registryChanged = true
  }
  if (registryChanged)
    registryStore.update(registry)
  return registry.hostInstanceId
}

/** Returns public device metadata without credential hashes. */
export function listLumiChannelDevices() {
  const registry = getRegistry()
  return {
    hostInstanceId: registry.hostInstanceId,
    devices: registry.devices.map(toPublicDevice),
  }
}

/** Creates a one-time device token and binds the device to one Lumi user and room. */
export async function createLumiChannelDevice(input: { name: string, userId: string, conversationId: string, roomTitle: string, toolScopes?: LumiChannelToolScope[] }) {
  const registry = getRegistry()
  const id = `lumi-device-${randomUUID()}`
  const secret = randomBytes(32).toString('base64url')
  const token = `${id}.${secret}`
  const device: StoredLumiChannelDevice = {
    id,
    name: normalizeLabel(input.name),
    userId: requiredText(input.userId, 'userId', 160),
    conversationId: requiredText(input.conversationId, 'conversationId', 240),
    roomTitle: requiredText(input.roomTitle, 'roomTitle', 160),
    scopes: normalizeDeviceScopes([
      LUMI_CHANNEL_CHAT_SCOPE,
      'lumi:tool:memory',
      ...(input.toolScopes ?? []),
    ], false),
    createdAt: new Date().toISOString(),
    revokedAt: null,
    tokenHash: hashToken(token),
  }
  if (!device.name)
    throw new Error('Device name is required.')

  await linkLumiExternalIdentity({
    userId: device.userId,
    provider: 'lumi-lan',
    providerInstanceId: registry.hostInstanceId,
    externalUserId: device.id,
  })
  registry.devices.push(device)
  registryStore.update(registry)
  recordLumiChannelAudit({
    kind: 'device-created',
    ...deviceAuditFields(device),
  })
  return {
    hostInstanceId: registry.hostInstanceId,
    device: toPublicDevice(device),
    token,
  }
}

/** Revokes a device credential while preserving its audit metadata. */
export function revokeLumiChannelDevice(deviceId: string) {
  const registry = getRegistry()
  const device = registry.devices.find(item => item.id === deviceId)
  if (!device)
    throw new Error('Lumi channel device was not found.')
  if (!device.revokedAt) {
    device.revokedAt = new Date().toISOString()
    eventPolicy.reset(device.id)
    registryStore.update(registry)
    recordLumiChannelAudit({
      kind: 'device-revoked',
      ...deviceAuditFields(device),
    })
  }
  return toPublicDevice(device)
}

/** Exports credential hashes and host identity for a trusted full Lumi archive. */
export function exportLumiChannelDeviceArchive(): ElectronLumiChannelDeviceArchiveSnapshot {
  const registry = getRegistry()
  return {
    version: 3,
    hostInstanceId: registry.hostInstanceId,
    devices: registry.devices.map(device => ({
      ...structuredClone(device),
      scopes: normalizeDeviceScopes(device.scopes, true),
    })),
    audit: exportLumiChannelAudit(),
  }
}

/** Restores a validated device registry from a trusted full Lumi archive. */
export function importLumiChannelDeviceArchive(snapshot: ElectronLumiChannelDeviceArchiveSnapshot | ElectronLumiChannelDeviceArchiveSnapshotV2) {
  if (snapshot.version !== 2 && snapshot.version !== 3)
    throw new Error('Unsupported Lumi channel device archive version.')
  const hostInstanceId = requiredText(snapshot.hostInstanceId, 'hostInstanceId', 160)
  const deviceIds = new Set<string>()
  const devices: StoredLumiChannelDevice[] = snapshot.devices.map((device) => {
    const id = requiredText(device.id, 'device.id', 160)
    if (deviceIds.has(id))
      throw new Error('Lumi channel device archive contains duplicate device IDs.')
    deviceIds.add(id)
    if (!/^[a-f\d]{64}$/i.test(device.tokenHash))
      throw new Error('Lumi channel device archive contains an invalid token hash.')
    const scopes = normalizeDeviceScopes(device.scopes, snapshot.version === 2)
    return {
      id,
      name: normalizeLabel(device.name),
      userId: requiredText(device.userId, 'device.userId', 160),
      conversationId: requiredText(device.conversationId, 'device.conversationId', 240),
      roomTitle: requiredText(device.roomTitle, 'device.roomTitle', 160),
      scopes,
      createdAt: requiredText(device.createdAt, 'device.createdAt', 80),
      revokedAt: device.revokedAt ? requiredText(device.revokedAt, 'device.revokedAt', 80) : null,
      tokenHash: device.tokenHash.toLowerCase(),
    }
  })
  const registry: LumiChannelDeviceRegistry = { version: 1, hostInstanceId, devices }
  eventPolicy.reset()
  registryStore.update(registry)
  importLumiChannelAudit(snapshot.audit)
  return exportLumiChannelDeviceArchive()
}

/** Removes every device credential and rotates the host identity. */
export function clearLumiChannelDevices() {
  eventPolicy.reset()
  clearLumiChannelAudit()
  registryStore.update({
    version: 1,
    hostInstanceId: `lumi-host-${randomUUID()}`,
    devices: [],
  })
}

/** Returns newest-first content-free device activity for host diagnostics. */
export function listLumiChannelDeviceAudit() {
  return { entries: listLumiChannelAudit() }
}

/** Clears device activity without changing issued credentials. */
export function clearLumiChannelDeviceAudit() {
  clearLumiChannelAudit()
}

/** Records a server-runtime authentication outcome without receiving the credential token. */
export function recordLumiChannelAuthenticationResult(result: {
  authenticated: boolean
  identity?: ConnectionAuthIdentity
  remoteAddress?: string
}) {
  if (result.identity?.subject === 'shared-token')
    return
  recordLumiChannelAudit({
    kind: result.authenticated ? 'authenticated' : 'authentication-failed',
    ...identityAuditFields(result.identity),
    remoteAddress: result.remoteAddress,
  })
}

/** Records accepted and rejected room operations without message content. */
export function recordLumiChannelAuthorizationResult(result: {
  identity: ConnectionAuthIdentity
  eventType: string
  decision: { authorized: boolean, reason?: string, code?: string, retryAfterMs?: number }
  remoteAddress?: string
}) {
  if (result.identity.subject === 'shared-token')
    return
  if (!['input:text', 'input:voice', 'lumi:room:sync:request', 'lumi:room:voice:cancel'].includes(result.eventType))
    return
  recordLumiChannelAudit({
    kind: result.decision.authorized ? 'event-accepted' : 'event-rejected',
    ...identityAuditFields(result.identity),
    eventType: result.eventType,
    code: result.decision.code,
    reason: result.decision.reason,
    retryAfterMs: result.decision.retryAfterMs,
    remoteAddress: result.remoteAddress,
  })
}

/** Records the end of a device-authenticated channel connection. */
export function recordLumiChannelDisconnected(result: {
  identity: ConnectionAuthIdentity
  remoteAddress?: string
  code?: number
  reason?: string
}) {
  if (result.identity.subject === 'shared-token')
    return
  recordLumiChannelAudit({
    kind: 'disconnected',
    ...identityAuditFields(result.identity),
    code: typeof result.code === 'number' ? String(result.code) : undefined,
    reason: result.reason,
    remoteAddress: result.remoteAddress,
  })
}

/** Resolves a presented high-entropy token to a server-owned device identity. */
export function authenticateLumiChannelDevice(token: string): ConnectionAuthIdentity | undefined {
  const separator = token.indexOf('.')
  if (separator <= 0)
    return undefined
  const deviceId = token.slice(0, separator)
  const device = getRegistry().devices.find(item => item.id === deviceId && !item.revokedAt)
  if (!device || !safeEqualHash(hashToken(token), device.tokenHash))
    return undefined

  const registry = getRegistry()
  return {
    subject: device.id,
    scopes: normalizeDeviceScopes(device.scopes, true),
    claims: {
      provider: 'lumi-lan',
      providerInstanceId: registry.hostInstanceId,
      externalUserId: device.id,
      userId: device.userId,
      conversationId: device.conversationId,
    },
  }
}

/** Restricts device credentials to their issued room while preserving unrestricted shared-token access. */
export function authorizeLumiChannelDeviceEvent(identity: ConnectionAuthIdentity, event: WebSocketEvent) {
  if (identity.scopes.includes('*'))
    return { authorized: true }
  if (!identity.scopes.includes('lumi:chat'))
    return denied('This credential does not permit Lumi chat.', 'lumi-device-scope-denied')
  if (event.type === 'module:announce')
    return { authorized: true }

  const conversationId = identity.claims?.conversationId
  if (!conversationId)
    return denied('This Lumi device is not bound to a room.', 'lumi-device-room-missing')
  if (event.type === 'input:text' || event.type === 'input:voice') {
    if (event.data.overrides?.sessionId !== conversationId || !event.data.room)
      return denied('This Lumi device cannot send messages to that room.', 'lumi-device-room-denied')
    if (event.type === 'input:voice') {
      if (!(event.data.audio instanceof ArrayBuffer)
        || event.data.audio.byteLength === 0
        || event.data.audio.byteLength !== event.data.byteLength
        || event.data.byteLength > LUMI_ROOM_VOICE_MAX_BYTES) {
        return denied('This Lumi voice message has an invalid or oversized audio payload.', 'lumi-device-voice-payload-invalid')
      }
      if (typeof event.data.mimeType !== 'string' || !(LUMI_ROOM_VOICE_MIME_TYPES as readonly string[]).includes(event.data.mimeType.toLowerCase()))
        return denied('This Lumi voice message uses an unsupported audio format.', 'lumi-device-voice-format-invalid')
      if (!Number.isFinite(event.data.durationMs) || event.data.durationMs <= 0 || event.data.durationMs > LUMI_ROOM_VOICE_MAX_DURATION_MS)
        return denied('This Lumi voice message has an invalid or excessive duration.', 'lumi-device-voice-duration-invalid')
    }
    return eventPolicy.evaluate(identity, event)
  }
  if (event.type === 'lumi:room:sync:request') {
    if (event.data.conversationId !== conversationId)
      return denied('This Lumi device cannot read history from that room.', 'lumi-device-room-denied')
    return eventPolicy.evaluate(identity, event)
  }
  if (event.type === 'lumi:room:voice:cancel') {
    if (event.data.conversationId !== conversationId)
      return denied('This Lumi device cannot cancel voice messages in that room.', 'lumi-device-room-denied')
    return eventPolicy.evaluate(identity, event)
  }
  return denied('This Lumi device cannot send that event.', 'lumi-device-event-denied')
}

function denied(reason: string, code: string) {
  return { authorized: false, reason, code }
}

function normalizeDeviceScopes(scopes: readonly string[], allowLegacyAllTools: boolean): ElectronLumiChannelDevice['scopes'] {
  const normalized = new Set<string>(scopes)
  if (allowLegacyAllTools && normalized.delete('lumi:tools')) {
    for (const scope of LUMI_CHANNEL_TOOL_SCOPES)
      normalized.add(scope)
  }
  normalized.add(LUMI_CHANNEL_CHAT_SCOPE)
  normalized.add('lumi:tool:memory')
  if ([...normalized].some(scope => !(LUMI_CHANNEL_DEVICE_SCOPES as readonly string[]).includes(scope)))
    throw new Error('Lumi channel device archive contains invalid scopes.')
  return LUMI_CHANNEL_DEVICE_SCOPES.filter(scope => normalized.has(scope))
}

function getRegistry(): LumiChannelDeviceRegistry {
  return registryStore.get() || { version: 1, hostInstanceId: '', devices: [] }
}

function toPublicDevice(device: StoredLumiChannelDevice): ElectronLumiChannelDevice {
  return {
    id: device.id,
    name: device.name,
    userId: device.userId,
    conversationId: device.conversationId,
    roomTitle: device.roomTitle,
    scopes: normalizeDeviceScopes(device.scopes, true),
    createdAt: device.createdAt,
    revokedAt: device.revokedAt ?? null,
  }
}

function identityAuditFields(identity: ConnectionAuthIdentity | undefined) {
  if (!identity || identity.subject === 'shared-token')
    return {}
  const device = getRegistry().devices.find(candidate => candidate.id === identity.subject)
  return device ? deviceAuditFields(device) : { deviceId: identity.subject }
}

function deviceAuditFields(device: StoredLumiChannelDevice) {
  return {
    deviceId: device.id,
    deviceName: device.name,
    userId: device.userId,
    conversationId: device.conversationId,
  }
}

function hashToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function safeEqualHash(left: string, right: string) {
  const leftBuffer = Buffer.from(left, 'hex')
  const rightBuffer = Buffer.from(right, 'hex')
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function normalizeLabel(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 80) : ''
}

function requiredText(value: string, field: string, maxLength: number) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized)
    throw new Error(`${field} is required.`)
  if (normalized.length > maxLength)
    throw new Error(`${field} exceeds ${maxLength} characters.`)
  return normalized
}
