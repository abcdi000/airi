import type {
  LanguageDecisionLog,
  LumiLanguageFeedback,
  SocialLanguageEvidence,
  SocialLanguageGroupObservation,
} from '../types'

import { isRecord } from '../json'

/** Builds the model-backed expression, jargon, and social-behavior learning prompt. */
export function buildSocialLanguageLearningMessages(input: {
  evidence: SocialLanguageEvidence
  recentContext: Array<{ role: 'user' | 'assistant', content: string }>
}): Array<{ role: 'system' | 'user' | 'assistant', content: string }> {
  return [
    {
      role: 'system',
      content: [
        '你是 Lumi 的社会语言归纳器，不是 Lumi，不要回复当前对话。',
        '只提取经过验证的作者消息直接支持的语言与互动知识。',
        '不要提取事实记忆、私密事件、姓名、项目、密码、他人引语、角色扮演台词、代码、日志、网页文字、字幕或系统与工具输出。',
        '可以提取具体短语，也可以提取抽象节奏模式。',
        '黑话含义必须描述它在当前语境中的实际社交作用，不能凭空编造字典释义。',
        '只返回严格 JSON：',
        '{',
        '  "expressions": [{"phrase":"optional exact phrase","situation":"","pragmaticFunction":"","emotionalMeaning":"","tone":"","patternType":"exact_phrase | sentence_pattern | rhythm | punctuation | message_length | multi_message_sequence | reaction | jargon | swear | exaggeration","confidence":0.0}],',
        '  "jargon": [{"term":"","meaning":"","context":"","literalMeaning":"","pragmaticFunctions":[],"emotionalTone":"","communities":[],"confidence":0.0}],',
        '  "behaviors": [{"situation":"","action":"","expectedEffect":"","confidence":0.0}]',
        '}',
        '证据不足时返回空数组。绝不能根据一次观察就声称用户经常这样说。',
      ].join('\n'),
    },
    ...input.recentContext.slice(-8),
    {
      role: 'user',
      content: JSON.stringify({
        verified_source: {
          messageId: input.evidence.messageId,
          authorPersonId: input.evidence.personId,
          platform: input.evidence.platform,
          sourceKind: input.evidence.sourceKind,
          text: input.evidence.text,
        },
      }),
    },
  ]
}

/** Builds a curator prompt for a read-only group observation batch. */
export function buildObservedGroupLearningMessages(input: {
  observations: SocialLanguageGroupObservation[]
  recentContext?: SocialLanguageGroupObservation[]
}): Array<{ role: 'system' | 'user' | 'assistant', content: string }> {
  return [
    {
      role: 'system',
      content: [
        '你是 Lumi 的社会语言归纳器，不是 Lumi，绝不能在群聊中回复。',
        '只学习本批次证据支持的重复语言、黑话、节奏、标点、消息长度和互动行为。',
        '不要提取姓名、身份、事实事件、私密细节、关系、观点、密码、链接、图片、引语或记忆。',
        '不要模仿针对个人的辱骂，也不能削弱 Lumi 的人格、安全、隐私或防御规则。',
        'recent_context 是辅助证据，focus_batch 是当前新到并等待处理的消息。',
        '单次出现只是弱证据，优先选择两个区域中由多条独立消息共同支持的模式。',
        '只返回严格 JSON：',
        '{',
        '  "expressions": [{"phrase":"optional exact phrase","situation":"","pragmaticFunction":"","emotionalMeaning":"","tone":"","patternType":"exact_phrase | sentence_pattern | rhythm | punctuation | message_length | multi_message_sequence | reaction | jargon | swear | exaggeration","confidence":0.0}],',
        '  "jargon": [{"term":"","meaning":"","context":"","literalMeaning":"","pragmaticFunctions":[],"emotionalTone":"","communities":[],"confidence":0.0}],',
        '  "behaviors": [{"situation":"","action":"","expectedEffect":"","confidence":0.0}]',
        '}',
        '必须始终包含三个数组；只有综合证据确实没有可复用模式时才全部返回空数组。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        recent_context: (input.recentContext ?? []).map(observation => ({
          messageId: observation.messageId,
          anonymousSpeaker: `speaker-${observation.senderId}`,
          text: observation.text,
          timestamp: observation.timestamp,
        })),
        focus_batch: input.observations.map(observation => ({
          messageId: observation.messageId,
          anonymousSpeaker: `speaker-${observation.senderId}`,
          text: observation.text,
          timestamp: observation.timestamp,
        })),
      }),
    },
  ]
}

/**
 * Builds the consciousness task that interprets delayed human feedback.
 *
 * Use when:
 * - A verified user message follows a Lumi reply decision
 * - Learned expressions and behaviors may need confidence updates
 *
 * Expects:
 * - The decision is the latest unresolved decision in the same conversation
 *
 * Returns:
 * - A tool-free prompt whose JSON result contains feedback evidence only
 */
export function buildSocialLanguageFeedbackMessages(input: {
  userText: string
  decision: LanguageDecisionLog
}): Array<{ role: 'system' | 'user', content: string }> {
  return [
    {
      role: 'system',
      content: [
        '你是 Lumi 的社会语言反馈归纳器，不是 Lumi，不要回复用户。',
        '判断新的已验证用户消息是否为 Lumi 紧邻的上一条措辞或互动行为提供了反馈证据。',
        '不要根据孤立关键词推断表扬、拒绝、误解、模仿或玩笑式延续。',
        '必须结合上一条实际发送回复与当前消息判断；证据有歧义时，将所有语义反馈字段设为 false。',
        'normalContinuation 只表示对话继续，不能单独算作正向学习证据。',
        '只返回严格 JSON：',
        '{"explicitPraise":false,"explicitRejection":false,"phraseEcho":false,"playfulContinuation":false,"normalContinuation":false,"misunderstanding":false,"aiStyleComplaint":false}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        previous_lumi_reply: input.decision.actuallySentReply.messages.map(message => message.text),
        selected_expression_ids: input.decision.selectedExpressions,
        selected_behavior_ids: input.decision.selectedBehaviors,
        verified_human_message: input.userText,
      }),
    },
  ]
}

/**
 * Parses a consciousness-produced social-language feedback judgment.
 *
 * Use when:
 * - Applying delayed feedback to learned expressions or behaviors
 *
 * Expects:
 * - Strict JSON produced by {@link buildSocialLanguageFeedbackMessages}
 *
 * Returns:
 * - A complete feedback object, or `undefined` when the model response is invalid
 */
export function parseSocialLanguageFeedbackOutput(raw: string): LumiLanguageFeedback | undefined {
  const normalized = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    const parsed: unknown = JSON.parse(normalized)
    if (!isRecord(parsed))
      return undefined
    const keys = [
      'explicitPraise',
      'explicitRejection',
      'phraseEcho',
      'playfulContinuation',
      'normalContinuation',
      'misunderstanding',
      'aiStyleComplaint',
    ] as const
    if (!keys.every(key => typeof parsed[key] === 'boolean'))
      return undefined
    return {
      explicitPraise: parsed.explicitPraise as boolean,
      explicitRejection: parsed.explicitRejection as boolean,
      phraseEcho: parsed.phraseEcho as boolean,
      playfulContinuation: parsed.playfulContinuation as boolean,
      normalContinuation: parsed.normalContinuation as boolean,
      misunderstanding: parsed.misunderstanding as boolean,
      aiStyleComplaint: parsed.aiStyleComplaint as boolean,
    }
  }
  catch {
    return undefined
  }
}
