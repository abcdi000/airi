import type {
  LumiOnlineConversation,
  LumiOnlineMessage,
  LumiOnlinePerson,
} from '@proj-airi/lumi-online'
import type {
  LumiMemoryCandidate,
  LumiMemoryFragment,
  LumiMemorySearchRequest,
  LumiMemoryStatus,
} from '@proj-airi/lumi-runtime'

import { Buffer } from 'node:buffer'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  canAccessLumiMemory,
  classifyLumiMemoryCandidate,
  decideLumiMemoryStatus,
  normalizeMemoryScores,
} from '@proj-airi/lumi-runtime'

export const DOGGY_PERSON_ID = 'lumi-user-00000000-0000-4000-8000-000000000001'
export const MOUSSY_PERSON_ID = 'lumi-user-00000000-0000-4000-8000-000000000002'
export const DOGGY_MOUSSY_GROUP_ID = 'lumi-group-00000000-0000-4000-8000-000000000001'
export const LUMI_SERVER_BACKUP_FORMAT = 'lumi-server-backup:v1'
export const LUMI_PERSONA_ID = 'lumi'

type SqliteValue = string | number | null
export type SqliteRow = Record<string, SqliteValue>

export interface LumiInvitation {
  id: string
  personId: string
  expiresAt: number
  createdAt: number
}

export interface LumiIssuedInvitation extends LumiInvitation {
  /** Plaintext code returned once and never persisted. */
  code: string
}

export interface LumiServerBackupV1 {
  format: typeof LUMI_SERVER_BACKUP_FORMAT
  version: 1
  exportedAt: string
  sections: {
    authUsers: SqliteRow[]
    authAccounts: SqliteRow[]
    authVerifications: SqliteRow[]
    people: SqliteRow[]
    accountPeople: SqliteRow[]
    invitations: SqliteRow[]
    externalIdentities: SqliteRow[]
    conversations: SqliteRow[]
    conversationMembers: SqliteRow[]
    messages: SqliteRow[]
    deliveryReceipts: SqliteRow[]
    memories: SqliteRow[]
    memoryVectors: SqliteRow[]
    personStates: SqliteRow[]
    diaryEntries: SqliteRow[]
    privateNotes: SqliteRow[]
    autonomousState: SqliteRow[]
    toolAudits: SqliteRow[]
    jobs: SqliteRow[]
    serverConfig: SqliteRow[]
    devices: SqliteRow[]
    migrationImports: SqliteRow[]
    metadata: SqliteRow[]
    audits: SqliteRow[]
  }
}

export interface AcceptMessageInput {
  conversationId: string
  actorPersonId: string
  messageId: string
  idempotencyKey: string
  content: string
  createdAt: number
}

export type AcceptMessageResult
  = | { status: 'accepted', message: LumiOnlineMessage }
    | { status: 'duplicate', message: LumiOnlineMessage }

export interface StoreMemoryCandidateInput {
  actorPersonId: string
  conversationId?: string
  candidate: LumiMemoryCandidate
}

export type LumiPersonStateKind = 'profile' | 'short-term' | 'emotion' | 'relationship'

export interface LumiPersonStateRecord {
  personId: string
  kind: LumiPersonStateKind
  version: number
  payload: Record<string, unknown>
  updatedAt: number
}

export interface LumiManagerOverview {
  people: number
  boundAccounts: number
  conversations: { direct: number, group: number }
  messages: number
  memories: Record<LumiMemoryStatus, number>
  personStates: number
  diaryEntries: number
  privateNotes: number
  jobs: Record<'pending' | 'running' | 'completed' | 'failed' | 'cancelled', number>
  devices: { active: number, revoked: number }
}

export interface LumiDeviceRecord {
  id: string
  accountId: string
  name: string
  platform: string
  lastSeenAt: number
  revokedAt?: number
  createdAt: number
}

export type LumiServerJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface LumiServerJob {
  id: string
  kind: string
  status: LumiServerJobStatus
  payload: Record<string, unknown>
  result?: Record<string, unknown>
  attempts: number
  scheduledAt: number
  startedAt?: number
  finishedAt?: number
  createdAt: number
  updatedAt: number
}

export interface LumiMemoryVectorRecord {
  memoryId: string
  model: string
  dimensions: number
  vector: number[]
  contentDigest: string
  device?: string
  updatedAt: number
}

export interface LumiMemoryVectorStatus {
  model: string
  indexedCount: number
  totalCount: number
  missingCount: number
}

export interface LumiMigrationMessage {
  id: string
  conversationId: string
  conversationType: 'direct' | 'group'
  title: string
  participantPersonIds: string[]
  role: 'user' | 'assistant' | 'system'
  actorPersonId?: string
  content: string
  createdAt: number
}

export interface LumiValidatedMigrationPlan {
  people: Array<{
    id: string
    displayName: string
    preferredAddress: string
    role: 'owner' | 'member'
    status: 'active' | 'inactive'
    createdAt: number
    updatedAt: number
  }>
  externalIdentities: Array<{
    id: string
    personId: string
    provider: string
    providerInstanceId: string
    externalUserId: string
    createdAt: number
  }>
  messages: LumiMigrationMessage[]
  memories: LumiMemoryFragment[]
  memoryVectors: LumiMemoryVectorRecord[]
  personStates: Array<{ personId: string, kind: LumiPersonStateKind, payload: Record<string, unknown>, updatedAt: number }>
  diaryEntries: Array<{ id: string, entryDate: string, title: string, content: string, mood?: string, tags: string[], sourceSummary?: string, createdAt: number, updatedAt: number }>
  privateNotes: Array<{ id: string, content: string, sourceKind: string, sourceReference?: string, tags: string[], createdAt: number, updatedAt: number }>
  autonomousState: Array<{ key: string, payload: Record<string, unknown>, updatedAt: number }>
}

export interface LumiMigrationImportCounts {
  people: number
  externalIdentities: number
  messages: number
  memories: number
  memoryVectors: number
  personStates: number
  diaryEntries: number
  privateNotes: number
  autonomousState: number
}

export interface LumiBackgroundMessage {
  conversationId: string
  conversationType: 'direct' | 'group'
  role: 'user' | 'assistant' | 'system'
  actorDisplayName?: string
  content: string
  createdAt: number
}

/**
 * Owns the canonical Lumi Online relational state.
 *
 * Use when:
 * - Authenticating an account into a stable Lumi person
 * - Authorizing conversations and assigning reliable message sequences
 * - Producing a server backup without active authentication sessions
 *
 * Expects:
 * - Exactly one server process opens the writable database
 * - Callers derive `actorPersonId` from an authenticated server session
 *
 * Returns:
 * - Transactional, server-authoritative identity and conversation operations
 */
export class LumiServerDatabase {
  private constructor(
    private readonly database: DatabaseSync,
    readonly path: string,
  ) {}

  static open(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    const database = new DatabaseSync(path)
    const result = new LumiServerDatabase(database, path)
    result.migrate()
    result.seedKnownPeopleAndConversations()
    return result
  }

  close() {
    this.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    this.database.close()
  }

  /** Returns a client-safe person resolved from a Better Auth user id. */
  personForAccount(authUserId: string): LumiOnlinePerson | undefined {
    const row = this.row(`
      SELECT p.id, p.display_name, p.role
      FROM lumi_account_people ap
      JOIN lumi_people p ON p.id = ap.person_id
      WHERE ap.auth_user_id = ? AND p.status = 'active'
    `, requiredText(authUserId, 'authUserId', 160))
    return row ? personFromRow(row) : undefined
  }

  /** Returns the Better Auth user id already bound to a stable Lumi person. */
  accountForPerson(personId: string): string | undefined {
    const row = this.row(
      'SELECT auth_user_id FROM lumi_account_people WHERE person_id = ?',
      requiredText(personId, 'personId', 160),
    )
    return row ? String(row.auth_user_id) : undefined
  }

  bindAccount(authUserId: string, personId: string) {
    const normalizedAuthUserId = requiredText(authUserId, 'authUserId', 160)
    const normalizedPersonId = requiredText(personId, 'personId', 160)
    this.assertPerson(normalizedPersonId)
    this.database.prepare(`
      INSERT INTO lumi_account_people (auth_user_id, person_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(auth_user_id) DO UPDATE SET person_id = excluded.person_id
    `).run(normalizedAuthUserId, normalizedPersonId, Date.now())
  }

  listPeople(): LumiOnlinePerson[] {
    return this.rows(`
      SELECT id, display_name, role
      FROM lumi_people
      WHERE status = 'active'
      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC
    `).map(personFromRow)
  }

  /** Returns content-free health counts for the local Server Manager. */
  managerOverview(): LumiManagerOverview {
    const count = (sql: string, ...values: SqliteValue[]) => Number(this.row(sql, ...values)?.count ?? 0)
    return {
      people: count('SELECT COUNT(*) AS count FROM lumi_people WHERE status = \'active\''),
      boundAccounts: count('SELECT COUNT(*) AS count FROM lumi_account_people'),
      conversations: {
        direct: count('SELECT COUNT(*) AS count FROM lumi_conversations WHERE type = \'direct\''),
        group: count('SELECT COUNT(*) AS count FROM lumi_conversations WHERE type = \'group\''),
      },
      messages: count('SELECT COUNT(*) AS count FROM lumi_messages'),
      memories: {
        candidate: count('SELECT COUNT(*) AS count FROM lumi_memories WHERE status = \'candidate\''),
        active: count('SELECT COUNT(*) AS count FROM lumi_memories WHERE status = \'active\''),
        rejected: count('SELECT COUNT(*) AS count FROM lumi_memories WHERE status = \'rejected\''),
        contradicted: count('SELECT COUNT(*) AS count FROM lumi_memories WHERE status = \'contradicted\''),
        archived: count('SELECT COUNT(*) AS count FROM lumi_memories WHERE status = \'archived\''),
      },
      personStates: count('SELECT COUNT(*) AS count FROM lumi_person_state'),
      diaryEntries: count('SELECT COUNT(*) AS count FROM lumi_diary_entries'),
      privateNotes: count('SELECT COUNT(*) AS count FROM lumi_private_notes'),
      jobs: {
        pending: count('SELECT COUNT(*) AS count FROM lumi_jobs WHERE status = \'pending\''),
        running: count('SELECT COUNT(*) AS count FROM lumi_jobs WHERE status = \'running\''),
        completed: count('SELECT COUNT(*) AS count FROM lumi_jobs WHERE status = \'completed\''),
        failed: count('SELECT COUNT(*) AS count FROM lumi_jobs WHERE status = \'failed\''),
        cancelled: count('SELECT COUNT(*) AS count FROM lumi_jobs WHERE status = \'cancelled\''),
      },
      devices: {
        active: count('SELECT COUNT(*) AS count FROM lumi_devices WHERE revoked_at IS NULL'),
        revoked: count('SELECT COUNT(*) AS count FROM lumi_devices WHERE revoked_at IS NOT NULL'),
      },
    }
  }

  registerDevice(input: { id: string, accountId: string, sessionId: string, name: string, platform: string }) {
    const id = requiredText(input.id, 'device id', 160)
    const accountId = requiredText(input.accountId, 'account id', 160)
    const existing = this.row('SELECT auth_user_id, revoked_at FROM lumi_devices WHERE id = ?', id)
    if (existing?.revoked_at)
      throw new Error('This device has been revoked')
    if (existing && existing.auth_user_id !== accountId)
      throw new Error('This device id is already bound to another account')
    const now = Date.now()
    this.database.prepare(`
      INSERT INTO lumi_devices (id, auth_user_id, session_id, name, platform, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        name = excluded.name,
        platform = excluded.platform,
        last_seen_at = excluded.last_seen_at
    `).run(
      id,
      accountId,
      requiredText(input.sessionId, 'session id', 240),
      requiredText(input.name, 'device name', 160),
      requiredText(input.platform, 'device platform', 80),
      now,
      now,
    )
    this.audit('device-seen', { deviceId: id, authUserId: accountId })
    return this.listDevices(accountId).find(device => device.id === id)!
  }

  listDevices(accountId?: string): LumiDeviceRecord[] {
    const rows = accountId
      ? this.rows('SELECT * FROM lumi_devices WHERE auth_user_id = ? ORDER BY last_seen_at DESC', requiredText(accountId, 'account id', 160))
      : this.rows('SELECT * FROM lumi_devices ORDER BY last_seen_at DESC')
    return rows.map(row => ({
      id: String(row.id),
      accountId: String(row.auth_user_id),
      name: String(row.name),
      platform: String(row.platform),
      lastSeenAt: Number(row.last_seen_at),
      revokedAt: row.revoked_at === null ? undefined : Number(row.revoked_at),
      createdAt: Number(row.created_at),
    }))
  }

  isDeviceActive(accountId: string, deviceId: string) {
    return Boolean(this.row(
      'SELECT 1 AS active FROM lumi_devices WHERE auth_user_id = ? AND id = ? AND revoked_at IS NULL',
      requiredText(accountId, 'account id', 160),
      requiredText(deviceId, 'device id', 160),
    ))
  }

  revokeDevice(accountId: string, deviceId: string) {
    const normalizedAccountId = requiredText(accountId, 'account id', 160)
    const normalizedDeviceId = requiredText(deviceId, 'device id', 160)
    return this.transaction(() => {
      const device = this.row('SELECT session_id FROM lumi_devices WHERE auth_user_id = ? AND id = ?', normalizedAccountId, normalizedDeviceId)
      if (!device)
        throw new Error('Device was not found for this account')
      this.database.prepare('UPDATE lumi_devices SET revoked_at = ? WHERE auth_user_id = ? AND id = ?')
        .run(Date.now(), normalizedAccountId, normalizedDeviceId)
      if (device.session_id)
        this.database.prepare('DELETE FROM session WHERE id = ?').run(device.session_id)
      this.audit('device-revoked', { deviceId: normalizedDeviceId, authUserId: normalizedAccountId })
      return this.listDevices(normalizedAccountId).find(item => item.id === normalizedDeviceId)!
    })
  }

  recordSecurityAudit(action: string, metadata: Record<string, string>) {
    this.audit(requiredText(action, 'audit action', 160), metadata)
  }

  createInvitation(personId: string, expiresInMs = 24 * 60 * 60 * 1000): LumiIssuedInvitation {
    const normalizedPersonId = requiredText(personId, 'personId', 160)
    if (!Number.isFinite(expiresInMs) || expiresInMs < 60_000 || expiresInMs > 7 * 24 * 60 * 60 * 1000)
      throw new Error('Invitation expiry must be between one minute and seven days')
    this.assertPerson(normalizedPersonId)
    const alreadyBound = this.row('SELECT auth_user_id FROM lumi_account_people WHERE person_id = ?', normalizedPersonId)
    if (alreadyBound)
      throw new Error('This Lumi person already has an account')

    const id = randomUUID()
    const code = invitationCode()
    const now = Date.now()
    const expiresAt = now + expiresInMs
    this.database.prepare(`
      INSERT INTO lumi_invitations (id, person_id, code_digest, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, normalizedPersonId, digest(code), expiresAt, now)
    this.audit('invitation-created', { personId: normalizedPersonId, invitationId: id })
    return { id, personId: normalizedPersonId, code, expiresAt, createdAt: now }
  }

  inspectInvitation(code: string): LumiInvitation {
    const normalizedCode = requiredText(code, 'code', 240)
    const codeDigest = digest(normalizedCode)
    const candidates = this.rows(`
      SELECT id, person_id, code_digest, expires_at, created_at
      FROM lumi_invitations
      WHERE consumed_at IS NULL AND expires_at >= ?
    `, Date.now())
    const row = candidates.find(candidate => constantTimeEqual(String(candidate.code_digest), codeDigest))
    if (!row)
      throw new Error('Invitation is invalid or expired')
    return {
      id: String(row.id),
      personId: String(row.person_id),
      expiresAt: Number(row.expires_at),
      createdAt: Number(row.created_at),
    }
  }

  consumeInvitation(input: { code: string, authUserId: string }) {
    const invitation = this.inspectInvitation(input.code)
    const authUserId = requiredText(input.authUserId, 'authUserId', 160)
    this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE lumi_invitations
        SET consumed_at = ?, consumed_by_auth_user_id = ?
        WHERE id = ? AND consumed_at IS NULL AND expires_at >= ?
      `).run(Date.now(), authUserId, invitation.id, Date.now())
      if (Number(result.changes) !== 1)
        throw new Error('Invitation was already consumed')
      this.bindAccount(authUserId, invitation.personId)
      this.audit('invitation-consumed', { personId: invitation.personId, invitationId: invitation.id, authUserId })
    })
    return this.personForAccount(authUserId)!
  }

  listConversations(personId: string): LumiOnlineConversation[] {
    const normalizedPersonId = requiredText(personId, 'personId', 160)
    return this.rows(`
      SELECT c.id, c.type, c.title, c.latest_sequence, c.updated_at
      FROM lumi_conversations c
      JOIN lumi_conversation_members m ON m.conversation_id = c.id
      WHERE m.person_id = ? AND m.revoked_at IS NULL
      ORDER BY c.updated_at DESC
    `, normalizedPersonId).map(row => this.conversationFromRow(row))
  }

  isConversationMember(conversationId: string, personId: string) {
    return Boolean(this.row(`
      SELECT 1 AS allowed
      FROM lumi_conversation_members
      WHERE conversation_id = ? AND person_id = ? AND revoked_at IS NULL
    `, requiredText(conversationId, 'conversationId', 240), requiredText(personId, 'personId', 160)))
  }

  acceptUserMessage(input: AcceptMessageInput): AcceptMessageResult {
    const conversationId = requiredText(input.conversationId, 'conversationId', 240)
    const actorPersonId = requiredText(input.actorPersonId, 'actorPersonId', 160)
    const messageId = requiredText(input.messageId, 'messageId', 240)
    const idempotencyKey = requiredText(input.idempotencyKey, 'idempotencyKey', 240)
    const content = requiredText(input.content, 'content', 100_000)
    if (!this.isConversationMember(conversationId, actorPersonId))
      throw new Error('Authenticated person is not a member of this conversation')

    return this.transaction(() => {
      const existing = this.row(`
        SELECT message_id, actor_person_id, content_digest
        FROM lumi_delivery_receipts
        WHERE conversation_id = ? AND idempotency_key = ?
      `, conversationId, idempotencyKey)
      if (existing) {
        if (existing.message_id !== messageId || existing.actor_person_id !== actorPersonId || existing.content_digest !== digest(content))
          throw new Error('Idempotency key was already used for different input')
        return { status: 'duplicate', message: this.getMessage(messageId)! }
      }
      if (this.row('SELECT id FROM lumi_messages WHERE id = ?', messageId))
        throw new Error('Message id was already used')

      const conversation = this.row('SELECT latest_sequence FROM lumi_conversations WHERE id = ?', conversationId)
      if (!conversation)
        throw new Error('Conversation was not found')
      const sequence = Number(conversation.latest_sequence) + 1
      const createdAt = finiteTimestamp(input.createdAt)
      this.database.prepare(`
        INSERT INTO lumi_messages (
          id, conversation_id, sequence, role, actor_person_id, content, created_at
        ) VALUES (?, ?, ?, 'user', ?, ?, ?)
      `).run(messageId, conversationId, sequence, actorPersonId, content, createdAt)
      this.database.prepare(`
        INSERT INTO lumi_delivery_receipts (
          conversation_id, idempotency_key, message_id, actor_person_id, content_digest, accepted_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(conversationId, idempotencyKey, messageId, actorPersonId, digest(content), createdAt)
      this.database.prepare(`
        UPDATE lumi_conversations SET latest_sequence = ?, updated_at = ? WHERE id = ?
      `).run(sequence, createdAt, conversationId)
      return { status: 'accepted', message: this.getMessage(messageId)! }
    })
  }

  appendAssistantMessage(input: {
    conversationId: string
    messageId?: string
    content: string
    expression?: string
    motion?: string
    createdAt?: number
  }): LumiOnlineMessage {
    const conversationId = requiredText(input.conversationId, 'conversationId', 240)
    const messageId = requiredText(input.messageId ?? randomUUID(), 'messageId', 240)
    const content = requiredText(input.content, 'content', 100_000)
    return this.transaction(() => {
      const conversation = this.row('SELECT latest_sequence FROM lumi_conversations WHERE id = ?', conversationId)
      if (!conversation)
        throw new Error('Conversation was not found')
      const sequence = Number(conversation.latest_sequence) + 1
      const createdAt = finiteTimestamp(input.createdAt ?? Date.now())
      this.database.prepare(`
        INSERT INTO lumi_messages (
          id, conversation_id, sequence, role, content, expression, motion, created_at
        ) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)
      `).run(
        messageId,
        conversationId,
        sequence,
        content,
        optionalText(input.expression, 160) ?? null,
        optionalText(input.motion, 160) ?? null,
        createdAt,
      )
      this.database.prepare('UPDATE lumi_conversations SET latest_sequence = ?, updated_at = ? WHERE id = ?')
        .run(sequence, createdAt, conversationId)
      return this.getMessage(messageId)!
    })
  }

  replay(conversationId: string, personId: string, afterSequence: number, limit = 500) {
    const normalizedConversationId = requiredText(conversationId, 'conversationId', 240)
    if (!this.isConversationMember(normalizedConversationId, personId))
      throw new Error('Authenticated person is not a member of this conversation')
    const normalizedAfter = Number.isFinite(afterSequence) ? Math.max(0, Math.floor(afterSequence)) : 0
    const normalizedLimit = Math.max(1, Math.min(1000, Math.floor(limit)))
    const conversation = this.row('SELECT latest_sequence FROM lumi_conversations WHERE id = ?', normalizedConversationId)
    if (!conversation)
      throw new Error('Conversation was not found')
    const first = this.row('SELECT MIN(sequence) AS sequence FROM lumi_messages WHERE conversation_id = ?', normalizedConversationId)
    const retainedFromSequence = Number(first?.sequence ?? 0)
    const messages = this.rows(`
      SELECT m.*, p.display_name AS actor_display_name
      FROM lumi_messages m
      LEFT JOIN lumi_people p ON p.id = m.actor_person_id
      WHERE m.conversation_id = ? AND m.sequence > ?
      ORDER BY m.sequence ASC
      LIMIT ?
    `, normalizedConversationId, normalizedAfter, normalizedLimit).map(messageFromRow)
    return {
      conversationId: normalizedConversationId,
      afterSequence: normalizedAfter,
      latestSequence: Number(conversation.latest_sequence),
      retainedFromSequence,
      truncated: retainedFromSequence > 0 && normalizedAfter + 1 < retainedFromSequence,
      messages,
    }
  }

  /** Stores a model proposal only after server-owned scope classification. */
  storeMemoryCandidate(input: StoreMemoryCandidateInput): LumiMemoryFragment {
    const actorPersonId = requiredText(input.actorPersonId, 'actorPersonId', 160)
    this.assertPerson(actorPersonId)
    const conversation = input.conversationId
      ? this.listConversations(actorPersonId).find(item => item.id === input.conversationId)
      : undefined
    if (input.conversationId && !conversation)
      throw new Error('Authenticated person is not a member of the source conversation')

    const classification = classifyLumiMemoryCandidate(input.candidate, {
      actorId: actorPersonId,
      personaId: LUMI_PERSONA_ID,
      conversationId: conversation?.id,
      conversationType: conversation?.type ?? 'manual',
      participantUserIds: conversation?.participantPersonIds,
      requestedScope: input.candidate.scope,
      requestedVisibility: input.candidate.visibility,
      requestedSensitivity: input.candidate.sensitivity,
      requestedSubjectUserIds: input.candidate.subjectUserIds,
    })
    const now = new Date().toISOString()
    const decision = decideLumiMemoryStatus(
      input.candidate,
      this.rows('SELECT * FROM lumi_memories WHERE status = \'active\'').map(memoryFromRow),
    )
    const memory = normalizeMemoryScores({
      id: randomUUID(),
      userId: actorPersonId,
      personaId: LUMI_PERSONA_ID,
      conversationId: conversation?.id,
      type: input.candidate.type,
      content: requiredText(input.candidate.content, 'memory content', 100_000),
      sourceMessageId: input.candidate.sourceMessageId,
      confidence: input.candidate.confidence,
      importance: input.candidate.importance,
      emotionalIntensity: input.candidate.emotionalIntensity,
      relationshipRelevance: input.candidate.relationshipRelevance,
      createdAt: now,
      updatedAt: now,
      decay: input.candidate.decay,
      status: decision.status,
      tags: [...input.candidate.tags, decision.status === 'candidate' ? 'needs_review' : 'auto_memory'],
      ...classification,
    })
    for (const contradictedId of decision.contradictedMemoryIds)
      this.database.prepare('UPDATE lumi_memories SET status = \'contradicted\', updated_at = ? WHERE id = ?').run(now, contradictedId)
    this.writeMemory(memory)
    this.audit('memory-candidate-stored', {
      memoryId: memory.id,
      actorPersonId,
      scope: requiredMemoryPolicy(memory.scope, 'scope'),
      ownerId: requiredMemoryPolicy(memory.ownerId, 'ownerId'),
    })
    return memory
  }

  /** Changes curation status without weakening the server-assigned access scope. */
  setMemoryStatus(memoryId: string, status: LumiMemoryStatus) {
    const allowed: LumiMemoryStatus[] = ['candidate', 'active', 'rejected', 'contradicted', 'archived']
    if (!allowed.includes(status))
      throw new Error('Unsupported memory status')
    const result = this.database.prepare('UPDATE lumi_memories SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), requiredText(memoryId, 'memoryId', 160))
    if (Number(result.changes) !== 1)
      throw new Error('Memory was not found')
  }

  /** Returns only memories authorized for the current direct or group context. */
  listAccessibleMemories(request: LumiMemorySearchRequest, limit = 500): LumiMemoryFragment[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 2_000)
      throw new Error('Memory limit must be between 1 and 2000')
    this.assertPerson(requiredText(request.viewerUserId || request.userId, 'viewerUserId', 160))
    return this.rows(`
      SELECT * FROM lumi_memories
      WHERE status = 'active'
      ORDER BY importance DESC, updated_at DESC
      LIMIT ?
    `, limit)
      .map(memoryFromRow)
      .filter(memory => canAccessLumiMemory(memory, request))
  }

  /** Returns non-rejected memories whose current content has no matching vector. */
  listMemoryVectorCandidates(model: string, limit = 2_000): LumiMemoryFragment[] {
    const normalizedModel = requiredText(model, 'model', 500)
    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
      throw new Error('Vector candidate limit must be between 1 and 10000')
    return this.rows(`
      SELECT m.*
      FROM lumi_memories m
      LEFT JOIN lumi_memory_vectors v
        ON v.memory_id = m.id AND v.model = ?
      WHERE m.status != 'rejected'
      ORDER BY m.updated_at ASC
      LIMIT ?
    `, normalizedModel, limit)
      .map(memoryFromRow)
  }

  /** Stores one normalized semantic vector in the authoritative database. */
  upsertMemoryVector(record: LumiMemoryVectorRecord) {
    const vector = finiteVector(record.vector)
    if (record.dimensions !== vector.length)
      throw new Error('Vector dimensions do not match vector length')
    this.assertMemory(requiredText(record.memoryId, 'memoryId', 160))
    this.database.prepare(`
      INSERT INTO lumi_memory_vectors (
        memory_id, model, dimensions, vector_json, content_digest, device, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        model = excluded.model,
        dimensions = excluded.dimensions,
        vector_json = excluded.vector_json,
        content_digest = excluded.content_digest,
        device = excluded.device,
        updated_at = excluded.updated_at
    `).run(
      record.memoryId,
      requiredText(record.model, 'model', 500),
      record.dimensions,
      JSON.stringify(vector),
      requiredText(record.contentDigest, 'contentDigest', 128),
      optionalText(record.device, 160) ?? null,
      finiteTimestamp(record.updatedAt),
    )
  }

  /** Returns persisted vectors for an already authorized memory projection. */
  memoryVectors(memoryIds: string[], model: string): LumiMemoryVectorRecord[] {
    const normalizedIds = [...new Set(memoryIds.map(id => requiredText(id, 'memoryId', 160)))]
    if (normalizedIds.length === 0)
      return []
    if (normalizedIds.length > 2_000)
      throw new Error('At most 2000 memory vectors may be read at once')
    const placeholders = normalizedIds.map(() => '?').join(', ')
    return this.rows(`
      SELECT * FROM lumi_memory_vectors
      WHERE model = ? AND memory_id IN (${placeholders})
    `, requiredText(model, 'model', 500), ...normalizedIds).map(memoryVectorFromRow)
  }

  memoryVectorStatus(model: string, contentDigestFor: (memory: LumiMemoryFragment) => string): LumiMemoryVectorStatus {
    const memories = this.rows('SELECT * FROM lumi_memories WHERE status != \'rejected\'').map(memoryFromRow)
    const vectors = new Map(this.memoryVectors(memories.map(memory => memory.id), model).map(vector => [vector.memoryId, vector]))
    const indexedCount = memories.filter(memory => vectors.get(memory.id)?.contentDigest === contentDigestFor(memory)).length
    return {
      model,
      indexedCount,
      totalCount: memories.length,
      missingCount: memories.length - indexedCount,
    }
  }

  /** Atomically replaces one per-person state projection using optimistic versioning. */
  writePersonState(input: {
    personId: string
    kind: LumiPersonStateKind
    payload: Record<string, unknown>
    expectedVersion?: number
  }): LumiPersonStateRecord {
    const personId = requiredText(input.personId, 'personId', 160)
    this.assertPerson(personId)
    return this.transaction(() => {
      const existing = this.row(
        'SELECT version FROM lumi_person_state WHERE person_id = ? AND kind = ?',
        personId,
        input.kind,
      )
      const version = existing ? Number(existing.version) : 0
      if (input.expectedVersion !== undefined && input.expectedVersion !== version)
        throw new Error(`Person state version conflict: expected ${input.expectedVersion}, current ${version}`)
      const nextVersion = version + 1
      const updatedAt = Date.now()
      this.database.prepare(`
        INSERT INTO lumi_person_state (person_id, kind, version, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(person_id, kind) DO UPDATE SET
          version = excluded.version,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `).run(personId, input.kind, nextVersion, JSON.stringify(input.payload), updatedAt)
      return { personId, kind: input.kind, version: nextVersion, payload: input.payload, updatedAt }
    })
  }

  /** Reads state only for the explicitly selected Lumi person. */
  readPersonState(personId: string, kind: LumiPersonStateKind): LumiPersonStateRecord | undefined {
    const row = this.row(
      'SELECT * FROM lumi_person_state WHERE person_id = ? AND kind = ?',
      requiredText(personId, 'personId', 160),
      kind,
    )
    if (!row)
      return undefined
    return {
      personId: String(row.person_id),
      kind: String(row.kind) as LumiPersonStateKind,
      version: Number(row.version),
      payload: parseJsonObject(row.payload_json),
      updatedAt: Number(row.updated_at),
    }
  }

  /** Reads a bounded cross-conversation projection for Lumi's private background reflection. */
  recentMessagesForBackground(limit = 200, since = 0): LumiBackgroundMessage[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 2_000)
      throw new Error('Background message limit must be between 1 and 2000')
    return this.rows(`
      SELECT m.role, m.content, m.created_at, m.conversation_id,
             c.type AS conversation_type, p.display_name AS actor_display_name
      FROM lumi_messages m
      JOIN lumi_conversations c ON c.id = m.conversation_id
      LEFT JOIN lumi_people p ON p.id = m.actor_person_id
      WHERE m.created_at >= ?
      ORDER BY m.created_at DESC, m.sequence DESC
      LIMIT ?
    `, Math.max(0, Math.floor(since)), limit).reverse().map(row => ({
      conversationId: String(row.conversation_id),
      conversationType: String(row.conversation_type) as 'direct' | 'group',
      role: String(row.role) as 'user' | 'assistant' | 'system',
      actorDisplayName: optionalText(row.actor_display_name, 200),
      content: String(row.content),
      createdAt: Number(row.created_at),
    }))
  }

  appendDiaryEntry(input: { date: string, title: string, content: string, mood?: string, tags?: string[], sourceSummary?: string }) {
    const id = randomUUID()
    const now = Date.now()
    this.database.prepare(`
      INSERT INTO lumi_diary_entries (
        id, entry_date, title, content, mood, tags_json, source_summary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      requiredText(input.date, 'diary date', 40),
      requiredText(input.title, 'diary title', 300),
      requiredText(input.content, 'diary content', 1_000_000),
      optionalText(input.mood, 160) ?? null,
      JSON.stringify(input.tags ?? []),
      optionalText(input.sourceSummary, 20_000) ?? null,
      now,
      now,
    )
    return id
  }

  readAutonomousState(key: string): Record<string, unknown> | undefined {
    const row = this.row('SELECT payload_json FROM lumi_autonomous_state WHERE key = ?', requiredText(key, 'autonomous state key', 240))
    return row ? parseJsonObject(row.payload_json) : undefined
  }

  writeAutonomousState(key: string, payload: Record<string, unknown>) {
    const normalizedKey = requiredText(key, 'autonomous state key', 240)
    const now = Date.now()
    this.database.prepare(`
      INSERT INTO lumi_autonomous_state (key, version, payload_json, updated_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        version = version + 1,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(normalizedKey, JSON.stringify(payload), now)
  }

  /** Persists background work before execution so it survives server restarts. */
  enqueueJob(kind: string, payload: Record<string, unknown>, scheduledAt = Date.now()): LumiServerJob {
    const now = Date.now()
    const job: LumiServerJob = {
      id: randomUUID(),
      kind: requiredText(kind, 'job kind', 160),
      status: 'pending',
      payload,
      attempts: 0,
      scheduledAt: finiteTimestamp(scheduledAt),
      createdAt: now,
      updatedAt: now,
    }
    this.database.prepare(`
      INSERT INTO lumi_jobs (
        id, kind, status, payload_json, attempts, scheduled_at, created_at, updated_at
      ) VALUES (?, ?, 'pending', ?, 0, ?, ?, ?)
    `).run(job.id, job.kind, JSON.stringify(job.payload), job.scheduledAt, now, now)
    return job
  }

  /** Enqueues singleton maintenance work unless the same kind is already active. */
  enqueueJobIfIdle(kind: string, payload: Record<string, unknown> = {}, scheduledAt = Date.now()): LumiServerJob | undefined {
    const normalizedKind = requiredText(kind, 'job kind', 160)
    if (this.row('SELECT id FROM lumi_jobs WHERE kind = ? AND status IN (\'pending\', \'running\') LIMIT 1', normalizedKind))
      return undefined
    return this.enqueueJob(normalizedKind, payload, scheduledAt)
  }

  /** Atomically claims the oldest due job for the single server task pool. */
  claimDueJob(now = Date.now()): LumiServerJob | undefined {
    return this.transaction(() => {
      const row = this.row(`
        SELECT * FROM lumi_jobs
        WHERE status = 'pending' AND scheduled_at <= ?
        ORDER BY scheduled_at ASC, created_at ASC
        LIMIT 1
      `, finiteTimestamp(now))
      if (!row)
        return undefined
      const startedAt = Date.now()
      const updated = this.database.prepare(`
        UPDATE lumi_jobs
        SET status = 'running', attempts = attempts + 1, started_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(startedAt, startedAt, String(row.id))
      if (Number(updated.changes) !== 1)
        return undefined
      return jobFromRow({ ...row, status: 'running', attempts: Number(row.attempts) + 1, started_at: startedAt, updated_at: startedAt })
    })
  }

  finishJob(jobId: string, result: Record<string, unknown> = {}): void {
    this.setJobTerminalState(jobId, 'completed', result)
  }

  failJob(jobId: string, result: Record<string, unknown>, retryAt?: number): void {
    const id = requiredText(jobId, 'jobId', 160)
    const now = Date.now()
    const status = retryAt === undefined ? 'failed' : 'pending'
    const updated = this.database.prepare(`
      UPDATE lumi_jobs SET
        status = ?, result_json = ?, scheduled_at = ?,
        started_at = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running'
    `).run(
      status,
      JSON.stringify(result),
      retryAt === undefined ? now : finiteTimestamp(retryAt),
      retryAt === undefined ? now : null,
      retryAt === undefined ? now : null,
      now,
      id,
    )
    if (Number(updated.changes) !== 1)
      throw new Error('Running job was not found')
  }

  /** Requeues jobs left running by a crash before workers begin. */
  recoverInterruptedJobs(now = Date.now()): number {
    const recoveredAt = finiteTimestamp(now)
    const result = this.database.prepare(`
      UPDATE lumi_jobs SET
        status = 'pending', scheduled_at = ?, started_at = NULL,
        result_json = ?, updated_at = ?
      WHERE status = 'running'
    `).run(recoveredAt, JSON.stringify({ recoveredAfterRestart: true }), recoveredAt)
    return Number(result.changes)
  }

  exportBackup(): LumiServerBackupV1 {
    return {
      format: LUMI_SERVER_BACKUP_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      sections: {
        authUsers: this.rowsIfTableExists('user', 'createdAt'),
        authAccounts: this.rowsIfTableExists('account', 'createdAt'),
        authVerifications: this.rowsIfTableExists('verification', 'createdAt'),
        people: this.rows('SELECT * FROM lumi_people ORDER BY created_at ASC'),
        accountPeople: this.rows('SELECT * FROM lumi_account_people ORDER BY created_at ASC'),
        invitations: this.rows('SELECT * FROM lumi_invitations ORDER BY created_at ASC'),
        externalIdentities: this.rows('SELECT * FROM lumi_external_identities ORDER BY created_at ASC'),
        conversations: this.rows('SELECT * FROM lumi_conversations ORDER BY created_at ASC'),
        conversationMembers: this.rows('SELECT * FROM lumi_conversation_members ORDER BY conversation_id, person_id'),
        messages: this.rows('SELECT * FROM lumi_messages ORDER BY conversation_id, sequence'),
        deliveryReceipts: this.rows('SELECT * FROM lumi_delivery_receipts ORDER BY accepted_at ASC'),
        memories: this.rows('SELECT * FROM lumi_memories ORDER BY created_at ASC'),
        memoryVectors: this.rows('SELECT * FROM lumi_memory_vectors ORDER BY memory_id ASC'),
        personStates: this.rows('SELECT * FROM lumi_person_state ORDER BY person_id, kind'),
        diaryEntries: this.rows('SELECT * FROM lumi_diary_entries ORDER BY entry_date, created_at'),
        privateNotes: this.rows('SELECT * FROM lumi_private_notes ORDER BY created_at'),
        autonomousState: this.rows('SELECT * FROM lumi_autonomous_state ORDER BY key'),
        toolAudits: this.rows('SELECT * FROM lumi_tool_audit ORDER BY created_at'),
        jobs: this.rows('SELECT * FROM lumi_jobs ORDER BY created_at'),
        serverConfig: this.rows('SELECT * FROM lumi_server_config ORDER BY key'),
        devices: this.rows('SELECT * FROM lumi_devices ORDER BY created_at'),
        migrationImports: this.rows('SELECT * FROM lumi_migration_imports ORDER BY created_at'),
        metadata: this.rows('SELECT * FROM lumi_server_meta ORDER BY key'),
        audits: this.rows('SELECT * FROM lumi_server_audit ORDER BY created_at ASC'),
      },
    }
  }

  /** Restores a full server backup into a stopped, exclusively owned database. */
  restoreBackup(backup: LumiServerBackupV1) {
    if (backup.format !== LUMI_SERVER_BACKUP_FORMAT || backup.version !== 1)
      throw new Error('Unsupported Lumi Server backup format')
    const sections = backup.sections
    this.database.exec('PRAGMA foreign_keys = OFF')
    try {
      this.transaction(() => {
        for (const table of [
          'session',
          'lumi_delivery_receipts',
          'lumi_messages',
          'lumi_conversation_members',
          'lumi_memory_vectors',
          'lumi_memories',
          'lumi_person_state',
          'lumi_diary_entries',
          'lumi_private_notes',
          'lumi_autonomous_state',
          'lumi_tool_audit',
          'lumi_jobs',
          'lumi_devices',
          'lumi_invitations',
          'lumi_account_people',
          'lumi_external_identities',
          'lumi_conversations',
          'lumi_people',
          'lumi_server_config',
          'lumi_migration_imports',
          'lumi_server_meta',
          'lumi_server_audit',
          'account',
          'verification',
          'user',
        ]) {
          if (this.tableExists(table))
            this.database.exec(`DELETE FROM ${quotedIdentifier(table)}`)
        }

        this.insertRows('user', sections.authUsers)
        this.insertRows('account', sections.authAccounts)
        this.insertRows('verification', sections.authVerifications)
        this.insertRows('lumi_people', sections.people)
        this.insertRows('lumi_external_identities', sections.externalIdentities)
        this.insertRows('lumi_conversations', sections.conversations)
        this.insertRows('lumi_conversation_members', sections.conversationMembers)
        this.insertRows('lumi_account_people', sections.accountPeople)
        this.insertRows('lumi_invitations', sections.invitations)
        this.insertRows('lumi_messages', sections.messages)
        this.insertRows('lumi_delivery_receipts', sections.deliveryReceipts)
        this.insertRows('lumi_memories', sections.memories)
        this.insertRows('lumi_memory_vectors', sections.memoryVectors)
        this.insertRows('lumi_person_state', sections.personStates)
        this.insertRows('lumi_diary_entries', sections.diaryEntries)
        this.insertRows('lumi_private_notes', sections.privateNotes)
        this.insertRows('lumi_autonomous_state', sections.autonomousState)
        this.insertRows('lumi_tool_audit', sections.toolAudits)
        this.insertRows('lumi_jobs', sections.jobs)
        this.insertRows('lumi_server_config', sections.serverConfig)
        this.insertRows('lumi_devices', sections.devices)
        this.insertRows('lumi_migration_imports', sections.migrationImports)
        this.insertRows('lumi_server_meta', sections.metadata)
        this.insertRows('lumi_server_audit', sections.audits)
      })
    }
    finally {
      this.database.exec('PRAGMA foreign_keys = ON')
    }
    const integrity = this.row('PRAGMA integrity_check')
    if (String(integrity?.integrity_check) !== 'ok')
      throw new Error(`Restored database integrity check failed: ${String(integrity?.integrity_check)}`)
  }

  recordStagedMigration(input: { id: string, sourceDigest: string, manifest: Record<string, unknown>, report: Record<string, unknown> }) {
    this.database.prepare(`
      INSERT INTO lumi_migration_imports (
        id, format, source_digest, status, manifest_json, report_json, created_at
      ) VALUES (?, 'lumi-client-migration:v1', ?, 'validated', ?, ?, ?)
    `).run(
      requiredText(input.id, 'migration id', 160),
      requiredText(input.sourceDigest, 'source digest', 128),
      JSON.stringify(input.manifest),
      JSON.stringify(input.report),
      Date.now(),
    )
  }

  markMigrationFailed(id: string, report: Record<string, unknown>) {
    this.database.prepare(`
      UPDATE lumi_migration_imports
      SET status = 'failed', report_json = ?, completed_at = ?
      WHERE id = ? AND status IN ('staged', 'validated')
    `).run(JSON.stringify(report), Date.now(), requiredText(id, 'migration id', 160))
  }

  /** Appends one validated offline migration without replacing existing online records. */
  importValidatedMigration(id: string, plan: LumiValidatedMigrationPlan): LumiMigrationImportCounts {
    const migrationId = requiredText(id, 'migration id', 160)
    return this.transaction(() => {
      const migration = this.row('SELECT status FROM lumi_migration_imports WHERE id = ? AND status = \'validated\'', migrationId)
      if (!migration)
        throw new Error('Migration is not staged and validated')
      const counts: LumiMigrationImportCounts = {
        people: 0,
        externalIdentities: 0,
        messages: 0,
        memories: 0,
        memoryVectors: 0,
        personStates: 0,
        diaryEntries: 0,
        privateNotes: 0,
        autonomousState: 0,
      }
      for (const person of plan.people) {
        const result = this.database.prepare(`
          INSERT OR IGNORE INTO lumi_people (
            id, display_name, preferred_address, role, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(person.id, person.displayName, person.preferredAddress, person.role, person.status, person.createdAt, person.updatedAt)
        counts.people += Number(result.changes)
      }
      for (const identity of plan.externalIdentities) {
        this.assertPerson(identity.personId)
        const result = this.database.prepare(`
          INSERT OR IGNORE INTO lumi_external_identities (
            id, person_id, provider, provider_instance_id, external_user_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(identity.id, identity.personId, identity.provider, identity.providerInstanceId, identity.externalUserId, identity.createdAt)
        counts.externalIdentities += Number(result.changes)
      }
      for (const message of plan.messages) {
        this.ensureConversation(message.conversationId, message.conversationType, message.title, message.participantPersonIds, message.createdAt)
        if (this.row('SELECT id FROM lumi_messages WHERE id = ?', message.id))
          continue
        const conversation = this.row('SELECT latest_sequence FROM lumi_conversations WHERE id = ?', message.conversationId)!
        const sequence = Number(conversation.latest_sequence) + 1
        const result = this.database.prepare(`
          INSERT OR IGNORE INTO lumi_messages (
            id, conversation_id, sequence, role, actor_person_id, content, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(message.id, message.conversationId, sequence, message.role, message.actorPersonId ?? null, message.content, message.createdAt)
        if (Number(result.changes) === 1) {
          this.database.prepare('UPDATE lumi_conversations SET latest_sequence = ?, updated_at = ? WHERE id = ?')
            .run(sequence, message.createdAt, message.conversationId)
          counts.messages += 1
        }
      }
      for (const memory of plan.memories) {
        if (this.row('SELECT id FROM lumi_memories WHERE id = ?', memory.id))
          continue
        this.assertPerson(memory.userId)
        this.writeMemory(memory)
        counts.memories += 1
      }
      for (const vector of plan.memoryVectors) {
        if (!this.row('SELECT id FROM lumi_memories WHERE id = ?', vector.memoryId))
          continue
        const result = this.database.prepare(`
          INSERT OR IGNORE INTO lumi_memory_vectors (
            memory_id, model, dimensions, vector_json, content_digest, device, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          vector.memoryId,
          vector.model,
          vector.dimensions,
          JSON.stringify(vector.vector),
          vector.contentDigest,
          vector.device ?? null,
          vector.updatedAt,
        )
        counts.memoryVectors += Number(result.changes)
      }
      for (const state of plan.personStates) {
        this.assertPerson(state.personId)
        const result = this.database.prepare(`
          INSERT OR IGNORE INTO lumi_person_state (person_id, kind, version, payload_json, updated_at)
          VALUES (?, ?, 1, ?, ?)
        `).run(state.personId, state.kind, JSON.stringify(state.payload), state.updatedAt)
        counts.personStates += Number(result.changes)
      }
      for (const entry of plan.diaryEntries) {
        const result = this.database.prepare(`
          INSERT OR IGNORE INTO lumi_diary_entries (
            id, entry_date, title, content, mood, tags_json, source_summary, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(entry.id, entry.entryDate, entry.title, entry.content, entry.mood ?? null, JSON.stringify(entry.tags), entry.sourceSummary ?? null, entry.createdAt, entry.updatedAt)
        counts.diaryEntries += Number(result.changes)
      }
      for (const note of plan.privateNotes) {
        const result = this.database.prepare(`
          INSERT OR IGNORE INTO lumi_private_notes (
            id, content, source_kind, source_reference, tags_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(note.id, note.content, note.sourceKind, note.sourceReference ?? null, JSON.stringify(note.tags), note.createdAt, note.updatedAt)
        counts.privateNotes += Number(result.changes)
      }
      for (const state of plan.autonomousState) {
        const result = this.database.prepare(`
          INSERT OR IGNORE INTO lumi_autonomous_state (key, version, payload_json, updated_at)
          VALUES (?, 1, ?, ?)
        `).run(state.key, JSON.stringify(state.payload), state.updatedAt)
        counts.autonomousState += Number(result.changes)
      }
      this.database.prepare(`
        UPDATE lumi_migration_imports
        SET status = 'imported', report_json = ?, completed_at = ?
        WHERE id = ? AND status = 'validated'
      `).run(JSON.stringify({ imported: counts }), Date.now(), migrationId)
      return counts
    })
  }

  private migrate() {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS lumi_people (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        preferred_address TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('owner', 'member')),
        status TEXT NOT NULL CHECK(status IN ('active', 'inactive')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lumi_account_people (
        auth_user_id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(person_id) REFERENCES lumi_people(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS lumi_external_identities (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL,
        external_user_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(person_id) REFERENCES lumi_people(id) ON DELETE CASCADE,
        UNIQUE(provider, provider_instance_id, external_user_id)
      );

      CREATE TABLE IF NOT EXISTS lumi_invitations (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL,
        code_digest TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER,
        consumed_by_auth_user_id TEXT,
        FOREIGN KEY(person_id) REFERENCES lumi_people(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS lumi_conversations (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('direct', 'group')),
        title TEXT NOT NULL,
        latest_sequence INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lumi_conversation_members (
        conversation_id TEXT NOT NULL,
        person_id TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        revoked_at INTEGER,
        PRIMARY KEY(conversation_id, person_id),
        FOREIGN KEY(conversation_id) REFERENCES lumi_conversations(id) ON DELETE CASCADE,
        FOREIGN KEY(person_id) REFERENCES lumi_people(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS lumi_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        actor_person_id TEXT,
        content TEXT NOT NULL,
        expression TEXT,
        motion TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES lumi_conversations(id) ON DELETE CASCADE,
        FOREIGN KEY(actor_person_id) REFERENCES lumi_people(id) ON DELETE SET NULL,
        UNIQUE(conversation_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS lumi_delivery_receipts (
        conversation_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        actor_person_id TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        accepted_at INTEGER NOT NULL,
        PRIMARY KEY(conversation_id, idempotency_key),
        FOREIGN KEY(conversation_id) REFERENCES lumi_conversations(id) ON DELETE CASCADE,
        FOREIGN KEY(message_id) REFERENCES lumi_messages(id) ON DELETE CASCADE,
        FOREIGN KEY(actor_person_id) REFERENCES lumi_people(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS lumi_memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        conversation_id TEXT,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        source_message_id TEXT,
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        emotional_intensity REAL NOT NULL,
        relationship_relevance REAL NOT NULL,
        decay REAL NOT NULL,
        tags_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('candidate', 'active', 'rejected', 'contradicted', 'archived')),
        scope TEXT NOT NULL CHECK(scope IN ('global', 'shared', 'relationship', 'group', 'private')),
        owner_type TEXT NOT NULL CHECK(owner_type IN ('lumi', 'user', 'group')),
        owner_id TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK(visibility IN ('global', 'shared', 'participants', 'private')),
        participant_user_ids_json TEXT NOT NULL,
        subject_user_ids_json TEXT NOT NULL,
        sensitivity TEXT NOT NULL CHECK(sensitivity IN ('normal', 'private')),
        source_actor_id TEXT NOT NULL,
        source_conversation_type TEXT NOT NULL CHECK(source_conversation_type IN ('direct', 'group', 'manual', 'import')),
        classification_reason TEXT NOT NULL,
        disclosure_reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        FOREIGN KEY(user_id) REFERENCES lumi_people(id) ON DELETE CASCADE,
        FOREIGN KEY(conversation_id) REFERENCES lumi_conversations(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS lumi_memory_vectors (
        memory_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        device TEXT,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(memory_id) REFERENCES lumi_memories(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS lumi_person_state (
        person_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('profile', 'short-term', 'emotion', 'relationship')),
        version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(person_id, kind),
        FOREIGN KEY(person_id) REFERENCES lumi_people(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS lumi_diary_entries (
        id TEXT PRIMARY KEY,
        entry_date TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        mood TEXT,
        tags_json TEXT NOT NULL,
        source_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lumi_private_notes (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_reference TEXT,
        tags_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lumi_autonomous_state (
        key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lumi_tool_audit (
        id TEXT PRIMARY KEY,
        person_id TEXT,
        conversation_id TEXT,
        tool_name TEXT NOT NULL,
        outcome TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(person_id) REFERENCES lumi_people(id) ON DELETE SET NULL,
        FOREIGN KEY(conversation_id) REFERENCES lumi_conversations(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS lumi_jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
        payload_json TEXT NOT NULL,
        result_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        scheduled_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lumi_server_config (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        secret INTEGER NOT NULL DEFAULT 0 CHECK(secret IN (0, 1)),
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lumi_devices (
        id TEXT PRIMARY KEY,
        auth_user_id TEXT NOT NULL,
        session_id TEXT,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        last_seen_at INTEGER NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(auth_user_id) REFERENCES lumi_account_people(auth_user_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS lumi_migration_imports (
        id TEXT PRIMARY KEY,
        format TEXT NOT NULL,
        source_digest TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('staged', 'validated', 'imported', 'failed')),
        manifest_json TEXT NOT NULL,
        report_json TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS lumi_server_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lumi_server_audit (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_lumi_messages_conversation_sequence
        ON lumi_messages(conversation_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_lumi_conversation_members_person
        ON lumi_conversation_members(person_id, revoked_at);
      CREATE INDEX IF NOT EXISTS idx_lumi_memories_access
        ON lumi_memories(status, scope, owner_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_lumi_memories_source_actor
        ON lumi_memories(source_actor_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_lumi_jobs_schedule
        ON lumi_jobs(status, scheduled_at);
    `)
    this.addColumnIfMissing('lumi_memory_vectors', 'device', 'TEXT')
    this.addColumnIfMissing('lumi_devices', 'session_id', 'TEXT')
  }

  private seedKnownPeopleAndConversations() {
    const now = Date.now()
    const insertPerson = this.database.prepare(`
      INSERT OR IGNORE INTO lumi_people (
        id, display_name, preferred_address, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?)
    `)
    insertPerson.run(DOGGY_PERSON_ID, 'Doggy', 'Doggy', 'owner', now, now)
    insertPerson.run(MOUSSY_PERSON_ID, 'Moussy', 'Moussy', 'member', now, now)

    this.ensureConversation(`lumi-direct:${DOGGY_PERSON_ID}`, 'direct', 'Doggy 与 Lumi', [DOGGY_PERSON_ID], now)
    this.ensureConversation(`lumi-direct:${MOUSSY_PERSON_ID}`, 'direct', 'Moussy 与 Lumi', [MOUSSY_PERSON_ID], now)
    this.ensureConversation(DOGGY_MOUSSY_GROUP_ID, 'group', 'Doggy、Moussy 与 Lumi', [DOGGY_PERSON_ID, MOUSSY_PERSON_ID], now)
    this.database.prepare(`
      INSERT INTO lumi_server_meta (key, value, updated_at)
      VALUES ('schema_version', '2', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(now)
  }

  private ensureConversation(id: string, type: 'direct' | 'group', title: string, people: string[], now: number) {
    this.database.prepare(`
      INSERT OR IGNORE INTO lumi_conversations (id, type, title, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, type, title, now, now)
    const insertMember = this.database.prepare(`
      INSERT OR IGNORE INTO lumi_conversation_members (conversation_id, person_id, joined_at)
      VALUES (?, ?, ?)
    `)
    for (const personId of people)
      insertMember.run(id, personId, now)
  }

  private conversationFromRow(row: SqliteRow): LumiOnlineConversation {
    const id = String(row.id)
    return {
      id,
      type: row.type === 'group' ? 'group' : 'direct',
      title: String(row.title),
      participantPersonIds: this.rows(`
        SELECT person_id FROM lumi_conversation_members
        WHERE conversation_id = ? AND revoked_at IS NULL
        ORDER BY joined_at ASC
      `, id).map(member => String(member.person_id)),
      latestSequence: Number(row.latest_sequence),
      updatedAt: Number(row.updated_at),
    }
  }

  private getMessage(messageId: string) {
    const row = this.row(`
      SELECT m.*, p.display_name AS actor_display_name
      FROM lumi_messages m
      LEFT JOIN lumi_people p ON p.id = m.actor_person_id
      WHERE m.id = ?
    `, messageId)
    return row ? messageFromRow(row) : undefined
  }

  private writeMemory(memory: LumiMemoryFragment) {
    const normalized = normalizeMemoryScores(memory)
    this.database.prepare(`
      INSERT INTO lumi_memories (
        id, user_id, persona_id, conversation_id, type, content, source_message_id,
        confidence, importance, emotional_intensity, relationship_relevance, decay,
        tags_json, status, scope, owner_type, owner_id, visibility,
        participant_user_ids_json, subject_user_ids_json, sensitivity,
        source_actor_id, source_conversation_type, classification_reason,
        disclosure_reason, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.id,
      normalized.userId,
      normalized.personaId,
      normalized.conversationId ?? null,
      normalized.type,
      normalized.content,
      normalized.sourceMessageId ?? null,
      normalized.confidence,
      normalized.importance,
      normalized.emotionalIntensity,
      normalized.relationshipRelevance,
      normalized.decay,
      JSON.stringify(normalized.tags),
      normalized.status,
      requiredMemoryPolicy(normalized.scope, 'scope'),
      requiredMemoryPolicy(normalized.ownerType, 'ownerType'),
      requiredMemoryPolicy(normalized.ownerId, 'ownerId'),
      requiredMemoryPolicy(normalized.visibility, 'visibility'),
      JSON.stringify(normalized.participantUserIds ?? []),
      JSON.stringify(normalized.subjectUserIds ?? []),
      requiredMemoryPolicy(normalized.sensitivity, 'sensitivity'),
      requiredMemoryPolicy(normalized.sourceActorId, 'sourceActorId'),
      requiredMemoryPolicy(normalized.sourceConversationType, 'sourceConversationType'),
      requiredMemoryPolicy(normalized.classificationReason, 'classificationReason'),
      requiredMemoryPolicy(normalized.disclosureReason, 'disclosureReason'),
      normalized.createdAt,
      normalized.updatedAt,
      normalized.lastUsedAt ?? null,
    )
  }

  private assertPerson(personId: string) {
    if (!this.row('SELECT id FROM lumi_people WHERE id = ? AND status = \'active\'', personId))
      throw new Error('Lumi person was not found or is inactive')
  }

  private assertMemory(memoryId: string) {
    if (!this.row('SELECT id FROM lumi_memories WHERE id = ?', memoryId))
      throw new Error('Memory was not found')
  }

  private addColumnIfMissing(table: string, column: string, definition: string) {
    const columns = this.rows(`PRAGMA table_info(${table})`)
    if (!columns.some(existing => existing.name === column))
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  private tableExists(table: string) {
    return Boolean(this.row('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = ?', table))
  }

  private rowsIfTableExists(table: string, orderColumn: string): SqliteRow[] {
    return this.tableExists(table)
      ? this.rows(`SELECT * FROM ${quotedIdentifier(table)} ORDER BY ${quotedIdentifier(orderColumn)} ASC`)
      : []
  }

  private insertRows(table: string, rows: SqliteRow[]) {
    if (rows.length === 0)
      return
    if (!this.tableExists(table))
      throw new Error(`Backup target table does not exist: ${table}`)
    const targetColumns = new Set(this.rows(`PRAGMA table_info(${quotedIdentifier(table)})`).map(row => String(row.name)))
    for (const row of rows) {
      const columns = Object.keys(row)
      if (columns.length === 0 || columns.some(column => !targetColumns.has(column)))
        throw new Error(`Backup row does not match target table: ${table}`)
      const sql = `INSERT INTO ${quotedIdentifier(table)} (${columns.map(quotedIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      this.database.prepare(sql).run(...columns.map(column => row[column] ?? null))
    }
  }

  private setJobTerminalState(jobId: string, status: Extract<LumiServerJobStatus, 'completed' | 'cancelled'>, result: Record<string, unknown>) {
    const now = Date.now()
    const updated = this.database.prepare(`
      UPDATE lumi_jobs
      SET status = ?, result_json = ?, finished_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'running')
    `).run(status, JSON.stringify(result), now, now, requiredText(jobId, 'jobId', 160))
    if (Number(updated.changes) !== 1)
      throw new Error('Active job was not found')
  }

  private audit(action: string, metadata: Record<string, string>) {
    this.database.prepare(`
      INSERT INTO lumi_server_audit (id, action, metadata_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(randomUUID(), action, JSON.stringify(metadata), Date.now())
  }

  private transaction<TResult>(operation: () => TResult): TResult {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    }
    catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private row(sql: string, ...values: SqliteValue[]): SqliteRow | undefined {
    return this.database.prepare(sql).get(...values) as SqliteRow | undefined
  }

  private rows(sql: string, ...values: SqliteValue[]): SqliteRow[] {
    return this.database.prepare(sql).all(...values) as SqliteRow[]
  }
}

function personFromRow(row: SqliteRow): LumiOnlinePerson {
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    role: row.role === 'owner' ? 'owner' : 'member',
  }
}

function messageFromRow(row: SqliteRow): LumiOnlineMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    sequence: Number(row.sequence),
    role: row.role === 'assistant' ? 'assistant' : row.role === 'system' ? 'system' : 'user',
    actorPersonId: optionalText(row.actor_person_id, 160),
    actorDisplayName: optionalText(row.actor_display_name, 160),
    content: String(row.content),
    createdAt: Number(row.created_at),
    expression: optionalText(row.expression, 160),
    motion: optionalText(row.motion, 160),
  }
}

function memoryFromRow(row: SqliteRow): LumiMemoryFragment {
  return normalizeMemoryScores({
    id: String(row.id),
    userId: String(row.user_id),
    personaId: String(row.persona_id),
    conversationId: optionalText(row.conversation_id, 240),
    type: String(row.type) as LumiMemoryFragment['type'],
    content: String(row.content),
    sourceMessageId: optionalText(row.source_message_id, 240),
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    emotionalIntensity: Number(row.emotional_intensity),
    relationshipRelevance: Number(row.relationship_relevance),
    decay: Number(row.decay),
    tags: parseJsonStringArray(row.tags_json),
    status: String(row.status) as LumiMemoryStatus,
    scope: String(row.scope) as LumiMemoryFragment['scope'],
    ownerType: String(row.owner_type) as LumiMemoryFragment['ownerType'],
    ownerId: String(row.owner_id),
    visibility: String(row.visibility) as LumiMemoryFragment['visibility'],
    participantUserIds: parseJsonStringArray(row.participant_user_ids_json),
    subjectUserIds: parseJsonStringArray(row.subject_user_ids_json),
    sensitivity: String(row.sensitivity) as LumiMemoryFragment['sensitivity'],
    sourceActorId: String(row.source_actor_id),
    sourceConversationType: String(row.source_conversation_type) as LumiMemoryFragment['sourceConversationType'],
    classificationReason: String(row.classification_reason),
    disclosureReason: String(row.disclosure_reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastUsedAt: optionalText(row.last_used_at, 64),
  })
}

function memoryVectorFromRow(row: SqliteRow): LumiMemoryVectorRecord {
  const vector = finiteVector(JSON.parse(String(row.vector_json)))
  return {
    memoryId: String(row.memory_id),
    model: String(row.model),
    dimensions: Number(row.dimensions),
    vector,
    contentDigest: String(row.content_digest),
    device: optionalText(row.device, 160),
    updatedAt: Number(row.updated_at),
  }
}

function jobFromRow(row: SqliteRow): LumiServerJob {
  return {
    id: String(row.id),
    kind: String(row.kind),
    status: String(row.status) as LumiServerJobStatus,
    payload: parseJsonObject(row.payload_json),
    result: row.result_json === null ? undefined : parseJsonObject(row.result_json),
    attempts: Number(row.attempts),
    scheduledAt: Number(row.scheduled_at),
    startedAt: row.started_at === null ? undefined : Number(row.started_at),
    finishedAt: row.finished_at === null ? undefined : Number(row.finished_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function parseJsonObject(value: SqliteValue): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(value))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Stored JSON value is not an object')
  return parsed as Record<string, unknown>
}

function parseJsonStringArray(value: SqliteValue): string[] {
  const parsed: unknown = JSON.parse(String(value))
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string'))
    throw new Error('Stored JSON value is not a string array')
  return parsed
}

function finiteVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100_000)
    throw new Error('Vector must be a non-empty numeric array')
  if (!value.every(item => typeof item === 'number' && Number.isFinite(item)))
    throw new Error('Vector contains a non-finite value')
  return value
}

function requiredMemoryPolicy<TValue extends string>(value: TValue | undefined, field: string): TValue {
  if (!value)
    throw new Error(`Normalized memory ${field} is required`)
  return value
}

function requiredText(value: unknown, field: string, maxLength: number) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized)
    throw new Error(`${field} is required`)
  if (normalized.length > maxLength)
    throw new Error(`${field} is too long`)
  return normalized
}

function optionalText(value: unknown, maxLength: number) {
  const normalized = typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
  return normalized || undefined
}

function finiteTimestamp(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : Date.now()
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function invitationCode() {
  return randomBytes(24).toString('base64url')
}

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function quotedIdentifier(identifier: string) {
  if (!/^[A-Z_]\w*$/i.test(identifier))
    throw new Error(`Unsafe SQLite identifier: ${identifier}`)
  return `"${identifier}"`
}
