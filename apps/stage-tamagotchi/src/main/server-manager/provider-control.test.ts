import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getDeepSeekBalance,
  getSub2ApiAccountStatus,
  listProviderModels,
  testProviderAccess,
  testProviderConnection,
  testSub2ApiAdvanced,
} from './provider-control'

describe('server manager provider control', () => {
  afterEach(() => vi.restoreAllMocks())

  it('lists models and sends bearer authentication', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      data: [{ id: 'deepseek-v4-flash', owned_by: 'deepseek' }],
    }))
    await expect(listProviderModels({ baseURL: 'https://api.deepseek.com', apiKey: 'secret' })).resolves.toEqual([
      { id: 'deepseek-v4-flash', ownedBy: 'deepseek', source: 'openai-list' },
    ])
    expect(fetch.mock.calls[0]?.[0]).toEqual(new URL('https://api.deepseek.com/models'))
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer secret')
  })

  it('parses Codex manifests, keeps display names, skips missing IDs, and deduplicates by ID', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      models: [
        { id: 'gpt-5.4', display_name: 'GPT 5.4' },
        { slug: 'gpt-5.4', displayName: 'Duplicate' },
        { slug: 'gpt-5.3-codex', display_name: 'GPT 5.3 Codex' },
        { display_name: 'Missing ID' },
      ],
    }))

    await expect(listProviderModels({
      providerId: 'sub2api',
      baseURL: 'https://sub2api.example/custom/v1/',
      apiKey: 'secret',
    })).resolves.toEqual([
      { id: 'gpt-5.4', displayName: 'GPT 5.4', source: 'codex-manifest' },
      { id: 'gpt-5.3-codex', displayName: 'GPT 5.3 Codex', source: 'codex-manifest' },
    ])
  })

  it('uses the maintained provider catalogue when an API does not expose models', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(listProviderModels({
      baseURL: 'https://api.anthropic.com/v1/',
      modelList: 'static',
      defaultModels: ['claude-sonnet-4-5-20250929'],
    })).resolves.toEqual([{ id: 'claude-sonnet-4-5-20250929', source: 'static' }])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('tests DeepSeek without spending tokens on thinking', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ choices: [{ message: { content: 'OK' } }] }))
    await expect(testProviderConnection({
      providerId: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'secret',
      model: 'deepseek-v4-flash',
    })).resolves.toMatchObject({
      ok: true,
      protocol: 'chat-completions',
      requestedModel: 'deepseek-v4-flash',
    })
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.max_tokens).toBe(8)
  })

  it('tests Sub2API Responses with configured reasoning effort', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      id: 'resp_test',
      status: 'completed',
      model: 'gpt-resolved',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'LUMI_SUB2API_OK' }] }],
      usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
    }))

    await expect(testProviderConnection({
      providerId: 'sub2api',
      baseURL: 'https://sub2api.example/v1/',
      apiKey: 'secret',
      model: 'gpt-test',
      providerOptions: { protocol: 'responses', reasoningEffort: 'high' },
    })).resolves.toMatchObject({
      ok: true,
      protocol: 'responses',
      endpoint: '/responses',
      requestedModel: 'gpt-test',
      resolvedModel: 'gpt-resolved',
      text: 'LUMI_SUB2API_OK',
      fallbackUsed: false,
    })
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body.reasoning).toEqual({ effort: 'high' })
    expect(body.store).toBe(false)
  })

  it('falls back from an unsupported Responses endpoint exactly once', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ error: { code: 'unsupported_endpoint', message: 'responses endpoint unsupported' } }, { status: 405 }))
      .mockResolvedValueOnce(Response.json({
        model: 'gpt-chat',
        choices: [{ message: { content: 'LUMI_SUB2API_OK' } }],
      }))

    await expect(testProviderConnection({
      providerId: 'sub2api',
      baseURL: 'https://sub2api.example/v1/',
      apiKey: 'secret',
      model: 'gpt-test',
      providerOptions: { protocol: 'auto' },
    })).resolves.toMatchObject({
      protocol: 'chat-completions',
      fallbackUsed: true,
      resolvedModel: 'gpt-chat',
    })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('runs the advanced multi-turn test with local history', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({
        id: 'resp_first',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '已记住' }] }],
      }))
      .mockResolvedValueOnce(Response.json({
        id: 'resp_second',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'LUMI_MULTI_4281' }] }],
      }))

    await expect(testSub2ApiAdvanced({
      providerId: 'sub2api',
      baseURL: 'https://sub2api.example/v1/',
      apiKey: 'secret',
      model: 'gpt-test',
      providerOptions: { protocol: 'responses' },
    }, 'multi-turn')).resolves.toMatchObject({
      ok: true,
      kind: 'multi-turn',
      protocol: 'responses',
      rounds: 2,
      text: 'LUMI_MULTI_4281',
    })
    const secondBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))
    expect(secondBody).not.toHaveProperty('previous_response_id')
    expect(secondBody.input).toEqual([
      { type: 'message', role: 'user', content: '请记住测试代号 LUMI_MULTI_4281，只回复“已记住”。' },
      { type: 'message', role: 'assistant', content: '已记住' },
      { type: 'message', role: 'user', content: '刚才的测试代号是什么？' },
    ])
  })

  it('runs the advanced Planner tool test without executing an external tool', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({
        id: 'resp_tool',
        status: 'completed',
        output: [{
          id: 'fc_test',
          type: 'function_call',
          call_id: 'call_test',
          name: 'echo_test',
          arguments: '{"value":"LUMI_TOOL_OK"}',
        }],
      }))
      .mockResolvedValueOnce(Response.json({
        id: 'resp_final',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'LUMI_TOOL_OK' }] }],
      }))

    await expect(testSub2ApiAdvanced({
      providerId: 'sub2api',
      baseURL: 'https://sub2api.example/v1/',
      apiKey: 'secret',
      model: 'gpt-test',
      providerOptions: { protocol: 'responses' },
    }, 'planner-tool')).resolves.toMatchObject({
      ok: true,
      kind: 'planner-tool',
      callId: 'call_test',
      rounds: 2,
    })
    const secondBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))
    expect(secondBody.input).toEqual(expect.arrayContaining([
      { type: 'function_call', call_id: 'call_test', name: 'echo_test', arguments: '{"value":"LUMI_TOOL_OK"}' },
      { type: 'function_call_output', call_id: 'call_test', output: '{"value":"LUMI_TOOL_OK"}' },
    ]))
  })

  it('maps the DeepSeek balance response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '12.50', granted_balance: '2.50', topped_up_balance: '10.00' }],
    }))
    await expect(getDeepSeekBalance({
      providerId: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'secret',
    })).resolves.toEqual({
      available: true,
      balances: [{ currency: 'CNY', total: '12.50', granted: '2.50', toppedUp: '10.00' }],
    })
  })

  it('tests transcription provider authentication without a completion', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ data: [] }))
    await expect(testProviderAccess({ baseURL: 'https://api.openai.com/v1/', apiKey: 'secret' })).resolves.toMatchObject({ ok: true })
    expect(fetch.mock.calls[0]?.[0]).toEqual(new URL('https://api.openai.com/v1/models'))
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer secret')
  })

  it('keeps Sub2API balance, quotas, and billing rate independent and preserves a real zero balance', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/user/profile')) {
        return Response.json({
          code: 0,
          message: 'success',
          data: { balance: 0, frozen_balance: 1.5, concurrency: 3, rpm_limit: 60, status: 'active' },
        })
      }
      if (url.endsWith('/api/v1/user/platform-quotas')) {
        return Response.json({
          code: 0,
          message: 'success',
          data: {
            platform_quotas: [{
              platform: 'openai',
              daily_limit_usd: 10,
              weekly_limit_usd: null,
              monthly_limit_usd: 100,
              daily_usage_usd: 2,
              weekly_usage_usd: 4,
              monthly_usage_usd: 8,
              daily_window_resets_at: '2026-08-04T00:00:00Z',
              weekly_window_resets_at: null,
              monthly_window_resets_at: '2026-09-01T00:00:00Z',
            }],
          },
        })
      }
      return Response.json({
        group_rate_multiplier: 1.2,
        resolved_rate_multiplier: 1.1,
        effective_rate_multiplier: 1.32,
        observed_at: '2026-08-03T00:00:00Z',
      })
    })

    await expect(getSub2ApiAccountStatus({
      providerId: 'sub2api',
      baseURL: 'https://sub2api.example/v1/',
      apiKey: 'model-key',
      accountAccessToken: 'user-jwt',
      providerOptions: { accountApiBaseURL: 'https://sub2api.example/api/v1/' },
    })).resolves.toMatchObject({
      accountTokenConfigured: true,
      wallet: { balance: 0, frozenBalance: 1.5, status: 'active' },
      limits: { concurrency: 3, rpmLimit: 60 },
      platformQuotas: [{ platform: 'openai', dailyUsageUsd: 2 }],
      billingRate: { groupRateMultiplier: 1.2, effectiveRateMultiplier: 1.32 },
      partialErrors: [],
    })
    const authorizations = fetch.mock.calls.map(call => new Headers(call[1]?.headers).get('authorization'))
    expect(authorizations).toContain('Bearer model-key')
    expect(authorizations.filter(value => value === 'Bearer user-jwt')).toHaveLength(2)
  })

  it('returns billing when no account token is configured and reports partial failures without inventing a zero balance', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      effective_rate_multiplier: 1,
      observed_at: '2026-08-03T00:00:00Z',
    }))

    await expect(getSub2ApiAccountStatus({
      providerId: 'sub2api',
      baseURL: 'https://sub2api.example/v1/',
      apiKey: 'model-key',
    })).resolves.toMatchObject({
      accountTokenConfigured: false,
      billingRate: { effectiveRateMultiplier: 1 },
      partialErrors: [],
    })
  })

  it('reports an expired user token independently and redacts credentials from partial errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('/sub2api/billing'))
        return Response.json({ effective_rate_multiplier: 1 })
      return Response.json({ error: { message: 'Authorization: Bearer user-jwt-secret is invalid' } }, { status: 401 })
    })

    const status = await getSub2ApiAccountStatus({
      providerId: 'sub2api',
      baseURL: 'https://sub2api.example/v1/',
      apiKey: 'model-key',
      accountAccessToken: 'user-jwt-secret',
    })

    expect(status.billingRate).toMatchObject({ effectiveRateMultiplier: 1 })
    expect(status.wallet).toBeUndefined()
    expect(status.partialErrors).toEqual([
      { source: 'profile', status: 401, message: '用户令牌已过期或无效 (401)' },
      { source: 'platform-quotas', status: 401, message: '用户令牌已过期或无效 (401)' },
    ])
    expect(JSON.stringify(status)).not.toContain('user-jwt-secret')
    expect(JSON.stringify(status)).not.toContain('model-key')
  })
})
