import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message, Tool } from '@xsai/shared-chat'

import type { ProviderChatTransport, StreamUsage, TransportChatProvider } from '../types/llm'

import { stepCountAtLeast } from '@xsai/shared-chat'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { providerChatTransport } from '../types/llm'
import { dedupeToolsByName, isContentArrayRelatedError, sanitizeMessages, streamFrom } from './llm-service'

const { streamTextMock } = vi.hoisted(() => ({
  streamTextMock: vi.fn(),
}))

vi.mock('@xsai/stream-text', () => ({
  streamText: streamTextMock,
}))

vi.mock('@xsai/shared-chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xsai/shared-chat')>()
  return {
    ...actual,
    stepCountAtLeast: vi.fn(),
  }
})

const provider = {
  chat: () => ({
    baseURL: 'https://example.com/',
  }),
} as unknown as ChatProvider

beforeEach(() => {
  streamTextMock.mockReset()
  ;(stepCountAtLeast as unknown as ReturnType<typeof vi.fn>).mockReset()
  ;(stepCountAtLeast as unknown as ReturnType<typeof vi.fn>).mockReturnValue('stop-when')
})

function createMockStreamResult(steps: Promise<unknown[]> = Promise.resolve([])) {
  return {
    steps,
    messages: Promise.resolve([]),
    usage: Promise.resolve(undefined),
    totalUsage: Promise.resolve(undefined),
  }
}

describe('dedupeToolsByName', () => {
  it('dedupes provider tools by function name and lets later entries win', () => {
    const builtinFallback = {
      type: 'function',
      function: {
        name: 'builtIn_mcpCallTool',
        description: 'fallback',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    } satisfies Tool
    const runtimeTool = {
      type: 'function',
      function: {
        name: 'builtIn_mcpCallTool',
        description: 'runtime',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    } satisfies Tool
    const uniqueTool = {
      type: 'function',
      function: {
        name: 'mcp_browser_navigate',
        description: 'Navigate browser.',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    } satisfies Tool

    expect(dedupeToolsByName([builtinFallback, runtimeTool, uniqueTool])).toEqual([
      runtimeTool,
      uniqueTool,
    ])
  })
})

describe('streamFrom step budget', () => {
  it('uses a larger default step budget for multi-tool tasks', async () => {
    streamTextMock.mockReturnValueOnce(createMockStreamResult())

    await streamFrom({
      model: 'model-a',
      chatProvider: provider,
      messages: [{ role: 'user', content: 'browse until done' }] as Message[],
    })

    expect(stepCountAtLeast).toHaveBeenCalledWith(64)
    expect(streamTextMock.mock.calls[0]?.[0].stopWhen).toBe('stop-when')
  })

  it('allows callers to override and clamps the stream step budget', async () => {
    streamTextMock.mockReturnValueOnce(createMockStreamResult())

    await streamFrom({
      model: 'model-a',
      chatProvider: provider,
      messages: [{ role: 'user', content: 'browse until done' }] as Message[],
      options: {
        maxSteps: 200,
      },
    })

    expect(stepCountAtLeast).toHaveBeenCalledWith(200)
  })

  it('forwards a per-request output token ceiling to the provider', async () => {
    streamTextMock.mockReturnValueOnce(createMockStreamResult())

    await streamFrom({
      model: 'model-a',
      chatProvider: provider,
      messages: [{ role: 'user', content: 'summarize briefly' }] as Message[],
      options: {
        maxOutputTokens: 2_048,
      },
    })

    expect(streamTextMock.mock.calls[0]?.[0].maxTokens).toBe(2_048)
  })

  it('reports cache usage from every completed provider step', async () => {
    const onUsage = vi.fn()
    const usage = {
      completion_tokens: 12,
      prompt_tokens: 120,
      total_tokens: 132,
      prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 40,
    } satisfies StreamUsage
    streamTextMock.mockReturnValueOnce(createMockStreamResult(Promise.resolve([{
      finishReason: 'stop',
      stepType: 'done',
      toolCalls: [],
      toolResults: [],
      usage,
    }])))

    await streamFrom({
      model: 'model-a',
      chatProvider: provider,
      messages: [{ role: 'user', content: 'measure cache usage' }] as Message[],
      options: { onUsage },
    })

    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledWith(usage)
  })
})

describe('streamFrom final tool policy', () => {
  /**
   * @example
   * await streamFrom({ options: { toolTransform: () => [] }, builtinToolsResolver })
   */
  it('filters builtin tools after merging so an empty caller tool list cannot bypass a per-turn denial', async () => {
    // ROOT CAUSE:
    //
    // AIRI merges builtin tools independently from options.tools. Passing []
    // therefore did not disable the builtin MCP proxy for chat-only devices.
    // The final transform now sees and filters the complete merged tool set.
    const builtinTool = {
      type: 'function',
      function: {
        name: 'builtIn_mcpCallTool',
        description: 'Call any MCP tool.',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(),
    } satisfies Tool
    streamTextMock.mockReturnValueOnce(createMockStreamResult())

    await streamFrom({
      model: 'model-a',
      chatProvider: provider,
      messages: [{ role: 'user', content: 'hello' }] as Message[],
      builtinToolsResolver: async () => [builtinTool],
      options: {
        tools: [],
        toolTransform: tools => tools.filter(tool => tool.function.name === 'lumi_memory_search'),
      },
    })

    expect(streamTextMock.mock.calls[0]?.[0].tools).toBeUndefined()
  })
})

describe('streamFrom tool error capture', () => {
  /**
   * @example
   * await streamFrom({ model, chatProvider, messages, options: { captureToolErrors: true } })
   */
  it('keeps captureToolErrors internal while forwarding failed tool calls as tool-error events', async () => {
    let resolveSteps: ((steps: unknown[]) => void) | undefined
    const events: unknown[] = []
    const failingTool = {
      type: 'function',
      function: {
        name: 'play_chess',
        description: 'Start chess.',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(() => {
        throw new Error('Focus mode does not accept game-state mutation inputs.')
      }),
    } satisfies Tool

    streamTextMock.mockImplementationOnce((options: {
      captureToolErrors?: boolean
      onEvent: (event: unknown) => Promise<void>
      tools?: Tool[]
    }) => {
      const steps = new Promise<unknown[]>((resolve) => {
        resolveSteps = resolve
      })

      queueMicrotask(async () => {
        const result = await options.tools?.[0]?.execute({}, {
          messages: [],
          toolCallId: 'call-1',
        })

        await options.onEvent({
          type: 'tool-result',
          args: {},
          result,
          toolCallId: 'call-1',
          toolName: 'play_chess',
        })
        await options.onEvent({ type: 'finish', finishReason: 'stop' })
        resolveSteps?.([])
      })

      return createMockStreamResult(steps)
    })

    await streamFrom({
      model: 'model-a',
      chatProvider: provider,
      messages: [{ role: 'user', content: 'play chess' }] as Message[],
      options: {
        captureToolErrors: true,
        tools: [failingTool],
        onStreamEvent: (event) => {
          events.push(event)
        },
      },
    })

    const streamOptions = streamTextMock.mock.calls[0]?.[0]
    expect(streamOptions.captureToolErrors).toBeUndefined()
    expect(streamOptions.tools?.[0]).not.toBe(failingTool)
    expect(failingTool.execute).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool-error',
      isError: true,
      toolCallId: 'call-1',
      toolName: 'play_chess',
      result: expect.stringContaining('Focus mode does not accept game-state mutation inputs.'),
    }))
  })
})

describe('streamFrom provider-native transport', () => {
  /** @example await streamFrom({ chatProvider: providerWithTransport, options: { tools } }) */
  it('keeps tool execution in core-agent and continues with the same call ID', async () => {
    const events: unknown[] = []
    const execute = vi.fn(async (input: unknown) => JSON.stringify({ echoed: input }))
    const tool = {
      type: 'function',
      function: {
        name: 'echo_test',
        description: 'Echo one value.',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
      execute,
    } satisfies Tool
    const streamRound = vi.fn<ProviderChatTransport['streamRound']>(async (input) => {
      if (input.stepNumber === 0) {
        return {
          text: '我先处理',
          toolCalls: [{
            args: '{"value":"LUMI_TOOL_OK"}',
            toolCallId: 'call_1',
            toolCallType: 'function',
            toolName: 'echo_test',
          }],
          finishReason: 'tool_calls',
        }
      }

      expect(input.messages.at(-1)).toMatchObject({
        role: 'tool',
        tool_call_id: 'call_1',
      })
      return {
        text: '工具完成',
        toolCalls: [],
        finishReason: 'stop',
      }
    })
    const providerWithTransport: TransportChatProvider = {
      chat: model => ({ apiKey: '', baseURL: 'https://example.com/v1/', model }),
      [providerChatTransport]: { streamRound },
    }

    await streamFrom({
      model: 'model-a',
      chatProvider: providerWithTransport,
      messages: [{ role: 'user', content: 'use tool' }],
      options: {
        tools: [tool],
        onStreamEvent: (event) => {
          events.push(event)
        },
      },
    })

    expect(streamTextMock).not.toHaveBeenCalled()
    expect(streamRound).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledWith({ value: 'LUMI_TOOL_OK' }, expect.objectContaining({
      toolCallId: 'call_1',
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool-result',
      toolCallId: 'call_1',
      toolName: 'echo_test',
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'finish',
      finishReason: 'stop',
    }))
  })

  /** @example await streamFrom({ options: { maxSteps: 1 } }) */
  it('enforces the configured maximum provider-native tool steps', async () => {
    const tool = {
      type: 'function',
      function: {
        name: 'echo_test',
        description: 'Echo one value.',
        parameters: { type: 'object', properties: {} },
      },
      execute: vi.fn(async () => 'ok'),
    } satisfies Tool
    const providerWithTransport: TransportChatProvider = {
      chat: model => ({ apiKey: '', baseURL: 'https://example.com/v1/', model }),
      [providerChatTransport]: {
        streamRound: async () => ({
          text: '',
          toolCalls: [{
            args: '{}',
            toolCallId: 'call_1',
            toolCallType: 'function',
            toolName: 'echo_test',
          }],
          finishReason: 'tool_calls',
        }),
      },
    }

    await expect(streamFrom({
      model: 'model-a',
      chatProvider: providerWithTransport,
      messages: [{ role: 'user', content: 'continue forever' }],
      options: { maxSteps: 1, tools: [tool] },
    })).rejects.toThrow('exceeded maxSteps=1')
    expect(tool.execute).toHaveBeenCalledTimes(1)
  })

  /** @example await streamFrom({ options: { abortSignal } }) */
  it('stops before provider I/O when the request is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const streamRound = vi.fn<ProviderChatTransport['streamRound']>()
    const providerWithTransport: TransportChatProvider = {
      chat: model => ({ apiKey: '', baseURL: 'https://example.com/v1/', model }),
      [providerChatTransport]: { streamRound },
    }

    await expect(streamFrom({
      model: 'model-a',
      chatProvider: providerWithTransport,
      messages: [{ role: 'user', content: 'cancel' }],
      options: { abortSignal: controller.signal },
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(streamRound).not.toHaveBeenCalled()
  })

  /** @example await streamFrom({ chatProvider: autoProvider }) */
  it('delegates the whole first round to Chat Completions when transport returns undefined', async () => {
    streamTextMock.mockReturnValueOnce(createMockStreamResult())
    const streamRound = vi.fn<ProviderChatTransport['streamRound']>(async () => undefined)
    const providerWithTransport: TransportChatProvider = {
      chat: model => ({ apiKey: '', baseURL: 'https://example.com/v1/', model }),
      [providerChatTransport]: { streamRound },
    }

    await streamFrom({
      model: 'model-a',
      chatProvider: providerWithTransport,
      messages: [{ role: 'user', content: 'fallback' }],
    })

    expect(streamRound).toHaveBeenCalledTimes(1)
    expect(streamTextMock).toHaveBeenCalledTimes(1)
  })
})

describe('sanitizeMessages', () => {
  it('rewrites internal `error`-role messages as user-role narrations', () => {
    /**
     * @example
     * sanitizeMessages([{ role: 'error', content: 'Remote sent 400' }])
     * // -> [{ role: 'user', content: 'User encountered error: Remote sent 400' }]
     */
    const out = sanitizeMessages([{ role: 'error', content: 'Remote sent 400' }])
    expect(out).toEqual([
      { role: 'user', content: 'User encountered error: Remote sent 400' },
    ])
  })

  it('flattens text-only content arrays to a string by default', () => {
    /**
     * @example
     * sanitizeMessages([{
     *   role: 'user',
     *   content: [{ type: 'text', text: 'hi' }, { type: 'text', text: ' there' }],
     * }])
     * // -> [{ role: 'user', content: 'hi there' }]
     */
    const out = sanitizeMessages([{
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'text', text: ' there' },
      ],
    }])
    expect(out).toEqual([{ role: 'user', content: 'hi there' }])
  })

  it('preserves multimodal arrays when supportsContentArray is true (default)', () => {
    /**
     * @example
     * sanitizeMessages([{ role: 'user', content: [{type:'text',text:'see'},{type:'image_url',...}] }])
     * // -> unchanged: image_url part stays so vision-capable providers receive the image
     */
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: 'see this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ],
    }
    const out = sanitizeMessages([message])
    expect(out[0]).toEqual(message)
  })

  // ROOT CAUSE:
  //
  // Some Rust/serde-based OpenAI-compatible gateways only deserialize
  // `messages[].content` as a plain string and reject content-part arrays
  // with HTTP 400 "Failed to deserialize the JSON body into the target type:
  // messages[N]: invalid type: sequence, expected a string". Before the fix,
  // historical messages that contained an `image_url` part (uploaded image,
  // vision capture, restored session) bypassed the existing flatten branch
  // and stayed as arrays, so every subsequent send re-tripped the 400.
  //
  // We fixed this by adding a `supportsContentArray` flag — when the runtime
  // auto-degrade has flipped it to `false`, we force-flatten arrays to a
  // text-only string and drop non-text parts so the request shape matches
  // what a string-only provider can deserialize.
  //
  // See: https://github.com/moeru-ai/airi/issues/1500
  it('issue #1500: drops image_url parts and flattens to string when supportsContentArray=false', () => {
    /**
     * @example
     * sanitizeMessages([{ role:'user', content: [{type:'text',text:'hi'},{type:'image_url',...}] }], false)
     * // -> [{ role: 'user', content: 'hi' }]
     */
    const out = sanitizeMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
        ],
      },
    ], false)
    expect(out).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('issue #1500: drops audio/file parts when supportsContentArray=false', () => {
    /**
     * @example
     * sanitizeMessages([{ role:'user', content: [{type:'text',text:'q'},{type:'input_audio',...},{type:'file',...}] }], false)
     * // -> [{ role: 'user', content: 'q' }]
     */
    const out = sanitizeMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'q' },
          { type: 'input_audio', input_audio: { data: 'AAA', format: 'wav' } },
          { type: 'file', file: { file_id: 'f_1' } },
        ],
      },
    ], false)
    expect(out).toEqual([{ role: 'user', content: 'q' }])
  })

  it('passes string content through untouched regardless of the flag', () => {
    expect(sanitizeMessages([{ role: 'user', content: 'plain' }], true))
      .toEqual([{ role: 'user', content: 'plain' }])
    expect(sanitizeMessages([{ role: 'user', content: 'plain' }], false))
      .toEqual([{ role: 'user', content: 'plain' }])
  })
})

describe('isContentArrayRelatedError', () => {
  it('issue #1500: detects the Rust/serde "expected a string" wire error', () => {
    /**
     * @example
     * isContentArrayRelatedError(
     *   `Remote sent 400 response: {"error":{"message":"Failed to deserialize the JSON body into the target type: messages[7]: invalid type: sequence, expected a string at line 1 column 5603","code":"invalid_request_error"}}`
     * )
     * // -> true
     */
    const wire = 'Remote sent 400 response: {"error":{"message":"Failed to deserialize the JSON body into the target type: messages[7]: invalid type: sequence, expected a string at line 1 column 5603","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}'
    expect(isContentArrayRelatedError(wire)).toBe(true)
    expect(isContentArrayRelatedError(new Error(wire))).toBe(true)
  })

  it('detects Rust/serde providers that reject image_url parts in history', () => {
    /**
     * @example
     * isContentArrayRelatedError(
     *   `Remote sent 400 response: {"error":{"message":"Failed to deserialize the JSON body into the target type: messages[35]: unknown variant image_url, expected text at line 1 column 705835"}}`
     * )
     * // -> true
     */
    const wire = 'Remote sent 400 response: {"error":{"message":"Failed to deserialize the JSON body into the target type: messages[35]: unknown variant image_url, expected text at line 1 column 705835","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}'
    expect(isContentArrayRelatedError(wire)).toBe(true)
    expect(isContentArrayRelatedError(new Error(wire))).toBe(true)
  })

  it('detects the Pydantic/Python "Input should be a valid string" variant', () => {
    /**
     * @example
     * isContentArrayRelatedError('messages.0.content: Input should be a valid string')
     * // -> true
     */
    expect(isContentArrayRelatedError('messages.0.content: Input should be a valid string'))
      .toBe(true)
    expect(isContentArrayRelatedError('messages.3.content expected string, got list'))
      .toBe(true)
  })

  it('does not false-positive on unrelated 400s', () => {
    expect(isContentArrayRelatedError('Remote sent 400 response: model not found')).toBe(false)
    expect(isContentArrayRelatedError('Remote sent 401 response: invalid api key')).toBe(false)
    expect(isContentArrayRelatedError('Tool call failed: invalid schema for function')).toBe(false)
    expect(isContentArrayRelatedError(undefined)).toBe(false)
  })
})
