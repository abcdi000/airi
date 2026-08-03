import type {
  Sub2ApiAccountTransportConfig,
  Sub2ApiClientAccountStatus,
  Sub2ApiClientRoundEvent,
  Sub2ApiClientRoundRequest,
  Sub2ApiClientRoundResult,
  Sub2ApiClientTransport,
  Sub2ApiClientTransportConfig,
  Sub2ApiModelInfo,
} from '@proj-airi/lumi-runtime/providers/sub2api'

import type {
  ElectronSub2ApiResult,
  ElectronSub2ApiRoundEventEnvelope,
} from '../../shared/eventa'

import { defineInvoke } from '@moeru/eventa'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { deserializeSub2ApiError, Sub2ApiProviderError } from '@proj-airi/lumi-runtime/providers/sub2api'

import {
  electronSub2ApiCancelRound,
  electronSub2ApiGetAccountStatus,
  electronSub2ApiListModels,
  electronSub2ApiRoundEvent,
  electronSub2ApiRunRound,
} from '../../shared/eventa'

export interface ElectronSub2ApiBridge {
  listModels: (
    config: Pick<Sub2ApiClientTransportConfig, 'modelApiBaseUrl' | 'apiKey'>,
    signal?: AbortSignal,
  ) => Promise<ElectronSub2ApiResult<Sub2ApiModelInfo[]>>
  getAccountStatus: (
    config: Sub2ApiAccountTransportConfig,
    signal?: AbortSignal,
  ) => Promise<ElectronSub2ApiResult<Sub2ApiClientAccountStatus>>
  runRound: (
    requestId: string,
    round: Sub2ApiClientRoundRequest,
  ) => Promise<ElectronSub2ApiResult<Sub2ApiClientRoundResult>>
  cancelRound: (requestId: string) => Promise<ElectronSub2ApiResult<void>>
  onRoundEvent: (handler: (event: ElectronSub2ApiRoundEventEnvelope) => void) => () => void
}

function createEventaBridge(): ElectronSub2ApiBridge {
  const context = getElectronEventaContext()
  const invokeListModels = defineInvoke(context, electronSub2ApiListModels)
  const invokeGetAccountStatus = defineInvoke(context, electronSub2ApiGetAccountStatus)
  const invokeRunRound = defineInvoke(context, electronSub2ApiRunRound)
  const invokeCancelRound = defineInvoke(context, electronSub2ApiCancelRound)

  return {
    listModels: async (config, signal) => await invokeListModels({ config }, { signal }),
    getAccountStatus: async (config, signal) => await invokeGetAccountStatus(config, { signal }),
    runRound: async (requestId, round) => await invokeRunRound({ requestId, round }),
    cancelRound: async requestId => await invokeCancelRound({ requestId }),
    onRoundEvent: handler => context.on(electronSub2ApiRoundEvent, ({ body }) => {
      if (body)
        handler(body)
    }),
  }
}

/** Creates the desktop transport that routes every Sub2API HTTP operation through Main. */
export function createElectronSub2ApiClientTransport(
  bridge: ElectronSub2ApiBridge = createEventaBridge(),
): Sub2ApiClientTransport {
  return {
    async listModels(config, signal) {
      try {
        const result = await bridge.listModels(config, signal)
        if (!result.ok)
          throw deserializeSub2ApiError(result.error)
        return result.value
      }
      catch (error) {
        throw bridgeError(error, signal)
      }
    },

    async getAccountStatus(config, signal) {
      try {
        const result = await bridge.getAccountStatus(config, signal)
        if (!result.ok)
          throw deserializeSub2ApiError(result.error)
        return result.value
      }
      catch (error) {
        throw bridgeError(error, signal)
      }
    },

    async runRound(round, hooks = {}) {
      if (hooks.signal?.aborted)
        throw new Sub2ApiProviderError('cancelled', 'Sub2API 请求已取消')

      const requestId = globalThis.crypto.randomUUID()
      const disposeEvent = bridge.onRoundEvent((body) => {
        if (body.requestId !== requestId)
          return
        hooks.onEvent?.(body.event as Sub2ApiClientRoundEvent)
      })
      const cancel = () => {
        void bridge.cancelRound(requestId).catch(() => undefined)
      }
      hooks.signal?.addEventListener('abort', cancel, { once: true })

      try {
        const result = await bridge.runRound(requestId, round)
        if (!result.ok)
          throw deserializeSub2ApiError(result.error)
        return result.value
      }
      catch (error) {
        throw bridgeError(error, hooks.signal)
      }
      finally {
        hooks.signal?.removeEventListener('abort', cancel)
        disposeEvent()
      }
    },
  }
}

function bridgeError(error: unknown, signal?: AbortSignal): Sub2ApiProviderError {
  if (error instanceof Sub2ApiProviderError)
    return error
  if (signal?.aborted)
    return new Sub2ApiProviderError('cancelled', 'Sub2API 请求已取消', {}, { cause: error })
  return new Sub2ApiProviderError(
    'upstream_unavailable',
    'Electron Main Sub2API IPC 不可用',
    {},
    { cause: error },
  )
}
