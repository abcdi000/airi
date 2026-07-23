import { beforeEach, describe, expect, it, vi } from 'vitest'

import { lumiRoomLedgerRepo } from './lumi-room-ledger.repo'

const records = vi.hoisted(() => new Map<string, unknown>())

vi.mock('../storage', () => ({
  storage: {
    getItemRaw: async <T>(key: string) => records.get(key) as T | null ?? null,
    setItemRaw: async (key: string, value: unknown) => { records.set(key, structuredClone(value)) },
    removeItem: async (key: string) => { records.delete(key) },
  },
}))

describe('lumi room ledger repository', () => {
  beforeEach(() => records.clear())

  it('assigns monotonic host sequences and replays events after a cursor', async () => {
    const accepted = await lumiRoomLedgerRepo.acceptInput(input())
    expect(accepted.status).toBe('accepted')
    if (accepted.status !== 'accepted')
      throw new Error('Expected accepted room input')
    expect(accepted.event.sequence).toBe(1)

    const completed = await lumiRoomLedgerRepo.completeInput({
      conversationId: 'room-1',
      idempotencyKey: 'operation-1',
      messageId: 'assistant-1',
      actorId: 'lumi',
      actorDisplayName: 'Lumi',
      content: 'Hello Doggy.',
      createdAt: 20,
    })
    expect(completed.event.sequence).toBe(2)
    expect(completed.receipt.status).toBe('completed')

    const replay = await lumiRoomLedgerRepo.replay('room-1', 1)
    expect(replay.latestSequence).toBe(2)
    expect(replay.truncated).toBe(false)
    expect(replay.events).toEqual([
      expect.objectContaining({ sequence: 2, role: 'assistant', content: 'Hello Doggy.' }),
    ])
  })

  it('returns duplicate without allocating another sequence or running a second turn', async () => {
    const first = await lumiRoomLedgerRepo.acceptInput(input())
    const duplicate = await lumiRoomLedgerRepo.acceptInput(input())
    const snapshot = await lumiRoomLedgerRepo.get('room-1')

    expect(first.status).toBe('accepted')
    expect(duplicate.status).toBe('duplicate')
    expect(snapshot.latestSequence).toBe(1)
    expect(snapshot.events).toHaveLength(1)
    expect(snapshot.receipts).toHaveLength(1)
  })

  it('rejects reuse of an idempotency key or message id for different input', async () => {
    await lumiRoomLedgerRepo.acceptInput(input())

    const reusedOperation = await lumiRoomLedgerRepo.acceptInput(input({ content: 'Changed content' }))
    const reusedMessage = await lumiRoomLedgerRepo.acceptInput(input({ idempotencyKey: 'operation-2' }))
    const snapshot = await lumiRoomLedgerRepo.get('room-1')

    expect(reusedOperation).toMatchObject({ status: 'conflict' })
    expect(reusedMessage).toMatchObject({ status: 'conflict' })
    expect(snapshot.latestSequence).toBe(1)
  })

  it('persists failed delivery state in the host audit receipt', async () => {
    await lumiRoomLedgerRepo.acceptInput(input())
    const receipt = await lumiRoomLedgerRepo.failInput('room-1', 'operation-1', 'provider unavailable', 30)
    const snapshot = await lumiRoomLedgerRepo.get('room-1')

    expect(receipt).toMatchObject({ status: 'failed', failureReason: 'provider unavailable', updatedAt: 30 })
    expect(snapshot.receipts[0]).toMatchObject({ status: 'failed', failureReason: 'provider unavailable' })
  })

  it('reserves voice input before transcription and accepts its transcript exactly once', async () => {
    const reservation = await lumiRoomLedgerRepo.reserveVoiceInput({
      conversationId: 'room-1',
      messageId: 'voice-1',
      idempotencyKey: 'voice-operation-1',
      actorId: 'doggy-user',
      payloadFingerprint: 'sha256:audio-1',
      createdAt: 10,
    })
    expect(reservation.status).toBe('reserved')
    if (reservation.status !== 'reserved')
      throw new Error('Expected reserved voice input')
    expect(reservation.receipt).toMatchObject({ status: 'transcribing', inputKind: 'voice' })
    expect(reservation.receipt.inputSequence).toBeUndefined()

    const accepted = await lumiRoomLedgerRepo.acceptReservedVoiceInput({
      conversationId: 'room-1',
      idempotencyKey: 'voice-operation-1',
      actorDisplayName: 'Doggy',
      content: 'Voice transcript.',
      createdAt: 20,
    })
    const duplicate = await lumiRoomLedgerRepo.acceptReservedVoiceInput({
      conversationId: 'room-1',
      idempotencyKey: 'voice-operation-1',
      actorDisplayName: 'Doggy',
      content: 'Voice transcript.',
      createdAt: 30,
    })
    const snapshot = await lumiRoomLedgerRepo.get('room-1')

    expect(accepted.status).toBe('accepted')
    expect(accepted.event).toMatchObject({ sequence: 1, content: 'Voice transcript.' })
    expect(duplicate.status).toBe('duplicate')
    expect(snapshot.events).toHaveLength(1)
  })

  it('deduplicates reserved voice uploads and persists cancellation before chat ingestion', async () => {
    const input = {
      conversationId: 'room-1',
      messageId: 'voice-1',
      idempotencyKey: 'voice-operation-1',
      actorId: 'doggy-user',
      payloadFingerprint: 'sha256:audio-1',
      createdAt: 10,
    }
    await lumiRoomLedgerRepo.reserveVoiceInput(input)
    const duplicate = await lumiRoomLedgerRepo.reserveVoiceInput(input)
    const conflict = await lumiRoomLedgerRepo.reserveVoiceInput({ ...input, payloadFingerprint: 'sha256:different' })
    const cancelled = await lumiRoomLedgerRepo.cancelInput('room-1', input.idempotencyKey, 'Cancelled by Doggy.', 20)

    expect(duplicate.status).toBe('duplicate')
    expect(conflict.status).toBe('conflict')
    expect(cancelled).toMatchObject({ status: 'cancelled', failureReason: 'Cancelled by Doggy.' })
    await expect(lumiRoomLedgerRepo.acceptReservedVoiceInput({
      conversationId: 'room-1',
      idempotencyKey: input.idempotencyKey,
      content: 'Too late.',
      createdAt: 30,
    })).rejects.toThrow('cancelled')
  })
})

function input(patch: Partial<Parameters<typeof lumiRoomLedgerRepo.acceptInput>[0]> = {}) {
  return {
    conversationId: 'room-1',
    messageId: 'message-1',
    idempotencyKey: 'operation-1',
    actorId: 'doggy-user',
    actorDisplayName: 'Doggy',
    content: 'Hello Lumi.',
    createdAt: 10,
    ...patch,
  }
}
