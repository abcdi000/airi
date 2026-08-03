import type { Message } from '@xsai/shared-chat'

import { describe, expect, it } from 'vitest'

import { toSub2ApiResponsesInput } from './index'

describe('offline Sub2API Responses message conversion', () => {
  /** @example toSub2ApiResponsesInput(messages, true) */
  it('moves system messages to instructions and preserves image and tool call IDs', () => {
    const messages: Message[] = [
      { role: 'system', content: 'System A' },
      { role: 'developer', content: 'System B' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA', detail: 'high' } },
        ],
      },
      {
        role: 'assistant',
        content: '我先查一下',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"id":1}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
    ]

    const result = toSub2ApiResponsesInput(messages, true)

    expect(result.instructions).toBe('System A\n\nSystem B')
    expect(result.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '看图' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: 'high' },
        ],
      },
      { type: 'message', role: 'assistant', content: '我先查一下' },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
    ])
    expect(JSON.stringify(result)).not.toContain('previous_response_id')
    expect(JSON.stringify(result)).not.toContain('rs_')
  })

  /** @example toSub2ApiResponsesInput(messages, false) */
  it('keeps text but omits direct image input when multimodal mode is disabled', () => {
    const result = toSub2ApiResponsesInput([{
      role: 'user',
      content: [
        { type: 'text', text: '视觉模块的文字理解' },
        { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
      ],
    }], false)

    expect(result.input).toEqual([{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '视觉模块的文字理解' }],
    }])
  })
})
