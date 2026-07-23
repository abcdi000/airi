import type { LumiAuthenticatedSession } from './auth'

import { describe, expect, it } from 'vitest'

import {
  DOGGY_MOUSSY_GROUP_ID,
  DOGGY_PERSON_ID,
  LumiServerDatabase,
  MOUSSY_PERSON_ID,
} from './database'
import { LumiOnlineServer } from './onlineServer'

describe('lumiOnlineServer', () => {
  it('delivers direct messages only to the authenticated conversation member', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const server = createServer(database)
    const deliveries: Array<{ personIds: string[], type: string }> = []
    server.onDelivery(delivery => deliveries.push({ personIds: delivery.personIds, type: delivery.type }))
    try {
      server.sendMessage(session(DOGGY_PERSON_ID, 'Doggy', 'owner'), {
        conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
        messageId: 'doggy-message',
        idempotencyKey: 'doggy-device:doggy-message',
        content: 'private hello',
        createdAt: Date.now(),
      })
      await until(() => deliveries.some(item => item.type === 'generation'))
      expect(deliveries.every(item => item.personIds.includes(DOGGY_PERSON_ID))).toBe(true)
      expect(deliveries.every(item => !item.personIds.includes(MOUSSY_PERSON_ID))).toBe(true)
    }
    finally {
      database.close()
    }
  })

  it('broadcasts a shared turn to both people and generates only once on retry', async () => {
    const database = LumiServerDatabase.open(':memory:')
    let generations = 0
    const server = new LumiOnlineServer({
      database,
      serverVersion: 'test',
      replyGenerator: {
        async generate(_, emitDelta) {
          generations += 1
          emitDelta('Hi')
          return { content: 'Hi together' }
        },
      },
    })
    const completed: string[] = []
    server.onDelivery((delivery) => {
      if (delivery.type === 'generation' && delivery.event.state === 'completed')
        completed.push(delivery.event.inputMessageId)
    })
    try {
      const request = {
        conversationId: DOGGY_MOUSSY_GROUP_ID,
        messageId: 'group-message',
        idempotencyKey: 'doggy-device:group-message',
        content: 'hello group',
        createdAt: Date.now(),
      }
      expect(server.sendMessage(session(DOGGY_PERSON_ID, 'Doggy', 'owner'), request).status).toBe('accepted')
      expect(server.sendMessage(session(DOGGY_PERSON_ID, 'Doggy', 'owner'), request).status).toBe('duplicate')
      await until(() => completed.length === 1)

      expect(generations).toBe(1)
      expect(database.replay(DOGGY_MOUSSY_GROUP_ID, MOUSSY_PERSON_ID, 0).messages).toHaveLength(2)
    }
    finally {
      database.close()
    }
  })

  it('rejects an incompatible protocol before exposing capabilities', () => {
    const database = LumiServerDatabase.open(':memory:')
    const server = createServer(database)
    try {
      expect(() => server.hello(session(DOGGY_PERSON_ID, 'Doggy', 'owner'), {
        protocolVersion: 99,
        clientVersion: 'test',
        deviceId: 'device',
        deviceName: 'Test device',
      })).toThrow('Unsupported Lumi protocol version 99')
    }
    finally {
      database.close()
    }
  })

  it('reports asynchronous generation failures to both the client and server host', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const failures: Error[] = []
    const deliveries: string[] = []
    const server = new LumiOnlineServer({
      database,
      serverVersion: 'test',
      replyGenerator: {
        async generate() {
          throw new Error('provider rejected tools')
        },
      },
      onGenerationError: error => failures.push(error),
    })
    server.onDelivery((delivery) => {
      if (delivery.type === 'generation' && delivery.event.state === 'failed')
        deliveries.push(delivery.event.error ?? '')
    })
    try {
      server.sendMessage(session(DOGGY_PERSON_ID, 'Doggy', 'owner'), {
        conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
        messageId: 'failed-message',
        idempotencyKey: 'doggy-device:failed-message',
        content: 'hello',
        createdAt: Date.now(),
      })
      await until(() => failures.length === 1 && deliveries.length === 1)

      expect(failures[0]?.message).toBe('provider rejected tools')
      expect(deliveries).toEqual(['provider rejected tools'])
    }
    finally {
      database.close()
    }
  })
})

function createServer(database: LumiServerDatabase) {
  return new LumiOnlineServer({
    database,
    serverVersion: 'test',
    replyGenerator: {
      async generate() {
        return { content: 'Hello' }
      },
    },
  })
}

function session(personId: string, displayName: string, role: 'owner' | 'member'): LumiAuthenticatedSession {
  return {
    accountId: `account:${personId}`,
    sessionId: `session:${personId}`,
    expiresAt: new Date(Date.now() + 60_000),
    person: { id: personId, displayName, role },
  }
}

async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate())
      return
    await new Promise<void>(resolve => setTimeout(resolve, 2))
  }
  throw new Error('Timed out waiting for server delivery')
}
