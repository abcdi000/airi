import type { LumiGenerationPushed, LumiOnlineMessage } from '@proj-airi/lumi-online'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defineInvoke } from '@moeru/eventa'
import { createContext } from '@moeru/eventa/adapters/websocket/native'
import {
  LUMI_ONLINE_PROTOCOL_VERSION,
  lumiOnlineGenerationPushed,
  lumiOnlineHello,
  lumiOnlineListConversations,
  lumiOnlineMessagesPushed,
  lumiOnlineReplayConversation,
  lumiOnlineSendMessage,
} from '@proj-airi/lumi-online'
import { describe, expect, it } from 'vitest'

import { DOGGY_MOUSSY_GROUP_ID, DOGGY_PERSON_ID, MOUSSY_PERSON_ID } from './database'
import { createLumiNetworkServer } from './networkServer'

describe('lumi Online dual-client transport', () => {
  it('isolates direct chats and reliably replays a shared group after reconnect', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumi-dual-client-'))
    const managerToken = 'test-manager-token-with-at-least-thirty-two-characters'
    let generations = 0
    const server = await createLumiNetworkServer({
      databasePath: join(directory, 'server.sqlite3'),
      authSecret: 'test-auth-secret-with-at-least-thirty-two-characters',
      publicBaseURL: 'http://127.0.0.1',
      hostname: '127.0.0.1',
      port: 0,
      serverVersion: 'test',
      manager: { token: managerToken, port: 0 },
      createReplyGenerator: () => ({
        async generate(context, emitDelta) {
          generations += 1
          emitDelta('Lumi')
          return {
            content: `Lumi reply to ${context.input.content}`,
            expression: 'happy',
            motion: 'Happy',
          }
        },
      }),
    })
    let doggy: Awaited<ReturnType<typeof connectClient>> | undefined
    let moussy: Awaited<ReturnType<typeof connectClient>> | undefined
    let reconnectedMoussy: Awaited<ReturnType<typeof connectClient>> | undefined
    try {
      await within(provisionAccounts(server, managerToken), 'account provisioning')
      const doggyToken = await within(signIn(server, 'doggy', 'correct-horse-battery-staple'), 'Doggy sign-in')
      const moussyToken = await within(signIn(server, 'moussy', 'moussy-correct-horse-battery'), 'Moussy sign-in')
      await within(server.start(), 'server startup')
      const serverUrl = server.url()
      expect(serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)

      doggy = await connectClient(serverUrl!, doggyToken, 'doggy-device')
      moussy = await connectClient(serverUrl!, moussyToken, 'moussy-device')
      expect(doggy.personId).toBe(DOGGY_PERSON_ID)
      expect(moussy.personId).toBe(MOUSSY_PERSON_ID)

      const doggyConversations = await doggy.listConversations()
      const moussyConversations = await moussy.listConversations()
      expect(doggyConversations.map(item => item.id)).toEqual(expect.arrayContaining([
        `lumi-direct:${DOGGY_PERSON_ID}`,
        DOGGY_MOUSSY_GROUP_ID,
      ]))
      expect(doggyConversations.some(item => item.id === `lumi-direct:${MOUSSY_PERSON_ID}`)).toBe(false)
      expect(moussyConversations.map(item => item.id)).toEqual(expect.arrayContaining([
        `lumi-direct:${MOUSSY_PERSON_ID}`,
        DOGGY_MOUSSY_GROUP_ID,
      ]))
      expect(moussyConversations.some(item => item.id === `lumi-direct:${DOGGY_PERSON_ID}`)).toBe(false)

      const firstGroupRequest = request(DOGGY_MOUSSY_GROUP_ID, 'group-1', 'hello together')
      expect((await doggy.send(firstGroupRequest)).status).toBe('accepted')
      expect((await doggy.send(firstGroupRequest)).status).toBe('duplicate')
      await until(() => doggy!.completed.some(item => item.inputMessageId === 'group-1'))
      await until(() => moussy!.completed.some(item => item.inputMessageId === 'group-1'))
      expect(generations).toBe(1)

      const firstReplay = await moussy.replay(DOGGY_MOUSSY_GROUP_ID, 0)
      expect(firstReplay.messages.map(item => item.sequence)).toEqual([1, 2])
      expect(firstReplay.messages[1]).toMatchObject({ expression: 'happy', motion: 'Happy' })

      const moussyVisibleBeforeDirect = moussy.messages.length
      await doggy.send(request(`lumi-direct:${DOGGY_PERSON_ID}`, 'doggy-private-1', 'private Doggy note'))
      await until(() => doggy!.completed.some(item => item.inputMessageId === 'doggy-private-1'))
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(moussy.messages).toHaveLength(moussyVisibleBeforeDirect)
      await expect(moussy.replay(`lumi-direct:${DOGGY_PERSON_ID}`, 0)).rejects.toThrow()

      moussy.close()
      const cursor = firstReplay.latestSequence
      await doggy.send(request(DOGGY_MOUSSY_GROUP_ID, 'group-2', 'message while Moussy reconnects'))
      await until(() => doggy!.completed.some(item => item.inputMessageId === 'group-2'))

      reconnectedMoussy = await connectClient(serverUrl!, moussyToken, 'moussy-device')
      const catchUp = await reconnectedMoussy.replay(DOGGY_MOUSSY_GROUP_ID, cursor)
      expect(catchUp.messages.map(item => item.sequence)).toEqual([3, 4])
      expect(catchUp.messages.map(item => item.content)).toEqual([
        'message while Moussy reconnects',
        'Lumi reply to message while Moussy reconnects',
      ])
    }
    finally {
      doggy?.close()
      moussy?.close()
      reconnectedMoussy?.close()
      await within(server.stop(), 'server shutdown')
      rmSync(directory, { recursive: true, force: true })
    }
  }, 20_000)

  it('preserves sessions, idempotency, and replay cursors across a server restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumi-server-restart-'))
    const databasePath = join(directory, 'server.sqlite3')
    const managerToken = 'restart-manager-token-with-at-least-thirty-two-characters'
    const authSecret = 'restart-auth-secret-with-at-least-thirty-two-characters'
    let generations = 0
    const createServer = async () => await createLumiNetworkServer({
      databasePath,
      authSecret,
      publicBaseURL: 'http://127.0.0.1',
      hostname: '127.0.0.1',
      port: 0,
      serverVersion: 'test',
      manager: { token: managerToken, port: 0 },
      createReplyGenerator: () => ({
        async generate(context) {
          generations += 1
          return { content: `Restart-safe reply to ${context.input.content}` }
        },
      }),
    })
    let server = await createServer()
    let doggy: Awaited<ReturnType<typeof connectClient>> | undefined
    try {
      await within(provisionAccounts(server, managerToken), 'account provisioning')
      const doggyToken = await within(signIn(server, 'doggy', 'correct-horse-battery-staple'), 'Doggy sign-in')
      await within(server.start(), 'initial server startup')
      doggy = await connectClient(server.url()!, doggyToken, 'doggy-restart-device')
      const firstRequest = request(DOGGY_MOUSSY_GROUP_ID, 'restart-message-1', 'before restart')
      await doggy.send(firstRequest)
      await until(() => doggy!.completed.some(item => item.inputMessageId === 'restart-message-1'))
      const beforeRestart = await doggy.replay(DOGGY_MOUSSY_GROUP_ID, 0)
      expect(beforeRestart.messages.map(item => item.sequence)).toEqual([1, 2])
      doggy.close()
      doggy = undefined
      await within(server.stop(), 'initial server shutdown')

      server = await createServer()
      await within(server.start(), 'restarted server startup')
      doggy = await connectClient(server.url()!, doggyToken, 'doggy-restart-device')
      expect((await doggy.send(firstRequest)).status).toBe('duplicate')
      expect(generations).toBe(1)
      expect((await doggy.replay(DOGGY_MOUSSY_GROUP_ID, beforeRestart.latestSequence)).messages).toEqual([])

      await doggy.send(request(DOGGY_MOUSSY_GROUP_ID, 'restart-message-2', 'after restart'))
      await until(() => doggy!.completed.some(item => item.inputMessageId === 'restart-message-2'))
      const catchUp = await doggy.replay(DOGGY_MOUSSY_GROUP_ID, beforeRestart.latestSequence)
      expect(catchUp.messages.map(item => item.sequence)).toEqual([3, 4])
      expect(catchUp.messages.map(item => item.content)).toEqual([
        'after restart',
        'Restart-safe reply to after restart',
      ])
      expect(generations).toBe(2)
    }
    finally {
      doggy?.close()
      await within(server.stop(), 'final server shutdown')
      rmSync(directory, { recursive: true, force: true })
    }
  }, 20_000)
})

async function provisionAccounts(server: Awaited<ReturnType<typeof createLumiNetworkServer>>, managerToken: string) {
  const managerHeaders = { 'authorization': `Bearer ${managerToken}`, 'content-type': 'application/json' }
  const bootstrap = await server.managerApp!.request('/bootstrap/doggy', {
    method: 'POST',
    headers: managerHeaders,
    body: JSON.stringify({ username: 'doggy', password: 'correct-horse-battery-staple' }),
  })
  expect(bootstrap.status).toBe(200)
  const invitationResponse = await server.managerApp!.request('/invitations', {
    method: 'POST',
    headers: managerHeaders,
    body: JSON.stringify({ personId: MOUSSY_PERSON_ID }),
  })
  expect(invitationResponse.status).toBe(200)
  const invitation = await invitationResponse.json() as { code: string }
  const claim = await server.app.request('/api/lumi/invitations/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: invitation.code, username: 'moussy', password: 'moussy-correct-horse-battery' }),
  })
  expect(claim.status).toBe(200)
}

async function signIn(server: Awaited<ReturnType<typeof createLumiNetworkServer>>, username: string, password: string) {
  const response = await server.app.request('/api/auth/sign-in/username', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  expect(response.status).toBe(200)
  const token = response.headers.get('set-auth-token')
  expect(token).toBeTruthy()
  return token!
}

async function connectClient(serverUrl: string, token: string, deviceId: string) {
  const url = new URL('/ws', serverUrl)
  url.protocol = 'ws:'
  url.searchParams.set('access_token', token)
  const socket = await openSocket(url)
  const { context } = createContext(socket)
  const messages: LumiOnlineMessage[] = []
  const completed: LumiGenerationPushed[] = []
  context.on(lumiOnlineMessagesPushed, (event) => {
    if (event.body)
      messages.push(...event.body.messages)
  })
  context.on(lumiOnlineGenerationPushed, (event) => {
    if (event.body?.state === 'completed')
      completed.push(event.body)
  })
  const hello = await within(defineInvoke(context, lumiOnlineHello)({
    protocolVersion: LUMI_ONLINE_PROTOCOL_VERSION,
    clientVersion: 'integration-test',
    deviceId,
    deviceName: deviceId,
    platform: 'test',
  }), `${deviceId} hello`)
  return {
    personId: hello.person.id,
    messages,
    completed,
    listConversations: async () => (await within(defineInvoke(context, lumiOnlineListConversations)(undefined), `${deviceId} list conversations`)).conversations,
    replay: async (conversationId: string, afterSequence: number) => await within(defineInvoke(context, lumiOnlineReplayConversation)({ conversationId, afterSequence }), `${deviceId} replay`),
    send: async (input: ReturnType<typeof request>) => await within(defineInvoke(context, lumiOnlineSendMessage)(input), `${deviceId} send`),
    close: () => socket.close(1000, 'test complete'),
  }
}

function request(conversationId: string, messageId: string, content: string) {
  return {
    conversationId,
    messageId,
    idempotencyKey: `test-device:${messageId}`,
    content,
    createdAt: Date.now(),
  }
}

async function openSocket(url: URL) {
  const socket = new WebSocket(url)
  return await new Promise<WebSocket>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out opening test WebSocket')), 5_000)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(socket)
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('Test WebSocket failed'))
    }, { once: true })
  })
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate())
      return
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for dual-client delivery')
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 3_000)
      }),
    ])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
}
