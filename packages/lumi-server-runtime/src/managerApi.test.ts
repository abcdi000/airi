import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createLumiAuthentication } from './auth'
import { LumiServerDatabase, MOUSSY_PERSON_ID } from './database'
import { createLumiManagerApi } from './managerApi'

const managerToken = 'manager-test-token-with-more-than-thirty-two-bytes'

function managerRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${managerToken}`)
  if (init.body)
    headers.set('content-type', 'application/json')
  return new Request(`http://127.0.0.1${path}`, { ...init, headers })
}

describe('createLumiManagerApi', () => {
  it('keeps management authenticated and content-free while provisioning known people', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumi-manager-api-'))
    const databasePath = join(directory, 'server.sqlite3')
    const database = LumiServerDatabase.open(databasePath)
    const authentication = await createLumiAuthentication(database, {
      databasePath,
      baseURL: 'http://127.0.0.1:6130',
      secret: 'manager-auth-test-secret-with-more-than-thirty-two-bytes',
    })
    const manager = createLumiManagerApi({ database, authentication, token: managerToken })
    try {
      expect((await manager.app.request('/overview')).status).toBe(401)

      const overviewResponse = await manager.app.fetch(managerRequest('/overview'))
      const overview: unknown = await overviewResponse.json()
      expect(overviewResponse.status).toBe(200)
      expect(JSON.stringify(overview)).not.toContain('content')
      expect(overview).toMatchObject({ people: 2, boundAccounts: 0, messages: 0 })

      const bootstrapResponse = await manager.app.fetch(managerRequest('/bootstrap/doggy', {
        method: 'POST',
        body: JSON.stringify({ username: 'doggy_owner', password: 'correct-horse-battery-staple' }),
      }))
      expect(bootstrapResponse.status).toBe(200)
      expect(await bootstrapResponse.json()).toMatchObject({
        person: { displayName: 'Doggy', role: 'owner' },
      })

      const invitationResponse = await manager.app.fetch(managerRequest('/invitations', {
        method: 'POST',
        body: JSON.stringify({ personId: MOUSSY_PERSON_ID, expiresInMs: 60_000 }),
      }))
      expect(invitationResponse.status).toBe(200)
      expect(await invitationResponse.json()).toMatchObject({ personId: MOUSSY_PERSON_ID })

      const usersResponse = await manager.app.fetch(managerRequest('/users'))
      const users = await usersResponse.json() as { users: Array<{ displayName: string, accountBound: boolean }> }
      expect(users.users).toEqual(expect.arrayContaining([
        expect.objectContaining({ displayName: 'Doggy', accountBound: true }),
        expect.objectContaining({ displayName: 'Moussy', accountBound: false }),
      ]))
    }
    finally {
      await manager.stop()
      authentication.close()
      database.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
