import type {
  LumiAstrBotIntegrationError,
} from './astrbotIntegration'

import { Buffer } from 'node:buffer'

import { createLumiImageUnderstandingResult } from '@proj-airi/lumi-runtime'
import { describe, expect, it, vi } from 'vitest'

import {
  LumiAstrBotIntegration,
} from './astrbotIntegration'
import {
  DOGGY_PERSON_ID,
  LumiServerDatabase,
} from './database'
import { LumiOnlineServer } from './onlineServer'

describe('lumiAstrBotIntegration', () => {
  it('resolves the server-owned person and writes one direct Lumi turn', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const generated: string[] = []
    const server = new LumiOnlineServer({
      database,
      serverVersion: 'test',
      replyGenerator: {
        async generate(context) {
          generated.push(context.input.content)
          return { content: 'Lumi reply' }
        },
      },
    })
    const integration = new LumiAstrBotIntegration({
      database,
      onlineServer: server,
      identityBindings: [{
        platformInstanceId: 'qq-bot-1',
        externalUserId: '10001',
        personId: DOGGY_PERSON_ID,
      }],
    })
    try {
      const result = await integration.perceiveAndRespond(event({
        segments: [{ type: 'text', text: '  第一段\n第二段  ' }],
      }))

      expect(result.text).toBe('Lumi reply')
      expect(result.metadata.actor_person_id).toBe(DOGGY_PERSON_ID)
      expect(result.metadata.conversation_id).toBe(`lumi-direct:${DOGGY_PERSON_ID}`)
      expect(generated).toHaveLength(1)
      expect(generated[0]).toContain('"text":"  第一段\\n第二段  "')
      expect(database.replay(`lumi-direct:${DOGGY_PERSON_ID}`, DOGGY_PERSON_ID, 0).messages).toHaveLength(2)
    }
    finally {
      database.close()
    }
  })

  it('keeps text, visual perception, text, and hearing in original order', async () => {
    const database = LumiServerDatabase.open(':memory:')
    let generated = ''
    const vision = vi.fn(async () => createLumiImageUnderstandingResult({
      text: '一张测试图片',
      model: 'fake-vision',
      workloadId: 'test',
    }))
    const hearing = vi.fn(async () => '语音内容')
    const server = new LumiOnlineServer({
      database,
      serverVersion: 'test',
      replyGenerator: {
        async generate(context) {
          generated = context.input.content
          return { content: '融合回复' }
        },
      },
    })
    const integration = new LumiAstrBotIntegration({
      database,
      onlineServer: server,
      identityBindings: [{
        platformInstanceId: 'qq-bot-1',
        externalUserId: '10001',
        personId: DOGGY_PERSON_ID,
      }],
      visionAnalyzer: { analyze: vision },
      voiceTranscriber: { transcribe: hearing },
    })
    try {
      await integration.perceiveAndRespond(event({
        segments: [
          { type: 'text', text: '先看图' },
          {
            type: 'image',
            mime_type: 'image/png',
            size_bytes: 8,
            data_base64: Buffer.from('\x89PNG\r\n\x1A\n', 'latin1').toString('base64'),
          },
          { type: 'text', text: '再听一下' },
          {
            type: 'audio',
            mime_type: 'audio/wav',
            size_bytes: 12,
            data_base64: Buffer.from('RIFF0000WAVE').toString('base64'),
          },
        ],
      }))

      const orderedTypes = JSON.parse(generated.split('\n')[1]!) as Array<{ type: string }>
      expect(orderedTypes.map(item => item.type)).toEqual([
        'text',
        'visual_perception',
        'text',
        'auditory_perception',
      ])
      expect(vision).toHaveBeenCalledOnce()
      expect(hearing).toHaveBeenCalledOnce()
    }
    finally {
      database.close()
    }
  })

  it('rejects an external sender that the server owner did not bind', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const server = new LumiOnlineServer({
      database,
      serverVersion: 'test',
      replyGenerator: { async generate() { return { content: 'unused' } } },
    })
    const integration = new LumiAstrBotIntegration({
      database,
      onlineServer: server,
      identityBindings: [],
    })
    try {
      await expect(integration.perceiveAndRespond(event())).rejects.toMatchObject({
        code: 'identity_unbound',
      } satisfies Partial<LumiAstrBotIntegrationError>)
    }
    finally {
      database.close()
    }
  })

  it('rejects group events even when the sender identity is bound', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const server = new LumiOnlineServer({
      database,
      serverVersion: 'test',
      replyGenerator: { async generate() { return { content: 'unused' } } },
    })
    const integration = new LumiAstrBotIntegration({
      database,
      onlineServer: server,
      identityBindings: [{
        platformInstanceId: 'qq-bot-1',
        externalUserId: '10001',
        personId: DOGGY_PERSON_ID,
      }],
    })
    try {
      await expect(integration.perceiveAndRespond(event({
        conversation_id: 'aiocqhttp:group:2747277822',
        group_id: '2747277822',
        is_private: false,
        is_group: true,
      }))).rejects.toMatchObject({
        code: 'invalid_event',
        message: 'AstrBot group events are disabled',
      } satisfies Partial<LumiAstrBotIntegrationError>)
    }
    finally {
      database.close()
    }
  })

  it('deduplicates platform delivery without running consciousness twice', async () => {
    const database = LumiServerDatabase.open(':memory:')
    let generations = 0
    const server = new LumiOnlineServer({
      database,
      serverVersion: 'test',
      replyGenerator: {
        async generate() {
          generations += 1
          return { content: 'only once' }
        },
      },
    })
    const integration = new LumiAstrBotIntegration({
      database,
      onlineServer: server,
      identityBindings: [{
        platformInstanceId: 'qq-bot-1',
        externalUserId: '10001',
        personId: DOGGY_PERSON_ID,
      }],
    })
    try {
      expect((await integration.perceiveAndRespond(event())).text).toBe('only once')
      expect((await integration.perceiveAndRespond(event())).text).toBe('only once')
      expect(generations).toBe(1)
    }
    finally {
      database.close()
    }
  })

  it('returns each structured Lumi message as one ordered AstrBot text segment', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const server = new LumiOnlineServer({
      database,
      serverVersion: 'test',
      replyGenerator: {
        async generate() {
          return {
            messages: [
              { content: 'first' },
              { content: 'second' },
            ],
          }
        },
      },
    })
    const integration = new LumiAstrBotIntegration({
      database,
      onlineServer: server,
      identityBindings: [{
        platformInstanceId: 'qq-bot-1',
        externalUserId: '10001',
        personId: DOGGY_PERSON_ID,
      }],
    })
    try {
      const response = await integration.perceiveAndRespond(event())
      expect(response.text).toBe('first\nsecond')
      expect(response.segments).toHaveLength(2)
      expect(response.segments.map(segment => segment.type)).toEqual(['text', 'text'])
      expect(response.segments.map(segment => 'text' in segment ? segment.text : undefined)).toEqual(['first', 'second'])
      expect(response.metadata.message_count).toBe(2)
    }
    finally {
      database.close()
    }
  })

  it('completes an intentional empty turn without timing out or sending blank text', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const server = new LumiOnlineServer({
      database,
      serverVersion: 'test',
      replyGenerator: {
        async generate() {
          return { messages: [] }
        },
      },
    })
    const integration = new LumiAstrBotIntegration({
      database,
      onlineServer: server,
      identityBindings: [{
        platformInstanceId: 'qq-bot-1',
        externalUserId: '10001',
        personId: DOGGY_PERSON_ID,
      }],
      responseTimeoutMs: 100,
    })
    try {
      const response = await integration.perceiveAndRespond(event())
      expect(response.text).toBeNull()
      expect(response.segments).toEqual([])
      expect(response.metadata.message_count).toBe(0)
    }
    finally {
      database.close()
    }
  })
})

function event(overrides: Record<string, unknown> = {}) {
  return {
    event_id: 'qq-bot-1:message-1',
    platform: 'aiocqhttp',
    platform_instance_id: 'qq-bot-1',
    unified_session_id: 'aiocqhttp:friend:10001',
    conversation_id: 'aiocqhttp:friend:10001',
    sender_id: '10001',
    sender_name: 'Doggy',
    group_id: null,
    message_id: 'message-1',
    timestamp: 1_700_000_000,
    is_private: true,
    is_group: false,
    is_mention: false,
    segments: [{ type: 'text', text: '你好 Lumi' }],
    ...overrides,
  }
}
