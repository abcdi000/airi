import type { ChatSessionMeta } from '../types/chat-session'

import { describe, expect, it } from 'vitest'

import { canUserAccessChatSession, normalizeChatMessageActors, normalizeChatSessionMeta } from './chat-conversation'

function meta(patch: Partial<ChatSessionMeta> = {}): ChatSessionMeta {
  return {
    sessionId: 'conversation-1',
    userId: 'doggy',
    characterId: 'lumi',
    conversationType: 'direct',
    participantUserIds: ['doggy'],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

describe('chat conversation policy', () => {
  it('keeps direct sessions owner-only and exposes groups to every participant', () => {
    const direct = meta()
    const group = meta({
      conversationType: 'group',
      participantUserIds: ['doggy', 'moussy'],
    })

    expect(canUserAccessChatSession(direct, 'doggy')).toBe(true)
    expect(canUserAccessChatSession(direct, 'moussy')).toBe(false)
    expect(canUserAccessChatSession(group, 'doggy')).toBe(true)
    expect(canUserAccessChatSession(group, 'moussy')).toBe(true)
    expect(canUserAccessChatSession(group, 'stranger')).toBe(false)
  })

  it('normalizes legacy direct metadata and assigns deterministic message actors', () => {
    const legacy = JSON.parse(JSON.stringify({
      sessionId: 'legacy-direct',
      userId: 'doggy',
      characterId: 'lumi',
      createdAt: 1,
      updatedAt: 1,
    })) as ChatSessionMeta
    const normalized = normalizeChatSessionMeta(legacy)
    const messages = normalizeChatMessageActors([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', slices: [], tool_results: [] },
    ], normalized)

    expect(normalized.conversationType).toBe('direct')
    expect(normalized.participantUserIds).toEqual(['doggy'])
    expect(messages[0]).toMatchObject({ role: 'user', actorId: 'doggy' })
    expect(messages[1]).toMatchObject({ role: 'assistant', actorId: 'lumi' })
  })
})
