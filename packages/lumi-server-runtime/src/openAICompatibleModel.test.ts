import { describe, expect, it } from 'vitest'

import { createOpenAICompatibleConsciousnessModel } from './openAICompatibleModel'

describe('createOpenAICompatibleConsciousnessModel', () => {
  it('rejects invalid server model configuration before any request', () => {
    expect(() => createOpenAICompatibleConsciousnessModel({
      baseURL: 'file:///unsafe',
      model: 'deepseek-chat',
    })).toThrow('baseURL must use HTTP or HTTPS')
    expect(() => createOpenAICompatibleConsciousnessModel({
      baseURL: 'https://api.deepseek.com/v1',
      model: '',
    })).toThrow('model is required')
    expect(() => createOpenAICompatibleConsciousnessModel({
      baseURL: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      maxSteps: 0,
    })).toThrow('maxSteps must be between 1 and 64')
  })

  it('reports an upstream stream failure without leaving an unhandled steps rejection', async () => {
    const model = createOpenAICompatibleConsciousnessModel({
      baseURL: 'https://example.invalid/v1/',
      model: 'test-model',
      curateMemories: false,
      fetch: async () => new Response('invalid credentials', { status: 401 }),
    })

    await expect(model.generate({
      conversationId: 'lumi-background',
      conversationType: 'group',
      actorPersonId: 'lumi',
      actorDisplayName: 'Lumi',
      participantPersonIds: [],
      memories: [],
      personStates: [],
      messages: [{ role: 'user', content: 'background reflection' }],
    }, () => {})).rejects.toThrow('401')

    // Give every xsAI response promise a turn to settle. Vitest reports an
    // unhandled steps rejection as an error after this case completes.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })

  it('requests DeepSeek V4 streamed cache accounting', async () => {
    let requestBody: Record<string, unknown> | undefined
    const model = createOpenAICompatibleConsciousnessModel({
      baseURL: 'https://api.deepseek.com/v1/',
      model: 'deepseek-v4-flash',
      providerId: 'deepseek',
      curateMemories: false,
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return new Response([
          'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}',
          '',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          '',
          'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":1,"total_tokens":21,"prompt_cache_hit_tokens":12,"prompt_cache_miss_tokens":8}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'), {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      },
    })

    const result = await model.generate({
      conversationId: 'direct-doggy',
      conversationType: 'direct',
      actorPersonId: 'doggy',
      actorDisplayName: 'Doggy',
      participantPersonIds: ['doggy'],
      memories: [],
      personStates: [],
      messages: [{ role: 'user', content: 'hello' }],
    }, () => {})

    expect(result.text).toBe('hello')
    expect(requestBody?.stream_options).toEqual({ include_usage: true })
  })
})
