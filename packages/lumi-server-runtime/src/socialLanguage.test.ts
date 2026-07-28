import {
  createEmptySocialLanguageSnapshot,
  createFallbackLumiReplyIntent,
  DEFAULT_LANGUAGE_LEARNING_CONFIG,
} from '@proj-airi/lumi-runtime'
import { describe, expect, it } from 'vitest'

import {
  applyServerLanguageFeedback,
  observeServerLanguageEvidence,
  recordServerLanguageDecision,
} from './socialLanguage'

const modelOutput = JSON.stringify({
  expressions: [{
    phrase: '这也能行',
    situation: '朋友聊天中对意外结果作出反应',
    pragmaticFunction: '用短句表达惊讶',
    patternType: 'reaction',
    confidence: 0.9,
  }],
  jargon: [{
    term: '炸了',
    meaning: '表示事情突然出问题或结果非常夸张',
    context: '朋友聊天',
    pragmaticFunctions: ['react'],
    confidence: 0.9,
  }],
  behaviors: [{
    situation: '对方分享意外结果',
    action: '先用短句接住情绪，再追问细节',
    expectedEffect: '保持自然互动',
    confidence: 0.9,
  }],
})

function evidence(sourceKind: 'chat' | 'group_chat') {
  return {
    messageId: `message-${sourceKind}`,
    text: '这也能行，真炸了',
    personId: 'doggy',
    conversationId: sourceKind === 'chat' ? 'direct-doggy' : 'learning-friends',
    platform: 'qq',
    timestamp: 100,
    source: 'human' as const,
    sourceKind,
    authorVerified: true,
  }
}

describe('server social-language candidate boundary', () => {
  /**
   * @example
   * A normal private turn leaves every candidate collection empty.
   */
  it('does not create candidates from direct chat by default', () => {
    const next = observeServerLanguageEvidence({
      snapshot: createEmptySocialLanguageSnapshot(0),
      evidence: evidence('chat'),
      config: DEFAULT_LANGUAGE_LEARNING_CONFIG,
      ingress: 'direct_turn',
      modelOutput,
    })

    expect(next.expressions).toEqual([])
    expect(next.jargon).toEqual([])
    expect(next.behaviors).toEqual([])
  })

  /**
   * @example
   * The same model output is accepted when it belongs to an authorized group batch.
   */
  it('creates candidates from the group observation ingress', () => {
    const next = observeServerLanguageEvidence({
      snapshot: createEmptySocialLanguageSnapshot(0),
      evidence: evidence('group_chat'),
      config: DEFAULT_LANGUAGE_LEARNING_CONFIG,
      ingress: 'group_observation',
      modelOutput,
    })

    expect(next.expressions).toHaveLength(1)
    expect(next.jargon).toHaveLength(1)
    expect(next.behaviors).toHaveLength(1)
  })

  /**
   * @example
   * Doggy's later praise strengthens a group-learned expression without creating a private candidate.
   */
  it('keeps direct feedback active for an existing group-learned candidate', () => {
    const learned = observeServerLanguageEvidence({
      snapshot: createEmptySocialLanguageSnapshot(0),
      evidence: evidence('group_chat'),
      config: DEFAULT_LANGUAGE_LEARNING_CONFIG,
      ingress: 'group_observation',
      modelOutput,
    })
    const expression = learned.expressions[0]!
    const phrase = expression.phrase ?? '这也能行'
    const withDecision = recordServerLanguageDecision({
      snapshot: learned,
      decision: {
        id: 'decision-1',
        timestamp: 200,
        personId: 'doggy',
        conversationId: 'direct-doggy',
        platform: 'qq',
        plannerIntent: createFallbackLumiReplyIntent({ rawDraft: phrase }),
        retrievedExpressions: [expression.id],
        selectedExpressions: [expression.id],
        realizedExpressions: [expression.id],
        selectedExpressionReasons: { [expression.id]: ['fits the turn'] },
        selectedBehaviors: [],
        generatedReply: { messages: [{ text: phrase }], appliedExpressionIds: [expression.id] },
        actuallySentReply: { messages: [{ text: phrase }], appliedExpressionIds: [expression.id] },
        emotionState: {},
        defenseState: {},
        validator: {
          passed: true,
          attempts: 1,
          issues: [],
          fallbackUsed: false,
        },
      },
    })
    const beforeFeedback = withDecision.expressions[0]!
    const afterFeedback = applyServerLanguageFeedback({
      snapshot: withDecision,
      conversationId: 'direct-doggy',
      personId: 'doggy',
      userText: '这句挺好',
      feedback: { explicitPraise: true },
      config: DEFAULT_LANGUAGE_LEARNING_CONFIG,
      now: 300,
    })

    expect(afterFeedback.expressions).toHaveLength(1)
    expect(afterFeedback.expressions[0]?.successfulUseCount).toBeGreaterThan(beforeFeedback.successfulUseCount)
    expect(afterFeedback.decisions[0]?.laterFeedback).toEqual({ explicitPraise: true })
  })
})
