<script setup lang="ts">
import { defineInvokeHandler } from '@moeru/eventa'
import { useElectronEventaContext, useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { themeColorFromValue, useThemeColor } from '@proj-airi/stage-layouts/composables/theme-color'
import { artistrySyncConfig } from '@proj-airi/stage-shared'
import { ToasterRoot } from '@proj-airi/stage-ui/components'
import { useInferencePreload } from '@proj-airi/stage-ui/composables'
import { useSharedAnalyticsStore } from '@proj-airi/stage-ui/stores/analytics'
import { useCharacterOrchestratorStore } from '@proj-airi/stage-ui/stores/character'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { usePluginHostInspectorStore } from '@proj-airi/stage-ui/stores/devtools/plugin-host-debug'
import { useDisplayModelsStore } from '@proj-airi/stage-ui/stores/display-models'
import { useLumiAgentStore } from '@proj-airi/stage-ui/stores/lumi-agent'
import { useModsServerChannelStore } from '@proj-airi/stage-ui/stores/mods/api/channel-server'
import { useContextBridgeStore } from '@proj-airi/stage-ui/stores/mods/api/context-bridge'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useArtistryStore } from '@proj-airi/stage-ui/stores/modules/artistry'
import { usePerfTracerBridgeStore } from '@proj-airi/stage-ui/stores/perf-tracer-bridge'
import { listProvidersForPluginHost, shouldPublishPluginHostCapabilities } from '@proj-airi/stage-ui/stores/plugin-host-capabilities'
import { useSettings, useSettingsAudioDevice } from '@proj-airi/stage-ui/stores/settings'
import { useLumiCurrentStateStore } from '@proj-airi/stage-ui/stores/lumi-current-state'
import { useLumiMemoryStore } from '@proj-airi/stage-ui/stores/lumi-memory'
import { useLumiUserProfileStore } from '@proj-airi/stage-ui/stores/lumi-user-profile'
import { useTheme } from '@proj-airi/ui'
import { useLocalStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { onMounted, onUnmounted, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { toast, Toaster } from 'vue-sonner'

import ResizeHandler from './components/ResizeHandler.vue'

import {
  electronGetServerChannelConfig,
  electronGodotStageGetStatus,
  electronGodotStageStatusChanged,
  electronClaudeCodeAgentCancelTask,
  electronClaudeCodeAgentGetLog,
  electronClaudeCodeAgentListLogs,
  electronClaudeCodeAgentOpenTaskWindow,
  electronClaudeCodeAgentPickCommand,
  electronClaudeCodeAgentRunTask,
  electronClaudeCodeAgentSearchCommand,
  electronLumiMemoryBackfillVectors,
  electronLumiMemoryClear,
  electronLumiMemoryDeleteMemory,
  electronLumiMemoryDeleteVector,
  electronLumiMemoryGetVectors,
  electronLumiMemoryGetSnapshot,
  electronLumiMemoryReplaceSnapshot,
  electronLumiMemorySaveEvent,
  electronLumiMemorySearchVectors,
  electronLumiMemorySetSeedId,
  electronLumiMemorySyncVector,
  electronLumiMemoryUpsertMemory,
  electronLumiMemoryUpsertVector,
  electronLumiMemoryVectorStatus,
  electronLumiCurrentStateClear,
  electronLumiCurrentStateGetSnapshot,
  electronLumiCurrentStateSaveSnapshot,
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
  electronPluginInspect,
  electronPluginAddFromDirectory,
  electronPluginList,
  electronPluginLoad,
  electronPluginLoadEnabled,
  electronPluginOpenRoot,
  electronPluginRemove,
  electronPluginSetAutoReload,
  electronPluginSetEnabled,
  electronPluginUnload,
} from '../shared/eventa/plugin/host'
import { initializeElectronAuthCallbackBridge } from './bridges/electron-auth-callback'
import { initializeStageThreeRuntimeTraceBridge } from './bridges/stage-three-runtime-trace'
import MinecraftMcpMonitorLauncher from './components/MinecraftMcpMonitorLauncher.vue'
import { useLanguage } from './composables/use-language'
import { createChatSyncWindowLifecycle } from './stores/chat-sync-lifecycle'
import { useLumiAutonomousLifeStore } from './stores/lumi-autonomous-life'
import { useLumiDiarySchedulerStore } from './stores/lumi-diary-scheduler'
import { useTamagotchiMcpToolsStore } from './stores/mcp-tools'
import { useLumiProactiveVisionStore } from './stores/lumi-proactive-vision'
import { useLumiSelfAdjustmentStore } from './stores/lumi-self-adjustment'
import { initializeLumiToolMeshRuntime } from './stores/lumi-tool-mesh-registration'
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
const lumiCurrentStateStore = useLumiCurrentStateStore()
const lumiMemoryStore = useLumiMemoryStore()
const lumiUserProfileStore = useLumiUserProfileStore()
const miniChatEnabled = useLocalStorage('settings/plugins/lumi-chat-mini/enabled', false)
const artistryStore = useArtistryStore()
const { activeProvider, artistryGlobals, activeModel, defaultPromptPrefix, providerOptions } = storeToRefs(artistryStore)
const context = useElectronEventaContext()
usePerfTracerBridgeStore()
initializeStageThreeRuntimeTraceBridge()
initializeElectronAuthCallbackBridge()
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

lumiMemoryStore.setPersistenceBridge({
  getSnapshot: () => getLumiMemorySnapshot() as any,
  replaceSnapshot: snapshot => replaceLumiMemorySnapshot(toIpcPayload(snapshot) as any) as any,
  upsertMemory: memory => upsertLumiMemory(toIpcPayload(memory) as any),
  deleteMemory: payload => deleteLumiMemory(payload),
  getVectors: payload => getLumiMemoryVectors(payload),
  upsertVector: record => upsertLumiMemoryVector(toIpcPayload(record) as any),
  deleteVector: payload => deleteLumiMemoryVector(payload),
  vectorStatus: () => getLumiMemoryVectorStatus() as any,
  backfillVectors: payload => backfillLumiMemoryVectors(payload ?? {}) as any,
  searchVectors: payload => searchLumiMemoryVectors(payload) as any,
  syncVector: memory => syncLumiMemoryVector(toIpcPayload(memory) as any) as any,
  saveEvent: event => saveLumiMemoryEvent(toIpcPayload(event) as any),
  setSeedId: payload => setLumiMemorySeedId(payload),
  clear: () => clearLumiMemory(),
})

lumiCurrentStateStore.setPersistenceBridge({
  loadCurrentStateFromDatabase: () => loadLumiCurrentStateFromDatabase() as any,
  saveCurrentState: snapshot => saveLumiCurrentStateSnapshot(toIpcPayload(snapshot) as any) as any,
  clearCurrentState: () => clearLumiCurrentStateDatabase(),
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
  loadProfileFromDatabase: () => loadLumiUserProfileFromDatabase() as any,
  replaceSnapshot: snapshot => replaceLumiUserProfileSnapshot(toIpcPayload(snapshot) as any) as any,
  saveProfileEntry: entry => saveLumiUserProfileEntry(toIpcPayload(entry) as any),
  updateProfileEntry: entry => updateLumiUserProfileEntry(toIpcPayload(entry) as any),
  archiveProfileEntry: payload => archiveLumiUserProfileEntry(payload),
  deleteProfileEntry: payload => deleteLumiUserProfileEntry(payload),
  saveEvidence: payload => saveLumiUserProfileEvidence(toIpcPayload(payload) as any),
  saveHistory: payload => saveLumiUserProfileHistory(toIpcPayload(payload) as any),
  loadPendingUpdates: async () => (await loadLumiUserProfileFromDatabase() as any).pendingUpdates ?? [],
  savePendingUpdate: pending => saveLumiUserProfilePendingUpdate(toIpcPayload(pending) as any),
  approvePendingUpdate: payload => approveLumiUserProfilePendingUpdate(toIpcPayload(payload) as any),
  rejectPendingUpdate: payload => rejectLumiUserProfilePendingUpdate(payload),
  setMeta: payload => setLumiUserProfileMeta(toIpcPayload(payload) as any),
  clear: () => clearLumiUserProfile(),
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
  cardStore.initialize()
  void lumiMemoryStore.initializePersistence()
    .then(() => lumiMemoryStore.prewarmSemanticIndex().catch((error) => {
      console.warn('[App] Lumi memory semantic index prewarm failed:', error)
    }))
    .catch((error) => {
      console.warn('[App] Lumi memory persistence initialization failed:', error)
    })
  void lumiUserProfileStore.initializePersistence().catch((error) => {
    console.warn('[App] Lumi user profile persistence initialization failed:', error)
  })
  void lumiCurrentStateStore.initializePersistence().catch((error) => {
    console.warn('[App] Lumi current_state persistence initialization failed:', error)
  })

  await chatSessionStore.initialize()
  if (chatSyncLifecycle.role === 'authority' && proactiveVisionStore.enabled) {
    void proactiveVisionStore.start().catch((error) => {
      console.warn('[App] Failed to start Lumi proactive vision:', error)
    })
  }
  if (chatSyncLifecycle.role === 'authority' && diarySchedulerStore.enabled) {
    diarySchedulerStore.start()
  }
  if (chatSyncLifecycle.role === 'authority' && autonomousLifeStore.enabled) {
    autonomousLifeStore.start()
  }
  if (chatSyncLifecycle.role === 'authority' && miniChatEnabled.value) {
    void openMiniChat().catch((error) => {
      console.warn('[App] Failed to open Lumi mini chat:', error)
    })
  }

  if (chatSyncLifecycle.role === 'authority') {
    watch(() => proactiveVisionStore.enabled, (enabled) => {
      if (enabled) {
        void proactiveVisionStore.start().catch((error) => {
          console.warn('[App] Failed to start Lumi proactive vision:', error)
        })
        return
      }

      proactiveVisionStore.stop({ disable: true })
    })

    watch(() => diarySchedulerStore.enabled, (enabled) => {
      if (enabled) {
        diarySchedulerStore.start()
        return
      }

      diarySchedulerStore.stop()
    })

    watch(() => autonomousLifeStore.enabled, (enabled) => {
      if (enabled) {
        autonomousLifeStore.start()
        return
      }

      autonomousLifeStore.stop()
    })
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
