import type { ConnectionAuthIdentity, WebSocketEvent } from '@proj-airi/server-runtime'

import { describe, expect, it } from 'vitest'

import { LumiChannelDeviceEventPolicy } from './device-policy'

const identity: ConnectionAuthIdentity = {
  subject: 'lumi-device-1',
  scopes: ['lumi:chat'],
}

function inputEvent(type: 'input:text' | 'input:voice' | 'lumi:room:sync:request' | 'lumi:room:voice:cancel'): WebSocketEvent {
  return { type } as WebSocketEvent
}

describe('lumi channel device event policy', () => {
  it('limits each device independently and reports when retry becomes safe', () => {
    let now = 1_000
    const policy = new LumiChannelDeviceEventPolicy({
      now: () => now,
      rules: [{ eventType: 'input:text', limit: 2, windowMs: 1_000 }],
    })

    expect(policy.evaluate(identity, inputEvent('input:text'))).toEqual({ authorized: true })
    now = 1_100
    expect(policy.evaluate(identity, inputEvent('input:text'))).toEqual({ authorized: true })
    now = 1_200
    expect(policy.evaluate(identity, inputEvent('input:text'))).toEqual({
      authorized: false,
      reason: 'This Lumi device is sending messages too quickly.',
      code: 'lumi-device-rate-limited',
      retryAfterMs: 800,
    })
    expect(policy.evaluate({ ...identity, subject: 'lumi-device-2' }, inputEvent('input:text'))).toEqual({ authorized: true })
  })

  it('uses separate budgets for room sync and text events', () => {
    const policy = new LumiChannelDeviceEventPolicy({
      now: () => 1_000,
      rules: [
        { eventType: 'input:text', limit: 1, windowMs: 1_000 },
        { eventType: 'lumi:room:sync:request', limit: 1, windowMs: 1_000 },
      ],
    })

    expect(policy.evaluate(identity, inputEvent('input:text')).authorized).toBe(true)
    expect(policy.evaluate(identity, inputEvent('lumi:room:sync:request')).authorized).toBe(true)
    expect(policy.evaluate(identity, inputEvent('input:text')).authorized).toBe(false)
    expect(policy.evaluate(identity, inputEvent('lumi:room:sync:request')).authorized).toBe(false)
  })

  it('limits voice uploads independently from text messages', () => {
    const policy = new LumiChannelDeviceEventPolicy({
      now: () => 1_000,
      rules: [
        { eventType: 'input:text', limit: 1, windowMs: 1_000 },
        { eventType: 'input:voice', limit: 1, windowMs: 1_000 },
      ],
    })

    expect(policy.evaluate(identity, inputEvent('input:voice')).authorized).toBe(true)
    expect(policy.evaluate(identity, inputEvent('input:text')).authorized).toBe(true)
    expect(policy.evaluate(identity, inputEvent('input:voice'))).toMatchObject({
      authorized: false,
      code: 'lumi-device-rate-limited',
    })
  })

  it('releases a revoked device budget without affecting other subjects', () => {
    const policy = new LumiChannelDeviceEventPolicy({
      now: () => 1_000,
      rules: [{ eventType: 'input:text', limit: 1, windowMs: 1_000 }],
    })

    policy.evaluate(identity, inputEvent('input:text'))
    policy.evaluate({ ...identity, subject: 'lumi-device-2' }, inputEvent('input:text'))
    policy.reset(identity.subject)

    expect(policy.evaluate(identity, inputEvent('input:text')).authorized).toBe(true)
    expect(policy.evaluate({ ...identity, subject: 'lumi-device-2' }, inputEvent('input:text')).authorized).toBe(false)
  })
})
