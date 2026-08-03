import type { ElectronSub2ApiBridge } from './sub2api'

import { describe, expect, it, vi } from 'vitest'

import { createElectronSub2ApiClientTransport } from './sub2api'

function round() {
  return {
    config: {
      modelApiBaseUrl: 'https://sub2api.example/v1/',
      apiKey: 'test-api-key',
      protocol: 'responses' as const,
      reasoningEffort: 'auto' as const,
    },
    model: 'gpt-test',
    responses: { input: [{ type: 'message' as const, role: 'user' as const, content: 'hi' }] },
    chatMessages: [{ role: 'user' as const, content: 'hi' }],
  }
}

function createBridge(overrides: Partial<ElectronSub2ApiBridge> = {}): ElectronSub2ApiBridge {
  return {
    listModels: vi.fn(async () => ({ ok: true as const, value: [] })),
    getAccountStatus: vi.fn(async () => ({
      ok: true as const,
      value: {
        fetchedAt: '2026-08-03T00:00:00.000Z',
        accountTokenConfigured: false,
        platformQuotas: [],
        errors: [],
      },
    })),
    runRound: vi.fn(async () => ({
      ok: true as const,
      value: {
        protocol: 'responses' as const,
        fallbackUsed: false,
        value: { text: '', toolCalls: [], requestedModel: 'gpt-test' },
      },
    })),
    cancelRound: vi.fn(async () => ({ ok: true as const, value: undefined })),
    onRoundEvent: vi.fn(() => () => undefined),
    ...overrides,
  }
}

describe('electron Renderer Sub2API transport', () => {
  /** @example transport.listModels(config) */
  it('uses the typed bridge for model and account operations', async () => {
    const bridge = createBridge({
      listModels: vi.fn(async config => ({
        ok: true as const,
        value: [{ id: `${config.apiKey}-model`, source: 'openai-list' as const }],
      })),
      getAccountStatus: vi.fn(async config => ({
        ok: true as const,
        value: {
          fetchedAt: '2026-08-03T00:00:00.000Z',
          accountTokenConfigured: Boolean(config.accountAccessToken),
          platformQuotas: [],
          errors: [],
        },
      })),
    })
    const transport = createElectronSub2ApiClientTransport(bridge)

    const models = await transport.listModels({
      modelApiBaseUrl: 'https://sub2api.example/v1/',
      apiKey: 'test-api-key',
    })
    const account = await transport.getAccountStatus({
      modelApiBaseUrl: 'https://sub2api.example/v1/',
      modelApiKey: 'test-api-key',
      accountAccessToken: 'account-token',
    })

    expect(models).toEqual([{ id: 'test-api-key-model', source: 'openai-list' }])
    expect(account.accountTokenConfigured).toBe(true)
  })

  /** @example controller.abort() while transport.listModels(config) is active */
  it('normalizes an Eventa model discovery cancellation', async () => {
    const controller = new AbortController()
    const listModels: ElectronSub2ApiBridge['listModels'] = vi.fn(async (_config, signal) => await new Promise<never>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const bridge = createBridge({
      listModels,
    })
    const transport = createElectronSub2ApiClientTransport(bridge)
    const pending = transport.listModels({
      modelApiBaseUrl: 'https://sub2api.example/v1/',
      apiKey: 'test-api-key',
    }, controller.signal)

    controller.abort()

    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' })
  })

  /** @example transport.listModels(config) when Electron Main is unavailable */
  it('normalizes an unavailable IPC bridge without exposing transport internals', async () => {
    const bridge = createBridge({
      listModels: vi.fn(async () => {
        throw new Error('ipc secret implementation detail')
      }),
    })
    const transport = createElectronSub2ApiClientTransport(bridge)

    await expect(transport.listModels({
      modelApiBaseUrl: 'https://sub2api.example/v1/',
      apiKey: 'test-api-key',
    })).rejects.toMatchObject({
      kind: 'upstream_unavailable',
      message: 'Electron Main Sub2API IPC 不可用',
    })
  })

  /** @example transport.runRound(round(), hooks) */
  it('filters events by requestId and removes its listener after completion', async () => {
    let eventHandler: Parameters<ElectronSub2ApiBridge['onRoundEvent']>[0] = () => undefined
    let disposed = false
    let activeRequestId = ''
    const runRound: ElectronSub2ApiBridge['runRound'] = vi.fn(async (requestId) => {
      activeRequestId = requestId
      eventHandler({ requestId: 'another-request', event: { type: 'text-delta', text: 'wrong' } })
      eventHandler({ requestId, event: { type: 'text-delta', text: 'right' } })
      return {
        ok: true as const,
        value: {
          protocol: 'responses' as const,
          fallbackUsed: false,
          value: { text: 'right', toolCalls: [], requestedModel: 'gpt-test' },
        },
      }
    })
    const bridge = createBridge({
      onRoundEvent: vi.fn((handler) => {
        eventHandler = handler
        return () => {
          disposed = true
        }
      }),
      runRound,
    })
    const transport = createElectronSub2ApiClientTransport(bridge)
    const deltas: string[] = []

    await transport.runRound(round(), {
      onEvent(event) {
        if (event.type === 'text-delta')
          deltas.push(event.text)
      },
    })
    if (!disposed)
      eventHandler({ requestId: activeRequestId, event: { type: 'text-delta', text: 'late' } })

    expect(deltas).toEqual(['right'])
    expect(disposed).toBe(true)
  })

  /** @example two transport.runRound() calls receiving interleaved Main events */
  it('isolates concurrent round events and disposes both listeners', async () => {
    const handlers = new Set<Parameters<ElectronSub2ApiBridge['onRoundEvent']>[0]>()
    const requestIds: string[] = []
    let releaseRounds: () => void = () => undefined
    const roundsReleased = new Promise<void>((resolve) => {
      releaseRounds = resolve
    })
    const bridge = createBridge({
      onRoundEvent: vi.fn((handler) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      }),
      runRound: vi.fn(async (requestId) => {
        requestIds.push(requestId)
        await roundsReleased
        return {
          ok: true as const,
          value: {
            protocol: 'responses' as const,
            fallbackUsed: false,
            value: { text: requestId, toolCalls: [], requestedModel: 'gpt-test' },
          },
        }
      }),
    })
    const transport = createElectronSub2ApiClientTransport(bridge)
    const first: string[] = []
    const second: string[] = []
    const pendingFirst = transport.runRound(round(), {
      onEvent: event => event.type === 'text-delta' && first.push(event.text),
    })
    const pendingSecond = transport.runRound(round(), {
      onEvent: event => event.type === 'text-delta' && second.push(event.text),
    })
    await vi.waitFor(() => expect(requestIds).toHaveLength(2))

    for (const handler of handlers) {
      handler({ requestId: requestIds[1]!, event: { type: 'text-delta', text: 'second' } })
      handler({ requestId: requestIds[0]!, event: { type: 'text-delta', text: 'first' } })
    }
    releaseRounds()
    await Promise.all([pendingFirst, pendingSecond])

    expect(first).toEqual(['first'])
    expect(second).toEqual(['second'])
    expect(handlers.size).toBe(0)
  })

  /** @example controller.abort() while transport.runRound() is active */
  it('invokes Main cancellation when AbortSignal fires', async () => {
    let finishRound: (requestId: string) => void = () => undefined
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const cancelRound = vi.fn(async (requestId: string) => {
      finishRound(requestId)
      return { ok: true as const, value: undefined }
    })
    const runRound: ElectronSub2ApiBridge['runRound'] = async requestId => await new Promise((resolve) => {
      markStarted()
      finishRound = () => resolve({
        ok: false as const,
        error: { kind: 'cancelled', message: 'cancelled', requestId },
      })
    })
    const bridge = createBridge({
      runRound,
      cancelRound,
    })
    const transport = createElectronSub2ApiClientTransport(bridge)
    const controller = new AbortController()
    const pending = transport.runRound(round(), { signal: controller.signal })

    await started
    controller.abort()

    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' })
    expect(cancelRound).toHaveBeenCalledTimes(1)
  })
})
