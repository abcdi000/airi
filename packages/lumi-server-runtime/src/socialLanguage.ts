import type {
  LanguageDecisionLog,
  LanguageLearningConfig,
  LearnedBehaviorProposal,
  LearnedExpressionProposal,
  LumiLanguageFeedback,
  SocialLanguageEvidence,
  SocialLanguageSnapshot,
} from '@proj-airi/lumi-runtime'

import { randomUUID } from 'node:crypto'

import {
  applyExpressionFeedback,
  behaviorSemanticKey,
  canCreateSocialLanguageCandidates,
  expressionIdsActuallyUsed,
  expressionIdsForDecisionFeedback,
  expressionSemanticKey,
  isTrustedSocialLanguageEvidence,
  maintainSocialLanguageSnapshot,
  markExpressionUsed,
  migrateSocialLanguageSnapshot,
  observeJargonKnowledge,
  observeLearnedExpression,
  observeSocialBehavior,
  parseSocialLanguageLearningOutput,
} from '@proj-airi/lumi-runtime'

/**
 * Applies the next verified human turn as delayed feedback.
 *
 * Affinity is a ranking feature only. This function never grants access to a
 * memory, conversation, or person projection.
 */
export function applyServerLanguageFeedback(input: {
  snapshot: SocialLanguageSnapshot
  conversationId: string
  personId: string
  userText: string
  feedback?: LumiLanguageFeedback
  config: LanguageLearningConfig
  now?: number
}): SocialLanguageSnapshot {
  const snapshot = maintainSocialLanguageSnapshot(
    migrateSocialLanguageSnapshot(input.snapshot),
    input.now ?? Date.now(),
  )
  if (!input.config.enabled || !input.config.feedbackLearningEnabled)
    return snapshot
  const decisionIndex = snapshot.decisions.findLastIndex(decision =>
    decision.conversationId === input.conversationId
    && decision.personId === input.personId
    && decision.laterFeedback === undefined,
  )
  if (decisionIndex < 0)
    return snapshot

  const decision = snapshot.decisions[decisionIndex]
  if (!input.feedback)
    return snapshot
  const feedback = input.feedback
  const selectedExpressions = expressionIdsForDecisionFeedback(snapshot.expressions, decision)
  const selectedBehaviors = new Set(decision.selectedBehaviors)
  const positive = feedback.explicitPraise || feedback.phraseEcho || feedback.playfulContinuation
  const failed = feedback.explicitRejection || feedback.misunderstanding || feedback.aiStyleComplaint
  const succeeded = positive
  const now = input.now ?? Date.now()
  return {
    ...snapshot,
    expressions: snapshot.expressions.map((expression) => {
      if (!selectedExpressions.has(expression.id))
        return expression
      const updated = applyExpressionFeedback(expression, feedback, now)
      if (!input.config.globalDiffusionEnabled || !positive)
        return updated
      return {
        ...updated,
        affinity: {
          ...updated.affinity,
          global: Math.min(1, updated.affinity.global + 0.05),
        },
      }
    }),
    behaviors: snapshot.behaviors.map(behavior => selectedBehaviors.has(behavior.id)
      ? {
          ...behavior,
          successCount: behavior.successCount + Number(succeeded),
          failureCount: behavior.failureCount + Number(failed),
          confidence: Math.max(0, Math.min(1, behavior.confidence + Number(succeeded) * 0.03 - Number(failed) * 0.06)),
        }
      : behavior),
    decisions: snapshot.decisions.map((item, index) =>
      index === decisionIndex ? { ...item, laterFeedback: feedback } : item,
    ),
    updatedAt: now,
  }
}

/** Records one auditable decision and updates use counters. */
export function recordServerLanguageDecision(
  input: {
    snapshot: SocialLanguageSnapshot
    decision: LanguageDecisionLog
  },
): SocialLanguageSnapshot {
  const snapshot = maintainSocialLanguageSnapshot(
    migrateSocialLanguageSnapshot(input.snapshot),
    input.decision.timestamp,
  )
  const realizedExpressions = expressionIdsActuallyUsed(snapshot.expressions, input.decision)
  const selectedBehaviors = new Set(input.decision.selectedBehaviors)
  return {
    ...snapshot,
    expressions: snapshot.expressions.map(expression =>
      realizedExpressions.has(expression.id)
        ? markExpressionUsed(expression, input.decision.timestamp)
        : expression),
    behaviors: snapshot.behaviors.map(behavior =>
      selectedBehaviors.has(behavior.id)
        ? { ...behavior, lastAppliedAt: input.decision.timestamp }
        : behavior),
    decisions: [...snapshot.decisions, input.decision].slice(-500),
    updatedAt: input.decision.timestamp,
  }
}

/**
 * Learns only from verified human or Lumi-authored chat evidence.
 *
 * Semantic learning occurs only from consciousness-model output. Missing or
 * invalid model output leaves the snapshot unchanged.
 */
export function observeServerLanguageEvidence(input: {
  snapshot: SocialLanguageSnapshot
  evidence: SocialLanguageEvidence
  config: LanguageLearningConfig
  ingress: 'direct_turn' | 'group_observation'
  modelOutput?: string
}): SocialLanguageSnapshot {
  const snapshot = maintainSocialLanguageSnapshot(
    migrateSocialLanguageSnapshot(input.snapshot),
    input.evidence.timestamp,
  )
  if (
    !isTrustedSocialLanguageEvidence(input.evidence)
    || !canCreateSocialLanguageCandidates({
      config: input.config,
      evidence: input.evidence,
      ingress: input.ingress,
    })
  ) {
    return snapshot
  }
  if (input.evidence.source === 'lumi' && !input.config.selfExpressionLearningEnabled)
    return snapshot

  const parsed = input.modelOutput
    ? parseSocialLanguageLearningOutput(input.modelOutput)
    : { expressions: [], jargon: [], behaviors: [] }
  let next = snapshot
  if (input.config.expressionLearningEnabled) {
    for (const proposal of deduplicateExpressions(parsed.expressions))
      next = upsertExpression(next, proposal, input.evidence)
  }
  if (input.config.jargonLearningEnabled) {
    for (const proposal of parsed.jargon) {
      const existing = next.jargon.find(item => item.term.toLocaleLowerCase() === proposal.term.toLocaleLowerCase())
      const learned = observeJargonKnowledge(existing, proposal, input.evidence, existing?.id ?? randomUUID())
      next = { ...next, jargon: [...next.jargon.filter(item => item.id !== learned.id), learned] }
    }
  }
  if (input.config.behaviorLearningEnabled) {
    for (const proposal of parsed.behaviors)
      next = upsertBehavior(next, proposal, input.evidence)
  }
  return {
    ...next,
    updatedAt: input.evidence.timestamp,
  }
}

function upsertExpression(
  snapshot: SocialLanguageSnapshot,
  proposal: LearnedExpressionProposal,
  evidence: SocialLanguageEvidence,
) {
  const key = expressionSemanticKey(proposal)
  const existing = snapshot.expressions.find(item => expressionSemanticKey(item) === key)
  const learned = observeLearnedExpression(existing, proposal, evidence, existing?.id ?? randomUUID())
  return {
    ...snapshot,
    expressions: [...snapshot.expressions.filter(item => item.id !== learned.id), learned],
  }
}

function upsertBehavior(
  snapshot: SocialLanguageSnapshot,
  proposal: LearnedBehaviorProposal,
  evidence: SocialLanguageEvidence,
) {
  const key = behaviorSemanticKey(proposal)
  const existing = snapshot.behaviors.find(item => behaviorSemanticKey(item) === key)
  const learned = observeSocialBehavior(existing, proposal, evidence, existing?.id ?? randomUUID())
  return {
    ...snapshot,
    behaviors: [...snapshot.behaviors.filter(item => item.id !== learned.id), learned],
  }
}

function deduplicateExpressions(proposals: LearnedExpressionProposal[]) {
  const seen = new Set<string>()
  return proposals.filter((proposal) => {
    const key = expressionSemanticKey(proposal)
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}
