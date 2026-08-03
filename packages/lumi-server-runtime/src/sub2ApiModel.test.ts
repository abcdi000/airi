import type { LumiConsciousnessRequest } from './consciousness'

import { describe, expect, it, vi } from 'vitest'

import { createLumiServerModelBundle } from './sub2ApiModel'

describe('sub2API model bundle', () => {
  it('keeps Planner single-step and maps local tool history without replaying reasoning', async () => {
    const execute = vi.fn(async () => ({ unexpected: true }))
    let requestBody: Record<string, unknown> | undefined
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return responsesJson({
        id: 'resp_planner',
        status: 'completed',
        model: 'gpt-resolved',
        output: [{
          id: 'fc_2',
          type: 'function_call',
          call_id: 'call_2',
          name: 'echo_test',
          arguments: '{"value":"LUMI_TOOL_OK"}',
        }],
        usage: {
          input_tokens: 20,
          input_tokens_details: { cached_tokens: 12 },
          output_tokens: 5,
        },
      })
    })
    const bundle = modelBundle(fetch)

    const step = await bundle.agentModels.plannerModel.generateStep({
      messages: [
        { role: 'system', content: 'Planner system' },
        {
          role: 'assistant',
          content: '',
          reasoning: 'private reasoning must not be replayed',
          toolCalls: [{ id: 'call_1', name: 'echo_test', arguments: { value: 'first' } }],
        },
        { role: 'tool', content: '{"value":"first"}', toolCallId: 'call_1', toolName: 'echo_test' },
        { role: 'user', content: 'continue' },
      ],
      tools: [{
        name: 'echo_test',
        description: 'Echo a value',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
      }],
      toolChoice: 'required',
    })

    expect(execute).not.toHaveBeenCalled()
    expect(step).toMatchObject({
      content: '',
      modelName: 'gpt-resolved',
      toolCalls: [{ id: 'call_2', name: 'echo_test', arguments: { value: 'LUMI_TOOL_OK' } }],
      usage: { inputTokens: 20, outputTokens: 5, cacheHitTokens: 12, cacheMissTokens: 8 },
    })
    expect(requestBody?.instructions).toBe('Planner system')
    expect(JSON.stringify(requestBody?.input)).not.toContain('private reasoning')
    expect(requestBody?.input).toEqual([
      { type: 'function_call', call_id: 'call_1', name: 'echo_test', arguments: '{"value":"first"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"value":"first"}' },
      { type: 'message', role: 'user', content: 'continue' },
    ])
  })

  it('executes authorized traditional consciousness tools locally and returns results with the same call_id', async () => {
    const requests: Record<string, unknown>[] = []
    const execute = vi.fn(async (input: unknown) => ({ echoed: input }))
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push(body)
      if (requests.length === 1) {
        return responsesJson({
          id: 'resp_tool',
          status: 'completed',
          model: 'gpt-test',
          output: [{
            id: 'fc_tool',
            type: 'function_call',
            call_id: 'call_tool',
            name: 'echo_test',
            arguments: '{"value":"LUMI_TOOL_OK"}',
          }, {
            type: 'message',
            content: [{ type: 'output_text', text: '我先处理。' }],
          }],
        })
      }
      return responsesJson({
        id: 'resp_final',
        status: 'completed',
        model: 'gpt-test',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: '工具完成' }],
        }],
      })
    })
    const bundle = modelBundle(fetch, {
      async toolsFor() {
        return [{
          type: 'function',
          function: {
            name: 'echo_test',
            description: 'Echo a value',
            parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
          },
          execute,
        }]
      },
    })
    const deltas: string[] = []

    const result = await bundle.consciousnessModel.generate(consciousnessRequest(), delta => deltas.push(delta))

    expect(result).toEqual({ text: '我先处理。工具完成' })
    expect(deltas).toEqual(['我先处理。', '工具完成'])
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith({ value: 'LUMI_TOOL_OK' }, {
      messages: [
        { role: 'system', content: 'Lumi system' },
        { role: 'user', content: 'use tool' },
      ],
      toolCallId: 'call_tool',
    })
    expect(requests[1]?.input).toEqual([
      { type: 'message', role: 'user', content: 'use tool' },
      { type: 'message', role: 'assistant', content: '我先处理。' },
      { type: 'function_call', call_id: 'call_tool', name: 'echo_test', arguments: '{"value":"LUMI_TOOL_OK"}' },
      { type: 'function_call_output', call_id: 'call_tool', output: '{"echoed":{"value":"LUMI_TOOL_OK"}}' },
    ])
    expect(requests[1]).not.toHaveProperty('previous_response_id')
  })

  it('uses one tool-free Responses request for Replyer and preserves system boundaries', async () => {
    let requestBody: Record<string, unknown> | undefined
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return responsesJson({
        id: 'resp_replyer',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'reply' }] }],
      })
    })
    const bundle = modelBundle(fetch)

    const text = await bundle.agentModels.languageModel.generate([
      { role: 'system', content: 'System A' },
      { role: 'system', content: 'System B' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'history' },
    ], 'replyer', undefined, { maxOutputTokens: 321 })

    expect(text).toBe('reply')
    expect(requestBody).toMatchObject({
      instructions: 'System A\n\nSystem B',
      max_output_tokens: 321,
      input: [
        { type: 'message', role: 'user', content: 'hello' },
        { type: 'message', role: 'assistant', content: 'history' },
      ],
    })
    expect(requestBody).not.toHaveProperty('tools')
  })

  it('never routes a non-Sub2API provider through Responses', async () => {
    let requestURL = ''
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      requestURL = String(input)
      return new Response(JSON.stringify({
        id: 'chat_1',
        model: 'existing-model',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', index: 0 }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { headers: { 'content-type': 'application/json' } })
    })
    const bundle = createLumiServerModelBundle({
      providerId: 'openai-compatible',
      baseURL: 'https://existing.example/v1/',
      model: 'existing-model',
      fetch,
    })

    await bundle.agentModels.plannerModel.generateStep({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    })

    expect(requestURL).toContain('/chat/completions')
    expect(requestURL).not.toContain('/responses')
  })

  it('applies Sub2API reasoning effort to the reused Chat Completions path only', async () => {
    let requestBody: Record<string, unknown> | undefined
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify({
        id: 'chat_1',
        model: 'gpt-chat',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', index: 0 }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { headers: { 'content-type': 'application/json' } })
    })
    const bundle = createLumiServerModelBundle({
      providerId: 'sub2api',
      baseURL: 'https://sub2api.example/v1/',
      model: 'gpt-chat',
      providerOptions: { protocol: 'chat-completions', reasoningEffort: 'xhigh' },
      fetch,
    })

    await bundle.agentModels.plannerModel.generateStep({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    })

    expect(requestBody?.reasoning_effort).toBe('xhigh')
  })
})

function modelBundle(
  fetch: typeof globalThis.fetch,
  toolProvider?: Parameters<typeof createLumiServerModelBundle>[0]['toolProvider'],
) {
  return createLumiServerModelBundle({
    providerId: 'sub2api',
    baseURL: 'https://sub2api.example/v1/',
    apiKey: 'model-secret',
    model: 'gpt-test',
    maxSteps: 4,
    providerOptions: { protocol: 'responses', reasoningEffort: 'medium' },
    toolProvider,
    fetch,
  })
}

function consciousnessRequest(): LumiConsciousnessRequest {
  return {
    conversationId: 'conversation-1',
    sourceMessageId: 'message-1',
    conversationType: 'direct',
    actorPersonId: 'person-1',
    actorDisplayName: 'Doggy',
    participantPersonIds: ['person-1'],
    messages: [
      { role: 'system', content: 'Lumi system' },
      { role: 'user', content: 'use tool' },
    ],
    memories: [],
    personStates: [],
  }
}

function responsesJson(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
}
