import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createLumiAuthentication } from './auth'
import {
  DOGGY_PERSON_ID,
  LumiServerDatabase,
  MOUSSY_PERSON_ID,
} from './database'

describe('createLumiAuthentication', () => {
  it('bootstraps Doggy and resolves a signed bearer session', async () => {
    const fixture = await createFixture()
    try {
      const bootstrap = await fixture.authentication.bootstrapDoggy({
        username: 'Doggy',
        password: 'correct-horse-battery-staple',
      })
      expect(bootstrap.person.id).toBe(DOGGY_PERSON_ID)
      expect(bootstrap.user.role).toBe('admin')

      const response = await signIn(fixture.authentication.handler, 'doggy', 'correct-horse-battery-staple')
      const token = response.headers.get('set-auth-token')
      expect(response.status).toBe(200)
      expect(token).toBeTruthy()

      const session = await fixture.authentication.sessionFromHeaders(new Headers({
        authorization: `Bearer ${token}`,
      }))
      expect(session?.person.id).toBe(DOGGY_PERSON_ID)
      expect(session?.person.role).toBe('owner')

      fixture.database.registerDevice({
        id: 'windows-doggy-test',
        accountId: session!.accountId,
        sessionId: session!.sessionId,
        name: 'Doggy test PC',
        platform: 'win32',
      })
      expect(fixture.database.isDeviceActive(session!.accountId, 'windows-doggy-test')).toBe(true)

      fixture.database.revokeDevice(session!.accountId, 'windows-doggy-test')

      expect(fixture.database.isDeviceActive(session!.accountId, 'windows-doggy-test')).toBe(false)
      expect(await fixture.authentication.sessionFromHeaders(new Headers({ authorization: `Bearer ${token}` }))).toBeUndefined()
    }
    finally {
      fixture.close()
    }
  })

  it('creates Moussy only through the server-bound one-time invitation', async () => {
    const fixture = await createFixture()
    try {
      const invitation = fixture.database.createInvitation(MOUSSY_PERSON_ID)
      const claimed = await fixture.authentication.claimInvitation({
        code: invitation.code,
        username: 'Moussy',
        password: 'another-correct-horse-battery',
      })
      expect(claimed.person.id).toBe(MOUSSY_PERSON_ID)
      expect(() => fixture.database.inspectInvitation(invitation.code)).toThrow('Invitation is invalid or expired')
      await expect(fixture.authentication.claimInvitation({
        code: invitation.code,
        username: 'Moussy2',
        password: 'another-correct-horse-battery',
      })).rejects.toThrow('Invitation is invalid or expired')
    }
    finally {
      fixture.close()
    }
  })
})

async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'lumi-auth-test-'))
  const databasePath = join(directory, 'server.sqlite3')
  const database = LumiServerDatabase.open(databasePath)
  const authentication = await createLumiAuthentication(database, {
    databasePath,
    baseURL: 'http://127.0.0.1:6130',
    secret: 'test-only-secret-with-at-least-thirty-two-characters',
    trustedOrigins: ['http://127.0.0.1:6130'],
  })
  return {
    database,
    authentication,
    close() {
      authentication.close()
      database.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

function signIn(handler: (request: Request) => Promise<Response>, username: string, password: string) {
  return handler(new Request('http://127.0.0.1:6130/api/auth/sign-in/username', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }))
}
