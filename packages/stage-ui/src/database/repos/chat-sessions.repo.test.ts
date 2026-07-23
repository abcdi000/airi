import type { ChatSessionRecord, ChatSessionsIndex } from '../../types/chat-session'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { chatSessionsRepo } from './chat-sessions.repo'

const records = vi.hoisted(() => new Map<string, unknown>())

vi.mock('../storage', () => ({
  storage: {
    getItemRaw: async <T>(key: string) => records.get(key) as T | null ?? null,
    setItemRaw: async (key: string, value: unknown) => { records.set(key, value) },
    removeItem: async (key: string) => { records.delete(key) },
  },
}))

describe('chat session owner migration', () => {
  beforeEach(() => records.clear())

  it('copies legacy local sessions to Doggy with new ids and keeps the source unchanged', async () => {
    const sourceIndex: ChatSessionsIndex = {
      userId: 'local',
      characters: {
        lumi: {
          activeSessionId: 'legacy-main',
          sessions: {
            'legacy-main': {
              sessionId: 'legacy-main',
              userId: 'local',
              characterId: 'lumi',
              conversationType: 'direct',
              participantUserIds: ['local'],
              timelineType: 'main',
              createdAt: 1,
              updatedAt: 2,
            },
          },
        },
      },
    }
    const sourceRecord: ChatSessionRecord = {
      meta: sourceIndex.characters.lumi.sessions['legacy-main'],
      messages: [{ role: 'user', content: 'legacy message', id: 'message-1' }],
    }
    await chatSessionsRepo.saveIndex(sourceIndex)
    await chatSessionsRepo.saveSession('legacy-main', sourceRecord)

    const copied = await chatSessionsRepo.copyUserDataIfTargetEmpty('local', 'lumi-user-doggy0001')
    const sourceAfter = await chatSessionsRepo.getIndex('local')
    const target = await chatSessionsRepo.getIndex('lumi-user-doggy0001')
    const targetId = target?.characters.lumi.activeSessionId ?? ''
    const targetRecord = await chatSessionsRepo.getSession(targetId)

    expect(copied).toBe(true)
    expect(sourceAfter).toEqual(sourceIndex)
    expect(targetId).not.toBe('legacy-main')
    expect(targetRecord?.meta.userId).toBe('lumi-user-doggy0001')
    expect(targetRecord?.messages[0]?.content).toBe('legacy message')
  })

  it('links a group record into participant indexes and preserves it when one participant clears data', async () => {
    const meta: ChatSessionRecord['meta'] = {
      sessionId: 'shared-room',
      userId: 'doggy-user',
      characterId: 'lumi',
      conversationType: 'group',
      participantUserIds: ['doggy-user', 'moussy-user'],
      createdAt: 1,
      updatedAt: 1,
    }
    await chatSessionsRepo.saveSession(meta.sessionId, { meta, messages: [] })
    await chatSessionsRepo.linkSessionToUser('doggy-user', meta)
    await chatSessionsRepo.linkSessionToUser('moussy-user', meta)

    await chatSessionsRepo.clear('doggy-user')

    expect(await chatSessionsRepo.getIndex('doggy-user')).toBeNull()
    expect(await chatSessionsRepo.getSession(meta.sessionId)).toEqual({ meta, messages: [] })
    expect((await chatSessionsRepo.getIndex('moussy-user'))?.characters.lumi.sessions[meta.sessionId]).toEqual(meta)
  })
})
