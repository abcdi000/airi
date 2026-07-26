import type { LumiAgentContextMessage } from './messages'

import { describe, expect, it } from 'vitest'

import {
  buildAtomicContextSegments,
  selectContextWithinBudget,
} from './history'

const base = {
  timestamp: 1,
  countInContext: true,
  remainingUses: null,
  source: 'test',
  visibility: 'planner' as const,
  provenance: { origin: 'test', sourceIds: [] },
}

describe('typed context history', () => {
  it('keeps Planner tool calls and all matching results in one atomic segment', () => {
    const messages: LumiAgentContextMessage[] = [
      {
        ...base,
        id: 'planner-1',
        kind: 'planner_assistant',
        round: 1,
        content: '',
        toolCalls: [
          { id: 'call-a', name: 'query_memory', arguments: {} },
          { id: 'call-b', name: 'query_person_profile', arguments: {} },
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
      {
        ...base,
        id: 'result-b',
        kind: 'tool_result',
        toolCallId: 'call-b',
        toolName: 'query_person_profile',
        success: true,
        result: {},
      },
    ]

    const segments = buildAtomicContextSegments(messages, () => 1)
    expect(segments).toHaveLength(1)
    expect(segments[0]?.messages.map(message => message.id)).toEqual([
      'planner-1',
      'result-a',
      'result-b',
    ])
  })

  it('drops a whole tool atom when the remaining budget cannot fit it', () => {
    const messages: LumiAgentContextMessage[] = [
      {
        ...base,
        id: 'planner-1',
        kind: 'planner_assistant',
        round: 1,
        content: '',
        toolCalls: [{ id: 'call-a', name: 'query_memory', arguments: {} }],
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
      {
        ...base,
        id: 'user-2',
        kind: 'dialogue_user',
        messageId: 'message-2',
        personId: 'doggy',
        text: 'new',
        segments: [{ type: 'text', text: 'new' }],
        attachments: [],
        visibility: 'both',
      },
    ]

    const selected = selectContextWithinBudget(messages, 1, () => 1)
    expect(selected.map(message => message.id)).toEqual(['user-2'])
  })
})
