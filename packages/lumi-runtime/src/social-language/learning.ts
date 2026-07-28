import type {
  JargonKnowledge,
  JargonKnowledgeProposal,
  LanguageDecisionLog,
  LearnedBehaviorProposal,
  LearnedExpression,
  LearnedExpressionProposal,
  LearnedSocialBehavior,
  LumiLanguageFeedback,
  SocialLanguageAffinity,
  SocialLanguageEvidence,
} from './types'

import { clamp01, isRecord, parseJsonObject, stringArray, stringValue } from './json'

const EXCLUDED_SOURCES = new Set<SocialLanguageEvidence['sourceKind']>([
  'system',
  'tool',
  'planner',
  'memory_summary',
  'web',
  'subtitle',
  'forwarded',
  'code',
  'roleplay',
  'unknown',
])

/** Returns whether source provenance permits social-language learning. */
export function isTrustedSocialLanguageEvidence(evidence: SocialLanguageEvidence) {
  return evidence.authorVerified
    && !EXCLUDED_SOURCES.has(evidence.sourceKind)
    && evidence.text.trim().length >= 2
    && evidence.text.trim().length <= 4_000
}

export interface SocialLanguageLearningParseResult {
  valid: boolean
  expressions: LearnedExpressionProposal[]
  jargon: JargonKnowledgeProposal[]
  behaviors: LearnedBehaviorProposal[]
  warning?: string
}

/** Parses and validates model-curated expression, jargon, and behavior proposals. */
export function parseSocialLanguageLearningResult(raw: string): SocialLanguageLearningParseResult {
  const parsed = parseJsonObject(raw)
  if (!parsed) {
    return {
      valid: false,
      expressions: [],
      jargon: [],
      behaviors: [],
      warning: '模型没有返回可解析的 JSON 对象',
    }
  }

  if (
    !Array.isArray(parsed.expressions)
    || !Array.isArray(parsed.jargon)
    || !Array.isArray(parsed.behaviors)
  ) {
    return {
      valid: false,
      expressions: [],
      jargon: [],
      behaviors: [],
      warning: '模型输出缺少 expressions、jargon 或 behaviors 数组',
    }
  }

  const result = {
    expressions: parseExpressionProposals(parsed.expressions),
    jargon: parseJargonProposals(parsed.jargon),
    behaviors: parseBehaviorProposals(parsed.behaviors),
  }
  const rawProposalCount = parsed.expressions.length + parsed.jargon.length + parsed.behaviors.length
  const acceptedProposalCount = result.expressions.length + result.jargon.length + result.behaviors.length
  if (rawProposalCount > 0 && acceptedProposalCount === 0) {
    return {
      valid: false,
      ...result,
      warning: '模型返回了候选项，但字段或置信度不符合学习协议',
    }
  }
  return { valid: true, ...result }
}

/** Parses model-curated expression, jargon, and behavior proposals. */
export function parseSocialLanguageLearningOutput(raw: string): {
  expressions: LearnedExpressionProposal[]
  jargon: JargonKnowledgeProposal[]
  behaviors: LearnedBehaviorProposal[]
} {
  const { expressions, jargon, behaviors } = parseSocialLanguageLearningResult(raw)
  return { expressions, jargon, behaviors }
}

/** Creates or reinforces a persisted expression from one trusted observation. */
export function observeLearnedExpression(
  existing: LearnedExpression | undefined,
  proposal: LearnedExpressionProposal,
  evidence: SocialLanguageEvidence,
  id: string,
): LearnedExpression {
  const sourceMessageIds = evidence.sourceMessageIds?.length
    ? evidence.sourceMessageIds
    : [evidence.messageId]
  const affinity = existing?.affinity ?? createAffinity()
  const localBoost = evidence.source === 'human' ? 0.12 : 0.04
  if (evidence.personId)
    affinity.byPerson[evidence.personId] = clamp01((affinity.byPerson[evidence.personId] ?? 0) + localBoost)
  if (evidence.conversationId)
    affinity.byConversation[evidence.conversationId] = clamp01((affinity.byConversation[evidence.conversationId] ?? 0) + localBoost)
  if (evidence.platform)
    affinity.byPlatform[evidence.platform] = clamp01((affinity.byPlatform[evidence.platform] ?? 0) + localBoost)

  const observationCount = (existing?.observationCount ?? 0) + 1
  const sourceOwnership = evidence.source === 'lumi' ? 0.08 : 0.02
  const familiarity = clamp01((existing?.familiarity ?? 0) + 0.08 * proposal.confidence)
  const ownership = clamp01((existing?.ownership ?? sourceOwnership) + (observationCount > 1 ? 0.025 : 0))
  return {
    id: existing?.id ?? id,
    phrase: proposal.phrase ?? existing?.phrase,
    situation: proposal.situation,
    pragmaticFunction: proposal.pragmaticFunction,
    emotionalMeaning: proposal.emotionalMeaning ?? existing?.emotionalMeaning,
    tone: proposal.tone ?? existing?.tone,
    patternType: proposal.patternType,
    origin: {
      personId: existing?.origin.personId ?? evidence.personId,
      conversationId: existing?.origin.conversationId ?? evidence.conversationId,
      platform: existing?.origin.platform ?? evidence.platform,
      messageIds: [...new Set([...(existing?.origin.messageIds ?? []), ...sourceMessageIds])].slice(-64),
      source: existing?.origin.source ?? evidence.source,
    },
    affinity,
    familiarity,
    ownership,
    confidence: clamp01(Math.max(existing?.confidence ?? 0, proposal.confidence) + Math.min(0.15, observationCount * 0.01)),
    observationCount,
    useCount: existing?.useCount ?? 0,
    successfulUseCount: existing?.successfulUseCount ?? 0,
    awkwardUseCount: existing?.awkwardUseCount ?? 0,
    explicitRejectionCount: existing?.explicitRejectionCount ?? 0,
    firstSeenAt: existing?.firstSeenAt ?? evidence.timestamp,
    lastSeenAt: evidence.timestamp,
    lastUsedAt: existing?.lastUsedAt,
    embedding: existing?.embedding,
    status: expressionStatus({
      observationCount,
      familiarity,
      ownership,
      useCount: existing?.useCount ?? 0,
      successfulUseCount: existing?.successfulUseCount ?? 0,
      explicitRejectionCount: existing?.explicitRejectionCount ?? 0,
    }),
  }
}

/** Creates or reinforces one jargon meaning with explicit evidence IDs. */
export function observeJargonKnowledge(
  existing: JargonKnowledge | undefined,
  proposal: JargonKnowledgeProposal,
  evidence: SocialLanguageEvidence,
  id: string,
): JargonKnowledge {
  const sourceMessageIds = evidence.sourceMessageIds?.length
    ? evidence.sourceMessageIds
    : [evidence.messageId]
  const matching = existing?.meanings.find(item =>
    normalizeKey(item.meaning) === normalizeKey(proposal.meaning)
    && normalizeKey(item.context) === normalizeKey(proposal.context),
  )
  const meaning = {
    meaning: proposal.meaning,
    context: proposal.context,
    confidence: clamp01(Math.max(matching?.confidence ?? 0, proposal.confidence)),
    evidenceMessageIds: [...new Set([...(matching?.evidenceMessageIds ?? []), ...sourceMessageIds])].slice(-64),
  }
  return {
    id: existing?.id ?? id,
    term: proposal.term,
    meanings: [
      ...(existing?.meanings ?? []).filter(item => item !== matching),
      meaning,
    ].slice(-12),
    literalMeaning: proposal.literalMeaning ?? existing?.literalMeaning,
    pragmaticFunctions: [...new Set([...(existing?.pragmaticFunctions ?? []), ...proposal.pragmaticFunctions])].slice(0, 16),
    emotionalTone: proposal.emotionalTone ?? existing?.emotionalTone,
    communities: [...new Set([...(existing?.communities ?? []), ...(proposal.communities ?? [])])].slice(0, 16),
    lastSeenAt: evidence.timestamp,
  }
}

/** Creates or reinforces one learned social behavior. */
export function observeSocialBehavior(
  existing: LearnedSocialBehavior | undefined,
  proposal: LearnedBehaviorProposal,
  evidence: SocialLanguageEvidence,
  id: string,
): LearnedSocialBehavior {
  const sourceMessageIds = evidence.sourceMessageIds?.length
    ? evidence.sourceMessageIds
    : [evidence.messageId]
  const affinity = existing?.affinity ?? createAffinity()
  if (evidence.personId)
    affinity.byPerson[evidence.personId] = clamp01((affinity.byPerson[evidence.personId] ?? 0) + 0.08)
  if (evidence.conversationId)
    affinity.byConversation[evidence.conversationId] = clamp01((affinity.byConversation[evidence.conversationId] ?? 0) + 0.08)
  if (evidence.platform)
    affinity.byPlatform[evidence.platform] = clamp01((affinity.byPlatform[evidence.platform] ?? 0) + 0.06)
  return {
    id: existing?.id ?? id,
    situation: proposal.situation,
    action: proposal.action,
    expectedEffect: proposal.expectedEffect ?? existing?.expectedEffect,
    originEvidenceIds: [...new Set([...(existing?.originEvidenceIds ?? []), ...sourceMessageIds])].slice(-64),
    confidence: clamp01(Math.max(existing?.confidence ?? 0, proposal.confidence) + 0.01),
    affinity,
    successCount: existing?.successCount ?? 0,
    failureCount: existing?.failureCount ?? 0,
    lastAppliedAt: existing?.lastAppliedAt,
  }
}

/**
 * Resolves expressions that should receive feedback for a completed decision.
 *
 * Besides expressions selected before generation, this includes a new
 * Lumi-authored candidate when its phrase was actually sent in that decision.
 * That keeps novel wording in probation while allowing later human feedback to
 * turn it into an owned habit.
 */
export function expressionIdsForDecisionFeedback(
  expressions: LearnedExpression[],
  decision: LanguageDecisionLog,
): Set<string> {
  const expressionIds = expressionIdsActuallyUsed(expressions, decision)
  const sentText = decision.actuallySentReply.messages.map(message => message.text).join('\n').toLocaleLowerCase()
  for (const expression of expressions) {
    if (
      expression.origin.source === 'lumi'
      && expression.lastSeenAt >= decision.timestamp
      && expression.phrase
      && sentText.includes(expression.phrase.toLocaleLowerCase())
    ) {
      expressionIds.add(expression.id)
    }
  }
  return expressionIds
}

/**
 * Resolves expressions that were actually realized in visible output.
 *
 * Current Replyer decisions use consciousness-reported IDs. Older decisions
 * without that field fall back to exact visible phrase evidence instead of
 * treating every injected candidate as spoken.
 */
export function expressionIdsActuallyUsed(
  expressions: LearnedExpression[],
  decision: LanguageDecisionLog,
): Set<string> {
  const knownIds = new Set(expressions.map(expression => expression.id))
  if (decision.realizedExpressions) {
    return new Set(decision.realizedExpressions.filter(id =>
      knownIds.has(id) && decision.selectedExpressions.includes(id),
    ))
  }

  const sentText = decision.actuallySentReply.messages
    .map(message => message.text)
    .join('\n')
    .toLocaleLowerCase()
  return new Set(expressions.flatMap((expression) => {
    if (
      !decision.selectedExpressions.includes(expression.id)
      || !expression.phrase
      || !sentText.includes(expression.phrase.toLocaleLowerCase())
    ) {
      return []
    }
    return [expression.id]
  }))
}

/** Applies feedback to selected expressions without treating silence as failure. */
export function applyExpressionFeedback(
  expression: LearnedExpression,
  feedback: LumiLanguageFeedback,
  now = Date.now(),
): LearnedExpression {
  const positive = Number(Boolean(feedback.explicitPraise)) * 3
    + Number(Boolean(feedback.phraseEcho)) * 2
    + Number(Boolean(feedback.playfulContinuation))
  const negative = Number(Boolean(feedback.explicitRejection)) * 4
    + Number(Boolean(feedback.misunderstanding)) * 2
    + Number(Boolean(feedback.aiStyleComplaint)) * 2
  const successfulUseCount = expression.successfulUseCount + (positive > 0 ? 1 : 0)
  const awkwardUseCount = expression.awkwardUseCount + (negative > 0 ? 1 : 0)
  const explicitRejectionCount = expression.explicitRejectionCount + Number(Boolean(feedback.explicitRejection))
  const ownershipDelta = positive * 0.035 - negative * 0.06
  const familiarityDelta = positive * 0.025 - negative * 0.035
  const next: LearnedExpression = {
    ...expression,
    successfulUseCount,
    awkwardUseCount,
    explicitRejectionCount,
    ownership: clamp01(expression.ownership + ownershipDelta),
    familiarity: clamp01(expression.familiarity + familiarityDelta),
    lastUsedAt: expression.lastUsedAt ?? now,
  }
  return {
    ...next,
    status: expressionStatus({
      observationCount: next.observationCount,
      familiarity: next.familiarity,
      ownership: next.ownership,
      useCount: next.useCount,
      successfulUseCount: next.successfulUseCount,
      explicitRejectionCount,
    }),
  }
}

/** Applies use evidence immediately after a selected expression is sent. */
export function markExpressionUsed(expression: LearnedExpression, now = Date.now()): LearnedExpression {
  const next = {
    ...expression,
    useCount: expression.useCount + 1,
    lastUsedAt: now,
    familiarity: clamp01(expression.familiarity + 0.01),
  }
  return {
    ...next,
    status: expressionStatus({
      observationCount: next.observationCount,
      familiarity: next.familiarity,
      ownership: next.ownership,
      useCount: next.useCount,
      successfulUseCount: next.successfulUseCount,
      explicitRejectionCount: next.explicitRejectionCount,
    }),
  }
}

/**
 * Applies gradual probabilistic decay while preserving high-ownership habits.
 *
 * This does not hard-delete entries. Forgotten records remain auditable and can
 * be revived by later trusted observations.
 */
export function decayLearnedExpression(expression: LearnedExpression, now = Date.now()): LearnedExpression {
  const daysSinceSeen = Math.max(0, now - expression.lastSeenAt) / 86_400_000
  const daysSinceUsed = expression.lastUsedAt === undefined
    ? daysSinceSeen
    : Math.max(0, now - expression.lastUsedAt) / 86_400_000
  if (daysSinceSeen < 7 && daysSinceUsed < 7)
    return expression
  const ownershipShield = 0.25 + expression.ownership * 0.75
  const decay = Math.min(0.35, ((daysSinceSeen / 180) + (daysSinceUsed / 240)) * (1 - ownershipShield))
  const familiarity = clamp01(expression.familiarity - decay)
  const status: LearnedExpression['status'] = familiarity < 0.08
    ? 'forgotten'
    : familiarity < 0.2
      ? 'declining'
      : expression.status
  return { ...expression, familiarity, status }
}

/**
 * Produces the stable identity used to accumulate expression evidence.
 *
 * A concrete phrase remains the same candidate when a curator describes its
 * situation or pragmatic function differently on later turns. Structural
 * patterns without a phrase retain their contextual identity.
 */
export function expressionSemanticKey(proposal: LearnedExpressionProposal) {
  const phrase = normalizeKey(proposal.phrase ?? '')
  return phrase
    ? `phrase:${phrase}`
    : normalizeKey(`${proposal.patternType}:${proposal.situation}:${proposal.pragmaticFunction}`)
}

/** Stable semantic key used to merge behavior observations. */
export function behaviorSemanticKey(proposal: LearnedBehaviorProposal) {
  return normalizeKey(`${proposal.situation}:${proposal.action}`)
}

function parseExpressionProposals(value: unknown): LearnedExpressionProposal[] {
  if (!Array.isArray(value))
    return []
  return deduplicateExpressionProposals(value.flatMap((item) => {
    if (!isRecord(item))
      return []
    const situation = stringValue(item.situation, '', 600)
    const pragmaticFunction = stringValue(item.pragmaticFunction ?? item.pragmatic_function, '', 600)
    if (!situation || !pragmaticFunction)
      return []
    return [{
      phrase: stringValue(item.phrase, '', 160) || undefined,
      situation,
      pragmaticFunction,
      emotionalMeaning: stringValue(item.emotionalMeaning ?? item.emotional_meaning, '', 300) || undefined,
      tone: stringValue(item.tone, '', 160) || undefined,
      patternType: stringValue(item.patternType ?? item.pattern_type, 'sentence_pattern', 80),
      confidence: clamp01(item.confidence, 0.4),
    }]
  })).filter(item => item.confidence >= 0.35).slice(0, 12)
}

function parseJargonProposals(value: unknown): JargonKnowledgeProposal[] {
  if (!Array.isArray(value))
    return []
  return value.flatMap((item) => {
    if (!isRecord(item))
      return []
    const term = stringValue(item.term, '', 80)
    const meaning = stringValue(item.meaning, '', 600)
    const context = stringValue(item.context, '', 600)
    if (!term || !meaning || !context)
      return []
    return [{
      term,
      meaning,
      context,
      literalMeaning: stringValue(item.literalMeaning ?? item.literal_meaning, '', 300) || undefined,
      pragmaticFunctions: stringArray(item.pragmaticFunctions ?? item.pragmatic_functions, 12, 160),
      emotionalTone: stringValue(item.emotionalTone ?? item.emotional_tone, '', 160) || undefined,
      communities: stringArray(item.communities, 12, 160),
      confidence: clamp01(item.confidence, 0.4),
    }]
  }).filter(item => item.confidence >= 0.4).slice(0, 12)
}

function parseBehaviorProposals(value: unknown): LearnedBehaviorProposal[] {
  if (!Array.isArray(value))
    return []
  return value.flatMap((item) => {
    if (!isRecord(item))
      return []
    const situation = stringValue(item.situation, '', 600)
    const action = stringValue(item.action, '', 600)
    if (!situation || !action)
      return []
    return [{
      situation,
      action,
      expectedEffect: stringValue(item.expectedEffect ?? item.expected_effect, '', 600) || undefined,
      confidence: clamp01(item.confidence, 0.4),
    }]
  }).filter(item => item.confidence >= 0.4).slice(0, 8)
}

function deduplicateExpressionProposals(proposals: LearnedExpressionProposal[]) {
  const seen = new Set<string>()
  return proposals.filter((proposal) => {
    const key = expressionSemanticKey(proposal)
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

function expressionStatus(input: {
  observationCount: number
  familiarity: number
  ownership: number
  useCount: number
  successfulUseCount: number
  explicitRejectionCount: number
}): LearnedExpression['status'] {
  if (input.explicitRejectionCount >= 3)
    return 'forgotten'
  if (
    input.successfulUseCount >= 3
    && input.useCount >= 3
    && input.ownership >= 0.55
    && input.familiarity >= 0.5
  ) {
    return 'habit'
  }
  if (
    input.successfulUseCount >= 2
    && input.ownership >= 0.36
    && input.familiarity >= 0.35
  ) {
    return 'adopted'
  }
  if (
    input.successfulUseCount >= 1
    && input.ownership >= 0.16
    && input.familiarity >= 0.16
  ) {
    return 'trial'
  }
  if (input.useCount >= 1)
    return 'trial'
  if (input.observationCount >= 2)
    return 'understood'
  return 'observed'
}

function createAffinity(): SocialLanguageAffinity {
  return {
    global: 0.02,
    byPerson: {},
    byConversation: {},
    byPlatform: {},
  }
}

function normalizeKey(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}
