import type { DirectPerceptionEnvelope } from '../input'
import type {
  DirectAtPayload,
  DirectImagePayload,
  DirectOutboundAdapter,
  DirectOutboundPort,
  DirectOutboundResult,
  DirectOutboundTarget,
  DirectQuotePayload,
  DirectStickerPayload,
  DirectTextPayload,
  DirectVoicePayload,
} from '../ports/outbound'

import { validateDirectPerceptionEnvelope } from '../input'

const capabilityBrand: unique symbol = Symbol('LumiDirectOutboundCapability')

/**
 * Opaque authority required by every visible outbound operation.
 *
 * Values are issued only by {@link DirectOutboundAuthority.issue}. Runtime
 * validation also checks private WeakMap membership, so a structurally similar
 * object is rejected.
 */
export interface DirectOutboundCapability {
  readonly [capabilityBrand]: true
}

interface CapabilityMetadata {
  conversationId: string
  personId: string
  eventId: string
  issuedAt: number
}

/** Security audit emitted when outbound authorization fails. */
export interface OutboundSecurityAudit {
  code: 'GROUP_OUTBOUND_FORBIDDEN'
  operation: 'sendText' | 'sendImage' | 'sendSticker' | 'sendVoice' | 'sendAt' | 'sendQuote'
  conversationId?: string
  personId?: string
  reason: string
  timestamp: number
}

/** Receives security audit records without exposing platform content. */
export interface OutboundSecurityAuditPort {
  record: (audit: OutboundSecurityAudit) => Promise<void> | void
}

/** Error thrown for a missing, forged, revoked, or mismatched capability. */
export class GroupOutboundForbiddenError extends Error {
  readonly code = 'GROUP_OUTBOUND_FORBIDDEN'

  constructor(message: string) {
    super(message)
    this.name = 'GroupOutboundForbiddenError'
  }
}

/**
 * Issues and validates direct-only outbound capabilities.
 *
 * Use when:
 * - A direct ingress has completed identity and membership authorization
 * - The reply tool needs a capability-gated outbound port
 *
 * Expects:
 * - The raw adapter itself is not exposed to Planner or group-observation code
 *
 * Returns:
 * - An authority whose public outbound methods validate every operation
 */
export class DirectOutboundAuthority implements DirectOutboundPort {
  readonly #capabilities = new WeakMap<object, CapabilityMetadata>()
  readonly #adapter: DirectOutboundAdapter
  readonly #audit: OutboundSecurityAuditPort

  constructor(adapter: DirectOutboundAdapter, audit: OutboundSecurityAuditPort) {
    this.#adapter = adapter
    this.#audit = audit
  }

  issue(envelope: DirectPerceptionEnvelope): DirectOutboundCapability {
    validateDirectPerceptionEnvelope(envelope)
    const capability = Object.freeze({
      [capabilityBrand]: true,
    }) as DirectOutboundCapability
    this.#capabilities.set(capability, {
      conversationId: envelope.conversationId,
      personId: envelope.personId,
      eventId: envelope.eventId,
      issuedAt: Date.now(),
    })
    return capability
  }

  revoke(capability: DirectOutboundCapability): void {
    this.#capabilities.delete(capability)
  }

  async sendText(capability: DirectOutboundCapability, payload: DirectTextPayload): Promise<DirectOutboundResult> {
    await this.#assertAuthorized(capability, payload, 'sendText')
    return this.#adapter.sendText(payload)
  }

  async sendImage(capability: DirectOutboundCapability, payload: DirectImagePayload): Promise<DirectOutboundResult> {
    await this.#assertAuthorized(capability, payload, 'sendImage')
    return this.#adapter.sendImage(payload)
  }

  async sendSticker(capability: DirectOutboundCapability, payload: DirectStickerPayload): Promise<DirectOutboundResult> {
    await this.#assertAuthorized(capability, payload, 'sendSticker')
    return this.#adapter.sendSticker(payload)
  }

  async sendVoice(capability: DirectOutboundCapability, payload: DirectVoicePayload): Promise<DirectOutboundResult> {
    await this.#assertAuthorized(capability, payload, 'sendVoice')
    return this.#adapter.sendVoice(payload)
  }

  async sendAt(capability: DirectOutboundCapability, payload: DirectAtPayload): Promise<DirectOutboundResult> {
    await this.#assertAuthorized(capability, payload, 'sendAt')
    return this.#adapter.sendAt(payload)
  }

  async sendQuote(capability: DirectOutboundCapability, payload: DirectQuotePayload): Promise<DirectOutboundResult> {
    await this.#assertAuthorized(capability, payload, 'sendQuote')
    return this.#adapter.sendQuote(payload)
  }

  async #assertAuthorized(
    capability: DirectOutboundCapability,
    target: DirectOutboundTarget,
    operation: OutboundSecurityAudit['operation'],
  ): Promise<void> {
    const metadata = typeof capability === 'object' && capability !== null
      ? this.#capabilities.get(capability)
      : undefined
    const reason = !metadata
      ? 'missing, forged, or revoked direct capability'
      : metadata.conversationId !== target.conversationId
        ? 'capability conversation does not match outbound target'
        : metadata.personId !== target.personId
          ? 'capability person does not match outbound target'
          : undefined
    if (!reason)
      return

    await this.#audit.record({
      code: 'GROUP_OUTBOUND_FORBIDDEN',
      operation,
      conversationId: target.conversationId,
      personId: target.personId,
      reason,
      timestamp: Date.now(),
    })
    throw new GroupOutboundForbiddenError(reason)
  }
}
