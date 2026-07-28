import type {
  JargonKnowledge,
  LanguageDecisionLog,
  LanguageLearningConfig,
  LearnedExpression,
  LearnedSocialBehavior,
  SocialLanguageAffinity,
  SocialLanguageSnapshot,
} from './types'

import { decayLearnedExpression, expressionSemanticKey } from './learning'

const SOCIAL_LANGUAGE_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * Defaults for Lumi's social-language subsystem.
 */
export const DEFAULT_LANGUAGE_LEARNING_CONFIG: Readonly<LanguageLearningConfig> = {
  enabled: true,
  expressionLearningEnabled: true,
  behaviorLearningEnabled: true,
  jargonLearningEnabled: true,
  selfExpressionLearningEnabled: true,
  globalDiffusionEnabled: true,
  maxSelectedExpressions: 3,
  vectorCandidateLimit: 24,
  preciseSelectorEnabled: true,
  feedbackLearningEnabled: true,
  groupExpressionLearningEnabled: true,
  groupJargonLearningEnabled: true,
  groupBehaviorLearningEnabled: true,
  groupPublicKnowledgeLearningEnabled: true,
  directLanguageCandidateLearningEnabled: false,
  promptLoggingEnabled: false,
  multiMessageReplyEnabled: true,
}

/**
 * Normalizes persisted language-learning configuration.
 *
 * Before:
 * - `{ maxSelectedExpressions: 99, preciseSelectorEnabled: "yes" }`
 *
 * After:
 * - `{ ...defaults, maxSelectedExpressions: 3, preciseSelectorEnabled: true }`
 */
export function normalizeLanguageLearningConfig(input?: Partial<LanguageLearningConfig> | null): LanguageLearningConfig {
  return {
    enabled: booleanValue(input?.enabled, DEFAULT_LANGUAGE_LEARNING_CONFIG.enabled),
    expressionLearningEnabled: booleanValue(input?.expressionLearningEnabled, DEFAULT_LANGUAGE_LEARNING_CONFIG.expressionLearningEnabled),
    behaviorLearningEnabled: booleanValue(input?.behaviorLearningEnabled, DEFAULT_LANGUAGE_LEARNING_CONFIG.behaviorLearningEnabled),
    jargonLearningEnabled: booleanValue(input?.jargonLearningEnabled, DEFAULT_LANGUAGE_LEARNING_CONFIG.jargonLearningEnabled),
    selfExpressionLearningEnabled: booleanValue(input?.selfExpressionLearningEnabled, DEFAULT_LANGUAGE_LEARNING_CONFIG.selfExpressionLearningEnabled),
    globalDiffusionEnabled: booleanValue(input?.globalDiffusionEnabled, DEFAULT_LANGUAGE_LEARNING_CONFIG.globalDiffusionEnabled),
    maxSelectedExpressions: integerValue(input?.maxSelectedExpressions, 0, 3, DEFAULT_LANGUAGE_LEARNING_CONFIG.maxSelectedExpressions),
    vectorCandidateLimit: integerValue(input?.vectorCandidateLimit, 1, 100, DEFAULT_LANGUAGE_LEARNING_CONFIG.vectorCandidateLimit),
    preciseSelectorEnabled: booleanValue(input?.preciseSelectorEnabled, DEFAULT_LANGUAGE_LEARNING_CONFIG.preciseSelectorEnabled),
    feedbackLearningEnabled: booleanValue(input?.feedbackLearningEnabled, DEFAULT_LANGUAGE_LEARNING_CONFIG.feedbackLearningEnabled),
    groupExpressionLearningEnabled: booleanValue(input?.groupExpressionLearningEnabled, DEFAULT_LANGUAGE_LEARNING_CONFIG.groupExpressionLearningEnabled),
    groupJargonLearningEnabled: booleanValue(input?.groupJargonLearningEnabled, DEFAULT_LANGUAGE_LEARNING_CONFIG.groupJargonLearningEnabled),
    groupBehaviorLearningEnabled: booleanValue(input?.groupBehaviorLearningEnabled, DEFAULT_LANGUAGE_LEARNING_CONFIG.groupBehaviorLearningEnabled),
    groupPublicKnowledgeLearningEnabled: booleanValue(input?.groupPublicKnowledgeLearningEnabled, DEFAULT_LANGUAGE_LEARNING_CONFIG.groupPublicKnowledgeLearningEnabled),
    directLanguageCandidateLearningEnabled: booleanValue(input?.directLanguageCandidateLearningEnabled, DEFAULT_LANGUAGE_LEARNING_CONFIG.directLanguageCandidateLearningEnabled),
    promptLoggingEnabled: booleanValue(input?.promptLoggingEnabled, DEFAULT_LANGUAGE_LEARNING_CONFIG.promptLoggingEnabled),
    multiMessageReplyEnabled: booleanValue(input?.multiMessageReplyEnabled, DEFAULT_LANGUAGE_LEARNING_CONFIG.multiMessageReplyEnabled),
  }
}

/** Creates an empty, versioned social-language snapshot. */
export function createEmptySocialLanguageSnapshot(now = Date.now()): SocialLanguageSnapshot {
  return {
    version: 4,
    expressions: [],
    jargon: [],
    behaviors: [],
    publicKnowledge: [],
    decisions: [],
    observationBuffer: [],
    observationHistory: [],
    observationBatches: [],
    updatedAt: now,
    lastMaintenanceAt: now,
  }
}

/**
 * Migrates unknown persisted social-language data to the current snapshot.
 *
 * Before:
 * - `undefined`
 * - `{ expressions: [...] }`
 *
 * After:
 * - `{ version: 4, expressions: [...], observationHistory: [], ... }`
 */
export function migrateSocialLanguageSnapshot(input: unknown, now = Date.now()): SocialLanguageSnapshot {
  if (!isRecord(input))
    return createEmptySocialLanguageSnapshot(now)

  const sourceVersion = input.version === 4 ? 4 : input.version === 3 ? 3 : input.version === 2 ? 2 : 1
  const expressions = Array.isArray(input.expressions)
    ? input.expressions.filter(isLearnedExpression)
    : []
  const migratedExpressions = sourceVersion === 1
    ? mergeLegacyExpressions(expressions.map(repairLegacyExpressionStatus))
    : expressions

  return {
    version: 4,
    expressions: migratedExpressions,
    jargon: Array.isArray(input.jargon) ? input.jargon.filter(isJargonKnowledge) : [],
    behaviors: Array.isArray(input.behaviors) ? input.behaviors.filter(isLearnedSocialBehavior) : [],
    publicKnowledge: Array.isArray(input.publicKnowledge) ? input.publicKnowledge.filter(isPublicGroupKnowledge) : [],
    decisions: Array.isArray(input.decisions) ? input.decisions.filter(isLanguageDecisionLog) : [],
    observationBuffer: Array.isArray(input.observationBuffer)
      ? input.observationBuffer.filter(isSocialLanguageGroupObservation)
      : [],
    observationHistory: Array.isArray(input.observationHistory)
      ? input.observationHistory.filter(isSocialLanguageGroupObservation).slice(-50_000)
      : [],
    observationBatches: Array.isArray(input.observationBatches)
      ? input.observationBatches
          .filter(isSocialLanguageObservationBatch)
          .map(normalizeSocialLanguageObservationBatch)
          .slice(-200)
      : [],
    updatedAt: finiteNumber(input.updatedAt, now),
    lastMaintenanceAt: sourceVersion >= 2
      ? finiteNumber(input.lastMaintenanceAt, now)
      : now,
  }
}

function isSocialLanguageGroupObservation(value: unknown): value is SocialLanguageSnapshot['observationBuffer'][number] {
  return isRecord(value)
    && typeof value.eventId === 'string'
    && typeof value.messageId === 'string'
    && typeof value.sourceId === 'string'
    && typeof value.platform === 'string'
    && typeof value.platformInstanceId === 'string'
    && typeof value.groupId === 'string'
    && typeof value.senderId === 'string'
    && typeof value.senderName === 'string'
    && typeof value.text === 'string'
    && Number.isFinite(value.timestamp)
}

function isSocialLanguageObservationBatch(value: unknown): value is SocialLanguageSnapshot['observationBatches'][number] {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.sourceId === 'string'
    && Array.isArray(value.messageIds)
    && value.messageIds.every(item => typeof item === 'string')
    && Number.isFinite(value.messageCount)
    && Number.isFinite(value.processedAt)
    && (value.curator === 'model' || value.curator === 'pending')
    && (value.expressionIds === undefined || (Array.isArray(value.expressionIds) && value.expressionIds.every(item => typeof item === 'string')))
    && (value.jargonIds === undefined || (Array.isArray(value.jargonIds) && value.jargonIds.every(item => typeof item === 'string')))
    && (value.behaviorIds === undefined || (Array.isArray(value.behaviorIds) && value.behaviorIds.every(item => typeof item === 'string')))
    && (value.publicKnowledgeIds === undefined || (Array.isArray(value.publicKnowledgeIds) && value.publicKnowledgeIds.every(item => typeof item === 'string')))
    && (value.warning === undefined || typeof value.warning === 'string')
    && (value.recoveredAt === undefined || Number.isFinite(value.recoveredAt))
    && (value.recoveryBatchId === undefined || typeof value.recoveryBatchId === 'string')
}

function normalizeSocialLanguageObservationBatch(
  batch: SocialLanguageSnapshot['observationBatches'][number],
): SocialLanguageSnapshot['observationBatches'][number] {
  return {
    ...batch,
    expressionIds: batch.expressionIds ?? [],
    jargonIds: batch.jargonIds ?? [],
    behaviorIds: batch.behaviorIds ?? [],
    publicKnowledgeIds: batch.publicKnowledgeIds ?? [],
  }
}

function isPublicGroupKnowledge(value: unknown): value is SocialLanguageSnapshot['publicKnowledge'][number] {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.sourceId === 'string'
    && typeof value.content === 'string'
    && Array.isArray(value.sourceMessageIds)
    && value.sourceMessageIds.every(item => typeof item === 'string')
    && Number.isFinite(value.confidence)
    && Number.isFinite(value.observationCount)
    && Number.isFinite(value.firstSeenAt)
    && Number.isFinite(value.lastSeenAt)
    && ['candidate', 'active', 'rejected', 'archived'].includes(String(value.status))
}

/**
 * Runs at most one inactivity-decay pass per day.
 *
 * MaiBot updates expression activity during scheduled learning and selection.
 * Lumi keeps its feedback-aware lifecycle, but applies decay through the same
 * maintenance principle so ordinary messages cannot repeatedly decay a record.
 */
export function maintainSocialLanguageSnapshot(
  input: SocialLanguageSnapshot,
  now = Date.now(),
): SocialLanguageSnapshot {
  const snapshot = migrateSocialLanguageSnapshot(input, now)
  if (now - (snapshot.lastMaintenanceAt ?? 0) < SOCIAL_LANGUAGE_MAINTENANCE_INTERVAL_MS)
    return snapshot

  return {
    ...snapshot,
    expressions: snapshot.expressions.map(expression => decayLearnedExpression(expression, now)),
    updatedAt: now,
    lastMaintenanceAt: now,
  }
}

function repairLegacyExpressionStatus(expression: LearnedExpression): LearnedExpression {
  if (
    expression.status !== 'forgotten'
    || expression.explicitRejectionCount >= 3
    || expression.familiarity <= 0
  ) {
    return expression
  }

  return {
    ...expression,
    status: expression.observationCount >= 2 ? 'understood' : 'observed',
  }
}

/**
 * Consolidates v1 candidates split by model wording drift.
 *
 * Lumi v1 included situation and pragmatic wording in the identity key, so the
 * same phrase could be stored repeatedly. v2 follows MaiBot's count-first
 * evidence model and combines those observations without exposing source text.
 */
function mergeLegacyExpressions(expressions: LearnedExpression[]): LearnedExpression[] {
  const merged = new Map<string, LearnedExpression>()
  for (const expression of expressions) {
    const key = expressionSemanticKey(expression)
    const current = merged.get(key)
    if (!current) {
      merged.set(key, expression)
      continue
    }

    const observationCount = current.observationCount + expression.observationCount
    const explicitRejectionCount = current.explicitRejectionCount + expression.explicitRejectionCount
    merged.set(key, {
      ...current,
      phrase: current.phrase ?? expression.phrase,
      situation: expression.confidence > current.confidence ? expression.situation : current.situation,
      pragmaticFunction: expression.confidence > current.confidence
        ? expression.pragmaticFunction
        : current.pragmaticFunction,
      emotionalMeaning: current.emotionalMeaning ?? expression.emotionalMeaning,
      tone: current.tone ?? expression.tone,
      origin: {
        ...current.origin,
        messageIds: [...new Set([...current.origin.messageIds, ...expression.origin.messageIds])].slice(-64),
      },
      affinity: mergeAffinity(current.affinity, expression.affinity),
      familiarity: Math.min(1, Math.max(current.familiarity, expression.familiarity) + 0.04),
      ownership: Math.min(1, Math.max(current.ownership, expression.ownership) + 0.025),
      confidence: Math.max(current.confidence, expression.confidence),
      observationCount,
      useCount: current.useCount + expression.useCount,
      successfulUseCount: current.successfulUseCount + expression.successfulUseCount,
      awkwardUseCount: current.awkwardUseCount + expression.awkwardUseCount,
      explicitRejectionCount,
      firstSeenAt: Math.min(current.firstSeenAt, expression.firstSeenAt),
      lastSeenAt: Math.max(current.lastSeenAt, expression.lastSeenAt),
      lastUsedAt: Math.max(current.lastUsedAt ?? 0, expression.lastUsedAt ?? 0) || undefined,
      embedding: current.embedding ?? expression.embedding,
      status: explicitRejectionCount >= 3
        ? 'forgotten'
        : observationCount >= 2
          ? 'understood'
          : current.status,
    })
  }
  return [...merged.values()]
}

function mergeAffinity(left: SocialLanguageAffinity, right: SocialLanguageAffinity): SocialLanguageAffinity {
  return {
    global: Math.max(left.global, right.global),
    byPerson: mergeScoreMap(left.byPerson, right.byPerson),
    byConversation: mergeScoreMap(left.byConversation, right.byConversation),
    byPlatform: mergeScoreMap(left.byPlatform, right.byPlatform),
  }
}

function mergeScoreMap(left: Record<string, number>, right: Record<string, number>) {
  const result = { ...left }
  for (const [key, score] of Object.entries(right))
    result[key] = Math.max(result[key] ?? 0, score)
  return result
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback
}

function integerValue(value: unknown, minimum: number, maximum: number, fallback: number) {
  if (typeof value !== 'number' || !Number.isInteger(value))
    return fallback
  return Math.max(minimum, Math.min(maximum, value))
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isAffinity(value: unknown): value is SocialLanguageAffinity {
  if (!isRecord(value))
    return false
  return typeof value.global === 'number'
    && isRecord(value.byPerson)
    && isRecord(value.byConversation)
    && isRecord(value.byPlatform)
}

function isLearnedExpression(value: unknown): value is LearnedExpression {
  if (!isRecord(value) || !isRecord(value.origin))
    return false
  return typeof value.id === 'string'
    && typeof value.situation === 'string'
    && typeof value.pragmaticFunction === 'string'
    && typeof value.patternType === 'string'
    && typeof value.familiarity === 'number'
    && typeof value.ownership === 'number'
    && typeof value.confidence === 'number'
    && typeof value.observationCount === 'number'
    && typeof value.useCount === 'number'
    && typeof value.firstSeenAt === 'number'
    && typeof value.lastSeenAt === 'number'
    && typeof value.status === 'string'
    && Array.isArray(value.origin.messageIds)
    && (value.origin.source === 'human' || value.origin.source === 'lumi')
    && isAffinity(value.affinity)
}

function isJargonKnowledge(value: unknown): value is JargonKnowledge {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.term === 'string'
    && Array.isArray(value.meanings)
    && Array.isArray(value.pragmaticFunctions)
    && typeof value.lastSeenAt === 'number'
}

function isLearnedSocialBehavior(value: unknown): value is LearnedSocialBehavior {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.situation === 'string'
    && typeof value.action === 'string'
    && Array.isArray(value.originEvidenceIds)
    && typeof value.confidence === 'number'
    && typeof value.successCount === 'number'
    && typeof value.failureCount === 'number'
    && isAffinity(value.affinity)
}

function isLanguageDecisionLog(value: unknown): value is LanguageDecisionLog {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.timestamp === 'number'
    && typeof value.conversationId === 'string'
    && typeof value.platform === 'string'
    && isRecord(value.plannerIntent)
    && Array.isArray(value.retrievedExpressions)
    && Array.isArray(value.selectedExpressions)
    && Array.isArray(value.selectedBehaviors)
    && isRecord(value.generatedReply)
    && isRecord(value.actuallySentReply)
    && isRecord(value.validator)
}
