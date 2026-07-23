import type { ChatSessionsExport } from '../types/chat-session'
import type { LumiDataArchive } from './data-maintenance/lumi-archive'

import { isStageTamagotchi } from '@proj-airi/stage-shared'
import { useLive2dParams, useSettingsLive2d } from '@proj-airi/stage-ui-live2d'
import { useModelStore } from '@proj-airi/stage-ui-three'

import { lumiRoomLedgerRepo } from '../database/repos/lumi-room-ledger.repo'
import { useBackgroundStore } from '../stores/background'
import { useChatOrchestratorStore } from '../stores/chat'
import { useChatSessionStore } from '../stores/chat/session-store'
import { useDisplayModelsStore } from '../stores/display-models'
import { useLumiChannelDevicesStore } from '../stores/lumi-channel-devices'
import { useLumiCurrentStateStore } from '../stores/lumi-current-state'
import { useLumiEmotionStore } from '../stores/lumi-emotion'
import { useLumiIdentityStore } from '../stores/lumi-identity'
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
import { createLumiClientMigrationPackage } from './data-maintenance/lumi-migration'

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
  const lumiChannelDevicesStore = useLumiChannelDevicesStore()
  const lumiEmotionStore = useLumiEmotionStore()
  const lumiIdentityStore = useLumiIdentityStore()
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
    const users: LumiDataArchive['sections']['users'] = {}
    for (const user of lumiIdentityStore.users) {
      users[user.id] = await lumiIdentityStore.withUserScope(user.id, async () => ({
        chatSessions: await chatStore.exportSessions(),
        lumiMemory: await lumiMemoryStore.exportSnapshot(),
        lumiUserProfile: lumiUserProfileStore.exportSnapshot(),
        lumiCurrentState: lumiCurrentStateStore.exportSnapshot(),
        lumiEmotion: lumiEmotionStore.exportSnapshot(),
      }))
    }
    const roomLedgers: LumiDataArchive['sections']['roomLedgers'] = {}
    for (const conversationId of await lumiRoomLedgerRepo.listConversationIds()) {
      const ledger = await lumiRoomLedgerRepo.get(conversationId)
      if (ledger.events.length > 0 || ledger.receipts.length > 0)
        roomLedgers[conversationId] = ledger
    }
    const archive: LumiDataArchive = {
      format: LUMI_DATA_ARCHIVE_FORMAT,
      version: 6,
      source: 'lumi',
      exportedAt: new Date().toISOString(),
      sections: {
        identity: {
          users: JSON.parse(JSON.stringify(lumiIdentityStore.users)),
          externalIdentities: JSON.parse(JSON.stringify(lumiIdentityStore.externalIdentities)),
          activeUserId: lumiIdentityStore.activeUserId,
          migrationVersion: lumiIdentityStore.migrationVersion,
        },
        users,
        roomLedgers,
        channelDevices: await lumiChannelDevicesStore.exportArchive(),
        backgroundEntries: await serializeBackgroundEntries(await backgroundStore.exportUserEntries()),
        localStorage: exportLumiLocalStorageSnapshot(),
      },
    }
    return new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' })
  }

  async function exportLumiServerMigrationPackage(diaryEntries: unknown[] = []) {
    const archiveBlob = await exportLumiDataArchive()
    const archive = JSON.parse(await archiveBlob.text()) as Record<string, unknown>
    const migration = await createLumiClientMigrationPackage(archive, diaryEntries)
    return new Blob([JSON.stringify(migration, null, 2)], { type: 'application/json' })
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

    await lumiRoomLedgerRepo.clearAll()
    if (payload.version === 1) {
      await chatStore.importSessions(payload.sections.chatSessions)
      await lumiMemoryStore.importSnapshot(payload.sections.lumiMemory)
      await lumiUserProfileStore.importSnapshot(payload.sections.lumiUserProfile)
      await lumiCurrentStateStore.importSnapshot(payload.sections.lumiCurrentState)
      lumiEmotionStore.importSnapshot(payload.sections.lumiEmotion)
    }
    else {
      await lumiIdentityStore.importSnapshot(payload.sections.identity)
      for (const [userId, sections] of Object.entries(payload.sections.users)) {
        await lumiIdentityStore.withUserScope(userId, async () => {
          await chatStore.importSessions(sections.chatSessions)
          await lumiMemoryStore.importSnapshot(sections.lumiMemory)
          await lumiUserProfileStore.importSnapshot(sections.lumiUserProfile)
          await lumiCurrentStateStore.importSnapshot(sections.lumiCurrentState)
          lumiEmotionStore.importSnapshot(sections.lumiEmotion)
        })
      }
      if (lumiIdentityStore.activeUserId !== payload.sections.identity.activeUserId)
        await lumiIdentityStore.selectUser(payload.sections.identity.activeUserId)
      if (payload.version === 3 || payload.version === 4 || payload.version === 5 || payload.version === 6) {
        for (const ledger of Object.values(payload.sections.roomLedgers ?? {}))
          await lumiRoomLedgerRepo.replace(ledger)
      }
      if (payload.version === 6 || payload.version === 5)
        await lumiChannelDevicesStore.importArchive(payload.sections.channelDevices)
      if (payload.version === 4) {
        const legacyDevices = payload.sections.channelDevices
        await lumiChannelDevicesStore.importArchive(legacyDevices
          ? { ...legacyDevices, version: 2, audit: [] }
          : null)
      }
    }
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
    await lumiRoomLedgerRepo.clearAll()
    await lumiChannelDevicesStore.clear()
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
    exportLumiServerMigrationPackage,
    importLumiDataArchive,
    deleteAllData,
    resetDesktopApplicationState,
  }
}
