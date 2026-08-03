import type {
  Sub2ApiAccountTransportConfig,
  Sub2ApiClientAccountStatus,
  Sub2ApiClientRoundEvent,
  Sub2ApiClientRoundRequest,
  Sub2ApiClientRoundResult,
  Sub2ApiClientTransportConfig,
  Sub2ApiModelInfo,
  Sub2ApiSerializedError,
} from '@proj-airi/lumi-runtime/providers/sub2api'

import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

export type ElectronSub2ApiResult<T>
  = | { ok: true, value: T }
    | { ok: false, error: Sub2ApiSerializedError }

export interface ElectronSub2ApiListModelsRequest {
  config: Pick<Sub2ApiClientTransportConfig, 'modelApiBaseUrl' | 'apiKey'>
}

export interface ElectronSub2ApiRunRoundRequest {
  requestId: string
  round: Sub2ApiClientRoundRequest
}

export interface ElectronSub2ApiRoundEventEnvelope {
  requestId: string
  event: Sub2ApiClientRoundEvent
}

export interface ElectronSub2ApiCancelRoundRequest {
  requestId: string
}

export const electronSub2ApiListModels = defineInvokeEventa<
  ElectronSub2ApiResult<Sub2ApiModelInfo[]>,
  ElectronSub2ApiListModelsRequest
>('eventa:invoke:electron:sub2api:list-models')

export const electronSub2ApiGetAccountStatus = defineInvokeEventa<
  ElectronSub2ApiResult<Sub2ApiClientAccountStatus>,
  Sub2ApiAccountTransportConfig
>('eventa:invoke:electron:sub2api:get-account-status')

export const electronSub2ApiRunRound = defineInvokeEventa<
  ElectronSub2ApiResult<Sub2ApiClientRoundResult>,
  ElectronSub2ApiRunRoundRequest
>('eventa:invoke:electron:sub2api:run-round')

export const electronSub2ApiCancelRound = defineInvokeEventa<
  ElectronSub2ApiResult<void>,
  ElectronSub2ApiCancelRoundRequest
>('eventa:invoke:electron:sub2api:cancel-round')

export const electronSub2ApiRoundEvent = defineEventa<ElectronSub2ApiRoundEventEnvelope>(
  'eventa:event:electron:sub2api:round',
)
