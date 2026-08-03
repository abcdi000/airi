import type { Sub2ApiClientTransport } from '@proj-airi/lumi-runtime/providers/sub2api'
import type { Message } from '@xsai/shared-chat'

import type { Sub2ApiClientProvider } from './index'

import { getProviderChatTransport } from '@proj-airi/core-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getSub2ApiClientTransport,
  providerSub2Api,
  setSub2ApiClientTransport,
  toSub2ApiResponsesInput,
} from './index'

const defaultTransport = getSub2ApiClientTransport()

afterEach(() => {
  setSub2ApiClientTransport(defaultTransport)
})

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

describe('offline Sub2API platform transport', () => {
  /** @example providerSub2Api.createProvider(config) */
  it('uses the injected desktop transport for model rounds', async () => {
    // ROOT CAUSE:
    //
    // Before the desktop transport boundary, this provider called
    // globalThis.fetch in Renderer and third-party CORS preflight returned 403.
    const transport: Sub2ApiClientTransport = {
      listModels: vi.fn(),
      getAccountStatus: vi.fn(),
      runRound: vi.fn(async () => ({
        protocol: 'responses' as const,
        fallbackUsed: false,
        value: {
          text: 'from-main',
          toolCalls: [],
          requestedModel: 'gpt-test',
        },
      })),
    }
    setSub2ApiClientTransport(transport)
    const provider = await providerSub2Api.createProvider({
      apiKey: 'test-api-key',
      baseUrl: 'https://sub2api.example/v1/',
      preferredModel: 'gpt-test',
      protocol: 'auto',
      reasoningEffort: 'auto',
      maxToolSteps: 64,
      multimodalEnabled: false,
      accountApiBaseUrl: '',
      accountAccessToken: '',
      apiTestPassed: false,
    })

    const chatProvider = provider as Sub2ApiClientProvider
    const result = await getProviderChatTransport(chatProvider)?.streamRound({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      stepNumber: 0,
    })

    expect(transport.runRound).toHaveBeenCalledTimes(1)
    expect(result?.text).toBe('from-main')
  })
})
