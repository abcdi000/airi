import { describe, expect, it } from 'vitest'

import {
  createOpenAICompatibleAgentModels,
  createOpenAICompatibleConsciousnessModel,
} from './openAICompatibleModel'

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

describe('createOpenAICompatibleAgentModels', () => {
  it('returns one Planner tool-call step without executing or continuing it', async () => {
    let requestCount = 0
    let requestBody: Record<string, unknown> | undefined
    const models = createOpenAICompatibleAgentModels({
      baseURL: 'https://example.invalid/v1/',
      model: 'single-step-model',
      fetch: async (_input, init) => {
        requestCount += 1
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          id: 'completion-1',
          object: 'chat.completion',
          created: 1,
          model: 'single-step-model-resolved',
          system_fingerprint: 'test',
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              reasoning_content: 'Need authorized memory.',
              tool_calls: [{
                id: 'call-memory',
                type: 'function',
                function: {
                  name: 'query_memory',
                  arguments: '{"query":"birthday"}',
                },
              }],
            },
          }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 12,
            total_tokens: 132,
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 40,
          },
        })
      },
    })

    const result = await models.plannerModel.generateStep({
      messages: [
        { role: 'system', content: 'plan one step' },
        { role: 'user', content: 'when is your birthday?' },
      ],
      tools: [{
        name: 'query_memory',
        description: 'Query authorized memory',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      }],
    })

    expect(requestCount).toBe(1)
    expect(requestBody?.stream).toBeUndefined()
    expect(requestBody?.tool_choice).toBe('required')
    expect(requestBody?.tools).toEqual([{
      type: 'function',
      function: {
        name: 'query_memory',
        description: 'Query authorized memory',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    }])
    expect(result.content).toBe('')
    expect(result.reasoning).toBe('Need authorized memory.')
    expect(result.toolCalls).toEqual([{
      id: 'call-memory',
      name: 'query_memory',
      arguments: { query: 'birthday' },
    }])
    expect(result.usage).toEqual({
      inputTokens: 120,
      outputTokens: 12,
      cacheHitTokens: 80,
      cacheMissTokens: 40,
    })
    expect(result.modelName).toBe('single-step-model-resolved')
  })

  it('maps prior Planner tool calls and host tool results without executing tools', async () => {
    let requestBody: Record<string, unknown> | undefined
    const models = createOpenAICompatibleAgentModels({
      baseURL: 'https://example.invalid/v1/',
      model: 'single-step-model',
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          id: 'completion-2',
          object: 'chat.completion',
          created: 1,
          model: 'single-step-model',
          system_fingerprint: 'test',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '',
            },
          }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 1,
            total_tokens: 21,
          },
        })
      },
    })

    const result = await models.plannerModel.generateStep({
      messages: [
        {
          role: 'assistant',
          content: '',
          reasoning: 'Query first.',
          toolCalls: [{
            id: 'call-1',
            name: 'query_memory',
            arguments: { query: 'Lumi birthday' },
          }],
        },
        {
          role: 'tool',
          content: '{"facts":[]}',
          toolCallId: 'call-1',
          toolName: 'query_memory',
        },
      ],
      tools: [],
    })

    expect(requestBody?.messages).toEqual([
      {
        role: 'assistant',
        content: '',
        reasoning: 'Query first.',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'query_memory',
            arguments: '{"query":"Lumi birthday"}',
          },
        }],
      },
      {
        role: 'tool',
        content: '{"facts":[]}',
        tool_call_id: 'call-1',
      },
    ])
    expect(result.toolCalls).toEqual([])
  })

  it('uses the DeepSeek V4 thinking tool protocol without tool_choice', async () => {
    let requestBody: Record<string, unknown> | undefined
    const models = createOpenAICompatibleAgentModels({
      baseURL: 'https://api.deepseek.com/v1/',
      model: 'deepseek-v4-flash',
      providerId: 'deepseek',
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call-reply',
                type: 'function',
                function: {
                  name: 'reply',
                  arguments: '{"semanticGoal":"answer"}',
                },
              }],
            },
          }],
        })
      },
    })

    await models.plannerModel.generateStep({
      messages: [
        {
          role: 'assistant',
          content: '',
          reasoning: 'Need memory before replying.',
          toolCalls: [{
            id: 'call-memory',
            name: 'query_memory',
            arguments: { query: 'birthday' },
          }],
        },
        {
          role: 'tool',
          content: '{"facts":[]}',
          toolCallId: 'call-memory',
          toolName: 'query_memory',
        },
      ],
      tools: [{
        name: 'reply',
        description: 'Reply to the user',
        inputSchema: {
          type: 'object',
          properties: {
            semanticGoal: { type: 'string' },
          },
        },
      }],
      toolChoice: 'required',
    })

    expect(requestBody?.tools).toBeDefined()
    expect(requestBody?.tool_choice).toBeUndefined()
    expect(requestBody?.messages).toEqual([
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'Need memory before replying.',
        tool_calls: [{
          id: 'call-memory',
          type: 'function',
          function: {
            name: 'query_memory',
            arguments: '{"query":"birthday"}',
          },
        }],
      },
      {
        role: 'tool',
        content: '{"facts":[]}',
        tool_call_id: 'call-memory',
      },
    ])
  })

  it('keeps required tool_choice when DeepSeek V4 thinking is disabled', async () => {
    let requestBody: Record<string, unknown> | undefined
    const models = createOpenAICompatibleAgentModels({
      baseURL: 'https://api.deepseek.com/v1/',
      model: 'deepseek-v4-flash',
      providerId: 'deepseek',
      thinkingMode: 'disabled',
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call-reply',
                type: 'function',
                function: {
                  name: 'reply',
                  arguments: '{"semanticGoal":"answer"}',
                },
              }],
            },
          }],
        })
      },
    })

    await models.plannerModel.generateStep({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{
        name: 'reply',
        description: 'Reply to the user',
        inputSchema: {
          type: 'object',
          properties: {
            semanticGoal: { type: 'string' },
          },
        },
      }],
      toolChoice: 'required',
    })

    expect(requestBody?.tool_choice).toBe('required')
    expect(requestBody?.thinking).toEqual({ type: 'disabled' })
  })

  it('omits empty Planner tool call arrays from provider messages', async () => {
    let requestBody: Record<string, unknown> | undefined
    const models = createOpenAICompatibleAgentModels({
      baseURL: 'https://example.invalid/v1/',
      model: 'single-step-model',
      fetch: async (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
            },
          }],
        })
      },
    })

    await models.plannerModel.generateStep({
      messages: [{
        role: 'assistant',
        content: 'No tool was selected.',
        toolCalls: [],
      }],
      tools: [],
    })

    expect(requestBody?.messages).toEqual([{
      role: 'assistant',
      content: 'No tool was selected.',
    }])
  })

  it('rejects malformed Planner tool arguments instead of executing or hiding them', async () => {
    const models = createOpenAICompatibleAgentModels({
      baseURL: 'https://example.invalid/v1/',
      model: 'single-step-model',
      fetch: async () => Response.json({
        id: 'completion-3',
        object: 'chat.completion',
        created: 1,
        model: 'single-step-model',
        system_fingerprint: 'test',
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'bad-call',
              type: 'function',
              function: {
                name: 'reply',
                arguments: '{not-json',
              },
            }],
          },
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 1,
          total_tokens: 11,
        },
      }),
    })

    await expect(models.plannerModel.generateStep({
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
    })).rejects.toThrow('invalid JSON arguments')
  })

  it('runs tool-free language work as one request', async () => {
    let requestCount = 0
    let requestBody: Record<string, unknown> | undefined
    const models = createOpenAICompatibleAgentModels({
      baseURL: 'https://example.invalid/v1/',
      model: 'language-model',
      fetch: async (_input, init) => {
        requestCount += 1
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          id: 'completion-4',
          object: 'chat.completion',
          created: 1,
          model: 'language-model',
          system_fingerprint: 'test',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: '{"messages":[{"text":"嗯"}]}',
            },
          }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        })
      },
    })

    const text = await models.languageModel.generate(
      [{ role: 'user', content: 'reply briefly' }],
      'replyer',
      undefined,
      { maxOutputTokens: 2_048 },
    )

    expect(requestCount).toBe(1)
    expect(text).toBe('{"messages":[{"text":"嗯"}]}')
    expect(requestBody?.max_tokens).toBe(2_048)
  })
})
