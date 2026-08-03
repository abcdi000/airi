import { describe, expect, it, vi } from 'vitest'

import {
  deriveAccountApiRoot,
  normalizeAccountApiRoot,
  normalizeModelApiRoot,
  parseSub2ApiResponsesStream,
  resolveProviderEndpoint,
  Sub2ApiProtocolRouter,
  Sub2ApiProviderError,
  Sub2ApiResponsesClient,
} from './sub2ApiProtocol'

describe('sub2API URL handling', () => {
  it('preserves path prefixes while adding one model API version segment', () => {
    expect(normalizeModelApiRoot('https://example.com')).toBe('https://example.com/v1/')
    expect(normalizeModelApiRoot('https://example.com/v1')).toBe('https://example.com/v1/')
    expect(normalizeModelApiRoot('https://example.com/custom/v1/')).toBe('https://example.com/custom/v1/')
    expect(resolveProviderEndpoint('https://example.com/custom/v1/', '/models').href).toBe('https://example.com/custom/v1/models')
  })

  it('supports local HTTP and derives or normalizes account roots', () => {
    expect(normalizeModelApiRoot('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/v1/')
    expect(deriveAccountApiRoot('https://example.com/custom/v1/')).toBe('https://example.com/api/v1/')
    expect(normalizeAccountApiRoot('https://example.com/proxy/api/v1')).toBe('https://example.com/proxy/api/v1/')
  })

  it('rejects non-HTTP model roots', () => {
    expect(() => normalizeModelApiRoot('file:///tmp/sub2api')).toThrow('HTTP/HTTPS')
  })
})

describe('sub2API Responses protocol', () => {
  it('sends native Responses fields, configured reasoning effort, and no previous response reference', async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toMatchObject({
        model: 'gpt-test',
        instructions: 'System A\n\nSystem B',
        store: false,
        stream: true,
        reasoning: { effort: 'high' },
      })
      expect(body).not.toHaveProperty('previous_response_id')
      return jsonResponse({
        id: 'resp_1',
        status: 'completed',
        model: 'gpt-test-resolved',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'hello' }],
        }],
        usage: {
          input_tokens: 11,
          input_tokens_details: { cached_tokens: 7 },
          output_tokens: 3,
          total_tokens: 14,
        },
      })
    })
    const client = new Sub2ApiResponsesClient({
      baseURL: 'https://example.com/v1',
      apiKey: 'secret-key',
      model: 'gpt-test',
      reasoningEffort: 'high',
      fetch,
    })

    const result = await client.request({
      instructions: 'System A\n\nSystem B',
      input: [{ type: 'message', role: 'user', content: 'hi' }],
    })

    expect(result.text).toBe('hello')
    expect(result.resolvedModel).toBe('gpt-test-resolved')
    expect(result.usage).toEqual({
      inputTokens: 11,
      cachedInputTokens: 7,
      outputTokens: 3,
      totalTokens: 14,
    })
  })

  it('parses chunked CRLF SSE and merges item_id with call_id into one tool call', async () => {
    const events = [
      sse({ type: 'response.output_text.delta', delta: '我先' }, '\r\n'),
      sse({
        type: 'response.output_item.added',
        item: { id: 'fc_item_1', type: 'function_call', call_id: 'call_1', name: 'echo_test', arguments: '' },
      }, '\r\n'),
      sse({ type: 'response.function_call_arguments.delta', item_id: 'fc_item_1', call_id: 'call_1', delta: '{"value":' }, '\r\n'),
      sse({ type: 'response.function_call_arguments.done', item_id: 'fc_item_1', call_id: 'call_1', name: 'echo_test', arguments: '{"value":"ok"}' }, '\r\n'),
      sse({
        type: 'response.completed',
        response: {
          id: 'resp_2',
          status: 'completed',
          model: 'gpt-test',
          output: [{ id: 'fc_item_1', type: 'function_call', call_id: 'call_1', name: 'echo_test', arguments: '{"value":"ok"}' }],
        },
      }, '\r\n'),
      'data: [DONE]\r\n\r\n',
    ].join('')
    const deltas: string[] = []

    const result = await parseSub2ApiResponsesStream(chunkedStream(events, [1, 7, 19, 43]), {
      requestedModel: 'gpt-test',
      onTextDelta: delta => deltas.push(delta),
    })

    expect(deltas).toEqual(['我先'])
    expect(result.text).toBe('我先')
    expect(result.toolCalls).toEqual([{
      id: 'call_1',
      name: 'echo_test',
      arguments: '{"value":"ok"}',
    }])
  })

  it('rejects an interrupted stream and records whether text was already emitted', async () => {
    const stream = chunkedStream(sse({ type: 'response.output_text.delta', delta: 'partial' }), [3])

    await expect(parseSub2ApiResponsesStream(stream, { requestedModel: 'gpt-test' })).rejects.toMatchObject({
      kind: 'stream_interrupted',
      details: { partialOutput: true },
    })
  })

  it('classifies explicit cancellation separately from timeout', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      if (init?.signal?.aborted)
        throw new DOMException('aborted', 'AbortError')
      return jsonResponse({ status: 'completed', output: [] })
    })
    const client = new Sub2ApiResponsesClient({
      baseURL: 'https://example.com/v1/',
      model: 'gpt-test',
      fetch,
    })

    await expect(client.request({
      input: [{ type: 'message', role: 'user', content: 'hello' }],
      signal: controller.signal,
    })).rejects.toMatchObject({ kind: 'cancelled' })
  })

  it('keeps the timeout active until the provider request settles', async () => {
    vi.useFakeTimers()
    try {
      const fetch = vi.fn((_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      }))
      const client = new Sub2ApiResponsesClient({
        baseURL: 'https://example.com/v1/',
        model: 'gpt-test',
        timeoutMs: 1_000,
        fetch,
      })
      const assertion = expect(client.request({
        input: [{ type: 'message', role: 'user', content: 'hello' }],
      })).rejects.toMatchObject({ kind: 'timeout' })

      await vi.advanceTimersByTimeAsync(1_001)
      await assertion
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('rejects provider error events and malformed SSE JSON', async () => {
    await expect(parseSub2ApiResponsesStream(chunkedStream(sse({
      type: 'error',
      error: { code: 'provider_error', message: 'failed' },
    }), [5]), { requestedModel: 'gpt-test' })).rejects.toMatchObject({ kind: 'invalid_response' })

    await expect(parseSub2ApiResponsesStream(chunkedStream('data: {broken}\n\n', [2]), {
      requestedModel: 'gpt-test',
    })).rejects.toMatchObject({ kind: 'invalid_sse' })
  })
})

describe('sub2API protocol auto selection', () => {
  it('falls back once only after a strict unsupported endpoint error', async () => {
    const responses = vi.fn(async () => {
      throw new Sub2ApiProviderError('endpoint_not_supported', 'not supported', {
        status: 405,
        partialOutput: false,
      })
    })
    const chatCompletions = vi.fn(async () => 'chat')
    const router = new Sub2ApiProtocolRouter('auto')

    const first = await router.run({ responses, chatCompletions })
    const second = await router.run({ responses, chatCompletions })

    expect(first).toEqual({ value: 'chat', protocol: 'chat-completions', fallbackUsed: true })
    expect(second).toEqual({ value: 'chat', protocol: 'chat-completions', fallbackUsed: false })
    expect(responses).toHaveBeenCalledTimes(1)
    expect(chatCompletions).toHaveBeenCalledTimes(2)
  })

  it.each([
    'unauthorized',
    'forbidden',
    'model_not_found',
    'rate_limited',
    'upstream_unavailable',
    'stream_interrupted',
    'invalid_tool_arguments',
  ] as const)('does not fall back for %s', async (kind) => {
    const router = new Sub2ApiProtocolRouter('auto')
    const chatCompletions = vi.fn(async () => 'chat')

    await expect(router.run({
      responses: async () => {
        throw new Sub2ApiProviderError(kind, kind, { partialOutput: kind === 'stream_interrupted' })
      },
      chatCompletions,
    })).rejects.toMatchObject({ kind })
    expect(chatCompletions).not.toHaveBeenCalled()
  })
})

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'x-request-id': 'request_1' },
  })
}

function sse(body: Record<string, unknown>, newline = '\n'): string {
  return `data: ${JSON.stringify(body)}${newline}${newline}`
}

function chunkedStream(value: string, chunkSizes: readonly number[]): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(value)
  return new ReadableStream({
    start(controller) {
      let offset = 0
      let index = 0
      while (offset < encoded.length) {
        const size = chunkSizes[index % chunkSizes.length] ?? encoded.length
        controller.enqueue(encoded.slice(offset, offset + size))
        offset += size
        index += 1
      }
      controller.close()
    },
  })
}
