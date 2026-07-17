export interface LumiConversationGuardResult {
  isCorrection: boolean
  isTopicCorrection: boolean
  isMemoryCorrection: boolean
  reason?: string
}

const CORRECTION_PATTERNS = [
  /\b(that'?s not|not that|not this|wrong|you are wrong|you got it wrong|misremembered|remembered wrong)\b/i,
  /\bI (?:said|told you) (?:something else|another thing)\b/i,
  /不是这个/,
  /不是那个/,
  /不是这[件个回事]/,
  /不对/,
  /错了/,
  /记错了/,
  /你记错/,
  /我都说/,
  /我说的是/,
  /我说其他/,
  /其他事情/,
  /别再说/,
  /别重复/,
  /别老/,
  /不要再/,
]

const MEMORY_CORRECTION_PATTERNS = [
  /\b(?:remember|memory|misremembered|remembered wrong)\b/i,
  /记忆/,
  /记得/,
  /记错/,
  /回忆/,
]

const TOPIC_CORRECTION_PATTERNS = [
  /\b(?:not that|not this|something else|another thing|topic)\b/i,
  /不是这个/,
  /不是那个/,
  /其他事情/,
  /别再说/,
  /我说的是/,
]

export function analyzeLumiConversationGuard(userText: string): LumiConversationGuardResult {
  const text = userText.trim()
  if (!text)
    return { isCorrection: false, isTopicCorrection: false, isMemoryCorrection: false }

  const isCorrection = CORRECTION_PATTERNS.some(pattern => pattern.test(text))
  const isMemoryCorrection = isCorrection && MEMORY_CORRECTION_PATTERNS.some(pattern => pattern.test(text))
  const isTopicCorrection = isCorrection && TOPIC_CORRECTION_PATTERNS.some(pattern => pattern.test(text))

  return {
    isCorrection,
    isMemoryCorrection,
    isTopicCorrection,
    reason: isCorrection
      ? isMemoryCorrection
        ? 'user_corrects_memory_or_prior_claim'
        : isTopicCorrection
          ? 'user_corrects_topic_or_repetition'
          : 'user_corrects_prior_response'
      : undefined,
  }
}
