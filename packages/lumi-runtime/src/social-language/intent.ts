import type { LumiReplyIntent, LumiReplyLength } from './types'

import { clamp01, isRecord, parseJsonObject, stringArray, stringValue } from './json'

const HELP_WILLINGNESS = new Set(['eager', 'normal', 'reluctant', 'unwilling', 'refuse'])
const REPLY_LENGTHS = new Set<LumiReplyLength>(['tiny', 'short', 'medium', 'long'])

/** Parses and validates a Planner-produced reply intent. */
export function parseLumiReplyIntent(raw: string): LumiReplyIntent | null {
  const value = parseJsonObject(raw)
  if (!value)
    return null

  const attitude = isRecord(value.attitude) ? value.attitude : {}
  const emotion = isRecord(value.emotion) ? value.emotion : {}
  const defense = isRecord(value.defenseState) ? value.defenseState : isRecord(value.defense_state) ? value.defense_state : {}
  const expression = isRecord(value.expressionIntent) ? value.expressionIntent : isRecord(value.expression_intent) ? value.expression_intent : {}
  const willingnessValue = stringValue(attitude.willingnessToHelp ?? attitude.willingness_to_help, 'normal', 24)
  const lengthValue = stringValue(expression.desiredLength ?? expression.desired_length, 'short', 24) as LumiReplyLength
  const semanticGoal = stringValue(value.semanticGoal ?? value.semantic_goal, '', 8_000)
  const replyAct = stringValue(value.replyAct ?? value.reply_act, 'answer', 80)
  if (!semanticGoal || !replyAct)
    return null

  return normalizeLumiReplyIntent({
    shouldReply: value.shouldReply !== false && value.should_reply !== false,
    targetMessageId: stringValue(value.targetMessageId ?? value.target_message_id, '', 240) || undefined,
    replyAct,
    semanticGoal,
    keyPoints: stringArray(value.keyPoints ?? value.key_points, 32, 2_000),
    referenceInfo: stringArray(value.referenceInfo ?? value.reference_info, 32, 2_000),
    attitude: {
      towardTarget: stringValue(attitude.towardTarget ?? attitude.toward_target, '', 500) || undefined,
      stance: stringValue(attitude.stance, '', 500) || undefined,
      willingnessToHelp: HELP_WILLINGNESS.has(willingnessValue)
        ? willingnessValue as LumiReplyIntent['attitude']['willingnessToHelp']
        : 'normal',
    },
    emotion: {
      primary: stringValue(emotion.primary, 'neutral', 80),
      intensity: clamp01(emotion.intensity, 0.35),
      secondary: stringArray(emotion.secondary, 8, 80),
    },
    defenseState: {
      active: defense.active === true,
      level: defense.level === undefined ? undefined : clamp01(defense.level, 0),
      reason: stringValue(defense.reason, '', 1_000) || undefined,
      refusalRequired: defense.refusalRequired === true || defense.refusal_required === true,
      prohibitedHelpTypes: stringArray(defense.prohibitedHelpTypes ?? defense.prohibited_help_types, 24, 240),
    },
    expressionIntent: {
      focus: stringValue(expression.focus, semanticGoal, 1_000),
      scene: stringValue(expression.scene, 'direct_chat', 120),
      tone: stringValue(expression.tone, 'natural', 240),
      desiredLength: REPLY_LENGTHS.has(lengthValue) ? lengthValue : 'short',
      preferredActs: stringArray(expression.preferredActs ?? expression.preferred_acts, 16, 120),
      avoid: stringArray(expression.avoid, 24, 240),
    },
    immutableConstraints: stringArray(value.immutableConstraints ?? value.immutable_constraints, 32, 1_000),
  })
}

/**
 * Creates a safe intent when a provider cannot produce structured Planner JSON.
 *
 * The original model answer is retained as a semantic draft, allowing the old
 * chat path to remain usable without exposing malformed JSON to the user.
 */
export function createFallbackLumiReplyIntent(input: {
  rawDraft: string
  emotion?: string
  emotionIntensity?: number
  defenseActive?: boolean
  refusalRequired?: boolean
  defenseReason?: string
  prohibitedHelpTypes?: string[]
  relationshipStance?: string
  willingnessToHelp?: LumiReplyIntent['attitude']['willingnessToHelp']
  desiredLength?: LumiReplyLength
}): LumiReplyIntent {
  const rawDraft = input.rawDraft.trim()
  const refusalRequired = input.refusalRequired === true
  return normalizeLumiReplyIntent({
    shouldReply: true,
    replyAct: refusalRequired ? 'refuse' : 'answer',
    semanticGoal: rawDraft || (refusalRequired ? '明确拒绝当前请求。' : '对当前消息作出自然回应。'),
    keyPoints: rawDraft ? [rawDraft] : [],
    referenceInfo: [],
    attitude: {
      stance: input.relationshipStance,
      willingnessToHelp: refusalRequired ? 'refuse' : input.willingnessToHelp ?? 'normal',
    },
    emotion: {
      primary: input.emotion ?? 'neutral',
      intensity: clamp01(input.emotionIntensity, 0.35),
    },
    defenseState: {
      active: input.defenseActive === true,
      level: input.defenseActive ? Math.max(0.5, clamp01(input.emotionIntensity, 0.5)) : 0,
      reason: input.defenseReason,
      refusalRequired,
      prohibitedHelpTypes: input.prohibitedHelpTypes ?? [],
    },
    expressionIntent: {
      focus: rawDraft || 'current_message',
      scene: 'direct_chat',
      tone: input.emotion ?? 'natural',
      desiredLength: input.desiredLength ?? inferDesiredLength(rawDraft),
      preferredActs: refusalRequired ? ['direct_refusal'] : [],
      avoid: ['assistant_cliche', 'unnecessary_summary'],
    },
    immutableConstraints: refusalRequired
      ? [
          '必须拒绝继续提供被禁止的帮助。',
          '不得把拒绝软化成仍可继续帮助。',
          '不得用道歉或空泛共情消解当前立场。',
        ]
      : [],
  })
}

/** Normalizes a trusted reply intent and enforces defense invariants. */
export function normalizeLumiReplyIntent(intent: LumiReplyIntent): LumiReplyIntent {
  const refusalRequired = intent.defenseState.refusalRequired === true
  const shouldReply = intent.replyAct === 'stay_silent' ? false : intent.shouldReply
  const immutableConstraints = [...new Set(intent.immutableConstraints.map(item => item.trim()).filter(Boolean))]
  if (refusalRequired) {
    immutableConstraints.push(
      '必须拒绝继续提供被禁止的帮助。',
      '不得把拒绝改写成可继续协助。',
    )
  }
  return {
    ...intent,
    shouldReply,
    replyAct: refusalRequired ? 'refuse' : intent.replyAct,
    semanticGoal: intent.semanticGoal.trim().slice(0, 8_000),
    keyPoints: intent.keyPoints.map(item => item.trim().slice(0, 2_000)).filter(Boolean).slice(0, 32),
    referenceInfo: intent.referenceInfo.map(item => item.trim().slice(0, 2_000)).filter(Boolean).slice(0, 32),
    attitude: {
      ...intent.attitude,
      willingnessToHelp: refusalRequired ? 'refuse' : intent.attitude.willingnessToHelp,
    },
    emotion: {
      ...intent.emotion,
      primary: intent.emotion.primary.trim().slice(0, 80) || 'neutral',
      intensity: clamp01(intent.emotion.intensity, 0.35),
      secondary: intent.emotion.secondary?.map(item => item.trim().slice(0, 80)).filter(Boolean).slice(0, 8),
    },
    defenseState: {
      ...intent.defenseState,
      active: intent.defenseState.active || refusalRequired,
      level: intent.defenseState.level === undefined ? undefined : clamp01(intent.defenseState.level, 0),
      prohibitedHelpTypes: intent.defenseState.prohibitedHelpTypes?.map(item => item.trim().slice(0, 240)).filter(Boolean).slice(0, 24),
    },
    expressionIntent: {
      ...intent.expressionIntent,
      focus: intent.expressionIntent.focus.trim().slice(0, 1_000),
      scene: intent.expressionIntent.scene.trim().slice(0, 120) || 'direct_chat',
      tone: intent.expressionIntent.tone.trim().slice(0, 240) || 'natural',
      preferredActs: intent.expressionIntent.preferredActs.map(item => item.trim().slice(0, 120)).filter(Boolean).slice(0, 16),
      avoid: intent.expressionIntent.avoid.map(item => item.trim().slice(0, 240)).filter(Boolean).slice(0, 24),
    },
    immutableConstraints: [...new Set(immutableConstraints)],
  }
}

function inferDesiredLength(text: string): LumiReplyLength {
  if (text.length <= 12)
    return 'tiny'
  if (text.length <= 120)
    return 'short'
  if (text.length <= 500)
    return 'medium'
  return 'long'
}
