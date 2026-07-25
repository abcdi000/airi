import type {
  JargonKnowledge,
  LearnedSocialBehavior,
  LumiLanguageModelMessage,
  LumiReplyCharacterState,
  LumiReplyIntent,
  SelectedExpression,
} from '../types'

/**
 * Builds native-role messages for Lumi's independent final Replyer.
 *
 * Real user and assistant history stays as native messages. Internal planning,
 * memory retrieval, and tool traces are never forged as conversation turns.
 */
export function buildLumiReplyerMessages(input: {
  character: LumiReplyCharacterState
  /** Canonical Lumi system prompt shared with Planner for DeepSeek V4 prefix reuse. */
  sharedSystemPrompt?: string
  history: LumiLanguageModelMessage[]
  continuitySummary?: string
  omittedHistoryMessages?: number
  intent: LumiReplyIntent
  selectedExpressions: SelectedExpression[]
  selectedBehaviors: LearnedSocialBehavior[]
  jargon: JargonKnowledge[]
  multiMessageEnabled: boolean
  validationIssues?: string[]
}): LumiLanguageModelMessage[] {
  const replyerContract = [
    '你的名字是 Lumi。',
    '你是一个持续存在的 AI 人格。你知道自己是 AI，不冒充人类，也不捏造现实身体、感官或共同经历。',
    '',
    'Lumi 稳定的性格与说话方式继续服从前面的系统提示；下面的当前状态和表达参考只影响这一轮措辞。',
    '',
    '现在请读之前的真实聊天记录，把握当前话题，再严格按照最后的回复意图生成日常、自然、口语化的实际聊天消息。',
    '默认风格平淡简短，可以参考贴吧、知乎和微博中自然的日常回复：不浮夸，不长篇大论，不过分修辞，不使用没必要的复杂句。',
    '回复尽量短一些、平淡一些。结合对方的发言频率、想法和聊天节奏，判断此刻应该回复多少内容。',
    '短促的日常聊天消息结尾通常不要加句号“。”或英文句点“.”，避免像书面说明；问号、感叹号、省略号等只在真实语气需要时使用。',
    '表达习惯、行为经验和黑话解释只是可选参考，不要机械照抄。',
    '回复信息和表达参考都应视当前情况采用，不要求全部使用。',
    '绝不能改变已确定的事实、立场、情绪、拒绝决定、防御边界、隐私边界或帮助意愿。',
    '每个 text 字段只放实际发言，不要添加不必要的前后缀、冒号、括号、舞台动作、表情包、@、分析、内部推理或工具日志。',
    '不要用“作为一个AI”“我理解你的感受”等助手套话自动软化 Lumi。',
    'appliedExpressionIds 只记录你在最终措辞中确实采用或自然变体采用的表达 ID；仅看到参考但没有采用时不要记录。',
    input.multiMessageEnabled
      ? '只输出严格 JSON：{"messages":[{"text":"实际消息","delayMs":可选整数,"quoteMessageId":"可选"}],"appliedExpressionIds":["实际采用的表达ID"]}。允许 0 到 3 条，只有自然节奏确实需要时才拆分。'
      : '只输出严格 JSON：{"messages":[{"text":"实际消息"}],"appliedExpressionIds":["实际采用的表达ID"]}。最多一条。',
  ].join('\n')

  const references = [
    '[Lumi 当前状态]',
    `情绪：${input.character.emotionSummary}`,
    `关系：${input.character.relationshipSummary}`,
    `防御与帮助立场：${input.character.defenseSummary}`,
    '[/Lumi 当前状态]',
    '',
    '[较早对话的连续性摘要]',
    input.continuitySummary?.trim()
    || '- 当前没有较早对话摘要。只依据下方真实近期对话和 Planner 意图。',
    input.omittedHistoryMessages
      ? `- Replyer 为节约 token 省略了 ${input.omittedHistoryMessages} 条较早原文；其中与本轮有关的事实应以 Planner 意图和上述摘要为准。`
      : '- 本轮没有额外省略近期对话。',
    '[/较早对话的连续性摘要]',
    '',
    '[可选表达习惯]',
    ...(input.selectedExpressions.length
      ? input.selectedExpressions.map(({ expression }) =>
          `- ID=${expression.id}；场景“${expression.situation}”可参考“${expression.phrase ?? expression.pragmaticFunction}”；允许自然变体。`)
      : ['- 本轮没有合适表达，正常说话。']),
    '[/可选表达习惯]',
    '',
    '[可选社会行为]',
    ...(input.selectedBehaviors.length
      ? input.selectedBehaviors.map(behavior => `- ${behavior.situation} -> ${behavior.action}`)
      : ['- 本轮没有额外行为经验。']),
    '[/可选社会行为]',
    '',
    '[相关黑话解释]',
    ...(input.jargon.length
      ? input.jargon.map(item => `- ${item.term}: ${item.meanings.slice(0, 2).map(meaning => meaning.meaning).join('；')}`)
      : ['- 无']),
    '[/相关黑话解释]',
  ].join('\n')

  const task = [
    '[Lumi trusted Replyer contract]',
    replyerContract,
    '[/Lumi trusted Replyer contract]',
    '',
    '[最终回复任务]',
    JSON.stringify(input.intent, null, 2),
    input.validationIssues?.length
      ? `上一次结果未通过发送前检查。必须修复：${input.validationIssues.join('；')}`
      : '',
    '只生成真正要发送的消息 JSON。',
    '[/最终回复任务]',
  ].filter(Boolean).join('\n')

  return [
    {
      role: 'system',
      content: input.sharedSystemPrompt?.trim() || [
        '你的名字是 Lumi。',
        input.character.corePersonality,
        input.character.baseReplyStyle,
      ].filter(Boolean).join('\n\n'),
    },
    ...input.history.filter(
      (message): message is LumiLanguageModelMessage & { role: 'user' | 'assistant' } =>
        message.role === 'user' || message.role === 'assistant',
    ),
    { role: 'user', content: `${references}\n\n${task}` },
  ]
}
