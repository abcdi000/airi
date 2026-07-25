import { beforeEach, describe, expect, it, vi } from 'vitest'

import { providerDeepSeek } from './index'

const { providerFetch } = vi.hoisted(() => ({
  providerFetch: vi.fn(),
}))

vi.mock('@xsai-ext/providers/create', () => ({
  createDeepSeek: () => ({
    chat: () => ({
      baseURL: 'https://api.deepseek.com/',
      fetch: providerFetch,
    }),
  }),
}))

describe('deepSeek provider', () => {
  beforeEach(() => {
    providerFetch.mockReset()
    providerFetch.mockResolvedValue({ ok: true })
  })

  it('requests streamed usage so cache hit and miss tokens are observable', async () => {
    const provider = providerDeepSeek.createProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com/',
    })
    if (!('chat' in provider))
      throw new Error('Expected DeepSeek chat provider')
    const fetcher = provider.chat('deepseek-v4-flash').fetch
    if (!fetcher)
      throw new Error('Expected DeepSeek provider fetch wrapper')

    await fetcher(new URL('https://api.deepseek.com/chat/completions'), {
      method: 'POST',
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    })

    const request = providerFetch.mock.calls[0]?.[1] as RequestInit | undefined
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>
    expect(body.stream_options).toEqual({ include_usage: true })
  })
})
