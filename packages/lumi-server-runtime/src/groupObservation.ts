import type {
  GroupObservationBatch,
  GroupObservationEnvelope,
  GroupObservationReceipt,
  LumiPromptTemplate,
  LumiPromptTemplateId,
  StudyGroupPolicy,
} from '@proj-airi/lumi-agent-runtime'
import type {
  GroupLearningCuratorKind,
  LanguageLearningConfig,
  ParsedGroupCuratorOutput,
  SocialLanguageGroupObservation,
  SocialLanguageObservationBatch,
  SocialLanguageSnapshot,
} from '@proj-airi/lumi-runtime'

import type { LumiConsciousnessModel } from './consciousness'
import type { LumiServerDatabase } from './database'

import { createHash, randomUUID } from 'node:crypto'

import { errorMessageFrom } from '@moeru/std'
import {
  createLumiPromptTemplate,
  GroupObservationRuntime,
  lumiPromptTemplateMetadata,
  redactPromptMessages,
} from '@proj-airi/lumi-agent-runtime'
import {
  buildObservedGroupCuratorMessages,
  completeGroupObservationBatch,
  enqueueGroupObservation,
  observePublicGroupKnowledge,
  parseObservedGroupCuratorOutput,
} from '@proj-airi/lumi-runtime'

import { observeServerLanguageEvidence } from './socialLanguage'

/** Configuration for the server-owned, reply-free group learner. */
export interface LumiServerGroupObservationOptions {
  database: LumiServerDatabase
  model: Pick<LumiConsciousnessModel, 'generateLanguageText'>
  enabled: boolean
  batchSize: number
  maximumTextLength?: number
  maximumHistory?: number
  studyGroups: readonly StudyGroupPolicy[]
  languageLearning: LanguageLearningConfig
  promptTemplates?: Partial<Record<LumiPromptTemplateId, LumiPromptTemplate>>
}

/** Server adapter around the platform-neutral read-only observation runtime. */
export interface LumiServerGroupObservationRuntime {
  observe: (envelope: GroupObservationEnvelope) => Promise<GroupObservationReceipt>
  resume: () => Promise<void>
  drain: () => Promise<void>
}

/**
 * Creates the authoritative Node adapter for read-only group learning.
 *
 * Use when:
 * - Lumi Server accepts verified AstrBot observations
 * - Persisted pending batches must resume after a process restart
 *
 * Expects:
 * - AstrBot has already suppressed every group reply path
 * - `studyGroups` contains stable, unique source IDs
 *
 * Returns:
 * - An adapter with no consciousness, tool, speech, or outbound capability
 */
export function createLumiServerGroupObservationRuntime(
  options: LumiServerGroupObservationOptions,
): LumiServerGroupObservationRuntime {
  const maximumHistory = Math.max(1, Math.floor(options.maximumHistory ?? 50_000))
  let commitQueue: Promise<void> = Promise.resolve()

  const mutateSnapshot = (mutation: (snapshot: SocialLanguageSnapshot) => SocialLanguageSnapshot) => {
    const operation = commitQueue.then(() => {
      options.database.replaceSocialLanguageSnapshot(
        mutation(options.database.getSocialLanguageSnapshot()),
      )
    })
    commitQueue = operation.catch(() => undefined)
    return operation
  }

  const runtime = new GroupObservationRuntime({
    policy: {
      enabled: options.enabled,
      batchSize: options.batchSize,
      maximumTextLength: options.maximumTextLength ?? 4_000,
      studyGroups: options.studyGroups,
    },
    persistence: {
      hasEvent: async eventId => hasObservation(options.database.getSocialLanguageSnapshot(), eventId),
      loadPending: async () => options.database.getSocialLanguageSnapshot().observationBuffer.map(observation => restoreEnvelope(observation, options.studyGroups)).filter((observation): observation is GroupObservationEnvelope => observation !== undefined),
      append: async envelope => await mutateSnapshot(snapshot =>
        enqueueGroupObservation(snapshot, toSocialObservation(envelope), maximumHistory),
      ),
    },
    consumer: {
      consume: async batch => await consumeBatch(batch),
    },
    audit: {
      record(entry) {
        options.database.recordSecurityAudit('group-observation', {
          eventId: entry.eventId,
          sourceId: entry.sourceId,
          outcome: entry.outcome,
          reason: entry.reason ?? '',
          batchSize: String(entry.batchSize ?? 0),
        })
      },
    },
  })

  async function consumeBatch(batch: GroupObservationBatch): Promise<void> {
    const snapshot = options.database.getSocialLanguageSnapshot()
    const currentIds = new Set(batch.observations.map(observation => observation.messageId))
    const recentContext = snapshot.observationHistory
      .filter(observation => observation.sourceId === batch.sourceId && !currentIds.has(observation.messageId))
      .slice(-60)
    const observations = batch.observations.map(toSocialObservation)
    const auditId = batchAuditId(batch)
    const enabledCurators = curatorKinds(options.languageLearning)
    const completedCurators = new Set(
      snapshot.observationBatches
        .find(candidate => candidate.id === auditId)
        ?.curators
        ? Object.entries(snapshot.observationBatches.find(candidate => candidate.id === auditId)!.curators!)
            .filter(([, progress]) => progress?.status === 'completed')
            .map(([kind]) => kind as GroupLearningCuratorKind)
        : [],
    )
    const pendingCurators = enabledCurators.filter(kind => !completedCurators.has(kind))
    const results = await Promise.allSettled(
      pendingCurators.map(kind => runCurator(kind, batch, observations, recentContext, currentIds, auditId)),
    )
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0)
      throw new AggregateError(failures, 'One or more group learning curators failed')

    await mutateSnapshot((latest) => {
      const audit = latest.observationBatches.find(candidate => candidate.id === auditId)
        ?? createBatchAudit(auditId, batch)
      const allCompleted = enabledCurators.every(kind => audit.curators?.[kind]?.status === 'completed')
      if (!allCompleted)
        return latest
      const withoutPendingAudit = {
        ...latest,
        observationBatches: latest.observationBatches.filter(candidate => candidate.id !== auditId),
      }
      return completeGroupObservationBatch(withoutPendingAudit, observations, {
        ...audit,
        processedAt: Date.now(),
        curator: 'model',
        warning: undefined,
      })
    })
  }

  async function runCurator(
    kind: GroupLearningCuratorKind,
    batch: GroupObservationBatch,
    observations: SocialLanguageGroupObservation[],
    recentContext: SocialLanguageGroupObservation[],
    allowedMessageIds: ReadonlySet<string>,
    auditId: string,
  ) {
    try {
      const promptId = promptIdForCurator(kind)
      const override = options.promptTemplates?.[promptId]
      const messages = buildObservedGroupCuratorMessages({
        kind,
        focusBatch: observations,
        recentContext,
        systemPromptOverride: override?.content,
      })
      const template = override ?? createLumiPromptTemplate(promptId, messages[0]!.content)
      const startedAt = Date.now()
      const modelOutput = await options.model.generateLanguageText(
        messages,
        curatorPurpose(kind),
      )
      const metadata = lumiPromptTemplateMetadata(template)
      options.database.recordSecurityAudit('agent-model-request', {
        turnId: auditId,
        purpose: curatorPurpose(kind),
        durationMs: String(Date.now() - startedAt),
        promptId: metadata.id,
        promptVersion: metadata.version,
        promptHash: metadata.hash,
        messageCount: String(messages.length),
        ...(options.languageLearning.promptLoggingEnabled
          ? { promptMessages: JSON.stringify(redactPromptMessages(messages)) }
          : {}),
      })
      const parsed = parseObservedGroupCuratorOutput({
        kind,
        raw: modelOutput,
        allowedMessageIds,
        forbiddenIdentityStrings: batch.observations.flatMap(observation => [
          observation.senderId,
          observation.senderName,
        ]),
      })
      if (!parsed.valid)
        throw new Error(parsed.warning ?? `${kind} curator returned an invalid result`)

      await mutateSnapshot(latest => applyCuratorResult({
        snapshot: latest,
        parsed,
        kind,
        batch,
        auditId,
        config: options.languageLearning,
      }))
    }
    catch (error) {
      await mutateSnapshot(snapshot => updateCuratorProgress(
        snapshot,
        createBatchAudit(auditId, batch),
        kind,
        'failed',
        [],
        errorMessageFrom(error) ?? 'group curator failed',
      ))
      throw error
    }
  }

  return {
    observe: envelope => runtime.observe(envelope),
    resume: () => runtime.resume(),
    drain: async () => {
      await runtime.drain()
      await commitQueue
    },
  }
}

function promptIdForCurator(kind: GroupLearningCuratorKind): LumiPromptTemplateId {
  if (kind === 'expression')
    return 'expression_learning'
  if (kind === 'jargon')
    return 'jargon_learning'
  if (kind === 'behavior')
    return 'behavior_learning'
  return 'public_group_knowledge_learning'
}

function applyCuratorResult(input: {
  snapshot: SocialLanguageSnapshot
  parsed: ParsedGroupCuratorOutput
  kind: GroupLearningCuratorKind
  batch: GroupObservationBatch
  auditId: string
  config: LanguageLearningConfig
}): SocialLanguageSnapshot {
  const beforeExpressions = signatures(input.snapshot.expressions)
  const beforeJargon = signatures(input.snapshot.jargon)
  const beforeBehaviors = signatures(input.snapshot.behaviors)
  const beforePublicKnowledge = signatures(input.snapshot.publicKnowledge)
  const timestamp = input.batch.observations.at(-1)?.timestamp ?? Date.now()
  const evidenceBase = {
    messageId: `batch:${input.batch.observations.map(observation => observation.messageId).join(',')}`,
    text: input.batch.observations.map(observation => observation.text ?? '').filter(Boolean).join('\n'),
    conversationId: `group-learning:${input.batch.sourceId}`,
    platform: input.batch.observations[0]?.platform,
    timestamp,
    source: 'human' as const,
    sourceKind: 'group_chat' as const,
    authorVerified: true,
  }
  let learned = input.snapshot
  for (const sourced of input.parsed.expressions) {
    learned = observeServerLanguageEvidence({
      snapshot: learned,
      evidence: { ...evidenceBase, sourceMessageIds: sourced.sourceMessageIds },
      config: input.config,
      ingress: 'group_observation',
      modelOutput: JSON.stringify({ expressions: [sourced.candidate], jargon: [], behaviors: [] }),
    })
  }
  for (const sourced of input.parsed.jargon) {
    learned = observeServerLanguageEvidence({
      snapshot: learned,
      evidence: { ...evidenceBase, sourceMessageIds: sourced.sourceMessageIds },
      config: input.config,
      ingress: 'group_observation',
      modelOutput: JSON.stringify({ expressions: [], jargon: [sourced.candidate], behaviors: [] }),
    })
  }
  for (const sourced of input.parsed.behaviors) {
    learned = observeServerLanguageEvidence({
      snapshot: learned,
      evidence: { ...evidenceBase, sourceMessageIds: sourced.sourceMessageIds },
      config: input.config,
      ingress: 'group_observation',
      modelOutput: JSON.stringify({ expressions: [], jargon: [], behaviors: [sourced.candidate] }),
    })
  }
  for (const sourced of input.parsed.publicKnowledge) {
    const key = publicKnowledgeKey(input.batch.sourceId, sourced.candidate.content)
    const existing = learned.publicKnowledge.find(candidate =>
      publicKnowledgeKey(candidate.sourceId, candidate.content) === key)
    const next = observePublicGroupKnowledge({
      existing,
      id: existing?.id ?? randomUUID(),
      sourceId: input.batch.sourceId,
      sourceMessageIds: sourced.sourceMessageIds,
      proposal: sourced.candidate,
      timestamp,
    })
    learned = {
      ...learned,
      publicKnowledge: [
        ...learned.publicKnowledge.filter(candidate => candidate.id !== next.id),
        next,
      ],
    }
  }
  const outputIds = input.kind === 'expression'
    ? changedIds(beforeExpressions, learned.expressions)
    : input.kind === 'jargon'
      ? changedIds(beforeJargon, learned.jargon)
      : input.kind === 'behavior'
        ? changedIds(beforeBehaviors, learned.behaviors)
        : changedIds(beforePublicKnowledge, learned.publicKnowledge)
  return updateCuratorProgress(
    learned,
    createBatchAudit(input.auditId, input.batch),
    input.kind,
    'completed',
    outputIds,
  )
}

function updateCuratorProgress(
  snapshot: SocialLanguageSnapshot,
  baseAudit: SocialLanguageObservationBatch,
  kind: GroupLearningCuratorKind,
  status: 'completed' | 'failed',
  outputIds: string[],
  warning?: string,
): SocialLanguageSnapshot {
  const existing = snapshot.observationBatches.find(candidate => candidate.id === baseAudit.id)
  const previous = existing?.curators?.[kind]
  const audit: SocialLanguageObservationBatch = {
    ...(existing ?? baseAudit),
    curator: status === 'failed' ? 'pending' : existing?.curator ?? 'pending',
    expressionIds: kind === 'expression' ? outputIds : existing?.expressionIds ?? [],
    jargonIds: kind === 'jargon' ? outputIds : existing?.jargonIds ?? [],
    behaviorIds: kind === 'behavior' ? outputIds : existing?.behaviorIds ?? [],
    publicKnowledgeIds: kind === 'public_knowledge' ? outputIds : existing?.publicKnowledgeIds ?? [],
    curators: {
      ...existing?.curators,
      [kind]: {
        status,
        attempts: (previous?.attempts ?? 0) + 1,
        updatedAt: Date.now(),
        outputIds,
        ...(warning ? { warning: warning.slice(0, 500) } : {}),
      },
    },
    ...(warning ? { warning: warning.slice(0, 500) } : {}),
  }
  return {
    ...snapshot,
    observationBatches: [
      ...snapshot.observationBatches.filter(candidate => candidate.id !== audit.id),
      audit,
    ].slice(-200),
    updatedAt: Date.now(),
  }
}

function createBatchAudit(
  id: string,
  batch: GroupObservationBatch,
): SocialLanguageObservationBatch {
  return {
    id,
    sourceId: batch.sourceId,
    messageIds: batch.observations.map(observation => observation.messageId),
    messageCount: batch.observations.length,
    processedAt: Date.now(),
    curator: 'pending',
    expressionIds: [],
    jargonIds: [],
    behaviorIds: [],
    publicKnowledgeIds: [],
    curators: {},
  }
}

function curatorKinds(config: LanguageLearningConfig): GroupLearningCuratorKind[] {
  return [
    ...(config.groupExpressionLearningEnabled ? ['expression' as const] : []),
    ...(config.groupJargonLearningEnabled ? ['jargon' as const] : []),
    ...(config.groupBehaviorLearningEnabled ? ['behavior' as const] : []),
    ...(config.groupPublicKnowledgeLearningEnabled ? ['public_knowledge' as const] : []),
  ]
}

function curatorPurpose(kind: GroupLearningCuratorKind) {
  return kind === 'expression'
    ? 'expression_learning' as const
    : kind === 'jargon'
      ? 'jargon_learning' as const
      : kind === 'behavior'
        ? 'behavior_learning' as const
        : 'public_knowledge_learning' as const
}

function batchAuditId(batch: GroupObservationBatch) {
  const digest = createHash('sha256')
    .update(batch.sourceId)
    .update('\0')
    .update(batch.observations.map(observation => observation.messageId).join('\0'))
    .digest('hex')
    .slice(0, 24)
  return `group-curators:${digest}`
}

function publicKnowledgeKey(sourceId: string, content: string) {
  return `${sourceId}\0${content.trim().toLocaleLowerCase().replace(/\s+/g, ' ')}`
}

function toSocialObservation(envelope: GroupObservationEnvelope): SocialLanguageGroupObservation {
  return {
    eventId: envelope.eventId,
    messageId: envelope.messageId,
    sourceId: envelope.sourceId,
    platform: envelope.platform,
    platformInstanceId: envelope.platformInstanceId,
    groupId: envelope.groupId,
    senderId: envelope.senderId,
    senderName: envelope.senderName,
    text: envelope.text ?? '',
    timestamp: envelope.timestamp,
  }
}

function restoreEnvelope(
  observation: SocialLanguageGroupObservation,
  studyGroups: readonly StudyGroupPolicy[],
): GroupObservationEnvelope | undefined {
  const source = studyGroups.find(candidate =>
    candidate.sourceId === observation.sourceId
    && candidate.platformInstanceId === observation.platformInstanceId
    && candidate.groupId === observation.groupId,
  )
  if (!source)
    return undefined
  return {
    ...observation,
    authorVerified: true,
    isLumi: false,
    sourceKind: 'human_message',
    images: [],
    segments: [{ type: 'text', text: observation.text }],
    conversationType: 'group_observation',
  }
}

function hasObservation(snapshot: SocialLanguageSnapshot, eventId: string): boolean {
  return snapshot.observationBuffer.some(observation => observation.eventId === eventId)
    || snapshot.observationHistory.some(observation => observation.eventId === eventId)
}

function signatures<TItem extends { id: string }>(items: readonly TItem[]): Map<string, string> {
  return new Map(items.map(item => [item.id, JSON.stringify(item)]))
}

function changedIds<TItem extends { id: string }>(
  before: ReadonlyMap<string, string>,
  after: readonly TItem[],
): string[] {
  return after
    .filter(item => before.get(item.id) !== JSON.stringify(item))
    .map(item => item.id)
}
