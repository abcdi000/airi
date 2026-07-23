import { describe, expect, it } from 'vitest'

import {
  createLumiChannelDeviceQrPayload,
  parseLumiChannelDeviceQrPayload,
  parseServerChannelQrPayload,
} from './server-channel-qr'

describe('lumi channel device QR payload', () => {
  it('round-trips one device credential and its bound actor identity', () => {
    const payload = createLumiChannelDeviceQrPayload({
      type: 'lumi:channel-device',
      version: 1,
      urls: ['wss://192.168.1.2:6121/ws'],
      authToken: 'device.secret',
      conversationId: 'lumi-room-doggy-moussy',
      roomTitle: 'Doggy, Moussy, Lumi',
      actor: {
        provider: 'lumi-lan',
        providerInstanceId: 'host-1',
        externalUserId: 'device-1',
      },
    })

    expect(parseLumiChannelDeviceQrPayload(JSON.stringify(payload))).toEqual(payload)
    expect(() => parseServerChannelQrPayload(JSON.stringify(payload))).toThrow()
  })

  it('rejects a device credential that is not bound to a host-issued room', () => {
    expect(() => parseLumiChannelDeviceQrPayload(JSON.stringify({
      type: 'lumi:channel-device',
      version: 1,
      urls: ['wss://192.168.1.2:6121/ws'],
      authToken: 'device.secret',
      actor: {
        provider: 'lumi-lan',
        providerInstanceId: 'host-1',
        externalUserId: 'device-1',
      },
    }))).toThrow()
  })
})
