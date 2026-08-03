import type { InvocableEventContext } from '@moeru/eventa'
import type { Sub2ApiClientTransport } from '@proj-airi/lumi-runtime/providers/sub2api'

import { defineInvokeHandler } from '@moeru/eventa'
import {
  createDirectSub2ApiClientTransport,
  serializeSub2ApiError,
  Sub2ApiProviderError,
} from '@proj-airi/lumi-runtime/providers/sub2api'

import {
  electronSub2ApiCancelRound,
  electronSub2ApiGetAccountStatus,
  electronSub2ApiListModels,
  electronSub2ApiRoundEvent,
  electronSub2ApiRunRound,
} from '../../../../shared/eventa'

interface Sub2ApiServiceWindow {
  once: (event: 'closed', listener: () => void) => unknown
}

// A direct multimodal request can legitimately contain a large data URL. This
// ceiling prevents the fixed business IPC from becoming an unbounded payload channel.
const MAX_ROUND_PAYLOAD_CHARS = 32 * 1024 * 1024

/**
 * Owns Sub2API network requests for one trusted Electron window.
 *
 * Use when:
 * - Registering base-window Eventa handlers that bypass browser CORS safely
 * - Streaming one model round back to the Renderer while core-agent owns tools
 *
 * Expects:
 * - A window-scoped Eventa context
 * - Only fixed Sub2API business contracts, never arbitrary URL proxy input
 *
 * Returns:
 * - A lifecycle handle that aborts all active requests when disposed
 */
export function createSub2ApiService<ContextExtensions, EmitOptions extends { raw?: unknown }>(params: {
  context: InvocableEventContext<ContextExtensions, EmitOptions>
  window: Sub2ApiServiceWindow
  transport?: Sub2ApiClientTransport
}) {
  const transport = params.transport ?? createDirectSub2ApiClientTransport()
  const activeRounds = new Map<string, AbortController>()

  defineInvokeHandler(params.context, electronSub2ApiListModels, async ({ config }, options) => {
    try {
      return { ok: true as const, value: await transport.listModels(config, options?.abortController?.signal) }
    }
    catch (error) {
      return { ok: false as const, error: serializeSub2ApiError(error, [config.apiKey]) }
    }
  })

  defineInvokeHandler(params.context, electronSub2ApiGetAccountStatus, async (config, options) => {
    try {
      return { ok: true as const, value: await transport.getAccountStatus(config, options?.abortController?.signal) }
    }
    catch (error) {
      return {
        ok: false as const,
        error: serializeSub2ApiError(error, [config.modelApiKey, config.accountAccessToken ?? '']),
      }
    }
  })

  defineInvokeHandler(params.context, electronSub2ApiRunRound, async ({ requestId, round }) => {
    if (activeRounds.has(requestId)) {
      return {
        ok: false as const,
        error: serializeSub2ApiError(new Sub2ApiProviderError('invalid_response', 'Sub2API requestId 正在使用')),
      }
    }

    if (JSON.stringify(round).length > MAX_ROUND_PAYLOAD_CHARS) {
      return {
        ok: false as const,
        error: serializeSub2ApiError(new Sub2ApiProviderError('invalid_response', 'Sub2API 请求内容超过桌面传输限制')),
      }
    }

    const controller = new AbortController()
    activeRounds.set(requestId, controller)
    try {
      const value = await transport.runRound(round, {
        signal: controller.signal,
        onEvent(event) {
          params.context.emit(electronSub2ApiRoundEvent, { requestId, event })
        },
      })
      return { ok: true as const, value }
    }
    catch (error) {
      return { ok: false as const, error: serializeSub2ApiError(error, [round.config.apiKey]) }
    }
    finally {
      activeRounds.delete(requestId)
    }
  })

  defineInvokeHandler(params.context, electronSub2ApiCancelRound, ({ requestId }) => {
    activeRounds.get(requestId)?.abort(new DOMException('Request cancelled by Renderer', 'AbortError'))
    return { ok: true as const, value: undefined }
  })

  const dispose = () => {
    for (const controller of activeRounds.values())
      controller.abort(new DOMException('Electron window closed', 'AbortError'))
    activeRounds.clear()
  }
  params.window.once('closed', dispose)

  return {
    dispose,
    activeRequestCount: () => activeRounds.size,
  }
}
