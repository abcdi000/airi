import type {
  GroupObservationBatch,
  GroupObservationEnvelope,
  GroupObservationReceipt,
  StudyGroupPolicy,
} from '@proj-airi/lumi-agent-runtime'
import type {
  LanguageLearningConfig,
  SocialLanguageGroupObservation,
  SocialLanguageSnapshot,
} from '@proj-airi/lumi-runtime'

import type { LumiConsciousnessModel } from './consciousness'
import type { LumiServerDatabase } from './database'

import { randomUUID } from 'node:crypto'

import { GroupObservationRuntime } from '@proj-airi/lumi-agent-runtime'
import {
  buildObservedGroupLearningMessages,
  completeGroupObservationBatch,
  enqueueGroupObservation,
  parseSocialLanguageLearningResult,
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
    const modelOutput = await options.model.generateLanguageText(
      buildObservedGroupLearningMessages({
        observations: batch.observations.map(toSocialObservation),
        recentContext,
      }),
      'expression_learning',
    )
    const parsed = parseSocialLanguageLearningResult(modelOutput)
    if (!parsed.valid)
      throw new Error(parsed.warning ?? 'Group language curator returned an invalid result')

    await mutateSnapshot((latest) => {
      const beforeExpressions = signatures(latest.expressions)
      const beforeJargon = signatures(latest.jargon)
      const beforeBehaviors = signatures(latest.behaviors)
      const evidence = {
        messageId: `batch:${batch.observations.map(observation => observation.messageId).join(',')}`,
        text: batch.observations.map(observation => observation.text ?? '').filter(Boolean).join('\n'),
        conversationId: `group-learning:${batch.sourceId}`,
        platform: batch.observations[0]?.platform,
        timestamp: batch.observations.at(-1)?.timestamp ?? Date.now(),
        source: 'human' as const,
        sourceKind: 'group_chat' as const,
        authorVerified: true,
      }
      const learned = observeServerLanguageEvidence({
        snapshot: latest,
        evidence,
        config: options.languageLearning,
        modelOutput,
      })
      const processedAt = Date.now()
      return completeGroupObservationBatch(
        learned,
        batch.observations.map(toSocialObservation),
        {
          id: randomUUID(),
          sourceId: batch.sourceId,
          messageIds: batch.observations.map(observation => observation.messageId),
          messageCount: batch.observations.length,
          processedAt,
          curator: 'model',
          expressionIds: changedIds(beforeExpressions, learned.expressions),
          jargonIds: changedIds(beforeJargon, learned.jargon),
          behaviorIds: changedIds(beforeBehaviors, learned.behaviors),
        },
      )
    })
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
