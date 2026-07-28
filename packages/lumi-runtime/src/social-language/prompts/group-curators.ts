import type {
  GroupLearningCuratorKind,
  SocialLanguageGroupObservation,
} from '../types'

const TASKS: Record<GroupLearningCuratorKind, {
  purpose: string
  schema: string
}> = {
  expression: {
    purpose: '寻找可复用的措辞、句式、节奏、标点、消息长度或多消息习惯。',
    schema: '{"candidates":[{"sourceMessageIds":[""],"phrase":"optional","situation":"","pragmaticFunction":"","emotionalMeaning":"optional","tone":"optional","patternType":"exact_phrase | sentence_pattern | rhythm | punctuation | message_length | multi_message_sequence | reaction | jargon | swear | exaggeration","confidence":0.0}]}',
  },
  jargon: {
    purpose: '解释黑话或社群词语在当前具体社交语境中的实际含义。',
    schema: '{"candidates":[{"sourceMessageIds":[""],"term":"","meaning":"","context":"","literalMeaning":"optional","pragmaticFunctions":[],"emotionalTone":"optional","communities":[],"confidence":0.0}]}',
  },
  behavior: {
    purpose: '寻找可复用的社会参与行为，包括何时回答、提问、调侃、等待或沉默。',
    schema: '{"candidates":[{"sourceMessageIds":[""],"situation":"","action":"","expectedEffect":"optional","confidence":0.0}]}',
  },
  public_knowledge: {
    purpose: '寻找群内公开分享、适合长期保留为群范围上下文的稳定知识。',
    schema: '{"candidates":[{"sourceMessageIds":[""],"content":"","confidence":0.0}]}',
  },
}

/**
 * Builds one isolated, read-only group curator request.
 *
 * Use when:
 * - A host runs expression, jargon, behavior, and public-knowledge learning independently
 * - Candidate provenance must be checked against the current batch
 *
 * Expects:
 * - `focusBatch` belongs to one authorized source and is time ordered
 *
 * Returns:
 * - A tool-free prompt that requires source IDs on every candidate
 */
export function buildObservedGroupCuratorMessages(input: {
  kind: GroupLearningCuratorKind
  focusBatch: SocialLanguageGroupObservation[]
  recentContext?: SocialLanguageGroupObservation[]
  systemPromptOverride?: string
}): Array<{ role: 'system' | 'user', content: string }> {
  const task = TASKS[input.kind]
  const speakerAliases = new Map<string, string>()
  const alias = (senderId: string) => {
    const existing = speakerAliases.get(senderId)
    if (existing)
      return existing
    const next = `speaker-${speakerAliases.size + 1}`
    speakerAliases.set(senderId, next)
    return next
  }
  const project = (observation: SocialLanguageGroupObservation) => ({
    messageId: observation.messageId,
    speaker: alias(observation.senderId),
    text: observation.text,
    timestamp: observation.timestamp,
  })

  return [
    {
      role: 'system',
      content: input.systemPromptOverride?.trim() || [
        `你是 Lumi 的 ${input.kind} 归纳器，不是 Lumi，绝不能在群聊中回复。`,
        task.purpose,
        '只使用所提供消息支持的重复或稳定证据。',
        '每个候选必须引用 focus_batch 中一个或多个 sourceMessageIds。',
        '不要包含私密秘密、账号标识、说话人姓名、临时对象、命令、角色扮演、代码、日志、网页文字、字幕、转发文字或系统与工具输出。',
        '不要把一次性事实变成语言习惯，也不要把候选直接提升为已采用习惯。',
        '只按以下结构返回严格 JSON：',
        task.schema,
        '证据不足时返回空 candidates 数组。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        recent_context: (input.recentContext ?? []).map(project),
        focus_batch: input.focusBatch.map(project),
      }),
    },
  ]
}
