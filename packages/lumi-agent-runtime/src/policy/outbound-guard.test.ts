import type { DirectOutboundAdapter } from '../ports/outbound'

import { describe, expect, it, vi } from 'vitest'

import {
  DirectOutboundAuthority,
  GroupOutboundForbiddenError,
} from './outbound-guard'

function createEnvelope() {
  return {
    eventId: 'event-1',
    conversationId: 'direct-doggy',
    personId: 'doggy',
    platform: 'qq',
    platformInstanceId: 'qq-main',
    externalUserId: '1770249418',
    timestamp: 1,
    text: 'hello',
    segments: [{ type: 'text' as const, text: 'hello' }],
    attachments: [],
    sourceMessageId: 'message-1',
    participantPersonIds: ['doggy'],
    conversationType: 'direct' as const,
  }
}

function createAdapter(): DirectOutboundAdapter {
  const result = { messageId: 'sent-1', timestamp: 2 }
  return {
    sendText: vi.fn(async () => result),
    sendImage: vi.fn(async () => result),
    sendSticker: vi.fn(async () => result),
    sendVoice: vi.fn(async () => result),
    sendAt: vi.fn(async () => result),
    sendQuote: vi.fn(async () => result),
  }
}

describe('directOutboundAuthority', () => {
  it('allows every outbound operation with the issued direct capability', async () => {
    const adapter = createAdapter()
    const authority = new DirectOutboundAuthority(adapter, { record: vi.fn() })
    const capability = authority.issue(createEnvelope())
    const target = { conversationId: 'direct-doggy', personId: 'doggy' }

    await authority.sendText(capability, { ...target, text: 'hello' })
    await authority.sendImage(capability, { ...target, localPath: 'image.png' })
    await authority.sendSticker(capability, { ...target, stickerId: 'sticker-1', localPath: 'sticker.png' })
    await authority.sendVoice(capability, { ...target, audio: new Uint8Array([1]), mimeType: 'audio/wav' })
    await authority.sendAt(capability, { ...target, externalUserId: '1770249418' })
    await authority.sendQuote(capability, { ...target, sourceMessageId: 'message-1' })

    expect(adapter.sendText).toHaveBeenCalledOnce()
    expect(adapter.sendImage).toHaveBeenCalledOnce()
    expect(adapter.sendSticker).toHaveBeenCalledOnce()
    expect(adapter.sendVoice).toHaveBeenCalledOnce()
    expect(adapter.sendAt).toHaveBeenCalledOnce()
    expect(adapter.sendQuote).toHaveBeenCalledOnce()
  })

  it('rejects a forged capability and writes a security audit', async () => {
    const audit = { record: vi.fn() }
    const authority = new DirectOutboundAuthority(createAdapter(), audit)
    const forgedCapability = Object.freeze({})

    await expect(authority.sendText(
      // The cast models an untrusted plugin crossing the JavaScript runtime boundary.
      forgedCapability as never,
      { conversationId: 'group-42', personId: 'member', text: 'forbidden' },
    )).rejects.toBeInstanceOf(GroupOutboundForbiddenError)
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      code: 'GROUP_OUTBOUND_FORBIDDEN',
      operation: 'sendText',
    }))
  })

  it('rejects a capability used for another conversation', async () => {
    const audit = { record: vi.fn() }
    const authority = new DirectOutboundAuthority(createAdapter(), audit)
    const capability = authority.issue(createEnvelope())

    await expect(authority.sendSticker(capability, {
      conversationId: 'group-42',
      personId: 'doggy',
      stickerId: 'sticker-1',
      localPath: 'sticker.png',
    })).rejects.toThrow('conversation')
    expect(audit.record).toHaveBeenCalledOnce()
  })
})
