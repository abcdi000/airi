import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DOGGY_PERSON_ID } from './database'
import { createLumiNetworkServer } from './networkServer'
import { LumiStickerLibrary } from './stickerLibrary'

describe('createLumiNetworkServer', () => {
  it('serves health without exposing management data', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumi-network-test-'))
    const server = await createLumiNetworkServer({
      databasePath: join(directory, 'server.sqlite3'),
      authSecret: 'test-only-secret-with-at-least-thirty-two-characters',
      publicBaseURL: 'http://127.0.0.1:6130',
      serverVersion: 'test',
      createReplyGenerator: () => ({ async generate() { return { content: 'test' } } }),
    })
    try {
      const response = await server.app.request('/health')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: 'ok', role: 'server-runtime' })

      const managementResponse = await server.app.request('/api/manager/users')
      expect(managementResponse.status).toBe(404)
    }
    finally {
      await server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses plaintext listeners reachable beyond the local machine', async () => {
    await expect(createLumiNetworkServer({
      databasePath: 'unused.sqlite3',
      authSecret: 'test-only-secret-with-at-least-thirty-two-characters',
      publicBaseURL: 'http://192.168.1.5:6130',
      hostname: '0.0.0.0',
      serverVersion: 'test',
      createReplyGenerator: () => ({ async generate() { return { content: 'test' } } }),
    })).rejects.toThrow('Lumi refuses plaintext HTTP/WS on a non-loopback listener')
  })

  it('closes a real listener without leaving the server process alive', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumi-network-lifecycle-'))
    const server = await createLumiNetworkServer({
      databasePath: join(directory, 'server.sqlite3'),
      authSecret: 'test-only-secret-with-at-least-thirty-two-characters',
      publicBaseURL: 'http://127.0.0.1',
      hostname: '127.0.0.1',
      port: 0,
      serverVersion: 'test',
      createReplyGenerator: () => ({ async generate() { return { content: 'test' } } }),
    })
    try {
      await server.start()
      await expect(Promise.race([
        server.stop().then(() => 'stopped'),
        new Promise<string>(resolve => setTimeout(resolve, 2_000, 'timeout')),
      ])).resolves.toBe('stopped')
    }
    finally {
      await server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('authenticates voice transcription and enforces the byte limit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumi-network-voice-'))
    const transcribed: Array<{ mimeType: string, bytes: number }> = []
    const server = await createLumiNetworkServer({
      databasePath: join(directory, 'server.sqlite3'),
      authSecret: 'test-only-secret-with-at-least-thirty-two-characters',
      publicBaseURL: 'http://127.0.0.1:6130',
      serverVersion: 'test',
      maxVoiceBytes: 8,
      voiceTranscriber: {
        async transcribe(input) {
          transcribed.push({ mimeType: input.mimeType, bytes: input.audio.byteLength })
          return '你好 Lumi'
        },
      },
      createReplyGenerator: () => ({ async generate() { return { content: 'test' } } }),
      manager: { token: 'test-manager-token-with-at-least-thirty-two-characters' },
    })
    try {
      const bootstrap = await server.managerApp!.request('/bootstrap/doggy', {
        method: 'POST',
        headers: { 'authorization': 'Bearer test-manager-token-with-at-least-thirty-two-characters', 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'doggy', password: 'correct-horse-battery-staple' }),
      })
      expect(bootstrap.status).toBe(200)
      const signIn = await server.app.request('/api/auth/sign-in/username', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'doggy', password: 'correct-horse-battery-staple' }),
      })
      const token = signIn.headers.get('set-auth-token')
      expect(token).toBeTruthy()

      const unauthorized = await server.app.request('/api/lumi/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'audio/wav', 'content-length': '3' },
        body: new Uint8Array([1, 2, 3]),
      })
      expect(unauthorized.status).toBe(401)

      const accepted = await server.app.request('/api/lumi/transcribe', {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'audio/wav', 'content-length': '3' },
        body: new Uint8Array([1, 2, 3]),
      })
      expect(accepted.status).toBe(200)
      expect(await accepted.json()).toEqual({ text: '你好 Lumi' })
      expect(transcribed).toEqual([{ mimeType: 'audio/wav', bytes: 3 }])

      const tooLarge = await server.app.request('/api/lumi/transcribe', {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'audio/wav', 'content-length': '9' },
        body: new Uint8Array(9),
      })
      expect(tooLarge.status).toBe(413)
    }
    finally {
      await server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('authenticates AstrBot perception and resolves its server-owned identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumi-network-astrbot-'))
    const token = 'test-astrbot-token-with-at-least-thirty-two-characters'
    const server = await createLumiNetworkServer({
      databasePath: join(directory, 'server.sqlite3'),
      authSecret: 'test-only-secret-with-at-least-thirty-two-characters',
      publicBaseURL: 'http://127.0.0.1:6130',
      serverVersion: 'test',
      astrbot: {
        apiToken: token,
        identityBindings: [{
          platformInstanceId: 'qq-bot-1',
          externalUserId: '10001',
          personId: DOGGY_PERSON_ID,
        }],
      },
      createReplyGenerator: () => ({
        async generate() {
          return { content: 'Lumi through AstrBot' }
        },
      }),
    })
    const body = JSON.stringify({
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
      segments: [{ type: 'text', text: 'Hello Lumi' }],
    })
    try {
      const unauthorized = await server.app.request('/api/lumi/integrations/astrbot/perceive', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
        body,
      })
      expect(unauthorized.status).toBe(401)

      const accepted = await server.app.request('/api/lumi/integrations/astrbot/perceive', {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
      })
      expect(accepted.status).toBe(200)
      expect(await accepted.json()).toMatchObject({
        text: 'Lumi through AstrBot',
        metadata: {
          actor_person_id: DOGGY_PERSON_ID,
          conversation_id: `lumi-direct:${DOGGY_PERSON_ID}`,
        },
      })
    }
    finally {
      await server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  /**
   * @example
   * An authorized read-only group teaches the server a sticker that can later
   * accompany a private Lumi reply without ever replying to the group.
   */
  it('learns group stickers and returns them through the server AstrBot bridge', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumi-network-sticker-'))
    const token = 'test-astrbot-token-with-at-least-thirty-two-characters'
    const stickerLibrary = new LumiStickerLibrary(() => ({
      enabled: true,
      collectFromStudyGroups: true,
      relativePath: 'stickers',
      maximumItems: 16,
      sendProbability: 1,
      cooldownMessages: 0,
    }), () => directory, {
      classify: async () => ({
        tags: ['觉得好笑'],
        summary: '意识模型判断为轻松玩笑',
        confidence: 0.9,
      }),
      select: async input => ({
        stickerId: input.candidates[0]?.id,
        reason: '意识模型判断适合当前回复',
      }),
    })
    const server = await createLumiNetworkServer({
      databasePath: join(directory, 'server.sqlite3'),
      authSecret: 'test-only-secret-with-at-least-thirty-two-characters',
      publicBaseURL: 'http://127.0.0.1:6130',
      serverVersion: 'test',
      astrbot: {
        apiToken: token,
        identityBindings: [{
          platformInstanceId: 'qq-bot-1',
          externalUserId: '10001',
          personId: DOGGY_PERSON_ID,
        }],
        privateReplyEnabled: true,
        groupObservationEnabled: true,
        studyGroups: [{
          id: 'friends',
          platformInstanceId: 'qq-bot-1',
          groupId: '20001',
          displayName: 'Friends',
          enabled: true,
          priority: 'high',
        }],
        stickerLibrary,
      },
      createReplyGenerator: () => ({
        async generate() {
          return { content: '笑死' }
        },
      }),
    })
    const headers = {
      'authorization': `Bearer ${token}`,
      'content-type': 'application/json',
    }
    try {
      const policyResponse = await server.app.request(
        '/api/lumi/integrations/astrbot/learning-policy',
        { headers },
      )
      expect(policyResponse.status).toBe(200)
      expect(await policyResponse.json()).toMatchObject({
        private_reply_enabled: true,
        group_observation_enabled: true,
      })

      const observationBody = JSON.stringify({
        event_id: 'group-message-1',
        message_id: 'group-message-1',
        platform: 'aiocqhttp',
        platform_instance_id: 'qq-bot-1',
        group_id: '20001',
        sender_id: '30001',
        sender_name: 'Friend',
        author_verified: true,
        is_lumi: false,
        source_kind: 'human_message',
        conversation_type: 'group_observation',
        timestamp: 1_700_000_000,
        segments: [
          { type: 'text', text: '笑死了' },
          { type: 'image', mime_type: 'image/png', data_base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64') },
        ],
      })
      const observation = await server.app.request('/api/lumi/integrations/astrbot/observe', {
        method: 'POST',
        headers,
        body: observationBody,
      })
      expect(observation.status).toBe(202)
      expect(await observation.json()).toEqual({
        accepted: true,
        reply_suppressed: true,
      })
      expect(await stickerLibrary.snapshot()).toMatchObject({ stats: { owned: 1 } })

      const privateBody = JSON.stringify({
        event_id: 'private-message-1',
        platform: 'aiocqhttp',
        platform_instance_id: 'qq-bot-1',
        unified_session_id: 'aiocqhttp:friend:10001',
        conversation_id: 'aiocqhttp:friend:10001',
        sender_id: '10001',
        sender_name: 'Doggy',
        group_id: null,
        message_id: 'private-message-1',
        timestamp: 1_700_000_001,
        is_private: true,
        is_group: false,
        is_mention: false,
        segments: [{ type: 'text', text: '笑死了' }],
      })
      const response = await server.app.request('/api/lumi/integrations/astrbot/perceive', {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(privateBody)) },
        body: privateBody,
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        segments: [
          { type: 'text', text: '笑死' },
          { type: 'image', mime_type: 'image/png' },
        ],
      })
    }
    finally {
      await server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
