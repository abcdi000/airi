import type { Sub2ApiClientRoundRequest } from './client'

import { describe, expect, it, vi } from 'vitest'

import { createDirectSub2ApiClientTransport, serializeSub2ApiError } from './client'

function responseStream(events: Array<Record<string, unknown> | '[DONE]'>): Response {
  const body = events.map(event => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`).join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function round(protocol: Sub2ApiClientRoundRequest['config']['protocol'] = 'auto'): Sub2ApiClientRoundRequest {
  return {
    config: {
      modelApiBaseUrl: 'https://sub2api.example/v1/',
      apiKey: 'test-api-key',
      protocol,
      reasoningEffort: 'low',
    },
    model: 'gpt-test',
    responses: {
      instructions: 'system',
      input: [{ type: 'message', role: 'user', content: 'hello' }],
    },
    chatMessages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
    ],
    tools: [{
      type: 'function',
      name: 'lookup',
      parameters: { type: 'object', properties: {} },
    }],
    toolChoice: 'auto',
  }
}

describe('sub2API client network transport', () => {
  /** @example transport.listModels(config) */
  it('lists and deduplicates Codex manifest models with authorization', async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      expect(init?.headers).toEqual({
        accept: 'application/json',
        authorization: 'Bearer test-api-key',
      })
      return new Response(JSON.stringify({
        models: [
          { id: 'gpt-a', display_name: 'GPT A' },
          { slug: 'gpt-a', display_name: 'duplicate' },
          { slug: 'gpt-b' },
          { display_name: 'missing id' },
        ],
      }))
    })
    const transport = createDirectSub2ApiClientTransport({ fetch })

    const models = await transport.listModels({
      modelApiBaseUrl: 'https://sub2api.example/v1/',
      apiKey: 'test-api-key',
    })

    expect(models).toEqual([
      { id: 'gpt-a', displayName: 'GPT A', source: 'codex-manifest' },
      { id: 'gpt-b', source: 'codex-manifest' },
    ])
  })

  /** @example transport.listModels(config) with malformed JSON */
  it('classifies an invalid model catalogue as an invalid response', async () => {
    const transport = createDirectSub2ApiClientTransport({
      fetch: async () => new Response('{not-json', {
        headers: { 'content-type': 'application/json' },
      }),
    })

    await expect(transport.listModels({
      modelApiBaseUrl: 'https://sub2api.example/v1/',
      apiKey: 'test-api-key',
    })).rejects.toMatchObject({ kind: 'invalid_response' })
  })

  /** @example transport.listModels(config) with HTTP 403 */
  it('preserves forbidden model catalogue errors', async () => {
    const transport = createDirectSub2ApiClientTransport({
      fetch: async () => new Response('forbidden', { status: 403 }),
    })

    await expect(transport.listModels({
      modelApiBaseUrl: 'https://sub2api.example/v1/',
      apiKey: 'test-api-key',
    })).rejects.toMatchObject({ kind: 'forbidden', details: { status: 403 } })
  })

  /** @example controller.abort() while transport.listModels(config) is active */
  it('classifies model discovery cancellation without exposing a network error', async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const transport = createDirectSub2ApiClientTransport({ fetch })
    const controller = new AbortController()
    const pending = transport.listModels({
      modelApiBaseUrl: 'https://sub2api.example/v1/',
      apiKey: 'test-api-key',
    }, controller.signal)

    controller.abort()

    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' })
  })

  /** @example transport.runRound(round('auto')) */
  it('keeps the allowed auto fallback inside one network transport', async () => {
    // ROOT CAUSE:
    //
    // The original client returned undefined after a Responses 404, causing
    // core-agent to issue Chat Completions through Renderer fetch and hit CORS.
    // The direct transport now performs both protocol attempts itself.
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input)
      if (url.endsWith('/responses')) {
        return new Response(JSON.stringify({ error: { message: 'route unsupported' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      return responseStream([
        { id: 'chat_1', model: 'gpt-test', choices: [{ delta: { content: 'OK' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } },
        '[DONE]',
      ])
    })
    const transport = createDirectSub2ApiClientTransport({ fetch })
    const deltas: string[] = []

    const result = await transport.runRound(round(), {
      onEvent(event) {
        if (event.type === 'text-delta')
          deltas.push(event.text)
      },
    })

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/responses')
    expect(String(fetch.mock.calls[1]?.[0])).toContain('/chat/completions')
    expect(result.protocol).toBe('chat-completions')
    expect(result.fallbackUsed).toBe(true)
    expect(result.value.text).toBe('OK')
    expect(deltas).toEqual(['OK'])
  })

  /** @example transport.runRound(round('auto')) with HTTP 401 */
  it('does not fallback on authentication failures', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }))
    const transport = createDirectSub2ApiClientTransport({ fetch })

    await expect(transport.runRound(round())).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  /** @example transport.runRound(round('auto')) after a streamed text delta */
  it('does not fallback after Responses has emitted partial text', async () => {
    const fetch = vi.fn(async () => responseStream([
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'error', error: { code: 'unsupported_protocol', message: 'protocol unsupported' } },
    ]))
    const transport = createDirectSub2ApiClientTransport({ fetch })
    const deltas: string[] = []

    await expect(transport.runRound(round(), {
      onEvent(event) {
        if (event.type === 'text-delta')
          deltas.push(event.text)
      },
    })).rejects.toMatchObject({ details: { partialOutput: true } })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(deltas).toEqual(['partial'])
  })

  /** @example transport.runRound(round('chat-completions')) */
  it('streams stable tool calls and usage from Chat Completions', async () => {
    const fetch = vi.fn(async () => responseStream([
      {
        id: 'chat_tool',
        model: 'gpt-test',
        choices: [{
          delta: {
            tool_calls: [{ index: 0, id: 'call_7', function: { name: 'lookup', arguments: '{"q"' } }],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          delta: { tool_calls: [{ index: 0, function: { arguments: ':"lumi"}' } }] },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
      },
      '[DONE]',
    ]))
    const transport = createDirectSub2ApiClientTransport({ fetch })
    const events: string[] = []

    const result = await transport.runRound(round('chat-completions'), {
      onEvent: event => events.push(event.type),
    })

    expect(result.value.toolCalls).toEqual([{
      id: 'call_7',
      name: 'lookup',
      arguments: '{"q":"lumi"}',
    }])
    expect(result.value.finishReason).toBe('tool_calls')
    expect(result.value.usage).toEqual({ inputTokens: 9, outputTokens: 3, totalTokens: 12 })
    expect(events).toEqual([
      'tool-call-streaming-start',
      'tool-call-delta',
      'tool-call-delta',
      'usage',
      'diagnostics',
    ])
  })

  /** @example serializeSub2ApiError(new Error('Bearer token')) */
  it('redacts credentials before an error crosses IPC', () => {
    const error = serializeSub2ApiError(
      new Error('Authorization: Bearer secret-token sk-abcdefghijk custom-account-token'),
      ['custom-account-token'],
    )

    expect(error.message).not.toContain('secret-token')
    expect(error.message).not.toContain('sk-abcdefghijk')
    expect(error.message).not.toContain('custom-account-token')
    expect(error.message).toContain('[redacted]')
  })
})
