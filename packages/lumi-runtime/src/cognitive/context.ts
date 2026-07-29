import type { LumiMemoryFragment, LumiMemorySearchRequest } from '../types'
import type {
  LumiBeliefHypothesis,
  LumiCognitiveContextBundle,
  LumiCognitiveEvidence,
  LumiCognitiveIdentity,
  LumiCognitiveProfileProjection,
  LumiFeedbackEvent,
  LumiRecallTrace,
  LumiWorkingMemory,
} from './types'

import { canAccessLumiMemory } from '../validation'
import { pruneLumiWorkingMemory } from './working-memory'

/** Inputs accepted by the unique cognitive-context assembler. */
export interface LumiCognitiveContextAssemblyInput {
  /** Immutable turn identity and privacy boundary. */
  identity: LumiCognitiveIdentity
  /** Conversation working memory. */
  workingMemory: LumiWorkingMemory
  /** Evidence available for lineage and hypothesis authorization. */
  evidence: readonly LumiCognitiveEvidence[]
  /** Stable semantic and episodic memories returned by hybrid retrieval. */
  memories: readonly LumiMemoryFragment[]
  /** Temporary beliefs available to this host. */
  hypotheses: readonly LumiBeliefHypothesis[]
  /** Materialized profile projection available to this host. */
  profile: readonly LumiCognitiveProfileProjection[]
  /** Direct-only relationship state. */
  relationshipState?: unknown
  /** Current Lumi emotion state. */
  currentEmotion?: unknown
  /** Evidence-backed interaction strategy summaries. */
  interactionStrategies?: readonly string[]
  /** Selected expression assets. */
  expressionAssets?: readonly string[]
  /** Contradiction notices. */
  contradictions?: readonly string[]
  /** Automatic recall trace. */
  recallTrace: LumiRecallTrace
  /** Explicit feedback persisted by the current fast loop. */
  feedbackEvents?: readonly LumiFeedbackEvent[]
  /** Current ISO timestamp. @default new Date().toISOString() */
  now?: string
}

/**
 * Assembles one deduplicated, ACL-filtered cognitive context bundle.
 *
 * Use when:
 * - Preparing Planner context before the first round of a turn
 * - Projecting a narrower Replyer context from the same source bundle
 *
 * Expects:
 * - Identity was resolved once at ingress and remains immutable
 * - Host services may provide a superset; this function revalidates access
 *
 * Returns:
 * - A single context bundle with stable facts, tentative beliefs, and profile layers separated
 */
export function assembleLumiCognitiveContext(
  input: LumiCognitiveContextAssemblyInput,
): LumiCognitiveContextBundle {
  const request = memoryRequest(input.identity)
  const memories = dedupeMemories(input.memories.filter(memory => canAccessLumiMemory(memory, request)))
    .filter(memory => !memory.supersededById)
    .filter(memory => memory.status === 'active')
  const evidenceById = new Map(input.evidence.map(item => [item.id, item]))
  const hypotheses = input.hypotheses
    .filter(item => item.status !== 'expired' && item.status !== 'contradicted')
    .filter(item => canAccessHypothesis(item, input.identity, evidenceById))
  const profile = input.identity.conversationType === 'group'
    ? []
    : input.profile.filter(item => canAccessProjection(item, input.identity))
  const semanticTypes = new Set([
    'user_preference',
    'user_fact',
    'persona_fact',
    'persona_preference',
    'promise',
    'project_context',
  ])

  return {
    identity: input.identity,
    workingMemory: input.identity.conversationType === 'group'
      ? groupSafeWorkingMemory(input.workingMemory, input.now)
      : pruneLumiWorkingMemory(input.workingMemory, input.now),
    stableFacts: memories.filter(memory => semanticTypes.has(memory.type)),
    tentativeImpressions: hypotheses,
    relevantEpisodes: memories.filter(memory => !semanticTypes.has(memory.type)),
    userProfileProjection: {
      communicationPreferences: profile.filter(item => /communication|expression|preference/i.test(item.key)),
      stableGoals: profile.filter(item => /goal|project|decision|focus/i.test(item.key)),
      relevantTraits: profile.filter(item => item.layer === 'core' && !/goal|project|decision|focus/i.test(item.key)),
      currentState: profile.filter(item => item.layer === 'daily'),
    },
    relationshipState: input.identity.conversationType === 'direct' ? input.relationshipState : undefined,
    currentEmotion: input.currentEmotion,
    interactionStrategies: uniqueStrings(input.interactionStrategies ?? []),
    expressionAssets: uniqueStrings(input.expressionAssets ?? []),
    contradictions: uniqueStrings(input.contradictions ?? []),
    recallTrace: input.recallTrace,
    feedbackEvents: input.feedbackEvents?.map(event => ({ ...event, targetIds: [...event.targetIds] })) ?? [],
  }
}

/**
 * Formats the Planner-only cognitive projection with uncertainty labels.
 *
 * Use when:
 * - Injecting one authorized reference before Planner
 *
 * Expects:
 * - Bundle was produced by {@link assembleLumiCognitiveContext}
 *
 * Returns:
 * - Chinese structured text that distinguishes stable facts, episodes, and tentative hypotheses
 */
export function formatLumiPlannerCognitiveContext(bundle: LumiCognitiveContextBundle): string {
  const working = bundle.workingMemory
  const lines = [
    '<Lumi认知上下文>',
    '以下内容已经过本轮身份和权限过滤。稳定事实、暂时假设和历史事件不可互相冒充。',
    section('工作记忆', [
      ...working.activeTopics.map(item => `活跃话题：${item.value}`),
      ...working.entityBindings.map(item => `实体绑定：${item.key} = ${item.value}`),
      ...working.goals.map(item => `当前目标：${item.value}`),
      ...working.openLoops.map(item => `未完成问题：${item.value}`),
      ...working.projects.map(item => `当前项目：${item.value}`),
      ...working.temporaryUserStates.map(item => `当前用户临时状态：${item.value}`),
      working.relationshipContext ? `当前关系情境：${working.relationshipContext.value}` : '',
      working.continuationPoint ? `续接点：${working.continuationPoint}` : '',
    ]),
    section('稳定认知', bundle.stableFacts.map(memory => memory.content)),
    section('相关情景', bundle.relevantEpisodes.map(memory => memory.content)),
    section('暂时假设（不确定，不得当作事实）', bundle.tentativeImpressions.map(item =>
      `${item.predicate} = ${printableValue(item.value)}（置信度 ${item.confidence.toFixed(2)}）`,
    )),
    section('画像投影', [
      ...bundle.userProfileProjection.communicationPreferences.map(item => `${item.key}: ${item.value}`),
      ...bundle.userProfileProjection.stableGoals.map(item => `${item.key}: ${item.value}`),
      ...bundle.userProfileProjection.relevantTraits.map(item => `${item.key}: ${item.value}`),
      ...bundle.userProfileProjection.currentState.map(item => `${item.key}: ${item.value}（短期）`),
    ]),
    bundle.relationshipState === undefined
      ? ''
      : section('当前关系状态', [printableValue(bundle.relationshipState)]),
    bundle.currentEmotion === undefined
      ? ''
      : section('Lumi 当前情绪', [printableValue(bundle.currentEmotion)]),
    section('互动策略', bundle.interactionStrategies),
    section('冲突', bundle.contradictions),
    '</Lumi认知上下文>',
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * Formats the Replyer-only language and interaction projection.
 *
 * Use when:
 * - Replyer needs style/behavior guidance without raw private memories or tools
 *
 * Expects:
 * - Planner already produced a structured reply intent
 *
 * Returns:
 * - A narrow projection containing emotion, strategy, and selected expression assets
 */
export function formatLumiReplyerCognitiveContext(bundle: LumiCognitiveContextBundle): string {
  return [
    '<Lumi表达上下文>',
    bundle.currentEmotion === undefined ? '' : `当前情绪：${printableValue(bundle.currentEmotion)}`,
    section('互动策略', bundle.interactionStrategies),
    section('可选表达', bundle.expressionAssets),
    '</Lumi表达上下文>',
  ].filter(Boolean).join('\n')
}

function memoryRequest(identity: LumiCognitiveIdentity): LumiMemorySearchRequest {
  return {
    query: '',
    userId: identity.actorId,
    viewerUserId: identity.actorId,
    personaId: identity.personaId,
    limit: 100,
    conversationType: identity.conversationType === 'group' ? 'group' : 'direct',
    conversationId: identity.conversationId,
    participantUserIds: [...identity.participantUserIds],
  }
}

function canAccessHypothesis(
  hypothesis: LumiBeliefHypothesis,
  identity: LumiCognitiveIdentity,
  evidenceById: Map<string, LumiCognitiveEvidence>,
) {
  if (identity.conversationType === 'group') {
    if (hypothesis.scope !== 'group' && hypothesis.scope !== 'global' && hypothesis.scope !== 'shared')
      return false
    if (hypothesis.scope === 'group' && hypothesis.conversationId !== identity.conversationId)
      return false
  }
  if (hypothesis.scope === 'global' || hypothesis.scope === 'shared')
    return hypothesis.sensitivity !== 'private'
  if (!hypothesis.participantUserIds.includes(identity.actorId))
    return false
  if (hypothesis.evidenceIds.length === 0)
    return false
  return hypothesis.evidenceIds.every((id) => {
    const evidence = evidenceById.get(id)
    return evidence !== undefined && canAccessEvidence(evidence, identity)
  })
}

function canAccessEvidence(evidence: LumiCognitiveEvidence, identity: LumiCognitiveIdentity) {
  if (evidence.sensitivity === 'private' && evidence.actorId !== identity.actorId)
    return false
  if (identity.conversationType === 'group') {
    if (evidence.scope === 'private' || evidence.scope === 'relationship')
      return false
    if (evidence.scope === 'group' && evidence.conversationId !== identity.conversationId)
      return false
  }
  if (evidence.scope === 'global' || evidence.scope === 'shared')
    return evidence.sensitivity !== 'private'
  return evidence.participantUserIds.includes(identity.actorId)
}

function canAccessProjection(projection: LumiCognitiveProfileProjection, identity: LumiCognitiveIdentity) {
  return projection.subjectId === identity.actorId
    && projection.sensitivity !== 'private'
    ? true
    : projection.subjectId === identity.actorId
}

function groupSafeWorkingMemory(memory: LumiWorkingMemory, now?: string) {
  const pruned = pruneLumiWorkingMemory(memory, now)
  return {
    ...pruned,
    personId: '',
    temporaryUserStates: [],
    relationshipContext: undefined,
  }
}

function dedupeMemories(memories: readonly LumiMemoryFragment[]) {
  const seen = new Set<string>()
  return memories.filter((memory) => {
    const key = `${memory.type}:${memory.content.trim().toLowerCase()}`
    if (!memory.content.trim() || seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

function section(title: string, values: readonly string[]) {
  const clean = uniqueStrings(values)
  return clean.length ? `[${title}]\n${clean.map(value => `- ${value}`).join('\n')}` : ''
}

function printableValue(value: unknown) {
  if (typeof value === 'string')
    return value
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}
