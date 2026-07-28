import type {
  JargonKnowledge,
  LanguageDecisionLog,
  LanguageLearningConfig,
  LearnedBehaviorProposal,
  LearnedExpression,
  LearnedExpressionProposal,
  LearnedSocialBehavior,
  LumiLanguageFeedback,
  SocialLanguageCandidateIngress,
  SocialLanguageEvidence,
  SocialLanguageGroupObservation,
  SocialLanguageSnapshot,
} from '../../../lumi-runtime/src'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import {
  applyExpressionFeedback,
  behaviorSemanticKey,
  canCreateSocialLanguageCandidates,
  completeGroupObservationBatch,
  createEmptySocialLanguageSnapshot,
  decayLearnedExpression,
  DEFAULT_LANGUAGE_LEARNING_CONFIG,
  enqueueGroupObservation,
  expressionIdsActuallyUsed,
  expressionIdsForDecisionFeedback,
  expressionSemanticKey,
  isTrustedSocialLanguageEvidence,
  maintainSocialLanguageSnapshot,
  markExpressionUsed,
  migrateSocialLanguageSnapshot,
  nextGroupObservationBatch,
  normalizeLanguageLearningConfig,
  observeJargonKnowledge,
  observeLearnedExpression,
  observeSocialBehavior,
  parseSocialLanguageLearningOutput,
  parseSocialLanguageLearningResult,
} from '../../../lumi-runtime/src'

export type {
  JargonKnowledge,
  LanguageDecisionLog,
  LanguageLearningConfig,
  LearnedExpression,
  LearnedExpressionStatus,
  LearnedSocialBehavior,
} from '../../../lumi-runtime/src'

const SNAPSHOT_STORAGE_KEY = 'runtime/lumi/social-language/snapshot-v1'
const CONFIG_STORAGE_KEY = 'settings/lumi/language-learning/config-v1'

export interface LumiSocialLanguagePersistenceBridge {
  /** Loads the complete device-owned snapshot. */
  loadSnapshot: () => Promise<unknown>
  /** Atomically replaces the complete device-owned snapshot. */
  replaceSnapshot: (snapshot: SocialLanguageSnapshot) => Promise<void>
}

/**
 * Owns offline Lumi social-language state and its feedback lifecycle.
 *
 * This store persists language habits globally while keeping person,
 * conversation, and platform affinities as probabilistic features. It never
 * reads or changes memory authorization.
 */
export const useLumiSocialLanguageStore = defineStore('lumi-social-language', () => {
  const persistedSnapshot = useLocalStorageManualReset<SocialLanguageSnapshot>(
    SNAPSHOT_STORAGE_KEY,
    createEmptySocialLanguageSnapshot(),
  )
  const persistedConfig = useLocalStorageManualReset<LanguageLearningConfig>(
    CONFIG_STORAGE_KEY,
    { ...DEFAULT_LANGUAGE_LEARNING_CONFIG },
  )
  const snapshot = ref(migrateSocialLanguageSnapshot(persistedSnapshot.value))
  const config = computed({
    get: () => normalizeLanguageLearningConfig(persistedConfig.value),
    set: (value: LanguageLearningConfig) => {
      persistedConfig.value = normalizeLanguageLearningConfig(value)
    },
  })
  const bridge = shallowRef<LumiSocialLanguagePersistenceBridge | null>(null)
  const initialized = ref(false)
  const activeObservationBatches = ref<Array<{
    sourceId: string
    messageCount: number
    startedAt: number
  }>>([])
  const activeObservationBatch = computed(() => activeObservationBatches.value[0] ?? null)
  let persistQueue = Promise.resolve()

  async function initialize() {
    if (initialized.value)
      return
    initialized.value = true
    if (!bridge.value)
      return
    try {
      const now = Date.now()
      const databaseInput = await bridge.value.loadSnapshot()
      const databaseSnapshot = migrateSocialLanguageSnapshot(databaseInput, now)
      const local = migrateSocialLanguageSnapshot(persistedSnapshot.value, now)
      const hasDatabaseData = databaseSnapshot.expressions.length
        || databaseSnapshot.jargon.length
        || databaseSnapshot.behaviors.length
        || databaseSnapshot.decisions.length
      const selected = hasDatabaseData ? databaseSnapshot : local
      snapshot.value = maintainSocialLanguageSnapshot(selected, now)
      const maintenanceRan = snapshot.value.lastMaintenanceAt !== selected.lastMaintenanceAt
      const databaseNeedsMigration = snapshotVersion(databaseInput) !== 4
      if (
        (hasDatabaseData && (databaseNeedsMigration || maintenanceRan))
        || (!hasDatabaseData && hasSnapshotData(local))
      ) {
        await bridge.value.replaceSnapshot(snapshot.value)
      }
      persistedSnapshot.value = snapshot.value
    }
    catch (error) {
      console.warn('[lumi-social-language] failed to initialize SQLite persistence; using local snapshot', error)
    }
  }

  function setPersistenceBridge(next: LumiSocialLanguagePersistenceBridge | null) {
    bridge.value = next
    initialized.value = false
  }

  /** Reloads the authoritative snapshot for read-only cross-window monitors. */
  async function refreshFromPersistence() {
    if (!bridge.value)
      return
    snapshot.value = migrateSocialLanguageSnapshot(await bridge.value.loadSnapshot())
    persistedSnapshot.value = snapshot.value
  }

  function updateConfig(patch: Partial<LanguageLearningConfig>) {
    config.value = normalizeLanguageLearningConfig({ ...config.value, ...patch })
  }

  /**
   * Reloads language settings from the shared browser storage.
   *
   * Use when:
   * - A separate Electron settings window may have changed learning options
   * - A chat turn must use the latest prompt logging and selection policy
   *
   * Expects:
   * - VueUse stores object values as JSON under {@link CONFIG_STORAGE_KEY}
   *
   * Returns:
   * - The normalized current configuration
   */
  function refreshConfigFromStorage() {
    const serialized = globalThis.localStorage?.getItem(CONFIG_STORAGE_KEY)
    if (!serialized)
      return config.value
    try {
      persistedConfig.value = normalizeLanguageLearningConfig(JSON.parse(serialized))
    }
    catch (error) {
      console.warn('[lumi-social-language] failed to refresh config from local storage', error)
    }
    return config.value
  }

  async function observeEvidence(
    evidence: SocialLanguageEvidence,
    modelOutput?: string,
    ingress: SocialLanguageCandidateIngress = 'direct_turn',
  ) {
    if (
      !isTrustedSocialLanguageEvidence(evidence)
      || !canCreateSocialLanguageCandidates({
        config: config.value,
        evidence,
        ingress,
      })
    ) {
      return
    }

    const parsed = modelOutput
      ? parseSocialLanguageLearningOutput(modelOutput)
      : {
          expressions: [],
          jargon: [],
          behaviors: [],
        }
    const expressions = config.value.expressionLearningEnabled
      ? deduplicateProposals(parsed.expressions)
      : []
    for (const proposal of expressions)
      upsertExpression(proposal, evidence)
    if (config.value.jargonLearningEnabled) {
      for (const proposal of parsed.jargon) {
        const existing = snapshot.value.jargon.find(item => item.term.toLocaleLowerCase() === proposal.term.toLocaleLowerCase())
        const next = observeJargonKnowledge(existing, proposal, evidence, existing?.id ?? nanoid())
        snapshot.value.jargon = [...snapshot.value.jargon.filter(item => item.id !== next.id), next]
      }
    }
    if (config.value.behaviorLearningEnabled) {
      for (const proposal of parsed.behaviors)
        upsertBehavior(proposal, evidence)
    }
    touch()
    await schedulePersist()
  }

  /**
   * Queues a read-only group observation and returns a complete batch.
   *
   * The caller may curate the returned batch, then must call
   * {@link completeObservationBatch}. No observation enters chat or memory.
   */
  async function enqueueObservation(
    observation: SocialLanguageGroupObservation,
    batchSize = 20,
    options: {
      claimBatch?: boolean
      maximumHistory?: number
    } = {},
  ) {
    const previous = snapshot.value
    snapshot.value = enqueueGroupObservation(
      snapshot.value,
      observation,
      options.maximumHistory,
    )
    if (snapshot.value === previous)
      return []
    touch(observation.timestamp)
    const batch = options.claimBatch === false ? [] : takeNextObservationBatch(batchSize)
    await schedulePersist()
    return batch
  }

  /** Claims the next complete batch when no other curator call is active. */
  function takeNextObservationBatch(batchSize = 20) {
    const activeSources = new Set(activeObservationBatches.value.map(batch => batch.sourceId))
    const batch = nextGroupObservationBatch({
      ...snapshot.value,
      observationBuffer: snapshot.value.observationBuffer.filter(
        observation => !activeSources.has(observation.sourceId),
      ),
    }, batchSize)
    if (!batch.length)
      return []
    activeObservationBatches.value = [...activeObservationBatches.value, {
      sourceId: batch[0]?.sourceId ?? 'unknown',
      messageCount: batch.length,
      startedAt: Date.now(),
    }]
    return batch
  }

  /** Releases a failed curator claim without consuming its observations. */
  function releaseObservationBatch(sourceId: string) {
    activeObservationBatches.value = activeObservationBatches.value.filter(batch => batch.sourceId !== sourceId)
  }

  async function completeObservationBatch(input: {
    observations: SocialLanguageGroupObservation[]
    modelOutput?: string
    curatorWarning?: string
    processedAt?: number
    consume?: boolean
    recoveryBatchIds?: string[]
  }) {
    const processedAt = input.processedAt ?? Date.now()
    const parsed = input.modelOutput
      ? parseSocialLanguageLearningResult(input.modelOutput)
      : undefined
    const previousExpressions = new Map(snapshot.value.expressions.map(item => [item.id, expressionMonitorSignature(item)]))
    const previousJargon = new Map(snapshot.value.jargon.map(item => [item.id, jargonMonitorSignature(item)]))
    const previousBehaviors = new Map(snapshot.value.behaviors.map(item => [item.id, behaviorMonitorSignature(item)]))
    if (parsed?.valid && input.modelOutput && input.observations[0]) {
      const combinedEvidence: SocialLanguageEvidence = {
        messageId: `batch:${input.observations.map(item => item.messageId).join(',')}`,
        text: input.observations.map(item => item.text).join('\n'),
        conversationId: `learning:${input.observations[0].sourceId}`,
        platform: input.observations[0].platform,
        timestamp: processedAt,
        source: 'human',
        sourceKind: 'group_chat',
        authorVerified: true,
      }
      await observeEvidence(combinedEvidence, input.modelOutput, 'group_observation')
    }
    const expressionIds = snapshot.value.expressions
      .filter(item => previousExpressions.get(item.id) !== expressionMonitorSignature(item))
      .map(item => item.id)
    const jargonIds = snapshot.value.jargon
      .filter(item => previousJargon.get(item.id) !== jargonMonitorSignature(item))
      .map(item => item.id)
    const behaviorIds = snapshot.value.behaviors
      .filter(item => previousBehaviors.get(item.id) !== behaviorMonitorSignature(item))
      .map(item => item.id)
    const changeCount = expressionIds.length + jargonIds.length + behaviorIds.length
    const successful = parsed?.valid === true && changeCount > 0
    const batchId = `batch-${processedAt}-${input.observations[0]?.sourceId ?? 'unknown'}`
    const warning = input.curatorWarning
      ?? parsed?.warning
      ?? (parsed?.valid ? '模型没有归纳出可写入的语言知识，消息已保留待跨批次重新归纳' : '意识模型未完成归纳，消息已保留待重试')
    const batch = {
      id: batchId,
      sourceId: input.observations[0]?.sourceId ?? 'unknown',
      messageIds: input.observations.map(item => item.messageId),
      messageCount: input.observations.length,
      processedAt,
      curator: successful ? 'model' as const : 'pending' as const,
      expressionIds,
      jargonIds,
      behaviorIds,
      publicKnowledgeIds: [],
      warning: successful ? undefined : warning,
    }
    if (input.consume === false) {
      snapshot.value = {
        ...snapshot.value,
        observationBatches: [
          ...snapshot.value.observationBatches.map(existing =>
            successful && input.recoveryBatchIds?.includes(existing.id)
              ? { ...existing, recoveredAt: processedAt, recoveryBatchId: batchId }
              : existing,
          ),
          batch,
        ].slice(-200),
      }
    }
    else {
      snapshot.value = completeGroupObservationBatch(snapshot.value, input.observations, batch)
    }
    releaseObservationBatch(input.observations[0]?.sourceId ?? 'unknown')
    touch(processedAt)
    await schedulePersist()
    return { batch, successful, changeCount }
  }

  /** Returns recent same-source observations that help the model detect cross-batch patterns. */
  function recentObservationContext(sourceId: string, excludeMessageIds: string[] = [], limit = 60) {
    const excluded = new Set(excludeMessageIds)
    return snapshot.value.observationHistory
      .filter(item => item.sourceId === sourceId && !excluded.has(item.messageId))
      .slice(-limit)
  }

  /**
   * Reconstructs zero-change batches from retained raw observation history.
   *
   * Old versions consumed these batches even when model JSON was invalid. This
   * projection is intentionally read-only; a successful recovery call marks the
   * original audit records as covered.
   */
  function recoverableObservationGroups(limitPerSource = 120) {
    const history = new Map(snapshot.value.observationHistory.map(item => [item.messageId, item]))
    const groups = new Map<string, { batchIds: string[], observations: SocialLanguageGroupObservation[] }>()
    const seen = new Set<string>()
    for (const batch of snapshot.value.observationBatches) {
      const changeCount = batch.expressionIds.length + batch.jargonIds.length + batch.behaviorIds.length
      if (changeCount > 0 || batch.recoveredAt)
        continue
      const group = groups.get(batch.sourceId) ?? { batchIds: [], observations: [] }
      group.batchIds.push(batch.id)
      for (const messageId of batch.messageIds) {
        const observation = history.get(messageId)
        if (!observation || seen.has(observation.eventId) || group.observations.length >= limitPerSource)
          continue
        seen.add(observation.eventId)
        group.observations.push(observation)
      }
      groups.set(batch.sourceId, group)
    }
    return [...groups.entries()]
      .map(([sourceId, value]) => ({
        sourceId,
        batchIds: value.batchIds,
        observations: value.observations.sort((left, right) => left.timestamp - right.timestamp),
      }))
      .filter(group => group.observations.length > 0)
  }

  async function recordDecision(decision: LanguageDecisionLog) {
    const now = decision.timestamp
    const realized = expressionIdsActuallyUsed(snapshot.value.expressions, decision)
    snapshot.value.expressions = snapshot.value.expressions.map(expression =>
      realized.has(expression.id) ? markExpressionUsed(expression, now) : expression,
    )
    const selectedBehaviors = new Set(decision.selectedBehaviors)
    snapshot.value.behaviors = snapshot.value.behaviors.map(behavior =>
      selectedBehaviors.has(behavior.id) ? { ...behavior, lastAppliedAt: now } : behavior,
    )
    snapshot.value.decisions = [...snapshot.value.decisions, decision].slice(-500)
    touch(now)
    await schedulePersist()
  }

  async function applyFeedbackFromUser(input: {
    conversationId: string
    personId?: string
    feedback?: LumiLanguageFeedback
    now?: number
  }) {
    if (!config.value.enabled || !config.value.feedbackLearningEnabled)
      return
    const decisionIndex = snapshot.value.decisions.findLastIndex(decision =>
      decision.conversationId === input.conversationId
      && decision.personId === input.personId
      && decision.laterFeedback === undefined,
    )
    if (decisionIndex < 0)
      return
    if (!input.feedback)
      return
    const decision = snapshot.value.decisions[decisionIndex]
    const feedback = input.feedback
    const selectedExpressionIds = expressionIdsForDecisionFeedback(snapshot.value.expressions, decision)
    snapshot.value.expressions = snapshot.value.expressions.map((expression) => {
      if (!selectedExpressionIds.has(expression.id))
        return expression
      const next = applyExpressionFeedback(expression, feedback, input.now ?? Date.now())
      if (config.value.globalDiffusionEnabled && hasStrongPositiveFeedback(feedback)) {
        return {
          ...next,
          affinity: {
            ...next.affinity,
            global: Math.min(1, next.affinity.global + 0.05),
          },
        }
      }
      return next
    })
    const selectedBehaviorIds = new Set(decision.selectedBehaviors)
    snapshot.value.behaviors = snapshot.value.behaviors.map((behavior) => {
      if (!selectedBehaviorIds.has(behavior.id))
        return behavior
      const failed = feedback.explicitRejection || feedback.misunderstanding || feedback.aiStyleComplaint
      const succeeded = feedback.explicitPraise || feedback.playfulContinuation || feedback.phraseEcho
      return {
        ...behavior,
        successCount: behavior.successCount + Number(succeeded),
        failureCount: behavior.failureCount + Number(failed),
        confidence: Math.max(0, Math.min(1, behavior.confidence + Number(succeeded) * 0.03 - Number(failed) * 0.06)),
      }
    })
    snapshot.value.decisions = snapshot.value.decisions.map((item, index) =>
      index === decisionIndex ? { ...item, laterFeedback: feedback } : item,
    )
    touch(input.now)
    await schedulePersist()
  }

  async function runDecay(now = Date.now()) {
    snapshot.value.expressions = snapshot.value.expressions.map(expression => decayLearnedExpression(expression, now))
    snapshot.value.lastMaintenanceAt = now
    touch(now)
    await schedulePersist()
  }

  async function updateExpression(
    id: string,
    patch: Partial<Pick<LearnedExpression, 'phrase' | 'situation' | 'pragmaticFunction' | 'emotionalMeaning' | 'tone' | 'patternType' | 'status' | 'confidence' | 'familiarity' | 'ownership'>>,
  ) {
    snapshot.value.expressions = snapshot.value.expressions.map(expression =>
      expression.id === id ? { ...expression, ...patch } : expression,
    )
    touch()
    await schedulePersist()
  }

  async function deleteExpression(id: string) {
    snapshot.value.expressions = snapshot.value.expressions.filter(expression => expression.id !== id)
    touch()
    await schedulePersist()
  }

  async function updateJargon(
    id: string,
    patch: Partial<Pick<JargonKnowledge, 'term' | 'meanings' | 'literalMeaning' | 'pragmaticFunctions' | 'emotionalTone' | 'communities'>>,
  ) {
    snapshot.value.jargon = snapshot.value.jargon.map(jargon =>
      jargon.id === id ? { ...jargon, ...patch } : jargon,
    )
    touch()
    await schedulePersist()
  }

  async function deleteJargon(id: string) {
    snapshot.value.jargon = snapshot.value.jargon.filter(jargon => jargon.id !== id)
    touch()
    await schedulePersist()
  }

  async function updateBehavior(
    id: string,
    patch: Partial<Pick<LearnedSocialBehavior, 'situation' | 'action' | 'expectedEffect' | 'confidence'>>,
  ) {
    snapshot.value.behaviors = snapshot.value.behaviors.map(behavior =>
      behavior.id === id ? { ...behavior, ...patch } : behavior,
    )
    touch()
    await schedulePersist()
  }

  async function deleteBehavior(id: string) {
    snapshot.value.behaviors = snapshot.value.behaviors.filter(behavior => behavior.id !== id)
    touch()
    await schedulePersist()
  }

  async function deleteDecision(id: string) {
    snapshot.value.decisions = snapshot.value.decisions.filter(decision => decision.id !== id)
    touch()
    await schedulePersist()
  }

  async function clearDecisions() {
    snapshot.value.decisions = []
    touch()
    await schedulePersist()
  }

  async function replaceSnapshot(next: unknown) {
    snapshot.value = migrateSocialLanguageSnapshot(next)
    persistedSnapshot.value = snapshot.value
    await schedulePersist()
  }

  function reset() {
    snapshot.value = createEmptySocialLanguageSnapshot()
    persistedSnapshot.value = snapshot.value
    persistedConfig.reset()
    void schedulePersist()
  }

  function upsertExpression(proposal: LearnedExpressionProposal, evidence: SocialLanguageEvidence) {
    if (evidence.source === 'lumi' && !config.value.selfExpressionLearningEnabled)
      return
    const key = expressionSemanticKey(proposal)
    const existing = snapshot.value.expressions.find(item => expressionSemanticKey(item) === key)
    const next = observeLearnedExpression(existing, proposal, evidence, existing?.id ?? nanoid())
    snapshot.value.expressions = [...snapshot.value.expressions.filter(item => item.id !== next.id), next]
  }

  function upsertBehavior(proposal: LearnedBehaviorProposal, evidence: SocialLanguageEvidence) {
    const key = behaviorSemanticKey(proposal)
    const existing = snapshot.value.behaviors.find(item => behaviorSemanticKey(item) === key)
    const next = observeSocialBehavior(existing, proposal, evidence, existing?.id ?? nanoid())
    snapshot.value.behaviors = [...snapshot.value.behaviors.filter(item => item.id !== next.id), next]
  }

  function touch(now = Date.now()) {
    snapshot.value = {
      ...snapshot.value,
      updatedAt: now,
    }
    persistedSnapshot.value = snapshot.value
  }

  function schedulePersist() {
    const target = bridge.value
    if (!target)
      return Promise.resolve()
    let current: SocialLanguageSnapshot
    try {
      // Vue deep refs expose Proxy objects that Electron and structuredClone
      // cannot transfer. JSON is the persistence format for this schema, so
      // serialize at the store boundary before invoking any host bridge.
      current = migrateSocialLanguageSnapshot(JSON.parse(JSON.stringify(snapshot.value)))
    }
    catch (error) {
      console.warn('[lumi-social-language] failed to serialize snapshot for persistence', error)
      return Promise.resolve()
    }
    persistQueue = persistQueue
      .catch(() => undefined)
      .then(() => target.replaceSnapshot(current))
      .catch(error => console.warn('[lumi-social-language] failed to persist snapshot', error))
    return persistQueue
  }

  return {
    snapshot,
    config,
    initialized,
    activeObservationBatch,
    activeObservationBatches,
    initialize,
    setPersistenceBridge,
    refreshFromPersistence,
    updateConfig,
    refreshConfigFromStorage,
    observeEvidence,
    enqueueObservation,
    takeNextObservationBatch,
    releaseObservationBatch,
    completeObservationBatch,
    recentObservationContext,
    recoverableObservationGroups,
    recordDecision,
    applyFeedbackFromUser,
    pendingFeedbackDecision,
    runDecay,
    updateExpression,
    deleteExpression,
    updateJargon,
    deleteJargon,
    updateBehavior,
    deleteBehavior,
    deleteDecision,
    clearDecisions,
    replaceSnapshot,
    reset,
  }

  function pendingFeedbackDecision(conversationId: string, personId?: string) {
    return snapshot.value.decisions.findLast(decision =>
      decision.conversationId === conversationId
      && decision.personId === personId
      && decision.laterFeedback === undefined,
    )
  }
})

function hasSnapshotData(snapshot: SocialLanguageSnapshot) {
  return snapshot.expressions.length
    + snapshot.jargon.length
    + snapshot.behaviors.length
    + snapshot.decisions.length
    + snapshot.observationBuffer.length
    + snapshot.observationHistory.length
    + snapshot.observationBatches.length > 0
}

function snapshotVersion(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  return 'version' in value ? value.version : undefined
}

function deduplicateProposals(proposals: LearnedExpressionProposal[]) {
  const seen = new Set<string>()
  return proposals.filter((proposal) => {
    const key = expressionSemanticKey(proposal)
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

function hasStrongPositiveFeedback(feedback: LumiLanguageFeedback) {
  return feedback.explicitPraise || feedback.phraseEcho || feedback.playfulContinuation
}

function expressionMonitorSignature(expression: SocialLanguageSnapshot['expressions'][number]) {
  return [
    expression.observationCount,
    expression.familiarity,
    expression.ownership,
    expression.confidence,
    expression.status,
    expression.lastSeenAt,
  ].join(':')
}

function jargonMonitorSignature(jargon: SocialLanguageSnapshot['jargon'][number]) {
  return [
    jargon.lastSeenAt,
    jargon.meanings.length,
    jargon.meanings.map(meaning => meaning.confidence).join(','),
  ].join(':')
}

function behaviorMonitorSignature(behavior: SocialLanguageSnapshot['behaviors'][number]) {
  return [
    behavior.confidence,
    behavior.successCount,
    behavior.failureCount,
    behavior.originEvidenceIds.length,
  ].join(':')
}
