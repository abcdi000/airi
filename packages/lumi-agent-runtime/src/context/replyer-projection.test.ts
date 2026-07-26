import type { LumiAgentContextMessage } from './messages'

import { describe, expect, it } from 'vitest'

import { projectReplyerHistory } from './replyer-projection'

const base = {
  timestamp: 1,
  countInContext: true,
  remainingUses: null,
  source: 'test',
  provenance: { origin: 'test', sourceIds: [] },
}

describe('replyer projection', () => {
  it('excludes Planner and raw tool records from Replyer history', () => {
    const messages: LumiAgentContextMessage[] = [
      {
        ...base,
        id: 'user-1',
        kind: 'dialogue_user',
        messageId: 'message-1',
        personId: 'doggy',
        text: 'hello',
        segments: [{ type: 'text', text: 'hello' }],
        attachments: [],
        visibility: 'both',
      },
      {
        ...base,
        id: 'planner-1',
        kind: 'planner_assistant',
        round: 1,
        content: 'private planner content',
        toolCalls: [{ id: 'call-1', name: 'query_memory', arguments: {} }],
        visibility: 'both',
      },
      {
        ...base,
        id: 'tool-1',
        kind: 'tool_result',
        toolCallId: 'call-1',
        toolName: 'query_memory',
        success: true,
        result: { secret: true },
        visibility: 'both',
      },
    ]

    const projected = projectReplyerHistory(messages)
    expect(projected.map(message => message.id)).toEqual(['user-1'])
  })
})
