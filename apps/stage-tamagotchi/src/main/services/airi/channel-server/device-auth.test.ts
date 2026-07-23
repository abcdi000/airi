import type { WebSocketEvent } from '@proj-airi/server-runtime'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const persistence = vi.hoisted(() => ({
  registry: {
    version: 1 as const,
    hostInstanceId: '',
    devices: [] as Array<Record<string, unknown>>,
  },
  audit: {
    version: 1 as const,
    entries: [] as Array<Record<string, unknown>>,
    lastClearedAt: null as string | null,
  },
}))
const linkExternalIdentity = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('../../../libs/electron/persistence', () => ({
  createConfig: (_namespace: string, fileName: string) => ({
    setup: vi.fn(),
    get: () => fileName === 'device-audit.json' ? persistence.audit : persistence.registry,
    update: (value: typeof persistence.registry | typeof persistence.audit) => {
      if (fileName === 'device-audit.json')
        persistence.audit = structuredClone(value as typeof persistence.audit)
      else
        persistence.registry = structuredClone(value as typeof persistence.registry)
    },
  }),
}))

vi.mock('../lumi-identity', () => ({
  linkLumiExternalIdentity: linkExternalIdentity,
}))

const {
  authenticateLumiChannelDevice,
  authorizeLumiChannelDeviceEvent,
  createLumiChannelDevice,
  exportLumiChannelDeviceArchive,
  importLumiChannelDeviceArchive,
  listLumiChannelDeviceAudit,
  recordLumiChannelAuthenticationResult,
  recordLumiChannelAuthorizationResult,
  revokeLumiChannelDevice,
  setupLumiChannelDeviceRegistry,
} = await import('./device-auth')

describe('lumi channel device credentials', () => {
  beforeEach(() => {
    persistence.registry = { version: 1, hostInstanceId: '', devices: [] }
    persistence.audit = { version: 1, entries: [], lastClearedAt: null }
    linkExternalIdentity.mockClear()
  })

  it('binds a one-time token to the selected Lumi user and external identity', async () => {
    const hostInstanceId = setupLumiChannelDeviceRegistry()
    const credential = await createLumiChannelDevice({
      name: 'Moussy laptop',
      userId: 'lumi-user-moussy',
      conversationId: 'lumi-room-shared',
      roomTitle: 'Doggy, Moussy, Lumi',
      toolScopes: [],
    })
    const identity = authenticateLumiChannelDevice(credential.token)

    expect(identity?.subject).toBe(credential.device.id)
    expect(identity?.scopes).toEqual(['lumi:chat', 'lumi:tool:memory'])
    expect(identity?.claims).toEqual({
      provider: 'lumi-lan',
      providerInstanceId: hostInstanceId,
      externalUserId: credential.device.id,
      userId: 'lumi-user-moussy',
      conversationId: 'lumi-room-shared',
    })
    expect(linkExternalIdentity).toHaveBeenCalledWith({
      userId: 'lumi-user-moussy',
      provider: 'lumi-lan',
      providerInstanceId: hostInstanceId,
      externalUserId: credential.device.id,
    })
  })

  it('rejects altered and revoked device tokens', async () => {
    setupLumiChannelDeviceRegistry()
    const credential = await createLumiChannelDevice({
      name: 'Doggy laptop',
      userId: 'lumi-user-doggy',
      conversationId: 'lumi-room-shared',
      roomTitle: 'Doggy, Moussy, Lumi',
    })

    expect(authenticateLumiChannelDevice(`${credential.token}altered`)).toBeUndefined()
    expect(authenticateLumiChannelDevice(credential.token)).toBeDefined()

    revokeLumiChannelDevice(credential.device.id)

    expect(authenticateLumiChannelDevice(credential.token)).toBeUndefined()
  })

  it('permits chat room events but denies unrelated protocol events', () => {
    const identity = {
      subject: 'device-1',
      scopes: ['lumi:chat'],
      claims: { conversationId: 'lumi-room-shared' },
    }
    const chatEvent = {
      type: 'input:text',
      data: {
        text: 'hello',
        room: { messageId: 'message-1', idempotencyKey: 'operation-1' },
        overrides: { sessionId: 'lumi-room-shared' },
      },
    } as const
    const otherRoomEvent = {
      ...chatEvent,
      data: {
        ...chatEvent.data,
        overrides: { sessionId: 'lumi-room-private' },
      },
    } as const
    const contextEvent = { type: 'context:update', data: {} } as const

    expect(authorizeLumiChannelDeviceEvent(identity, chatEvent as WebSocketEvent)).toEqual({ authorized: true })
    expect(authorizeLumiChannelDeviceEvent(identity, {
      type: 'input:voice',
      data: {
        audio: new ArrayBuffer(44),
        byteLength: 44,
        durationMs: 1_000,
        mimeType: 'audio/wav',
        room: { messageId: 'voice-1', idempotencyKey: 'voice-operation-1' },
        overrides: { sessionId: 'lumi-room-shared' },
      },
    } as WebSocketEvent)).toEqual({ authorized: true })
    expect(authorizeLumiChannelDeviceEvent(identity, {
      type: 'input:voice',
      data: {
        audio: new ArrayBuffer(44),
        byteLength: 45,
        durationMs: 1_000,
        mimeType: 'audio/wav',
        room: { messageId: 'voice-2', idempotencyKey: 'voice-operation-2' },
        overrides: { sessionId: 'lumi-room-shared' },
      },
    } as WebSocketEvent)).toMatchObject({ authorized: false, code: 'lumi-device-voice-payload-invalid' })
    expect(authorizeLumiChannelDeviceEvent(identity, otherRoomEvent as WebSocketEvent)).toEqual({
      authorized: false,
      reason: 'This Lumi device cannot send messages to that room.',
      code: 'lumi-device-room-denied',
    })
    expect(authorizeLumiChannelDeviceEvent(identity, contextEvent as WebSocketEvent)).toEqual({
      authorized: false,
      reason: 'This Lumi device cannot send that event.',
      code: 'lumi-device-event-denied',
    })
  })

  it('restores credential hashes and host identity from a full Lumi archive', async () => {
    setupLumiChannelDeviceRegistry()
    const credential = await createLumiChannelDevice({
      name: 'Moussy laptop',
      userId: 'lumi-user-moussy',
      conversationId: 'lumi-room-shared',
      roomTitle: 'Doggy, Moussy, Lumi',
    })
    const archive = exportLumiChannelDeviceArchive()
    persistence.registry = { version: 1, hostInstanceId: 'temporary-host', devices: [] }
    persistence.audit = { version: 1, entries: [], lastClearedAt: null }

    importLumiChannelDeviceArchive(archive)

    expect(authenticateLumiChannelDevice(credential.token)?.claims?.providerInstanceId).toBe(archive.hostInstanceId)
    expect(exportLumiChannelDeviceArchive()).toEqual(archive)
  })

  it('migrates the legacy all-tools scope into explicit least-privilege categories', async () => {
    setupLumiChannelDeviceRegistry()
    const credential = await createLumiChannelDevice({
      name: 'Legacy laptop',
      userId: 'lumi-user-moussy',
      conversationId: 'lumi-room-shared',
      roomTitle: 'Doggy, Moussy, Lumi',
    })
    const current = exportLumiChannelDeviceArchive()
    const legacy = {
      ...current,
      version: 2 as const,
      devices: current.devices.map(device => ({ ...device, scopes: ['lumi:chat', 'lumi:tools'] })),
    }

    const migrated = importLumiChannelDeviceArchive(legacy)

    expect(migrated.version).toBe(3)
    expect(authenticateLumiChannelDevice(credential.token)?.scopes).toEqual([
      'lumi:chat',
      'lumi:tool:memory',
      'lumi:tool:web',
      'lumi:tool:minecraft',
      'lumi:tool:computer-use',
    ])
  })

  it('records content-free authentication and event authorization audit entries', async () => {
    const credential = await createLumiChannelDevice({
      name: 'Moussy phone',
      userId: 'lumi-user-moussy',
      conversationId: 'lumi-room-shared',
      roomTitle: 'Doggy, Moussy, Lumi',
    })
    const identity = authenticateLumiChannelDevice(credential.token)!

    recordLumiChannelAuthenticationResult({ authenticated: true, identity, remoteAddress: '192.168.1.8' })
    recordLumiChannelAuthorizationResult({
      identity,
      eventType: 'input:text',
      decision: {
        authorized: false,
        code: 'lumi-device-rate-limited',
        reason: 'Too many messages.',
        retryAfterMs: 2_000,
      },
      remoteAddress: '192.168.1.8',
    })

    const audit = listLumiChannelDeviceAudit().entries
    expect(audit.map(entry => entry.kind)).toEqual(['event-rejected', 'authenticated', 'device-created'])
    expect(audit[0]).toMatchObject({
      deviceId: credential.device.id,
      deviceName: 'Moussy phone',
      userId: 'lumi-user-moussy',
      conversationId: 'lumi-room-shared',
      eventType: 'input:text',
      code: 'lumi-device-rate-limited',
      retryAfterMs: 2_000,
      remoteAddress: '192.168.1.8',
    })
    expect(Object.keys(audit[0] ?? {})).not.toContain('content')
  })
})
