import type {
  JargonKnowledge,
  LanguageLearningConfig,
  LearnedExpression,
  LearnedSocialBehavior,
  SelectedExpression,
  SelectedSocialBehavior,
  SocialLanguageTurnContext,
} from './types'

import { parseJsonObject, stringArray } from './json'

const SERIOUS_SCENE_TERMS = ['serious', 'grief', 'medical', 'legal', 'safety', '严肃', '悲伤', '危险', '求救']
const PLAYFUL_TYPES = new Set(['exaggeration', 'reaction', 'swear', 'jargon'])

/** Minimal pre-intent context used to retrieve learned participation behavior. */
export interface PlannerSocialBehaviorContext {
  personId?: string
  conversationId: string
  platform: string
  conversationType: 'direct' | 'group'
  currentUserText: string
}

/**
 * Performs broad deterministic retrieval and scoring before an optional model selector.
 *
 * Selection affinity is probabilistic only; it never expands memory authorization.
 */
export function retrieveExpressionCandidates(
  expressions: LearnedExpression[],
  context: SocialLanguageTurnContext,
  config: LanguageLearningConfig,
): SelectedExpression[] {
  if (!config.enabled || !config.expressionLearningEnabled || config.maxSelectedExpressions <= 0)
    return []

  const scored = expressions
    .filter(expression => expression.status !== 'observed' && expression.status !== 'forgotten')
    .map(expression => scoreExpression(expression, context, config.globalDiffusionEnabled))
    .sort((left, right) => right.score - left.score || right.expression.lastSeenAt - left.expression.lastSeenAt)

  const relevant = scored
    .filter(candidate => candidate.score >= 0.28)
    .slice(0, config.vectorCandidateLimit)
  const relevantIds = new Set(relevant.map(candidate => candidate.expression.id))

  // MaiBot keeps an exploration path between retrieval and its expression
  // selector. Deterministic code only offers safe, untried records here; the
  // consciousness model remains responsible for deciding whether to try one.
  const exploration = scored
    .filter(candidate =>
      candidate.expression.status === 'understood'
      && candidate.expression.useCount === 0
      && !relevantIds.has(candidate.expression.id)
      && !recentlyRepeated(candidate.expression, context),
    )
    .slice(0, Math.min(8, config.vectorCandidateLimit))
    .map(candidate => ({
      ...candidate,
      reasons: [...candidate.reasons, 'exploration_candidate:untried_understood'],
    }))

  return [...relevant, ...exploration]
}

/** Selects up to the configured number of broad candidates without forcing a result. */
export function selectExpressionsLocally(
  candidates: SelectedExpression[],
  context: SocialLanguageTurnContext,
  config: LanguageLearningConfig,
): SelectedExpression[] {
  const threshold = context.defenseActive || context.replyIntent.defenseState.active ? 0.55 : 0.42
  return candidates
    .filter(candidate => candidate.score >= threshold)
    .filter(candidate => !recentlyRepeated(candidate.expression, context))
    .slice(0, config.maxSelectedExpressions)
}

/** Parses the optional precise selector while retaining broad-score audit data. */
export function applyPreciseExpressionSelection(
  raw: string,
  candidates: SelectedExpression[],
  maximum: number,
): SelectedExpression[] | null {
  const parsed = parseJsonObject(raw)
  if (!parsed)
    return null
  const selectedIds = new Set(stringArray(parsed.selectedIds ?? parsed.selected_ids, maximum, 240))
  const reasons = parsed.reasons && typeof parsed.reasons === 'object' && !Array.isArray(parsed.reasons)
    ? parsed.reasons as Record<string, unknown>
    : {}
  return candidates
    .filter(candidate => selectedIds.has(candidate.expression.id))
    .slice(0, maximum)
    .map(candidate => ({
      ...candidate,
      reasons: [
        ...candidate.reasons,
        ...(candidate.expression.status === 'understood' && candidate.expression.useCount === 0
          ? ['consciousness_selected_trial']
          : []),
        typeof reasons[candidate.expression.id] === 'string'
          ? `precise_selector:${String(reasons[candidate.expression.id]).slice(0, 240)}`
          : 'precise_selector:selected',
      ],
    }))
}

/** Selects a small set of social behaviors relevant to the current turn. */
export function selectSocialBehaviors(
  behaviors: LearnedSocialBehavior[],
  context: SocialLanguageTurnContext,
  maximum = 2,
): SelectedSocialBehavior[] {
  return behaviors
    .map((behavior) => {
      const reasons: string[] = []
      let score = behavior.confidence * 0.35
      const semantic = lexicalSimilarity(
        `${context.currentUserText} ${context.replyIntent.expressionIntent.scene} ${context.replyIntent.replyAct}`,
        `${behavior.situation} ${behavior.action}`,
      )
      score += semantic * 0.35
      score += affinityScore(behavior.affinity, context) * 0.2
      const feedback = (behavior.successCount + 1) / (behavior.successCount + behavior.failureCount + 2)
      score += feedback * 0.1
      reasons.push(`semantic=${semantic.toFixed(2)}`, `feedback=${feedback.toFixed(2)}`)
      if (semantic < 0.08) {
        score *= 0.45
        reasons.push('scene_mismatch')
      }
      return { behavior, score, reasons }
    })
    .filter(candidate => candidate.score >= 0.38)
    .sort((left, right) => right.score - left.score)
    .slice(0, maximum)
}

/**
 * Selects learned participation hints before Planner creates a reply intent.
 *
 * This is deliberately independent from expression selection: behavior may
 * advise waiting, replying, asking, or staying out of a group conversation,
 * while later safety and authorization rules retain higher priority.
 */
export function selectPlannerSocialBehaviors(
  behaviors: LearnedSocialBehavior[],
  context: PlannerSocialBehaviorContext,
  maximum = 2,
): SelectedSocialBehavior[] {
  return behaviors
    .map((behavior) => {
      const semantic = lexicalSimilarity(
        `${context.conversationType} ${context.currentUserText}`,
        `${behavior.situation} ${behavior.action}`,
      )
      const affinity = affinityScore(behavior.affinity, context)
      const feedback = (behavior.successCount + 1) / (behavior.successCount + behavior.failureCount + 2)
      let score = behavior.confidence * 0.3 + semantic * 0.42 + affinity * 0.18 + feedback * 0.1
      const reasons = [
        `semantic=${semantic.toFixed(2)}`,
        `affinity=${affinity.toFixed(2)}`,
        `feedback=${feedback.toFixed(2)}`,
      ]
      if (semantic < 0.08) {
        score *= 0.4
        reasons.push('scene_mismatch')
      }
      return { behavior, score, reasons }
    })
    .filter(candidate => candidate.score >= 0.38)
    .sort((left, right) => right.score - left.score)
    .slice(0, maximum)
}

/** Retrieves only jargon whose term appears in the current turn or semantic goal. */
export function selectRelevantJargon(jargon: JargonKnowledge[], context: SocialLanguageTurnContext, maximum = 4) {
  const haystack = `${context.currentUserText}\n${context.replyIntent.semanticGoal}`.toLocaleLowerCase()
  return jargon
    .filter(item => haystack.includes(item.term.toLocaleLowerCase()))
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .slice(0, maximum)
}

function scoreExpression(
  expression: LearnedExpression,
  context: SocialLanguageTurnContext,
  globalDiffusionEnabled: boolean,
): SelectedExpression {
  const reasons: string[] = []
  const query = [
    context.currentUserText,
    context.replyIntent.replyAct,
    context.replyIntent.expressionIntent.scene,
    context.replyIntent.expressionIntent.tone,
    context.replyIntent.semanticGoal,
  ].join(' ')
  const document = [
    expression.phrase,
    expression.situation,
    expression.pragmaticFunction,
    expression.emotionalMeaning,
    expression.tone,
    expression.patternType,
  ].filter(Boolean).join(' ')
  const lexical = lexicalSimilarity(query, document)
  const vector = cosineSimilarity(context.queryEmbedding, expression.embedding)
  const semantic = vector === undefined
    ? lexical
    : Math.max(lexical * 0.7 + vector * 0.3, vector * 0.82)
  const affinity = affinityScore(expression.affinity, context)
  const recency = recencyScore(expression.lastSeenAt, context.now)
  const feedback = (expression.successfulUseCount + 1)
    / (expression.successfulUseCount + expression.awkwardUseCount + expression.explicitRejectionCount * 2 + 2)
  const ownership = expression.ownership
  const familiarity = expression.familiarity
  let score = semantic * 0.34
    + affinity * 0.18
    + recency * 0.1
    + feedback * 0.13
    + ownership * 0.15
    + familiarity * 0.1
  reasons.push(
    `semantic=${semantic.toFixed(2)}`,
    ...(vector === undefined ? [] : [`vector=${vector.toFixed(2)}`]),
    `affinity=${affinity.toFixed(2)}`,
    `ownership=${ownership.toFixed(2)}`,
    `familiarity=${familiarity.toFixed(2)}`,
  )

  if (!globalDiffusionEnabled && !hasLocalAffinity(expression, context)) {
    score *= 0.25
    reasons.push('global_diffusion_disabled')
  }
  if (isSeriousScene(context) && PLAYFUL_TYPES.has(expression.patternType)) {
    score *= 0.25
    reasons.push('serious_scene_penalty')
  }
  if (context.defenseActive && expression.tone && /warm|cute|撒娇|温柔/i.test(expression.tone)) {
    score *= 0.2
    reasons.push('defense_tone_conflict')
  }
  if (expression.status === 'observed') {
    score *= 0.55
    reasons.push('observation_only')
  }
  if (expression.status === 'declining') {
    score *= 0.7
    reasons.push('declining')
  }
  return { expression, score: clamp01(score), reasons }
}

function affinityScore(
  affinity: LearnedExpression['affinity'],
  context: Pick<SocialLanguageTurnContext, 'personId' | 'conversationId' | 'platform'>,
) {
  return clamp01(
    affinity.global * 0.35
    + (context.personId ? affinity.byPerson[context.personId] ?? 0 : 0) * 0.25
    + (affinity.byConversation[context.conversationId] ?? 0) * 0.25
    + (affinity.byPlatform[context.platform] ?? 0) * 0.15,
  )
}

function hasLocalAffinity(expression: LearnedExpression, context: SocialLanguageTurnContext) {
  return (context.personId ? expression.affinity.byPerson[context.personId] ?? 0 : 0) > 0.15
    || (expression.affinity.byConversation[context.conversationId] ?? 0) > 0.15
    || (expression.affinity.byPlatform[context.platform] ?? 0) > 0.15
}

function recentlyRepeated(expression: LearnedExpression, context: SocialLanguageTurnContext) {
  if (!expression.phrase || context.replyIntent.emotion.intensity >= 0.75)
    return false
  const normalized = expression.phrase.toLocaleLowerCase()
  return context.recentAssistantTexts.slice(-3).some(text => text.toLocaleLowerCase().includes(normalized))
}

function recencyScore(timestamp: number, now: number) {
  const days = Math.max(0, now - timestamp) / 86_400_000
  return Math.exp(-days / 30)
}

function isSeriousScene(context: SocialLanguageTurnContext) {
  const scene = `${context.replyIntent.expressionIntent.scene} ${context.currentUserText}`.toLocaleLowerCase()
  return SERIOUS_SCENE_TERMS.some(term => scene.includes(term))
}

function lexicalSimilarity(left: string, right: string) {
  const leftTokens = tokenize(left)
  const rightTokens = tokenize(right)
  if (!leftTokens.size || !rightTokens.size)
    return 0
  let matches = 0
  for (const token of leftTokens) {
    if (rightTokens.has(token))
      matches += 1
  }
  return matches / Math.sqrt(leftTokens.size * rightTokens.size)
}

function tokenize(text: string) {
  const normalized = text.toLocaleLowerCase()
  const tokens = normalized.match(/\p{Script=Han}{1,2}|[\p{L}\p{N}_]{2,}/gu) ?? []
  return new Set(tokens)
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value))
}

function cosineSimilarity(left?: number[], right?: number[]) {
  if (!left?.length || !right?.length || left.length !== right.length)
    return undefined
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftNorm += leftValue * leftValue
    rightNorm += rightValue * rightValue
  }
  if (leftNorm === 0 || rightNorm === 0)
    return undefined
  return clamp01((dot / Math.sqrt(leftNorm * rightNorm) + 1) / 2)
}
