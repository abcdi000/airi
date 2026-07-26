import type {
  LumiAgentContextMessage,
  PlannerAssistantMessage,
  ReferenceMessage,
  ToolResultMessage,
} from './messages'

/** An indivisible context segment used by budget selection. */
export interface AtomicContextSegment {
  id: string
  messages: readonly LumiAgentContextMessage[]
  estimatedTokens: number
}

/** Token estimator injected by model adapters when an exact tokenizer exists. */
export type ContextTokenEstimator = (message: LumiAgentContextMessage) => number

function defaultTokenEstimator(message: LumiAgentContextMessage): number {
  const serialized = JSON.stringify(message)
  return Math.max(1, Math.ceil(serialized.length / 4))
}

function isToolCallingPlannerMessage(
  message: LumiAgentContextMessage,
): message is PlannerAssistantMessage {
  return message.kind === 'planner_assistant' && message.toolCalls.length > 0
}

function isToolResult(message: LumiAgentContextMessage): message is ToolResultMessage {
  return message.kind === 'tool_result'
}

/**
 * Groups Planner tool calls and matching results into indivisible segments.
 *
 * Use when:
 * - Trimming Planner history to a model context budget
 * - Freezing an old context segment for summary generation
 *
 * Expects:
 * - Tool call IDs are unique within a direct conversation generation
 *
 * Returns:
 * - Segments ordered by the earliest original message index
 */
export function buildAtomicContextSegments(
  messages: readonly LumiAgentContextMessage[],
  estimateTokens: ContextTokenEstimator = defaultTokenEstimator,
): readonly AtomicContextSegment[] {
  const claimedIndices = new Set<number>()
  const segments: Array<{ firstIndex: number, segment: AtomicContextSegment }> = []

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message || !isToolCallingPlannerMessage(message))
      continue

    const callIds = new Set(message.toolCalls.map(call => call.id))
    const memberIndices = [index]
    for (let candidateIndex = index + 1; candidateIndex < messages.length; candidateIndex += 1) {
      const candidate = messages[candidateIndex]
      if (candidate && isToolResult(candidate) && callIds.has(candidate.toolCallId))
        memberIndices.push(candidateIndex)
    }
    const members = memberIndices.map(memberIndex => messages[memberIndex]).filter(Boolean)
    memberIndices.forEach(memberIndex => claimedIndices.add(memberIndex))
    segments.push({
      firstIndex: index,
      segment: {
        id: `tool-atomic:${message.id}`,
        messages: members,
        estimatedTokens: members.reduce((sum, member) => sum + estimateTokens(member), 0),
      },
    })
  }

  for (let index = 0; index < messages.length; index += 1) {
    if (claimedIndices.has(index))
      continue
    const message = messages[index]
    if (!message)
      continue
    segments.push({
      firstIndex: index,
      segment: {
        id: `message:${message.id}`,
        messages: [message],
        estimatedTokens: estimateTokens(message),
      },
    })
  }

  return segments
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map(item => item.segment)
}

/**
 * Selects newest atomic segments without splitting tool call/result pairs.
 *
 * Use when:
 * - A request must fit a strict token budget
 *
 * Expects:
 * - `budgetTokens` includes only history, not system or output reserves
 *
 * Returns:
 * - Selected messages in original chronological order
 */
export function selectContextWithinBudget(
  messages: readonly LumiAgentContextMessage[],
  budgetTokens: number,
  estimateTokens?: ContextTokenEstimator,
): readonly LumiAgentContextMessage[] {
  if (!Number.isFinite(budgetTokens) || budgetTokens < 0)
    throw new RangeError('budgetTokens must be a non-negative finite number')

  const segments = buildAtomicContextSegments(messages, estimateTokens)
  const selected: AtomicContextSegment[] = []
  let usedTokens = 0
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    if (!segment)
      continue
    if (usedTokens + segment.estimatedTokens > budgetTokens)
      continue
    selected.push(segment)
    usedTokens += segment.estimatedTokens
  }
  selected.reverse()
  return selected.flatMap(segment => segment.messages)
}

/**
 * Decrements bounded reference lifetimes after one Planner request.
 *
 * Use when:
 * - A successfully constructed Planner request consumed references
 *
 * Expects:
 * - Permanent references use `remainingUses=null`
 *
 * Returns:
 * - A new history array with expired references removed
 */
export function consumeReferenceUses(
  messages: readonly LumiAgentContextMessage[],
): readonly LumiAgentContextMessage[] {
  return messages.flatMap((message) => {
    if (message.kind !== 'reference' || message.remainingUses === null)
      return [message]
    const remainingUses = message.remainingUses - 1
    if (remainingUses <= 0)
      return []
    return [{ ...message, remainingUses } satisfies ReferenceMessage]
  })
}
