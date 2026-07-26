import type { DirectOutboundCapability } from '../policy/outbound-guard'

/** Common addressing for a direct outbound operation. */
export interface DirectOutboundTarget {
  conversationId: string
  personId: string
}

/** Text payload sent to a direct user. */
export interface DirectTextPayload extends DirectOutboundTarget {
  text: string
  delayMs?: number
}

/** Image payload sent to a direct user. */
export interface DirectImagePayload extends DirectOutboundTarget {
  localPath?: string
  sourceUrl?: string
  caption?: string
}

/** Sticker payload sent to a direct user. */
export interface DirectStickerPayload extends DirectOutboundTarget {
  stickerId: string
  localPath: string
}

/** Voice payload sent to a direct user. */
export interface DirectVoicePayload extends DirectOutboundTarget {
  audio: Uint8Array
  mimeType: string
}

/** Mention payload sent to a direct user when a platform supports it. */
export interface DirectAtPayload extends DirectOutboundTarget {
  externalUserId: string
}

/** Quote payload sent to a direct user when a platform supports it. */
export interface DirectQuotePayload extends DirectOutboundTarget {
  sourceMessageId: string
}

/** Platform delivery result recorded in dialogue history. */
export interface DirectOutboundResult {
  messageId: string
  timestamp: number
}

/**
 * Raw direct delivery adapter implemented by a desktop or server host.
 *
 * It is wrapped by `DirectOutboundAuthority`; runtime tools must not retain a
 * raw adapter reference.
 */
export interface DirectOutboundAdapter {
  sendText: (payload: DirectTextPayload) => Promise<DirectOutboundResult>
  sendImage: (payload: DirectImagePayload) => Promise<DirectOutboundResult>
  sendSticker: (payload: DirectStickerPayload) => Promise<DirectOutboundResult>
  sendVoice: (payload: DirectVoicePayload) => Promise<DirectOutboundResult>
  sendAt: (payload: DirectAtPayload) => Promise<DirectOutboundResult>
  sendQuote: (payload: DirectQuotePayload) => Promise<DirectOutboundResult>
}

/** Capability-gated outbound surface available to the explicit reply tool. */
export interface DirectOutboundPort {
  sendText: (capability: DirectOutboundCapability, payload: DirectTextPayload) => Promise<DirectOutboundResult>
  sendImage: (capability: DirectOutboundCapability, payload: DirectImagePayload) => Promise<DirectOutboundResult>
  sendSticker: (capability: DirectOutboundCapability, payload: DirectStickerPayload) => Promise<DirectOutboundResult>
  sendVoice: (capability: DirectOutboundCapability, payload: DirectVoicePayload) => Promise<DirectOutboundResult>
  sendAt: (capability: DirectOutboundCapability, payload: DirectAtPayload) => Promise<DirectOutboundResult>
  sendQuote: (capability: DirectOutboundCapability, payload: DirectQuotePayload) => Promise<DirectOutboundResult>
}
