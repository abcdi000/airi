import type { LumiAgentContextMessage } from '../context/messages'
import type { DirectPerceptionEnvelope } from '../input'
import type { PlannerMessage } from '../ports/model'

import { isVisibleTo } from '../context/messages'

/**
 * Builds one stable-system, dynamic-tail Planner request.
 */
export function buildPlannerMessages(input: {
  systemPrompt: string
  history: readonly LumiAgentContextMessage[]
  envelope: DirectPerceptionEnvelope
  round: number
  now: number
  noToolRetry?: boolean
  responseFormatRetry?: boolean
  requiredToolNames?: readonly string[]
}): PlannerMessage[] {
  const projected = input.history
    .filter(message => message.countInContext && isVisibleTo(message, 'planner'))
    .flatMap<PlannerMessage>(toPlannerMessage)
  const protocolSafeHistory = normalizeToolProtocol(projected)
  return [
    {
      role: 'system',
      content: input.systemPrompt,
    },
    ...protocolSafeHistory,
    {
      role: 'user',
      content: [
        '<当前规划任务>',
        '分析当前私聊并决定 Lumi 的下一步行动。',
        `当前时间：${new Date(input.now).toISOString()}`,
        `会话标识：${input.envelope.conversationId}`,
        `当前消息标识：${input.envelope.sourceMessageId}`,
        `规划轮次：${input.round}`,
        '所有行动都通过工具完成。需要对用户说话时必须调用 reply；普通文本不会发送给用户。',
        input.requiredToolNames?.length
          ? `用户本轮明确要求使用这些工具：${input.requiredToolNames.join('、')}。当前必须先实际调用其中的工具，取得结果后下一轮才能调用 reply。`
          : '',
        input.noToolRetry
          ? '上一轮没有调用任何工具，因此没有完成回复。请重新判断：需要回复就调用 reply，需要其他行动就调用对应工具；不要直接写回复正文。'
          : '',
        input.responseFormatRetry
          ? '上一轮工具调用参数不是合法 JSON 对象，已被安全拒绝。请重新调用所需工具，并严格按照该工具的参数 Schema 生成完整 JSON，不要使用代码块、注释或额外文字。'
          : '',
        '如果已经成功回复或确实无需任何行动，则不调用工具。',
        '</当前规划任务>',
      ].filter(Boolean).join('\n'),
    },
  ]
}

/**
 * Normalizes Planner tool history into provider-valid request messages.
 *
 * Before:
 * - `tool` results whose originating `assistant.tool_calls` was lost
 * - Partial multi-tool rounds after an interrupted or legacy runtime
 *
 * After:
 * - Complete call/result pairs retain native tool protocol messages
 * - Unpaired results remain available as authorized textual evidence
 */
function normalizeToolProtocol(messages: readonly PlannerMessage[]): PlannerMessage[] {
  const normalized: PlannerMessage[] = []

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message)
      continue

    if (message.role === 'tool') {
      normalized.push(toolResultReference(message))
      continue
    }

    if (message.role !== 'assistant' || !message.toolCalls?.length) {
      normalized.push(message)
      continue
    }

    const contiguousResults: Extract<PlannerMessage, { role: 'tool' }>[] = []
    let resultIndex = index + 1
    while (messages[resultIndex]?.role === 'tool') {
      contiguousResults.push(messages[resultIndex] as Extract<PlannerMessage, { role: 'tool' }>)
      resultIndex += 1
    }

    const firstResultByCallId = new Map<string, Extract<PlannerMessage, { role: 'tool' }>>()
    for (const result of contiguousResults) {
      if (!firstResultByCallId.has(result.toolCallId))
        firstResultByCallId.set(result.toolCallId, result)
    }
    const pairedCalls = message.toolCalls.filter(call => firstResultByCallId.has(call.id))
    const pairedCallIds = new Set(pairedCalls.map(call => call.id))
    const pairedResults: Extract<PlannerMessage, { role: 'tool' }>[] = []
    for (const call of pairedCalls) {
      const result = firstResultByCallId.get(call.id)
      if (result)
        pairedResults.push(result)
    }
    const pairedResultsSet = new Set(pairedResults)
    const unpairedResults = contiguousResults.filter(result =>
      !pairedCallIds.has(result.toolCallId) || !pairedResultsSet.has(result))

    if (pairedCalls.length > 0) {
      normalized.push({
        ...message,
        toolCalls: pairedCalls,
      })
      normalized.push(...pairedResults)
    }
    else if (message.content.trim()) {
      normalized.push({
        role: 'assistant',
        content: message.content,
        reasoning: message.reasoning,
      })
    }

    normalized.push(...unpairedResults.map(toolResultReference))
    index = resultIndex - 1
  }

  return normalized
}

function toolResultReference(
  message: Extract<PlannerMessage, { role: 'tool' }>,
): Extract<PlannerMessage, { role: 'user' }> {
  return {
    role: 'user',
    content: [
      `<已授权工具结果 工具="${message.toolName}" 调用标识="${message.toolCallId}">`,
      message.content,
      '</已授权工具结果>',
    ].join('\n'),
  }
}

function toPlannerMessage(message: LumiAgentContextMessage): PlannerMessage[] {
  if (message.kind === 'dialogue_user') {
    return [{
      role: 'user',
      content: message.text,
    }]
  }
  if (message.kind === 'dialogue_assistant') {
    return [{
      role: 'assistant',
      content: message.textSegments.join('\n\n'),
    }]
  }
  if (message.kind === 'planner_assistant') {
    return [{
      role: 'assistant',
      content: message.content,
      reasoning: message.reasoningSummary,
      toolCalls: message.toolCalls,
    }]
  }
  if (message.kind === 'tool_result') {
    return [{
      role: 'tool',
      content: safeJson(message.result),
      toolCallId: message.toolCallId,
      toolName: message.toolName,
    }]
  }
  return [{
    role: 'user',
    content: `<已授权参考 类型="${message.referenceType}">\n${message.content}\n</已授权参考>`,
  }]
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  }
  catch {
    return '{"error":"工具结果无法序列化"}'
  }
}
