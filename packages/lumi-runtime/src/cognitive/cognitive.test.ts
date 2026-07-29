import type {
  LumiBeliefHypothesis,
  LumiCognitiveEvidence,
  LumiCognitiveLifecycle,
  LumiCognitiveTurnRepository,
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
  maintainLumiCognitiveState,
  observeLumiBeliefHypothesis,
  prepareLumiCognitiveTurn,
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

function cognitiveRepository(input: {
  workingMemory?: ReturnType<typeof createLumiWorkingMemory>
  recalledMemories?: LumiMemoryFragment[]
}) {
  const commits: Parameters<LumiCognitiveTurnRepository['commitFastLoop']>[0][] = []
  let recallCount = 0
  let reuseCount = 0
  const repository: LumiCognitiveTurnRepository = {
    async loadWorkingMemory() {
      return input.workingMemory
    },
    async commitFastLoop(commit) {
      commits.push(commit)
      input.workingMemory = commit.workingMemory
    },
    async recall() {
      recallCount += 1
      const memories = input.recalledMemories ?? []
      return {
        memories,
        trace: {
          ran: true,
          reusedPreviousState: false,
          aclInputCount: memories.length,
          aclOutputCount: memories.length,
          lexicalCandidateCount: memories.length,
          annCandidateCount: memories.length,
          mergedCandidateCount: memories.length,
          rerankedCandidateCount: memories.length,
          thresholdRejectedCount: 0,
          conflictRejectedCount: 0,
          injectedCount: memories.length,
          durationMs: 4,
          vectorIndexStatus: 'test',
        },
      }
    },
    async loadMemoriesByIds({ memoryIds }) {
      reuseCount += 1
      return (input.recalledMemories ?? []).filter(item => memoryIds.includes(item.id))
    },
    async loadProjectionState() {
      return {
        evidence: [],
        hypotheses: [],
        profile: [],
      }
    },
  }
  return {
    repository,
    commits,
    recallCount: () => recallCount,
    reuseCount: () => reuseCount,
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

  it('raises stability across independent messages and immediately adopts an explicit correction', () => {
    let belief: LumiBeliefHypothesis | undefined
    for (const [index, timestamp] of [NOW, LATER, '2026-08-02T00:00:00.000Z'].entries()) {
      belief = observeLumiBeliefHypothesis(belief, {
        subjectId: DOGGY,
        predicate: 'communication_preference',
        value: '简短自然',
        evidence: evidence({
          id: `session-a:message-${index}`,
          occurredAt: timestamp,
          content: '我喜欢简短自然的回复。',
        }),
      })
    }

    expect(belief?.independentEvidenceCount).toBe(3)
    expect(belief?.status).toBe('stable')

    const correctionEvidence = evidence({
      id: 'session-a:message-correction',
      kind: 'user_correction',
      occurredAt: '2026-08-03T00:00:00.000Z',
      content: '纠正一下，我现在需要详细解释。',
      trust: 1,
    })
    const corrected = observeLumiBeliefHypothesis(belief, {
      subjectId: DOGGY,
      predicate: 'communication_preference',
      value: '需要详细解释',
      evidence: correctionEvidence,
    })
    const projections = projectLumiBeliefsToProfile({
      subjectId: DOGGY,
      beliefs: [corrected],
      evidenceById: new Map([[correctionEvidence.id, correctionEvidence]]),
      now: correctionEvidence.occurredAt,
    })

    expect(corrected.value).toBe('需要详细解释')
    expect(corrected.status).toBe('supported')
    expect(corrected.evidenceIds).toEqual(['session-a:message-correction'])
    expect(corrected.counterEvidenceIds).toEqual([
      'session-a:message-0',
      'session-a:message-1',
      'session-a:message-2',
    ])
    expect(corrected.independentEvidenceCount).toBe(1)
    expect(corrected.negativeFeedback).toBe(1)
    expect(corrected.rejectionCount).toBe(1)
    expect(projections).toHaveLength(1)
    expect(projections[0]?.value).toBe('需要详细解释')
    expect(projections[0]?.evidenceIds).toEqual(['session-a:message-correction'])
    expect(projections[0]?.status).toBe('pending')
  })

  it('does not count derived summaries as independent evidence', () => {
    const primary = evidence({ id: 'session-a:message-1' })
    const observed = observeLumiBeliefHypothesis(undefined, {
      subjectId: DOGGY,
      predicate: 'communication_preference',
      value: '简短自然',
      evidence: primary,
    })
    const summarized = observeLumiBeliefHypothesis(observed, {
      subjectId: DOGGY,
      predicate: 'communication_preference',
      value: '简短自然',
      evidence: evidence({
        id: 'summary:session-a',
        origin: 'derived',
        kind: 'conversation_episode',
        derivedFromEvidenceIds: [primary.id],
      }),
    })

    expect(summarized.evidenceCount).toBe(2)
    expect(summarized.independentEvidenceCount).toBe(1)
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

  /** @example A stale stable belief is downgraded and no longer produces a Core projection. */
  it('decays stale cognition and rebuilds profile projections without a model call', () => {
    const sourceEvidence = evidence({
      id: 'evidence-stale-preference',
      occurredAt: '2026-01-01T00:00:00.000Z',
    })
    const initialBelief = observeLumiBeliefHypothesis(undefined, {
      subjectId: DOGGY,
      predicate: 'communication_preference',
      value: '简短自然',
      evidence: sourceEvidence,
    })
    const staleBelief: LumiBeliefHypothesis = {
      ...initialBelief,
      confidence: 0.8,
      stability: 0.7,
      status: 'stable',
      evidenceIds: [sourceEvidence.id],
      independentEvidenceCount: 3,
      lastObservedAt: sourceEvidence.occurredAt,
      lastSeenAt: sourceEvidence.occurredAt,
      expiresAt: '2027-01-01T00:00:00.000Z',
    }

    const result = maintainLumiCognitiveState({
      subjectId: DOGGY,
      beliefs: [staleBelief],
      evidenceById: new Map([[sourceEvidence.id, sourceEvidence]]),
      now: '2026-03-15T00:00:00.000Z',
    })

    expect(result.beliefs[0]?.status).toBe('tentative')
    expect(result.downgradedCount).toBe(1)
    expect(result.projections.every(projection => projection.layer !== 'core')).toBe(true)
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

  it('rejects a hypothesis whose claimed evidence lineage is missing', () => {
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
      evidence: evidence({ id: 'missing-evidence' }),
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
      memories: [],
      hypotheses: [hypothesis],
      profile: [],
      recallTrace: emptyTrace(),
      now: NOW,
    })

    expect(bundle.tentativeImpressions).toEqual([])
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

describe('lumi cognitive fast loop', () => {
  /** @example Explicit feedback retains exact expression and behavior IDs from the prior sent reply. */
  it('routes explicit feedback to persisted assistant asset IDs without text matching', async () => {
    const host = cognitiveRepository({})
    const bundle = await prepareLumiCognitiveTurn({
      identity: {
        actorId: DOGGY,
        personaId: 'lumi',
        conversationId: 'direct-doggy',
        conversationType: 'direct',
        participantUserIds: [DOGGY],
      },
      sourceMessageId: 'message-feedback',
      userText: '你这样说自然多了',
      recentTurns: [
        {
          id: 'assistant-before',
          role: 'assistant',
          content: '这次就按你说的来',
          feedbackTargetIds: ['expression-natural', 'behavior-follow-user'],
        },
        { id: 'message-feedback', role: 'user', content: '你这样说自然多了' },
      ],
      repository: host.repository,
      now: NOW,
    })

    expect(bundle.feedbackEvents).toEqual([expect.objectContaining({
      kind: 'expression_natural',
      targetIds: ['expression-natural', 'behavior-follow-user', 'assistant-before'],
    })])
    expect(host.commits[0]?.feedback).toEqual(bundle.feedbackEvents)
  })

  /** @example One verified user turn becomes evidence before Planner context is assembled. */
  it('commits primary evidence, working memory, and authorized shallow recall together', async () => {
    const recalled = memory({ id: 'memory-project' })
    const host = cognitiveRepository({ recalledMemories: [recalled] })

    const bundle = await prepareLumiCognitiveTurn({
      identity: {
        actorId: DOGGY,
        personaId: 'lumi',
        conversationId: 'direct-doggy',
        conversationType: 'direct',
        participantUserIds: [DOGGY],
      },
      sourceMessageId: 'message-current',
      userText: 'Patchright 项目现在怎么样了',
      recentTurns: [
        { id: 'assistant-before', role: 'assistant', content: '我刚检查了浏览器链路。' },
        { id: 'message-current', role: 'user', content: 'Patchright 项目现在怎么样了' },
      ],
      repository: host.repository,
      now: NOW,
    })

    expect(host.recallCount()).toBe(1)
    expect(host.reuseCount()).toBe(0)
    expect(host.commits).toHaveLength(1)
    expect(host.commits[0]?.evidence).toMatchObject({
      actorId: DOGGY,
      sourceMessageId: 'message-current',
      origin: 'primary',
      kind: 'user_statement',
      scope: 'private',
    })
    expect(bundle.stableFacts.map(item => item.id)).toEqual(['memory-project'])
    expect(bundle.recallTrace).toMatchObject({
      ran: true,
      reusedPreviousState: false,
      injectedCount: 1,
    })
  })

  /** @example Hybrid recall and cognitive projections start together before Planner. */
  it('loads automatic recall and cognitive projections in parallel', async () => {
    const starts: string[] = []
    let releaseRecall = () => {}
    let releaseProjection = () => {}
    const recallGate = new Promise<void>((resolve) => {
      releaseRecall = resolve
    })
    const projectionGate = new Promise<void>((resolve) => {
      releaseProjection = resolve
    })
    const repository: LumiCognitiveTurnRepository = {
      async loadWorkingMemory() {
        return undefined
      },
      async commitFastLoop() {},
      async recall() {
        starts.push('recall')
        await recallGate
        return {
          memories: [],
          trace: {
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
            durationMs: 1,
          },
        }
      },
      async loadMemoriesByIds() {
        return []
      },
      async loadProjectionState() {
        starts.push('projection')
        await projectionGate
        return { evidence: [], hypotheses: [], profile: [] }
      },
    }
    const task = prepareLumiCognitiveTurn({
      identity: {
        actorId: DOGGY,
        personaId: 'lumi',
        conversationId: 'direct-doggy',
        conversationType: 'direct',
        participantUserIds: [DOGGY],
      },
      sourceMessageId: 'message-parallel',
      userText: '继续检查 Patchright 项目',
      recentTurns: [{ id: 'message-parallel', role: 'user', content: '继续检查 Patchright 项目' }],
      repository,
      now: NOW,
    })

    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(starts).toEqual(['recall', 'projection'])
    }
    finally {
      releaseRecall()
      releaseProjection()
    }
    await task
  })

  /** @example “对” reloads previous memory IDs without another semantic recall. */
  it('reuses persisted RecallState for a pure acknowledgement without a new embedding path', async () => {
    const workingMemory = createLumiWorkingMemory({
      personId: DOGGY,
      personaId: 'lumi',
      conversationId: 'direct-doggy',
      conversationType: 'direct',
      now: NOW,
    })
    workingMemory.recallState = {
      query: '默认使用 Patchright，特殊情况使用 Playwright',
      memoryIds: ['memory-browser'],
      activeTopics: ['浏览器工具'],
      sourceMessageIds: ['assistant-before'],
      updatedAt: NOW,
      expiresAt: LATER,
      reuseCount: 0,
    }
    const host = cognitiveRepository({
      workingMemory,
      recalledMemories: [memory({ id: 'memory-browser' })],
    })

    const bundle = await prepareLumiCognitiveTurn({
      identity: {
        actorId: DOGGY,
        personaId: 'lumi',
        conversationId: 'direct-doggy',
        conversationType: 'direct',
        participantUserIds: [DOGGY],
      },
      sourceMessageId: 'message-confirm',
      userText: '对',
      recentTurns: [
        { id: 'assistant-before', role: 'assistant', content: '默认使用 Patchright，特殊情况才用 Playwright。' },
        { id: 'message-confirm', role: 'user', content: '对' },
      ],
      repository: host.repository,
      now: NOW,
    })

    expect(host.recallCount()).toBe(0)
    expect(host.reuseCount()).toBe(1)
    expect(bundle.recallTrace).toMatchObject({
      reusedPreviousState: true,
      vectorIndexStatus: 'reused_previous_recall',
    })
    expect(bundle.workingMemory.continuationPoint).toBe('默认使用 Patchright，特殊情况才用 Playwright。')
    expect(bundle.workingMemory.recallState?.reuseCount).toBe(1)
  })

  /** @example Explicit naturalness feedback is persisted, while a plain acknowledgement is not. */
  it('writes explicit feedback events without treating an acknowledgement as praise', async () => {
    const host = cognitiveRepository({ recalledMemories: [] })
    const identity = {
      actorId: DOGGY,
      personaId: 'lumi',
      conversationId: 'direct-doggy',
      conversationType: 'direct' as const,
      participantUserIds: [DOGGY],
    }
    await prepareLumiCognitiveTurn({
      identity,
      sourceMessageId: 'message-feedback',
      userText: '你这样说自然多了',
      recentTurns: [{ id: 'assistant-before', role: 'assistant', content: '这次简短说。' }],
      repository: host.repository,
      now: NOW,
    })
    await prepareLumiCognitiveTurn({
      identity,
      sourceMessageId: 'message-ack',
      userText: '嗯',
      recentTurns: [{ id: 'assistant-after', role: 'assistant', content: '知道了。' }],
      repository: host.repository,
      now: NOW,
    })

    expect(host.commits[0]?.feedback.map(item => item.kind)).toEqual(['expression_natural'])
    expect(host.commits[1]?.feedback).toEqual([])
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
