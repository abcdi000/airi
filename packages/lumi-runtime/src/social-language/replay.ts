import type {
  LanguageDecisionLog,
  LearnedExpression,
  LearnedSocialBehavior,
  LumiReplyCharacterState,
  LumiReplyIntent,
  SocialLanguageTurnContext,
} from './types'

import { normalizeLanguageLearningConfig } from './config'
import { retrieveExpressionCandidates, selectExpressionsLocally, selectSocialBehaviors } from './selection'

export type LumiLanguageReplayVariant
  = | 'legacy'
    | 'new_replyer_only'
    | 'new_full_runtime'
    | 'new_full_runtime_expression'
    | 'new_full_runtime_expression_behavior'
    | 'new_full_runtime_expression_behavior_sticker'

/** One desensitized sample used by the offline language-decision replay tool. */
export interface LumiLanguageReplaySample {
  id: string
  intent: LumiReplyIntent
  legacyReply: string
  character: LumiReplyCharacterState
  context: Omit<SocialLanguageTurnContext, 'replyIntent'>
}

/** Deterministic replay projection used before optional model generation. */
export interface LumiLanguageReplayProjection {
  sampleId: string
  variant: LumiLanguageReplayVariant
  selectedExpressionIds: string[]
  selectedBehaviorIds: string[]
  selectedStickerIds: string[]
}

/**
 * Compares retrieval behavior for the four required offline replay variants.
 *
 * Model generation remains a host concern; this pure projection makes selection
 * and regression tests deterministic and runnable without external services.
 */
export function projectLumiLanguageReplay(input: {
  sample: LumiLanguageReplaySample
  expressions: LearnedExpression[]
  behaviors: LearnedSocialBehavior[]
  stickerCandidateIds?: string[]
}): LumiLanguageReplayProjection[] {
  const config = normalizeLanguageLearningConfig()
  const context: SocialLanguageTurnContext = {
    ...input.sample.context,
    replyIntent: input.sample.intent,
  }
  const selectedExpressions = selectExpressionsLocally(
    retrieveExpressionCandidates(input.expressions, context, config),
    context,
    config,
  )
  const selectedBehaviors = selectSocialBehaviors(input.behaviors, context)
  return [
    {
      sampleId: input.sample.id,
      variant: 'legacy',
      selectedExpressionIds: [],
      selectedBehaviorIds: [],
      selectedStickerIds: [],
    },
    {
      sampleId: input.sample.id,
      variant: 'new_replyer_only',
      selectedExpressionIds: [],
      selectedBehaviorIds: [],
      selectedStickerIds: [],
    },
    {
      sampleId: input.sample.id,
      variant: 'new_full_runtime',
      selectedExpressionIds: [],
      selectedBehaviorIds: [],
      selectedStickerIds: [],
    },
    {
      sampleId: input.sample.id,
      variant: 'new_full_runtime_expression',
      selectedExpressionIds: selectedExpressions.map(item => item.expression.id),
      selectedBehaviorIds: [],
      selectedStickerIds: [],
    },
    {
      sampleId: input.sample.id,
      variant: 'new_full_runtime_expression_behavior',
      selectedExpressionIds: selectedExpressions.map(item => item.expression.id),
      selectedBehaviorIds: selectedBehaviors.map(item => item.behavior.id),
      selectedStickerIds: [],
    },
    {
      sampleId: input.sample.id,
      variant: 'new_full_runtime_expression_behavior_sticker',
      selectedExpressionIds: selectedExpressions.map(item => item.expression.id),
      selectedBehaviorIds: selectedBehaviors.map(item => item.behavior.id),
      selectedStickerIds: [...(input.stickerCandidateIds ?? [])].slice(0, 1),
    },
  ]
}

/** Redacts prompt snapshots and visible text before exporting a replay decision. */
export function redactLanguageDecisionForReplay(decision: LanguageDecisionLog): LanguageDecisionLog {
  return {
    ...decision,
    replyerPromptSnapshot: undefined,
    generatedReply: {
      messages: decision.generatedReply.messages.map(message => ({ ...message, text: '[redacted]' })),
    },
    actuallySentReply: {
      messages: decision.actuallySentReply.messages.map(message => ({ ...message, text: '[redacted]' })),
    },
  }
}
