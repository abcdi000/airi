import type { LumiReplyContext } from './onlineServer'

import { describe, expect, it, vi } from 'vitest'

import {
  DOGGY_PERSON_ID,
  LumiServerDatabase,
} from './database'
import { createLumiServerAgentReplyGenerator } from './serverAgentRuntime'

describe('lumiServerAgentRuntime', () => {
  it('runs host-managed Planner rounds and returns only explicit reply-tool output', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const plannerCalls = vi.fn()
    const plannerMessages = vi.fn()
    const plannerModel = {
      async generateStep(input: {
        tools: readonly { name: string }[]
        messages: readonly { content: string }[]
      }) {
        plannerCalls(input.tools.map(tool => tool.name))
        plannerMessages(input.messages.map(message => message.content))
        if (plannerCalls.mock.calls.length === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'reply-call',
              name: 'reply',
              arguments: {
                targetMessageId: 'input-message',
                replyAct: 'answer',
                semanticGoal: '自然地回应用户',
                keyPoints: ['记住这是一段私聊'],
                referenceInfo: [],
              },
            }],
          }
        }
        return {
          content: '',
          toolCalls: [],
        }
      },
    }
    const languageModel = {
      async generate() {
        return JSON.stringify({
          messages: [
            { text: '我在' },
            { text: '刚刚看到了' },
          ],
        })
      },
    }
    try {
      const input = database.acceptUserMessage({
        conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
        actorPersonId: DOGGY_PERSON_ID,
        messageId: 'input-message',
        idempotencyKey: 'device:input-message',
        content: 'Lumi 在吗',
        createdAt: Date.now(),
      }).message
      const generator = createLumiServerAgentReplyGenerator({
        database,
        plannerModel,
        languageModel,
        personaPrompt: '你是 Lumi。',
        runtime: {
          mergeWindowMs: 0,
        },
      })
      const context: LumiReplyContext = {
        conversation: database.listConversations(DOGGY_PERSON_ID)
          .find(item => item.id === `lumi-direct:${DOGGY_PERSON_ID}`)!,
        history: database.replay(`lumi-direct:${DOGGY_PERSON_ID}`, DOGGY_PERSON_ID, 0).messages,
        input,
      }

      const reply = await generator.generate(context, () => {})

      expect(plannerCalls).toHaveBeenCalledTimes(1)
      expect(plannerCalls.mock.calls[0]?.[0]).toContain('reply')
      expect(plannerMessages.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
        expect.stringContaining('<Lumi认知上下文>'),
      ]))
      expect(reply.messages).toMatchObject([
        { content: '我在' },
        { content: '刚刚看到了' },
      ])
      expect(reply.messages?.every(message => Boolean(message.messageId))).toBe(true)
      expect(database.loadAgentSession(context.conversation.id)?.history)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'dialogue_user', messageId: 'input-message' }),
          expect.objectContaining({ kind: 'dialogue_assistant', textSegments: ['我在', '刚刚看到了'] }),
        ]))
      expect(database.exportBackup().sections.cognitiveEvidence).toHaveLength(1)
      expect(database.exportBackup().sections.cognitiveWorkingMemory).toHaveLength(1)
      const recallAudit = database.exportBackup().sections.audits.find(row => row.action === 'agent-automatic_recall')
      expect(recallAudit).toBeDefined()
      expect(JSON.parse(String(recallAudit?.metadata_json))).toMatchObject({
        status: 'completed',
        ran: 'true',
        reusedPreviousState: 'false',
        aclInputCount: '0',
        aclOutputCount: '0',
        lexicalCandidateCount: '0',
        annCandidateCount: '0',
        mergedCandidateCount: '0',
        injectedCount: '0',
        vectorIndexStatus: 'structured_lexical_fallback',
        fallbackReason: 'semantic_recall_unconfigured',
      })
      expect(JSON.parse(String(recallAudit?.metadata_json))).not.toHaveProperty('query')
    }
    finally {
      database.close()
    }
  })

  it('rejects group conversations before issuing any outbound capability', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const generator = createLumiServerAgentReplyGenerator({
      database,
      plannerModel: {
        async generateStep() {
          throw new Error('Planner must not run')
        },
      },
      languageModel: {
        async generate() {
          throw new Error('Replyer must not run')
        },
      },
      personaPrompt: '你是 Lumi。',
    })
    try {
      const conversation = database.listConversations(DOGGY_PERSON_ID)
        .find(item => item.type === 'group')!
      await expect(generator.generate({
        conversation,
        history: [],
        input: {
          id: 'group-input',
          conversationId: conversation.id,
          sequence: 1,
          role: 'user',
          actorPersonId: DOGGY_PERSON_ID,
          content: '群聊消息',
          createdAt: Date.now(),
        },
      }, () => {})).rejects.toThrow('direct conversations only')
    }
    finally {
      database.close()
    }
  })

  it('reuses prior recall state for a low-information continuation without another semantic query', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const semanticMemorySearch = vi.fn(async () => [])
    const plannerModel = {
      async generateStep() {
        return {
          content: '',
          toolCalls: [{
            id: 'reply-call',
            name: 'reply',
            arguments: {
              replyAct: 'answer',
              semanticGoal: '回应当前消息',
              keyPoints: ['保持上下文连续'],
              referenceInfo: [],
            },
          }],
        }
      },
    }
    const generator = createLumiServerAgentReplyGenerator({
      database,
      plannerModel,
      languageModel: {
        async generate() {
          return JSON.stringify({ messages: [{ text: '好' }] })
        },
      },
      personaPrompt: '你是 Lumi。',
      semanticMemorySearch,
      runtime: { mergeWindowMs: 0 },
    })
    try {
      const conversation = database.listConversations(DOGGY_PERSON_ID)
        .find(item => item.id === `lumi-direct:${DOGGY_PERSON_ID}`)!
      const first = database.acceptUserMessage({
        conversationId: conversation.id,
        actorPersonId: DOGGY_PERSON_ID,
        messageId: 'recall-first',
        idempotencyKey: 'recall-first',
        content: '默认使用 Patchright，特殊情况使用 Playwright 吗？',
        createdAt: 1,
      }).message
      await generator.generate({
        conversation,
        history: [first],
        input: first,
      }, () => {})

      const second = database.acceptUserMessage({
        conversationId: conversation.id,
        actorPersonId: DOGGY_PERSON_ID,
        messageId: 'recall-second',
        idempotencyKey: 'recall-second',
        content: '对',
        createdAt: 2,
      }).message
      await generator.generate({
        conversation: database.listConversations(DOGGY_PERSON_ID)
          .find(item => item.id === conversation.id)!,
        history: database.replay(conversation.id, DOGGY_PERSON_ID, 0).messages,
        input: second,
      }, () => {})

      expect(semanticMemorySearch).toHaveBeenCalledTimes(1)
      expect(database.loadCognitiveWorkingMemory({
        actorId: DOGGY_PERSON_ID,
        personaId: 'lumi',
        conversationId: conversation.id,
        conversationType: 'direct',
        participantUserIds: [DOGGY_PERSON_ID],
      })?.recallState).toMatchObject({ reuseCount: 1 })
    }
    finally {
      database.close()
    }
  })
})
