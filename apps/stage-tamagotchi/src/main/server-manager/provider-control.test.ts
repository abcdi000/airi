import { afterEach, describe, expect, it, vi } from 'vitest'

import { getDeepSeekBalance, listProviderModels, testProviderAccess, testProviderConnection } from './provider-control'

describe('server manager provider control', () => {
  afterEach(() => vi.restoreAllMocks())

  it('lists models and sends bearer authentication', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      data: [{ id: 'deepseek-v4-flash', owned_by: 'deepseek' }],
    }))
    await expect(listProviderModels({ baseURL: 'https://api.deepseek.com', apiKey: 'secret' })).resolves.toEqual([
      { id: 'deepseek-v4-flash', ownedBy: 'deepseek' },
    ])
    expect(fetch).toHaveBeenCalledWith(new URL('https://api.deepseek.com/models'), expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer secret' }),
    }))
  })

  it('uses the maintained provider catalogue when an API does not expose models', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(listProviderModels({
      baseURL: 'https://api.anthropic.com/v1/',
      modelList: 'static',
      defaultModels: ['claude-sonnet-4-5-20250929'],
    })).resolves.toEqual([{ id: 'claude-sonnet-4-5-20250929' }])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('tests DeepSeek without spending tokens on thinking', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ choices: [{ message: { content: 'OK' } }] }))
    await expect(testProviderConnection({
      providerId: 'deepseek',
      baseURL: 'https://api.deepseek.com',
      apiKey: 'secret',
      model: 'deepseek-v4-flash',
    })).resolves.toMatchObject({ ok: true, model: 'deepseek-v4-flash' })
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.max_tokens).toBe(8)
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
    expect(fetch).toHaveBeenCalledWith(new URL('https://api.openai.com/v1/models'), expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer secret' }),
    }))
  })
})
