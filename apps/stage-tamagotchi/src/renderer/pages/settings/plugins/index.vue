<script setup lang="ts">
import type { PluginManifestSummary } from '@proj-airi/stage-ui/stores/devtools/plugin-host-debug'

import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { Section } from '@proj-airi/stage-ui/components'
import { usePluginHostInspectorStore } from '@proj-airi/stage-ui/stores/devtools/plugin-host-debug'
import { useLumiToolMeshStore } from '@proj-airi/stage-ui/stores/lumi-tool-mesh'
import { Button, Callout, FieldCheckbox, FieldCombobox, FieldInput, FieldRange } from '@proj-airi/ui'
import { useLocalStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'

import { electronAppOpenPath, electronOpenMiniChat } from '../../../../shared/eventa'
import { useLumiAutonomousLifeStore } from '../../../stores/lumi-autonomous-life'
import { useLumiDiarySchedulerStore } from '../../../stores/lumi-diary-scheduler'
import { useLumiProactiveVisionStore } from '../../../stores/lumi-proactive-vision'
import { useLumiSelfAdjustmentStore } from '../../../stores/lumi-self-adjustment'
import { useLumiSelfTodoStore } from '../../../stores/lumi-self-todo'
import { useTamagotchiPluginToolsStore } from '../../../stores/plugin-tools'
import VisionCapturePreview from './components/visionCapturePreview.vue'

const pluginStore = usePluginHostInspectorStore()
const proactiveVisionStore = useLumiProactiveVisionStore()
const selfAdjustmentStore = useLumiSelfAdjustmentStore()
const selfTodoStore = useLumiSelfTodoStore()
const autonomousLifeStore = useLumiAutonomousLifeStore()
const diarySchedulerStore = useLumiDiarySchedulerStore()
const pluginToolsStore = useTamagotchiPluginToolsStore()
const toolMeshStore = useLumiToolMeshStore()
const openMiniChatWindow = useElectronEventaInvoke(electronOpenMiniChat)
const openPath = useElectronEventaInvoke(electronAppOpenPath)

const filter = useLocalStorage('settings/plugins/filter', '')
const proactiveRuntimeStatus = useLocalStorage<Record<string, any>>('runtime/lumi-proactive-vision/status', {})
const miniChatEnabled = useLocalStorage('settings/plugins/lumi-chat-mini/enabled', false)
const miniChatAlwaysOnTop = useLocalStorage('settings/plugins/lumi-chat-mini/always-on-top', true)
const miniChatInactiveOpacity = useLocalStorage('settings/plugins/lumi-chat-mini/inactive-opacity', 0.62)
const miniChatEdgeDockEnabled = useLocalStorage('settings/plugins/lumi-chat-mini/edge-dock-enabled', true)
const miniChatEdgeDockThreshold = useLocalStorage('settings/plugins/lumi-chat-mini/edge-dock-threshold', 24)
const miniChatEdgeDockVisibleSize = useLocalStorage('settings/plugins/lumi-chat-mini/edge-dock-visible-size', 18)

const {
  enabled: proactiveVisionEnabled,
  running,
  processing,
  configured,
  sourceId,
  workloadId,
  minIntervalMs,
  maxIntervalMs,
  cooldownMs,
  publishOnlyWhenLumiActive,
  autonomousEnabled,
  quietMode,
  summaryMode,
  idleDailyMaxMessages,
  agentSuggestionCooldownMs,
  observationNoEffectThreshold,
  allowAutonomousSandboxTasks,
  lumiWorldRoot,
  decisionLog,
  privateNotes,
  runtimeLogs,
  settingChangeAudit,
  todayProactiveMessageCount,
  ignoredProactiveStreak,
  lowChangeStreak,
  noProgressStreak,
  sources,
  isRefetching,
  workloadOptions,
  lastError,
  lastObservation,
  lastMessage,
  lastCaptureAt,
  lastCaptureSourceId,
  lastCaptureSourceName,
  lastCapturedImageDataUrl,
  lastVisionInputImageDataUrl,
  lastMessageAt,
  lastScheduledDelayMs,
  tickCount,
  skippedCount,
  environmentContext,
  currentActivity,
  lastSalience,
  lastDecision,
  captureFailureCount,
} = storeToRefs(proactiveVisionStore)

const {
  enabled: selfAdjustmentEnabled,
  loaded: selfAdjustmentLoaded,
  allowProactiveVisionTiming,
  allowConsciousnessModelSwitch,
  allowOllamaThinkingMode,
  allowSpeechPlaybackVolume,
  allowPromptHistoryLimit,
  changeLog: selfAdjustmentChangeLog,
  lastError: selfAdjustmentLastError,
  lastChangeAt: selfAdjustmentLastChangeAt,
} = storeToRefs(selfAdjustmentStore)

const {
  projects: selfTodoProjects,
  activeProject: selfTodoActiveProject,
  nextExecutableTodo: selfTodoNextTodo,
} = storeToRefs(selfTodoStore)

const {
  enabled: lifeTickEnabled,
  minIntervalMs: lifeTickMinIntervalMs,
  maxIntervalMs: lifeTickMaxIntervalMs,
  dailyActionBudget: lifeTickDailyActionBudget,
  lumiWorldRoot: lifeTickLumiWorldRoot,
  running: lifeTickRunning,
  processing: lifeTickProcessing,
  lastError: lifeTickLastError,
  lastDecision: lifeTickLastDecision,
  ideas: lifeTickIdeas,
  reflections: lifeTickReflections,
  restState: lifeTickRestState,
  recentLogs: lifeTickRecentLogs,
  todayActionCount: lifeTickTodayActionCount,
  consecutiveFailureCount: lifeTickConsecutiveFailureCount,
  nextTickAt: lifeTickNextTickAt,
  currentStatus: lifeTickCurrentStatus,
} = storeToRefs(autonomousLifeStore)

const {
  enabled: diaryAutoWriteEnabled,
  dailyTime: diaryDailyTime,
  lastRunDate: diaryLastRunDate,
  lastRunAt: diaryLastRunAt,
  lastStatus: diaryLastStatus,
  nextTargetAt: diaryNextTargetAt,
  running: diarySchedulerRunning,
  writing: diaryWriting,
} = storeToRefs(diarySchedulerStore)

const {
  definitions: toolMeshDefinitions,
  toolUseLogs: toolMeshUseLogs,
  recentPlans: toolMeshRecentPlans,
  operatorPresentMode: toolMeshOperatorPresentMode,
  waitingForConfirmation: toolMeshWaitingForConfirmation,
  registeredLlmTool: toolMeshRegisteredLlmTool,
  lastInjectionSummary: toolMeshLastInjectionSummary,
} = storeToRefs(toolMeshStore)

const diaryDirectoryDraft = ref('')
const diaryDirectorySaved = ref('')
const diaryConfigLoading = ref(false)
const diaryRecentLoading = ref(false)
const diaryRecentEntries = ref<Array<{ date: string, path: string, mtimeMs?: number }>>([])
const selfProjectTitleDraft = ref('')
const selfProjectPurposeDraft = ref('')
const selfProjectMotivationDraft = ref('')
const selfProjectTargetPathDraft = ref('')
const selfTodoContentDraft = ref('')
const selfProgressNoteDraft = ref('')
const selfDeliverablePathsDraft = ref('')

const builtInPlugins = computed(() => [
  {
    id: 'lumi-proactive-vision',
    name: 'Lumi 主动视觉插件',
    enabled: proactiveVisionEnabled.value,
    loaded: true,
  },
  {
    id: 'lumi-chat-mini',
    name: 'Lumi 聊天浮窗插件',
    enabled: miniChatEnabled.value,
    loaded: true,
  },
  {
    id: 'lumi-self-adjustment',
    name: 'Lumi 自我调节插件',
    enabled: selfAdjustmentEnabled.value,
    loaded: selfAdjustmentLoaded.value,
  },
])

const proactiveVisionControlLabel = computed(() => proactiveVisionEnabled.value ? '停止主动视觉' : '启用主动视觉')
const proactiveVisionControlIcon = computed(() => proactiveVisionEnabled.value ? 'i-solar:stop-bold-duotone' : 'i-solar:play-bold-duotone')

const filteredPlugins = computed(() => {
  const query = filter.value.trim().toLowerCase()
  const plugins = pluginStore.discoveredPlugins.slice().sort((left, right) => left.name.localeCompare(right.name))
  if (!query)
    return plugins

  return plugins.filter(plugin =>
    plugin.name.toLowerCase().includes(query)
    || plugin.path.toLowerCase().includes(query),
  )
})

const sourceOptions = computed(() => sources.value.map(source => ({
  label: source.name,
  value: source.id,
})))

const proactiveRuntimeFresh = computed(() => {
  const updatedAt = Number(proactiveRuntimeStatus.value.updatedAt || 0)
  return updatedAt > 0 && Date.now() - updatedAt < 15 * 60 * 1000
})

const syncedProactiveRunning = computed(() => running.value || (proactiveRuntimeFresh.value && proactiveRuntimeStatus.value.running === true))
const syncedProactiveProcessing = computed(() => processing.value || (proactiveRuntimeFresh.value && proactiveRuntimeStatus.value.processing === true))
const syncedProactiveEnabled = computed(() => proactiveVisionEnabled.value || Boolean(proactiveRuntimeStatus.value.enabled))
const syncedLastScheduledDelayMs = computed(() => Number(proactiveRuntimeStatus.value.lastScheduledDelayMs || lastScheduledDelayMs.value || 0))

const summaryModeOptions = [
  { label: '正常判断', value: 'normal' },
  { label: '只总结不打扰', value: 'summarize_only' },
]

const discoveredCount = computed(() => pluginStore.discoveredPlugins.length + builtInPlugins.value.length)
const enabledCount = computed(() => pluginStore.enabledPlugins.length + builtInPlugins.value.filter(plugin => plugin.enabled).length)
const loadedCount = computed(() => pluginStore.loadedPlugins.length + builtInPlugins.value.filter(plugin => plugin.loaded).length)
const diaryPlugin = computed(() => pluginStore.discoveredPlugins.find(plugin => plugin.name === 'lumi-diary'))
const diaryPluginLoaded = computed(() => Boolean(diaryPlugin.value?.loaded))
const toolMeshImplementedCount = computed(() => toolMeshDefinitions.value.filter(tool => tool.status === 'implemented').length)
const toolMeshWritableCount = computed(() => toolMeshDefinitions.value.filter(tool => tool.canWrite).length)
const toolMeshExecutableCount = computed(() => toolMeshDefinitions.value.filter(tool => tool.canExecuteProcess).length)
const toolMeshHighRiskCount = computed(() => toolMeshDefinitions.value.filter(tool => tool.riskLevel === 'high' || tool.riskLevel === 'critical').length)
const toolMeshRecentVisibleLogs = computed(() => toolMeshUseLogs.value.slice(0, 8))
const toolMeshRecentVisiblePlans = computed(() => toolMeshRecentPlans.value.slice(0, 5))
const selfTodoActiveProgress = computed(() => selfTodoActiveProject.value
  ? selfTodoStore.getProjectProgress(selfTodoActiveProject.value.id)
  : null)
const selfTodoRecentProjects = computed(() => selfTodoProjects.value.slice(0, 6))
const lifeTickActiveProjectProgress = computed(() => selfTodoActiveProject.value
  ? selfTodoStore.getProjectProgress(selfTodoActiveProject.value.id)
  : null)
const autonomyDecisionStats = computed(() => {
  const empty = {
    interact_with_user: 0,
    observe_quietly: 0,
    continue_self_project: 0,
    generate_or_select_idea: 0,
    reflect: 0,
    rest: 0,
    request_permission: 0,
    permissionBlocked: 0,
    budgetBlocked: 0,
    failurePaused: 0,
    progressed: 0,
    external_silence_count: 0,
    life_tick_count: 0,
    idea_generation_count: 0,
    idea_selection_count: 0,
    project_continuation_count: 0,
    todo_progress_count: 0,
    private_thought_count: 0,
    runtime_log_count: 0,
    setting_change_count: 0,
    duplicate_setting_change_blocked: 0,
    manual_override_protected: 0,
    quiet_but_internally_active_count: 0,
  }
  for (const entry of decisionLog.value) {
    const mode = (entry as any).selectedMode || ((entry as any).selectedAction === 'say_message' ? 'interact_with_user' : 'observe_quietly')
    if (mode in empty)
      empty[mode as keyof typeof empty] += 1
    const result = String(entry.result || '')
    const reason = String(entry.reason || '').toLowerCase()
    if (mode === 'request_permission' || result.includes('blocked') || reason.includes('permission'))
      empty.permissionBlocked += 1
    if (reason.includes('budget') || result.includes('budget'))
      empty.budgetBlocked += 1
    if (result.includes('paused') || reason.includes('连续失败') || reason.includes('consecutive'))
      empty.failurePaused += 1
    if (result.includes('self_project') || result.includes('settings_changed') || result.includes('agent_success') || result.includes('private_note_written') || result.includes('ideas_generated'))
      empty.progressed += 1
    if ((entry as any).userInteractionSuppressed)
      empty.external_silence_count += 1
    if (result.includes('self_project') || result.includes('idea_pool') || result.includes('reflect'))
      empty.life_tick_count += 1
    if (result.includes('generate_ideas') || result.includes('ideas_generated'))
      empty.idea_generation_count += 1
    if (result.includes('idea_pool') || mode === 'generate_or_select_idea')
      empty.idea_selection_count += 1
    if (mode === 'continue_self_project')
      empty.project_continuation_count += 1
    if (result.includes('changed') || result.includes('self_project:'))
      empty.todo_progress_count += 1
    if (result.includes('private_note_written'))
      empty.private_thought_count += 1
    if (result.includes('runtime_log'))
      empty.runtime_log_count += 1
    if (result.includes('settings_changed'))
      empty.setting_change_count += 1
    if (result.includes('duplicate') || result.includes('cooldown_active') || result.includes('same_direction'))
      empty.duplicate_setting_change_blocked += 1
    if (result.includes('manual_override') || reason.includes('manual_override'))
      empty.manual_override_protected += 1
    if ((entry as any).userInteractionSuppressed && (entry as any).internalActionContinued)
      empty.quiet_but_internally_active_count += 1
  }
  empty.runtime_log_count += runtimeLogs.value.filter(log => log.kind === 'runtimeLog').length
  empty.private_thought_count += runtimeLogs.value.filter(log => log.kind === 'privateThought').length
  empty.setting_change_count += settingChangeAudit.value.filter(entry => entry.source === 'auto' && !entry.blockedReason).length
  empty.duplicate_setting_change_blocked += settingChangeAudit.value.filter(entry => Boolean(entry.blockedReason)).length
  empty.manual_override_protected += settingChangeAudit.value.filter(entry => entry.source === 'manual' || entry.blockedReason === 'manual_override_protected').length
  return empty
})
const autonomyExternalSilenceReason = computed(() => {
  const latest = decisionLog.value[0]
  if (!latest)
    return '还没有外部互动决策。'
  if (latest.selectedMode === 'interact_with_user')
    return `最近允许主动发言：${latest.reason}`
  if (latest.userInteractionSuppressed)
    return `没有对用户说话，因为选择了 ${latest.selectedMode}：${latest.reason}`
  return latest.reason || latest.result || '最近一次决策没有提供原因。'
})
const autonomyInternalNoProgressReason = computed(() => {
  const latestLife = lifeTickRecentLogs.value[0]
  if (latestLife)
    return `${latestLife.mode} / ${latestLife.result}: ${latestLife.reason}`
  const latest = decisionLog.value[0]
  if (!latest)
    return '还没有内部生活决策。'
  if (latest.internalActionContinued)
    return `内部行动已继续：${latest.selectedMode} / ${latest.result}`
  return `最近未推进内部生活：${latest.selectedMode} / ${latest.result || latest.reason}`
})
const latestManualOverrideUntil = computed(() => {
  const future = settingChangeAudit.value
    .map(entry => Number(entry.manualOverrideUntil || 0))
    .filter(value => value > Date.now())
    .sort((left, right) => right - left)[0]
  return future || null
})
const latestAutoCooldownUntil = computed(() => {
  const future = settingChangeAudit.value
    .map(entry => Number(entry.cooldownUntil || 0))
    .filter(value => value > Date.now())
    .sort((left, right) => right - left)[0]
  return future || null
})

function pluginStatus(plugin: PluginManifestSummary) {
  if (plugin.loaded)
    return '已加载'
  if (plugin.enabled)
    return '已启用'
  return '已禁用'
}

function formatSeconds(value: number) {
  return `${Math.round(value / 1000)} 秒`
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`
}

function formatMinutes(value: number) {
  return `${Math.round(value / 60000)} 分钟`
}

function formatTime(value: number | null) {
  return value ? new Date(value).toLocaleTimeString() : '暂无'
}

function formatDateTime(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString() : '暂无'
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' ? value as Record<string, any> : {}
}

async function runAction(label: string, action: () => Promise<unknown>) {
  try {
    await action()
    toast.success(label)
  }
  catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  }
}

async function refreshPlugins() {
  await runAction('插件列表已刷新。', () => pluginStore.refreshAll())
}

async function addPlugin() {
  await runAction('插件已添加。', () => pluginStore.addFromDirectory())
}

async function openPluginRoot() {
  await runAction('插件目录已打开。', () => pluginStore.openRoot())
}

async function loadEnabled() {
  await runAction('已加载启用的插件。', () => pluginStore.loadEnabled())
}

async function togglePluginEnabled(plugin: PluginManifestSummary) {
  await runAction(
    plugin.enabled ? `${plugin.name} 已禁用。` : `${plugin.name} 已启用。`,
    () => pluginStore.setEnabled({ name: plugin.name, enabled: !plugin.enabled, path: plugin.path }),
  )
}

async function toggleAutoReload(plugin: PluginManifestSummary) {
  await runAction(
    plugin.autoReload ? `${plugin.name} 已关闭热重载。` : `${plugin.name} 已开启热重载。`,
    () => pluginStore.setAutoReload({ name: plugin.name, enabled: !plugin.autoReload }),
  )
}

async function loadPlugin(plugin: PluginManifestSummary) {
  await runAction(`${plugin.name} 已加载。`, () => pluginStore.load({ name: plugin.name }))
}

async function unloadPlugin(plugin: PluginManifestSummary) {
  await runAction(`${plugin.name} 已卸载。`, () => pluginStore.unload({ name: plugin.name }))
}

async function removePlugin(plugin: PluginManifestSummary) {
  if (!confirm(`要从本地插件目录删除 "${plugin.name}" 吗？`))
    return

  await runAction(`${plugin.name} 已删除。`, () => pluginStore.remove({ name: plugin.name }))
}

async function refreshSources() {
  await runAction('屏幕来源已刷新。', () => proactiveVisionStore.refreshSources())
}

async function toggleProactiveVision() {
  if (proactiveVisionEnabled.value) {
    proactiveVisionStore.stop({ disable: true })
    toast.success('Lumi 主动视觉已禁用。')
    return
  }

  proactiveVisionEnabled.value = true
  toast.success('Lumi 主动视觉已启用，主聊天窗口会负责运行。')
}

async function testProactiveVision() {
  await runAction('主动视觉测试完成。', () => proactiveVisionStore.runTick({ force: true }))
}

async function runLifeTickNow() {
  await runAction('自主生命节拍已运行。', () => autonomousLifeStore.runLifeTick({ force: true }))
}

function toggleLifeTick() {
  lifeTickEnabled.value = !lifeTickEnabled.value
  if (lifeTickEnabled.value) {
    autonomousLifeStore.start()
    toast.success('Lumi 自主生命节拍已启用。')
    return
  }

  autonomousLifeStore.stop()
  toast.success('Lumi 自主生命节拍已停止。')
}

async function openLumiWorldDirectory() {
  const path = String(lumiWorldRoot.value || 'D:\\LumiSandbox\\LumiWorld').trim()
  await runAction('LumiWorld directory opened.', async () => {
    await openPath({ path })
  })
}

function createSelfProject() {
  const title = selfProjectTitleDraft.value.trim()
  if (!title) {
    toast.error('请先填写 Lumi 自己的项目标题。')
    return
  }

  selfTodoStore.createProject({
    title,
    purpose: selfProjectPurposeDraft.value,
    motivation: selfProjectMotivationDraft.value,
    targetPath: selfProjectTargetPathDraft.value || undefined,
    status: 'active',
    source: 'manual',
  })
  selfProjectTitleDraft.value = ''
  selfProjectPurposeDraft.value = ''
  selfProjectMotivationDraft.value = ''
  selfProjectTargetPathDraft.value = ''
  toast.success('Lumi 自己的项目已创建。')
}

function addSelfTodoToActiveProject() {
  const project = selfTodoActiveProject.value
  if (!project) {
    toast.error('当前没有 active 项目。')
    return
  }
  const content = selfTodoContentDraft.value.trim()
  if (!content) {
    toast.error('请先填写 Todo 内容。')
    return
  }

  selfTodoStore.addTodo(project.id, { content, source: 'manual' })
  selfTodoContentDraft.value = ''
  toast.success('Todo 已添加。')
}

function startSelfNextTodo() {
  const todo = selfTodoNextTodo.value
  if (!todo) {
    toast.error('当前没有可执行 Todo。')
    return
  }
  selfTodoStore.startTodo(todo.projectId, todo.id)
  toast.success('已开始下一项 Todo。')
}

function completeSelfTodo(todoId: string) {
  const project = selfTodoActiveProject.value
  if (!project)
    return
  selfTodoStore.completeTodo(project.id, todoId)
  toast.success('Todo 已完成。')
}

function addSelfProgressNote() {
  const project = selfTodoActiveProject.value
  if (!project) {
    toast.error('当前没有 active 项目。')
    return
  }
  const content = selfProgressNoteDraft.value.trim()
  if (!content) {
    toast.error('请先写进度记录。')
    return
  }
  selfTodoStore.addProgressNote(project.id, { content, source: 'manual' })
  selfProgressNoteDraft.value = ''
  toast.success('进度记录已保存。')
}

function completeSelfProject() {
  const project = selfTodoActiveProject.value
  if (!project) {
    toast.error('当前没有 active 项目。')
    return
  }
  const deliverablePaths = selfDeliverablePathsDraft.value
    .split(/\r?\n|;/)
    .map(path => path.trim())
    .filter(Boolean)
  const result = selfTodoStore.completeProject(project.id, {
    deliverablePaths,
    source: 'manual',
    reason: '用户在设置页手动完成项目。',
  })
  if (!result.completed) {
    toast.error(`还不能完成：${result.check.reason}`)
    return
  }
  selfDeliverablePathsDraft.value = ''
  toast.success('Lumi 自己的项目已完成。')
}

async function openMiniChat() {
  miniChatEnabled.value = true
  await runAction('Lumi 聊天浮窗已打开。', () => openMiniChatWindow())
}

async function invokeDiaryTool(name: string, input: unknown) {
  if (!diaryPluginLoaded.value)
    throw new Error('Lumi 日记插件还没有加载。请先在外部插件列表里启用并加载 lumi-diary。')

  return await pluginToolsStore.invokeTool({
    ownerPluginId: 'lumi-diary',
    name,
    input,
  })
}

async function refreshDiaryConfig() {
  diaryConfigLoading.value = true
  try {
    const result = asRecord(await invokeDiaryTool('lumi_diary_configure', {
      diaryDir: null,
      createIfMissing: null,
    }))
    const diaryDir = typeof result.diaryDir === 'string' ? result.diaryDir : ''
    diaryDirectorySaved.value = diaryDir
    diaryDirectoryDraft.value = diaryDir
  }
  finally {
    diaryConfigLoading.value = false
  }
}

async function saveDiaryConfig() {
  await runAction('Lumi 日记目录已保存。', async () => {
    const result = asRecord(await invokeDiaryTool('lumi_diary_configure', {
      diaryDir: diaryDirectoryDraft.value,
      createIfMissing: true,
    }))
    const diaryDir = typeof result.diaryDir === 'string' ? result.diaryDir : diaryDirectoryDraft.value
    diaryDirectorySaved.value = diaryDir
    diaryDirectoryDraft.value = diaryDir
  })
}

async function openDiaryDirectory() {
  await runAction('Lumi 日记目录已打开。', async () => {
    await invokeDiaryTool('lumi_diary_open_directory', {})
  })
}

async function refreshRecentDiaryEntries() {
  diaryRecentLoading.value = true
  try {
    const result = asRecord(await invokeDiaryTool('lumi_diary_list_recent', {
      limit: 7,
    }))
    diaryRecentEntries.value = Array.isArray(result.entries)
      ? result.entries
          .map(entry => asRecord(entry))
          .map(entry => ({
            date: String(entry.date ?? ''),
            path: String(entry.path ?? ''),
            mtimeMs: typeof entry.mtimeMs === 'number' ? entry.mtimeMs : undefined,
          }))
          .filter(entry => entry.date && entry.path)
      : []
  }
  finally {
    diaryRecentLoading.value = false
  }
}

async function writeDiaryNow() {
  await runAction('Lumi 已收到今日日记写入请求。', () => diarySchedulerStore.writeToday('manual'))
}

watch(miniChatEnabled, (enabled) => {
  if (enabled)
    void openMiniChatWindow().catch(error => console.warn('[plugins] failed to auto-open mini chat', error))
})

watch(diaryPluginLoaded, (loaded) => {
  if (!loaded)
    return
  void refreshDiaryConfig().catch(error => console.warn('[plugins] failed to refresh diary config', error))
  void refreshRecentDiaryEntries().catch(error => console.warn('[plugins] failed to refresh recent diary entries', error))
})

onMounted(async () => {
  proactiveVisionStore.requestLastCaptureImages()
  await pluginStore.refreshAll().catch(() => {})
  await proactiveVisionStore.refreshSources().catch(() => {})
  if (diaryPluginLoaded.value) {
    await refreshDiaryConfig().catch(() => {})
    await refreshRecentDiaryEntries().catch(() => {})
  }
})
</script>

<template>
  <div :class="['flex', 'flex-col', 'gap-4', 'pb-12']">
    <Callout
      v-if="!pluginStore.isAvailable"
      theme="orange"
      label="当前运行时不可管理外部插件"
      description="外部插件管理需要在 Stage Tamagotchi 桌面端中使用。内置插件仍可在本页配置。"
    />

    <Callout
      v-if="pluginStore.error"
      theme="orange"
      label="插件系统错误"
      :description="pluginStore.error"
    />

    <Section title="插件管理" icon="i-solar:plug-circle-bold-duotone" inner-class="gap-3">
      <div :class="['grid', 'gap-2', 'sm:grid-cols-4']">
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            已发现
          </div>
          <div :class="['text-2xl', 'font-semibold']">
            {{ discoveredCount }}
          </div>
        </div>
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            已启用
          </div>
          <div :class="['text-2xl', 'font-semibold']">
            {{ enabledCount }}
          </div>
        </div>
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            已加载
          </div>
          <div :class="['text-2xl', 'font-semibold']">
            {{ loadedCount }}
          </div>
        </div>
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            外部插件目录
          </div>
          <div :class="['truncate', 'text-xs', 'font-mono']">
            {{ pluginStore.registry?.root || '未知' }}
          </div>
        </div>
      </div>

      <div :class="['grid', 'gap-2']">
        <div
          v-for="plugin in builtInPlugins"
          :key="plugin.id"
          :class="['rounded-lg', 'border', 'border-primary-200/60', 'bg-primary-50/50', 'p-3', 'dark:border-primary-900/60', 'dark:bg-primary-950/20']"
        >
          <div :class="['flex', 'items-center', 'justify-between', 'gap-2']">
            <div>
              <div :class="['font-semibold']">
                {{ plugin.name }}
              </div>
              <div :class="['mt-1', 'text-xs', 'opacity-60']">
                内置插件
              </div>
            </div>
            <span :class="['rounded-full', 'bg-white/70', 'px-2', 'py-1', 'text-xs', 'dark:bg-neutral-900/70']">
              {{ plugin.enabled ? '已启用' : '已禁用' }} / 已加载
            </span>
          </div>
        </div>
      </div>

      <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
        <input
          v-model="filter"
          :class="['min-w-240px', 'rounded-lg', 'border', 'border-neutral-200', 'bg-white', 'px-3', 'py-2', 'text-sm', 'outline-none', 'dark:border-neutral-800', 'dark:bg-neutral-950']"
          placeholder="筛选外部插件..."
        >
        <Button label="添加插件" icon="i-solar:add-circle-bold-duotone" :loading="pluginStore.loading" @click="addPlugin" />
        <Button label="打开目录" icon="i-solar:folder-open-bold-duotone" variant="secondary" @click="openPluginRoot" />
        <Button label="刷新" icon="i-solar:refresh-bold-duotone" variant="secondary" :loading="pluginStore.loading" @click="refreshPlugins" />
        <Button label="加载已启用" icon="i-solar:play-bold-duotone" variant="secondary" :loading="pluginStore.loading" @click="loadEnabled" />
      </div>

      <div v-if="filteredPlugins.length === 0" :class="['rounded-lg', 'border', 'border-dashed', 'border-neutral-300', 'p-4', 'text-sm', 'opacity-70', 'dark:border-neutral-800']">
        还没有发现外部插件。可以添加一个包含 plugin.airi.json 的插件目录。
      </div>

      <div v-else :class="['grid', 'gap-3']">
        <div
          v-for="plugin in filteredPlugins"
          :key="plugin.path"
          :class="['rounded-lg', 'border', 'border-neutral-200', 'bg-white/70', 'p-3', 'dark:border-neutral-800', 'dark:bg-neutral-950/60']"
        >
          <div :class="['flex', 'flex-wrap', 'items-center', 'justify-between', 'gap-2']">
            <div :class="['min-w-0']">
              <div :class="['font-semibold']">
                {{ plugin.name }}
              </div>
              <div :class="['mt-1', 'break-all', 'text-xs', 'font-mono', 'opacity-60']">
                {{ plugin.path }}
              </div>
            </div>
            <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
              <span :class="['rounded-full', 'bg-neutral-100', 'px-2', 'py-1', 'text-xs', 'dark:bg-neutral-800']">{{ pluginStatus(plugin) }}</span>
              <Button size="sm" variant="secondary" :label="plugin.autoReload ? '关闭热重载' : '热重载'" icon="i-solar:refresh-circle-bold-duotone" @click="toggleAutoReload(plugin)" />
              <Button size="sm" variant="secondary" :label="plugin.enabled ? '禁用' : '启用'" icon="i-solar:power-bold-duotone" @click="togglePluginEnabled(plugin)" />
              <Button size="sm" variant="secondary" label="加载" icon="i-solar:play-bold-duotone" :disabled="plugin.loaded" @click="loadPlugin(plugin)" />
              <Button size="sm" variant="ghost" label="卸载" icon="i-solar:stop-bold-duotone" :disabled="!plugin.loaded" @click="unloadPlugin(plugin)" />
              <Button size="sm" variant="ghost" label="删除" icon="i-solar:trash-bin-trash-bold-duotone" @click="removePlugin(plugin)" />
            </div>
          </div>
          <div :class="['mt-2', 'text-xs', 'opacity-70']">
            入口：{{ JSON.stringify(plugin.entrypoints) }}
          </div>
        </div>
      </div>
    </Section>

    <Section title="Lumi 日记插件" icon="i-solar:notebook-bold-duotone" inner-class="gap-4">
      <Callout
        v-if="!diaryPlugin"
        theme="orange"
        label="还没有发现 lumi-diary 外置插件"
        description="请先在插件管理中添加 external-plugins/lumi-diary，然后启用并加载。"
      />
      <Callout
        v-else-if="!diaryPluginLoaded"
        theme="orange"
        label="日记插件尚未加载"
        description="启用并加载 lumi-diary 后，才能读取和修改日记配置。"
      />

      <div :class="['grid', 'gap-3', 'md:grid-cols-3']">
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            自动日记
          </div>
          <div :class="['text-lg', 'font-semibold']">
            {{ diaryAutoWriteEnabled ? (diarySchedulerRunning ? '运行中' : '已启用') : '已关闭' }}
          </div>
        </div>
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            下次检查
          </div>
          <div :class="['text-sm']">
            {{ formatDateTime(diaryNextTargetAt) }}
          </div>
        </div>
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            最近写入
          </div>
          <div :class="['text-sm']">
            {{ diaryLastRunDate || '暂无' }} / {{ formatDateTime(diaryLastRunAt) }}
          </div>
        </div>
      </div>

      <div :class="['grid', 'gap-4', 'lg:grid-cols-[1fr_220px]']">
        <label :class="['grid', 'gap-1']">
          <span :class="['text-sm', 'font-medium']">日记目录</span>
          <input
            v-model="diaryDirectoryDraft"
            :disabled="!diaryPluginLoaded || diaryConfigLoading"
            :class="['rounded-lg', 'border', 'border-neutral-200', 'bg-white', 'px-3', 'py-2', 'text-sm', 'outline-none', 'dark:border-neutral-800', 'dark:bg-neutral-950']"
            placeholder="例如 D:\LumiDiary"
          >
          <span :class="['text-xs', 'opacity-60']">当前保存：{{ diaryDirectorySaved || '尚未读取' }}</span>
        </label>
        <div :class="['flex', 'flex-wrap', 'items-end', 'gap-2']">
          <Button label="读取配置" icon="i-solar:refresh-bold-duotone" variant="secondary" :loading="diaryConfigLoading" :disabled="!diaryPluginLoaded" @click="refreshDiaryConfig" />
          <Button label="保存目录" icon="i-solar:diskette-bold-duotone" :loading="diaryConfigLoading" :disabled="!diaryPluginLoaded" @click="saveDiaryConfig" />
          <Button label="打开目录" icon="i-solar:folder-open-bold-duotone" variant="secondary" :disabled="!diaryPluginLoaded" @click="openDiaryDirectory" />
        </div>
      </div>

      <div :class="['grid', 'gap-4', 'lg:grid-cols-2']">
        <FieldCheckbox
          v-model="diaryAutoWriteEnabled"
          label="每天自动写日记"
          description="到达设定时间后，主聊天窗口会让 Lumi 结合今日聊天、印象和记忆强制写入一次日记。"
        />
        <label :class="['grid', 'gap-1']">
          <span :class="['text-sm', 'font-medium']">每日写入时间</span>
          <input
            v-model="diaryDailyTime"
            type="time"
            :class="['max-w-220px', 'rounded-lg', 'border', 'border-neutral-200', 'bg-white', 'px-3', 'py-2', 'text-sm', 'outline-none', 'dark:border-neutral-800', 'dark:bg-neutral-950']"
          >
        </label>
      </div>

      <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
        <Button label="立即写今日笔记" icon="i-solar:pen-new-round-bold-duotone" :loading="diaryWriting" :disabled="!diaryPluginLoaded" @click="writeDiaryNow" />
        <Button label="刷新最近日记" icon="i-solar:refresh-bold-duotone" variant="secondary" :loading="diaryRecentLoading" :disabled="!diaryPluginLoaded" @click="refreshRecentDiaryEntries" />
      </div>

      <div v-if="diaryLastStatus" :class="['rounded-lg', 'bg-emerald-50', 'p-3', 'text-xs', 'dark:bg-emerald-950/30']">
        {{ diaryLastStatus }}
      </div>

      <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
        <div :class="['mb-2', 'font-semibold']">
          最近日记
        </div>
        <div v-if="diaryRecentEntries.length === 0" :class="['text-sm', 'opacity-70']">
          还没有读取到日记文件。
        </div>
        <div v-else :class="['grid', 'gap-2']">
          <div
            v-for="entry in diaryRecentEntries"
            :key="entry.path"
            :class="['rounded-md', 'bg-white/70', 'p-2', 'text-xs', 'dark:bg-neutral-950/60']"
          >
            <div :class="['font-semibold']">
              {{ entry.date }}
            </div>
            <div :class="['break-all', 'font-mono', 'opacity-70']">
              {{ entry.path }}
            </div>
          </div>
        </div>
      </div>
    </Section>

    <Section title="Lumi 聊天浮窗插件" icon="i-solar:chat-round-like-bold-duotone" inner-class="gap-4">
      <FieldCheckbox
        v-model="miniChatEnabled"
        label="启用聊天浮窗"
        description="启用后会打开一个与普通聊天同步的小窗。"
      />
      <FieldCheckbox
        v-model="miniChatAlwaysOnTop"
        label="保持最前"
        description="浮窗打开后默认保持在其他窗口上方，也可以在浮窗标题栏切换。"
      />
      <FieldRange
        v-model="miniChatInactiveOpacity"
        label="未聚焦透明度"
        description="浮窗未被选中时的透明度。"
        :min="0.25"
        :max="1"
        :step="0.05"
        :format-value="formatPercent"
      />
      <FieldCheckbox
        v-model="miniChatEdgeDockEnabled"
        label="贴边自动收起"
        description="浮窗拖到接近屏幕边缘后，鼠标离开会像 PC QQ 一样收进边缘，鼠标移上去自动弹出。"
      />
      <div :class="['grid', 'gap-4', 'lg:grid-cols-2']">
        <FieldRange
          v-model="miniChatEdgeDockThreshold"
          label="贴边触发距离"
          description="只有窗口靠近屏幕边缘到这个距离内，才会触发收起。"
          :min="8"
          :max="80"
          :step="2"
          :format-value="value => `${Math.round(value)} px`"
        />
        <FieldRange
          v-model="miniChatEdgeDockVisibleSize"
          label="收起露出宽度"
          description="收起后保留在屏幕内的可触碰边缘宽度。"
          :min="10"
          :max="64"
          :step="2"
          :format-value="value => `${Math.round(value)} px`"
        />
      </div>
      <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
        <Button label="打开聊天浮窗" icon="i-solar:chat-round-like-bold-duotone" @click="openMiniChat" />
      </div>
    </Section>

    <Section title="Lumi 自我调节插件" icon="i-solar:tuning-2-bold-duotone" inner-class="gap-4">
      <Callout
        theme="orange"
        label="这是一个高权限但受限的内置插件"
        description="开启后，Lumi 可以通过聊天链路里的工具调用微调少量安全设置。她不能改 API Key、Provider、Base URL、插件目录、记忆数据库或删除数据。每次实际修改都会在聊天里出现系统提示。"
      />

      <div :class="['grid', 'gap-3', 'md:grid-cols-3']">
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            状态
          </div>
          <div :class="['text-lg', 'font-semibold']">
            {{ selfAdjustmentEnabled ? (selfAdjustmentLoaded ? '已启用 / 工具已注册' : '已启用 / 等待注册') : '已关闭' }}
          </div>
        </div>
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            最近修改
          </div>
          <div :class="['text-sm']">
            {{ formatDateTime(selfAdjustmentLastChangeAt) }}
          </div>
        </div>
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            已记录
          </div>
          <div :class="['text-lg', 'font-semibold']">
            {{ selfAdjustmentChangeLog.length }}
          </div>
        </div>
      </div>

      <FieldCheckbox
        v-model="selfAdjustmentEnabled"
        label="允许 Lumi 自我调节安全设置"
        description="关闭后，聊天链路不会暴露自我调节工具；如果你要求她调整，她只能提示你先打开这个插件。"
      />
      <FieldCheckbox
        v-model="allowProactiveVisionTiming"
        label="允许调节主动观察节奏"
        description="允许 Lumi 调整主动观察最短/最长间隔和主动发言冷却，用来减少打扰或提高陪伴感。"
      />
      <FieldCheckbox
        v-model="allowConsciousnessModelSwitch"
        label="允许切换当前意识模型"
        description="只允许在已经配置好的当前 Provider 内切换模型，不允许修改 Provider、API Key 或接口地址。"
      />
      <FieldCheckbox
        v-model="allowOllamaThinkingMode"
        label="允许调节 Ollama 思考模式"
        description="仅当意识 Provider 是 Ollama 时有效；OpenAI 兼容等 Provider 暂不伪造通用思考开关。"
      />

      <FieldCheckbox
        v-model="allowSpeechPlaybackVolume"
        label="允许调节发声播放音量"
        description="允许 Lumi 在 0%-150% 的安全范围内调节本地播放音量；不会修改声线、模型、API Key 或服务商配置。"
      />

      <FieldCheckbox
        v-model="allowPromptHistoryLimit"
        label="允许调节 Lumi 最近上下文条数"
        description="允许 Lumi 在 6-80 条范围内调整每轮发送给意识模型的最近主线消息数量；不会删除历史，也不会修改记忆数据库。"
      />

      <Callout
        v-if="selfAdjustmentLastError"
        theme="orange"
        label="自我调节错误"
        :description="selfAdjustmentLastError"
      />

      <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
        <div :class="['mb-2', 'font-semibold']">
          最近自调节记录
        </div>
        <div v-if="selfAdjustmentChangeLog.length === 0" :class="['text-sm', 'opacity-70']">
          还没有自调节记录。
        </div>
        <div v-else :class="['grid', 'gap-2']">
          <div
            v-for="entry in selfAdjustmentChangeLog.slice(0, 8)"
            :key="entry.id"
            :class="['rounded-md', 'bg-white/70', 'p-2', 'text-xs', 'dark:bg-neutral-950/60']"
          >
            <div :class="['mb-1', 'flex', 'flex-wrap', 'items-center', 'gap-2', 'font-semibold']">
              <span>{{ formatDateTime(entry.createdAt) }}</span>
              <span>{{ entry.action }}</span>
            </div>
            <div :class="['mb-1', 'opacity-80']">
              {{ entry.reason }}
            </div>
            <div v-for="change in entry.changes" :key="change" :class="['font-mono', 'opacity-70']">
              {{ change }}
            </div>
          </div>
        </div>
      </div>
    </Section>

    <Section title="Lumi Tool Mesh" icon="i-solar:widget-5-bold-duotone" inner-class="gap-4">
      <details :class="['rounded-lg', 'border', 'border-cyan-500/20', 'bg-cyan-50/60', 'p-4', 'dark:bg-cyan-950/20']">
        <summary :class="['cursor-pointer', 'select-none', 'font-semibold']">
          工具网格调试
        </summary>

        <div :class="['mt-4', 'grid', 'gap-4']">
          <div :class="['grid', 'gap-3', 'md:grid-cols-4']">
            <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
              <div :class="['text-xs', 'opacity-70']">已注册</div>
              <div :class="['text-2xl', 'font-semibold']">{{ toolMeshDefinitions.length }}</div>
              <div :class="['text-xs', 'opacity-60']">可执行 {{ toolMeshImplementedCount }}</div>
            </div>
            <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
              <div :class="['text-xs', 'opacity-70']">可写工具</div>
              <div :class="['text-2xl', 'font-semibold']">{{ toolMeshWritableCount }}</div>
              <div :class="['text-xs', 'opacity-60']">高风险 {{ toolMeshHighRiskCount }}</div>
            </div>
            <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
              <div :class="['text-xs', 'opacity-70']">进程工具</div>
              <div :class="['text-2xl', 'font-semibold']">{{ toolMeshExecutableCount }}</div>
              <div :class="['text-xs', 'opacity-60']">Claude / MCP / 沙箱</div>
            </div>
            <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
              <div :class="['text-xs', 'opacity-70']">聊天入口</div>
              <div :class="['text-lg', 'font-semibold']">{{ toolMeshRegisteredLlmTool ? '已注册' : '未注册' }}</div>
              <div :class="['text-xs', 'opacity-60']">{{ toolMeshWaitingForConfirmation ? '等待确认' : '空闲' }}</div>
            </div>
          </div>

          <div :class="['grid', 'gap-3', 'md:grid-cols-2']">
            <FieldCheckbox
              v-model="toolMeshOperatorPresentMode"
              label="Operator Present Mode"
              description="开启后，中风险工具可在本机有人值守时自动执行；高风险工具仍需确认。"
            />
            <div :class="['flex', 'items-center', 'gap-2']">
              <Button label="清空 Tool Mesh 日志" icon="i-solar:trash-bin-minimalistic-bold-duotone" variant="secondary" @click="toolMeshStore.resetLogs()" />
            </div>
          </div>

          <div v-if="toolMeshLastInjectionSummary" :class="['rounded-lg', 'bg-white/70', 'p-3', 'text-xs', 'dark:bg-neutral-950/50']">
            <div :class="['mb-1', 'font-semibold']">最近注入摘要</div>
            <pre :class="['max-h-32', 'overflow-auto', 'whitespace-pre-wrap']">{{ toolMeshLastInjectionSummary }}</pre>
          </div>

          <div :class="['grid', 'gap-3', 'lg:grid-cols-2']">
            <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
              <div :class="['mb-2', 'font-semibold']">最近工具调用</div>
              <div v-if="toolMeshRecentVisibleLogs.length === 0" :class="['text-sm', 'opacity-70']">
                还没有工具调用日志。
              </div>
              <div v-else :class="['grid', 'gap-2']">
                <div
                  v-for="entry in toolMeshRecentVisibleLogs"
                  :key="entry.id"
                  :class="['rounded-md', 'border', 'border-cyan-500/10', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']"
                >
                  <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2', 'font-semibold']">
                    <span>{{ entry.toolId }}</span>
                    <span>{{ entry.status }}</span>
                    <span>{{ formatDateTime(Date.parse(entry.createdAt)) }}</span>
                  </div>
                  <div v-if="entry.error" :class="['mt-1', 'text-red-400']">{{ entry.error }}</div>
                </div>
              </div>
            </div>

            <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
              <div :class="['mb-2', 'font-semibold']">最近工具计划</div>
              <div v-if="toolMeshRecentVisiblePlans.length === 0" :class="['text-sm', 'opacity-70']">
                还没有工具计划。
              </div>
              <div v-else :class="['grid', 'gap-2']">
                <div
                  v-for="plan in toolMeshRecentVisiblePlans"
                  :key="plan.id"
                  :class="['rounded-md', 'border', 'border-cyan-500/10', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']"
                >
                  <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2', 'font-semibold']">
                    <span>{{ plan.goal }}</span>
                    <span>{{ plan.status }}</span>
                  </div>
                  <div :class="['mt-1', 'opacity-70']">
                    {{ plan.steps.length }} steps · {{ formatDateTime(Date.parse(plan.createdAt)) }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </details>
    </Section>

    <Section title="Lumi 主动视觉插件" icon="i-solar:eye-bold-duotone" inner-class="gap-4">
      <Callout
        v-if="!configured"
        theme="orange"
        label="需要先配置视觉模型和意识模型"
        description="视觉模块负责看屏幕，意识模块负责判断 Lumi 是否应该主动开口。"
      />

      <div :class="['grid', 'gap-3', 'md:grid-cols-3']">
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            状态
          </div>
          <div :class="['text-lg', 'font-semibold']">
            {{ syncedProactiveProcessing ? '观察中' : (syncedProactiveRunning ? '运行中' : (syncedProactiveEnabled ? '已启用，等待调度' : '已停止')) }}
          </div>
        </div>
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            次数
          </div>
          <div :class="['text-lg', 'font-semibold']">
            {{ tickCount }} / 跳过 {{ skippedCount }}
          </div>
        </div>
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            最近
          </div>
          <div :class="['text-sm']">
            捕获 {{ formatTime(lastCaptureAt) }} / 发言 {{ formatTime(lastMessageAt) }}
          </div>
          <div v-if="syncedProactiveRunning && syncedLastScheduledDelayMs" :class="['mt-1', 'text-xs', 'opacity-70']">
            下次观察采用随机间隔：{{ formatSeconds(syncedLastScheduledDelayMs) }}
          </div>
        </div>
      </div>

      <div :class="['grid', 'gap-3', 'md:grid-cols-3']">
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            当前活动
          </div>
          <div :class="['text-lg', 'font-semibold']">
            {{ currentActivity }}
          </div>
        </div>
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            重要性
          </div>
          <div :class="['text-lg', 'font-semibold']">
            {{ lastSalience }}
          </div>
        </div>
        <div :class="['rounded-lg', 'bg-neutral-100', 'p-3', 'dark:bg-neutral-900/70']">
          <div :class="['text-xs', 'uppercase', 'opacity-60']">
            最近决策
          </div>
          <div v-if="lastDecision" :class="['text-sm']">
            <div :class="['font-semibold']">
              {{ lastDecision.action }} · {{ lastDecision.result || lastDecision.riskLevel }}
            </div>
            <div :class="['text-xs', 'opacity-70']">
              置信度 {{ Math.round((lastDecision.confidence || 0) * 100) }}% · {{ lastDecision.reason || '无原因' }}
            </div>
          </div>
          <div v-else :class="['text-sm', 'font-semibold']">
            暂无
          </div>
          <div v-if="captureFailureCount" :class="['mt-1', 'text-xs', 'text-orange-500']">
            采集失败 {{ captureFailureCount }} 次，主动视觉会自动停止防止刷屏。
          </div>
        </div>
      </div>

      <div :class="['grid', 'gap-4', 'lg:grid-cols-2']">
        <FieldCombobox
          v-model="sourceId"
          label="屏幕来源"
          description="选择 Lumi 主动观察的窗口或屏幕。"
          :options="sourceOptions"
          placeholder="选择屏幕或窗口..."
        />
        <FieldCombobox
          v-model="workloadId"
          label="识别任务"
          description="复用 AIRI 原版 screen vision workload。"
          :options="workloadOptions"
        />
      </div>

      <div :class="['grid', 'gap-4', 'lg:grid-cols-2']">
        <FieldRange
          v-model="minIntervalMs"
          label="最短观察间隔"
          description="Lumi 主动看屏幕前至少等待多久。"
          :min="30000"
          :max="900000"
          :step="30000"
          :format-value="formatSeconds"
        />
        <FieldRange
          v-model="maxIntervalMs"
          label="最长观察间隔"
          description="Lumi 会在最短和最长间隔之间随机选择下一次观察时间。"
          :min="30000"
          :max="1800000"
          :step="30000"
          :format-value="formatSeconds"
        />
      </div>

      <div :class="['grid', 'gap-4', 'lg:grid-cols-2']">
        <FieldRange
          v-model="cooldownMs"
          label="主动发言冷却"
          description="避免 Lumi 太频繁主动打断。"
          :min="30000"
          :max="900000"
          :step="30000"
          :format-value="formatSeconds"
        />
      </div>

      <FieldCheckbox
        v-model="publishOnlyWhenLumiActive"
        label="仅在当前角色是 Lumi 时运行"
        description="防止其他角色卡触发 Lumi 的主动消息。"
      />

      <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
        <Button :label="proactiveVisionControlLabel" :icon="proactiveVisionControlIcon" :loading="processing" :disabled="!configured" @click="toggleProactiveVision" />
        <Button label="测试一次" icon="i-solar:eye-scan-bold-duotone" variant="secondary" :loading="processing" :disabled="!configured" @click="testProactiveVision" />
        <Button label="刷新屏幕来源" icon="i-solar:refresh-bold-duotone" variant="secondary" :loading="isRefetching" @click="refreshSources" />
      </div>

      <details :class="['rounded-lg', 'border', 'border-cyan-500/20', 'bg-cyan-50/60', 'p-4', 'dark:bg-cyan-950/20']">
        <summary :class="['cursor-pointer', 'select-none', 'font-semibold']">
          自主行动
        </summary>

        <div :class="['mt-4', 'grid', 'gap-4']">
          <div :class="['grid', 'gap-3', 'md:grid-cols-2']">
            <FieldCheckbox
              v-model="autonomousEnabled"
              label="启用自主决策"
              description="观察屏幕后先判断是否行动，而不是每次都主动发言。"
            />
            <FieldCheckbox
              v-model="quietMode"
              label="安静模式"
              description="低价值观察只记录，不打扰；重要内容仍可提醒。"
            />
            <FieldCheckbox
              v-model="allowAutonomousSandboxTasks"
              label="允许 LumiWorld 自主创建"
              description="允许 Lumi 在自己的 LumiWorld 空间内创建低风险文件、草稿、实验和小项目。"
            />
          </div>

          <FieldInput
            v-model="lumiWorldRoot"
            label="LumiWorld 根目录"
            description="Lumi 自己的空间。自主创建会被限制在这个目录内，默认是 D:\LumiSandbox\LumiWorld。"
            placeholder="D:\LumiSandbox\LumiWorld"
          />

          <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
            <Button label="打开 LumiWorld" icon="i-solar:folder-open-bold-duotone" variant="secondary" @click="openLumiWorldDirectory" />
            <span :class="['text-xs', 'opacity-60']">导出可在目录打开后手动复制；删除整个 LumiWorld 请先关闭自主创建后在文件管理器中确认。</span>
          </div>

          <details :class="['rounded-lg', 'border', 'border-cyan-500/20', 'bg-cyan-950/5', 'p-3', 'text-sm', 'dark:bg-cyan-50/5']">
            <summary :class="['cursor-pointer', 'font-semibold']">
              Lumi 自主生命节拍
            </summary>

            <div :class="['mt-3', 'grid', 'gap-3']">
              <div :class="['grid', 'gap-3', 'md:grid-cols-2']">
                <FieldCheckbox
                  v-model="lifeTickEnabled"
                  label="启用自主生命节拍"
                  description="让 Lumi 在空闲时延续自己的项目、想法和反思。"
                />
                <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
                  <div :class="['text-xs', 'opacity-70']">
                    当前状态
                  </div>
                  <div :class="['text-lg', 'font-semibold']">
                    {{ lifeTickCurrentStatus }}
                  </div>
                  <div :class="['mt-1', 'text-xs', 'opacity-70']">
                    {{ lifeTickRunning ? '运行中' : '未运行' }} · 下一次 {{ formatDateTime(lifeTickNextTickAt ? Date.parse(lifeTickNextTickAt) : null) }}
                  </div>
                </div>
              </div>

              <div :class="['grid', 'gap-3', 'md:grid-cols-3']">
                <FieldRange
                  v-model="lifeTickMinIntervalMs"
                  label="自主生命节拍最短间隔"
                  description="默认 30 分钟。"
                  :min="600000"
                  :max="7200000"
                  :step="300000"
                  :format-value="formatMinutes"
                />
                <FieldRange
                  v-model="lifeTickMaxIntervalMs"
                  label="自主生命节拍最长间隔"
                  description="默认 60 分钟。"
                  :min="600000"
                  :max="10800000"
                  :step="300000"
                  :format-value="formatMinutes"
                />
                <FieldRange
                  v-model="lifeTickDailyActionBudget"
                  label="今日自主行动预算"
                  description="控制 Lumi 每天最多推进多少个小步骤。"
                  :min="0"
                  :max="24"
                  :step="1"
                  :format-value="value => `${Math.round(value)} 次`"
                />
              </div>

              <div :class="['flex', 'flex-wrap', 'items-center', 'gap-2']">
                <Button
                  :label="lifeTickEnabled ? '停止自主生命节拍' : '启用自主生命节拍'"
                  :icon="lifeTickEnabled ? 'i-solar:stop-bold-duotone' : 'i-solar:play-bold-duotone'"
                  variant="secondary"
                  @click="toggleLifeTick"
                />
                <Button
                  label="立即运行一次"
                  icon="i-solar:bolt-circle-bold-duotone"
                  :loading="lifeTickProcessing"
                  @click="runLifeTickNow"
                />
                <span :class="['text-xs', 'opacity-60']">自主生命节拍只推进一个可验证小步骤，不会把整个循环交给 Claude Code。</span>
              </div>

              <Callout
                v-if="lifeTickLastError"
                theme="orange"
                label="自主生命节拍错误"
                :description="lifeTickLastError"
              />

              <div :class="['grid', 'gap-3', 'md:grid-cols-4']">
                <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
                  <div :class="['text-xs', 'opacity-70']">今日行动</div>
                  <div :class="['text-2xl', 'font-semibold']">{{ lifeTickTodayActionCount }}</div>
                </div>
                <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
                  <div :class="['text-xs', 'opacity-70']">连续失败</div>
                  <div :class="['text-2xl', 'font-semibold']">{{ lifeTickConsecutiveFailureCount }}</div>
                </div>
                <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
                  <div :class="['text-xs', 'opacity-70']">想法池</div>
                  <div :class="['text-2xl', 'font-semibold']">{{ lifeTickIdeas.length }}</div>
                </div>
                <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
                  <div :class="['text-xs', 'opacity-70']">反思</div>
                  <div :class="['text-2xl', 'font-semibold']">{{ lifeTickReflections.length }}</div>
                </div>
              </div>

              <div v-if="lifeTickLastDecision" :class="['rounded-lg', 'bg-cyan-950/5', 'p-3', 'dark:bg-cyan-50/5']">
                <div :class="['mb-1', 'font-semibold']">
                  最近 Life 决策：{{ lifeTickLastDecision.mode }}
                </div>
                <div :class="['text-xs', 'opacity-75']">
                  {{ lifeTickLastDecision.reason }} · 风险 {{ lifeTickLastDecision.riskLevel }} · 置信度 {{ formatPercent(lifeTickLastDecision.confidence) }}
                </div>
              </div>

              <div v-if="lifeTickRestState" :class="['rounded-lg', 'bg-amber-500/10', 'p-3', 'text-sm']">
                <div :class="['font-semibold']">
                  Lumi 正在休息
                </div>
                <div :class="['mt-1', 'opacity-75']">
                  {{ lifeTickRestState.reason }} · 重新考虑 {{ formatDateTime(Date.parse(lifeTickRestState.reconsiderAt)) }}
                </div>
              </div>

              <div :class="['grid', 'gap-3', 'lg:grid-cols-2']">
                <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
                  <div :class="['mb-2', 'font-semibold']">
                    当前项目 / Todo
                  </div>
                  <div v-if="selfTodoActiveProject" :class="['text-sm']">
                    <div :class="['font-semibold']">
                      {{ selfTodoActiveProject.title }}
                    </div>
                    <div :class="['mt-1', 'opacity-75']">
                      下一步：{{ selfTodoNextTodo?.content || '暂无可执行 Todo' }}
                    </div>
                    <div :class="['mt-1', 'text-xs', 'opacity-70']">
                      进度 {{ lifeTickActiveProjectProgress?.done ?? 0 }}/{{ lifeTickActiveProjectProgress?.total ?? 0 }} · LumiWorld {{ lifeTickLumiWorldRoot || lumiWorldRoot }}
                    </div>
                  </div>
                  <div v-else :class="['text-xs', 'opacity-70']">
                    当前没有 active 项目。自主生命节拍会先查看想法池。
                  </div>
                </div>

                <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
                  <div :class="['mb-2', 'font-semibold']">
                    最近 Life 日志
                  </div>
                  <div v-if="lifeTickRecentLogs.length === 0" :class="['text-xs', 'opacity-70']">
                    还没有自主生命节拍日志。
                  </div>
                  <div v-else :class="['max-h-180px', 'overflow-auto', 'space-y-2']">
                    <div
                      v-for="entry in lifeTickRecentLogs.slice(0, 8)"
                      :key="entry.id"
                      :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']"
                    >
                      <div :class="['font-semibold']">
                        {{ entry.mode }} · {{ entry.result }}
                      </div>
                      <div :class="['opacity-70']">
                        {{ formatDateTime(Date.parse(entry.createdAt)) }} · {{ entry.reason }}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div :class="['grid', 'gap-3', 'lg:grid-cols-2']">
                <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
                  <div :class="['mb-2', 'font-semibold']">
                    想法池
                  </div>
                  <div v-if="lifeTickIdeas.length === 0" :class="['text-xs', 'opacity-70']">
                    还没有候选想法。自主生命节拍可以在没有项目时生成少量候选。
                  </div>
                  <div v-else :class="['max-h-220px', 'overflow-auto', 'space-y-2']">
                    <div
                      v-for="idea in lifeTickIdeas.slice(0, 10)"
                      :key="idea.id"
                      :class="['rounded-md', 'bg-emerald-950/5', 'p-2', 'text-xs', 'dark:bg-emerald-50/5']"
                    >
                      <div :class="['flex', 'items-center', 'justify-between', 'gap-2']">
                        <span :class="['font-semibold']">{{ idea.title }}</span>
                        <span>{{ idea.status }}</span>
                      </div>
                      <div :class="['mt-1', 'opacity-75']">
                        {{ idea.description }}
                      </div>
                      <div :class="['mt-1', 'opacity-60']">
                        兴趣 {{ formatPercent(idea.interestScore) }} · 连续性 {{ formatPercent(idea.continuityScore) }} · 可行性 {{ formatPercent(idea.feasibilityScore) }}
                      </div>
                    </div>
                  </div>
                </div>

                <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
                  <div :class="['mb-2', 'font-semibold']">
                    最近项目反思
                  </div>
                  <div v-if="lifeTickReflections.length === 0" :class="['text-xs', 'opacity-70']">
                    还没有项目反思。
                  </div>
                  <div v-else :class="['max-h-220px', 'overflow-auto', 'space-y-2']">
                    <div
                      v-for="reflection in lifeTickReflections.slice(0, 6)"
                      :key="reflection.id"
                      :class="['rounded-md', 'bg-violet-950/5', 'p-2', 'text-xs', 'dark:bg-violet-50/5']"
                    >
                      <div :class="['font-semibold']">
                        {{ formatDateTime(Date.parse(reflection.createdAt)) }} · 继续兴趣 {{ formatPercent(reflection.continueInterestScore) }}
                      </div>
                      <div :class="['mt-1', 'whitespace-pre-wrap', 'opacity-75']">
                        {{ reflection.summary }}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </details>

          <details open :class="['rounded-lg', 'border', 'border-cyan-500/20', 'bg-cyan-950/5', 'p-3', 'text-sm', 'dark:bg-cyan-50/5']">
            <summary :class="['cursor-pointer', 'font-semibold']">
              Lumi 自己的 Todo
            </summary>

            <div :class="['mt-3', 'grid', 'gap-3']">
              <div
                v-if="selfTodoActiveProject"
                :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']"
              >
                <div :class="['mb-2', 'flex', 'flex-wrap', 'items-center', 'justify-between', 'gap-2']">
                  <div>
                    <div :class="['text-base', 'font-semibold']">
                      {{ selfTodoActiveProject.title }}
                    </div>
                    <div :class="['text-xs', 'opacity-70']">
                      active · priority {{ selfTodoActiveProject.priority }} · 最近推进 {{ formatDateTime(Date.parse(selfTodoActiveProject.updatedAt)) }}
                    </div>
                  </div>
                  <div :class="['flex', 'flex-wrap', 'gap-2']">
                    <Button label="暂停" variant="secondary" @click="selfTodoStore.pauseProject(selfTodoActiveProject.id, '用户在设置页暂停。')" />
                    <Button label="放弃" variant="secondary" @click="selfTodoStore.abandonProject(selfTodoActiveProject.id, '用户在设置页放弃。')" />
                    <Button label="删除" variant="secondary" @click="selfTodoStore.deleteProject(selfTodoActiveProject.id)" />
                  </div>
                </div>

                <div :class="['grid', 'gap-2', 'md:grid-cols-2']">
                  <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'dark:bg-cyan-50/5']">
                    <div :class="['text-xs', 'opacity-70']">
                      项目目的
                    </div>
                    <div>{{ selfTodoActiveProject.purpose || '未填写' }}</div>
                  </div>
                  <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'dark:bg-cyan-50/5']">
                    <div :class="['text-xs', 'opacity-70']">
                      项目动机
                    </div>
                    <div>{{ selfTodoActiveProject.motivation || '未填写' }}</div>
                  </div>
                </div>

                <div :class="['mt-3', 'grid', 'gap-2', 'md:grid-cols-4']">
                  <div :class="['rounded-md', 'bg-white/80', 'p-2', 'dark:bg-neutral-900/70']">
                    <div :class="['text-xs', 'opacity-70']">
                      进度
                    </div>
                    <div :class="['font-semibold']">
                      {{ selfTodoActiveProgress ? `${selfTodoActiveProgress.done}/${selfTodoActiveProgress.total}` : '0/0' }}
                    </div>
                  </div>
                  <div :class="['rounded-md', 'bg-white/80', 'p-2', 'dark:bg-neutral-900/70']">
                    <div :class="['text-xs', 'opacity-70']">
                      Blocked
                    </div>
                    <div :class="['font-semibold']">
                      {{ selfTodoActiveProgress?.blocked ?? 0 }}
                    </div>
                  </div>
                  <div :class="['rounded-md', 'bg-white/80', 'p-2', 'dark:bg-neutral-900/70']">
                    <div :class="['text-xs', 'opacity-70']">
                      下一项
                    </div>
                    <div :class="['font-semibold']">
                      {{ selfTodoNextTodo?.content || '暂无可执行 Todo' }}
                    </div>
                  </div>
                  <div :class="['rounded-md', 'bg-white/80', 'p-2', 'dark:bg-neutral-900/70']">
                    <div :class="['text-xs', 'opacity-70']">
                      成果路径
                    </div>
                    <div :class="['truncate', 'font-semibold']">
                      {{ selfTodoActiveProject.targetPath || '未声明' }}
                    </div>
                  </div>
                </div>

                <div :class="['mt-3', 'grid', 'gap-2']">
                  <div
                    v-for="todo in selfTodoActiveProject.todos"
                    :key="todo.id"
                    :class="['rounded-md', 'bg-white/80', 'p-2', 'dark:bg-neutral-900/70']"
                  >
                    <div :class="['flex', 'flex-wrap', 'items-center', 'justify-between', 'gap-2']">
                      <div>
                        <span :class="['font-semibold']">{{ todo.content }}</span>
                        <span :class="['ml-2', 'rounded-full', 'bg-cyan-500/10', 'px-2', 'py-0.5', 'text-xs']">{{ todo.status }}</span>
                      </div>
                      <div :class="['flex', 'gap-2']">
                        <Button
                          v-if="todo.status === 'pending'"
                          label="开始"
                          variant="secondary"
                          @click="selfTodoStore.startTodo(selfTodoActiveProject.id, todo.id)"
                        />
                        <Button
                          v-if="todo.status === 'pending' || todo.status === 'doing'"
                          label="完成"
                          variant="secondary"
                          @click="completeSelfTodo(todo.id)"
                        />
                      </div>
                    </div>
                    <div v-if="todo.blockedReason" :class="['mt-1', 'text-xs', 'text-orange-500']">
                      blocked: {{ todo.blockedReason }}
                    </div>
                  </div>
                </div>

                <div :class="['mt-3', 'grid', 'gap-2', 'md:grid-cols-[1fr_auto]']">
                  <FieldInput v-model="selfTodoContentDraft" label="添加 Todo" placeholder="写下 Lumi 下一步要做什么..." />
                  <Button label="添加" icon="i-solar:add-circle-bold-duotone" @click="addSelfTodoToActiveProject" />
                </div>

                <div :class="['mt-3', 'grid', 'gap-2', 'md:grid-cols-[1fr_auto]']">
                  <FieldInput v-model="selfProgressNoteDraft" label="进度记录" placeholder="记录 Lumi 做到了哪里、卡在哪里..." />
                  <Button label="保存记录" icon="i-solar:notes-bold-duotone" variant="secondary" @click="addSelfProgressNote" />
                </div>

                <div :class="['mt-3', 'grid', 'gap-2', 'md:grid-cols-[1fr_auto_auto]']">
                  <FieldInput
                    v-model="selfDeliverablePathsDraft"
                    label="完成校验成果路径"
                    placeholder="一行或分号分隔，例如 D:\LumiSandbox\LumiWorld\room\index.html"
                  />
                  <Button label="开始下一项" icon="i-solar:play-bold-duotone" variant="secondary" @click="startSelfNextTodo" />
                  <Button label="完成项目" icon="i-solar:check-circle-bold-duotone" @click="completeSelfProject" />
                </div>

                <details :class="['mt-3']">
                  <summary :class="['cursor-pointer', 'text-xs', 'opacity-80']">
                    查看进度记录
                  </summary>
                  <div :class="['mt-2', 'max-h-180px', 'overflow-auto', 'space-y-2']">
                    <div
                      v-for="note in selfTodoActiveProject.progressNotes.slice().reverse()"
                      :key="note.id"
                      :class="['rounded-md', 'bg-emerald-950/5', 'p-2', 'text-xs', 'dark:bg-emerald-50/5']"
                    >
                      <div :class="['opacity-70']">
                        {{ formatDateTime(Date.parse(note.createdAt)) }} · {{ note.source }}
                      </div>
                      <div :class="['whitespace-pre-wrap']">
                        {{ note.content }}
                      </div>
                    </div>
                  </div>
                </details>
              </div>

              <div v-else :class="['rounded-lg', 'bg-white/70', 'p-3', 'text-sm', 'dark:bg-neutral-950/50']">
                当前没有 active 项目。Lumi 可以先计划，但本阶段不会自动生成新想法。
              </div>

              <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
                <div :class="['mb-2', 'font-semibold']">
                  手动创建 Lumi 自己的项目
                </div>
                <div :class="['grid', 'gap-2', 'md:grid-cols-2']">
                  <FieldInput v-model="selfProjectTitleDraft" label="标题" placeholder="例如：制作 Lumi 自己的小房间页面" />
                  <FieldInput v-model="selfProjectTargetPathDraft" label="目标路径（可选）" placeholder="例如 room/index.html" />
                  <FieldInput v-model="selfProjectPurposeDraft" label="目的" placeholder="这个项目想表达或解决什么..." />
                  <FieldInput v-model="selfProjectMotivationDraft" label="动机" placeholder="Lumi 为什么想做这件事..." />
                </div>
                <div :class="['mt-3']">
                  <Button label="创建为 active 项目" icon="i-solar:add-circle-bold-duotone" @click="createSelfProject" />
                </div>
              </div>

              <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'dark:bg-neutral-950/50']">
                <div :class="['mb-2', 'font-semibold']">
                  最近项目
                </div>
                <div v-if="selfTodoRecentProjects.length === 0" :class="['text-xs', 'opacity-70']">
                  还没有 Lumi 自己的项目。
                </div>
                <div v-else :class="['grid', 'gap-2']">
                  <div
                    v-for="project in selfTodoRecentProjects"
                    :key="project.id"
                    :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']"
                  >
                    <div :class="['flex', 'flex-wrap', 'items-center', 'justify-between', 'gap-2']">
                      <div>
                        <span :class="['font-semibold']">{{ project.title }}</span>
                        <span :class="['ml-2', 'opacity-70']">{{ project.status }}</span>
                      </div>
                      <Button
                        v-if="project.status === 'paused' || project.status === 'planned'"
                        label="恢复"
                        variant="secondary"
                        @click="selfTodoStore.resumeProject(project.id)"
                      />
                    </div>
                    <div :class="['mt-1', 'opacity-70']">
                      {{ project.purpose || project.motivation || project.id }}
                    </div>
                    <div v-if="project.pausedReason || project.abandonedReason" :class="['mt-1', 'text-orange-500']">
                      {{ project.pausedReason || project.abandonedReason }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </details>

          <div :class="['grid', 'gap-3', 'md:grid-cols-2']">
            <FieldSelect
              v-model="summaryMode"
              label="观察摘要模式"
              description="summary_only 会更偏向私密记录和总结。"
              :options="summaryModeOptions"
            />
            <FieldRange
              v-model="idleDailyMaxMessages"
              label="空闲每日最多主动发言"
              description="超过后 Lumi 会优先沉默、记录或总结。"
              :min="0"
              :max="12"
              :step="1"
              :format-value="value => `${Math.round(value)} 次`"
            />
            <FieldRange
              v-model="observationNoEffectThreshold"
              label="观察无效阈值"
              description="连续低变化或无人回应达到阈值后，会自动降低打扰频率。"
              :min="1"
              :max="8"
              :step="1"
              :format-value="value => `${Math.round(value)} 次`"
            />
            <FieldRange
              v-model="agentSuggestionCooldownMs"
              label="Agent 建议冷却"
              description="避免 Lumi 频繁建议或准备沙箱任务。"
              :min="300000"
              :max="7200000"
              :step="300000"
              :format-value="formatSeconds"
            />
          </div>

          <div :class="['grid', 'gap-3', 'md:grid-cols-4']">
            <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'text-sm', 'dark:bg-neutral-950/50']">
              <div :class="['opacity-70']">今日主动发言</div>
              <div :class="['text-2xl', 'font-semibold']">{{ todayProactiveMessageCount }}</div>
            </div>
            <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'text-sm', 'dark:bg-neutral-950/50']">
              <div :class="['opacity-70']">未回应次数</div>
              <div :class="['text-2xl', 'font-semibold']">{{ ignoredProactiveStreak }}</div>
            </div>
            <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'text-sm', 'dark:bg-neutral-950/50']">
              <div :class="['opacity-70']">低变化次数</div>
              <div :class="['text-2xl', 'font-semibold']">{{ lowChangeStreak }}</div>
            </div>
            <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'text-sm', 'dark:bg-neutral-950/50']">
              <div :class="['opacity-70']">无推进次数</div>
              <div :class="['text-2xl', 'font-semibold']">{{ noProgressStreak }}</div>
            </div>
          </div>

          <div :class="['grid', 'gap-3', 'lg:grid-cols-2']">
            <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'text-sm', 'dark:bg-neutral-950/50']">
              <div :class="['mb-2', 'font-semibold']">最近决策日志</div>
              <div :class="['mb-3', 'grid', 'gap-2', 'md:grid-cols-2']">
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  <div :class="['font-semibold']">
                    为什么没有对用户说话
                  </div>
                  <div :class="['mt-1', 'opacity-75']">
                    {{ autonomyExternalSilenceReason }}
                  </div>
                </div>
                <div :class="['rounded-md', 'bg-emerald-950/5', 'p-2', 'text-xs', 'dark:bg-emerald-50/5']">
                  <div :class="['font-semibold']">
                    为什么没有推进自己的生活
                  </div>
                  <div :class="['mt-1', 'opacity-75']">
                    {{ autonomyInternalNoProgressReason }}
                  </div>
                </div>
              </div>
              <div :class="['mb-3', 'grid', 'gap-2', 'md:grid-cols-2']">
                <div :class="['rounded-md', 'bg-white/70', 'p-2', 'text-xs', 'dark:bg-neutral-950/50']">
                  外部互动状态：{{ quietMode ? '安静模式' : '允许主动发言' }} · {{ summaryMode }}
                  <div :class="['opacity-70']">
                    消息冷却 {{ formatSeconds(cooldownMs) }} · 调参冷却 {{ formatDateTime(latestAutoCooldownUntil) }}
                  </div>
                </div>
                <div :class="['rounded-md', 'bg-white/70', 'p-2', 'text-xs', 'dark:bg-neutral-950/50']">
                  手动保护：{{ latestManualOverrideUntil ? formatDateTime(latestManualOverrideUntil) : '无' }}
                  <div :class="['opacity-70']">
                    最近明确负反馈：未检测到，仅未回应会按 unknown 处理。
                  </div>
                </div>
              </div>
              <div :class="['mb-3', 'grid', 'gap-2', 'grid-cols-2', 'lg:grid-cols-4']">
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  互动 {{ autonomyDecisionStats.interact_with_user }}
                </div>
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  安静观察 {{ autonomyDecisionStats.observe_quietly }}
                </div>
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  继续项目 {{ autonomyDecisionStats.continue_self_project }}
                </div>
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  想法池 {{ autonomyDecisionStats.generate_or_select_idea }}
                </div>
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  反思 {{ autonomyDecisionStats.reflect }}
                </div>
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  休息 {{ autonomyDecisionStats.rest }}
                </div>
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  权限阻塞 {{ autonomyDecisionStats.permissionBlocked }}
                </div>
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  实际进展 {{ autonomyDecisionStats.progressed }}
                </div>
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  外部沉默 {{ autonomyDecisionStats.external_silence_count }}
                </div>
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  Life Tick {{ autonomyDecisionStats.life_tick_count }}
                </div>
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  Idea 生成 {{ autonomyDecisionStats.idea_generation_count }}
                </div>
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  Todo 推进 {{ autonomyDecisionStats.todo_progress_count }}
                </div>
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  私密想法 {{ autonomyDecisionStats.private_thought_count }}
                </div>
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  运行日志 {{ autonomyDecisionStats.runtime_log_count }}
                </div>
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  调参 {{ autonomyDecisionStats.setting_change_count }}
                </div>
                <div :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']">
                  安静但内部活跃 {{ autonomyDecisionStats.quiet_but_internally_active_count }}
                </div>
              </div>
              <div v-if="decisionLog.length === 0" :class="['text-xs', 'opacity-70']">
                还没有自主决策记录。
              </div>
              <div v-else :class="['max-h-240px', 'overflow-auto', 'space-y-2']">
                <div
                  v-for="entry in decisionLog.slice(0, 12)"
                  :key="entry.id"
                  :class="['rounded-md', 'bg-cyan-950/5', 'p-2', 'text-xs', 'dark:bg-cyan-50/5']"
                >
                  <div :class="['font-semibold']">{{ entry.desire || entry.selectedAction }} · {{ entry.selectedMode || entry.selectedAction }} · {{ entry.result }}</div>
                  <div :class="['opacity-70']">{{ formatTime(entry.timestamp) }} · {{ entry.targetSpace || 'lumi_world' }} · {{ entry.visibility || 'private' }}</div>
                  <div :class="['opacity-70']">{{ entry.motivation || entry.reason }}</div>
                </div>
              </div>
            </div>

            <div :class="['rounded-lg', 'bg-white/70', 'p-3', 'text-sm', 'dark:bg-neutral-950/50']">
              <div :class="['mb-2', 'font-semibold']">私密笔记</div>
              <div v-if="privateNotes.length === 0" :class="['text-xs', 'opacity-70']">
                Lumi 还没有留下私密观察笔记。
              </div>
              <div v-else :class="['max-h-240px', 'overflow-auto', 'space-y-2']">
                <div
                  v-for="note in privateNotes.slice(0, 12)"
                  :key="note.id"
                  :class="['rounded-md', 'bg-emerald-950/5', 'p-2', 'text-xs', 'dark:bg-emerald-50/5']"
                >
                  <div :class="['font-semibold']">{{ formatTime(note.createdAt) }} · {{ note.reason }}</div>
                  <div :class="['whitespace-pre-wrap', 'opacity-80']">{{ note.note }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </details>

      <Callout
        v-if="lastError"
        theme="orange"
        label="主动视觉错误"
        :description="lastError"
      />

      <VisionCapturePreview
        v-if="lastCapturedImageDataUrl && lastVisionInputImageDataUrl"
        :captured-at="lastCaptureAt"
        :source-id="lastCaptureSourceId"
        :source-name="lastCaptureSourceName"
        :captured-image-data-url="lastCapturedImageDataUrl"
        :vision-input-image-data-url="lastVisionInputImageDataUrl"
        @clear="proactiveVisionStore.clearLastCaptureImages()"
      />

      <div :class="['grid', 'gap-3', 'lg:grid-cols-2']">
        <div :class="['rounded-lg', 'bg-emerald-50', 'p-3', 'text-sm', 'dark:bg-emerald-950/30']">
          <div :class="['mb-2', 'font-semibold']">
            最近观察
          </div>
          <pre :class="['max-h-220px', 'overflow-auto', 'whitespace-pre-wrap', 'text-xs']">{{ lastObservation || '还没有观察结果。' }}</pre>
        </div>
        <div :class="['rounded-lg', 'bg-sky-50', 'p-3', 'text-sm', 'dark:bg-sky-950/30']">
          <div :class="['mb-2', 'font-semibold']">
            最近主动消息
          </div>
          <pre :class="['max-h-220px', 'overflow-auto', 'whitespace-pre-wrap', 'text-xs']">{{ lastMessage || '还没有主动消息。' }}</pre>
        </div>
      </div>

      <div :class="['rounded-lg', 'bg-emerald-50', 'p-3', 'text-sm', 'dark:bg-emerald-950/30']">
        <div :class="['mb-2', 'font-semibold']">
          短期环境上下文
        </div>
        <div v-if="environmentContext.length === 0" :class="['text-xs', 'opacity-70']">
          还没有观察到可用上下文。
        </div>
        <div v-else :class="['grid', 'gap-2']">
          <div
            v-for="entry in environmentContext.slice().reverse()"
            :key="entry.id"
            :class="['rounded-md', 'bg-white/70', 'p-2', 'text-xs', 'dark:bg-neutral-950/50']"
          >
            <div :class="['mb-1', 'flex', 'flex-wrap', 'items-center', 'gap-2', 'font-semibold']">
              <span>{{ formatTime(entry.observedAt) }}</span>
              <span>{{ entry.activity }}</span>
              <span>{{ entry.salience }}</span>
              <span>{{ entry.source }}</span>
            </div>
            <div :class="['opacity-80']">
              {{ entry.summary }}
            </div>
          </div>
        </div>
      </div>
    </Section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  title: 插件
  description: 管理 AIRI 外部插件和 Lumi 内置插件
  icon: i-solar:plug-circle-bold-duotone
  settingsEntry: true
  order: 35
</route>
