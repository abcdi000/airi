import type {
  ElectronLumiAstrBotGatewayConfig,
  ElectronLumiAstrBotGatewayState,
} from '../../../../../shared/eventa'

import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { shallowRef } from 'vue'

import {
  electronLumiAstrBotGatewayGetState,
  electronLumiAstrBotGatewayRotateToken,
  electronLumiAstrBotGatewayUpdateConfig,
} from '../../../../../shared/eventa'

/** Owns the renderer-side settings workflow for the local AstrBot gateway. */
export function useLocalAstrBotGateway() {
  const getState = useElectronEventaInvoke(electronLumiAstrBotGatewayGetState)
  const updateConfig = useElectronEventaInvoke(electronLumiAstrBotGatewayUpdateConfig)
  const rotateToken = useElectronEventaInvoke(electronLumiAstrBotGatewayRotateToken)
  const state = shallowRef<ElectronLumiAstrBotGatewayState>()
  const busy = shallowRef(false)
  const error = shallowRef('')

  async function run(action: () => Promise<ElectronLumiAstrBotGatewayState>) {
    busy.value = true
    error.value = ''
    try {
      state.value = await action()
      return state.value
    }
    catch (cause) {
      error.value = errorMessageFrom(cause) ?? 'AstrBot 接入操作失败'
      throw cause
    }
    finally {
      busy.value = false
    }
  }

  return {
    state,
    busy,
    error,
    load: () => run(() => getState()),
    save: (config: ElectronLumiAstrBotGatewayConfig) => run(() => updateConfig(config)),
    rotateToken: () => run(() => rotateToken()),
  }
}
