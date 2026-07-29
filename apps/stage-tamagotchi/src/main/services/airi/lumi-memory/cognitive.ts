import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type {
  LumiBeliefHypothesis,
  LumiCognitiveEvidence,
  LumiCognitiveIdentity,
  LumiCognitiveProfileProjection,
  LumiCognitiveProjectionState,
  LumiConversationEpisode,
  LumiFeedbackEvent,
  LumiMemoryFragment,
  LumiWorkingMemory,
  SocialLanguageSnapshot,
} from '@proj-airi/lumi-runtime'

import type {
  ElectronLumiCognitiveArchive,
  ElectronLumiCognitiveConsolidateEpisodeRequest,
  ElectronLumiCognitivePrepareTurnRequest,
  ElectronLumiCognitiveRecordUseRequest,
} from '../../../../shared/eventa'
import type { LegacyDesktopCognitiveSources } from './cognitiveMigration'
import type { SqliteDatabase } from './index'

import { defineInvokeHandler } from '@moeru/eventa'
import {
  createLumiConversationEpisode,
  deriveLumiMemoryCognitiveObservation,
  maintainLumiCognitiveState,
  observeLumiBeliefHypothesis,
  prepareLumiCognitiveTurn,
  projectLumiBeliefsToProfile,
  selectPlannerSocialBehaviors,
} from '@proj-airi/lumi-runtime'

import {
  electronLumiCognitiveConsolidateEpisode,
  electronLumiCognitivePrepareTurn,
  electronLumiCognitiveRecordUse,
} from '../../../../shared/eventa'
import { migrateLegacyDesktopCognition } from './cognitiveMigration'

/** Main-process dependencies kept outside the renderer cognitive projection. */
export interface LumiDesktopCognitiveServiceOptions extends LegacyDesktopCognitiveSources {
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
  /** Existing canonical memory writer used inside the cognitive transaction. */
  persistMemory: (db: SqliteDatabase, memory: LumiMemoryFragment) => void
  /** Optional vector-index synchronization scheduled after the transaction. */
  onMemoryPersisted?: (memory: LumiMemoryFragment) => void
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
  defineInvokeHandler(options.context, electronLumiCognitiveConsolidateEpisode, async (request) => {
    const { db } = await options.getDatabase()
    const episode = consolidateDesktopConversationEpisode(db, request, options.persistMemory)
    options.onMemoryPersisted?.(episode.memory)
  })
}

/**
 * Persists one desktop context checkpoint with private evidence lineage.
 *
 * Use when:
 * - The Electron main process accepts Agent Runtime's idle compaction result
 *
 * Expects:
 * - The caller supplies the canonical memory writer for the shared database
 * - Source evidence was already committed by the cognitive fast loop
 *
 * Returns:
 * - The idempotently persisted evidence and episodic memory
 */
export function consolidateDesktopConversationEpisode(
  db: SqliteDatabase,
  input: ElectronLumiCognitiveConsolidateEpisodeRequest,
  persistMemory: (db: SqliteDatabase, memory: LumiMemoryFragment) => void,
): LumiConversationEpisode {
  ensureCognitiveSchema(db)
  assertIdentity(input.identity)
  const sourceMessageIds = uniqueStrings(input.sourceMessageIds, 500)
  if (sourceMessageIds.length === 0)
    throw new Error('Desktop cognitive episode has no source messages')
  const placeholders = sourceMessageIds.map(() => '?').join(', ')
  const primaryEvidence = db.prepare(`
    SELECT * FROM lumi_cognitive_evidence
    WHERE actor_id = ? AND conversation_id = ?
      AND origin = 'primary' AND author_verified = 1
      AND source_message_id IN (${placeholders})
    ORDER BY occurred_at ASC, id ASC
  `).all(
    input.identity.actorId,
    input.identity.conversationId,
    ...sourceMessageIds,
  ).flatMap(rowToEvidence)
  const episode = createLumiConversationEpisode({
    ...input,
    sourceMessageIds,
    primaryEvidence,
  })

  db.exec('BEGIN IMMEDIATE')
  try {
    const existingEvidence = db.prepare(
      'SELECT * FROM lumi_cognitive_evidence WHERE id = ?',
    ).get(episode.evidence.id)
    if (existingEvidence) {
      if (!sameEvidence(existingEvidence, episode.evidence))
        throw new Error('Desktop cognitive episode evidence id was reused for different content')
    }
    else {
      writeEvidence(db, episode.evidence)
    }
    const existingMemory = db.prepare(
      'SELECT id, user_id FROM lumi_memories WHERE id = ?',
    ).get(episode.memory.id)
    if (existingMemory) {
      if (existingMemory.user_id !== episode.memory.userId)
        throw new Error('Desktop cognitive episode memory belongs to another actor')
    }
    else {
      persistMemory(db, episode.memory)
    }
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return episode
}

/** Result of consolidating one model-curated memory through primary evidence. */
export interface LumiMemoryCognitiveConsolidationResult {
  /** Whether a hypothesis was updated. */
  consolidated: boolean
  /** Stable reason when no update was allowed. */
  reason?: 'inactive_memory' | 'missing_source_evidence' | 'unsupported_memory_type' | 'missing_semantic_tag' | 'invalid_source_evidence'
  /** Updated hypothesis identifier. */
  beliefId?: string
  /** Materialized profile projection identifiers. */
  projectionIds: string[]
  /** Long-term memories invalidated by an explicit correction. */
  supersededMemoryIds: string[]
}

/** Privacy-safe counts produced by one desktop cognitive maintenance pass. */
export interface LumiDesktopCognitiveMaintenanceReport {
  /** Number of immutable actors whose beliefs were examined. */
  actorCount: number
  /** Number of beliefs processed after actor filtering. */
  beliefCount: number
  /** Number of beliefs that expired during this pass. */
  expiredCount: number
  /** Number of beliefs downgraded by deterministic decay. */
  downgradedCount: number
  /** Number of fresh profile projections materialized. */
  projectionCount: number
  /** Number of expired conversation working-memory rows removed. */
  expiredWorkingMemoryCount: number
  /** ISO timestamp used consistently by the pass. */
  completedAt: string
}

/**
 * Runs deterministic desktop cognitive maintenance outside the reply path.
 *
 * Use when:
 * - The Electron main process starts its daily background maintenance pass
 * - An administrator repairs one immutable actor after importing an archive
 *
 * Expects:
 * - Existing cognitive rows have already passed ingress identity validation
 * - `actorId`, when supplied, is one immutable internal Person identifier
 *
 * Returns:
 * - Privacy-safe counts without evidence, memory, or profile content
 */
export function runDesktopCognitiveMaintenance(
  db: SqliteDatabase,
  input: {
    actorId?: string
    now?: string
  } = {},
): LumiDesktopCognitiveMaintenanceReport {
  ensureCognitiveSchema(db)
  const completedAt = isoTimestamp(input.now ?? new Date().toISOString(), 'cognitive maintenance now')
  const actorId = input.actorId?.trim()
  if (input.actorId !== undefined && !actorId)
    throw new Error('Desktop cognitive maintenance actor is invalid')
  const actorIds = actorId
    ? [actorId]
    : db.prepare(`
        SELECT DISTINCT subject_id FROM lumi_cognitive_beliefs ORDER BY subject_id
      `).all().map(row => stringValue(row.subject_id)).filter(Boolean)
  let beliefCount = 0
  let expiredCount = 0
  let downgradedCount = 0
  let projectionCount = 0
  let expiredWorkingMemoryCount = 0

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const subjectId of actorIds) {
      const sourceBeliefs = db.prepare(`
        SELECT payload_json FROM lumi_cognitive_beliefs
        WHERE subject_id = ? ORDER BY id
      `).all(subjectId).flatMap(row => parsedPayload<LumiBeliefHypothesis>(row.payload_json))
      const evidenceIds = [...new Set(sourceBeliefs.flatMap(belief => [
        ...belief.evidenceIds,
        ...belief.counterEvidenceIds,
      ]))]
      const evidenceById = new Map(
        (evidenceIds.length === 0
          ? []
          : db.prepare(`
              SELECT * FROM lumi_cognitive_evidence
              WHERE id IN (${evidenceIds.map(() => '?').join(', ')})
            `).all(...evidenceIds).flatMap(rowToEvidence))
          .map(evidence => [evidence.id, evidence] as const),
      )
      const maintained = maintainLumiCognitiveState({
        subjectId,
        beliefs: sourceBeliefs,
        evidenceById,
        now: completedAt,
      })
      beliefCount += maintained.beliefs.length
      expiredCount += maintained.expiredCount
      downgradedCount += maintained.downgradedCount
      for (const belief of maintained.beliefs)
        writeBelief(db, belief)

      db.prepare(`
        UPDATE lumi_cognitive_profile_projections SET
          status = 'pending',
          payload_json = json_set(payload_json, '$.status', 'pending'),
          updated_at = ?
        WHERE subject_id = ? AND status = 'active'
      `).run(completedAt, subjectId)
      for (const projection of maintained.projections) {
        if (projection.scope === 'group')
          continue
        writeProfileProjection(db, projection)
        projectionCount += 1
      }
    }

    const expiredRows = actorId
      ? Number(db.prepare(`
          SELECT COUNT(*) AS count FROM lumi_cognitive_working_memory
          WHERE person_id = ? AND expires_at <= ?
        `).get(actorId, completedAt)?.count ?? 0)
      : Number(db.prepare(`
          SELECT COUNT(*) AS count FROM lumi_cognitive_working_memory
          WHERE expires_at <= ?
        `).get(completedAt)?.count ?? 0)
    if (actorId) {
      db.prepare(`
        DELETE FROM lumi_cognitive_working_memory
        WHERE person_id = ? AND expires_at <= ?
      `).run(actorId, completedAt)
    }
    else {
      db.prepare(`
        DELETE FROM lumi_cognitive_working_memory WHERE expires_at <= ?
      `).run(completedAt)
    }
    expiredWorkingMemoryCount = expiredRows
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return {
    actorCount: actorIds.length,
    beliefCount,
    expiredCount,
    downgradedCount,
    projectionCount,
    expiredWorkingMemoryCount,
    completedAt,
  }
}

/**
 * Consolidates one curated long-term memory into evidence-backed cognition.
 *
 * Use when:
 * - The main process has durably upserted an auto-curated memory
 * - Cognitive fast-loop evidence for the same source message already exists
 *
 * Expects:
 * - The memory has passed the existing host scope/classification validator
 * - `sourceMessageId` and `userId` identify the immutable message actor
 *
 * Returns:
 * - The belief/profile lineage written, or a stable skip reason
 */
export function consolidateMemoryIntoCognition(
  db: SqliteDatabase,
  memory: LumiMemoryFragment,
): LumiMemoryCognitiveConsolidationResult {
  ensureCognitiveSchema(db)
  const sourceEvidence = sourceEvidenceForMemory(db, memory)
  if (!sourceEvidence) {
    return {
      consolidated: false,
      reason: 'missing_source_evidence',
      projectionIds: [],
      supersededMemoryIds: [],
    }
  }
  const derived = deriveLumiMemoryCognitiveObservation(memory, sourceEvidence)
  if (!derived.supported) {
    return {
      consolidated: false,
      reason: derived.reason,
      projectionIds: [],
      supersededMemoryIds: [],
    }
  }
  const correction = sourceEvidence.kind === 'user_correction'
  if (memory.status !== 'active' && !correction) {
    linkMemoryEvidence(db, memory, sourceEvidence)
    return {
      consolidated: false,
      reason: 'inactive_memory',
      projectionIds: [],
      supersededMemoryIds: [],
    }
  }

  const existing = db.prepare(`
    SELECT payload_json FROM lumi_cognitive_beliefs
    WHERE subject_id = ? AND status != 'expired'
    ORDER BY updated_at DESC
    LIMIT 500
  `).all(memory.userId).flatMap(row => parsedPayload<LumiBeliefHypothesis>(row.payload_json)).find(item => item.predicate === derived.observation.predicate)
  const belief = observeLumiBeliefHypothesis(existing, derived.observation)
  const supersededMemoryIds = correction
    ? supersedeMemoriesFromOldBelief(db, memory, existing, sourceEvidence.occurredAt)
    : []
  linkMemoryEvidence(db, {
    ...memory,
    status: correction ? 'active' : memory.status,
    supersedesId: supersededMemoryIds[0],
  }, sourceEvidence)

  db.prepare(`
    INSERT INTO lumi_cognitive_beliefs (
      id, subject_id, conversation_id, status, payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      status = excluded.status,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(
    belief.id,
    belief.subjectId,
    belief.conversationId ?? null,
    belief.status,
    JSON.stringify(belief),
    belief.lastObservedAt,
  )

  const evidenceById = new Map(
    db.prepare(`
      SELECT * FROM lumi_cognitive_evidence
      WHERE id IN (${belief.evidenceIds.map(() => '?').join(', ')})
    `).all(...belief.evidenceIds).flatMap(rowToEvidence).map(item => [item.id, item] as const),
  )
  const projections = projectLumiBeliefsToProfile({
    subjectId: belief.subjectId,
    beliefs: [belief],
    evidenceById,
    now: sourceEvidence.occurredAt,
  })
  retireBeliefProjections(db, belief.id, sourceEvidence.occurredAt)
  const upsertProjection = db.prepare(`
    INSERT INTO lumi_cognitive_profile_projections (
      id, subject_id, layer, status, payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      layer = excluded.layer,
      status = excluded.status,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `)
  for (const projection of projections) {
    upsertProjection.run(
      projection.id,
      projection.subjectId,
      projection.layer,
      projection.status,
      JSON.stringify(projection),
      projection.updatedAt,
    )
  }
  return {
    consolidated: true,
    beliefId: belief.id,
    projectionIds: projections.map(item => item.id),
    supersededMemoryIds,
  }
}

/**
 * Deletes one actor's private cognitive state without touching other people or Lumi-owned data.
 *
 * Use when:
 * - A user invokes the memory clear or account-deletion flow
 *
 * Expects:
 * - `actorId` is the immutable internal Person identifier
 *
 * Returns:
 * - Nothing after actor-scoped cognitive rows are removed
 */
export function deleteCognitiveActorData(db: SqliteDatabase, actorId: string): void {
  const normalizedActorId = actorId.trim()
  if (!normalizedActorId)
    throw new Error('Cognitive actor deletion requires an actor id')
  ensureCognitiveSchema(db)
  deleteCognitiveActorRows(db, normalizedActorId)
  markLegacyCognitiveMigration(db, normalizedActorId, { cleared: true })
}

/** Exports one actor's cognitive rows without loading them during normal renderer startup. */
export function exportCognitiveActorData(
  db: SqliteDatabase,
  actorId: string,
): ElectronLumiCognitiveArchive {
  const normalizedActorId = actorId.trim()
  if (!normalizedActorId)
    throw new Error('Cognitive actor export requires an actor id')
  ensureCognitiveSchema(db)
  return {
    version: 1,
    evidence: db.prepare(`
      SELECT * FROM lumi_cognitive_evidence WHERE actor_id = ? ORDER BY occurred_at, id
    `).all(normalizedActorId),
    workingMemory: db.prepare(`
      SELECT * FROM lumi_cognitive_working_memory WHERE person_id = ? ORDER BY conversation_id
    `).all(normalizedActorId),
    feedback: db.prepare(`
      SELECT * FROM lumi_cognitive_feedback WHERE actor_id = ? ORDER BY occurred_at, id
    `).all(normalizedActorId),
    beliefs: db.prepare(`
      SELECT * FROM lumi_cognitive_beliefs WHERE subject_id = ? ORDER BY updated_at, id
    `).all(normalizedActorId),
    profileProjections: db.prepare(`
      SELECT * FROM lumi_cognitive_profile_projections WHERE subject_id = ? ORDER BY updated_at, id
    `).all(normalizedActorId),
  }
}

/**
 * Restores a validated actor-scoped cognitive archive transactionally.
 *
 * Use when:
 * - A user explicitly imports a full Lumi memory archive
 *
 * Expects:
 * - Every row belongs to `actorId`
 * - Belief and profile lineage is complete inside the archive
 *
 * Returns:
 * - Nothing after replacing only that actor's cognitive rows
 */
export function importCognitiveActorData(
  db: SqliteDatabase,
  actorId: string,
  archive: ElectronLumiCognitiveArchive,
): void {
  const normalizedActorId = actorId.trim()
  if (!normalizedActorId || archive.version !== 1)
    throw new Error('Unsupported cognitive actor archive')
  ensureCognitiveSchema(db)
  const evidence = archive.evidence.flatMap(rowToEvidence)
  const workingMemory = archive.workingMemory.flatMap(row => parsedPayload<LumiWorkingMemory>(row.payload_json))
  const feedback = archive.feedback.flatMap(rowToFeedback)
  const beliefs = archive.beliefs.flatMap(row => parsedPayload<LumiBeliefHypothesis>(row.payload_json))
  const projections = archive.profileProjections.flatMap(row => parsedPayload<LumiCognitiveProfileProjection>(row.payload_json))
  if (
    evidence.length !== archive.evidence.length
    || workingMemory.length !== archive.workingMemory.length
    || feedback.length !== archive.feedback.length
    || beliefs.length !== archive.beliefs.length
    || projections.length !== archive.profileProjections.length
  ) {
    throw new Error('Cognitive actor archive contains invalid rows')
  }
  const evidenceIds = new Set(evidence.map(item => item.id))
  const beliefIds = new Set(beliefs.map(item => item.id))
  if (
    evidence.some(item => item.actorId !== normalizedActorId || !item.subjectUserIds.includes(normalizedActorId))
    || workingMemory.some(item => item.personId !== normalizedActorId)
    || feedback.some(item => item.actorId !== normalizedActorId || !evidenceIds.has(item.evidenceId))
    || beliefs.some(item =>
      item.subjectId !== normalizedActorId
      || [...item.evidenceIds, ...item.counterEvidenceIds].some(id => !evidenceIds.has(id)))
    || projections.some(item =>
      item.subjectId !== normalizedActorId
      || item.evidenceIds.some(id => !evidenceIds.has(id))
      || item.beliefIds.some(id => !beliefIds.has(id)))
  ) {
    throw new Error('Cognitive actor archive violates actor or lineage boundaries')
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    deleteCognitiveActorRows(db, normalizedActorId)
    for (const item of evidence)
      writeEvidence(db, item)
    for (const item of workingMemory)
      writeWorkingMemory(db, item)
    for (const item of feedback)
      writeFeedback(db, item)
    for (const item of beliefs)
      writeBelief(db, item)
    for (const item of projections)
      writeProfileProjection(db, item)
    markLegacyCognitiveMigration(db, normalizedActorId, { imported: true })
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function deleteCognitiveActorRows(db: SqliteDatabase, actorId: string): void {
  db.prepare('DELETE FROM lumi_cognitive_profile_projections WHERE subject_id = ?').run(actorId)
  db.prepare('DELETE FROM lumi_cognitive_beliefs WHERE subject_id = ?').run(actorId)
  db.prepare('DELETE FROM lumi_cognitive_feedback WHERE actor_id = ?').run(actorId)
  db.prepare('DELETE FROM lumi_cognitive_working_memory WHERE person_id = ?').run(actorId)
  db.prepare('DELETE FROM lumi_cognitive_evidence WHERE actor_id = ?').run(actorId)
  db.prepare(`
    DELETE FROM lumi_cognitive_migrations
    WHERE source_kind = 'legacy_desktop_cognition' AND id = ?
  `).run(`cognitive-v1-legacy-projections:${actorId}`)
}

function markLegacyCognitiveMigration(
  db: SqliteDatabase,
  actorId: string,
  report: Record<string, unknown>,
): void {
  const now = Date.now()
  db.prepare(`
    INSERT INTO lumi_cognitive_migrations (
      id, source_kind, phase, report_json, created_at, updated_at
    ) VALUES (?, 'legacy_desktop_cognition', 'active', ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      phase = 'active',
      report_json = excluded.report_json,
      updated_at = excluded.updated_at
  `).run(
    `cognitive-v1-legacy-projections:${actorId}`,
    JSON.stringify(report),
    now,
    now,
  )
}

async function desktopRepository(
  options: LumiDesktopCognitiveServiceOptions,
  request: ElectronLumiCognitivePrepareTurnRequest,
) {
  const { db } = await options.getDatabase()
  ensureCognitiveSchema(db)
  assertIdentity(request.identity)
  try {
    await migrateLegacyDesktopCognition(db, request.identity, options)
  }
  catch (error) {
    console.warn('[lumi-cognitive] legacy projection migration failed; continuing without legacy projections', error)
  }
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
      const projection = loadProjectionState(db, identity)
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
        ...projection,
        interactionStrategies: [
          ...behaviors.map(item => item.behavior.action),
          ...jargon.map(item => `按语境理解“${item.term}”：${item.meanings[0]?.meaning ?? item.pragmaticFunctions.join('、')}`),
        ],
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

function loadProjectionState(
  db: SqliteDatabase,
  identity: LumiCognitiveIdentity,
): LumiCognitiveProjectionState {
  const now = Date.now()
  const hypotheses = db.prepare(`
    SELECT payload_json FROM lumi_cognitive_beliefs
    WHERE subject_id = ? AND status IN ('tentative', 'supported', 'stable')
    ORDER BY updated_at DESC
    LIMIT 100
  `).all(identity.actorId).flatMap(row => parsedPayload<LumiBeliefHypothesis>(row.payload_json)).filter(item => !item.expiresAt || Date.parse(item.expiresAt) > now)
  const profile = db.prepare(`
    SELECT payload_json FROM lumi_cognitive_profile_projections
    WHERE subject_id = ? AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 100
  `).all(identity.actorId).flatMap(row => parsedPayload<LumiCognitiveProfileProjection>(row.payload_json)).filter(item => !item.expiresAt || Date.parse(item.expiresAt) > now)
  const evidenceIds = [...new Set(hypotheses.flatMap(item => item.evidenceIds))]
  const evidence = evidenceIds.length > 0
    ? db.prepare(`
        SELECT * FROM lumi_cognitive_evidence
        WHERE id IN (${evidenceIds.map(() => '?').join(', ')})
      `).all(...evidenceIds).flatMap(rowToEvidence)
    : []
  const contradictions = db.prepare(`
    SELECT payload_json FROM lumi_cognitive_beliefs
    WHERE subject_id = ? AND status = 'contradicted'
    ORDER BY updated_at DESC
    LIMIT 10
  `).all(identity.actorId).flatMap(row => parsedPayload<LumiBeliefHypothesis>(row.payload_json)).map(item => `${item.predicate} 存在已记录反证，不能作为当前事实。`)

  return {
    evidence,
    hypotheses,
    profile,
    interactionStrategies: [],
    expressionAssets: [],
    contradictions,
  }
}

function rowToEvidence(row: Record<string, unknown>): LumiCognitiveEvidence[] {
  const kind = cognitiveEvidenceKind(row.kind)
  const origin = cognitiveEvidenceOrigin(row.origin)
  const conversationType = cognitiveConversationType(row.conversation_type)
  const scope = cognitiveScope(row.scope)
  const sensitivity = row.sensitivity === 'private' ? 'private' : 'normal'
  if (!kind || !origin || !conversationType || !scope)
    return []
  return [{
    id: stringValue(row.id),
    actorId: stringValue(row.actor_id),
    subjectUserIds: jsonStringArray(row.subject_user_ids_json),
    conversationId: stringValue(row.conversation_id) || undefined,
    conversationType,
    kind,
    origin,
    content: stringValue(row.content),
    sourceId: stringValue(row.source_id) || undefined,
    sourceMessageId: stringValue(row.source_message_id) || undefined,
    occurredAt: stringValue(row.occurred_at),
    trust: finiteNumber(row.trust),
    authorVerified: Number(row.author_verified) === 1,
    scope,
    sensitivity,
    participantUserIds: jsonStringArray(row.participant_user_ids_json),
    derivedFromEvidenceIds: jsonStringArray(row.derived_from_evidence_ids_json),
    derivationReason: stringValue(row.derivation_reason) || undefined,
    schemaVersion: 1,
  }]
}

function rowToFeedback(row: Record<string, unknown>): LumiFeedbackEvent[] {
  const kind = cognitiveFeedbackKind(row.kind)
  const conversationType = cognitiveConversationType(row.conversation_type)
  const scope = cognitiveScope(row.scope)
  if (!kind || !conversationType || !scope)
    return []
  return [{
    id: stringValue(row.id),
    actorId: stringValue(row.actor_id),
    conversationId: stringValue(row.conversation_id),
    conversationType,
    kind,
    sourceId: stringValue(row.source_id),
    evidenceId: stringValue(row.evidence_id),
    targetIds: jsonStringArray(row.target_ids_json),
    strength: finiteNumber(row.strength),
    occurredAt: stringValue(row.occurred_at),
    authorVerified: Number(row.author_verified) === 1,
    scope,
    sensitivity: row.sensitivity === 'private' ? 'private' : 'normal',
  }]
}

function writeEvidence(db: SqliteDatabase, evidence: LumiCognitiveEvidence): void {
  db.prepare(`
    INSERT INTO lumi_cognitive_evidence (
      id, actor_id, conversation_id, conversation_type, kind, origin,
      content, source_id, source_message_id, subject_user_ids_json,
      participant_user_ids_json, derived_from_evidence_ids_json,
      occurred_at, trust, author_verified, scope, sensitivity,
      derivation_reason, schema_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    evidence.id,
    evidence.actorId,
    evidence.conversationId ?? '',
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
}

function writeWorkingMemory(db: SqliteDatabase, memory: LumiWorkingMemory): void {
  db.prepare(`
    INSERT INTO lumi_cognitive_working_memory (
      person_id, persona_id, conversation_id, conversation_type,
      version, payload_json, updated_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    memory.personId,
    memory.personaId,
    memory.conversationId,
    memory.conversationType,
    memory.version,
    JSON.stringify(memory),
    memory.updatedAt,
    memory.expiresAt,
  )
}

function writeFeedback(db: SqliteDatabase, feedback: LumiFeedbackEvent): void {
  db.prepare(`
    INSERT INTO lumi_cognitive_feedback (
      id, actor_id, conversation_id, conversation_type, kind, source_id,
      evidence_id, target_ids_json, strength, occurred_at, author_verified,
      scope, sensitivity, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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

function writeBelief(db: SqliteDatabase, belief: LumiBeliefHypothesis): void {
  db.prepare(`
    INSERT INTO lumi_cognitive_beliefs (
      id, subject_id, conversation_id, status, payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      subject_id = excluded.subject_id,
      conversation_id = excluded.conversation_id,
      status = excluded.status,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(
    belief.id,
    belief.subjectId,
    belief.conversationId ?? null,
    belief.status,
    JSON.stringify(belief),
    belief.lastObservedAt,
  )
}

function writeProfileProjection(db: SqliteDatabase, projection: LumiCognitiveProfileProjection): void {
  db.prepare(`
    INSERT INTO lumi_cognitive_profile_projections (
      id, subject_id, layer, status, payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      subject_id = excluded.subject_id,
      layer = excluded.layer,
      status = excluded.status,
      payload_json = excluded.payload_json,
      updated_at = excluded.updated_at
  `).run(
    projection.id,
    projection.subjectId,
    projection.layer,
    projection.status,
    JSON.stringify(projection),
    projection.updatedAt,
  )
}

function parsedPayload<T>(value: unknown): T[] {
  if (typeof value !== 'string')
    return []
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? [parsed as T] : []
  }
  catch {
    return []
  }
}

function cognitiveEvidenceKind(value: unknown): LumiCognitiveEvidence['kind'] | undefined {
  switch (value) {
    case 'user_statement':
    case 'user_correction':
    case 'observed_behavior':
    case 'tool_result':
    case 'screen_observation':
    case 'lumi_action':
    case 'user_feedback':
    case 'relationship_event':
    case 'conversation_episode':
    case 'legacy_import':
      return value
    default:
      return undefined
  }
}

function cognitiveEvidenceOrigin(value: unknown): LumiCognitiveEvidence['origin'] | undefined {
  return value === 'primary' || value === 'derived' || value === 'legacy_import'
    ? value
    : undefined
}

function cognitiveFeedbackKind(value: unknown): LumiFeedbackEvent['kind'] | undefined {
  switch (value) {
    case 'explicit_praise':
    case 'explicit_rejection':
    case 'fact_correction':
    case 'expression_natural':
    case 'expression_ai_like':
    case 'expression_repeated':
    case 'topic_continued':
    case 'topic_switched':
    case 'tool_succeeded':
    case 'tool_failed':
    case 'decision_confirmed':
    case 'decision_revoked':
      return value
    default:
      return undefined
  }
}

function cognitiveConversationType(value: unknown): LumiCognitiveEvidence['conversationType'] | undefined {
  return value === 'direct' || value === 'group' || value === 'internal'
    ? value
    : undefined
}

function cognitiveScope(value: unknown): LumiCognitiveEvidence['scope'] | undefined {
  return value === 'global'
    || value === 'shared'
    || value === 'relationship'
    || value === 'group'
    || value === 'private'
    ? value
    : undefined
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function sourceEvidenceForMemory(
  db: SqliteDatabase,
  memory: LumiMemoryFragment,
): LumiCognitiveEvidence | undefined {
  if (!memory.sourceMessageId?.trim() || !memory.userId.trim())
    return undefined
  return db.prepare(`
    SELECT * FROM lumi_cognitive_evidence
    WHERE actor_id = ? AND source_message_id = ? AND origin = 'primary'
    ORDER BY occurred_at DESC
    LIMIT 1
  `).all(memory.userId, memory.sourceMessageId).flatMap(rowToEvidence).find(evidence =>
    evidence.subjectUserIds.includes(memory.userId)
    && (!memory.conversationId || evidence.conversationId === memory.conversationId),
  )
}

function linkMemoryEvidence(
  db: SqliteDatabase,
  memory: LumiMemoryFragment,
  evidence: LumiCognitiveEvidence,
): void {
  db.prepare(`
    UPDATE lumi_memories SET
      derived_from_evidence_ids_json = ?,
      valid_from = COALESCE(valid_from, ?),
      last_confirmed_at = ?,
      supersedes_id = COALESCE(?, supersedes_id),
      status = ?,
      evidence_origin = 'derived',
      updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    JSON.stringify([evidence.id]),
    evidence.occurredAt,
    evidence.occurredAt,
    memory.supersedesId ?? null,
    memory.status,
    evidence.occurredAt,
    memory.id,
    memory.userId,
  )
}

function supersedeMemoriesFromOldBelief(
  db: SqliteDatabase,
  memory: LumiMemoryFragment,
  existing: LumiBeliefHypothesis | undefined,
  correctedAt: string,
): string[] {
  if (!existing?.evidenceIds.length)
    return []
  const placeholders = existing.evidenceIds.map(() => '?').join(', ')
  const oldIds = db.prepare(`
    SELECT DISTINCT memory.id FROM lumi_memories memory,
      json_each(memory.derived_from_evidence_ids_json) lineage
    WHERE memory.user_id = ?
      AND memory.id != ?
      AND memory.status = 'active'
      AND lineage.value IN (${placeholders})
  `).all(memory.userId, memory.id, ...existing.evidenceIds).map(row => stringValue(row.id)).filter(Boolean)
  const supersede = db.prepare(`
    UPDATE lumi_memories SET
      status = 'contradicted',
      valid_until = ?,
      superseded_by_id = ?,
      updated_at = ?
    WHERE id = ? AND user_id = ? AND status = 'active'
  `)
  for (const id of oldIds)
    supersede.run(correctedAt, memory.id, correctedAt, id, memory.userId)
  return oldIds
}

function retireBeliefProjections(db: SqliteDatabase, beliefId: string, updatedAt: string): void {
  for (const layer of ['daily', 'dynamic', 'core']) {
    db.prepare(`
      UPDATE lumi_cognitive_profile_projections SET
        status = 'pending',
        payload_json = json_set(payload_json, '$.status', 'pending'),
        updated_at = ?
      WHERE id = ? AND status = 'active'
    `).run(updatedAt, `profile:${beliefId}:${layer}`)
  }
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
    && Number(row.author_verified) === (evidence.authorVerified ? 1 : 0)
    && row.scope === evidence.scope
    && row.sensitivity === evidence.sensitivity
    && sameStringSet(jsonStringArray(row.subject_user_ids_json), evidence.subjectUserIds)
    && sameStringSet(jsonStringArray(row.participant_user_ids_json), evidence.participantUserIds)
    && sameStringSet(jsonStringArray(row.derived_from_evidence_ids_json), evidence.derivedFromEvidenceIds)
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
