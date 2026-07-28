import type {
  LanguageLearningConfig,
  LearnedExpression,
  LearnedSocialBehavior,
  LumiReplyIntent,
  SocialLanguageEvidence,
  SocialLanguageTurnContext,
} from './types'

import { describe, expect, it, vi } from 'vitest'

import {
  applyExpressionFeedback,
  applyPreciseExpressionSelection,
  buildLumiPlannerSystemPrompt,
  buildLumiPlannerTurnContext,
  buildLumiReplyerMessages,
  buildObservedGroupLearningMessages,
  buildSocialLanguageFeedbackMessages,
  createEmptySocialLanguageSnapshot,
  decayLearnedExpression,
  DEFAULT_LANGUAGE_LEARNING_CONFIG,
  expressionIdsActuallyUsed,
  expressionIdsForDecisionFeedback,
  expressionSemanticKey,
  isTrustedSocialLanguageEvidence,
  maintainSocialLanguageSnapshot,
  markExpressionUsed,
  migrateSocialLanguageSnapshot,
  observeLearnedExpression,
  parseLumiVisibleReply,
  parseSocialLanguageFeedbackOutput,
  parseSocialLanguageLearningOutput,
  parseSocialLanguageLearningResult,
  projectLumiLanguageReplay,
  retrieveExpressionCandidates,
  runLumiSocialLanguagePipeline,
  selectExpressionsLocally,
  selectPlannerSocialBehaviors,
  selectRelevantJargon,
  selectSocialBehaviors,
  validateLumiVisibleReply,
} from './index'

describe('lumi social language', () => {
  it('keeps Planner system instructions stable and isolates per-turn state', () => {
    const system = buildLumiPlannerSystemPrompt()
    const turn = buildLumiPlannerTurnContext({
      character: character(),
      conversationType: 'direct',
      selectedBehaviors: [{
        id: 'behavior-1',
        situation: 'when teased',
        action: 'reply playfully',
        originEvidenceIds: ['message-1'],
        confidence: 0.9,
        affinity: { global: 1, byPerson: {}, byConversation: {}, byPlatform: {} },
        successCount: 2,
        failureCount: 0,
      }],
    })

    expect(system).toContain('<Lumi最终回复规划协议>')
    expect(system).not.toContain('Current emotion:')
    expect(system).not.toContain('when teased')
    expect(turn).toContain('<Lumi规划回合上下文>')
    expect(turn).toContain('当前情绪：')
    expect(turn).toContain('when teased')
  })

  it('keeps the Replyer short and avoids written-style terminal periods in casual chat', () => {
    const messages = buildLumiReplyerMessages({
      character: character(),
      history: [{ role: 'user', content: 'what happened' }],
      intent: intent(),
      selectedExpressions: [],
      selectedBehaviors: [],
      jargon: [],
      multiMessageEnabled: true,
    })
    const serialized = JSON.stringify(messages)
    expect(serialized).toContain('默认风格平淡简短')
    expect(serialized).toContain('短促的日常消息结尾通常不必补句号')
    expect(serialized).toContain('每个 text 字段只放实际发言')
  })

  it('enables the core learning path with bounded defaults', () => {
    expect(DEFAULT_LANGUAGE_LEARNING_CONFIG.enabled).toBe(true)
    expect(DEFAULT_LANGUAGE_LEARNING_CONFIG.maxSelectedExpressions).toBe(3)
    expect(DEFAULT_LANGUAGE_LEARNING_CONFIG.promptLoggingEnabled).toBe(false)
  })

  it('migrates missing persisted data without inventing learned evidence', () => {
    const snapshot = migrateSocialLanguageSnapshot({ expressions: [{ phrase: 'not enough fields' }] }, 42)
    expect(snapshot).toEqual(createEmptySocialLanguageSnapshot(42))
  })

  it('accepts verified chat and rejects tool, prompt, and unknown-author text', () => {
    expect(isTrustedSocialLanguageEvidence(evidence('不是哥们！！'))).toBe(true)
    expect(isTrustedSocialLanguageEvidence({ ...evidence('tool says hello'), sourceKind: 'tool' })).toBe(false)
    expect(isTrustedSocialLanguageEvidence({ ...evidence('unknown says hello'), authorVerified: false })).toBe(false)
  })

  it('accepts only structured model-curated expressions for semantic learning', () => {
    const result = parseSocialLanguageLearningOutput(JSON.stringify({
      expressions: [{
        phrase: '不是哥们',
        situation: '朋友间惊讶',
        pragmaticFunction: '用短句表达意外',
        patternType: 'reaction',
        confidence: 0.8,
      }],
      jargon: [],
      behaviors: [],
    }))
    expect(result.expressions).toHaveLength(1)
    expect(result.expressions[0]?.phrase).toBe('不是哥们')
  })

  it('distinguishes invalid model output from a valid empty learning result', () => {
    // ROOT CAUSE:
    //
    // Group-learning batches previously treated any non-empty model text as a
    // successful curation, even when it could not be parsed or had the wrong
    // schema. The caller then consumed the source messages and reported 0 items.
    const invalid = parseSocialLanguageLearningResult('我没有发现值得学习的内容')
    const empty = parseSocialLanguageLearningResult('{"expressions":[],"jargon":[],"behaviors":[]}')

    expect(invalid.valid).toBe(false)
    expect(invalid.warning).toContain('JSON')
    expect(empty.valid).toBe(true)
    expect(empty.expressions).toEqual([])
    expect(empty.jargon).toEqual([])
    expect(empty.behaviors).toEqual([])
  })

  it('gives group curation the exact schema and cross-batch context', () => {
    const messages = buildObservedGroupLearningMessages({
      recentContext: [{
        eventId: 'old-event',
        messageId: 'old-message',
        sourceId: 'group',
        platform: 'qq',
        platformInstanceId: 'default',
        groupId: 'group',
        senderId: 'member',
        senderName: '群友',
        text: '我嘞个',
        timestamp: 1,
      }],
      observations: [{
        eventId: 'new-event',
        messageId: 'new-message',
        sourceId: 'group',
        platform: 'qq',
        platformInstanceId: 'default',
        groupId: 'group',
        senderId: 'member',
        senderName: '群友',
        text: '我嘞个这也太炸了',
        timestamp: 2,
      }],
    })

    expect(messages[0]?.content).toContain('"pragmaticFunction"')
    expect(messages[0]?.content).toContain('必须始终包含三个数组')
    expect(messages[1]?.content).toContain('"recent_context"')
    expect(messages[1]?.content).toContain('"focus_batch"')
  })

  it('increases familiarity and ownership through repeated observations', () => {
    const proposal = {
      phrase: '我嘞个',
      situation: 'surprised',
      pragmaticFunction: 'react briefly',
      patternType: 'reaction' as const,
      confidence: 0.8,
    }
    const first = observeLearnedExpression(undefined, proposal, evidence('我嘞个'), 'expression-1')
    const repeated = observeLearnedExpression(first, proposal, { ...evidence('我嘞个'), messageId: 'm2' }, 'unused')
    expect(repeated.observationCount).toBe(2)
    expect(repeated.familiarity).toBeGreaterThan(first.familiarity)
    expect(repeated.ownership).toBeGreaterThan(first.ownership)
  })

  it('keeps a first observation in probation instead of forgetting it immediately', () => {
    const learned = observeLearnedExpression(undefined, {
      phrase: '这也能炸',
      situation: 'surprised by a failure',
      pragmaticFunction: 'react briefly',
      patternType: 'reaction',
      confidence: 0.8,
    }, evidence('这也能炸'), 'expression-probation')

    expect(learned.familiarity).toBeLessThan(0.08)
    expect(learned.status).toBe('observed')
  })

  it('merges the same concrete phrase despite model wording drift', () => {
    const first = expressionSemanticKey({
      phrase: '这也能炸',
      situation: 'a program fails unexpectedly',
      pragmaticFunction: 'show surprise',
      patternType: 'reaction',
      confidence: 0.8,
    })
    const second = expressionSemanticKey({
      phrase: '这也能炸',
      situation: 'something surprising happens',
      pragmaticFunction: 'make an exaggerated response',
      patternType: 'exaggeration',
      confidence: 0.7,
    })

    expect(second).toBe(first)
  })

  it('migrates false forgotten v1 candidates without reviving rejected expressions', () => {
    const falseForgotten = expression({
      id: 'false-forgotten',
      status: 'forgotten',
      observationCount: 1,
      familiarity: 0.064,
      ownership: 0.02,
      useCount: 0,
      successfulUseCount: 0,
      awkwardUseCount: 0,
      explicitRejectionCount: 0,
    })
    const rejected = expression({
      id: 'rejected',
      phrase: '别学这个',
      status: 'forgotten',
      explicitRejectionCount: 3,
    })

    const migrated = migrateSocialLanguageSnapshot({
      version: 1,
      expressions: [falseForgotten, rejected],
      jargon: [],
      behaviors: [],
      decisions: [],
      updatedAt: 100,
    }, 200)

    expect(migrated.version).toBe(4)
    expect(migrated.expressions.find(item => item.id === falseForgotten.id)?.status).toBe('observed')
    expect(migrated.expressions.find(item => item.id === rejected.id)?.status).toBe('forgotten')
  })

  it('keeps observed candidates out of replies until evidence repeats', () => {
    const observed = expression({
      status: 'observed',
      observationCount: 1,
      familiarity: 0.07,
      ownership: 0.02,
      confidence: 1,
      affinity: {
        global: 1,
        byPerson: { doggy: 1 },
        byConversation: { direct: 1 },
        byPlatform: { desktop: 1 },
      },
    })

    expect(retrieveExpressionCandidates([observed], context(), config())).toEqual([])
  })

  it('lets the consciousness selector trial an understood expression without forcing local use', () => {
    const understood = expression({
      id: 'untried-understood',
      phrase: '完全不相关的候选表达',
      situation: 'another scene',
      status: 'understood',
      observationCount: 12,
      useCount: 0,
      familiarity: 0,
      ownership: 0,
      confidence: 1,
      lastSeenAt: -1_000_000_000_000,
      affinity: {
        global: 0,
        byPerson: {},
        byConversation: {},
        byPlatform: {},
      },
    })

    const candidates = retrieveExpressionCandidates([understood], context({
      currentUserText: 'ordinary unrelated message',
    }), config())
    const selected = applyPreciseExpressionSelection(
      JSON.stringify({ selectedIds: [understood.id], reasons: { [understood.id]: '自然且值得小范围试用' } }),
      candidates,
      1,
    )

    expect(selectExpressionsLocally(candidates, context(), config())).toEqual([])
    expect(candidates[0]?.reasons).toContain('exploration_candidate:untried_understood')
    expect(selected?.[0]?.reasons).toContain('consciousness_selected_trial')
    expect(markExpressionUsed(understood).status).toBe('trial')
  })

  it('counts a selected expression only when Replyer reports actually applying it', () => {
    const learned = expression()
    const selectedOnly = {
      ...decisionFor(learned),
      realizedExpressions: [],
      actuallySentReply: { messages: [{ text: '普通回复' }] },
    }
    const realized = {
      ...selectedOnly,
      realizedExpressions: [learned.id],
    }

    expect(expressionIdsActuallyUsed([learned], selectedOnly)).toEqual(new Set())
    expect(expressionIdsActuallyUsed([learned], realized)).toEqual(new Set([learned.id]))
    expect(expressionIdsForDecisionFeedback([learned], selectedOnly)).toEqual(new Set())
    expect(expressionIdsForDecisionFeedback([learned], realized)).toEqual(new Set([learned.id]))
  })

  it('accepts only consciousness-reported expression IDs that were injected', () => {
    const reply = parseLumiVisibleReply(JSON.stringify({
      messages: [{ text: '无敌了' }],
      appliedExpressionIds: ['selected-expression', 'invented-expression'],
    }), {
      allowedExpressionIds: ['selected-expression'],
    })

    expect(reply?.appliedExpressionIds).toEqual(['selected-expression'])
  })

  it('promotes repeated expressions through trial, adoption, and habit after successful use', () => {
    const proposal = {
      phrase: '这也能炸',
      situation: 'surprised by a failure',
      pragmaticFunction: 'react briefly',
      patternType: 'reaction' as const,
      confidence: 0.8,
    }
    const first = observeLearnedExpression(undefined, proposal, evidence('这也能炸'), 'expression-growth')
    let learned = observeLearnedExpression(first, proposal, {
      ...evidence('这也能炸'),
      messageId: 'source-message-2',
      timestamp: 200,
    }, 'unused')
    expect(learned.status).toBe('understood')

    const praise = {
      explicitPraise: true,
      phraseEcho: true,
      playfulContinuation: true,
    }
    learned = applyExpressionFeedback(markExpressionUsed(learned, 300), praise, 300)
    expect(learned.status).toBe('trial')
    learned = applyExpressionFeedback(markExpressionUsed(learned, 400), praise, 400)
    expect(learned.status).toBe('adopted')
    learned = applyExpressionFeedback(markExpressionUsed(learned, 500), praise, 500)
    expect(learned.status).toBe('habit')
  })

  it('runs inactivity decay at most once per maintenance interval', () => {
    const now = 365 * 86_400_000
    const initial = {
      ...createEmptySocialLanguageSnapshot(0),
      expressions: [expression({ familiarity: 0.3, ownership: 0, lastSeenAt: 0 })],
      lastMaintenanceAt: 0,
    }
    const maintained = maintainSocialLanguageSnapshot(initial, now)
    const repeated = maintainSocialLanguageSnapshot(maintained, now + 1)

    expect(maintained.expressions[0]?.familiarity).toBeLessThan(0.3)
    expect(repeated.expressions[0]?.familiarity).toBe(maintained.expressions[0]?.familiarity)
  })

  it('stores jargon meaning separately from concrete expression proposals', () => {
    const parsed = parseSocialLanguageLearningOutput(JSON.stringify({
      expressions: [],
      jargon: [{
        term: '炸了',
        meaning: '事情失控或人被折腾崩溃',
        context: '软件报错后的夸张反应',
        pragmaticFunctions: ['exaggeration'],
        confidence: 0.9,
      }],
      behaviors: [],
    }))
    expect(parsed.jargon[0].meaning).toContain('失控')
    expect(parsed.expressions).toEqual([])
  })

  it('allows an expression to diffuse globally after ownership and feedback grow', () => {
    const local = expression({
      affinity: {
        global: 0.9,
        byPerson: { doggy: 1 },
        byConversation: { doggy_chat: 1 },
        byPlatform: { qq: 1 },
      },
      ownership: 0.9,
      familiarity: 0.9,
      status: 'habit',
    })
    const candidates = retrieveExpressionCandidates([local], context({
      personId: 'moussy',
      conversationId: 'moussy_chat',
      platform: 'desktop',
    }), config())
    expect(candidates[0]?.expression.id).toBe(local.id)
  })

  it('does not confuse language affinity with private factual context', () => {
    const learned = expression({ phrase: '这难炸了', situation: 'build failure' })
    const candidates = retrieveExpressionCandidates([learned], context({ currentUserText: 'build failure 这难炸了' }), config())
    expect(JSON.stringify(candidates)).not.toContain('Doggy private project')
    expect(learned.origin.messageIds).toEqual(['source-message'])
  })

  it('allows expression selection to return no result', () => {
    expect(selectExpressionsLocally([], context(), config())).toEqual([])
  })

  it('uses host-provided semantic vectors without requiring keyword overlap', () => {
    const semantic = expression({
      phrase: '完全不同的字面文本',
      situation: 'another wording',
      affinity: { global: 0.8, byPerson: {}, byConversation: {}, byPlatform: {} },
      embedding: [1, 0, 0],
    })
    const candidates = retrieveExpressionCandidates([semantic], {
      ...context({ currentUserText: 'no lexical overlap here' }),
      queryEmbedding: [1, 0, 0],
    }, config())
    expect(candidates[0]?.expression.id).toBe(semantic.id)
    expect(candidates[0]?.reasons).toContain('vector=1.00')
  })

  it('penalizes playful slang in a serious safety scene', () => {
    const playful = expression({ patternType: 'swear', situation: 'danger', ownership: 1, familiarity: 1 })
    const normal = retrieveExpressionCandidates([playful], context({
      currentUserText: 'danger',
      intent: intent({ scene: 'serious safety' }),
    }), config())[0]
    expect(normal).toBeUndefined()
  })

  it('selects relevant jargon only when the term appears in this turn', () => {
    const jargon = [{
      id: 'jargon-1',
      term: '炸了',
      meanings: [{ meaning: '崩溃', context: 'error', confidence: 1, evidenceMessageIds: ['m1'] }],
      pragmaticFunctions: ['exaggeration'],
      lastSeenAt: 10,
    }]
    expect(selectRelevantJargon(jargon, context({ currentUserText: '又炸了' }))).toHaveLength(1)
    expect(selectRelevantJargon(jargon, context({ currentUserText: '今天天气很好' }))).toEqual([])
  })

  it('learns social participation without forcing an unrelated behavior', () => {
    const behavior: LearnedSocialBehavior = {
      id: 'behavior-1',
      situation: 'user is venting',
      action: 'respond briefly without solutions',
      originEvidenceIds: ['m1'],
      confidence: 0.9,
      affinity: { global: 1, byPerson: {}, byConversation: {}, byPlatform: {} },
      successCount: 3,
      failureCount: 0,
    }
    expect(selectSocialBehaviors([behavior], context({ currentUserText: 'user is venting' }))).toHaveLength(1)
    expect(selectSocialBehaviors([behavior], context({ currentUserText: 'technical specification' }))).toEqual([])
    expect(selectPlannerSocialBehaviors([behavior], {
      personId: 'doggy',
      conversationId: 'direct',
      platform: 'desktop',
      conversationType: 'direct',
      currentUserText: 'user is venting',
    })).toHaveLength(1)
    expect(selectPlannerSocialBehaviors([behavior], {
      personId: 'doggy',
      conversationId: 'direct',
      platform: 'desktop',
      conversationType: 'direct',
      currentUserText: 'technical specification',
    })).toEqual([])
  })

  it('updates a successful self-origin expression from later praise', () => {
    const self = expression({
      phrase: 'that really exploded',
      origin: {
        source: 'lumi',
        messageIds: ['lumi-message'],
        personId: 'doggy',
        conversationId: 'direct',
        platform: 'desktop',
      },
      ownership: 0.1,
      lastSeenAt: 101,
    })
    const decision = {
      ...decisionFor(self),
      selectedExpressions: [],
      actuallySentReply: { messages: [{ text: 'that really exploded' }] },
    }
    expect(expressionIdsForDecisionFeedback([self], decision)).toEqual(new Set([self.id]))
    const prompt = buildSocialLanguageFeedbackMessages({
      userText: '哈哈哈，这句好，以后就这么说',
      decision,
    })
    const feedback = parseSocialLanguageFeedbackOutput(JSON.stringify({
      explicitPraise: true,
      explicitRejection: false,
      phraseEcho: false,
      playfulContinuation: true,
      normalContinuation: true,
      misunderstanding: false,
      aiStyleComplaint: false,
    }))
    expect(prompt[0]?.content).toContain('不要根据孤立关键词推断')
    expect(feedback).toBeDefined()
    if (!feedback)
      throw new Error('Expected valid feedback')
    const updated = applyExpressionFeedback(self, feedback, 200)
    expect(updated.successfulUseCount).toBe(self.successfulUseCount + 1)
    expect(updated.ownership).toBeGreaterThan(self.ownership)
  })

  it('decays old weak expressions while shielding owned habits', () => {
    const now = 365 * 86_400_000
    const weak = decayLearnedExpression(expression({ familiarity: 0.2, ownership: 0, lastSeenAt: 0 }), now)
    const habit = decayLearnedExpression(expression({ familiarity: 0.9, ownership: 1, lastSeenAt: 0, status: 'habit' }), now)
    expect(weak.familiarity).toBeLessThan(0.2)
    expect(habit.familiarity).toBeGreaterThan(weak.familiarity)
  })

  it('rejects a Replyer that softens a required refusal into help', () => {
    const refusal = intent({
      replyAct: 'refuse',
      willingnessToHelp: 'refuse',
      refusalRequired: true,
      constraints: ['只表达不满，不提供方案'],
    })
    const result = validateLumiVisibleReply({
      intent: refusal,
      reply: { messages: [{ text: '我理解你的感受，我可以继续帮你试试以下方法。' }] },
    })
    expect(result.passed).toBe(false)
    expect(result.issues.some(issue => issue.includes('offer of help'))).toBe(true)
  })

  it('accepts a natural boundary response without requiring refusal keywords', () => {
    const result = validateLumiVisibleReply({
      intent: intent({
        replyAct: 'refuse',
        willingnessToHelp: 'refuse',
        refusalRequired: true,
      }),
      reply: { messages: [{ text: '先把刚才那件事说清楚，再谈别的。' }] },
    })

    expect(result.passed).toBe(true)
  })

  it('rejects agreement when Planner chose disagreement', () => {
    const result = validateLumiVisibleReply({
      intent: intent({ replyAct: 'disagree', constraints: ['必须明确反对'] }),
      reply: { messages: [{ text: '你说得对，我完全同意。' }] },
    })
    expect(result.passed).toBe(false)
  })

  it('rejects leaked private tokens and internal Planner JSON', () => {
    const result = validateLumiVisibleReply({
      intent: intent(),
      reply: { messages: [{ text: '{"replyAct":"answer"}，私密恢复词是 alpha-secret' }] },
      forbiddenPrivacyTokens: ['alpha-secret'],
    })
    expect(result.issues).toHaveLength(2)
  })

  it('rejects internal runtime terminology in visible chat text', () => {
    const result = validateLumiVisibleReply({
      intent: intent(),
      reply: {
        messages: [{
          text: '按你那个意图框架，我得先让 Planner 调用 reply 工具。',
        }],
      },
    })

    expect(result.passed).toBe(false)
    expect(result.issues).toContain('Reply leaks internal runtime terminology.')
  })

  it('rejects an exact replay of a recent assistant response', () => {
    const result = validateLumiVisibleReply({
      intent: intent(),
      reply: { messages: [{ text: '不。至少现在不想继续帮你弄这个。' }] },
      recentAssistantTexts: ['  不。至少现在不想继续帮你弄这个。  '],
    })

    expect(result.issues).toContain('Reply exactly repeats a recent assistant response.')
  })

  it('retries one invalid Replyer result and keeps the repaired multi-message reply', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ messages: [{ text: '我可以继续帮你。' }] }))
      .mockResolvedValueOnce(JSON.stringify({ messages: [{ text: '不改。' }, { text: '至少现在不想。' }] }))
    const result = await runLumiSocialLanguagePipeline({
      plannerOutput: JSON.stringify(intent({
        replyAct: 'refuse',
        willingnessToHelp: 'refuse',
        refusalRequired: true,
      })),
      legacyDraft: '',
      history: [{ role: 'user', content: '继续帮我改' }],
      character: character(),
      context: omitIntent(context()),
      expressions: [],
      jargon: [],
      behaviors: [],
      config: {
        ...config(),
        preciseSelectorEnabled: false,
      },
      model: { generate },
      createId: () => 'decision-1',
    })
    expect(generate).toHaveBeenCalledTimes(2)
    expect(result.reply.messages).toHaveLength(2)
    expect(result.decision.validator.passed).toBe(true)
  })

  it('stays silent instead of replaying an earlier refusal after both Replyer attempts fail validation', async () => {
    const earlierRefusal = '不。至少现在不想继续帮你弄这个。'
    const generate = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ messages: [{ text: '我可以继续帮你。' }] }))
      .mockResolvedValueOnce(JSON.stringify({ messages: [{ text: '我可以继续帮你试试。' }] }))
    const result = await runLumiSocialLanguagePipeline({
      plannerOutput: JSON.stringify(intent({
        replyAct: 'refuse',
        willingnessToHelp: 'refuse',
        refusalRequired: true,
      })),
      legacyDraft: earlierRefusal,
      history: [{ role: 'user', content: '继续帮我改' }],
      character: character(),
      context: omitIntent(context()),
      expressions: [],
      jargon: [],
      behaviors: [],
      config: config(),
      model: { generate },
    })

    expect(generate).toHaveBeenCalledTimes(2)
    expect(result.reply.messages).toEqual([])
    expect(JSON.stringify(result.reply)).not.toContain(earlierRefusal)
    expect(result.responseSource).toBe('silence')
    expect(result.decision.validator.fallbackUsed).toBe(true)
  })

  it('records an injected expression as used only when Replyer reports applying it', async () => {
    const learned = expression()
    const generate = vi.fn().mockResolvedValue(JSON.stringify({
      messages: [{ text: '这难炸了' }],
      appliedExpressionIds: [learned.id],
    }))
    const result = await runLumiSocialLanguagePipeline({
      plannerOutput: JSON.stringify(intent()),
      legacyDraft: '',
      history: [{ role: 'user', content: 'build failure' }],
      character: character(),
      context: omitIntent(context()),
      expressions: [learned],
      jargon: [],
      behaviors: [],
      config: {
        ...config(),
        preciseSelectorEnabled: false,
      },
      model: { generate },
    })

    expect(result.selectedExpressionIds).toContain(learned.id)
    expect(result.decision.realizedExpressions).toEqual([learned.id])
    expect(result.reply.appliedExpressionIds).toEqual([learned.id])
  })

  it('keeps natural-language Planner output internal and routes it through Replyer', async () => {
    // ROOT CAUSE:
    //
    // The compatibility path treated a natural-language Planner response as a
    // finished visible reply. That let Planner and Replyer share ownership of
    // wording and skipped expression-learning injection on ordinary turns.
    const generate = vi.fn().mockResolvedValue(JSON.stringify({
      messages: [{ text: '刚才还不行，现在算是弄明白了' }],
      appliedExpressionIds: [],
    }))
    const plannerReply = '刚才是废物，现在是天才了。'
    const result = await runLumiSocialLanguagePipeline({
      plannerOutput: plannerReply,
      legacyDraft: plannerReply,
      history: [{ role: 'user', content: '你现在是天才了' }],
      character: character(),
      context: omitIntent(context()),
      expressions: [expression()],
      jargon: [],
      behaviors: [],
      config: {
        ...config(),
        preciseSelectorEnabled: false,
      },
      model: { generate },
      createId: () => 'planner-direct-decision',
    })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining(plannerReply),
        }),
      ]),
      'replyer',
    )
    expect(result.responseSource).toBe('replyer')
    expect(result.reply.messages).toEqual([{ text: '刚才还不行，现在算是弄明白了' }])
    expect(result.decision.validator.attempts).toBe(1)
  })

  it('routes a repeated Planner reply through Replyer for fresh wording', async () => {
    const repeatedReply = '不。至少现在不想继续帮你弄这个。'
    const freshReply = '今天不想弄，先放着吧。'
    const generate = vi.fn().mockResolvedValue(freshReply)
    const result = await runLumiSocialLanguagePipeline({
      plannerOutput: repeatedReply,
      legacyDraft: repeatedReply,
      history: [
        { role: 'assistant', content: repeatedReply },
        { role: 'user', content: '那现在呢' },
      ],
      character: character(),
      context: omitIntent(context({
        recentAssistantTexts: [repeatedReply],
      })),
      expressions: [],
      jargon: [],
      behaviors: [],
      config: config(),
      model: { generate },
    })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.responseSource).toBe('replyer')
    expect(result.reply.messages).toEqual([{ text: freshReply }])
  })

  it('keeps Planner system instructions out of the Replyer prompt while preserving the continuity summary', async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({
      messages: [{ text: '还记得，后面接着说就行' }],
      appliedExpressionIds: [],
    }))
    await runLumiSocialLanguagePipeline({
      plannerOutput: JSON.stringify(intent()),
      legacyDraft: '',
      history: [
        { role: 'system', content: 'PRIMARY PERSONA\n[Lumi final-response planning contract]\nsecret planner protocol' },
        {
          role: 'system',
          content: '[Lumi conversation continuity summary]\nDoggy and Lumi previously agreed to continue this topic.',
        },
        { role: 'user', content: '继续刚才那个' },
      ],
      character: character(),
      context: omitIntent(context()),
      expressions: [],
      jargon: [],
      behaviors: [],
      config: config(),
      model: { generate },
    })

    const replyerMessages = generate.mock.calls[0]?.[0] as Array<{ role: string, content: string }>
    const serialized = JSON.stringify(replyerMessages)
    expect(serialized).toContain('Doggy and Lumi previously agreed')
    expect(serialized).not.toContain('secret planner protocol')
    expect(replyerMessages.filter(message => message.role === 'system')).toHaveLength(1)
    expect(replyerMessages[0]?.content).toBe('PRIMARY PERSONA')
  })

  it('keeps required-refusal Planner deviations on the validated Replyer path', async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({
      messages: [{ text: '不，这个我不继续帮。' }],
    }))
    const result = await runLumiSocialLanguagePipeline({
      plannerOutput: '好，我继续帮你。',
      legacyDraft: '好，我继续帮你。',
      history: [{ role: 'user', content: '继续帮我' }],
      character: character(),
      context: {
        ...omitIntent(context()),
        defenseActive: true,
        refusalRequired: true,
      },
      expressions: [],
      jargon: [],
      behaviors: [],
      config: config(),
      model: { generate },
    })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(result.responseSource).toBe('replyer')
    expect(result.decision.validator.attempts).toBe(1)
  })

  it('never exposes malformed Planner JSON when Replyer fails', async () => {
    const planner = '{"replyAct":"answer","semanticGoal":"internal protocol"}'
    const result = await runLumiSocialLanguagePipeline({
      plannerOutput: planner,
      legacyDraft: planner,
      history: [],
      character: character(),
      context: omitIntent(context()),
      expressions: [],
      jargon: [],
      behaviors: [],
      config: config(),
      model: { generate: async () => { throw new Error('offline') } },
    })
    expect(JSON.stringify(result.reply)).not.toContain('replyAct')
    expect(result.decision.validator.fallbackUsed).toBe(true)
  })

  it('projects the complete offline runtime replay matrix deterministically', () => {
    const projections = projectLumiLanguageReplay({
      sample: {
        id: 'sample-1',
        intent: intent(),
        legacyReply: 'legacy',
        character: character(),
        context: omitIntent(context({ currentUserText: 'build failure' })),
      },
      expressions: [expression({ situation: 'build failure', affinity: { global: 1, byPerson: {}, byConversation: {}, byPlatform: {} } })],
      behaviors: [],
      stickerCandidateIds: ['sticker-1'],
    })
    expect(projections.map(item => item.variant)).toEqual([
      'legacy',
      'new_replyer_only',
      'new_full_runtime',
      'new_full_runtime_expression',
      'new_full_runtime_expression_behavior',
      'new_full_runtime_expression_behavior_sticker',
    ])
    expect(projections.at(-1)?.selectedStickerIds).toEqual(['sticker-1'])
  })
})

function evidence(text: string): SocialLanguageEvidence {
  return {
    messageId: 'source-message',
    text,
    personId: 'doggy',
    conversationId: 'direct',
    platform: 'desktop',
    timestamp: 100,
    source: 'human',
    sourceKind: 'chat',
    authorVerified: true,
  }
}

function config(patch: Partial<LanguageLearningConfig> = {}): LanguageLearningConfig {
  return { ...DEFAULT_LANGUAGE_LEARNING_CONFIG, ...patch }
}

function intent(input: {
  shouldReply?: boolean
  replyAct?: string
  willingnessToHelp?: LumiReplyIntent['attitude']['willingnessToHelp']
  refusalRequired?: boolean
  emotion?: string
  scene?: string
  constraints?: string[]
} = {}): LumiReplyIntent {
  return {
    shouldReply: input.shouldReply ?? true,
    replyAct: input.replyAct ?? 'answer',
    semanticGoal: 'respond to the current message',
    keyPoints: ['preserve the intended meaning'],
    referenceInfo: [],
    attitude: { willingnessToHelp: input.willingnessToHelp ?? 'normal' },
    emotion: { primary: input.emotion ?? 'neutral', intensity: input.emotion === 'angry' ? 0.9 : 0.3 },
    defenseState: {
      active: input.refusalRequired ?? false,
      refusalRequired: input.refusalRequired ?? false,
      prohibitedHelpTypes: input.refusalRequired ? ['solution'] : [],
    },
    expressionIntent: {
      focus: 'current message',
      scene: input.scene ?? 'direct chat',
      tone: 'natural',
      desiredLength: 'short',
      preferredActs: [],
      avoid: [],
    },
    immutableConstraints: input.constraints ?? [],
  }
}

function context(input: {
  personId?: string
  conversationId?: string
  platform?: string
  currentUserText?: string
  intent?: LumiReplyIntent
  recentAssistantTexts?: string[]
} = {}): SocialLanguageTurnContext {
  return {
    now: 1_000,
    personId: input.personId ?? 'doggy',
    conversationId: input.conversationId ?? 'direct',
    platform: input.platform ?? 'desktop',
    conversationType: 'direct',
    currentUserText: input.currentUserText ?? 'build failure',
    replyIntent: input.intent ?? intent(),
    recentAssistantTexts: input.recentAssistantTexts ?? [],
  }
}

function omitIntent(value: SocialLanguageTurnContext): Omit<SocialLanguageTurnContext, 'replyIntent'> {
  const { replyIntent: _, ...rest } = value
  return rest
}

function expression(patch: Partial<LearnedExpression> = {}): LearnedExpression {
  return {
    id: 'expression-1',
    phrase: '这难炸了',
    situation: 'build failure',
    pragmaticFunction: 'exaggerated reaction',
    patternType: 'exaggeration',
    origin: {
      personId: 'doggy',
      conversationId: 'direct',
      platform: 'desktop',
      messageIds: ['source-message'],
      source: 'human',
    },
    affinity: {
      global: 0.5,
      byPerson: { doggy: 1 },
      byConversation: { direct: 1 },
      byPlatform: { desktop: 1 },
    },
    familiarity: 0.8,
    ownership: 0.8,
    confidence: 0.9,
    observationCount: 4,
    useCount: 2,
    successfulUseCount: 2,
    awkwardUseCount: 0,
    explicitRejectionCount: 0,
    firstSeenAt: 0,
    lastSeenAt: 900,
    status: 'adopted',
    ...patch,
  }
}

function decisionFor(learned: LearnedExpression) {
  return {
    id: 'decision',
    timestamp: 100,
    personId: 'doggy',
    conversationId: 'direct',
    platform: 'desktop',
    plannerIntent: intent(),
    retrievedExpressions: [learned.id],
    selectedExpressions: [learned.id],
    selectedExpressionReasons: { [learned.id]: ['test'] },
    selectedBehaviors: [],
    generatedReply: { messages: [{ text: '这难炸了' }] },
    actuallySentReply: { messages: [{ text: '这难炸了' }] },
    emotionState: {},
    defenseState: {},
    validator: { passed: true, attempts: 1, issues: [], fallbackUsed: false },
  }
}

function character() {
  return {
    corePersonality: 'Lumi has her own stance and boundaries.',
    baseReplyStyle: 'Short natural chat.',
    emotionSummary: 'neutral',
    relationshipSummary: 'familiar',
    defenseSummary: 'none',
  }
}
