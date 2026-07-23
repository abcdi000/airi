import type { ConnectionAuthIdentity, EventAuthorizationDecision, WebSocketEvent } from '@proj-airi/server-runtime'

export interface LumiChannelDeviceRateLimitRule {
  /** Protocol event governed by this rule. */
  eventType: 'input:text' | 'input:voice' | 'lumi:room:sync:request' | 'lumi:room:voice:cancel'
  /** Maximum accepted events inside one sliding window. */
  limit: number
  /** Sliding-window duration in milliseconds. */
  windowMs: number
}

export interface LumiChannelDeviceEventPolicyOptions {
  /** Clock used for deterministic policy evaluation. @default Date.now */
  now?: () => number
  /** Per-event limits. @default Lumi's chat-safe desktop policy */
  rules?: LumiChannelDeviceRateLimitRule[]
}

const defaultRules: LumiChannelDeviceRateLimitRule[] = [
  { eventType: 'input:text', limit: 30, windowMs: 60_000 },
  { eventType: 'input:voice', limit: 10, windowMs: 60_000 },
  { eventType: 'lumi:room:sync:request', limit: 60, windowMs: 60_000 },
  { eventType: 'lumi:room:voice:cancel', limit: 30, windowMs: 60_000 },
]

/**
 * Enforces per-device sliding-window limits for Lumi LAN room traffic.
 *
 * Use when:
 * - A room-bound device event has passed scope and room authorization
 * - The host must protect model ingestion and replay from accidental floods
 *
 * Expects:
 * - `identity.subject` is the server-authenticated device identifier
 * - One policy instance is retained for the lifetime of the channel server
 *
 * Returns:
 * - Structured authorization decisions with retry timing for denied events
 */
export class LumiChannelDeviceEventPolicy {
  private readonly acceptedAt = new Map<string, number[]>()
  private readonly now: () => number
  private readonly rules: LumiChannelDeviceRateLimitRule[]

  constructor(options?: LumiChannelDeviceEventPolicyOptions) {
    this.now = options?.now ?? Date.now
    this.rules = options?.rules?.map(rule => ({ ...rule })) ?? defaultRules.map(rule => ({ ...rule }))
  }

  evaluate(identity: ConnectionAuthIdentity, event: WebSocketEvent): EventAuthorizationDecision {
    const rule = this.rules.find(candidate => candidate.eventType === event.type)
    if (!rule)
      return { authorized: true }

    const now = this.now()
    const key = `${identity.subject}:${rule.eventType}`
    const windowStart = now - rule.windowMs
    const recent = (this.acceptedAt.get(key) ?? []).filter(timestamp => timestamp > windowStart)
    if (recent.length >= rule.limit) {
      const retryAfterMs = Math.max(1, recent[0] + rule.windowMs - now)
      this.acceptedAt.set(key, recent)
      return {
        authorized: false,
        reason: event.type === 'lumi:room:sync:request'
          ? 'This Lumi device is requesting room history too quickly.'
          : event.type === 'lumi:room:voice:cancel'
            ? 'This Lumi device is cancelling voice messages too quickly.'
            : 'This Lumi device is sending messages too quickly.',
        code: 'lumi-device-rate-limited',
        retryAfterMs,
      }
    }

    recent.push(now)
    this.acceptedAt.set(key, recent)
    return { authorized: true }
  }

  reset(subject?: string) {
    if (!subject) {
      this.acceptedAt.clear()
      return
    }

    for (const key of this.acceptedAt.keys()) {
      if (key.startsWith(`${subject}:`))
        this.acceptedAt.delete(key)
    }
  }
}
