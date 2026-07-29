import type {
  LumiBeliefHypothesis,
  LumiCognitiveEvidence,
  LumiCognitiveIdentity,
  LumiCognitiveProfileLayer,
  LumiCognitiveProfileProjection,
  LumiWorkingMemory,
  LumiWorkingMemoryItem,
} from '@proj-airi/lumi-runtime'

import type { SqliteDatabase } from './index'

/** Legacy desktop sources consumed by the additive cognitive migration. */
export interface LegacyDesktopCognitiveSources {
  /** Loads the old per-user profile projection without changing it. */
  loadLegacyProfile?: (actorId: string) => Promise<readonly Record<string, unknown>[]>
  /** Loads the old per-user short state without changing it. */
  loadLegacyCurrentState?: (actorId: string) => Promise<Record<string, unknown> | null>
}

/**
 * Copies legacy profile/current-state data into auditable cognitive projections.
 *
 * Use when:
 * - A desktop actor enters the cognitive runtime for the first time
 *
 * Expects:
 * - Cognitive tables already exist
 * - Legacy loaders are read-only and actor-scoped
 *
 * Returns:
 * - Nothing after the copy, verification, and activation marker are durable
 */
export async function migrateLegacyDesktopCognition(
  db: SqliteDatabase,
  identity: LumiCognitiveIdentity,
  sources: LegacyDesktopCognitiveSources,
): Promise<void> {
  const migrationId = `cognitive-v1-legacy-projections:${identity.actorId}`
  const current = db.prepare('SELECT phase FROM lumi_cognitive_migrations WHERE id = ?').get(migrationId)
  if (current?.phase === 'active')
    return

  const [legacyProfile, legacyCurrentState] = await Promise.all([
    sources.loadLegacyProfile?.(identity.actorId) ?? Promise.resolve([]),
    sources.loadLegacyCurrentState?.(identity.actorId) ?? Promise.resolve(null),
  ])
  const migratedProfile = legacyProfile.flatMap(entry => legacyProfileRecords(entry, identity))
  const workingMemory = legacyCurrentState
    ? legacyWorkingMemory(legacyCurrentState, identity)
    : undefined
  const currentStateEvidence = legacyCurrentState
    ? legacyStateEvidence(legacyCurrentState, identity)
    : undefined
  const copiedAt = Date.now()

  db.exec('BEGIN IMMEDIATE')
  try {
    upsertMigration(db, migrationId, 'copying', {
      profileEntries: migratedProfile.length,
      currentState: Boolean(workingMemory),
    }, copiedAt)
    for (const record of migratedProfile) {
      insertEvidence(db, record.evidence)
      db.prepare(`
        INSERT OR REPLACE INTO lumi_cognitive_beliefs (
          id, subject_id, conversation_id, status, payload_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        record.belief.id,
        record.belief.subjectId,
        record.belief.conversationId ?? null,
        record.belief.status,
        JSON.stringify(record.belief),
        record.belief.lastObservedAt,
      )
      db.prepare(`
        INSERT OR REPLACE INTO lumi_cognitive_profile_projections (
          id, subject_id, layer, status, payload_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        record.projection.id,
        record.projection.subjectId,
        record.projection.layer,
        record.projection.status,
        JSON.stringify(record.projection),
        record.projection.updatedAt,
      )
    }
    if (workingMemory && currentStateEvidence) {
      insertEvidence(db, currentStateEvidence)
      const existing = db.prepare(`
        SELECT person_id FROM lumi_cognitive_working_memory
        WHERE person_id = ? AND persona_id = ? AND conversation_id = ?
      `).get(identity.actorId, identity.personaId, identity.conversationId)
      if (!existing) {
        db.prepare(`
          INSERT INTO lumi_cognitive_working_memory (
            person_id, persona_id, conversation_id, conversation_type,
            version, payload_json, updated_at, expires_at
          ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        `).run(
          identity.actorId,
          identity.personaId,
          identity.conversationId,
          identity.conversationType,
          JSON.stringify(workingMemory),
          workingMemory.updatedAt,
          workingMemory.expiresAt,
        )
      }
    }
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  const profileCount = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM lumi_cognitive_profile_projections
    WHERE subject_id = ? AND id LIKE 'profile:legacy:%'
  `).get(identity.actorId)?.count ?? 0)
  const evidenceCount = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM lumi_cognitive_evidence
    WHERE actor_id = ? AND origin = 'legacy_import'
  `).get(identity.actorId)?.count ?? 0)
  if (profileCount < migratedProfile.length || evidenceCount < migratedProfile.length)
    throw new Error('Desktop legacy cognitive migration verification failed')

  db.exec('BEGIN IMMEDIATE')
  try {
    upsertMigration(db, migrationId, 'verified', {
      profileEntries: migratedProfile.length,
      profileCount,
      evidenceCount,
      currentState: Boolean(workingMemory),
    }, copiedAt)
    upsertMigration(db, migrationId, 'active', {
      profileEntries: migratedProfile.length,
      profileCount,
      evidenceCount,
      currentState: Boolean(workingMemory),
    }, copiedAt)
    db.exec('COMMIT')
  }
  catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function legacyProfileRecords(
  entry: Record<string, unknown>,
  identity: LumiCognitiveIdentity,
): Array<{
  evidence: LumiCognitiveEvidence
  belief: LumiBeliefHypothesis
  projection: LumiCognitiveProfileProjection
}> {
  const entryId = text(entry.id)
  const key = text(entry.key)
  const value = printable(entry.value)
  const layer = profileLayer(entry.layer)
  const status = text(entry.status, 'active')
  if (!entryId || !key || !value || status !== 'active')
    return []
  const updatedAt = timestamp(entry.updatedAt)
  const createdAt = timestamp(entry.createdAt, updatedAt)
  const expiresAt = optionalTimestamp(entry.expiresAt)
  if (expiresAt && Date.parse(expiresAt) <= Date.now())
    return []
  const confidence = Math.min(0.55, number(entry.confidence, 0.4))
  const evidenceId = `evidence:legacy:profile:${identity.actorId}:${entryId}`
  const beliefId = `belief:legacy:profile:${identity.actorId}:${entryId}`
  const projectionId = `profile:legacy:${identity.actorId}:${entryId}`
  const evidence: LumiCognitiveEvidence = {
    id: evidenceId,
    actorId: identity.actorId,
    subjectUserIds: [identity.actorId],
    conversationType: 'internal',
    kind: 'legacy_import',
    origin: 'legacy_import',
    content: `${key}: ${value}`,
    sourceId: entryId,
    occurredAt: updatedAt,
    trust: confidence,
    authorVerified: false,
    scope: 'private',
    sensitivity: 'private',
    participantUserIds: [identity.actorId],
    derivedFromEvidenceIds: [],
    derivationReason: 'Copied from the legacy profile database without promoting it to primary evidence.',
    schemaVersion: 1,
  }
  const belief: LumiBeliefHypothesis = {
    id: beliefId,
    subjectId: identity.actorId,
    predicate: key,
    value,
    confidence,
    stability: layer === 'core' ? 0.5 : 0.35,
    evidenceIds: [evidenceId],
    counterEvidenceIds: [],
    firstObservedAt: createdAt,
    lastObservedAt: updatedAt,
    expiresAt,
    status: 'supported',
    scope: 'private',
    sensitivity: 'private',
    participantUserIds: [identity.actorId],
    evidenceCount: 1,
    independentEvidenceCount: 1,
    familiarity: 0.35,
    ownership: 0,
    positiveFeedback: 0,
    negativeFeedback: 0,
    rejectionCount: 0,
    firstSeenAt: createdAt,
    lastSeenAt: updatedAt,
    decay: layer === 'daily' ? 0.2 : 0.05,
  }
  const projection: LumiCognitiveProfileProjection = {
    id: projectionId,
    subjectId: identity.actorId,
    layer,
    key,
    value,
    beliefIds: [beliefId],
    evidenceIds: [evidenceId],
    confidence,
    stability: belief.stability,
    expiresAt,
    status: 'active',
    scope: 'private',
    sensitivity: 'private',
    updatedAt,
  }
  return [{ evidence, belief, projection }]
}

function legacyStateEvidence(
  state: Record<string, unknown>,
  identity: LumiCognitiveIdentity,
): LumiCognitiveEvidence {
  const occurredAt = timestamp(state.updatedAt)
  return {
    id: `evidence:legacy:current-state:${identity.actorId}:${stableHash(JSON.stringify(state))}`,
    actorId: identity.actorId,
    subjectUserIds: [identity.actorId],
    conversationType: 'internal',
    kind: 'legacy_import',
    origin: 'legacy_import',
    content: JSON.stringify(state),
    sourceId: 'legacy-current-state',
    occurredAt,
    trust: 0.3,
    authorVerified: false,
    scope: 'private',
    sensitivity: 'private',
    participantUserIds: [identity.actorId],
    derivedFromEvidenceIds: [],
    derivationReason: 'Copied as expiring working context; never promoted directly into profile facts.',
    schemaVersion: 1,
  }
}

function legacyWorkingMemory(
  state: Record<string, unknown>,
  identity: LumiCognitiveIdentity,
): LumiWorkingMemory {
  const evidence = legacyStateEvidence(state, identity)
  const updatedAt = timestamp(state.updatedAt)
  const expiresAt = new Date(Date.parse(updatedAt) + 24 * 60 * 60 * 1_000).toISOString()
  const sourceMessageIds = stringList(state.sourceMessageIds, 20)
  return {
    version: 1,
    personId: identity.actorId,
    personaId: identity.personaId,
    conversationId: identity.conversationId,
    conversationType: identity.conversationType,
    activeTopics: items('topic', state.recentTopics, evidence.id, sourceMessageIds, updatedAt, expiresAt),
    topicStack: [],
    entityBindings: [],
    goals: items('decision', state.recentImportantDecisions, evidence.id, sourceMessageIds, updatedAt, expiresAt),
    openLoops: items('open-loop', state.unfinishedTasks, evidence.id, sourceMessageIds, updatedAt, expiresAt),
    projects: items('project', state.activeProjects, evidence.id, sourceMessageIds, updatedAt, expiresAt),
    temporaryUserStates: items('temporary-state', state.userRecentMood, evidence.id, sourceMessageIds, updatedAt, expiresAt),
    relationshipContext: item('relationship-context', state.relationshipContext, evidence.id, sourceMessageIds, updatedAt, expiresAt),
    continuationPoint: text(state.lastContinuationPoint) || undefined,
    sourceMessageIds,
    updatedAt,
    expiresAt,
  }
}

function items(
  prefix: string,
  value: unknown,
  evidenceId: string,
  sourceMessageIds: string[],
  updatedAt: string,
  expiresAt: string,
): LumiWorkingMemoryItem[] {
  return stringList(value, 8).map((itemValue, index) => ({
    id: `working:legacy:${prefix}:${index}:${stableHash(itemValue)}`,
    value: itemValue,
    evidenceIds: [evidenceId],
    sourceMessageIds,
    updatedAt,
    expiresAt,
  }))
}

function item(
  prefix: string,
  value: unknown,
  evidenceId: string,
  sourceMessageIds: string[],
  updatedAt: string,
  expiresAt: string,
): LumiWorkingMemoryItem | undefined {
  return items(prefix, value, evidenceId, sourceMessageIds, updatedAt, expiresAt)[0]
}

function insertEvidence(db: SqliteDatabase, evidence: LumiCognitiveEvidence): void {
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

function upsertMigration(
  db: SqliteDatabase,
  id: string,
  phase: string,
  report: Record<string, unknown>,
  createdAt: number,
): void {
  db.prepare(`
    INSERT INTO lumi_cognitive_migrations (
      id, source_kind, phase, report_json, created_at, updated_at
    ) VALUES (?, 'legacy_desktop_cognition', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      phase = excluded.phase,
      report_json = excluded.report_json,
      updated_at = excluded.updated_at
  `).run(id, phase, JSON.stringify(report), createdAt, Date.now())
}

function profileLayer(value: unknown): LumiCognitiveProfileLayer {
  return value === 'core' || value === 'daily' ? value : 'dynamic'
}

function stringList(value: unknown, maximum: number): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return [...new Set(values.map(item => text(item)).filter(Boolean))].slice(0, maximum)
}

function printable(value: unknown): string {
  if (typeof value === 'string')
    return value.trim()
  if (value === undefined || value === null)
    return ''
  try {
    return JSON.stringify(value)
  }
  catch {
    return ''
  }
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback
}

function timestamp(value: unknown, fallback = new Date().toISOString()): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : fallback
}

function optionalTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
