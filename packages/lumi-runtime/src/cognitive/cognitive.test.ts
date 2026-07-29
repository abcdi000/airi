import type {
  LumiBeliefHypothesis,
  LumiCognitiveEvidence,
  LumiCognitiveLifecycle,
  LumiFeedbackEvent,
  LumiMemoryFragment,
} from '../index'

import { describe, expect, it } from 'vitest'

import {
  assembleLumiCognitiveContext,
  buildLumiContextualRecallQuery,
  classifyExplicitLumiFeedback,
  createLumiWorkingMemory,
  decayLumiBeliefHypothesis,
  formatLumiPlannerCognitiveContext,
  observeLumiBeliefHypothesis,
  projectLumiBeliefsToProfile,
  reduceLumiFeedbackLifecycle,
  reduceLumiWorkingMemory,
} from './index'

const NOW = '2026-07-29T00:00:00.000Z'
const LATER = '2026-07-30T00:00:00.000Z'
const DOGGY = 'lumi-user-doggy'
const MOUSSY = 'lumi-user-moussy'

function evidence(patch: Partial<LumiCognitiveEvidence> = {}): LumiCognitiveEvidence {
  return {
    id: 'message:doggy:1',
    actorId: DOGGY,
    subjectUserIds: [DOGGY],
    conversationId: 'direct-doggy',
    conversationType: 'direct',
    kind: 'user_statement',
    origin: 'primary',
    content: 'Doggy currently prefers Patchright.',
    sourceId: 'message-1',
    sourceMessageId: 'message-1',
    occurredAt: NOW,
    trust: 0.95,
    authorVerified: true,
    scope: 'relationship',
    sensitivity: 'normal',
    participantUserIds: [DOGGY],
    derivedFromEvidenceIds: [],
    schemaVersion: 1,
    ...patch,
  }
}

function memory(patch: Partial<LumiMemoryFragment>): LumiMemoryFragment {
  return {
    id: 'memory-1',
    userId: DOGGY,
    personaId: 'lumi',
    type: 'user_fact',
    content: 'Doggy prefers Patchright for normal browser work.',
    confidence: 0.9,
    importance: 0.8,
    emotionalIntensity: 0.1,
    relationshipRelevance: 0.7,
    createdAt: NOW,
    updatedAt: NOW,
    decay: 0,
    tags: ['browser'],
    status: 'active',
    scope: 'relationship',
    ownerType: 'user',
    ownerId: DOGGY,
    visibility: 'participants',
    participantUserIds: [DOGGY],
    subjectUserIds: [DOGGY],
    sensitivity: 'normal',
    ...patch,
  }
}

describe('lumi cognitive working memory and recall', () => {
  it('reuses RecallState for pure low-information continuation messages', () => {
    const workingMemory = createLumiWorkingMemory({
      personId: DOGGY,
      personaId: 'lumi',
      conversationId: 'direct-doggy',
      conversationType: 'direct',
      now: NOW,
    })
    workingMemory.recallState = {
      query: 'Patchright default and Playwright exceptions',
      memoryIds: ['memory-browser'],
      activeTopics: ['browser automation'],
      sourceMessageIds: ['assistant-1'],
      updatedAt: NOW,
      expiresAt: LATER,
      reuseCount: 0,
    }

    for (const message of ['嗯', '对', '继续']) {
      const result = buildLumiContextualRecallQuery({
        message,
        recentTurns: [{ id: 'assistant-1', role: 'assistant', content: '默认使用 Patchright，特殊情况用 Playwright 吗？' }],
        workingMemory,
        now: NOW,
      })

      expect(result.reusedPreviousState).toBe(true)
      expect(result.query).toBe('Patchright default and Playwright exceptions')
      expect(result.reusedMemoryIds).toEqual(['memory-browser'])
    }
  })

  it('includes assistant context when a short continuation carries new semantics', () => {
    const workingMemory = createLumiWorkingMemory({
      personId: DOGGY,
      personaId: 'lumi',
      conversationId: 'direct-doggy',
      conversationType: 'direct',
      now: NOW,
    })
    const result = buildLumiContextualRecallQuery({
      message: '对，但这样会不会越来越慢？',
      recentTurns: [
        { id: 'user-1', role: 'user', content: '浏览器该用哪个后端？' },
        { id: 'assistant-1', role: 'assistant', content: '默认使用 Patchright，特殊情况才用 Playwright。' },
      ],
      workingMemory,
      now: NOW,
    })

    expect(result.reusedPreviousState).toBe(false)
    expect(result.query).toContain('默认使用 Patchright')
    expect(result.query).toContain('越来越慢')
    expect(result.sourceMessageIds).toEqual(['user-1', 'assistant-1'])
  })

  it('clears stale entity bindings after an explicit topic switch', () => {
    const workingMemory = createLumiWorkingMemory({
      personId: DOGGY,
      personaId: 'lumi',
      conversationId: 'direct-doggy',
      conversationType: 'direct',
      now: NOW,
    })
    workingMemory.entityBindings = [{
      key: '默认浏览器',
      value: 'Patchright',
      sourceMessageId: 'assistant-1',
      updatedAt: NOW,
      expiresAt: LATER,
    }]

    const result = reduceLumiWorkingMemory({
      previous: workingMemory,
      sourceMessageId: 'user-2',
      userText: '换个话题，我们说记忆系统',
      now: NOW,
    })

    expect(result.entityBindings).toEqual([])
  })
})

describe('lumi hypotheses and profile projection', () => {
  it('does not promote one temporary mood observation into a Core trait', () => {
    const observed = observeLumiBeliefHypothesis(undefined, {
      subjectId: DOGGY,
      predicate: 'mood',
      value: '可能焦虑',
      evidence: evidence({ id: 'session-a:message-1', kind: 'observed_behavior', trust: 0.55 }),
    })
    const projections = projectLumiBeliefsToProfile({
      subjectId: DOGGY,
      beliefs: [observed],
      evidenceById: new Map([[observed.evidenceIds[0]!, evidence({
        id: observed.evidenceIds[0],
        kind: 'observed_behavior',
        trust: 0.55,
      })]]),
      now: NOW,
    })

    expect(projections).toHaveLength(1)
    expect(projections[0]?.layer).toBe('daily')
    expect(projections.some(item => item.layer === 'core')).toBe(false)
  })

  it('raises stability across independent evidence and allows correction to contradict it', () => {
    let belief: LumiBeliefHypothesis | undefined
    for (const [index, timestamp] of [NOW, LATER, '2026-08-02T00:00:00.000Z'].entries()) {
      belief = observeLumiBeliefHypothesis(belief, {
        subjectId: DOGGY,
        predicate: 'communication_preference',
        value: '简短自然',
        evidence: evidence({
          id: `session-${index}:message-1`,
          occurredAt: timestamp,
          content: '我喜欢简短自然的回复。',
        }),
      })
    }

    expect(belief?.independentEvidenceCount).toBe(3)
    expect(belief?.status).toBe('stable')

    const corrected = observeLumiBeliefHypothesis(belief, {
      subjectId: DOGGY,
      predicate: 'communication_preference',
      value: '需要详细解释',
      evidence: evidence({
        id: 'session-correction:message-1',
        kind: 'user_correction',
        occurredAt: '2026-08-03T00:00:00.000Z',
        content: '纠正一下，我现在需要详细解释。',
        trust: 1,
      }),
    })

    expect(corrected.status).toBe('contradicted')
    expect(corrected.counterEvidenceIds).toContain('session-correction:message-1')
  })

  it('expires an unconfirmed hypothesis and excludes it from normal context', () => {
    const belief = observeLumiBeliefHypothesis(undefined, {
      subjectId: DOGGY,
      predicate: 'current_pressure',
      value: 'deadline',
      evidence: evidence({ id: 'session-a:message-1' }),
      ttlMs: 1000,
    })

    expect(decayLumiBeliefHypothesis(belief, LATER).status).toBe('expired')
  })

  it('marks tentative hypotheses explicitly in Planner context', () => {
    const workingMemory = createLumiWorkingMemory({
      personId: DOGGY,
      personaId: 'lumi',
      conversationId: 'direct-doggy',
      conversationType: 'direct',
      now: NOW,
    })
    const hypothesis = observeLumiBeliefHypothesis(undefined, {
      subjectId: DOGGY,
      predicate: 'current_mood',
      value: '可能焦虑',
      evidence: evidence(),
    })
    const bundle = assembleLumiCognitiveContext({
      identity: {
        actorId: DOGGY,
        personaId: 'lumi',
        conversationId: 'direct-doggy',
        conversationType: 'direct',
        participantUserIds: [DOGGY],
      },
      workingMemory,
      evidence: [evidence()],
      memories: [],
      hypotheses: [hypothesis],
      profile: [],
      recallTrace: emptyTrace(),
      now: NOW,
    })

    const prompt = formatLumiPlannerCognitiveContext(bundle)
    expect(prompt).toContain('暂时假设（不确定，不得当作事实）')
    expect(prompt).toContain('可能焦虑')
  })
})

describe('lumi cognitive privacy and feedback', () => {
  it('keeps Moussy private memory and profile out of Doggy direct context', () => {
    const workingMemory = createLumiWorkingMemory({
      personId: DOGGY,
      personaId: 'lumi',
      conversationId: 'direct-doggy',
      conversationType: 'direct',
      now: NOW,
    })
    const bundle = assembleLumiCognitiveContext({
      identity: {
        actorId: DOGGY,
        personaId: 'lumi',
        conversationId: 'direct-doggy',
        conversationType: 'direct',
        participantUserIds: [DOGGY],
      },
      workingMemory,
      evidence: [],
      memories: [memory({
        id: 'moussy-private',
        userId: MOUSSY,
        ownerId: MOUSSY,
        participantUserIds: [MOUSSY],
        subjectUserIds: [MOUSSY],
        scope: 'private',
        visibility: 'private',
        sensitivity: 'private',
      })],
      hypotheses: [],
      profile: [{
        id: 'moussy-profile',
        subjectId: MOUSSY,
        layer: 'core',
        key: 'identity',
        value: 'private Moussy fact',
        beliefIds: ['belief-moussy'],
        evidenceIds: ['evidence-moussy'],
        confidence: 1,
        stability: 1,
        status: 'active',
        scope: 'private',
        sensitivity: 'private',
        updatedAt: NOW,
      }],
      recallTrace: emptyTrace(),
      now: NOW,
    })

    expect(bundle.stableFacts).toEqual([])
    expect(bundle.userProfileProjection.relevantTraits).toEqual([])
  })

  it('strips private profile, relationship, and temporary user state from group context', () => {
    const workingMemory = createLumiWorkingMemory({
      personId: DOGGY,
      personaId: 'lumi',
      conversationId: 'group-1',
      conversationType: 'group',
      now: NOW,
    })
    workingMemory.temporaryUserStates = [{
      id: 'doggy-mood',
      value: 'private mood',
      evidenceIds: ['private-evidence'],
      sourceMessageIds: ['private-message'],
      updatedAt: NOW,
      expiresAt: LATER,
    }]
    const bundle = assembleLumiCognitiveContext({
      identity: {
        actorId: DOGGY,
        personaId: 'lumi',
        conversationId: 'group-1',
        conversationType: 'group',
        participantUserIds: [DOGGY, MOUSSY],
      },
      workingMemory,
      evidence: [],
      memories: [],
      hypotheses: [],
      profile: [],
      relationshipState: { private: true },
      recallTrace: emptyTrace(),
      now: NOW,
    })

    expect(bundle.workingMemory.temporaryUserStates).toEqual([])
    expect(bundle.relationshipState).toBeUndefined()
    expect(bundle.userProfileProjection.currentState).toEqual([])
  })

  it('does not treat a plain acknowledgement as positive feedback', () => {
    expect(classifyExplicitLumiFeedback('嗯')).toEqual([])
    expect(classifyExplicitLumiFeedback('你这样说自然多了')).toContain('expression_natural')
  })

  it('updates lifecycle from explicit feedback without changing ownership', () => {
    const lifecycle: LumiCognitiveLifecycle = {
      evidenceCount: 2,
      independentEvidenceCount: 2,
      confidence: 0.6,
      familiarity: 0.5,
      stability: 0.5,
      ownership: 0.4,
      positiveFeedback: 0,
      negativeFeedback: 0,
      rejectionCount: 0,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      decay: 0,
    }
    const event: LumiFeedbackEvent = {
      id: 'feedback-1',
      actorId: DOGGY,
      conversationId: 'direct-doggy',
      conversationType: 'direct',
      kind: 'expression_natural',
      sourceId: 'message-2',
      evidenceId: 'evidence-feedback-1',
      targetIds: ['expression-1'],
      strength: 1,
      occurredAt: LATER,
      authorVerified: true,
      scope: 'relationship',
      sensitivity: 'normal',
    }

    const result = reduceLumiFeedbackLifecycle(lifecycle, event)
    expect(result.positiveFeedback).toBe(1)
    expect(result.confidence).toBeGreaterThan(lifecycle.confidence)
    expect(result.ownership).toBe(lifecycle.ownership)
  })
})

function emptyTrace() {
  return {
    ran: true,
    reusedPreviousState: false,
    aclInputCount: 0,
    aclOutputCount: 0,
    lexicalCandidateCount: 0,
    annCandidateCount: 0,
    mergedCandidateCount: 0,
    rerankedCandidateCount: 0,
    thresholdRejectedCount: 0,
    conflictRejectedCount: 0,
    injectedCount: 0,
    durationMs: 0,
  }
}
