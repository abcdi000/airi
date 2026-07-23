import type { LumiRoomEvent } from '@proj-airi/server-sdk'

import { storage } from '../storage'

const MAX_RETAINED_ROOM_EVENTS = 5_000
const MAX_RETAINED_RECEIPTS = 10_000
const LEDGER_INDEX_KEY = 'local:lumi/room-ledger-index'
let ledgerIndexWriteQueue: Promise<void> = Promise.resolve()

/** Host-side delivery receipt retained for idempotency and audit. */
export interface LumiRoomDeliveryReceipt {
  /** Client operation identifier. */
  idempotencyKey: string
  /** Client message identifier. */
  messageId: string
  /** Internal actor resolved and authorized by the host. */
  actorId: string
  /** Host sequence assigned to the accepted user event. */
  inputSequence?: number
  /** Input transport reserved by this receipt. */
  inputKind: 'text' | 'voice'
  /** Host-computed identity of a voice payload before transcription. */
  payloadFingerprint?: string
  /** Current processing state. */
  status: 'transcribing' | 'accepted' | 'completed' | 'failed' | 'cancelled'
  /** Host sequence assigned to the assistant event after completion. */
  assistantSequence?: number
  /** Safe diagnostic text for failed processing. */
  failureReason?: string
  /** Unix timestamp of initial acceptance. */
  acceptedAt: number
  /** Unix timestamp of the latest state transition. */
  updatedAt: number
}

/** Persistent network event log for one authorized Lumi conversation. */
export interface LumiRoomLedgerSnapshot {
  /** Storage schema version. */
  version: 1
  /** Conversation disclosure boundary owning this log. */
  conversationId: string
  /** Highest host sequence ever assigned. */
  latestSequence: number
  /** Earliest event sequence still retained for replay. */
  retainedFromSequence: number
  /** Replayable user and assistant events. */
  events: LumiRoomEvent[]
  /** Idempotency and processing audit records. */
  receipts: LumiRoomDeliveryReceipt[]
}

export interface AcceptLumiRoomInput {
  conversationId: string
  messageId: string
  idempotencyKey: string
  actorId: string
  actorDisplayName?: string
  content: string
  createdAt: number
}

export interface ReserveLumiRoomVoiceInput {
  conversationId: string
  messageId: string
  idempotencyKey: string
  actorId: string
  payloadFingerprint: string
  createdAt: number
}

export type ReserveLumiRoomVoiceInputResult
  = | { status: 'reserved', receipt: LumiRoomDeliveryReceipt, latestSequence: number }
    | { status: 'duplicate', receipt: LumiRoomDeliveryReceipt, event?: LumiRoomEvent, latestSequence: number }
    | { status: 'conflict', reason: string, latestSequence: number }

export interface AcceptReservedLumiRoomVoiceInput {
  conversationId: string
  idempotencyKey: string
  actorDisplayName?: string
  content: string
  createdAt: number
}

export type AcceptLumiRoomInputResult
  = | { status: 'accepted', event: LumiRoomEvent, receipt: LumiRoomDeliveryReceipt, latestSequence: number }
    | { status: 'duplicate', event: LumiRoomEvent, receipt: LumiRoomDeliveryReceipt, latestSequence: number }
    | { status: 'conflict', reason: string, latestSequence: number }

export interface CompleteLumiRoomInput {
  conversationId: string
  idempotencyKey: string
  messageId: string
  actorId: string
  actorDisplayName?: string
  content: string
  createdAt: number
}

export interface LumiRoomReplay {
  conversationId: string
  afterSequence: number
  latestSequence: number
  retainedFromSequence: number
  truncated: boolean
  events: LumiRoomEvent[]
}

const ledgerKey = (conversationId: string) => `local:lumi/room-ledger/${encodeURIComponent(conversationId)}`

/**
 * Persists the host-authoritative event stream and idempotency receipts for Lumi LAN rooms.
 *
 * Use when:
 * - Accepting a remote room message after identity and membership authorization
 * - Replaying missed events after a client reconnects
 *
 * Expects:
 * - Callers serialize mutations for the same conversation
 * - `actorId` has already been resolved by the trusted host
 *
 * Returns:
 * - Stable host sequences and bounded replay/audit snapshots
 */
export const lumiRoomLedgerRepo = {
  async get(conversationId: string): Promise<LumiRoomLedgerSnapshot> {
    const normalizedConversationId = requiredText(conversationId, 'conversationId', 240)
    const stored = await storage.getItemRaw<LumiRoomLedgerSnapshot>(ledgerKey(normalizedConversationId))
    return normalizeLedger(stored, normalizedConversationId)
  },

  async replace(snapshot: LumiRoomLedgerSnapshot) {
    const normalized = normalizeLedger(snapshot, snapshot.conversationId)
    await storage.setItemRaw(ledgerKey(normalized.conversationId), normalized)
    await mutateLedgerIndex((conversationIds) => {
      if (!conversationIds.includes(normalized.conversationId))
        conversationIds.push(normalized.conversationId)
      return conversationIds
    })
    return normalized
  },

  async listConversationIds() {
    const stored = await storage.getItemRaw<string[]>(LEDGER_INDEX_KEY)
    return uniqueStrings(stored)
  },

  async acceptInput(input: AcceptLumiRoomInput): Promise<AcceptLumiRoomInputResult> {
    const conversationId = requiredText(input.conversationId, 'conversationId', 240)
    const messageId = requiredText(input.messageId, 'messageId', 240)
    const idempotencyKey = requiredText(input.idempotencyKey, 'idempotencyKey', 240)
    const actorId = requiredText(input.actorId, 'actorId', 240)
    const content = requiredText(input.content, 'content', 100_000)
    const snapshot = await this.get(conversationId)
    const existingReceipt = snapshot.receipts.find(receipt => receipt.idempotencyKey === idempotencyKey)
    if (existingReceipt) {
      const event = snapshot.events.find(item => item.sequence === existingReceipt.inputSequence)
      if (existingReceipt.inputKind !== 'text' || !event || existingReceipt.messageId !== messageId || existingReceipt.actorId !== actorId || event.content !== content) {
        return {
          status: 'conflict',
          reason: 'The idempotency key was already used for different room input.',
          latestSequence: snapshot.latestSequence,
        }
      }
      return { status: 'duplicate', event, receipt: existingReceipt, latestSequence: snapshot.latestSequence }
    }

    if (snapshot.receipts.some(receipt => receipt.messageId === messageId)) {
      return {
        status: 'conflict',
        reason: 'The message ID was already used with another idempotency key.',
        latestSequence: snapshot.latestSequence,
      }
    }

    const acceptedAt = finiteTimestamp(input.createdAt)
    const event: LumiRoomEvent = {
      conversationId,
      sequence: snapshot.latestSequence + 1,
      messageId,
      role: 'user',
      actorId,
      actorDisplayName: optionalText(input.actorDisplayName, 160),
      content,
      createdAt: acceptedAt,
    }
    const receipt: LumiRoomDeliveryReceipt = {
      idempotencyKey,
      messageId,
      actorId,
      inputSequence: event.sequence,
      inputKind: 'text',
      status: 'accepted',
      acceptedAt,
      updatedAt: acceptedAt,
    }
    snapshot.latestSequence = event.sequence
    snapshot.events.push(event)
    snapshot.receipts.push(receipt)
    await this.replace(pruneLedger(snapshot))
    return { status: 'accepted', event, receipt, latestSequence: snapshot.latestSequence }
  },

  async reserveVoiceInput(input: ReserveLumiRoomVoiceInput): Promise<ReserveLumiRoomVoiceInputResult> {
    const conversationId = requiredText(input.conversationId, 'conversationId', 240)
    const messageId = requiredText(input.messageId, 'messageId', 240)
    const idempotencyKey = requiredText(input.idempotencyKey, 'idempotencyKey', 240)
    const actorId = requiredText(input.actorId, 'actorId', 240)
    const payloadFingerprint = requiredText(input.payloadFingerprint, 'payloadFingerprint', 240)
    const snapshot = await this.get(conversationId)
    const existingReceipt = snapshot.receipts.find(receipt => receipt.idempotencyKey === idempotencyKey)
    if (existingReceipt) {
      if (existingReceipt.inputKind !== 'voice'
        || existingReceipt.messageId !== messageId
        || existingReceipt.actorId !== actorId
        || existingReceipt.payloadFingerprint !== payloadFingerprint) {
        return {
          status: 'conflict',
          reason: 'The idempotency key was already used for different room input.',
          latestSequence: snapshot.latestSequence,
        }
      }
      const event = snapshot.events.find(item => item.sequence === existingReceipt.inputSequence)
      return { status: 'duplicate', receipt: existingReceipt, event, latestSequence: snapshot.latestSequence }
    }
    if (snapshot.receipts.some(receipt => receipt.messageId === messageId)) {
      return {
        status: 'conflict',
        reason: 'The message ID was already used with another idempotency key.',
        latestSequence: snapshot.latestSequence,
      }
    }

    const acceptedAt = finiteTimestamp(input.createdAt)
    const receipt: LumiRoomDeliveryReceipt = {
      idempotencyKey,
      messageId,
      actorId,
      inputKind: 'voice',
      payloadFingerprint,
      status: 'transcribing',
      acceptedAt,
      updatedAt: acceptedAt,
    }
    snapshot.receipts.push(receipt)
    await this.replace(pruneLedger(snapshot))
    return { status: 'reserved', receipt, latestSequence: snapshot.latestSequence }
  },

  async acceptReservedVoiceInput(input: AcceptReservedLumiRoomVoiceInput) {
    const conversationId = requiredText(input.conversationId, 'conversationId', 240)
    const idempotencyKey = requiredText(input.idempotencyKey, 'idempotencyKey', 240)
    const content = requiredText(input.content, 'content', 100_000)
    const snapshot = await this.get(conversationId)
    const receipt = snapshot.receipts.find(item => item.idempotencyKey === idempotencyKey)
    if (!receipt || receipt.inputKind !== 'voice')
      throw new Error('Cannot accept an unknown Lumi room voice delivery.')
    if (receipt.inputSequence) {
      const existing = snapshot.events.find(event => event.sequence === receipt.inputSequence)
      if (existing)
        return { status: 'duplicate' as const, event: existing, receipt, latestSequence: snapshot.latestSequence }
    }
    if (receipt.status !== 'transcribing')
      throw new Error(`Cannot accept a voice delivery in ${receipt.status} state.`)

    const createdAt = finiteTimestamp(input.createdAt)
    const event: LumiRoomEvent = {
      conversationId,
      sequence: snapshot.latestSequence + 1,
      messageId: receipt.messageId,
      role: 'user',
      actorId: receipt.actorId,
      actorDisplayName: optionalText(input.actorDisplayName, 160),
      content,
      createdAt,
    }
    snapshot.latestSequence = event.sequence
    snapshot.events.push(event)
    receipt.inputSequence = event.sequence
    receipt.status = 'accepted'
    receipt.failureReason = undefined
    receipt.updatedAt = createdAt
    await this.replace(pruneLedger(snapshot))
    return { status: 'accepted' as const, event, receipt, latestSequence: snapshot.latestSequence }
  },

  async cancelInput(conversationId: string, idempotencyKey: string, reason: string, cancelledAt = Date.now()) {
    const snapshot = await this.get(conversationId)
    const receipt = snapshot.receipts.find(item => item.idempotencyKey === idempotencyKey)
    if (!receipt || receipt.status !== 'transcribing')
      return receipt
    receipt.status = 'cancelled'
    receipt.failureReason = optionalText(reason, 500) || 'Voice input was cancelled.'
    receipt.updatedAt = finiteTimestamp(cancelledAt)
    await this.replace(snapshot)
    return receipt
  },

  async completeInput(input: CompleteLumiRoomInput) {
    const conversationId = requiredText(input.conversationId, 'conversationId', 240)
    const idempotencyKey = requiredText(input.idempotencyKey, 'idempotencyKey', 240)
    const snapshot = await this.get(conversationId)
    const receipt = snapshot.receipts.find(item => item.idempotencyKey === idempotencyKey)
    if (!receipt)
      throw new Error('Cannot complete an unknown Lumi room delivery.')
    if (!receipt.inputSequence || receipt.status === 'transcribing' || receipt.status === 'cancelled')
      throw new Error(`Cannot complete a Lumi room delivery in ${receipt.status} state.`)

    if (receipt.status === 'completed' && receipt.assistantSequence) {
      const existing = snapshot.events.find(event => event.sequence === receipt.assistantSequence)
      if (existing)
        return { event: existing, receipt, latestSequence: snapshot.latestSequence }
    }

    const event: LumiRoomEvent = {
      conversationId,
      sequence: snapshot.latestSequence + 1,
      messageId: requiredText(input.messageId, 'messageId', 240),
      role: 'assistant',
      actorId: requiredText(input.actorId, 'actorId', 240),
      actorDisplayName: optionalText(input.actorDisplayName, 160),
      content: requiredText(input.content, 'content', 100_000),
      createdAt: finiteTimestamp(input.createdAt),
    }
    snapshot.latestSequence = event.sequence
    snapshot.events.push(event)
    receipt.status = 'completed'
    receipt.assistantSequence = event.sequence
    receipt.failureReason = undefined
    receipt.updatedAt = event.createdAt
    await this.replace(pruneLedger(snapshot))
    return { event, receipt, latestSequence: snapshot.latestSequence }
  },

  async failInput(conversationId: string, idempotencyKey: string, reason: string, failedAt = Date.now()) {
    const snapshot = await this.get(conversationId)
    const receipt = snapshot.receipts.find(item => item.idempotencyKey === idempotencyKey)
    if (!receipt)
      return undefined
    receipt.status = 'failed'
    receipt.failureReason = optionalText(reason, 500) || 'Room input processing failed.'
    receipt.updatedAt = finiteTimestamp(failedAt)
    await this.replace(snapshot)
    return receipt
  },

  async replay(conversationId: string, afterSequence: number): Promise<LumiRoomReplay> {
    const snapshot = await this.get(conversationId)
    const cursor = Math.max(0, Math.floor(Number.isFinite(afterSequence) ? afterSequence : 0))
    return {
      conversationId: snapshot.conversationId,
      afterSequence: cursor,
      latestSequence: snapshot.latestSequence,
      retainedFromSequence: snapshot.retainedFromSequence,
      truncated: snapshot.events.length > 0 && cursor < snapshot.retainedFromSequence - 1,
      events: snapshot.events.filter(event => event.sequence > cursor),
    }
  },

  async clear(conversationId: string) {
    const normalizedConversationId = requiredText(conversationId, 'conversationId', 240)
    await storage.removeItem(ledgerKey(normalizedConversationId))
    await mutateLedgerIndex(ids => ids.filter(id => id !== normalizedConversationId))
  },

  async clearAll() {
    const conversationIds = await this.listConversationIds()
    for (const conversationId of conversationIds)
      await storage.removeItem(ledgerKey(conversationId))
    await storage.removeItem(LEDGER_INDEX_KEY)
  },
}

/**
 * Normalizes a persisted room ledger.
 *
 * Before:
 * - Missing version, unordered events, or stale latest sequence
 *
 * After:
 * - Version 1 with ordered events and a monotonic latest sequence
 */
function normalizeLedger(value: LumiRoomLedgerSnapshot | null, conversationId: string): LumiRoomLedgerSnapshot {
  const events = Array.isArray(value?.events)
    ? value.events
        .filter(event => event?.conversationId === conversationId && Number.isInteger(event.sequence) && event.sequence > 0)
        .sort((left, right) => left.sequence - right.sequence)
    : []
  const receipts = Array.isArray(value?.receipts)
    ? value.receipts
        .filter(receipt => receipt && typeof receipt.idempotencyKey === 'string' && typeof receipt.messageId === 'string')
        .map(receipt => ({
          ...receipt,
          inputKind: receipt.inputKind === 'voice' ? 'voice' as const : 'text' as const,
        }))
    : []
  const latestSequence = Math.max(value?.latestSequence ?? 0, events.at(-1)?.sequence ?? 0)
  return pruneLedger({
    version: 1,
    conversationId,
    latestSequence,
    retainedFromSequence: events[0]?.sequence ?? latestSequence + 1,
    events,
    receipts,
  })
}

function pruneLedger(snapshot: LumiRoomLedgerSnapshot) {
  snapshot.events = snapshot.events.slice(-MAX_RETAINED_ROOM_EVENTS)
  snapshot.receipts = snapshot.receipts.slice(-MAX_RETAINED_RECEIPTS)
  snapshot.retainedFromSequence = snapshot.events[0]?.sequence ?? snapshot.latestSequence + 1
  return snapshot
}

function requiredText(value: string, field: string, maxLength: number) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized)
    throw new Error(`${field} is required.`)
  if (normalized.length > maxLength)
    throw new Error(`${field} exceeds ${maxLength} characters.`)
  return normalized
}

function optionalText(value: string | undefined, maxLength: number) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : undefined
}

function finiteTimestamp(value: number) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : Date.now()
}

function mutateLedgerIndex(update: (conversationIds: string[]) => string[]) {
  const operation = ledgerIndexWriteQueue.then(async () => {
    const stored = await storage.getItemRaw<string[]>(LEDGER_INDEX_KEY)
    await storage.setItemRaw(LEDGER_INDEX_KEY, uniqueStrings(update(uniqueStrings(stored))))
  })
  ledgerIndexWriteQueue = operation.catch(() => {})
  return operation
}

function uniqueStrings(value: unknown) {
  return [...new Set(Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : [])]
}
