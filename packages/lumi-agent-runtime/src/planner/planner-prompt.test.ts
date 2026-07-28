import type { LumiAgentContextMessage } from '../context/messages'

import { describe, expect, it } from 'vitest'

import { buildPlannerMessages } from './planner-prompt'

const base = {
  timestamp: 1,
  countInContext: true,
  remainingUses: null,
  source: 'test',
  visibility: 'planner' as const,
  provenance: { origin: 'test', sourceIds: [] },
}

function messages(history: LumiAgentContextMessage[]) {
  return buildPlannerMessages({
    systemPrompt: 'system',
    history,
    envelope: {
      eventId: 'event-current',
      conversationId: 'direct:doggy',
      sourceMessageId: 'message-current',
      personId: 'doggy',
      participantPersonIds: ['doggy'],
      platform: 'desktop',
      platformInstanceId: 'desktop-local',
      externalUserId: 'doggy',
      conversationType: 'direct',
      timestamp: 2,
      segments: [{ type: 'text', text: 'test' }],
      text: 'test',
      attachments: [],
    },
    round: 1,
    now: 2,
  }).slice(1, -1)
}

describe('Planner tool protocol normalization', () => {
  it('preserves a complete multi-tool call and result group', () => {
    const projected = messages([
      {
        ...base,
        id: 'planner-1',
        kind: 'planner_assistant',
        round: 1,
        content: '',
        toolCalls: [
          { id: 'call-a', name: 'query_memory', arguments: { query: '生日' } },
          { id: 'call-b', name: 'read_current_state', arguments: {} },
        ],
      },
      {
        ...base,
        id: 'result-a',
        kind: 'tool_result',
        toolCallId: 'call-a',
        toolName: 'query_memory',
        success: true,
        result: { answer: '7月21日' },
      },
      {
        ...base,
        id: 'result-b',
        kind: 'tool_result',
        toolCallId: 'call-b',
        toolName: 'read_current_state',
        success: true,
        result: { topic: '生日' },
      },
    ])

    expect(projected).toHaveLength(3)
    expect(projected[0]).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'call-a' }, { id: 'call-b' }],
    })
    expect(projected[1]).toMatchObject({ role: 'tool', toolCallId: 'call-a' })
    expect(projected[2]).toMatchObject({ role: 'tool', toolCallId: 'call-b' })
  })

  it('projects an orphaned legacy tool result as authorized evidence', () => {
    const projected = messages([{
      ...base,
      id: 'result-a',
      kind: 'tool_result',
      toolCallId: 'call-a',
      toolName: 'query_memory',
      success: true,
      result: { answer: '7月21日' },
    }])

    expect(projected).toHaveLength(1)
    expect(projected[0]?.role).toBe('user')
    expect(projected[0]?.content).toContain('<已授权工具结果')
    expect(projected[0]?.content).toContain('7月21日')
  })

  it('keeps only calls that have results after an interrupted multi-tool round', () => {
    const projected = messages([
      {
        ...base,
        id: 'planner-1',
        kind: 'planner_assistant',
        round: 1,
        content: '',
        toolCalls: [
          { id: 'call-a', name: 'query_memory', arguments: {} },
          { id: 'call-b', name: 'broken_tool', arguments: {} },
        ],
      },
      {
        ...base,
        id: 'result-a',
        kind: 'tool_result',
        toolCallId: 'call-a',
        toolName: 'query_memory',
        success: true,
        result: [],
      },
    ])

    expect(projected).toHaveLength(2)
    expect(projected[0]).toMatchObject({
      role: 'assistant',
      toolCalls: [{ id: 'call-a' }],
    })
    expect(projected[1]).toMatchObject({ role: 'tool', toolCallId: 'call-a' })
  })

  it('drops an empty assistant tool call record when every result is missing', () => {
    const projected = messages([{
      ...base,
      id: 'planner-1',
      kind: 'planner_assistant',
      round: 1,
      content: '',
      toolCalls: [{ id: 'call-a', name: 'query_memory', arguments: {} }],
    }])

    expect(projected).toEqual([])
  })
})
