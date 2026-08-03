<script setup lang="ts">
import type { Sub2ApiClientAccountStatus, Sub2ApiClientConfig } from '@proj-airi/stage-ui/libs'
import type { RemovableRef } from '@vueuse/core'
import type { ChatProvider } from '@xsai-ext/providers/utils'

import { errorMessageFrom } from '@moeru/std'
import {
  Alert,
  ErrorContainer,
  ProviderAdvancedSettings,
  ProviderApiKeyInput,
  ProviderBaseUrlInput,
  ProviderBasicSettings,
  ProviderSettingsContainer,
  ProviderSettingsLayout,
  ProviderValidationAlerts,
  RadioCardManySelect,
} from '@proj-airi/stage-ui/components'
import { useProviderValidation } from '@proj-airi/stage-ui/composables/use-provider-validation'
import {
  fetchSub2ApiClientAccountStatus,
  getDefinedProvider,
  getSub2ApiClientDiagnostics,
} from '@proj-airi/stage-ui/libs'
import { useLLM } from '@proj-airi/stage-ui/stores/llm'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, shallowRef } from 'vue'
import { useRoute } from 'vue-router'

import Sub2ApiClientSettings from './components/Sub2ApiClientSettings.vue'

const route = useRoute()
const providerId = route.params.providerId as string
const providersStore = useProvidersStore()
const consciousnessStore = useConsciousnessStore()
const llmStore = useLLM()
const { providers } = storeToRefs(providersStore) as { providers: RemovableRef<Record<string, any>> }
const { activeProvider, activeModel } = storeToRefs(consciousnessStore)

providersStore.initializeProvider(providerId)

type ConnectionStatus = 'idle' | 'saved' | 'loading-models' | 'testing' | 'success' | 'error'

interface Sub2ApiTestResult {
  success: boolean
  error?: string
  output: string
  protocol: string
  fallbackUsed: boolean
  requestedModel: string
  resolvedModel?: string
  firstTokenLatencyMs?: number
  durationMs: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

const isSavingConfig = ref(false)
const isFetchingModels = ref(false)
const isTestingApi = ref(false)
const connectionStatus = ref<ConnectionStatus>('idle')
const connectionMessage = ref('')
const modelSearchQuery = ref('')
const sub2ApiAccountLoading = ref(false)
const sub2ApiAccountStatus = shallowRef<Sub2ApiClientAccountStatus>()
const sub2ApiTestResult = shallowRef<Sub2ApiTestResult>()

const providerConfig = computed(() => providers.value[providerId] ?? {})
const providerRuntimeState = computed(() => providersStore.providerRuntimeState[providerId])
const providerModels = computed(() => providersStore.getModelsForProvider(providerId))
const isLoadingModels = computed(() => providersStore.isLoadingModels[providerId] || false)
const modelLoadError = computed(() => providersStore.modelLoadError[providerId] || null)

function readString(config: Record<string, unknown>, key: string, fallback = '') {
  const value = config[key]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function normalizeBaseUrl(value: unknown) {
  let baseUrl = typeof value === 'string' ? value.trim() : ''
  if (baseUrl && !baseUrl.endsWith('/'))
    baseUrl += '/'
  return baseUrl
}

function buildConfigHash(config: Record<string, unknown>) {
  return JSON.stringify({
    apiKey: readString(config, 'apiKey'),
    baseUrl: normalizeBaseUrl(config.baseUrl),
    preferredModel: readString(config, 'preferredModel'),
    protocol: readString(config, 'protocol', 'auto'),
    thinkingMode: readString(config, 'thinkingMode', 'auto'),
    reasoningEffort: readString(config, 'reasoningEffort', 'auto'),
    multimodalEnabled: config.multimodalEnabled === true,
    maxOutputTokens: readNumber(config, 'maxOutputTokens', 0),
    maxContextMessages: readNumber(config, 'maxContextMessages', 0),
    maxToolSteps: readNumber(config, 'maxToolSteps', 64),
  })
}

function readNumber(config: Record<string, unknown>, key: string, fallback = 0) {
  const value = config[key]
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

const isApiTestCurrent = computed(() => {
  return providerConfig.value.apiTestPassed === true
    && providerConfig.value.apiTestConfigHash === buildConfigHash(providerConfig.value)
})

const selectedModel = computed({
  get: () => readString(providerConfig.value, 'preferredModel', activeProvider.value === providerId ? activeModel.value : ''),
  set: (value: string) => {
    providerConfig.value.preferredModel = value
    if (activeProvider.value === providerId)
      activeModel.value = value
  },
})

const isDeepSeekProvider = computed(() => providerId === 'deepseek')
const isSub2ApiProvider = computed(() => providerId === 'sub2api')

const canTestApi = computed(() => {
  return (isSub2ApiProvider.value || !!readString(providerConfig.value, 'apiKey'))
    && !!normalizeBaseUrl(providerConfig.value.baseUrl)
    && !!selectedModel.value.trim()
})

const maxToolSteps = computed({
  get: () => readNumber(providerConfig.value, 'maxToolSteps', 64),
  set: (value: number | string) => {
    const parsed = typeof value === 'number' ? value : Number(value)
    providerConfig.value.maxToolSteps = Number.isFinite(parsed) ? Math.max(1, Math.min(200, Math.round(parsed))) : 64
  },
})

const deepSeekThinkingMode = computed({
  get: () => readString(providerConfig.value, 'thinkingMode', 'auto'),
  set: (value: string) => {
    providerConfig.value.thinkingMode = value
  },
})

const deepSeekReasoningEffort = computed({
  get: () => readString(providerConfig.value, 'reasoningEffort', 'auto'),
  set: (value: string) => {
    providerConfig.value.reasoningEffort = value
  },
})

const deepSeekMaxOutputTokens = computed({
  get: () => readNumber(providerConfig.value, 'maxOutputTokens', 0),
  set: (value: number | string) => {
    const parsed = typeof value === 'number' ? value : Number(value)
    providerConfig.value.maxOutputTokens = Number.isFinite(parsed) ? Math.max(0, Math.min(64000, Math.round(parsed))) : 0
  },
})

const deepSeekMaxContextMessages = computed({
  get: () => readNumber(providerConfig.value, 'maxContextMessages', 80),
  set: (value: number | string) => {
    const parsed = typeof value === 'number' ? value : Number(value)
    providerConfig.value.maxContextMessages = Number.isFinite(parsed) ? Math.max(0, Math.min(500, Math.round(parsed))) : 80
  },
})

// Define computed properties for credentials
const apiKey = computed({
  get: () => providers.value[providerId]?.apiKey || '',
  set: (value) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}
    providers.value[providerId].apiKey = value
  },
})

const baseUrl = computed({
  get: () => providers.value[providerId]?.baseUrl || '',
  set: (value) => {
    if (!providers.value[providerId])
      providers.value[providerId] = {}
    providers.value[providerId].baseUrl = value
  },
})

// Use the composable to get validation logic and state
const {
  t,
  router,
  providerMetadata,
  isValidating,
  isValid,
  validationMessage,
  handleResetSettings,
  forceValid,
  hasManualValidators,
  isManualTesting,
  manualTestPassed,
  manualTestMessage,
  runManualTest,
} = useProviderValidation(providerId)

const apiKeyPlaceholder = computed(() => {
  const definition = getDefinedProvider(providerId)
  if (!definition?.createProviderConfig)
    return 'sk-...'

  const schema = definition.createProviderConfig({ t }) as any
  const shape = typeof schema?.shape === 'function' ? schema.shape() : schema?.shape
  const apiKeySchema = shape?.apiKey
  if (!apiKeySchema)
    return 'sk-...'

  const meta = typeof apiKeySchema.meta === 'function' ? apiKeySchema.meta() : undefined
  return typeof meta?.placeholderLocalized === 'string' ? meta.placeholderLocalized : 'sk-...'
})

function ensureProviderConfig() {
  providersStore.initializeProvider(providerId)
  const config = providerConfig.value
  const defaultOptions = providerMetadata.value?.defaultOptions?.() || {}

  config.baseUrl = normalizeBaseUrl(config.baseUrl || defaultOptions.baseUrl)
  config.apiTestPassed ??= false
  config.apiTestConfigHash ??= ''
  config.preferredModel ??= activeProvider.value === providerId ? activeModel.value : ''
  config.maxToolSteps ??= defaultOptions.maxToolSteps ?? 64
  if (providerId === 'sub2api') {
    config.protocol ??= defaultOptions.protocol ?? 'auto'
    config.reasoningEffort ??= defaultOptions.reasoningEffort ?? 'auto'
    config.multimodalEnabled ??= defaultOptions.multimodalEnabled ?? false
    config.accountApiBaseUrl ??= defaultOptions.accountApiBaseUrl ?? ''
    config.accountAccessToken ??= defaultOptions.accountAccessToken ?? ''
  }
  if (providerId === 'deepseek') {
    config.thinkingMode ??= defaultOptions.thinkingMode ?? 'auto'
    config.reasoningEffort ??= defaultOptions.reasoningEffort ?? 'auto'
    config.maxOutputTokens ??= defaultOptions.maxOutputTokens ?? 0
    config.maxContextMessages ??= defaultOptions.maxContextMessages ?? 80
  }

  return config
}

async function saveProviderConfig() {
  isSavingConfig.value = true
  connectionStatus.value = 'idle'
  connectionMessage.value = ''

  try {
    const config = ensureProviderConfig()
    providersStore.markProviderAdded(providerId)
    await providersStore.disposeProviderInstance(providerId)
    const valid = await providersStore.validateProvider(providerId, { force: true })
    connectionStatus.value = valid ? 'saved' : 'idle'
    connectionMessage.value = valid
      ? '配置已保存。下一步可以获取模型并测试当前模型。'
      : '配置已保存，但基础校验还没通过。请检查 API Key 和 Base URL。'
    if (valid)
      await fetchProviderModels()
    if (config.preferredModel && activeProvider.value === providerId)
      activeModel.value = config.preferredModel as string
  }
  catch (error) {
    connectionStatus.value = 'error'
    connectionMessage.value = errorMessageFrom(error) ?? '保存配置失败。'
  }
  finally {
    isSavingConfig.value = false
  }
}

async function fetchProviderModels() {
  isFetchingModels.value = true
  connectionStatus.value = 'loading-models'
  connectionMessage.value = '正在从 provider 拉取模型列表...'

  try {
    ensureProviderConfig()
    providersStore.markProviderAdded(providerId)
    await providersStore.disposeProviderInstance(providerId)
    const models = await providersStore.fetchModelsForProvider(providerId)
    if (!models.length)
      throw new Error(modelLoadError.value || '没有获取到模型。可手动输入模型名后再测试。')

    if (!selectedModel.value && !isSub2ApiProvider.value)
      selectedModel.value = models[0].id

    connectionStatus.value = 'saved'
    connectionMessage.value = `已获取 ${models.length} 个模型。请选择一个意识模型后测试。`
  }
  catch (error) {
    connectionStatus.value = 'error'
    connectionMessage.value = errorMessageFrom(error) ?? '获取模型失败。'
  }
  finally {
    isFetchingModels.value = false
  }
}

async function testApiAndEnableProvider() {
  isTestingApi.value = true
  connectionStatus.value = 'testing'
  connectionMessage.value = '正在用当前选择的模型发送一条很短的测试消息...'
  let testedProvider: ChatProvider | undefined
  let output = ''
  let firstTokenAt: number | undefined
  let returnedModel: string | undefined
  let usage: { prompt_tokens?: number, completion_tokens?: number, total_tokens?: number } | undefined
  const startedAt = performance.now()

  try {
    const config = ensureProviderConfig()
    const apiKey = readString(config, 'apiKey')
    const normalizedBaseUrl = normalizeBaseUrl(config.baseUrl)
    const model = selectedModel.value.trim()

    if (!apiKey && !isSub2ApiProvider.value)
      throw new Error('API Key 不能为空。')
    if (!normalizedBaseUrl)
      throw new Error('Base URL 不能为空。')
    if (!model)
      throw new Error('请先选择或输入一个模型。')

    config.apiTestPassed = false
    config.apiTestConfigHash = ''
    providersStore.markProviderAdded(providerId)
    await providersStore.disposeProviderInstance(providerId)

    config.baseUrl = normalizedBaseUrl
    testedProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
    await llmStore.stream(model, testedProvider, [{
      role: 'user',
      content: isSub2ApiProvider.value ? '请只回复 LUMI_SUB2API_OK' : '请只回复 OK',
    }], {
      supportsTools: false,
      waitForTools: false,
      maxSteps: 1,
      tools: [],
      toolTransform: () => [],
      onUsage(value) {
        usage = value
      },
      onStreamEvent(event) {
        if (event.type === 'text-delta') {
          firstTokenAt ??= performance.now()
          output += event.text
        }
        if (event.type === 'finish' && 'model' in event && typeof event.model === 'string')
          returnedModel = event.model
      },
    })
    const completedAt = performance.now()

    if (isSub2ApiProvider.value && !output.includes('LUMI_SUB2API_OK'))
      throw new Error(`Sub2API 已返回响应，但测试文本不匹配：${output || '空响应'}`)

    if (isSub2ApiProvider.value) {
      const diagnostics = getSub2ApiClientDiagnostics(testedProvider)
      sub2ApiTestResult.value = {
        success: true,
        output,
        protocol: diagnostics?.protocol ?? readString(config, 'protocol', 'auto'),
        fallbackUsed: diagnostics?.fallbackUsed ?? false,
        requestedModel: diagnostics?.requestedModel ?? model,
        resolvedModel: diagnostics?.resolvedModel ?? returnedModel,
        firstTokenLatencyMs: firstTokenAt === undefined ? undefined : Math.round(firstTokenAt - startedAt),
        durationMs: Math.round(completedAt - startedAt),
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        totalTokens: usage?.total_tokens,
      }
    }

    config.preferredModel = model
    config.apiTestPassed = true
    config.apiTestConfigHash = buildConfigHash(config)
    config.lastApiTestAt = new Date().toISOString()
    providersStore.forceProviderConfigured(providerId)
    await fetchProviderModels().catch(() => undefined)

    activeProvider.value = providerId
    activeModel.value = model

    connectionStatus.value = 'success'
    connectionMessage.value = 'API 测试通过，已保存并设为当前意识模块。'
  }
  catch (error) {
    providersStore.setProviderUnconfigured(providerId)
    const message = errorMessageFrom(error) ?? 'API 测试失败。'
    if (isSub2ApiProvider.value) {
      const diagnostics = getSub2ApiClientDiagnostics(testedProvider)
      sub2ApiTestResult.value = {
        success: false,
        error: message,
        output,
        protocol: diagnostics?.protocol ?? readString(providerConfig.value, 'protocol', 'auto'),
        fallbackUsed: diagnostics?.fallbackUsed ?? false,
        requestedModel: diagnostics?.requestedModel ?? selectedModel.value.trim(),
        resolvedModel: diagnostics?.resolvedModel ?? returnedModel,
        firstTokenLatencyMs: firstTokenAt === undefined ? undefined : Math.round(firstTokenAt - startedAt),
        durationMs: Math.round(performance.now() - startedAt),
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        totalTokens: usage?.total_tokens,
      }
    }
    connectionStatus.value = 'error'
    connectionMessage.value = message
  }
  finally {
    isTestingApi.value = false
  }
}

function updateSub2ApiConfig(patch: Partial<Sub2ApiClientConfig>) {
  Object.assign(providerConfig.value, patch)
  if ('accountApiBaseUrl' in patch || 'accountAccessToken' in patch)
    sub2ApiAccountStatus.value = undefined
}

async function refreshSub2ApiAccount() {
  sub2ApiAccountLoading.value = true
  try {
    sub2ApiAccountStatus.value = await fetchSub2ApiClientAccountStatus(
      ensureProviderConfig() as Sub2ApiClientConfig,
    )
  }
  catch (error) {
    connectionStatus.value = 'error'
    connectionMessage.value = errorMessageFrom(error) ?? '账户状态查询失败。'
  }
  finally {
    sub2ApiAccountLoading.value = false
  }
}

function goToModelSelection() {
  activeProvider.value = providerId
  if (selectedModel.value)
    activeModel.value = selectedModel.value
  router.push('/settings/modules/consciousness')
}

onMounted(async () => {
  ensureProviderConfig()
  if (providerRuntimeState.value?.isConfigured && providerModels.value.length === 0)
    await providersStore.fetchModelsForProvider(providerId)
})
</script>

<template>
  <ProviderSettingsLayout
    :provider-name="providerMetadata?.localizedName"
    :provider-icon="providerMetadata?.icon"
    :provider-icon-color="providerMetadata?.iconColor"
    :on-back="() => router.back()"
  >
    <ProviderSettingsContainer>
      <ProviderBasicSettings
        :title="t('settings.pages.providers.common.section.basic.title')"
        :description="t('settings.pages.providers.common.section.basic.description')"
        :on-reset="handleResetSettings"
      >
        <ProviderApiKeyInput
          v-model="apiKey"
          :provider-name="providerMetadata?.localizedName"
          :placeholder="apiKeyPlaceholder"
        />
      </ProviderBasicSettings>

      <ProviderAdvancedSettings
        :title="t('settings.pages.providers.common.section.advanced.title')"
        :initial-visible="isSub2ApiProvider"
      >
        <ProviderBaseUrlInput
          v-model="baseUrl"
          :placeholder="providerMetadata?.defaultOptions?.().baseUrl as string || 'Base URL of your provider'"
        />

        <Sub2ApiClientSettings
          v-if="isSub2ApiProvider"
          :config="providerConfig"
          :account-status="sub2ApiAccountStatus"
          :account-loading="sub2ApiAccountLoading"
          :test-result="sub2ApiTestResult"
          :class="['mt-5']"
          @change="updateSub2ApiConfig"
          @refresh-account="refreshSub2ApiAccount"
        />

        <label v-else class="grid mt-4 gap-1">
          <span class="text-sm font-medium">最大工具步数</span>
          <input
            v-model.number="maxToolSteps"
            type="number"
            min="1"
            max="200"
            step="1"
            class="border border-neutral-200 rounded-lg bg-white px-3 py-2 text-sm outline-none dark:border-neutral-800 dark:bg-neutral-950"
          >
          <span class="text-xs opacity-60">一次回复中允许意识模型连续调用工具的最大步数。浏览器、MCP、批量操作任务可适当调高；默认 64，最高 200。</span>
        </label>

        <div v-if="isDeepSeekProvider" class="grid mt-4 gap-4">
          <div class="border border-cyan-500/30 rounded-lg bg-cyan-500/10 p-3 text-sm text-cyan-900 dark:text-cyan-100">
            <div class="font-semibold">
              DeepSeek 官方参数
            </div>
            <div class="mt-1 opacity-80">
              思考开关会写入 extra_body.thinking；思考强度会写入 reasoning_effort。最大上下文这里指 AIRI 发送给意识模型的最近历史消息条数，不是 DeepSeek 模型自身的上下文窗口。
            </div>
          </div>

          <label class="grid gap-1">
            <span class="text-sm font-medium">思考模式</span>
            <select
              v-model="deepSeekThinkingMode"
              class="border border-neutral-200 rounded-lg bg-white px-3 py-2 text-sm outline-none dark:border-neutral-800 dark:bg-neutral-950"
            >
              <option value="auto">自动（不显式传参）</option>
              <option value="enabled">开启</option>
              <option value="disabled">关闭</option>
            </select>
            <span class="text-xs opacity-60">DeepSeek 文档中默认开启；选择“自动”时不额外覆盖官方默认行为。</span>
          </label>

          <label class="grid gap-1">
            <span class="text-sm font-medium">思考强度</span>
            <select
              v-model="deepSeekReasoningEffort"
              class="border border-neutral-200 rounded-lg bg-white px-3 py-2 text-sm outline-none dark:border-neutral-800 dark:bg-neutral-950"
            >
              <option value="auto">自动</option>
              <option value="high">high</option>
              <option value="max">max</option>
            </select>
            <span class="text-xs opacity-60">官方 OpenAI 格式主要支持 high / max；low、medium 会被官方兼容映射，不在这里暴露。</span>
          </label>

          <label class="grid gap-1">
            <span class="text-sm font-medium">最大输出 Token</span>
            <input
              v-model.number="deepSeekMaxOutputTokens"
              type="number"
              min="0"
              max="64000"
              step="1024"
              class="border border-neutral-200 rounded-lg bg-white px-3 py-2 text-sm outline-none dark:border-neutral-800 dark:bg-neutral-950"
            >
            <span class="text-xs opacity-60">0 表示不覆盖默认值；DeepSeek 思考模型文档上限为 64K，且包含思维链输出。</span>
          </label>

          <label class="grid gap-1">
            <span class="text-sm font-medium">最大上下文历史消息条数</span>
            <input
              v-model.number="deepSeekMaxContextMessages"
              type="number"
              min="0"
              max="500"
              step="10"
              class="border border-neutral-200 rounded-lg bg-white px-3 py-2 text-sm outline-none dark:border-neutral-800 dark:bg-neutral-950"
            >
            <span class="text-xs opacity-60">0 表示不裁剪；默认 80。系统提示、画像、记忆与当前消息仍会正常加入。</span>
          </label>
        </div>
      </ProviderAdvancedSettings>

      <div flex="~ col gap-3">
        <div
          class="border rounded-lg px-4 py-3 text-sm"
          :class="{
            'border-emerald-400/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200': providerRuntimeState?.isConfigured && isApiTestCurrent,
            'border-amber-400/50 bg-amber-500/10 text-amber-700 dark:text-amber-200': !(providerRuntimeState?.isConfigured && isApiTestCurrent) && connectionStatus !== 'error',
            'border-red-400/50 bg-red-500/10 text-red-700 dark:text-red-200': connectionStatus === 'error',
          }"
        >
          <div class="flex items-center gap-2 font-medium">
            <div
              class="size-2.5 rounded-full"
              :class="providerRuntimeState?.isConfigured && isApiTestCurrent ? 'bg-emerald-500' : connectionStatus === 'error' ? 'bg-red-500' : 'bg-amber-500'"
            />
            <span>{{ providerRuntimeState?.isConfigured && isApiTestCurrent ? '当前意识 API 已通过测试' : '当前意识 API 尚未通过测试' }}</span>
          </div>
          <div class="mt-1 opacity-80">
            {{ connectionMessage || '保存配置后获取模型，选择模型并测试；测试成功后会设为当前意识模块。' }}
          </div>
        </div>

        <div class="flex flex-wrap gap-3">
          <button
            type="button"
            class="inline-flex items-center gap-2 border border-neutral-300 rounded-lg px-4 py-2 text-sm transition-colors disabled:cursor-not-allowed dark:border-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
            :disabled="isSavingConfig || isFetchingModels || isTestingApi"
            @click="saveProviderConfig"
          >
            <div i-solar:diskette-bold-duotone />
            <span>{{ isSavingConfig ? '保存中...' : '保存配置' }}</span>
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-2 border border-neutral-300 rounded-lg px-4 py-2 text-sm transition-colors disabled:cursor-not-allowed dark:border-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
            :disabled="isSavingConfig || isFetchingModels || isTestingApi || (!isSub2ApiProvider && !apiKey) || !baseUrl"
            @click="fetchProviderModels"
          >
            <div :class="isFetchingModels || isLoadingModels ? 'i-solar:refresh-bold-duotone animate-spin' : 'i-solar:list-check-bold-duotone'" />
            <span>{{ isFetchingModels || isLoadingModels ? '获取中...' : '获取模型' }}</span>
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-lg bg-primary-500 px-4 py-2 text-sm text-white transition-colors disabled:cursor-not-allowed hover:bg-primary-600 disabled:opacity-50"
            :disabled="isSavingConfig || isFetchingModels || isTestingApi || !canTestApi"
            @click="testApiAndEnableProvider"
          >
            <div :class="isTestingApi ? 'i-solar:refresh-bold-duotone animate-spin' : 'i-solar:check-circle-bold-duotone'" />
            <span>{{ isTestingApi ? '测试中...' : '测试并启用' }}</span>
          </button>
        </div>
      </div>

      <ProviderAdvancedSettings title="模型选择" :initial-visible="isSub2ApiProvider">
        <div flex="~ col gap-4">
          <div v-if="modelLoadError">
            <ErrorContainer title="模型获取失败" :error="modelLoadError" />
          </div>

          <template v-if="providerModels.length > 0">
            <RadioCardManySelect
              v-model="selectedModel"
              v-model:search-query="modelSearchQuery"
              :items="providerModels"
              :searchable="true"
              :allow-custom="true"
              search-placeholder="搜索模型..."
              search-no-results-title="没有找到模型"
              search-no-results-description="可以直接输入模型 ID。"
              search-results-text="{count} / {total} 个模型"
              custom-input-placeholder="输入自定义模型 ID"
              expand-button-text="显示更多"
              collapse-button-text="收起"
              custom-option-description="自定义模型"
              expanded-class="mb-12"
            />
          </template>
          <template v-else>
            <Alert type="info">
              <template #title>
                尚未获取模型
              </template>
              <template #content>
                先点击“获取模型”。如果中转站不支持 /models，也可以在搜索框里直接输入模型 ID。
              </template>
            </Alert>
            <RadioCardManySelect
              v-model="selectedModel"
              v-model:search-query="modelSearchQuery"
              :items="[]"
              :searchable="true"
              :allow-custom="true"
              search-placeholder="输入模型 ID..."
              search-no-results-title="输入后即可作为自定义模型"
              search-no-results-description="{query}"
              search-results-text="{count} / {total} 个模型"
              custom-input-placeholder="输入自定义模型 ID"
              expand-button-text="显示更多"
              collapse-button-text="收起"
              custom-option-description="自定义模型"
            />
          </template>
        </div>
      </ProviderAdvancedSettings>

      <ProviderValidationAlerts
        :is-valid="isValid"
        :is-validating="isValidating"
        :validation-message="validationMessage"
        :has-manual-validators="hasManualValidators"
        :is-manual-testing="isManualTesting"
        :manual-test-passed="manualTestPassed"
        :manual-test-message="manualTestMessage"
        :on-run-test="runManualTest"
        :on-force-valid="forceValid"
        :on-go-to-model-selection="goToModelSelection"
      />
    </ProviderSettingsContainer>
  </ProviderSettingsLayout>
</template>

<route lang="yaml">
meta:
  layout: settings
  stageTransition:
    name: slide
</route>
