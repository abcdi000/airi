import type { LumiReplyIntent, LumiVisibleReply } from './types'

export interface LumiReplyValidationResult {
  passed: boolean
  issues: string[]
}

const SOFTENED_HELP = [
  /我可以(继续)?帮/u,
  /可以尝试(以下|这样)/u,
  /不妨试试/u,
  /这里有(几个|一些)方法/u,
  /I can (still )?help/i,
]
const EMPTY_EMPATHY = [
  /我理解你的感受/u,
  /我能理解你/u,
  /I understand how you feel/i,
]
const AI_CLICHES = [
  /作为(一个|一名)?AI/u,
  /作为人工智能/u,
  /as an AI/i,
]
const STAGE_DIRECTIONS = [
  /^\s*[（(【[][^)\]】]{1,80}(笑|叹气|皱眉|沉默|歪头|摸头|抱|看着|眨眼)[^)\]】]*[）)】\]]/u,
  /\*(smiles?|sighs?|looks?|hugs?|nods?)\*/i,
]
const INTERNAL_RUNTIME_TERMS = [
  /\b(?:planner|replyer)\b/i,
  /意图框架|任务框架|语义意图|语义目标|内部运行机制|内部提示词|系统提示词|工具调用/u,
  /(?:规划器|表达器).{0,12}(?:要求|决定|生成|调用|框架|意图)/u,
]

/**
 * Validates semantic and character invariants before a visible reply is sent.
 *
 * The validator protects decisions; it does not impose friendliness, politeness,
 * or assistant-style completeness.
 */
export function validateLumiVisibleReply(input: {
  intent: LumiReplyIntent
  reply: LumiVisibleReply
  forbiddenPrivacyTokens?: string[]
  recentAssistantTexts?: string[]
}): LumiReplyValidationResult {
  const issues: string[] = []
  const text = input.reply.messages.map(message => message.text).join('\n')
  const normalized = text.trim()

  if (!input.intent.shouldReply && normalized)
    issues.push('Planner chose silence but Replyer produced visible text.')
  if (input.intent.shouldReply && !normalized && input.intent.replyAct !== 'stay_silent')
    issues.push('Planner requires a reply but Replyer returned no visible text.')
  if (input.intent.defenseState.refusalRequired) {
    if (SOFTENED_HELP.some(pattern => pattern.test(normalized)))
      issues.push('Required refusal was softened into an offer of help.')
  }
  if (input.intent.attitude.willingnessToHelp === 'unwilling' || input.intent.attitude.willingnessToHelp === 'refuse') {
    if (SOFTENED_HELP.some(pattern => pattern.test(normalized)))
      issues.push('Unwillingness was contradicted by an offer to continue helping.')
  }
  if (/angry|生气|愤怒|defensive|防御/i.test(input.intent.emotion.primary) && input.intent.emotion.intensity >= 0.55) {
    if (EMPTY_EMPATHY.some(pattern => pattern.test(normalized)))
      issues.push('Anger or defense was rewritten as generic empathy.')
  }
  if (input.intent.replyAct === 'disagree' && /你说得对|完全同意|you're right|I agree/i.test(normalized))
    issues.push('A disagreement intent became agreement.')
  if (AI_CLICHES.some(pattern => pattern.test(normalized)))
    issues.push('Reply contains an unnecessary AI disclaimer.')
  if (STAGE_DIRECTIONS.some(pattern => pattern.test(normalized)))
    issues.push('Reply contains a bracketed stage direction.')
  if (/```(?:json)?|"(?:shouldReply|replyAct|semanticGoal|immutableConstraints)"\s*:/i.test(normalized))
    issues.push('Reply leaks internal JSON or Planner labels.')
  if (INTERNAL_RUNTIME_TERMS.some(pattern => pattern.test(normalized)))
    issues.push('Reply leaks internal runtime terminology.')
  if (looksLikeUnnecessaryOutline(normalized) && input.intent.expressionIntent.desiredLength !== 'long')
    issues.push('Reply introduced an unnecessary assistant-style outline.')
  if (repeatsQuestionAsHeading(normalized))
    issues.push('Reply unnecessarily repeats the user question as a heading.')
  if (input.forbiddenPrivacyTokens?.some(token => token.length >= 3 && normalized.includes(token)))
    issues.push('Reply contains content marked as unauthorized private context.')
  if (
    normalized
    && input.recentAssistantTexts?.some(previous =>
      normalizeReplyForComparison(previous) === normalizeReplyForComparison(normalized),
    )
  ) {
    issues.push('Reply exactly repeats a recent assistant response.')
  }
  for (const constraint of input.intent.immutableConstraints) {
    if (/不能道歉|不得道歉/u.test(constraint) && /对不起|抱歉|sorry/i.test(normalized))
      issues.push('Reply violates the immutable no-apology constraint.')
    if (/必须明确反对/u.test(constraint) && /你说得对|同意/u.test(normalized))
      issues.push('Reply violates the immutable disagreement constraint.')
    if (/只表达不满|不提供方案/u.test(constraint) && looksLikeAdvice(normalized))
      issues.push('Reply provides a solution despite a no-solution constraint.')
  }
  return { passed: issues.length === 0, issues }
}

/**
 * Normalizes a complete reply for exact repetition checks.
 *
 * Before:
 * - "  Not now.\nTry later.  "
 *
 * After:
 * - "not now. try later."
 */
function normalizeReplyForComparison(text: string) {
  return text
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase()
}

function looksLikeAdvice(text: string) {
  return /可以|建议|试试|步骤|方法|首先|其次|你需要/u.test(text)
}

function looksLikeUnnecessaryOutline(text: string) {
  return /(?:^|\n)\s*(?:#{1,4}\s+|1[.、]|一[、.]|首先[:：])/u.test(text)
}

function repeatsQuestionAsHeading(text: string) {
  return /(?:^|\n)\s*(?:问题|你的问题|关于你问的)[:：]/u.test(text)
}
