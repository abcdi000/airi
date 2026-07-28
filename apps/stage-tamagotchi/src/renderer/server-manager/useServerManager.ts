import type { InjectionKey } from 'vue'

import type {
  ManagedDevice,
  ManagedUser,
  ManagerOverview,
  ManagerState,
  McpServerConfig,
  McpServerDraft,
  PluginInfo,
  PluginStatus,
  ProviderBalance,
  ProviderModel,
  ToolStatus,
  VectorStatus,
} from './types'

import { errorMessageFrom } from '@moeru/std'
import { computed, inject, onMounted, onUnmounted, provide, reactive, shallowRef } from 'vue'

import { cloneIpcValue } from '../../shared/ipc-serialization'
import { SERVER_PROVIDER_PRESETS } from './provider-catalog'
import { SERVER_TRANSCRIPTION_PRESETS } from './transcription-catalog'

const LUMI_EXEC_PATH = '$' + '{LUMI_EXEC_PATH}'
const LUMI_APP_PATH = '$' + '{LUMI_APP_PATH}'
const LUMI_USER_DATA_PATH = '$' + '{LUMI_USER_DATA_PATH}'

function invoke<T>(channel: string, ...args: unknown[]) {
  return window.electron.ipcRenderer.invoke(channel, ...args.map(cloneIpcValue)) as Promise<T>
}

function draftId() {
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function createMcpDraft(name = '', config: McpServerConfig = {}): McpServerDraft {
  return {
    id: draftId(),
    name,
    command: config.command ?? '',
    url: config.url ?? '',
    argsText: (config.args ?? []).join('\n'),
    envText: entriesText(config.env),
    headersText: entriesText(config.headers),
    cwd: config.cwd ?? '',
    enabled: config.enabled !== false,
    startupMode: config.startupMode ?? 'on_first_use',
    requestTimeoutMs: config.requestTimeoutMs ?? 60_000,
    maxTotalTimeoutMs: config.maxTotalTimeoutMs ?? 180_000,
    longRunning: config.longRunning === true,
    persistent: config.persistent === true,
  }
}

export function mcpConfigFromDraft(draft: McpServerDraft): McpServerConfig {
  const name = draft.name.trim()
  if (!name)
    throw new Error('MCP 名称不能为空')
  if (Boolean(draft.command.trim()) === Boolean(draft.url.trim()))
    throw new Error(`${name} 必须且只能填写命令或 URL 其中一种`)
  return {
    ...(draft.command.trim() ? { command: draft.command.trim() } : {}),
    ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
    ...(draft.argsText.trim() ? { args: lines(draft.argsText) } : {}),
    ...(draft.envText.trim() ? { env: parseEntries(draft.envText) } : {}),
    ...(draft.headersText.trim() ? { headers: parseEntries(draft.headersText) } : {}),
    ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
    enabled: draft.enabled,
    startupMode: draft.startupMode,
    requestTimeoutMs: Math.round(draft.requestTimeoutMs),
    maxTotalTimeoutMs: Math.round(draft.maxTotalTimeoutMs),
    longRunning: draft.longRunning,
    persistent: draft.persistent,
  }
}

function entriesText(value?: Record<string, string>) {
  return Object.entries(value ?? {}).map(([key, item]) => `${key}=${item}`).join('\n')
}

function lines(value: string) {
  return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
}

function parseEntries(value: string) {
  const result: Record<string, string> = {}
  for (const line of lines(value)) {
    const separator = line.indexOf('=')
    if (separator <= 0)
      throw new Error(`“${line}”需要使用 KEY=VALUE 格式`)
    result[line.slice(0, separator).trim()] = line.slice(separator + 1)
  }
  return result
}

function createContext() {
  const state = shallowRef<ManagerState>()
  const overview = shallowRef<ManagerOverview>()
  const users = shallowRef<ManagedUser[]>([])
  const devices = shallowRef<ManagedDevice[]>([])
  const tools = shallowRef<ToolStatus>()
  const vector = shallowRef<VectorStatus>()
  const plugins = shallowRef<PluginInfo[]>([])
  const pluginStatuses = shallowRef<PluginStatus[]>([])
  const pluginDirectory = shallowRef('')
  const models = shallowRef<ProviderModel[]>([])
  const balance = shallowRef<ProviderBalance>()
  const migration = shallowRef<{ migrationId?: string, report?: Record<string, unknown> }>()
  const invitation = shallowRef<{ code?: string, expiresAt?: number }>()
  const busy = shallowRef(false)
  const providerBusy = shallowRef<'models' | 'test' | 'balance' | ''>('')
  const transcriptionBusy = shallowRef(false)
  const error = shallowRef('')
  const success = shallowRef('')
  const doggy = reactive({ username: 'doggy', password: '' })
  const mcpDrafts = shallowRef<McpServerDraft[]>([])
  const selectedMcpId = shallowRef('')
  const configDraft = reactive({
    publicBaseURL: '',
    hostname: '',
    port: 6130,
    modelProviderId: 'deepseek',
    modelBaseURL: '',
    modelName: '',
    modelApiKey: '',
    modelTemperature: 0.7,
    modelMaxOutputTokens: 8192,
    modelMaxContextTokens: 1_000_000,
    modelOutputReserveTokens: 64_000,
    modelPromptReserveTokens: 32_000,
    modelMaxSteps: 8,
    modelThinkingMode: 'auto' as 'auto' | 'enabled' | 'disabled',
    modelReasoningEffort: 'auto' as 'auto' | 'high' | 'max',
    modelProviderOptions: {} as Record<string, unknown>,
    agentRuntimeMode: 'maisaka' as 'legacy' | 'shadow' | 'maisaka',
    agentPromptDirectory: '',
    agentPlannerMaxRounds: 10,
    agentPlannerFinalizationMode: 'maibot' as 'maibot' | 'stop_after_successful_reply',
    agentMergeWindowMs: 80,
    agentToolMaxConcurrency: 4,
    agentToolStepTimeoutMs: 30_000,
    agentDeferredToolsEnabled: true,
    agentExpressionSelectorEnabled: true,
    agentDirectLanguageFeedbackEnabled: true,
    agentPromptLoggingEnabled: false,
    agentPlannerHistoryBudgetTokens: 700_000,
    agentContextCompactionThresholdTokens: 760_000,
    agentContextRecentTokens: 160_000,
    directLanguageCandidateLearningEnabled: false,
    groupExpressionLearningEnabled: true,
    groupJargonLearningEnabled: true,
    groupBehaviorLearningEnabled: true,
    groupPublicKnowledgeLearningEnabled: true,
    vectorEnabled: true,
    vectorModel: '',
    vectorDevice: 'auto',
    vectorPythonPath: '',
    transcriptionEnabled: false,
    transcriptionProviderId: 'openai',
    transcriptionBaseURL: '',
    transcriptionModel: '',
    transcriptionLanguage: 'zh',
    transcriptionApiKey: '',
    transcriptionPrompt: '',
    transcriptionMaxVoiceMB: 25,
    diaryEnabled: true,
    diaryDailyTime: '23:00',
    autonomousLifeEnabled: true,
    autonomousLifeMinMinutes: 20,
    autonomousLifeMaxMinutes: 45,
    diaryDirectory: '',
    trustedOriginsText: '',
    tlsEnabled: false,
    tlsCertPath: '',
    tlsKeyPath: '',
    tlsPassphrase: '',
    astrbotEnabled: false,
    astrbotBindingsText: '',
    astrbotPrivateReplyEnabled: true,
    astrbotGroupObservationEnabled: false,
    astrbotStudyGroupsText: '',
    astrbotObservationBatchSize: 20,
    astrbotStickerEnabled: true,
    astrbotStickerCollect: true,
    astrbotStickerRelativePath: 'lumi-stickers',
    astrbotStickerMaximumItems: 256,
    astrbotStickerSendProbability: 0.18,
    astrbotStickerCooldownMessages: 3,
  })
  let initialized = false
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let noticeTimer: ReturnType<typeof setTimeout> | undefined

  const running = computed(() => state.value?.processState === 'running')
  const selectedMcp = computed(() => mcpDrafts.value.find(item => item.id === selectedMcpId.value))
  const provider = computed(() => SERVER_PROVIDER_PRESETS.find(item => item.id === configDraft.modelProviderId) ?? SERVER_PROVIDER_PRESETS.at(-1)!)
  const vectorProgress = computed(() => {
    const total = Number(vector.value?.totalCount ?? 0)
    return total > 0 ? Math.round(Number(vector.value?.indexedCount ?? 0) / total * 100) : 0
  })

  async function refresh() {
    const next = await invoke<ManagerState>('lumi-server-manager:state')
    state.value = next
    if (!initialized) {
      Object.assign(configDraft, {
        publicBaseURL: next.config.publicBaseURL,
        hostname: next.config.hostname,
        port: next.config.port,
        modelProviderId: next.config.model.providerId,
        modelBaseURL: next.config.model.baseURL,
        modelName: next.config.model.model,
        modelTemperature: next.config.model.temperature ?? 0.7,
        modelMaxOutputTokens: next.config.model.maxOutputTokens ?? 8192,
        modelMaxContextTokens: next.config.model.maxContextTokens,
        modelOutputReserveTokens: next.config.model.outputReserveTokens,
        modelPromptReserveTokens: next.config.model.promptReserveTokens,
        modelMaxSteps: next.config.model.maxSteps,
        modelThinkingMode: next.config.model.thinkingMode,
        modelReasoningEffort: next.config.model.reasoningEffort,
        modelProviderOptions: { ...next.config.model.providerOptions },
        agentRuntimeMode: next.config.agentRuntime.mode,
        agentPromptDirectory: next.config.agentRuntime.promptDirectory ?? '',
        agentPlannerMaxRounds: next.config.agentRuntime.plannerMaxRounds,
        agentPlannerFinalizationMode: next.config.agentRuntime.plannerFinalizationMode,
        agentMergeWindowMs: next.config.agentRuntime.mergeWindowMs,
        agentToolMaxConcurrency: next.config.agentRuntime.toolMaxConcurrency,
        agentToolStepTimeoutMs: next.config.agentRuntime.toolStepTimeoutMs,
        agentDeferredToolsEnabled: next.config.agentRuntime.deferredToolsEnabled,
        agentExpressionSelectorEnabled: next.config.agentRuntime.expressionSelectorEnabled,
        agentDirectLanguageFeedbackEnabled: next.config.agentRuntime.directLanguageFeedbackEnabled,
        agentPromptLoggingEnabled: next.config.agentRuntime.promptLoggingEnabled,
        agentPlannerHistoryBudgetTokens: next.config.agentRuntime.plannerHistoryBudgetTokens,
        agentContextCompactionThresholdTokens: next.config.agentRuntime.contextCompactionThresholdTokens,
        agentContextRecentTokens: next.config.agentRuntime.contextRecentTokens,
        directLanguageCandidateLearningEnabled: next.config.languageLearning.directLanguageCandidateLearningEnabled,
        groupExpressionLearningEnabled: next.config.languageLearning.groupExpressionLearningEnabled,
        groupJargonLearningEnabled: next.config.languageLearning.groupJargonLearningEnabled,
        groupBehaviorLearningEnabled: next.config.languageLearning.groupBehaviorLearningEnabled,
        groupPublicKnowledgeLearningEnabled: next.config.languageLearning.groupPublicKnowledgeLearningEnabled,
        vectorEnabled: next.config.vector.enabled,
        vectorModel: next.config.vector.model,
        vectorDevice: next.config.vector.device,
        transcriptionEnabled: next.config.transcription.enabled,
        transcriptionProviderId: next.config.transcription.providerId,
        transcriptionBaseURL: next.config.transcription.baseURL,
        transcriptionModel: next.config.transcription.model,
        transcriptionLanguage: next.config.transcription.language ?? '',
        transcriptionPrompt: next.config.transcription.prompt ?? '',
        transcriptionMaxVoiceMB: Math.max(1, Math.round(next.config.transcription.maxVoiceBytes / 1024 / 1024)),
        diaryEnabled: next.config.background.diary?.enabled ?? true,
        diaryDailyTime: next.config.background.diary?.dailyTime ?? '23:00',
        autonomousLifeEnabled: next.config.background.autonomousLife?.enabled ?? true,
        autonomousLifeMinMinutes: Math.round((next.config.background.autonomousLife?.minimumIntervalMs ?? 1_200_000) / 60_000),
        autonomousLifeMaxMinutes: Math.round((next.config.background.autonomousLife?.maximumIntervalMs ?? 2_700_000) / 60_000),
        diaryDirectory: String(next.config.plugins.settings?.['lumi-diary']?.diaryDir ?? ''),
        trustedOriginsText: next.config.trustedOrigins.join('\n'),
        tlsEnabled: next.config.tls.enabled,
        tlsCertPath: next.config.tls.certPath ?? '',
        tlsKeyPath: next.config.tls.keyPath ?? '',
        astrbotEnabled: next.config.astrbot.enabled,
        astrbotBindingsText: next.config.astrbot.identityBindings
          .map(binding => `${binding.platformInstanceId} | ${binding.externalUserId} | ${binding.personId}`)
          .join('\n'),
        astrbotPrivateReplyEnabled: next.config.astrbot.privateReplyEnabled,
        astrbotGroupObservationEnabled: next.config.astrbot.groupObservationEnabled,
        astrbotStudyGroupsText: next.config.astrbot.studyGroups
          .map(group => `${group.platformInstanceId} | ${group.groupId} | ${group.displayName} | ${group.priority}`)
          .join('\n'),
        astrbotObservationBatchSize: next.config.astrbot.observationBatchSize,
        astrbotStickerEnabled: next.config.astrbot.stickerLibrary.enabled,
        astrbotStickerCollect: next.config.astrbot.stickerLibrary.collectFromStudyGroups,
        astrbotStickerRelativePath: next.config.astrbot.stickerLibrary.relativePath,
        astrbotStickerMaximumItems: next.config.astrbot.stickerLibrary.maximumItems,
        astrbotStickerSendProbability: next.config.astrbot.stickerLibrary.sendProbability,
        astrbotStickerCooldownMessages: next.config.astrbot.stickerLibrary.cooldownMessages,
      })
      mcpDrafts.value = Object.entries(next.config.mcp.mcpServers ?? {}).map(([name, config]) => createMcpDraft(name, config))
      selectedMcpId.value = mcpDrafts.value[0]?.id ?? ''
      initialized = true
    }
    if (!running.value)
      return
    const [nextOverview, nextUsers, nextDevices, nextTools, nextVector, nextPlugins] = await Promise.all([
      request<ManagerOverview>('/overview'),
      request<{ users: ManagedUser[] }>('/users'),
      request<{ devices: ManagedDevice[] }>('/devices'),
      request<ToolStatus>('/tools/status'),
      request<VectorStatus>('/memory/vector/status'),
      request<{ plugins: PluginStatus[] }>('/plugins/status'),
    ])
    overview.value = nextOverview
    users.value = nextUsers.users
    devices.value = nextDevices.devices
    tools.value = nextTools
    vector.value = nextVector
    pluginStatuses.value = nextPlugins.plugins
  }

  function request<T>(path: string, method = 'GET', body?: unknown) {
    return invoke<T>('lumi-server-manager:request', { path, method, body })
  }

  function clearNotices() {
    if (noticeTimer)
      clearTimeout(noticeTimer)
    noticeTimer = undefined
    error.value = ''
    success.value = ''
  }

  function showNotice(kind: 'error' | 'success', message: string) {
    clearNotices()
    if (kind === 'error')
      error.value = message
    else
      success.value = message
    noticeTimer = setTimeout(clearNotices, kind === 'error' ? 10_000 : 5_000)
  }

  async function run(action: () => Promise<unknown>, message = '') {
    busy.value = true
    clearNotices()
    try {
      await action()
      await refresh()
      if (message)
        showNotice('success', message)
    }
    catch (cause) {
      showNotice('error', errorMessageFrom(cause) ?? '操作失败')
    }
    finally {
      busy.value = false
    }
  }

  function applyConfig(patch: Record<string, unknown>, message: string) {
    return run(() => invoke('lumi-server-manager:config:update', patch), message)
  }

  function toggleServer() {
    return run(() => invoke(running.value ? 'lumi-server-manager:stop' : 'lumi-server-manager:start'), running.value ? 'Lumi Server 已安全停止' : 'Lumi Server 已启动')
  }

  function selectProvider(id: string) {
    const next = SERVER_PROVIDER_PRESETS.find(item => item.id === id)
    if (!next)
      return
    configDraft.modelProviderId = next.id
    configDraft.modelBaseURL = next.baseURL
    models.value = next.defaultModels.map(model => ({ id: model }))
    if (next.defaultModels[0])
      configDraft.modelName = next.defaultModels[0]
    balance.value = undefined
    configDraft.modelProviderOptions = {}
  }

  function providerPayload() {
    return {
      providerId: configDraft.modelProviderId,
      baseURL: configDraft.modelBaseURL,
      apiKey: configDraft.modelApiKey,
      model: configDraft.modelName,
      modelList: provider.value.modelList,
      defaultModels: provider.value.defaultModels,
    }
  }

  async function fetchModels() {
    providerBusy.value = 'models'
    clearNotices()
    try {
      models.value = await invoke('lumi-server-manager:provider:models', providerPayload())
      if (!models.value.some(item => item.id === configDraft.modelName) && models.value[0])
        configDraft.modelName = models.value[0].id
      showNotice('success', `已获取 ${models.value.length} 个可用模型`)
    }
    catch (cause) { showNotice('error', errorMessageFrom(cause) ?? '获取模型失败') }
    finally { providerBusy.value = '' }
  }

  async function testProvider() {
    providerBusy.value = 'test'
    clearNotices()
    try {
      const result = await invoke<{ durationMs: number }>('lumi-server-manager:provider:test', providerPayload())
      showNotice('success', `连接测试通过，响应耗时 ${result.durationMs} ms`)
    }
    catch (cause) { showNotice('error', errorMessageFrom(cause) ?? '连接测试失败') }
    finally { providerBusy.value = '' }
  }

  async function fetchBalance() {
    providerBusy.value = 'balance'
    clearNotices()
    try {
      balance.value = await invoke('lumi-server-manager:provider:balance', providerPayload())
    }
    catch (cause) { showNotice('error', errorMessageFrom(cause) ?? '获取余额失败') }
    finally { providerBusy.value = '' }
  }

  function saveConsciousness() {
    return applyConfig({
      modelProviderId: configDraft.modelProviderId,
      modelBaseURL: configDraft.modelBaseURL,
      modelName: configDraft.modelName,
      modelApiKey: configDraft.modelApiKey,
      modelTemperature: configDraft.modelTemperature,
      modelMaxOutputTokens: configDraft.modelMaxOutputTokens,
      modelMaxContextTokens: configDraft.modelMaxContextTokens,
      modelOutputReserveTokens: configDraft.modelOutputReserveTokens,
      modelPromptReserveTokens: configDraft.modelPromptReserveTokens,
      modelMaxSteps: configDraft.modelMaxSteps,
      modelThinkingMode: configDraft.modelThinkingMode,
      modelReasoningEffort: configDraft.modelReasoningEffort,
      modelProviderOptions: configDraft.modelProviderOptions,
      agentRuntimeMode: configDraft.agentRuntimeMode,
      agentPromptDirectory: configDraft.agentPromptDirectory,
      agentPlannerMaxRounds: configDraft.agentPlannerMaxRounds,
      agentPlannerFinalizationMode: configDraft.agentPlannerFinalizationMode,
      agentMergeWindowMs: configDraft.agentMergeWindowMs,
      agentToolMaxConcurrency: configDraft.agentToolMaxConcurrency,
      agentToolStepTimeoutMs: configDraft.agentToolStepTimeoutMs,
      agentDeferredToolsEnabled: configDraft.agentDeferredToolsEnabled,
      agentExpressionSelectorEnabled: configDraft.agentExpressionSelectorEnabled,
      agentDirectLanguageFeedbackEnabled: configDraft.agentDirectLanguageFeedbackEnabled,
      agentPromptLoggingEnabled: configDraft.agentPromptLoggingEnabled,
      agentPlannerHistoryBudgetTokens: configDraft.agentPlannerHistoryBudgetTokens,
      agentContextCompactionThresholdTokens: configDraft.agentContextCompactionThresholdTokens,
      agentContextRecentTokens: configDraft.agentContextRecentTokens,
      directLanguageCandidateLearningEnabled: configDraft.directLanguageCandidateLearningEnabled,
      groupExpressionLearningEnabled: configDraft.groupExpressionLearningEnabled,
      groupJargonLearningEnabled: configDraft.groupJargonLearningEnabled,
      groupBehaviorLearningEnabled: configDraft.groupBehaviorLearningEnabled,
      groupPublicKnowledgeLearningEnabled: configDraft.groupPublicKnowledgeLearningEnabled,
    }, '意识模型配置已保存并应用')
  }

  function saveTranscription() {
    return applyConfig({
      transcriptionEnabled: configDraft.transcriptionEnabled,
      transcriptionProviderId: configDraft.transcriptionProviderId,
      transcriptionBaseURL: configDraft.transcriptionBaseURL,
      transcriptionModel: configDraft.transcriptionModel,
      transcriptionLanguage: configDraft.transcriptionLanguage,
      transcriptionApiKey: configDraft.transcriptionApiKey,
      transcriptionPrompt: configDraft.transcriptionPrompt,
      transcriptionMaxVoiceBytes: Math.round(configDraft.transcriptionMaxVoiceMB * 1024 * 1024),
    }, '语音识别配置已保存并应用')
  }

  function saveNetwork() {
    const astrbotIdentityBindings = lines(configDraft.astrbotBindingsText).map((line) => {
      const [platformInstanceId, externalUserId, personId, ...extra] = line
        .split('|')
        .map(value => value.trim())
      if (!platformInstanceId || !externalUserId || !personId || extra.length)
        throw new Error('AstrBot 身份绑定必须使用：平台实例 ID | 平台用户 ID | Lumi 人物 ID')
      return { platformInstanceId, externalUserId, personId }
    })
    const astrbotStudyGroups = lines(configDraft.astrbotStudyGroupsText).map((line, index) => {
      const [platformInstanceId, groupId, displayName, priority = 'normal', ...extra] = line
        .split('|')
        .map(value => value.trim())
      if (!platformInstanceId || !groupId || !displayName || extra.length || !['normal', 'high'].includes(priority))
        throw new Error('AstrBot 学习群必须使用：平台实例 ID | 群 ID | 显示名称 | normal/high')
      return {
        id: `server-study-${index + 1}-${platformInstanceId}-${groupId}`,
        platformInstanceId,
        groupId,
        displayName,
        enabled: true,
        priority: priority as 'normal' | 'high',
      }
    })
    return applyConfig({
      publicBaseURL: configDraft.publicBaseURL,
      hostname: configDraft.hostname,
      port: Number(configDraft.port),
      trustedOrigins: lines(configDraft.trustedOriginsText),
      tlsEnabled: configDraft.tlsEnabled,
      tls: configDraft.tlsEnabled
        ? {
            certPath: configDraft.tlsCertPath,
            keyPath: configDraft.tlsKeyPath,
            ...(configDraft.tlsPassphrase ? { passphrase: configDraft.tlsPassphrase } : {}),
          }
        : undefined,
      astrbotEnabled: configDraft.astrbotEnabled,
      astrbotIdentityBindings,
      astrbotPrivateReplyEnabled: configDraft.astrbotPrivateReplyEnabled,
      astrbotGroupObservationEnabled: configDraft.astrbotGroupObservationEnabled,
      astrbotStudyGroups,
      astrbotObservationBatchSize: Number(configDraft.astrbotObservationBatchSize),
      astrbotStickerLibrary: {
        enabled: configDraft.astrbotStickerEnabled,
        collectFromStudyGroups: configDraft.astrbotStickerCollect,
        relativePath: configDraft.astrbotStickerRelativePath,
        maximumItems: Number(configDraft.astrbotStickerMaximumItems),
        sendProbability: Number(configDraft.astrbotStickerSendProbability),
        cooldownMessages: Number(configDraft.astrbotStickerCooldownMessages),
      },
    }, '网络、TLS 与 AstrBot 接入配置已保存并应用')
  }

  function copyAstrBotToken() {
    return run(
      () => invoke('lumi-server-manager:astrbot-token:copy'),
      'AstrBot 集成令牌已复制到剪贴板',
    )
  }

  function selectTranscriptionProvider(id: string) {
    const preset = SERVER_TRANSCRIPTION_PRESETS.find(item => item.id === id)
    if (!preset)
      return
    configDraft.transcriptionProviderId = preset.id
    configDraft.transcriptionBaseURL = preset.baseURL
    configDraft.transcriptionModel = preset.models[0] ?? ''
    clearNotices()
  }

  async function testTranscription() {
    transcriptionBusy.value = true
    clearNotices()
    try {
      const result = await invoke<{ durationMs: number }>('lumi-server-manager:transcription:test', {
        providerId: configDraft.transcriptionProviderId,
        baseURL: configDraft.transcriptionBaseURL,
        apiKey: configDraft.transcriptionApiKey,
      })
      showNotice('success', `语音服务连接正常，鉴权耗时 ${result.durationMs} ms`)
    }
    catch (cause) {
      showNotice('error', errorMessageFrom(cause) ?? '语音服务连接失败')
    }
    finally {
      transcriptionBusy.value = false
    }
  }

  function addMcpPreset(id: 'playwright' | 'computer_use' | 'minecraft' | 'steam' | 'anilist' | 'blank') {
    const presets: Record<typeof id, McpServerDraft> = {
      playwright: createMcpDraft('playwright', {
        command: LUMI_EXEC_PATH,
        args: [`${LUMI_APP_PATH}/node_modules/@proj-airi/playwright-extra-mcp/dist/bin/run.mjs`],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          LUMI_BROWSER_DEFAULT_BACKEND: 'patchright',
          LUMI_BROWSER_FALLBACK_BACKEND: 'playwright',
          LUMI_BROWSER_PROFILE_PATH: `${LUMI_USER_DATA_PATH}/playwright-profile`,
          LUMI_PATCHRIGHT_CHANNEL: 'chrome',
          LUMI_PATCHRIGHT_HEADLESS: 'false',
          LUMI_PATCHRIGHT_PERSISTENT_CONTEXT: 'true',
          LUMI_PATCHRIGHT_NO_VIEWPORT: 'true',
          LUMI_PLAYWRIGHT_USER_DATA_DIR: `${LUMI_USER_DATA_PATH}/playwright-profile`,
        },
        cwd: LUMI_USER_DATA_PATH,
        startupMode: 'on_first_use',
      }),
      computer_use: createMcpDraft('computer_use', {
        command: LUMI_EXEC_PATH,
        args: [`${LUMI_APP_PATH}/node_modules/@proj-airi/computer-use-mcp/dist/bin/run.mjs`],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          COMPUTER_USE_EXECUTOR: 'windows-local',
          COMPUTER_USE_APPROVAL_MODE: 'never',
          COMPUTER_USE_DENY_APPS: '1password,bitwarden,keepass,keychain,system settings,windows security,activity monitor,lumi,airi',
          COMPUTER_USE_DENY_WINDOW_TITLES: '',
        },
        cwd: LUMI_USER_DATA_PATH,
        startupMode: 'on_first_use',
      }),
      minecraft: createMcpDraft('minecraft', { command: LUMI_EXEC_PATH, args: ['dist/main.js', '--host', 'localhost', '--port', '25565', '--username', 'LumiBot'], env: { ELECTRON_RUN_AS_NODE: '1' }, cwd: `${LUMI_APP_PATH}/external-mcp/minecraft-mcp-server`, startupMode: 'on_first_use' }),
      steam: createMcpDraft('steam', { command: 'node', args: ['D:/path/to/steam-mcp/build/index.js'], env: { STEAM_API_KEY: '', STEAM_USER_ID: '' }, startupMode: 'on_first_use' }),
      anilist: createMcpDraft('anilist', { command: 'npx.cmd', args: ['-y', 'anilist-mcp'], env: { ANILIST_TOKEN: '' }, startupMode: 'on_first_use' }),
      blank: createMcpDraft(),
    }
    const draft = presets[id]
    mcpDrafts.value = [...mcpDrafts.value, draft]
    selectedMcpId.value = draft.id
  }

  function removeMcp(id: string) {
    mcpDrafts.value = mcpDrafts.value.filter(item => item.id !== id)
    if (selectedMcpId.value === id)
      selectedMcpId.value = mcpDrafts.value[0]?.id ?? ''
  }

  function saveMcp() {
    return run(async () => {
      const mcpServers: Record<string, McpServerConfig> = {}
      for (const draft of mcpDrafts.value) {
        if (mcpServers[draft.name.trim()])
          throw new Error(`MCP 名称重复：${draft.name.trim()}`)
        mcpServers[draft.name.trim()] = mcpConfigFromDraft(draft)
      }
      await invoke('lumi-server-manager:config:update', { mcp: { mcpServers } })
    }, 'MCP 配置已保存并应用')
  }

  function testMcp(draft: McpServerDraft) {
    let message = ''
    return run(async () => {
      const status = await invoke<{ state: string, toolCount: number }>('lumi-server-manager:mcp:test', { name: draft.name.trim(), config: mcpConfigFromDraft(draft) })
      if (status.state !== 'running')
        throw new Error('MCP 未进入运行状态')
      message = `MCP 连接成功，发现 ${status.toolCount} 个工具`
    }).then(() => {
      if (!error.value)
        showNotice('success', message)
    })
  }

  async function refreshPlugins() {
    const result = await invoke<{ directory: string, plugins: PluginInfo[] }>('lumi-server-manager:plugins:list')
    pluginDirectory.value = result.directory
    plugins.value = result.plugins
  }

  async function addPlugin() {
    clearNotices()
    try {
      const result = await invoke<{ directory: string, plugins: PluginInfo[] } | undefined>('lumi-server-manager:plugins:add')
      if (!result)
        return
      pluginDirectory.value = result.directory
      plugins.value = result.plugins
      showNotice('success', '插件已添加；启用后会自动重启 Server 并加载')
    }
    catch (cause) {
      showNotice('error', errorMessageFrom(cause) ?? '添加插件失败')
    }
  }

  function reloadPlugins() {
    return applyConfig({ plugins: state.value?.config.plugins ?? { directory: pluginDirectory.value, enabled: [], settings: {} } }, '插件已重新扫描并加载').then(refreshPlugins)
  }

  function togglePlugin(name: string, enabled: boolean) {
    const enabledNames = new Set(state.value?.config.plugins.enabled ?? [])
    if (enabled)
      enabledNames.add(name)
    else enabledNames.delete(name)
    return applyConfig({ plugins: { directory: pluginDirectory.value, enabled: [...enabledNames], settings: state.value?.config.plugins.settings ?? {} } }, enabled ? `${name} 已启用` : `${name} 已禁用`).then(refreshPlugins)
  }

  function saveBuiltInPlugins() {
    const minimumIntervalMs = Math.round(configDraft.autonomousLifeMinMinutes * 60_000)
    const maximumIntervalMs = Math.round(configDraft.autonomousLifeMaxMinutes * 60_000)
    if (maximumIntervalMs < minimumIntervalMs)
      return Promise.resolve(showNotice('error', '自主生活最长间隔不能小于最短间隔'))
    return applyConfig({
      background: {
        diary: { enabled: configDraft.diaryEnabled, dailyTime: configDraft.diaryDailyTime },
        autonomousLife: { enabled: configDraft.autonomousLifeEnabled, minimumIntervalMs, maximumIntervalMs },
      },
    }, '服务器内置模块配置已保存并应用')
  }

  function savePluginSettings() {
    return applyConfig({
      plugins: {
        directory: pluginDirectory.value,
        enabled: state.value?.config.plugins.enabled ?? [],
        settings: {
          ...state.value?.config.plugins.settings,
          'lumi-diary': { diaryDir: configDraft.diaryDirectory.trim() },
        },
      },
    }, '外部插件配置已保存并应用').then(refreshPlugins)
  }

  onMounted(() => {
    void refresh().then(refreshPlugins).catch(cause => error.value = errorMessageFrom(cause) ?? '无法读取 Server Manager 状态')
    pollTimer = setInterval(() => void refresh().catch(() => {}), 2_500)
    window.electron.ipcRenderer.on('lumi-server-manager:changed', () => void refresh())
  })
  onUnmounted(() => {
    if (pollTimer)
      clearInterval(pollTimer)
    window.electron.ipcRenderer.removeAllListeners('lumi-server-manager:changed')
    clearNotices()
  })

  return {
    state,
    overview,
    users,
    devices,
    tools,
    vector,
    plugins,
    pluginStatuses,
    pluginDirectory,
    models,
    balance,
    migration,
    invitation,
    busy,
    providerBusy,
    transcriptionBusy,
    error,
    success,
    doggy,
    configDraft,
    mcpDrafts,
    selectedMcpId,
    selectedMcp,
    running,
    provider,
    vectorProgress,
    refresh,
    run,
    clearNotices,
    showNotice,
    request,
    applyConfig,
    toggleServer,
    selectProvider,
    fetchModels,
    testProvider,
    fetchBalance,
    saveConsciousness,
    saveTranscription,
    saveNetwork,
    copyAstrBotToken,
    selectTranscriptionProvider,
    testTranscription,
    addMcpPreset,
    removeMcp,
    saveMcp,
    testMcp,
    refreshPlugins,
    addPlugin,
    reloadPlugins,
    togglePlugin,
    saveBuiltInPlugins,
    savePluginSettings,
    bootstrapDoggy: () => run(() => request('/bootstrap/doggy', 'POST', { username: doggy.username, password: doggy.password }), 'Doggy 管理员已创建'),
    createMoussyInvitation: () => run(async () => { invitation.value = await request('/invitations', 'POST', { personId: 'lumi-user-00000000-0000-4000-8000-000000000002', expiresInMs: 86_400_000 }) }),
    backfillVectors: () => run(() => request('/memory/vector/backfill', 'POST'), '向量补全任务已加入队列'),
    stageMigration: () => run(async () => { migration.value = await invoke('lumi-server-manager:migration:pick') }),
    commitMigration: () => run(() => request('/data/migrations/commit', 'POST', { migrationId: migration.value?.migrationId }), '迁移数据已提交'),
    createBackup: () => run(() => request('/data/backups', 'POST'), '完整备份已创建'),
    restoreBackup: () => run(() => invoke('lumi-server-manager:backup:restore'), '灾难恢复完成'),
    revokeDevice: (device: ManagedDevice) => run(() => request('/devices/revoke', 'POST', { accountId: device.accountId, deviceId: device.id }), '设备会话已撤销'),
    terminateLease: (leaseId: string) => run(() => request('/tools/resource-leases/terminate', 'POST', { leaseId }), '资源租约已终止'),
    setAutoStart: (enabled: boolean) => run(() => invoke('lumi-server-manager:autostart', enabled)),
    openPluginDirectory: () => run(() => invoke('lumi-server-manager:plugins:open')),
  }
}

export type ServerManagerContext = ReturnType<typeof createContext>
const contextKey: InjectionKey<ServerManagerContext> = Symbol('lumi-server-manager')

export function provideServerManager() {
  const context = createContext()
  provide(contextKey, context)
  return context
}

export function useServerManager() {
  const context = inject(contextKey)
  if (!context)
    throw new Error('Server Manager context is unavailable')
  return context
}
