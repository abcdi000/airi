import { describe, expect, it, vi } from 'vitest'

import {
  parseSub2ApiModelList,
  Sub2ApiProtocolRouter,
  Sub2ApiResponsesClient,
} from './protocol'

describe('shared Sub2API model catalogue parser', () => {
  /** @example parseSub2ApiModelList({ data: [{ id: 'gpt-a' }] }) */
  it('parses OpenAI and Codex catalogues, preserves display names, and deduplicates by ID', () => {
    const models = parseSub2ApiModelList({
      data: [
        { id: 'gpt-a', owned_by: 'openai' },
        { id: '', owned_by: 'invalid' },
      ],
      models: [
        { id: 'gpt-a', display_name: 'Duplicate' },
        { slug: 'codex-b', display_name: 'Codex B' },
        { display_name: 'Missing ID' },
      ],
    })

    expect(models).toEqual([
      { id: 'gpt-a', ownedBy: 'openai', source: 'openai-list' },
      { id: 'codex-b', displayName: 'Codex B', source: 'codex-manifest' },
    ])
  })
})

describe('shared Sub2API Responses request', () => {
  /** @example new Sub2ApiResponsesClient(options).request({ input }) */
  it('sends stateless image input, function history, store false, and no previous response ID', async () => {
    let requestBody: Record<string, unknown> | undefined
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        id: 'resp_image',
        status: 'completed',
        model: 'vision-resolved',
        output: [
          { id: 'rs_private', type: 'reasoning', summary: [{ type: 'summary_text', text: 'private' }] },
          { type: 'message', content: [{ type: 'output_text', text: 'ok' }] },
        ],
      }), { headers: { 'content-type': 'application/json' } })
    })
    const client = new Sub2ApiResponsesClient({
      baseURL: 'https://example.com/v1/',
      apiKey: 'secret',
      model: 'vision-model',
      fetch,
    })

    const result = await client.request({
      instructions: 'System prompt',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '看图' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: 'high' },
          ],
        },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
        { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
      ],
    })

    expect(requestBody).toMatchObject({
      instructions: 'System prompt',
      store: false,
      stream: true,
    })
    expect(requestBody).not.toHaveProperty('previous_response_id')
    expect(requestBody?.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '看图' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: 'high' },
        ],
      },
      { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
    ])
    expect(result.text).toBe('ok')
    expect(result.reasoning).toBe('private')
    expect(result.resolvedModel).toBe('vision-resolved')
  })
})

describe('shared Sub2API Auto fallback policy', () => {
  /** @example router.run({ responses, chatCompletions }) */
  it.each([404, 405, 501])('falls back for an unsupported Responses endpoint returning %s', async (status) => {
    const router = new Sub2ApiProtocolRouter('auto')
    const chatCompletions = vi.fn(async () => 'chat-ok')

    const result = await router.run({
      responses: async () => {
        await new Sub2ApiResponsesClient({
          baseURL: 'https://example.com/v1/',
          model: 'gpt-test',
          fetch: async () => new Response('Not Found', { status }),
        }).request({ input: [{ type: 'message', role: 'user', content: 'hello' }] })
        return 'responses-ok'
      },
      chatCompletions,
    })

    expect(result).toEqual({ value: 'chat-ok', protocol: 'chat-completions', fallbackUsed: true })
    expect(chatCompletions).toHaveBeenCalledTimes(1)
  })

  /** @example router.run({ responses, chatCompletions }) */
  it.each([401, 429, 502])('does not fall back for HTTP %s', async (status) => {
    const router = new Sub2ApiProtocolRouter('auto')
    const chatCompletions = vi.fn(async () => 'chat-ok')

    await expect(router.run({
      responses: async () => {
        await new Sub2ApiResponsesClient({
          baseURL: 'https://example.com/v1/',
          model: 'gpt-test',
          fetch: async () => new Response('failure', { status }),
        }).request({ input: [{ type: 'message', role: 'user', content: 'hello' }] })
        return 'responses-ok'
      },
      chatCompletions,
    })).rejects.toBeDefined()
    expect(chatCompletions).not.toHaveBeenCalled()
  })

  /** @example router.run({ responses, chatCompletions }) */
  it('does not treat a model-not-found 404 as an unsupported endpoint', async () => {
    const router = new Sub2ApiProtocolRouter('auto')
    const chatCompletions = vi.fn(async () => 'chat-ok')

    await expect(router.run({
      responses: async () => {
        await new Sub2ApiResponsesClient({
          baseURL: 'https://example.com/v1/',
          model: 'missing-model',
          fetch: async () => new Response(JSON.stringify({
            error: { message: 'model missing-model not found', code: 'model_not_found' },
          }), { status: 404, headers: { 'content-type': 'application/json' } }),
        }).request({ input: [{ type: 'message', role: 'user', content: 'hello' }] })
        return 'responses-ok'
      },
      chatCompletions,
    })).rejects.toMatchObject({ kind: 'model_not_found' })
    expect(chatCompletions).not.toHaveBeenCalled()
  })
})
