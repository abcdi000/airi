import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type {
  LumiCognitiveEvidence,
  LumiCognitiveIdentity,
  LumiCognitiveProjectionState,
  LumiFeedbackEvent,
  LumiMemoryFragment,
  LumiWorkingMemory,
  SocialLanguageSnapshot,
} from '@proj-airi/lumi-runtime'

import type {
  ElectronLumiCognitivePrepareTurnRequest,
  ElectronLumiCognitiveRecordUseRequest,
} from '../../../../shared/eventa'
import type { SqliteDatabase } from './index'

import { defineInvokeHandler } from '@moeru/eventa'
import {
  prepareLumiCognitiveTurn,
  selectPlannerSocialBehaviors,
} from '@proj-airi/lumi-runtime'

import {
  electronLumiCognitivePrepareTurn,
  electronLumiCognitiveRecordUse,
} from '../../../../shared/eventa'

/** Main-process dependencies kept outside the renderer cognitive projection. */
export interface LumiDesktopCognitiveServiceOptions {
  /** Electron Eventa main context. */
  context: ReturnType<typeof createContext>['context']
  /** Shared memory database provider. */
  getDatabase: () => Promise<{ db: SqliteDatabase }>
  /** Main-process hybrid recall with final ACL enforcement. */
  recall: (input: {
    identity: LumiCognitiveIdentity
    query: string
    limit: number
    signal?: AbortSignal
  }) => Promise<{
    memories: LumiMemoryFragment[]
    trace: Awaited<ReturnType<typeof prepareLumiCognitiveTurn>>['recallTrace']
  }>
  /** Main-process memory reload for RecallState reuse. */
  loadMemoriesByIds: (input: {
    identity: LumiCognitiveIdentity
    memoryIds: readonly string[]
    signal?: AbortSignal
  }) => Promise<LumiMemoryFragment[]>
  /** Existing social-language snapshot, used only as non-authorizing guidance. */
  getSocialLanguageSnapshot: () => Promise<SocialLanguageSnapshot>
}

/**
 * Registers the Electron main-process cognitive fast-loop handlers.
 *
 * Use when:
 * - Desktop Agent Runtime needs automatic recall before Planner
 * - Renderer must not load the complete memory/evidence database
 *
 * Expects:
 * - Eventa calls originate from the trusted desktop renderer
 * - Every request carries the immutable Agent envelope identity
 *
 * Returns:
 * - Eventa handlers for preparation and post-Planner usage accounting
 */
export function createLumiDesktopCognitiveService(
  options: LumiDesktopCognitiveServiceOptions,
): void {
  defineInvokeHandler(options.context, electronLumiCognitivePrepareTurn, async (request) => {
    const repository = await desktopRepository(options, request)
    return await prepareLumiCognitiveTurn({
      identity: request.identity,
      sourceMessageId: request.sourceMessageId,
      userText: request.userText,
      recentTurns: request.recentTurns,
      repository,
    })
  })
  defineInvokeHandler(options.context, electronLumiCognitiveRecordUse, async (request) => {
    const { db } = await options.getDatabase()
    ensureCognitiveSchema(db)
    recordContextUse(db, request)
  })
}

async function desktopRepository(
  options: LumiDesktopCognitiveServiceOptions,
  request: ElectronLumiCognitivePrepareTurnRequest,
) {
  const { db } = await options.getDatabase()
  ensureCognitiveSchema(db)
  assertIdentity(request.identity)
  return {
    async loadWorkingMemory(identity: LumiCognitiveIdentity) {
      assertSameIdentity(identity, request.identity)
      return loadWorkingMemory(db, identity)
    },
    async commitFastLoop(input: {
      identity: LumiCognitiveIdentity
      evidence: LumiCognitiveEvidence
      feedback: readonly LumiFeedbackEvent[]
      workingMemory: LumiWorkingMemory
    }) {
      assertSameIdentity(input.identity, request.identity)
      commitFastLoop(db, input)
    },
    async recall(input: {
      identity: LumiCognitiveIdentity
      query: string
      limit: number
      signal?: AbortSignal
    }) {
      assertSameIdentity(input.identity, request.identity)
      return await options.recall(input)
    },
    async loadMemoriesByIds(input: {
      identity: LumiCognitiveIdentity
      memoryIds: readonly string[]
      signal?: AbortSignal
    }) {
      assertSameIdentity(input.identity, request.identity)
      return await options.loadMemoriesByIds(input)
    },
    async loadProjectionState(identity: LumiCognitiveIdentity): Promise<LumiCognitiveProjectionState> {
      assertSameIdentity(identity, request.identity)
      const snapshot = await options.getSocialLanguageSnapshot()
      const behaviors = selectPlannerSocialBehaviors(snapshot.behaviors, {
        personId: identity.actorId,
        conversationId: identity.conversationId,
        conversationType: 'direct',
        platform: request.platform,
        currentUserText: request.userText,
      }, 2)
      const lowerText = request.userText.toLocaleLowerCase()
      const jargon = snapshot.jargon
        .filter(item => lowerText.includes(item.term.toLocaleLowerCase()))
        .slice(0, 4)
      return {
        evidence: [],
        hypotheses: [],
        profile: [],
        interactionStrategies: [
          ...behaviors.map(item => item.behavior.action),
          ...jargon.map(item => `按语境理解“${item.term}”：${item.meanings[0]?.meaning ?? item.pragmaticFunctions.join('、')}`),
        ],
        expressionAssets: [],
        contradictions: [],
      }
    },
  }
}

function ensureCognitiveSchema(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lumi_cognitive_evidence (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      conversation_type TEXT NOT NULL,
      kind TEXT NOT NULL,
      origin TEXT NOT NULL,
      content TEXT NOT NULL,
      source_id TEXT,
      source_message_id TEXT,
      subject_user_ids_json TEXT NOT NULL,
      participant_user_ids_json TEXT NOT NULL,
      derived_from_evidence_ids_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      trust REAL NOT NULL,
      author_verified INTEGER NOT NULL,
      scope TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      derivation_reason TEXT,
      schema_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lumi_cognitive_working_memory (
      person_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      conversation_type TEXT NOT NULL,
      version INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY(person_id, persona_id, conversation_id)
    );

    CREATE TABLE IF NOT EXISTS lumi_cognitive_feedback (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      conversation_type TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      target_ids_json TEXT NOT NULL,
      strength REAL NOT NULL,
      occurred_at TEXT NOT NULL,
      author_verified INTEGER NOT NULL,
      scope TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lumi_cognitive_beliefs (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      conversation_id TEXT,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lumi_cognitive_profile_projections (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      layer TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lumi_cognitive_migrations (
      id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      phase TEXT NOT NULL,
      report_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_lumi_cognitive_evidence_actor_time
      ON lumi_cognitive_evidence(actor_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lumi_cognitive_evidence_conversation_time
      ON lumi_cognitive_evidence(conversation_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lumi_cognitive_working_expiry
      ON lumi_cognitive_working_memory(expires_at, person_id, conversation_id);
    CREATE INDEX IF NOT EXISTS idx_lumi_cognitive_feedback_actor_time
      ON lumi_cognitive_feedback(actor_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lumi_cognitive_belief_subject_status
      ON lumi_cognitive_beliefs(subject_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lumi_cognitive_profile_subject_status
      ON lumi_cognitive_profile_projections(subject_id, status, layer, updated_at DESC);
  `)

  addColumnIfMissing(db, 'lumi_memories', 'derived_from_evidence_ids_json', `TEXT NOT NULL DEFAULT '[]'`)
  addColumnIfMissing(db, 'lumi_memories', 'valid_from', 'TEXT')
  addColumnIfMissing(db, 'lumi_memories', 'valid_until', 'TEXT')
  addColumnIfMissing(db, 'lumi_memories', 'last_confirmed_at', 'TEXT')
  addColumnIfMissing(db, 'lumi_memories', 'supersedes_id', 'TEXT')
  addColumnIfMissing(db, 'lumi_memories', 'superseded_by_id', 'TEXT')
  addColumnIfMissing(db, 'lumi_memories', 'contradicts_ids_json', `TEXT NOT NULL DEFAULT '[]'`)
  addColumnIfMissing(db, 'lumi_memories', 'source_episode_start_message_id', 'TEXT')
  addColumnIfMissing(db, 'lumi_memories', 'source_episode_end_message_id', 'TEXT')
  addColumnIfMissing(db, 'lumi_memories', 'use_count', 'INTEGER NOT NULL DEFAULT 0')
  addColumnIfMissing(db, 'lumi_memories', 'evidence_origin', `TEXT NOT NULL DEFAULT 'legacy_import'`)
  migrateLegacyMemoryOrigins(db)
}

function migrateLegacyMemoryOrigins(db: SqliteDatabase): void {
  const id = 'cognitive-v1-memory-lineage'
  const current = db.prepare('SELECT phase FROM lumi_cognitive_migrations WHERE id = ?').get(id)
  if (current?.phase === 'active')
    return
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`
      UPDATE lumi_memories SET evidence_origin = 'legacy_import'
      WHERE evidence_origin IS NULL OR evidence_origin = ''
    `).run()
    const invalid = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM lumi_memories
      WHERE evidence_origin IS NULL OR evidence_origin = ''
    `).get()?.count ?? 0)
    if (invalid > 0)
      throw new Error('Desktop legacy memory lineage verification failed')
    db.prepare(`
      INSERT INTO lumi_cognitive_migrations (
        id, source_kind, phase, report_json, created_at, updated_at
      ) VALUES (?, 'legacy_memory', 'active', ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        phase = excluded.phase,
        report_json = excluded.report_json,
        updated_at = excluded.updated_at
    `).run(id, JSON.stringify({ copied: true, verified: true, invalid }), now, now)
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function loadWorkingMemory(
  db: SqliteDatabase,
  identity: LumiCognitiveIdentity,
): LumiWorkingMemory | undefined {
  const row = db.prepare(`
    SELECT payload_json FROM lumi_cognitive_working_memory
    WHERE person_id = ? AND persona_id = ? AND conversation_id = ?
  `).get(identity.actorId, identity.personaId, identity.conversationId)
  if (typeof row?.payload_json !== 'string')
    return undefined
  const memory = JSON.parse(row.payload_json) as LumiWorkingMemory
  assertWorkingMemoryIdentity(memory, identity)
  return Date.parse(memory.expiresAt) > Date.now() ? memory : undefined
}

function commitFastLoop(db: SqliteDatabase, input: {
  identity: LumiCognitiveIdentity
  evidence: LumiCognitiveEvidence
  feedback: readonly LumiFeedbackEvent[]
  workingMemory: LumiWorkingMemory
}): void {
  assertIdentity(input.identity)
  assertWorkingMemoryIdentity(input.workingMemory, input.identity)
  assertFastLoopEvidence(input.evidence, input.identity)
  db.exec('BEGIN IMMEDIATE')
  try {
    const evidence = input.evidence
    db.prepare(`
      INSERT OR IGNORE INTO lumi_cognitive_evidence (
        id, actor_id, conversation_id, conversation_type, kind, origin,
        content, source_id, source_message_id, subject_user_ids_json,
        participant_user_ids_json, derived_from_evidence_ids_json,
        occurred_at, trust, author_verified, scope, sensitivity,
        derivation_reason, schema_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evidence.id,
      evidence.actorId,
      evidence.conversationId ?? input.identity.conversationId,
      evidence.conversationType,
      evidence.kind,
      evidence.origin,
      evidence.content,
      evidence.sourceId ?? null,
      evidence.sourceMessageId ?? null,
      JSON.stringify(evidence.subjectUserIds),
      JSON.stringify(evidence.participantUserIds),
      JSON.stringify(evidence.derivedFromEvidenceIds),
      evidence.occurredAt,
      evidence.trust,
      evidence.authorVerified ? 1 : 0,
      evidence.scope,
      evidence.sensitivity,
      evidence.derivationReason ?? null,
      evidence.schemaVersion,
      Date.parse(evidence.occurredAt),
    )
    const stored = db.prepare('SELECT * FROM lumi_cognitive_evidence WHERE id = ?').get(evidence.id)
    if (!stored || !sameEvidence(stored, evidence))
      throw new Error('Desktop cognitive evidence id was reused for different content')

    const insertFeedback = db.prepare(`
      INSERT OR IGNORE INTO lumi_cognitive_feedback (
        id, actor_id, conversation_id, conversation_type, kind, source_id,
        evidence_id, target_ids_json, strength, occurred_at, author_verified,
        scope, sensitivity, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const feedback of input.feedback) {
      assertFastLoopFeedback(feedback, input.identity, evidence.id)
      insertFeedback.run(
        feedback.id,
        feedback.actorId,
        feedback.conversationId,
        feedback.conversationType,
        feedback.kind,
        feedback.sourceId,
        feedback.evidenceId,
        JSON.stringify(feedback.targetIds),
        feedback.strength,
        feedback.occurredAt,
        feedback.authorVerified ? 1 : 0,
        feedback.scope,
        feedback.sensitivity,
        Date.parse(feedback.occurredAt),
      )
    }
    const current = db.prepare(`
      SELECT version FROM lumi_cognitive_working_memory
      WHERE person_id = ? AND persona_id = ? AND conversation_id = ?
    `).get(input.identity.actorId, input.identity.personaId, input.identity.conversationId)
    db.prepare(`
      INSERT INTO lumi_cognitive_working_memory (
        person_id, persona_id, conversation_id, conversation_type,
        version, payload_json, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(person_id, persona_id, conversation_id) DO UPDATE SET
        conversation_type = excluded.conversation_type,
        version = excluded.version,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).run(
      input.identity.actorId,
      input.identity.personaId,
      input.identity.conversationId,
      input.identity.conversationType,
      Number(current?.version ?? 0) + 1,
      JSON.stringify(input.workingMemory),
      input.workingMemory.updatedAt,
      input.workingMemory.expiresAt,
    )
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function recordContextUse(db: SqliteDatabase, input: ElectronLumiCognitiveRecordUseRequest): void {
  assertIdentity(input.identity)
  const usedAt = isoTimestamp(input.usedAt, 'usedAt')
  const memoryIds = uniqueStrings(input.memoryIds, 100)
  const hypothesisIds = uniqueStrings(input.hypothesisIds, 100)
  db.exec('BEGIN IMMEDIATE')
  try {
    const updateMemory = db.prepare(`
      UPDATE lumi_memories SET last_used_at = ?, use_count = use_count + 1
      WHERE id = ? AND status = 'active'
        AND (user_id = ? OR scope IN ('global', 'shared'))
        AND superseded_by_id IS NULL
    `)
    for (const memoryId of memoryIds)
      updateMemory.run(usedAt, memoryId, input.identity.actorId)
    const updateBelief = db.prepare(`
      UPDATE lumi_cognitive_beliefs SET updated_at = ?
      WHERE id = ? AND subject_id = ? AND status IN ('tentative', 'supported', 'stable')
    `)
    for (const hypothesisId of hypothesisIds)
      updateBelief.run(usedAt, hypothesisId, input.identity.actorId)
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function addColumnIfMissing(
  db: SqliteDatabase,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!columns.some(item => item.name === column))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

function assertIdentity(identity: LumiCognitiveIdentity): void {
  if (
    identity.conversationType !== 'direct'
    || !identity.actorId.trim()
    || !identity.personaId.trim()
    || !identity.conversationId.trim()
    || !identity.participantUserIds.includes(identity.actorId)
  ) {
    throw new Error('Desktop cognitive identity is invalid')
  }
}

function assertSameIdentity(left: LumiCognitiveIdentity, right: LumiCognitiveIdentity): void {
  if (
    left.actorId !== right.actorId
    || left.personaId !== right.personaId
    || left.conversationId !== right.conversationId
    || left.conversationType !== right.conversationType
    || !sameStringSet(left.participantUserIds, right.participantUserIds)
  ) {
    throw new Error('Desktop cognitive repository identity changed during one turn')
  }
}

function assertWorkingMemoryIdentity(memory: LumiWorkingMemory, identity: LumiCognitiveIdentity): void {
  if (
    memory.personId !== identity.actorId
    || memory.personaId !== identity.personaId
    || memory.conversationId !== identity.conversationId
    || memory.conversationType !== identity.conversationType
  ) {
    throw new Error('Desktop working memory belongs to another identity')
  }
}

function assertFastLoopEvidence(
  evidence: LumiCognitiveEvidence,
  identity: LumiCognitiveIdentity,
): void {
  if (
    evidence.actorId !== identity.actorId
    || evidence.conversationId !== identity.conversationId
    || evidence.conversationType !== identity.conversationType
    || evidence.origin !== 'primary'
    || !evidence.authorVerified
    || evidence.scope !== 'private'
    || evidence.sensitivity !== 'private'
    || evidence.derivedFromEvidenceIds.length > 0
    || !sameStringSet(evidence.participantUserIds, identity.participantUserIds)
  ) {
    throw new Error('Desktop cognitive evidence does not match the immutable direct identity')
  }
}

function assertFastLoopFeedback(
  feedback: LumiFeedbackEvent,
  identity: LumiCognitiveIdentity,
  evidenceId: string,
): void {
  if (
    feedback.actorId !== identity.actorId
    || feedback.conversationId !== identity.conversationId
    || feedback.conversationType !== identity.conversationType
    || feedback.evidenceId !== evidenceId
    || !feedback.authorVerified
  ) {
    throw new Error('Desktop cognitive feedback does not match its verified evidence')
  }
}

function sameEvidence(row: Record<string, unknown>, evidence: LumiCognitiveEvidence): boolean {
  return row.actor_id === evidence.actorId
    && row.conversation_id === evidence.conversationId
    && row.conversation_type === evidence.conversationType
    && row.kind === evidence.kind
    && row.origin === evidence.origin
    && row.content === evidence.content
    && row.source_id === (evidence.sourceId ?? null)
    && row.source_message_id === (evidence.sourceMessageId ?? null)
    && row.occurred_at === evidence.occurredAt
    && Number(row.author_verified) === 1
    && row.scope === evidence.scope
    && row.sensitivity === evidence.sensitivity
    && sameStringSet(jsonStringArray(row.subject_user_ids_json), evidence.subjectUserIds)
    && sameStringSet(jsonStringArray(row.participant_user_ids_json), evidence.participantUserIds)
}

function jsonStringArray(value: unknown): string[] {
  if (typeof value !== 'string')
    return []
  const parsed: unknown = JSON.parse(value)
  return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : []
}

function uniqueStrings(values: readonly string[], maximum: number): string[] {
  if (values.length > maximum)
    throw new Error(`Cognitive identifier list exceeds ${maximum} records`)
  const normalized = values.map(value => value.trim()).filter(Boolean)
  if (new Set(normalized).size !== normalized.length)
    throw new Error('Cognitive identifier list contains duplicates')
  return normalized
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = [...new Set(left)].sort()
  const rightSet = [...new Set(right)].sort()
  return leftSet.length === rightSet.length
    && leftSet.every((value, index) => value === rightSet[index])
}

function isoTimestamp(value: string, field: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp))
    throw new Error(`Desktop cognitive ${field} is invalid`)
  return new Date(timestamp).toISOString()
}
