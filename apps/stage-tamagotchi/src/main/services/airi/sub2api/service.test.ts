import type { Sub2ApiClientTransport } from '@proj-airi/lumi-runtime/providers/sub2api'

import { createContext, defineInvoke } from '@moeru/eventa'
import { createDirectSub2ApiClientTransport, Sub2ApiProviderError } from '@proj-airi/lumi-runtime/providers/sub2api'
import { describe, expect, it, vi } from 'vitest'

import {
  electronSub2ApiCancelRound,
  electronSub2ApiGetAccountStatus,
  electronSub2ApiListModels,
  electronSub2ApiRoundEvent,
  electronSub2ApiRunRound,
} from '../../../../shared/eventa'
import { createSub2ApiService } from './service'

function windowLifecycle() {
  let onClosed: () => void = () => undefined
  return {
    window: {
      once(event: 'closed', listener: () => void) {
        if (event === 'closed')
          onClosed = listener
      },
    },
    close: () => onClosed(),
  }
}

function roundRequest(
  requestId = 'round-1',
  protocol: 'auto' | 'responses' | 'chat-completions' = 'responses',
) {
  return {
    requestId,
    round: {
      config: {
        modelApiBaseUrl: 'https://sub2api.example/v1/',
        apiKey: 'test-api-key',
        protocol,
        reasoningEffort: 'auto' as const,
      },
      model: 'gpt-test',
      responses: { input: [{ type: 'message' as const, role: 'user' as const, content: 'hi' }] },
      chatMessages: [{ role: 'user' as const, content: 'hi' }],
    },
  }
}

function responseStream(events: Array<Record<string, unknown> | '[DONE]'>): Response {
  const body = events.map(event => `data: ${event === '[DONE]' ? event : JSON.stringify(event)}\n\n`).join('')
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

describe('electron Main Sub2API service', () => {
  /** @example invokeListModels({ config }) */
  it('issues model discovery from the Main-owned direct transport', async () => {
    const fetch = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      expect(init?.headers).toEqual({
        accept: 'application/json',
        authorization: 'Bearer test-api-key',
      })
      return new Response(JSON.stringify({ data: [{ id: 'gpt-test', owned_by: 'sub2api' }] }))
    })
    const context = createContext()
    const lifecycle = windowLifecycle()
    createSub2ApiService({
      context,
      window: lifecycle.window,
      transport: createDirectSub2ApiClientTransport({ fetch }),
    })

    const result = await defineInvoke(context, electronSub2ApiListModels)({
      config: { modelApiBaseUrl: 'https://sub2api.example/v1/', apiKey: 'test-api-key' },
    })

    expect(result).toEqual({
      ok: true,
      value: [{ id: 'gpt-test', ownedBy: 'sub2api', source: 'openai-list' }],
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  /** @example invokeListModels({ config }) with malformed or rejected responses */
  it.each([
    {
      name: 'invalid JSON',
      response: () => new Response('{invalid-json'),
      expected: { kind: 'invalid_response' },
    },
    {
      name: 'HTTP 401',
      response: () => new Response('invalid key', { status: 401 }),
      expected: { kind: 'unauthorized', status: 401 },
    },
    {
      name: 'HTTP 403',
      response: () => new Response('forbidden', { status: 403 }),
      expected: { kind: 'forbidden', status: 403 },
    },
  ])('returns a clone-safe $name model discovery error', async ({ response, expected }) => {
    const context = createContext()
    const lifecycle = windowLifecycle()
    createSub2ApiService({
      context,
      window: lifecycle.window,
      transport: createDirectSub2ApiClientTransport({ fetch: async () => response() }),
    })

    const result = await defineInvoke(context, electronSub2ApiListModels)({
      config: { modelApiBaseUrl: 'https://sub2api.example/v1/', apiKey: 'test-api-key' },
    })

    expect(result).toMatchObject({ ok: false, error: expected })
  })

  /** @example invokeListModels({ config }) when upstream echoes a custom key */
  it('redacts a nonstandard API key echoed by the upstream model endpoint', async () => {
    const context = createContext()
    const lifecycle = windowLifecycle()
    createSub2ApiService({
      context,
      window: lifecycle.window,
      transport: createDirectSub2ApiClientTransport({
        fetch: async () => new Response('rejected custom-test-api-key', { status: 403 }),
      }),
    })

    const result = await defineInvoke(context, electronSub2ApiListModels)({
      config: { modelApiBaseUrl: 'https://sub2api.example/v1/', apiKey: 'custom-test-api-key' },
    })

    expect(result).toMatchObject({ ok: false, error: { kind: 'forbidden' } })
    expect(JSON.stringify(result)).not.toContain('custom-test-api-key')
  })

  /** @example controller.abort() while invokeListModels({ config }) is active */
  it('propagates model discovery cancellation through Main', async () => {
    const listModels: Sub2ApiClientTransport['listModels'] = vi.fn(async (_config, signal) => await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Sub2ApiProviderError('cancelled', 'cancelled')), { once: true })
    }))
    const transport: Sub2ApiClientTransport = {
      listModels,
      getAccountStatus: vi.fn(),
      runRound: vi.fn(),
    }
    const context = createContext()
    const lifecycle = windowLifecycle()
    createSub2ApiService({ context, window: lifecycle.window, transport })
    const controller = new AbortController()
    const pending = defineInvoke(context, electronSub2ApiListModels)({
      config: { modelApiBaseUrl: 'https://sub2api.example/v1/', apiKey: 'test-api-key' },
    }, { signal: controller.signal })
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(1))

    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  /** @example invokeGetAccountStatus(config) */
  it('queries account status through the Main-owned transport', async () => {
    const getAccountStatus: Sub2ApiClientTransport['getAccountStatus'] = vi.fn(async config => ({
      fetchedAt: '2026-08-03T00:00:00.000Z',
      accountTokenConfigured: Boolean(config.accountAccessToken),
      effectiveRateMultiplier: 0.8,
      platformQuotas: [],
      errors: [],
    }))
    const transport: Sub2ApiClientTransport = {
      listModels: vi.fn(),
      getAccountStatus,
      runRound: vi.fn(),
    }
    const context = createContext()
    const lifecycle = windowLifecycle()
    createSub2ApiService({ context, window: lifecycle.window, transport })

    const result = await defineInvoke(context, electronSub2ApiGetAccountStatus)({
      modelApiBaseUrl: 'https://sub2api.example/v1/',
      modelApiKey: 'test-api-key',
      accountAccessToken: 'test-account-token',
    })

    expect(result).toMatchObject({
      ok: true,
      value: { accountTokenConfigured: true, effectiveRateMultiplier: 0.8 },
    })
    expect(getAccountStatus).toHaveBeenCalledTimes(1)
  })

  /** @example invokeRunRound(roundRequest(id, 'chat-completions')) */
  it('keeps explicit Chat Completions network traffic in Main', async () => {
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      expect(String(input)).toContain('/chat/completions')
      return responseStream([
        { id: 'chat_1', choices: [{ delta: { content: 'main-chat' }, finish_reason: 'stop' }] },
        '[DONE]',
      ])
    })
    const context = createContext()
    const lifecycle = windowLifecycle()
    createSub2ApiService({
      context,
      window: lifecycle.window,
      transport: createDirectSub2ApiClientTransport({ fetch }),
    })

    const result = await defineInvoke(context, electronSub2ApiRunRound)(
      roundRequest('chat-main', 'chat-completions'),
    )

    expect(result).toMatchObject({
      ok: true,
      value: { protocol: 'chat-completions', fallbackUsed: false, value: { text: 'main-chat' } },
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  /** @example invokeRunRound(roundRequest(id, 'auto')) */
  it('keeps Auto fallback from Responses to Chat Completions in Main', async () => {
    const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
      if (String(input).endsWith('/responses'))
        return new Response('route unsupported', { status: 404 })
      return responseStream([
        { id: 'chat_2', choices: [{ delta: { content: 'main-fallback' }, finish_reason: 'stop' }] },
        '[DONE]',
      ])
    })
    const context = createContext()
    const lifecycle = windowLifecycle()
    createSub2ApiService({
      context,
      window: lifecycle.window,
      transport: createDirectSub2ApiClientTransport({ fetch }),
    })

    const result = await defineInvoke(context, electronSub2ApiRunRound)(roundRequest('auto-main', 'auto'))

    expect(result).toMatchObject({
      ok: true,
      value: { protocol: 'chat-completions', fallbackUsed: true, value: { text: 'main-fallback' } },
    })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/responses')
    expect(String(fetch.mock.calls[1]?.[0])).toContain('/chat/completions')
  })

  /** @example invokeRunRound({ requestId, round }) */
  it('streams only clone-safe round events and returns the final result', async () => {
    const runRound: Sub2ApiClientTransport['runRound'] = vi.fn(async (_round, hooks) => {
      hooks?.onEvent?.({ type: 'text-delta', text: 'hello' })
      return {
        protocol: 'responses' as const,
        fallbackUsed: false,
        value: {
          text: 'hello',
          toolCalls: [],
          requestedModel: 'gpt-test',
        },
      }
    })
    const transport: Sub2ApiClientTransport = {
      listModels: vi.fn(),
      getAccountStatus: vi.fn(),
      runRound,
    }
    const context = createContext()
    const lifecycle = windowLifecycle()
    createSub2ApiService({ context, window: lifecycle.window, transport })
    const events: unknown[] = []
    context.on(electronSub2ApiRoundEvent, event => events.push(event.body))

    const result = await defineInvoke(context, electronSub2ApiRunRound)(roundRequest())

    expect(events).toEqual([{
      requestId: 'round-1',
      event: { type: 'text-delta', text: 'hello' },
    }])
    expect(result).toEqual({
      ok: true,
      value: {
        protocol: 'responses',
        fallbackUsed: false,
        value: { text: 'hello', toolCalls: [], requestedModel: 'gpt-test' },
      },
    })
  })

  /** @example invokeCancelRound({ requestId }) */
  it('cancels an active round and clears it from the window service', async () => {
    const runRound: Sub2ApiClientTransport['runRound'] = vi.fn(async (_round, hooks) => await new Promise<never>((_resolve, reject) => {
      hooks?.signal?.addEventListener('abort', () => {
        reject(new Sub2ApiProviderError('cancelled', 'cancelled'))
      }, { once: true })
    }))
    const transport: Sub2ApiClientTransport = {
      listModels: vi.fn(),
      getAccountStatus: vi.fn(),
      runRound,
    }
    const context = createContext()
    const lifecycle = windowLifecycle()
    const service = createSub2ApiService({ context, window: lifecycle.window, transport })
    const run = defineInvoke(context, electronSub2ApiRunRound)(roundRequest('round-cancel'))
    await vi.waitFor(() => expect(service.activeRequestCount()).toBe(1))

    const cancel = await defineInvoke(context, electronSub2ApiCancelRound)({ requestId: 'round-cancel' })
    const result = await run

    expect(cancel).toEqual({ ok: true, value: undefined })
    expect(result).toMatchObject({ ok: false, error: { kind: 'cancelled' } })
    expect(service.activeRequestCount()).toBe(0)
  })

  /** @example lifecycle.close() */
  it('aborts active rounds when their owning window closes', async () => {
    const aborted = vi.fn()
    const runRound: Sub2ApiClientTransport['runRound'] = vi.fn(async (_round, hooks) => await new Promise<never>((_resolve, reject) => {
      hooks?.signal?.addEventListener('abort', () => {
        aborted()
        reject(new Sub2ApiProviderError('cancelled', 'closed'))
      }, { once: true })
    }))
    const transport: Sub2ApiClientTransport = {
      listModels: vi.fn(),
      getAccountStatus: vi.fn(),
      runRound,
    }
    const context = createContext()
    const lifecycle = windowLifecycle()
    const service = createSub2ApiService({ context, window: lifecycle.window, transport })
    const run = defineInvoke(context, electronSub2ApiRunRound)(roundRequest('round-close'))
    await vi.waitFor(() => expect(service.activeRequestCount()).toBe(1))

    lifecycle.close()
    await run

    expect(aborted).toHaveBeenCalledTimes(1)
    expect(service.activeRequestCount()).toBe(0)
  })
})
