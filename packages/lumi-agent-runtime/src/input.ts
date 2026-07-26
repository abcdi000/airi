/**
 * A text segment in an ordered Lumi perception.
 */
export interface DirectTextSegment {
  type: 'text'
  text: string
}

/**
 * A media segment in an ordered Lumi perception.
 */
export interface DirectMediaSegment {
  type: 'image' | 'audio' | 'file'
  attachmentId: string
  caption?: string
}

/**
 * A reference to another direct message.
 */
export interface DirectQuoteSegment {
  type: 'quote'
  sourceMessageId: string
  previewText?: string
}

/** Ordered user-visible content received in a direct conversation. */
export type DirectPerceptionSegment = DirectTextSegment | DirectMediaSegment | DirectQuoteSegment

/**
 * An attachment resolved by a platform adapter before direct ingestion.
 */
export interface DirectAttachment {
  id: string
  kind: 'image' | 'audio' | 'file'
  mimeType?: string
  sizeBytes?: number
  localPath?: string
  sourceUrl?: string
  metadata?: Readonly<Record<string, unknown>>
}

/**
 * Authenticated private input accepted by {@link LumiAgentRuntime.ingestDirect}.
 *
 * The direct ingress adapter must resolve the internal person and conversation
 * before constructing this envelope.
 */
export interface DirectPerceptionEnvelope {
  eventId: string
  conversationId: string
  personId: string
  platform: string
  platformInstanceId: string
  externalUserId: string
  timestamp: number
  text?: string
  segments: readonly DirectPerceptionSegment[]
  attachments: readonly DirectAttachment[]
  sourceMessageId: string
  participantPersonIds: readonly string[]
  conversationType: 'direct'
}

/** Text observed in a group without creating a reply channel. */
export interface GroupObservationText {
  type: 'text'
  text: string
}

/** Image evidence observed in a group without creating a reply channel. */
export interface GroupObservationImage {
  type: 'image'
  imageId: string
  mimeType?: string
  sizeBytes?: number
  localPath?: string
  sourceUrl?: string
}

/** Ordered, learnable group content. */
export type GroupObservationSegment = GroupObservationText | GroupObservationImage

/**
 * Read-only social evidence accepted by {@link GroupObservationRuntime.observe}.
 *
 * It intentionally contains no outbound channel, tool runtime, or direct
 * outbound capability.
 */
export interface GroupObservationEnvelope {
  eventId: string
  messageId: string
  sourceId: string
  groupId: string
  platform: string
  platformInstanceId: string
  senderId: string
  senderName: string
  timestamp: number
  text?: string
  images: readonly GroupObservationImage[]
  segments: readonly GroupObservationSegment[]
  conversationType: 'group_observation'
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim())
    throw new TypeError(`${field} must be a non-empty string`)
}

/**
 * Validates the security-relevant shape of a direct envelope.
 *
 * Use when:
 * - Accepting a direct envelope at a runtime boundary
 * - Issuing a direct outbound capability
 *
 * Expects:
 * - Identity and membership have already been resolved by the adapter
 *
 * Returns:
 * - Nothing when the envelope is valid; otherwise throws a `TypeError`
 */
export function validateDirectPerceptionEnvelope(envelope: DirectPerceptionEnvelope): void {
  if (envelope.conversationType !== 'direct')
    throw new TypeError('Direct perception requires conversationType=direct')
  requireNonEmpty(envelope.eventId, 'eventId')
  requireNonEmpty(envelope.conversationId, 'conversationId')
  requireNonEmpty(envelope.personId, 'personId')
  requireNonEmpty(envelope.platform, 'platform')
  requireNonEmpty(envelope.platformInstanceId, 'platformInstanceId')
  requireNonEmpty(envelope.externalUserId, 'externalUserId')
  requireNonEmpty(envelope.sourceMessageId, 'sourceMessageId')
  if (!Number.isFinite(envelope.timestamp) || envelope.timestamp <= 0)
    throw new TypeError('timestamp must be a positive finite number')
  if (!envelope.participantPersonIds.includes(envelope.personId))
    throw new TypeError('participantPersonIds must contain the authenticated person')
}

/**
 * Validates a read-only group observation envelope.
 *
 * Use when:
 * - Accepting group evidence before policy checks and batching
 *
 * Expects:
 * - The platform adapter has preserved the original message order
 *
 * Returns:
 * - Nothing when valid; otherwise throws a `TypeError`
 */
export function validateGroupObservationEnvelope(envelope: GroupObservationEnvelope): void {
  if (envelope.conversationType !== 'group_observation')
    throw new TypeError('Group observation requires conversationType=group_observation')
  requireNonEmpty(envelope.eventId, 'eventId')
  requireNonEmpty(envelope.messageId, 'messageId')
  requireNonEmpty(envelope.sourceId, 'sourceId')
  requireNonEmpty(envelope.groupId, 'groupId')
  requireNonEmpty(envelope.platform, 'platform')
  requireNonEmpty(envelope.platformInstanceId, 'platformInstanceId')
  requireNonEmpty(envelope.senderId, 'senderId')
  if (!Number.isFinite(envelope.timestamp) || envelope.timestamp <= 0)
    throw new TypeError('timestamp must be a positive finite number')
}
