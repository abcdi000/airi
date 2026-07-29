<script setup lang="ts">
import { defineInvokeHandler } from '@moeru/eventa'
import { useElectronEventaContext, useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { themeColorFromValue, useThemeColor } from '@proj-airi/stage-layouts/composables/theme-color'
import { artistrySyncConfig } from '@proj-airi/stage-shared'
import { ToasterRoot } from '@proj-airi/stage-ui/components'
import { useInferencePreload } from '@proj-airi/stage-ui/composables'
import { useSharedAnalyticsStore } from '@proj-airi/stage-ui/stores/analytics'
import { useCharacterOrchestratorStore } from '@proj-airi/stage-ui/stores/character'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { usePluginHostInspectorStore } from '@proj-airi/stage-ui/stores/devtools/plugin-host-debug'
import { useDisplayModelsStore } from '@proj-airi/stage-ui/stores/display-models'
import { useLumiAgentStore } from '@proj-airi/stage-ui/stores/lumi-agent'
import { useLumiChannelDevicesStore } from '@proj-airi/stage-ui/stores/lumi-channel-devices'
import { useLumiCurrentStateStore } from '@proj-airi/stage-ui/stores/lumi-current-state'
import { useLumiIdentityStore } from '@proj-airi/stage-ui/stores/lumi-identity'
import { useLumiMemoryStore } from '@proj-airi/stage-ui/stores/lumi-memory'
import { useLumiOnlineStore } from '@proj-airi/stage-ui/stores/lumi-online'
import { useLumiSocialLanguageStore } from '@proj-airi/stage-ui/stores/lumi-social-language'
import { useLumiUserProfileStore } from '@proj-airi/stage-ui/stores/lumi-user-profile'
import { useModsServerChannelStore } from '@proj-airi/stage-ui/stores/mods/api/channel-server'
import { useContextBridgeStore } from '@proj-airi/stage-ui/stores/mods/api/context-bridge'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useArtistryStore } from '@proj-airi/stage-ui/stores/modules/artistry'
import { usePerfTracerBridgeStore } from '@proj-airi/stage-ui/stores/perf-tracer-bridge'
import { listProvidersForPluginHost, shouldPublishPluginHostCapabilities } from '@proj-airi/stage-ui/stores/plugin-host-capabilities'
import { useSettings, useSettingsAudioDevice } from '@proj-airi/stage-ui/stores/settings'
import { useTheme } from '@proj-airi/ui'
import { useLocalStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { onMounted, onUnmounted, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { toast, Toaster } from 'vue-sonner'

import MinecraftMcpMonitorLauncher from './components/MinecraftMcpMonitorLauncher.vue'
import ResizeHandler from './components/ResizeHandler.vue'

import {
  electronClaudeCodeAgentCancelTask,
  electronClaudeCodeAgentGetLog,
  electronClaudeCodeAgentListLogs,
  electronClaudeCodeAgentOpenTaskWindow,
  electronClaudeCodeAgentPickCommand,
  electronClaudeCodeAgentRunTask,
  electronClaudeCodeAgentSearchCommand,
  electronClearLumiChannelDevices,
  electronExportLumiChannelDeviceArchive,
  electronGetServerChannelConfig,
  electronGodotStageGetStatus,
  electronGodotStageStatusChanged,
  electronImportLumiChannelDeviceArchive,
  electronLumiCognitivePrepareTurn,
  electronLumiCognitiveRecordUse,
  electronLumiCurrentStateClear,
  electronLumiCurrentStateGetSnapshot,
  electronLumiCurrentStateSaveSnapshot,
  electronLumiIdentityChanged,
  electronLumiIdentityCreateUser,
  electronLumiIdentityGetSnapshot,
  electronLumiIdentityLinkExternalIdentity,
  electronLumiIdentityReplaceSnapshot,
  electronLumiIdentitySetActiveUser,
  electronLumiIdentitySetRuntimeBusy,
  electronLumiIdentityUpdateUser,
  electronLumiMemoryBackfillVectors,
  electronLumiMemoryClear,
  electronLumiMemoryDeleteMemory,
  electronLumiMemoryDeleteVector,
  electronLumiMemoryGetSnapshot,
  electronLumiMemoryGetVectors,
  electronLumiMemoryReplaceSnapshot,
  electronLumiMemorySaveEvent,
  electronLumiMemorySearchVectors,
  electronLumiMemorySetSeedId,
  electronLumiMemorySyncVector,
  electronLumiMemoryUpsertMemory,
  electronLumiMemoryUpsertVector,
  electronLumiMemoryVectorStatus,
  electronLumiSocialLanguageGetSnapshot,
  electronLumiSocialLanguageReplaceSnapshot,
  electronLumiUserProfileApprovePendingUpdate,
  electronLumiUserProfileArchiveEntry,
  electronLumiUserProfileClear,
  electronLumiUserProfileDeleteEntry,
  electronLumiUserProfileGetSnapshot,
  electronLumiUserProfileRejectPendingUpdate,
  electronLumiUserProfileReplaceSnapshot,
  electronLumiUserProfileSaveEntry,
  electronLumiUserProfileSaveEvidence,
  electronLumiUserProfileSaveHistory,
  electronLumiUserProfileSavePendingUpdate,
  electronLumiUserProfileSetMeta,
  electronLumiUserProfileUpdateEntry,
  electronOpenMiniChat,
  electronSettingsNavigate,
  electronStartTrackMousePosition,
  i18nGetLocale,
  i18nSetLocale,
} from '../shared/eventa'
import {
  electronPluginUpdateCapability,
  pluginProtocolListProviders,
  pluginProtocolListProvidersEventName,
} from '../shared/eventa/plugin/capabilities'
import {
  electronPluginAddFromDirectory,
  electronPluginInspect,
  electronPluginList,
  electronPluginLoad,
  electronPluginLoadEnabled,
  electronPluginOpenRoot,
  electronPluginRemove,
  electronPluginSetAutoReload,
  electronPluginSetEnabled,
  electronPluginUnload,
} from '../shared/eventa/plugin/host'
import { initializeLumiOnlineDesktopBridge } from './bridges/lumi-online'
import { initializeStageThreeRuntimeTraceBridge } from './bridges/stage-three-runtime-trace'
import { useLanguage } from './composables/use-language'
import { createChatSyncWindowLifecycle } from './stores/chat-sync-lifecycle'
import { useLumiAutonomousLifeStore } from './stores/lumi-autonomous-life'
import { useLumiDiarySchedulerStore } from './stores/lumi-diary-scheduler'
import { useLumiProactiveVisionStore } from './stores/lumi-proactive-vision'
import { useLumiSelfAdjustmentStore } from './stores/lumi-self-adjustment'
import { initializeLumiToolMeshRuntime } from './stores/lumi-tool-mesh-registration'
import { useTamagotchiMcpToolsStore } from './stores/mcp-tools'
import { useTamagotchiPluginToolsStore } from './stores/plugin-tools'
import { useServerChannelSettingsStore } from './stores/settings/server-channel'
import { useStageWindowLifecycleStore } from './stores/stage-window-lifecycle'

const { isDark: dark } = useTheme()
const contextBridgeStore = useContextBridgeStore()
const displayModelsStore = useDisplayModelsStore()
const settingsStore = useSettings()
const { language, themeColorsHue, themeColorsHueDynamic } = storeToRefs(settingsStore)
const serverChannelSettingsStore = useServerChannelSettingsStore()
const router = useRouter()
const route = useRoute()
const cardStore = useAiriCardStore()
const chatSessionStore = useChatSessionStore()
const chatOrchestratorStore = useChatOrchestratorStore()
const serverChannelStore = useModsServerChannelStore()
const characterOrchestratorStore = useCharacterOrchestratorStore()
const analyticsStore = useSharedAnalyticsStore()
const inferencePreload = useInferencePreload()
const pluginHostInspectorStore = usePluginHostInspectorStore()
const mcpToolsStore = useTamagotchiMcpToolsStore()
const proactiveVisionStore = useLumiProactiveVisionStore()
const autonomousLifeStore = useLumiAutonomousLifeStore()
const selfAdjustmentStore = useLumiSelfAdjustmentStore()
const diarySchedulerStore = useLumiDiarySchedulerStore()
const pluginToolsStore = useTamagotchiPluginToolsStore()
const stageWindowLifecycleStore = useStageWindowLifecycleStore()
const settingsAudioDeviceStore = useSettingsAudioDevice()
const lumiAgentStore = useLumiAgentStore()
const lumiChannelDevicesStore = useLumiChannelDevicesStore()
const lumiIdentityStore = useLumiIdentityStore()
const lumiCurrentStateStore = useLumiCurrentStateStore()
const lumiMemoryStore = useLumiMemoryStore()
const lumiSocialLanguageStore = useLumiSocialLanguageStore()
const lumiOnlineStore = useLumiOnlineStore()
const lumiUserProfileStore = useLumiUserProfileStore()
const miniChatEnabled = useLocalStorage('settings/plugins/lumi-chat-mini/enabled', false)
const artistryStore = useArtistryStore()
const { activeProvider, artistryGlobals, activeModel, defaultPromptPrefix, providerOptions } = storeToRefs(artistryStore)
const context = useElectronEventaContext()
usePerfTracerBridgeStore()
initializeStageThreeRuntimeTraceBridge()
const disposeLumiOnlineDesktopBridge = initializeLumiOnlineDesktopBridge()
void stageWindowLifecycleStore.initializeWindowLifecycleBridge()
const getServerChannelConfig = useElectronEventaInvoke(electronGetServerChannelConfig)
const listPlugins = useElectronEventaInvoke(electronPluginList)
const setPluginEnabled = useElectronEventaInvoke(electronPluginSetEnabled)
const setPluginAutoReload = useElectronEventaInvoke(electronPluginSetAutoReload)
const loadEnabledPlugins = useElectronEventaInvoke(electronPluginLoadEnabled)
const loadPlugin = useElectronEventaInvoke(electronPluginLoad)
const unloadPlugin = useElectronEventaInvoke(electronPluginUnload)
const inspectPluginHost = useElectronEventaInvoke(electronPluginInspect)
const openPluginRoot = useElectronEventaInvoke(electronPluginOpenRoot)
const addPluginFromDirectory = useElectronEventaInvoke(electronPluginAddFromDirectory)
const removePlugin = useElectronEventaInvoke(electronPluginRemove)
const startTrackingCursorPoint = useElectronEventaInvoke(electronStartTrackMousePosition)
const reportPluginCapability = useElectronEventaInvoke(electronPluginUpdateCapability)
const getMainLocale = useElectronEventaInvoke(i18nGetLocale)
const setLocale = useElectronEventaInvoke(i18nSetLocale)
const getGodotStageStatus = useElectronEventaInvoke(electronGodotStageGetStatus)
const syncArtistryConfig = useElectronEventaInvoke(artistrySyncConfig)
const openMiniChat = useElectronEventaInvoke(electronOpenMiniChat)
const runClaudeCodeAgentTask = useElectronEventaInvoke(electronClaudeCodeAgentRunTask)
const cancelClaudeCodeAgentTask = useElectronEventaInvoke(electronClaudeCodeAgentCancelTask)
const getClaudeCodeAgentLog = useElectronEventaInvoke(electronClaudeCodeAgentGetLog)
const listClaudeCodeAgentLogs = useElectronEventaInvoke(electronClaudeCodeAgentListLogs)
const openClaudeCodeAgentTaskWindow = useElectronEventaInvoke(electronClaudeCodeAgentOpenTaskWindow)
const pickClaudeCodeAgentCommand = useElectronEventaInvoke(electronClaudeCodeAgentPickCommand)
const searchClaudeCodeAgentCommand = useElectronEventaInvoke(electronClaudeCodeAgentSearchCommand)
const getLumiIdentitySnapshot = useElectronEventaInvoke(electronLumiIdentityGetSnapshot)
const createLumiIdentityUser = useElectronEventaInvoke(electronLumiIdentityCreateUser)
const updateLumiIdentityUser = useElectronEventaInvoke(electronLumiIdentityUpdateUser)
const setActiveLumiIdentityUser = useElectronEventaInvoke(electronLumiIdentitySetActiveUser)
const linkLumiExternalIdentity = useElectronEventaInvoke(electronLumiIdentityLinkExternalIdentity)
const replaceLumiIdentitySnapshot = useElectronEventaInvoke(electronLumiIdentityReplaceSnapshot)
const setLumiIdentityRuntimeBusy = useElectronEventaInvoke(electronLumiIdentitySetRuntimeBusy)
const exportLumiChannelDeviceArchive = useElectronEventaInvoke(electronExportLumiChannelDeviceArchive)
const importLumiChannelDeviceArchive = useElectronEventaInvoke(electronImportLumiChannelDeviceArchive)
const clearLumiChannelDevices = useElectronEventaInvoke(electronClearLumiChannelDevices)
const getLumiMemorySnapshot = useElectronEventaInvoke(electronLumiMemoryGetSnapshot)
const replaceLumiMemorySnapshot = useElectronEventaInvoke(electronLumiMemoryReplaceSnapshot)
const upsertLumiMemory = useElectronEventaInvoke(electronLumiMemoryUpsertMemory)
const deleteLumiMemory = useElectronEventaInvoke(electronLumiMemoryDeleteMemory)
const getLumiMemoryVectors = useElectronEventaInvoke(electronLumiMemoryGetVectors)
const upsertLumiMemoryVector = useElectronEventaInvoke(electronLumiMemoryUpsertVector)
const deleteLumiMemoryVector = useElectronEventaInvoke(electronLumiMemoryDeleteVector)
const getLumiMemoryVectorStatus = useElectronEventaInvoke(electronLumiMemoryVectorStatus)
const backfillLumiMemoryVectors = useElectronEventaInvoke(electronLumiMemoryBackfillVectors)
const searchLumiMemoryVectors = useElectronEventaInvoke(electronLumiMemorySearchVectors)
const syncLumiMemoryVector = useElectronEventaInvoke(electronLumiMemorySyncVector)
const saveLumiMemoryEvent = useElectronEventaInvoke(electronLumiMemorySaveEvent)
const setLumiMemorySeedId = useElectronEventaInvoke(electronLumiMemorySetSeedId)
const clearLumiMemory = useElectronEventaInvoke(electronLumiMemoryClear)
const prepareLumiCognitiveTurn = useElectronEventaInvoke(electronLumiCognitivePrepareTurn)
const recordLumiCognitiveUse = useElectronEventaInvoke(electronLumiCognitiveRecordUse)
const getLumiSocialLanguageSnapshot = useElectronEventaInvoke(electronLumiSocialLanguageGetSnapshot)
const replaceLumiSocialLanguageSnapshot = useElectronEventaInvoke(electronLumiSocialLanguageReplaceSnapshot)
const loadLumiCurrentStateFromDatabase = useElectronEventaInvoke(electronLumiCurrentStateGetSnapshot)
const saveLumiCurrentStateSnapshot = useElectronEventaInvoke(electronLumiCurrentStateSaveSnapshot)
const clearLumiCurrentStateDatabase = useElectronEventaInvoke(electronLumiCurrentStateClear)
const loadLumiUserProfileFromDatabase = useElectronEventaInvoke(electronLumiUserProfileGetSnapshot)
const replaceLumiUserProfileSnapshot = useElectronEventaInvoke(electronLumiUserProfileReplaceSnapshot)
const saveLumiUserProfileEntry = useElectronEventaInvoke(electronLumiUserProfileSaveEntry)
const updateLumiUserProfileEntry = useElectronEventaInvoke(electronLumiUserProfileUpdateEntry)
const archiveLumiUserProfileEntry = useElectronEventaInvoke(electronLumiUserProfileArchiveEntry)
const deleteLumiUserProfileEntry = useElectronEventaInvoke(electronLumiUserProfileDeleteEntry)
const saveLumiUserProfileEvidence = useElectronEventaInvoke(electronLumiUserProfileSaveEvidence)
const saveLumiUserProfileHistory = useElectronEventaInvoke(electronLumiUserProfileSaveHistory)
const saveLumiUserProfilePendingUpdate = useElectronEventaInvoke(electronLumiUserProfileSavePendingUpdate)
const approveLumiUserProfilePendingUpdate = useElectronEventaInvoke(electronLumiUserProfileApprovePendingUpdate)
const rejectLumiUserProfilePendingUpdate = useElectronEventaInvoke(electronLumiUserProfileRejectPendingUpdate)
const setLumiUserProfileMeta = useElectronEventaInvoke(electronLumiUserProfileSetMeta)
const clearLumiUserProfile = useElectronEventaInvoke(electronLumiUserProfileClear)
const chatSyncLifecycle = createChatSyncWindowLifecycle(route.path)
const isChatWindowRoute = () => route.path === '/chat' || route.path === '/chat-mini'
const isGodotStageRoute = () => route.path === '/' || route.path.startsWith('/settings')
const isWidgetsWindowRoute = () => route.path === '/widgets'

function toIpcPayload<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

lumiIdentityStore.setBridge({
  getSnapshot: () => getLumiIdentitySnapshot(),
  createUser: payload => createLumiIdentityUser(payload),
  updateUser: payload => updateLumiIdentityUser(payload),
  setActiveUser: payload => setActiveLumiIdentityUser(payload),
  linkExternalIdentity: payload => linkLumiExternalIdentity(payload),
  replaceSnapshot: snapshot => replaceLumiIdentitySnapshot(toIpcPayload(snapshot)),
})

lumiChannelDevicesStore.setArchiveBridge({
  exportSnapshot: () => exportLumiChannelDeviceArchive(),
  importSnapshot: snapshot => importLumiChannelDeviceArchive(toIpcPayload(snapshot)),
  clear: () => clearLumiChannelDevices(),
})

lumiIdentityStore.setSwitchPolicy({
  canSwitch: () => !chatOrchestratorStore.sending
    && chatOrchestratorStore.pendingQueuedSendCount === 0
    && !autonomousLifeStore.processing
    && !proactiveVisionStore.processing
    && !diarySchedulerStore.writing,
  afterSwitch: async () => {
    lumiUserProfileStore.setActiveProfileUser(lumiIdentityStore.activeUserId)
    lumiCurrentStateStore.setActiveStateUser(lumiIdentityStore.activeUserId)
    await Promise.all([
      chatSessionStore.reloadForActiveUser(),
      lumiMemoryStore.reloadForActiveUser(),
      lumiUserProfileStore.reloadFromDatabase(),
      lumiCurrentStateStore.reloadForActiveUser(),
    ])
    lumiUserProfileStore.ensureKnownUserProfile(lumiIdentityStore.activeUserId)
  },
})

const disposeLumiIdentityChanged = context.value.on(electronLumiIdentityChanged, (event) => {
  if (!event.body)
    return
  void lumiIdentityStore.synchronizeSnapshot(event.body).catch((error) => {
    console.error('[App] Failed to synchronize Lumi identity across windows:', error)
  })
})

const stopLumiIdentityBusyWatch = watch(
  [
    () => chatOrchestratorStore.sending,
    () => chatOrchestratorStore.pendingQueuedSendCount,
    () => autonomousLifeStore.processing,
    () => proactiveVisionStore.processing,
    () => diarySchedulerStore.writing,
  ],
  ([sending, pendingQueuedSendCount, autonomousLifeProcessing, proactiveVisionProcessing, diaryWriting]) => {
    const busy = sending
      || pendingQueuedSendCount > 0
      || autonomousLifeProcessing
      || proactiveVisionProcessing
      || diaryWriting
    void setLumiIdentityRuntimeBusy({ busy }).catch((error) => {
      console.warn('[App] Failed to report Lumi identity switch availability:', error)
    })
  },
  { immediate: true },
)

lumiMemoryStore.setPersistenceBridge({
  getSnapshot: payload => getLumiMemorySnapshot(payload) as any,
  replaceSnapshot: payload => replaceLumiMemorySnapshot(toIpcPayload(payload) as any) as any,
  upsertMemory: memory => upsertLumiMemory(toIpcPayload(memory) as any),
  deleteMemory: payload => deleteLumiMemory(payload),
  getVectors: payload => getLumiMemoryVectors(payload),
  upsertVector: record => upsertLumiMemoryVector(toIpcPayload(record) as any),
  deleteVector: payload => deleteLumiMemoryVector(payload),
  vectorStatus: payload => getLumiMemoryVectorStatus(payload) as any,
  backfillVectors: payload => backfillLumiMemoryVectors(payload) as any,
  searchVectors: payload => searchLumiMemoryVectors(payload) as any,
  syncVector: memory => syncLumiMemoryVector(toIpcPayload(memory) as any) as any,
  saveEvent: payload => saveLumiMemoryEvent(toIpcPayload(payload) as any),
  setSeedId: payload => setLumiMemorySeedId(payload),
  clear: payload => clearLumiMemory(payload),
})

chatOrchestratorStore.setDesktopCognitivePort({
  async prepareTurn({ envelope, recentTurns }) {
    return await prepareLumiCognitiveTurn(toIpcPayload({
      identity: {
        actorId: envelope.personId,
        personaId: 'lumi',
        conversationId: envelope.conversationId,
        conversationType: envelope.conversationType,
        participantUserIds: [...new Set([
          envelope.personId,
          ...envelope.participantPersonIds,
        ])],
      },
      sourceMessageId: envelope.sourceMessageId,
      userText: envelope.text ?? '',
      recentTurns: recentTurns.map((turn, index) => ({
        id: turn.messageIds.at(-1) ?? `dialogue:${turn.timestamp}:${index}`,
        role: turn.role,
        content: turn.textSegments.join('\n'),
      })),
      platform: envelope.platform,
    }))
  },
  async recordContextUse({ envelope, memoryIds, hypothesisIds, usedAt }) {
    await recordLumiCognitiveUse({
      identity: {
        actorId: envelope.personId,
        personaId: 'lumi',
        conversationId: envelope.conversationId,
        conversationType: envelope.conversationType,
        participantUserIds: [...new Set([
          envelope.personId,
          ...envelope.participantPersonIds,
        ])],
      },
      memoryIds: [...memoryIds],
      hypothesisIds: [...hypothesisIds],
      usedAt,
    })
  },
})

lumiSocialLanguageStore.setPersistenceBridge({
  loadSnapshot: () => getLumiSocialLanguageSnapshot(),
  replaceSnapshot: snapshot => replaceLumiSocialLanguageSnapshot(toIpcPayload(snapshot)),
})
void lumiSocialLanguageStore.initialize()

lumiCurrentStateStore.setPersistenceBridge({
  loadCurrentStateFromDatabase: userId => loadLumiCurrentStateFromDatabase({ userId: userId ?? lumiIdentityStore.activeUserId }) as any,
  saveCurrentState: (snapshot, userId) => saveLumiCurrentStateSnapshot({ userId: userId ?? lumiIdentityStore.activeUserId, snapshot: toIpcPayload(snapshot) as any }) as any,
  clearCurrentState: () => clearLumiCurrentStateDatabase({ userId: lumiIdentityStore.activeUserId }),
})

lumiAgentStore.setBridge({
  runClaudeTask: payload => runClaudeCodeAgentTask(payload as any) as any,
  cancelClaudeTask: taskId => cancelClaudeCodeAgentTask({ taskId }),
  listClaudeTasks: limit => listClaudeCodeAgentLogs({ limit, settings: lumiAgentStore.settings } as any) as any,
  getClaudeTaskLog: taskId => getClaudeCodeAgentLog({ taskId, settings: lumiAgentStore.settings } as any) as any,
  openClaudeTaskWindow: (taskId, settings) => openClaudeCodeAgentTaskWindow({ taskId, settings: settings as any }),
  pickClaudeCommand: () => pickClaudeCodeAgentCommand() as any,
  searchClaudeCommand: command => searchClaudeCodeAgentCommand({ command }) as any,
})

lumiUserProfileStore.setPersistenceBridge({
  loadProfileFromDatabase: userId => loadLumiUserProfileFromDatabase({ userId: userId ?? lumiIdentityStore.activeUserId }) as any,
  replaceSnapshot: (snapshot, userId) => replaceLumiUserProfileSnapshot({ userId: userId ?? lumiIdentityStore.activeUserId, snapshot: toIpcPayload(snapshot) as any }) as any,
  saveProfileEntry: entry => saveLumiUserProfileEntry({ userId: lumiIdentityStore.activeUserId, entry: toIpcPayload(entry) as any }),
  updateProfileEntry: entry => updateLumiUserProfileEntry({ userId: lumiIdentityStore.activeUserId, entry: toIpcPayload(entry) as any }),
  archiveProfileEntry: payload => archiveLumiUserProfileEntry({ userId: lumiIdentityStore.activeUserId, ...payload }),
  deleteProfileEntry: payload => deleteLumiUserProfileEntry({ userId: lumiIdentityStore.activeUserId, ...payload }),
  saveEvidence: payload => saveLumiUserProfileEvidence({ userId: lumiIdentityStore.activeUserId, ...toIpcPayload(payload) as any }),
  saveHistory: payload => saveLumiUserProfileHistory({ userId: lumiIdentityStore.activeUserId, ...toIpcPayload(payload) as any }),
  loadPendingUpdates: async () => (await loadLumiUserProfileFromDatabase({ userId: lumiIdentityStore.activeUserId }) as any).pendingUpdates ?? [],
  savePendingUpdate: pending => saveLumiUserProfilePendingUpdate({ userId: lumiIdentityStore.activeUserId, pending: toIpcPayload(pending) as any }),
  approvePendingUpdate: payload => approveLumiUserProfilePendingUpdate({ userId: lumiIdentityStore.activeUserId, ...toIpcPayload(payload) as any }),
  rejectPendingUpdate: payload => rejectLumiUserProfilePendingUpdate({ userId: lumiIdentityStore.activeUserId, ...payload }),
  setMeta: payload => setLumiUserProfileMeta({ userId: lumiIdentityStore.activeUserId, ...toIpcPayload(payload) as any }),
  clear: () => clearLumiUserProfile({ userId: lumiIdentityStore.activeUserId }),
})

function syncGodotStageRenderer(state: { state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error' }) {
  if (state.state === 'running') {
    settingsStore.setStageModelRenderer('godot')
    return
  }

  if ((state.state === 'stopped' || state.state === 'error') && settingsStore.stageModelRenderer === 'godot')
    settingsStore.restoreBuiltInStageModelRenderer()
}

async function refreshPluginRuntimeTools() {
  try {
    await pluginToolsStore.refresh()
  }
  catch (error) {
    console.warn('[App] Failed to refresh plugin runtime tools:', error)
  }
}

watch(() => route.path, () => {
  contextBridgeStore.setSparkNotifyHostRole(isWidgetsWindowRoute() ? 'client' : 'main')
}, { immediate: true })

// NOTICE: register plugin host bridge during setup to avoid race with pages using it in immediate watchers.
pluginHostInspectorStore.setBridge({
  list: () => listPlugins(),
  setEnabled: async (payload) => {
    const result = await setPluginEnabled(payload)
    await refreshPluginRuntimeTools()
    return result
  },
  setAutoReload: payload => setPluginAutoReload(payload),
  openRoot: () => openPluginRoot(),
  addFromDirectory: async () => {
    const result = await addPluginFromDirectory()
    await refreshPluginRuntimeTools()
    return result
  },
  remove: async (payload) => {
    const result = await removePlugin(payload)
    await refreshPluginRuntimeTools()
    return result
  },
  loadEnabled: async () => {
    const result = await loadEnabledPlugins()
    await refreshPluginRuntimeTools()
    return result
  },
  load: async (payload) => {
    const result = await loadPlugin(payload)
    await refreshPluginRuntimeTools()
    return result
  },
  unload: async (payload) => {
    const result = await unloadPlugin(payload)
    await refreshPluginRuntimeTools()
    return result
  },
  inspect: () => inspectPluginHost(),
})

// NOTICE: Runtime tool stores must register during setup so renderer consumers can see them
// before `onMounted()` finishes the rest of the startup flow.
if (lumiOnlineStore.runtimeMode === 'offline-client') {
  void mcpToolsStore.refresh().catch((error) => {
    console.warn('[App] Failed to refresh MCP runtime tools:', error)
  })
  void refreshPluginRuntimeTools()
  void proactiveVisionStore.registerObserveScreenTool().catch((error) => {
    console.warn('[App] Failed to register Lumi screen observation tool:', error)
  })
  selfAdjustmentStore.initializeToolRegistration()
  lumiAgentStore.initializeToolRegistration()
  initializeLumiToolMeshRuntime()
}

const { restore: restoreLocale } = useLanguage(language, getMainLocale, setLocale)

watch([activeProvider, artistryGlobals, activeModel, defaultPromptPrefix, providerOptions], () => {
  if (activeProvider.value) {
    void syncArtistryConfig({
      provider: activeProvider.value as string,
      globals: JSON.parse(JSON.stringify(artistryGlobals.value)),
      model: activeModel.value,
      promptPrefix: defaultPromptPrefix.value,
      options: providerOptions.value,
    })
  }
}, { deep: true, immediate: true })

const { updateThemeColor } = useThemeColor(themeColorFromValue({ light: 'rgb(255 255 255)', dark: 'rgb(18 18 18)' }))
watch(dark, () => updateThemeColor(), { immediate: true })
watch(route, () => updateThemeColor(), { immediate: true })
onMounted(() => updateThemeColor())

context.value.on(electronSettingsNavigate, (event) => {
  const targetRoute = event?.body?.route
  if (!targetRoute || route.fullPath === targetRoute) {
    return
  }

  void router.push(targetRoute).catch((error) => {
    console.warn('Failed to navigate settings window:', error)
  })
})

context.value.on(electronGodotStageStatusChanged, (event) => {
  if (!event.body) {
    return
  }

  syncGodotStageRenderer(event.body)
})

onMounted(async () => {
  chatSyncLifecycle.initialize()

  // NOTICE: Issue #1658
  // When Electron restarts, renderer localStorage may not be flushed to disk.
  // The store's onMounted hook falls back to navigator.language, which triggers
  // watch(language) and overwrites the main-process config with the OS locale.
  // We must restore the correct locale from main process before allowing sync.
  // https://github.com/moeru-ai/airi/issues/1658
  await restoreLocale()

  analyticsStore.initialize()
  await displayModelsStore.initialize()
  await lumiIdentityStore.initialize()
  cardStore.initialize()
  void lumiMemoryStore.initializePersistence()
    .then(() => lumiMemoryStore.prewarmSemanticIndex().catch((error) => {
      console.warn('[App] Lumi memory semantic index prewarm failed:', error)
    }))
    .catch((error) => {
      console.warn('[App] Lumi memory persistence initialization failed:', error)
    })
  lumiUserProfileStore.setActiveProfileUser(lumiIdentityStore.activeUserId)
  lumiCurrentStateStore.setActiveStateUser(lumiIdentityStore.activeUserId)
  void lumiUserProfileStore.initializePersistence()
    .then(() => lumiUserProfileStore.ensureKnownUserProfile(lumiIdentityStore.activeUserId))
    .catch((error) => {
      console.warn('[App] Lumi user profile persistence initialization failed:', error)
    })
  void lumiCurrentStateStore.initializePersistence().catch((error) => {
    console.warn('[App] Lumi current_state persistence initialization failed:', error)
  })

  await chatSessionStore.initialize()
  await lumiOnlineStore.initialize()
  if (chatSyncLifecycle.role === 'authority' && miniChatEnabled.value) {
    void openMiniChat().catch((error) => {
      console.warn('[App] Failed to open Lumi mini chat:', error)
    })
  }

  if (chatSyncLifecycle.role === 'authority') {
    proactiveVisionStore.setRuntimeStatusPublishingEnabled(true)

    watch([() => proactiveVisionStore.enabled, () => lumiOnlineStore.runtimeMode], ([enabled, mode]) => {
      if (enabled && mode === 'offline-client') {
        void proactiveVisionStore.start().catch((error) => {
          console.warn('[App] Failed to start Lumi proactive vision:', error)
        })
        return
      }

      // Runtime role changes pause local autonomy without erasing the user's
      // offline preference. Returning to offline mode must resume the chain.
      proactiveVisionStore.stop({ disable: false })
    }, { immediate: true })

    watch([() => diarySchedulerStore.enabled, () => lumiOnlineStore.runtimeMode], ([enabled, mode]) => {
      if (enabled && mode === 'offline-client') {
        diarySchedulerStore.start()
        return
      }

      diarySchedulerStore.stop()
    }, { immediate: true })

    watch([() => autonomousLifeStore.enabled, () => lumiOnlineStore.runtimeMode], ([enabled, mode]) => {
      if (enabled && mode === 'offline-client') {
        autonomousLifeStore.start()
        return
      }

      autonomousLifeStore.stop()
    }, { immediate: true })
  }
  await displayModelsStore.loadDisplayModelsFromIndexedDB()
  await settingsStore.initializeStageModel()
  await settingsAudioDeviceStore.initialize()

  if (isGodotStageRoute()) {
    try {
      syncGodotStageRenderer(await getGodotStageStatus())
    }
    catch (error) {
      console.warn('[App] Failed to fetch Godot stage status:', error)
    }
  }

  const serverChannelConfig = await getServerChannelConfig()
  serverChannelSettingsStore.tlsConfig = serverChannelConfig.tlsConfig ?? null
  serverChannelSettingsStore.hostname = serverChannelConfig.hostname
  serverChannelSettingsStore.authToken = serverChannelConfig.authToken

  await serverChannelStore.initialize({
    token: serverChannelConfig.authToken || undefined,
    possibleEvents: ['ui:configure'],
  }).catch(err => console.error('Failed to initialize Mods Server Channel in App.vue:', err))
  if (!isChatWindowRoute()) {
    contextBridgeStore.initialize()
    if (!isWidgetsWindowRoute()) {
      characterOrchestratorStore.initialize()
      await startTrackingCursorPoint()
    }
  }

  // Expose stage provider definitions to plugin host APIs.
  defineInvokeHandler(context.value, pluginProtocolListProviders, async () => listProvidersForPluginHost())

  if (shouldPublishPluginHostCapabilities()) {
    await reportPluginCapability({
      key: pluginProtocolListProvidersEventName,
      state: 'ready',
      metadata: {
        source: 'stage-ui',
      },
    })
  }

  // Preload local inference models (Kokoro TTS, etc.) in background after a delay
  inferencePreload.triggerPreload()
})

onUnmounted(() => {
  chatSyncLifecycle.dispose()
  chatOrchestratorStore.setDesktopCognitivePort(undefined)
  disposeLumiIdentityChanged()
  stopLumiIdentityBusyWatch()
  disposeLumiOnlineDesktopBridge()
  void setLumiIdentityRuntimeBusy({ busy: false }).catch(() => {})
})

watch(themeColorsHue, () => {
  document.documentElement.style.setProperty('--chromatic-hue', themeColorsHue.value.toString())
}, { immediate: true })

watch(themeColorsHueDynamic, () => {
  document.documentElement.classList.toggle('dynamic-hue', themeColorsHueDynamic.value)
}, { immediate: true })

onUnmounted(() => {
  if (!isChatWindowRoute()) {
    contextBridgeStore.dispose()
  }
  mcpToolsStore.dispose()
  selfAdjustmentStore.clearTool()
  proactiveVisionStore.clearObserveScreenTool()
  proactiveVisionStore.stop({ disable: false })
  proactiveVisionStore.setRuntimeStatusPublishingEnabled(false)
  autonomousLifeStore.stop()
  diarySchedulerStore.stop()
  pluginToolsStore.dispose()
})
</script>

<template>
  <ToasterRoot @close="id => toast.dismiss(id)">
    <Toaster />
  </ToasterRoot>
  <ResizeHandler v-if="route.path !== '/chat-mini' && route.path !== '/minecraft-mcp-monitor'" />
  <MinecraftMcpMonitorLauncher v-if="route.path !== '/chat-mini' && route.path !== '/minecraft-mcp-monitor'" />
  <RouterView />
</template>

<style>
/* We need this to properly animate the CSS variable */
@property --chromatic-hue {
  syntax: '<number>';
  initial-value: 0;
  inherits: true;
}

@keyframes hue-anim {
  from {
    --chromatic-hue: 0;
  }
  to {
    --chromatic-hue: 360;
  }
}

.dynamic-hue {
  animation: hue-anim 10s linear infinite;
}
</style>
