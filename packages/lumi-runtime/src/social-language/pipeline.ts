import type {
  JargonKnowledge,
  LanguageDecisionLog,
  LanguageLearningConfig,
  LearnedExpression,
  LearnedSocialBehavior,
  LumiLanguageModelMessage,
  LumiReplyCharacterState,
  LumiReplyIntent,
  LumiVisibleReply,
  SocialLanguageTurnContext,
} from './types'

import { projectLumiReplyerContext } from './context'
import { createFallbackLumiReplyIntent, parseLumiReplyIntent } from './intent'
import { buildLumiReplyerMessages } from './prompts/replyer'
import { buildExpressionSelectorMessages } from './prompts/selector'
import {
  applyPreciseExpressionSelection,
  retrieveExpressionCandidates,
  selectExpressionsLocally,
  selectRelevantJargon,
  selectSocialBehaviors,
} from './selection'
import { validateLumiVisibleReply } from './validator'
import { parseLumiVisibleReply, visibleReplyFromText } from './visible-reply'

/** Model boundary used by the shared Replyer and optional precise selector. */
export interface LumiSocialLanguageModelPort {
  /**
   * Generates one non-tool model response.
   *
   * @param messages Native system/user/assistant messages.
   * @param purpose Stable purpose for model routing and observability.
   */
  generate: (
    messages: LumiLanguageModelMessage[],
    purpose: 'replyer' | 'replyer_retry' | 'expression_selector',
  ) => Promise<string>
}

export interface RunLumiSocialLanguagePipelineInput {
  /** Raw structured Planner output after existing tool work completes. */
  plannerOutput: string
  /** Current-turn provider output used to recover intent when Planner JSON is malformed. */
  legacyDraft: string
  /** Authorized real conversation history. */
  history: LumiLanguageModelMessage[]
  character: LumiReplyCharacterState
  context: Omit<SocialLanguageTurnContext, 'replyIntent'>
  expressions: LearnedExpression[]
  jargon: JargonKnowledge[]
  behaviors: LearnedSocialBehavior[]
  config: LanguageLearningConfig
  model: LumiSocialLanguageModelPort
  createId?: () => string
  forbiddenPrivacyTokens?: string[]
  /** Maximum native dialogue tokens passed to final wording. @default 48000 */
  replyerHistoryTokens?: number
}

export interface LumiSocialLanguagePipelineResult {
  intent: LumiReplyIntent
  reply: LumiVisibleReply
  decision: LanguageDecisionLog
  selectedExpressionIds: string[]
  selectedBehaviorIds: string[]
  plannerFallbackUsed: boolean
  responseSource: 'replyer' | 'silence'
}

/**
 * Runs expression retrieval, independent Replyer generation, and validation.
 *
 * The function never invokes tools. Existing host tool execution must finish
 * before this boundary. Failed generation or validation returns silence rather
 * than replaying earlier model wording or inventing a runtime-authored reply.
 */
export async function runLumiSocialLanguagePipeline(
  input: RunLumiSocialLanguagePipelineInput,
): Promise<LumiSocialLanguagePipelineResult> {
  const parsedIntent = parseLumiReplyIntent(input.plannerOutput)
  const safeLegacyDraft = visibleLegacyDraft(input.legacyDraft)
  const intent = parsedIntent ?? createFallbackLumiReplyIntent({
    rawDraft: safeLegacyDraft,
    emotion: input.context.emotionTag,
    emotionIntensity: input.context.emotionIntensity,
    defenseActive: input.context.defenseActive,
    refusalRequired: input.context.refusalRequired,
  })
  const turnContext: SocialLanguageTurnContext = {
    ...input.context,
    replyIntent: intent,
  }
  const shouldGenerateReply = intent.shouldReply && intent.replyAct !== 'stay_silent'
  const broadCandidates = !shouldGenerateReply
    ? []
    : retrieveExpressionCandidates(input.expressions, turnContext, input.config)
  let selectedExpressions = !shouldGenerateReply
    ? []
    : selectExpressionsLocally(broadCandidates, turnContext, input.config)
  if (
    shouldGenerateReply && input.config.preciseSelectorEnabled
    && broadCandidates.length > 0
    && input.config.maxSelectedExpressions > 0
  ) {
    try {
      const rawSelection = await input.model.generate(
        buildExpressionSelectorMessages(turnContext, broadCandidates.map(candidate => candidate.expression), input.config.maxSelectedExpressions),
        'expression_selector',
      )
      const precise = applyPreciseExpressionSelection(rawSelection, broadCandidates, input.config.maxSelectedExpressions)
      if (precise)
        selectedExpressions = precise
    }
    catch {
      // Precise selection is optional; deterministic retrieval remains authoritative.
    }
  }
  const selectedBehaviorRecords = input.config.behaviorLearningEnabled && shouldGenerateReply
    ? selectSocialBehaviors(input.behaviors, turnContext)
    : []
  const selectedJargon = input.config.jargonLearningEnabled && shouldGenerateReply
    ? selectRelevantJargon(input.jargon, turnContext)
    : []

  const replyerContext = projectLumiReplyerContext({
    history: input.history,
    maxHistoryTokens: input.replyerHistoryTokens ?? 48_000,
  })
  const promptMessages = !shouldGenerateReply
    ? []
    : buildLumiReplyerMessages({
        character: input.character,
        sharedSystemPrompt: replyerContext.sharedSystemPrompt,
        history: replyerContext.history,
        continuitySummary: replyerContext.continuitySummary,
        omittedHistoryMessages: replyerContext.omittedMessageCount,
        intent,
        selectedExpressions,
        selectedBehaviors: selectedBehaviorRecords.map(item => item.behavior),
        jargon: selectedJargon,
        multiMessageEnabled: input.config.multiMessageReplyEnabled,
      })
  const allowedExpressionIds = selectedExpressions.map(candidate => candidate.expression.id)
  let attempts = 0
  let generatedReply: LumiVisibleReply = { messages: [] }
  let reply = generatedReply
  let issues: string[] = []
  let fallbackUsed = false
  let responseSource: LumiSocialLanguagePipelineResult['responseSource'] = 'replyer'

  if (!shouldGenerateReply) {
    generatedReply = { messages: [] }
    reply = generatedReply
    responseSource = 'silence'
  }
  else {
    try {
      attempts = 1
      const rawReply = await input.model.generate(promptMessages, 'replyer')
      generatedReply = parseLumiVisibleReply(rawReply, {
        multiMessageEnabled: input.config.multiMessageReplyEnabled,
        allowedExpressionIds,
      }) ?? visibleReplyFromText(rawReply)
      let validation = validateLumiVisibleReply({
        intent,
        reply: generatedReply,
        forbiddenPrivacyTokens: input.forbiddenPrivacyTokens,
        recentAssistantTexts: input.context.recentAssistantTexts,
      })
      reply = generatedReply
      issues = validation.issues

      if (!validation.passed) {
        attempts = 2
        const retryMessages = buildLumiReplyerMessages({
          character: input.character,
          sharedSystemPrompt: replyerContext.sharedSystemPrompt,
          history: replyerContext.history,
          continuitySummary: replyerContext.continuitySummary,
          omittedHistoryMessages: replyerContext.omittedMessageCount,
          intent,
          selectedExpressions,
          selectedBehaviors: selectedBehaviorRecords.map(item => item.behavior),
          jargon: selectedJargon,
          multiMessageEnabled: input.config.multiMessageReplyEnabled,
          validationIssues: validation.issues,
        })
        const retryRaw = await input.model.generate(retryMessages, 'replyer_retry')
        const retryReply = parseLumiVisibleReply(retryRaw, {
          multiMessageEnabled: input.config.multiMessageReplyEnabled,
          allowedExpressionIds,
        }) ?? visibleReplyFromText(retryRaw)
        validation = validateLumiVisibleReply({
          intent,
          reply: retryReply,
          forbiddenPrivacyTokens: input.forbiddenPrivacyTokens,
          recentAssistantTexts: input.context.recentAssistantTexts,
        })
        issues = validation.issues
        if (validation.passed) {
          generatedReply = retryReply
          reply = retryReply
        }
        else {
          fallbackUsed = true
          reply = { messages: [] }
        }
      }
    }
    catch {
      fallbackUsed = true
      reply = { messages: [] }
      issues = ['Replyer failed; no previous or runtime-authored wording was replayed.']
    }
  }

  const finalValidation = validateLumiVisibleReply({
    intent,
    reply,
    forbiddenPrivacyTokens: input.forbiddenPrivacyTokens,
    recentAssistantTexts: input.context.recentAssistantTexts,
  })
  if (!finalValidation.passed) {
    fallbackUsed = true
    reply = { messages: [] }
    issues = [...new Set([...issues, ...finalValidation.issues])]
  }
  if (!reply.messages.length)
    responseSource = 'silence'

  const decision: LanguageDecisionLog = {
    id: input.createId?.() ?? defaultId(),
    timestamp: input.context.now,
    personId: input.context.personId,
    conversationId: input.context.conversationId,
    platform: input.context.platform,
    plannerIntent: intent,
    retrievedExpressions: broadCandidates.map(candidate => candidate.expression.id),
    selectedExpressions: selectedExpressions.map(candidate => candidate.expression.id),
    realizedExpressions: reply.appliedExpressionIds ?? [],
    selectedExpressionReasons: Object.fromEntries(selectedExpressions.map(candidate => [candidate.expression.id, candidate.reasons])),
    selectedBehaviors: selectedBehaviorRecords.map(candidate => candidate.behavior.id),
    selectedJargon: selectedJargon.map(candidate => candidate.id),
    replyerPromptSnapshot: input.config.promptLoggingEnabled ? promptMessages : undefined,
    contextProjection: {
      replyerHistoryTokens: replyerContext.estimatedHistoryTokens,
      retainedHistoryMessages: replyerContext.history.length,
      omittedHistoryMessages: replyerContext.omittedMessageCount,
      continuitySummaryIncluded: Boolean(replyerContext.continuitySummary),
    },
    generatedReply,
    actuallySentReply: reply,
    emotionState: {
      primary: intent.emotion.primary,
      intensity: intent.emotion.intensity,
    },
    defenseState: intent.defenseState,
    relationshipSnapshot: {
      stance: intent.attitude.stance,
      towardTarget: intent.attitude.towardTarget,
      willingnessToHelp: intent.attitude.willingnessToHelp,
    },
    validator: {
      passed: validateLumiVisibleReply({
        intent,
        reply,
        forbiddenPrivacyTokens: input.forbiddenPrivacyTokens,
        recentAssistantTexts: input.context.recentAssistantTexts,
      }).passed,
      attempts,
      issues,
      fallbackUsed,
    },
  }
  return {
    intent,
    reply,
    decision,
    selectedExpressionIds: decision.selectedExpressions,
    selectedBehaviorIds: decision.selectedBehaviors,
    plannerFallbackUsed: !parsedIntent,
    responseSource,
  }
}

function defaultId() {
  return globalThis.crypto?.randomUUID?.() ?? `lumi-language-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Prevents Planner protocol documents from becoming user-visible fallback text.
 *
 * Before:
 * - `{"replyAct":"answer","keyPoints":["..."]}`
 *
 * After:
 * - `""`
 */
function visibleLegacyDraft(value: string) {
  const normalized = value.trim()
  if (!normalized)
    return ''
  if (
    normalized.startsWith('{')
    || normalized.startsWith('```')
    || /"(?:shouldReply|replyAct|semanticGoal|keyPoints|immutableConstraints)"\s*:/u.test(normalized)
  ) {
    return ''
  }
  return normalized
}
