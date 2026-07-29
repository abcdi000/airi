import type {
  AgentLanguageReference,
  LanguageModelPort,
  LumiPromptTemplate,
  LumiPromptTemplateId,
  ReplyLanguageReferences,
  SocialLanguagePort,
} from '@proj-airi/lumi-agent-runtime'
import type {
  LanguageDecisionLog,
  LanguageLearningConfig,
  SocialLanguageTurnContext,
} from '@proj-airi/lumi-runtime'

import type { LumiServerDatabase } from './database'

import { randomUUID } from 'node:crypto'

import {
  createLumiPromptTemplate,
  lumiPromptTemplateMetadata,
  redactPromptMessages,
} from '@proj-airi/lumi-agent-runtime'
import {
  applyPreciseExpressionSelection,
  buildExpressionSelectorMessages,
  buildSocialLanguageFeedbackMessages,
  normalizeLanguageLearningConfig,
  parseSocialLanguageFeedbackOutput,
  projectCognitiveFeedbackToLanguage,
  retrieveExpressionCandidates,
  selectExpressionsLocally,
  selectPlannerSocialBehaviors,
  selectRelevantJargon,
  selectSocialBehaviors,
} from '@proj-airi/lumi-runtime'

import {
  applyServerLanguageFeedback,
  recordServerLanguageDecision,
} from './socialLanguage'

/**
 * Creates the server projection of Lumi's group-learned social language.
 *
 * Private turns can select and evaluate existing group candidates, but this
 * adapter never creates a new expression, behavior, jargon, or sticker item.
 */
export function createServerSocialLanguagePort(options: {
  database: LumiServerDatabase
  model: LanguageModelPort
  config?: Partial<LanguageLearningConfig>
  promptTemplates?: Partial<Record<LumiPromptTemplateId, LumiPromptTemplate>>
}): SocialLanguagePort {
  const config = normalizeLanguageLearningConfig(options.config)
  let writeTail = Promise.resolve()
  const serializeWrite = async (write: () => void): Promise<void> => {
    const task = writeTail.then(write)
    writeTail = task.catch(() => {})
    await task
  }

  return {
    async plannerReferences({ envelope, limit }) {
      if (!config.enabled)
        return []
      const snapshot = options.database.getSocialLanguageSnapshot()
      const behaviors = config.behaviorLearningEnabled
        ? selectPlannerSocialBehaviors(snapshot.behaviors, {
            personId: envelope.personId,
            conversationId: envelope.conversationId,
            platform: envelope.platform,
            conversationType: 'direct',
            currentUserText: envelope.text ?? '',
          }, limit)
        : []
      const normalizedText = (envelope.text ?? '').toLocaleLowerCase()
      const jargon = config.jargonLearningEnabled
        ? snapshot.jargon
            .filter(item => normalizedText.includes(item.term.toLocaleLowerCase()))
            .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
            .slice(0, limit)
        : []
      return [
        ...behaviors.map<AgentLanguageReference>(candidate => ({
          id: candidate.behavior.id,
          kind: 'behavior',
          content: `${candidate.behavior.situation} -> ${candidate.behavior.action}`,
          confidence: candidate.behavior.confidence,
        })),
        ...jargon.map<AgentLanguageReference>(item => ({
          id: item.id,
          kind: 'jargon',
          content: `${item.term}: ${item.meanings.map(meaning => meaning.meaning).join(' / ')}`,
          confidence: Math.max(0, ...item.meanings.map(meaning => meaning.confidence)),
        })),
      ].slice(0, Math.max(0, limit))
    },

    async replyReferences({ envelope, intent, limit, expressionSelectorEnabled }) {
      if (!config.enabled)
        return emptyReplyReferences()
      const snapshot = options.database.getSocialLanguageSnapshot()
      const context = turnContext(envelope, intent)
      const broad = config.expressionLearningEnabled
        ? retrieveExpressionCandidates(snapshot.expressions, context, config)
        : []
      let expressions = selectExpressionsLocally(broad, context, config)
      if (
        expressionSelectorEnabled
        && config.preciseSelectorEnabled
        && broad.length > 0
        && config.maxSelectedExpressions > 0
      ) {
        try {
          const override = options.promptTemplates?.expression_selector
          const messages = buildExpressionSelectorMessages(
            context,
            broad.map(candidate => candidate.expression),
            Math.min(limit, config.maxSelectedExpressions),
            override?.content,
          )
          const template = override ?? createLumiPromptTemplate(
            'expression_selector',
            messages[0]!.content,
          )
          const startedAt = Date.now()
          const raw = await options.model.generate(
            messages,
            'expression_selector',
          )
          const metadata = lumiPromptTemplateMetadata(template)
          options.database.recordSecurityAudit('agent-model-request', {
            turnId: `expression-selector:${envelope.eventId}`,
            purpose: 'expression_selector',
            durationMs: String(Date.now() - startedAt),
            promptId: metadata.id,
            promptVersion: metadata.version,
            promptHash: metadata.hash,
            messageCount: String(messages.length),
            ...(config.promptLoggingEnabled
              ? { promptMessages: JSON.stringify(redactPromptMessages(messages)) }
              : {}),
          })
          expressions = applyPreciseExpressionSelection(
            raw,
            broad,
            Math.min(limit, config.maxSelectedExpressions),
          ) ?? expressions
        }
        catch {
          // Model selection is optional; deterministic retrieval remains safe.
        }
      }
      const behaviors = config.behaviorLearningEnabled
        ? selectSocialBehaviors(snapshot.behaviors, context, Math.min(2, limit))
        : []
      const jargon = config.jargonLearningEnabled
        ? selectRelevantJargon(snapshot.jargon, context, Math.min(4, limit))
        : []
      return {
        expressions: expressions.slice(0, limit).map(candidate => ({
          id: candidate.expression.id,
          kind: 'expression',
          content: [
            candidate.expression.phrase,
            candidate.expression.situation,
            candidate.expression.pragmaticFunction,
          ].filter(Boolean).join(' · '),
          confidence: candidate.expression.confidence,
        })),
        behaviors: behaviors.map(candidate => ({
          id: candidate.behavior.id,
          kind: 'behavior',
          content: `${candidate.behavior.situation} -> ${candidate.behavior.action}`,
          confidence: candidate.behavior.confidence,
        })),
        jargon: jargon.map(item => ({
          id: item.id,
          kind: 'jargon',
          content: `${item.term}: ${item.meanings.map(meaning => meaning.meaning).join(' / ')}`,
          confidence: Math.max(0, ...item.meanings.map(meaning => meaning.confidence)),
        })),
      }
    },

    async observeDirectFeedback({ envelope, feedbackEvents }) {
      if (!config.enabled || !config.feedbackLearningEnabled)
        return
      const unresolved = options.database.getSocialLanguageSnapshot().decisions.findLast(decision =>
        decision.conversationId === envelope.conversationId
        && decision.personId === envelope.personId
        && decision.laterFeedback === undefined,
      )
      if (!unresolved)
        return
      let feedback = projectCognitiveFeedbackToLanguage(feedbackEvents)
      if (!feedback) {
        try {
          feedback = parseSocialLanguageFeedbackOutput(await options.model.generate(
            buildSocialLanguageFeedbackMessages({
              userText: envelope.text ?? '',
              decision: unresolved,
            }),
            'feedback',
          ))
        }
        catch {
          return
        }
      }
      if (!feedback)
        return
      await serializeWrite(() => {
        options.database.replaceSocialLanguageSnapshot(applyServerLanguageFeedback({
          snapshot: options.database.getSocialLanguageSnapshot(),
          conversationId: envelope.conversationId,
          personId: envelope.personId,
          userText: envelope.text ?? '',
          feedback,
          feedbackEvents,
          config,
        }))
      })
    },

    async recordSentReply({ envelope, intent, reply, selectedReferenceIds, replyerPromptSnapshot }) {
      if (!config.enabled)
        return
      await serializeWrite(() => {
        const snapshot = options.database.getSocialLanguageSnapshot()
        const selected = new Set(selectedReferenceIds)
        const selectedExpressions = snapshot.expressions.filter(item => selected.has(item.id))
        const selectedBehaviors = snapshot.behaviors.filter(item => selected.has(item.id))
        const selectedJargon = snapshot.jargon.filter(item => selected.has(item.id))
        const decision: LanguageDecisionLog = {
          id: randomUUID(),
          timestamp: Date.now(),
          personId: envelope.personId,
          conversationId: envelope.conversationId,
          platform: envelope.platform,
          plannerIntent: intent,
          retrievedExpressions: selectedExpressions.map(item => item.id),
          selectedExpressions: selectedExpressions.map(item => item.id),
          realizedExpressions: reply.appliedExpressionIds ?? [],
          selectedExpressionReasons: Object.fromEntries(
            selectedExpressions.map(item => [item.id, ['shared_agent_runtime:selected']]),
          ),
          selectedBehaviors: selectedBehaviors.map(item => item.id),
          selectedJargon: selectedJargon.map(item => item.id),
          replyerPromptSnapshot: config.promptLoggingEnabled
            ? replyerPromptSnapshot
            : undefined,
          generatedReply: reply,
          actuallySentReply: reply,
          emotionState: intent.emotion,
          defenseState: intent.defenseState,
          relationshipSnapshot: intent.attitude,
          validator: {
            passed: true,
            attempts: 1,
            issues: [],
            fallbackUsed: false,
          },
        }
        options.database.replaceSocialLanguageSnapshot(recordServerLanguageDecision({
          snapshot,
          decision,
        }))
      })
    },
  }
}

function turnContext(
  envelope: Parameters<SocialLanguagePort['replyReferences']>[0]['envelope'],
  intent: Parameters<SocialLanguagePort['replyReferences']>[0]['intent'],
): SocialLanguageTurnContext {
  return {
    now: Date.now(),
    personId: envelope.personId,
    conversationId: envelope.conversationId,
    platform: envelope.platform,
    conversationType: 'direct',
    currentUserText: envelope.text ?? '',
    replyIntent: intent,
    emotionTag: intent.emotion.primary,
    emotionIntensity: intent.emotion.intensity,
    defenseActive: intent.defenseState.active,
    refusalRequired: intent.defenseState.refusalRequired,
    recentAssistantTexts: [],
  }
}

function emptyReplyReferences(): ReplyLanguageReferences {
  return {
    expressions: [],
    behaviors: [],
    jargon: [],
  }
}
