import type { ChatSessionsExport } from '../types/chat-session'
import type { LumiDataArchive } from './data-maintenance/lumi-archive'

import { isStageTamagotchi } from '@proj-airi/stage-shared'
import { useLive2dParams, useSettingsLive2d } from '@proj-airi/stage-ui-live2d'
import { useModelStore } from '@proj-airi/stage-ui-three'

import { useBackgroundStore } from '../stores/background'
import { useChatOrchestratorStore } from '../stores/chat'
import { useChatSessionStore } from '../stores/chat/session-store'
import { useDisplayModelsStore } from '../stores/display-models'
import { useLumiCurrentStateStore } from '../stores/lumi-current-state'
import { useLumiEmotionStore } from '../stores/lumi-emotion'
import { useLumiMemoryStore } from '../stores/lumi-memory'
import { useLumiUserProfileStore } from '../stores/lumi-user-profile'
import { useMcpStore } from '../stores/mcp'
import { useAiriCardStore } from '../stores/modules/airi-card'
import { useConsciousnessStore } from '../stores/modules/consciousness'
import { useDiscordStore } from '../stores/modules/discord'
import { useFactorioStore } from '../stores/modules/gaming-factorio'
import { useMinecraftStore } from '../stores/modules/gaming-minecraft'
import { useHearingStore } from '../stores/modules/hearing'
import { useSpeechStore } from '../stores/modules/speech'
import { useTwitterStore } from '../stores/modules/twitter'
import { useOnboardingStore } from '../stores/onboarding'
import { useProvidersStore } from '../stores/providers'
import { useSettings, useSettingsAudioDevice } from '../stores/settings'
import {
  deserializeBackgroundEntries,
  exportLumiLocalStorageSnapshot,
  isLumiDataArchivePayload,
  LUMI_DATA_ARCHIVE_FORMAT,
  restoreLumiLocalStorageSnapshot,
  serializeBackgroundEntries,
} from './data-maintenance/lumi-archive'

export function useDataMaintenance() {
  const chatStore = useChatSessionStore()
  const chatOrchestrator = useChatOrchestratorStore()
  const displayModelsStore = useDisplayModelsStore()
  const providersStore = useProvidersStore()
  const settingsStore = useSettings()
  const audioSettingsStore = useSettingsAudioDevice()
  const live2dParamsStore = useLive2dParams()
  const live2dSettingsStore = useSettingsLive2d()
  const threeStore = useModelStore()
  const hearingStore = useHearingStore()
  const speechStore = useSpeechStore()
  const consciousnessStore = useConsciousnessStore()
  const twitterStore = useTwitterStore()
  const discordStore = useDiscordStore()
  const factorioStore = useFactorioStore()
  const minecraftStore = useMinecraftStore()
  const mcpStore = useMcpStore()
  const onboardingStore = useOnboardingStore()
  const airiCardStore = useAiriCardStore()
  const lumiMemoryStore = useLumiMemoryStore()
  const lumiUserProfileStore = useLumiUserProfileStore()
  const lumiCurrentStateStore = useLumiCurrentStateStore()
  const lumiEmotionStore = useLumiEmotionStore()
  const backgroundStore = useBackgroundStore()

  async function deleteAllModels() {
    await displayModelsStore.resetDisplayModels()
    settingsStore.stageModelSelected = 'preset-live2d-1'
    await settingsStore.updateStageModel()
  }

  async function resetProvidersSettings() {
    await providersStore.resetProviderSettings()
  }

  function resetModulesSettings() {
    hearingStore.resetState()
    speechStore.resetState()
    consciousnessStore.resetState()
    twitterStore.resetState()
    discordStore.resetState()
    factorioStore.resetState()
    minecraftStore.resetState()
    lumiMemoryStore.resetState()
    lumiUserProfileStore.resetState()
  }

  function deleteAllChatSessions() {
    chatOrchestrator.cancelPendingSends()
    chatStore.resetAllSessions()
  }

  async function exportChatSessions() {
    const data = await chatStore.exportSessions()
    return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  }

  async function exportLumiDataArchive() {
    const archive: LumiDataArchive = {
      format: LUMI_DATA_ARCHIVE_FORMAT,
      version: 1,
      source: 'lumi',
      exportedAt: new Date().toISOString(),
      sections: {
        chatSessions: await chatStore.exportSessions(),
        lumiMemory: await lumiMemoryStore.exportSnapshot(),
        lumiUserProfile: lumiUserProfileStore.exportSnapshot(),
        lumiCurrentState: lumiCurrentStateStore.exportSnapshot(),
        lumiEmotion: lumiEmotionStore.exportSnapshot(),
        backgroundEntries: await serializeBackgroundEntries(await backgroundStore.exportUserEntries()),
        localStorage: exportLumiLocalStorageSnapshot(),
      },
    }
    return new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' })
  }

  function isChatSessionsPayload(payload: unknown): payload is ChatSessionsExport {
    if (!payload || typeof payload !== 'object')
      return false
    return (payload as { format?: string }).format === 'chat-sessions-index:v1'
  }

  async function importChatSessions(payload: Record<string, unknown>) {
    if (!isChatSessionsPayload(payload))
      throw new Error('Invalid chat session export format')
    await chatStore.importSessions(payload)
  }

  async function importLumiDataArchive(payload: Record<string, unknown>) {
    if (isChatSessionsPayload(payload)) {
      await importChatSessions(payload)
      return
    }
    if (!isLumiDataArchivePayload(payload))
      throw new Error('Invalid Lumi data archive format')

    await chatStore.importSessions(payload.sections.chatSessions)
    await lumiMemoryStore.importSnapshot(payload.sections.lumiMemory)
    await lumiUserProfileStore.importSnapshot(payload.sections.lumiUserProfile)
    await lumiCurrentStateStore.importSnapshot(payload.sections.lumiCurrentState)
    lumiEmotionStore.importSnapshot(payload.sections.lumiEmotion)
    await backgroundStore.importUserEntries(await deserializeBackgroundEntries(payload.sections.backgroundEntries))
    restoreLumiLocalStorageSnapshot(payload.sections.localStorage)
  }

  async function resetSettingsState() {
    await settingsStore.resetState()
    audioSettingsStore.resetState()
    live2dParamsStore.resetState()
    live2dSettingsStore.resetState()
    threeStore.resetModelStore()
    mcpStore.resetState()
    onboardingStore.resetSetupState()
    airiCardStore.resetState()
  }

  async function deleteAllData() {
    await deleteAllModels()
    await resetProvidersSettings()
    resetModulesSettings()
    deleteAllChatSessions()
    await resetSettingsState()
  }

  async function resetDesktopApplicationState() {
    if (!isStageTamagotchi())
      return

    await resetSettingsState()
    resetModulesSettings()
  }

  return {
    deleteAllModels,
    resetProvidersSettings,
    resetModulesSettings,
    deleteAllChatSessions,
    exportChatSessions,
    importChatSessions,
    exportLumiDataArchive,
    importLumiDataArchive,
    deleteAllData,
    resetDesktopApplicationState,
  }
}
