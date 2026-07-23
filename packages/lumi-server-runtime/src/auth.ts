import type { LumiOnlinePerson } from '@proj-airi/lumi-online'

import type {
  LumiServerDatabase,
} from './database'

import { DatabaseSync } from 'node:sqlite'

import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'
import { admin, bearer, username } from 'better-auth/plugins'

import {
  DOGGY_PERSON_ID,
} from './database'

export interface LumiAuthenticationOptions {
  /** Absolute path to the authoritative server SQLite database. */
  databasePath: string
  /** Public HTTPS origin clients use for authentication requests. */
  baseURL: string
  /** Persistent server secret with at least 32 bytes of entropy. */
  secret: string
  /** Explicit browser origins allowed to send authenticated requests. */
  trustedOrigins?: string[]
}

export interface LumiAuthenticatedSession {
  accountId: string
  sessionId: string
  expiresAt: Date
  person: LumiOnlinePerson
}

export interface ClaimInvitationInput {
  code: string
  username: string
  password: string
}

export interface BootstrapDoggyInput {
  username: string
  password: string
}

export interface LumiAuthAccount {
  id: string
  name: string
  username?: string | null
  role?: string | null
}

export interface LumiAuthentication {
  /** Better Auth request handler mounted under the server authentication path. */
  handler: (request: Request) => Promise<Response>
  /** Creates the one permitted bootstrap administrator and binds it to Doggy. */
  bootstrapDoggy: (input: BootstrapDoggyInput) => Promise<{ user: LumiAuthAccount, person: LumiOnlinePerson }>
  /** Claims a server-issued invitation without accepting a person id from the client. */
  claimInvitation: (input: ClaimInvitationInput) => Promise<{ user: LumiAuthAccount, person: LumiOnlinePerson }>
  /** Resolves request headers to a server-owned person and rejects unbound accounts. */
  sessionFromHeaders: (headers: Headers) => Promise<LumiAuthenticatedSession | undefined>
  /** Closes the dedicated authentication database connection. */
  close: () => void
}

/**
 * Creates Lumi's invitation-only authentication authority.
 *
 * Use when:
 * - Starting the standalone Lumi Server process
 * - Resolving an HTTP or WebSocket bearer session into a server-owned person
 *
 * Expects:
 * - The database path is shared with {@link LumiServerDatabase}
 * - `secret` remains stable across restarts so signed bearer sessions remain valid
 *
 * Returns:
 * - Better Auth's HTTP handler plus guarded bootstrap, invitation, and session helpers
 */
export async function createLumiAuthentication(
  database: LumiServerDatabase,
  options: LumiAuthenticationOptions,
): Promise<LumiAuthentication> {
  const authDatabase = new DatabaseSync(options.databasePath)
  authDatabase.exec('PRAGMA journal_mode = WAL')
  authDatabase.exec('PRAGMA foreign_keys = ON')
  authDatabase.exec('PRAGMA busy_timeout = 5000')

  const authOptions = {
    appName: 'Lumi',
    baseURL: options.baseURL,
    secret: options.secret,
    database: authDatabase,
    trustedOrigins: options.trustedOrigins ?? [],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    disabledPaths: ['/is-username-available'],
    plugins: [
      username({
        minUsernameLength: 3,
        maxUsernameLength: 30,
      }),
      admin({
        defaultRole: 'user',
        adminRoles: ['admin'],
      }),
      bearer({ requireSignature: true }),
    ],
  }

  const migrations = await getMigrations(authOptions)
  await migrations.runMigrations()
  const auth = betterAuth(authOptions)

  let provisioningTail = Promise.resolve()
  const serializeProvisioning = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = provisioningTail
    let release: () => void = () => {}
    provisioningTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    }
    finally {
      release()
    }
  }

  const createBoundUser = async (
    personId: string,
    input: { username: string, password: string, role: 'admin' | 'user', displayName: string },
  ) => {
    if (database.accountForPerson(personId))
      throw new Error('This Lumi person already has an account')

    const normalizedUsername = normalizeUsername(input.username)
    const result = await auth.api.createUser({
      body: {
        email: `${normalizedUsername}@accounts.lumi.local`,
        password: input.password,
        name: input.displayName,
        role: input.role,
        data: {
          username: normalizedUsername,
          displayUsername: input.username.trim(),
        },
      },
    })
    return result.user
  }

  return {
    handler: auth.handler,

    /** Creates the one permitted bootstrap administrator and binds it to Doggy. */
    bootstrapDoggy(input: BootstrapDoggyInput) {
      return serializeProvisioning(async () => {
        const user = await createBoundUser(DOGGY_PERSON_ID, {
          username: input.username,
          password: input.password,
          role: 'admin',
          displayName: 'Doggy',
        })
        database.bindAccount(user.id, DOGGY_PERSON_ID)
        return { user, person: database.personForAccount(user.id)! }
      })
    },

    /** Claims a server-issued invitation without accepting a person id from the client. */
    claimInvitation(input: ClaimInvitationInput) {
      return serializeProvisioning(async () => {
        const invitation = database.inspectInvitation(input.code)
        const person = database.listPeople().find(candidate => candidate.id === invitation.personId)
        if (!person)
          throw new Error('The invitation is not bound to an active Lumi person')

        const user = await createBoundUser(person.id, {
          username: input.username,
          password: input.password,
          role: 'user',
          displayName: person.displayName,
        })
        database.consumeInvitation({ code: input.code, authUserId: user.id })
        return { user, person: database.personForAccount(user.id)! }
      })
    },

    /** Resolves request headers to a server-owned person and rejects unbound accounts. */
    async sessionFromHeaders(headers: Headers): Promise<LumiAuthenticatedSession | undefined> {
      const session = await auth.api.getSession({ headers })
      if (!session)
        return undefined
      const person = database.personForAccount(session.user.id)
      if (!person)
        return undefined
      return {
        accountId: session.user.id,
        sessionId: session.session.id,
        expiresAt: session.session.expiresAt,
        person,
      }
    },

    close() {
      authDatabase.close()
    },
  }
}

/**
 * Normalizes a Lumi login name.
 *
 * Before:
 * - " Doggy "
 *
 * After:
 * - "doggy"
 */
function normalizeUsername(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-z0-9_]{3,30}$/.test(normalized))
    throw new Error('Username must contain 3-30 lowercase letters, numbers, or underscores')
  return normalized
}
