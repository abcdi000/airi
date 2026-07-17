<script setup lang="ts">
import type { RemovableRef } from '@vueuse/core'

import {
  Alert,
  ErrorContainer,
  ProviderAdvancedSettings,
  ProviderApiKeyInput,
  ProviderBaseUrlInput,
  ProviderBasicSettings,
  ProviderSettingsContainer,
  ProviderSettingsLayout,
  RadioCardManySelect,
} from '@proj-airi/stage-ui/components'
import { useLLM } from '@proj-airi/stage-ui/stores/llm'
import { useVisionStore } from '@proj-airi/stage-ui/stores/modules/vision'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const DASHSCOPE_BASE_CN = 'https://dashscope.aliyuncs.com/compatible-mode/v1/'
const DASHSCOPE_BASE_INTL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/'
const DEFAULT_VISION_MODEL = 'qwen3-vl-flash'
const TEST_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAA3SURBVFhH7c6xDQAgDAQxJmFmNn56epIUPul6rzQHMA+wz9/fAAAAAAAAAAAAAADmAaoDaAYkF35O/LUr4oiXAAAAAElFTkSuQmCC'

type ConnectionStatus = 'idle' | 'saved' | 'loading-models' | 'testing' | 'success' | 'error'

const route = useRoute()
const router = useRouter()
const providerId = route.params.providerId as string
const providersStore = useProvidersStore()
const visionStore = useVisionStore()
const llmStore = useLLM()
const { providers } = storeToRefs(providersStore) as { providers: RemovableRef<Record<string, any>> }
const { activeProvider, activeModel } = storeToRefs(visionStore)

const isSavingConfig = ref(false)
const isFetchingModels = ref(false)
const isTestingApi = ref(false)
const connectionStatus = ref<ConnectionStatus>('idle')
const connectionMessage = ref('')
const modelSearchQuery = ref('')

const providerMetadata = computed(() => providersStore.getProviderMetadata(providerId))
const providerConfig = computed(() => providers.value[providerId] ??= {})
const providerRuntimeState = computed(() => providersStore.providerRuntimeState[providerId])
const providerModels = computed(() => providersStore.getVisionModelsForProvider(providerId))
const isLoadingModels = computed(() => providersStore.isLoadingVisionModels[providerId] || false)
const modelLoadError = computed(() => providersStore.visionModelLoadError[providerId] || null)
const isDashscopeVisionProvider = computed(() => providerId === 'alibaba-cloud-model-studio-vision')
const defaultBaseUrl = computed(() => providerMetadata.value?.defaultOptions?.().baseUrl as string || 'https://api.openai.com/v1/')

function readString(config: Record<string, unknown>, key: string, fallback = '') {
  const value = config[key]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function normalizeBaseUrl(value: unknown, fallback = '') {
  let baseUrl = typeof value === 'string' ? value.trim() : ''
  if (!baseUrl)
    baseUrl = fallback
  if (baseUrl && !baseUrl.endsWith('/'))
    baseUrl += '/'
  return baseUrl
}

function normalizedVisionBaseUrl(config: Record<string, unknown>) {
  const fallback = isDashscopeVisionProvider.value
    ? readString(config, 'region', 'cn') === 'intl'
      ? DASHSCOPE_BASE_INTL
      : DASHSCOPE_BASE_CN
    : defaultBaseUrl.value
  return normalizeBaseUrl(config.baseUrl, fallback)
}

function buildConfigHash(config: Record<string, unknown>) {
  if (!isDashscopeVisionProvider.value) {
    return JSON.stringify({
      apiKey: readString(config, 'apiKey'),
      baseUrl: normalizedVisionBaseUrl(config),
      preferredVisionModel: readString(config, 'preferredVisionModel'),
    })
  }

  return JSON.stringify({
    apiKey: readString(config, 'apiKey'),
    baseUrl: normalizedVisionBaseUrl(config),
    preferredVisionModel: readString(config, 'preferredVisionModel', DEFAULT_VISION_MODEL),
    region: readString(config, 'region', 'cn'),
  })
}

const apiKey = computed({
  get: () => providers.value[providerId]?.apiKey || '',
  set: (value) => {
    providers.value[providerId] ??= {}
    providers.value[providerId].apiKey = value
  },
})

const baseUrl = computed({
  get: () => providers.value[providerId]?.baseUrl || '',
  set: (value) => {
    providers.value[providerId] ??= {}
    providers.value[providerId].baseUrl = value
  },
})

const region = computed({
  get: () => readString(providerConfig.value, 'region', 'cn'),
  set: (value: string) => {
    providerConfig.value.region = value
    providerConfig.value.baseUrl = value === 'intl' ? DASHSCOPE_BASE_INTL : DASHSCOPE_BASE_CN
  },
})

const selectedModel = computed({
  get: () => readString(
    providerConfig.value,
    'preferredVisionModel',
    activeProvider.value === providerId ? activeModel.value : isDashscopeVisionProvider.value ? DEFAULT_VISION_MODEL : '',
  ),
  set: (value: string) => {
    providerConfig.value.preferredVisionModel = value
    if (activeProvider.value === providerId)
      activeModel.value = value
  },
})

const isApiTestCurrent = computed(() => {
  return providerConfig.value.apiTestPassed === true
    && providerConfig.value.apiTestConfigHash === buildConfigHash(providerConfig.value)
})

const canTestApi = computed(() => {
  return !!apiKey.value && !!normalizedVisionBaseUrl(providerConfig.value) && !!selectedModel.value.trim()
})

function ensureProviderConfig() {
  providersStore.initializeProvider(providerId)
  const config = providerConfig.value
  const defaultOptions = providerMetadata.value?.defaultOptions?.() || {}

  if (isDashscopeVisionProvider.value)
    config.region ??= 'cn'
  config.baseUrl = normalizedVisionBaseUrl({ ...defaultOptions, ...config })
  if (isDashscopeVisionProvider.value)
    config.preferredVisionModel ??= DEFAULT_VISION_MODEL
  config.apiTestPassed ??= false
  config.apiTestConfigHash ??= ''

  return config
}

async function saveProviderConfig() {
  isSavingConfig.value = true
  connectionStatus.value = 'idle'
  connectionMessage.value = ''

  try {
    ensureProviderConfig()
    providersStore.markProviderAdded(providerId)
    await providersStore.disposeProviderInstance(providerId)
    const valid = await providersStore.validateProvider(providerId, { force: true })
    connectionStatus.value = valid ? 'saved' : 'idle'
    connectionMessage.value = valid
      ? '视觉服务配置已保存，可以在视觉模块中使用。'
      : '配置已保存。请先运行图片测试，通过后才会在视觉模块中点亮。'
  }
  catch (error) {
    connectionStatus.value = 'error'
    connectionMessage.value = error instanceof Error ? error.message : '保存配置失败。'
  }
  finally {
    isSavingConfig.value = false
  }
}

async function fetchProviderModels() {
  isFetchingModels.value = true
  connectionStatus.value = 'loading-models'
  connectionMessage.value = '正在获取支持视觉理解的模型...'

  try {
    ensureProviderConfig()
    providersStore.markProviderAdded(providerId)
    await providersStore.disposeProviderInstance(providerId)
    const models = await providersStore.fetchVisionModelsForProvider(providerId)

    if (!models.length)
      throw new Error(modelLoadError.value || '没有检测到视觉模型。纯文本模型会被视觉模块隐藏。')

    if (!selectedModel.value)
      selectedModel.value = models[0].id

    connectionStatus.value = 'saved'
    connectionMessage.value = `已检测到 ${models.length} 个视觉模型。请选择一个模型后运行图片测试。`
  }
  catch (error) {
    connectionStatus.value = 'error'
    connectionMessage.value = error instanceof Error ? error.message : '获取模型失败。'
  }
  finally {
    isFetchingModels.value = false
  }
}

async function testApiAndEnableProvider() {
  isTestingApi.value = true
  connectionStatus.value = 'testing'
  connectionMessage.value = '正在向当前视觉模型发送一张 32x32 测试图片...'

  try {
    const config = ensureProviderConfig()
    const model = selectedModel.value.trim()
    if (!readString(config, 'apiKey'))
      throw new Error('API Key 不能为空。')
    if (!model)
      throw new Error('请先选择或输入一个视觉模型。')

    config.apiTestPassed = false
    config.apiTestConfigHash = ''
    config.baseUrl = normalizedVisionBaseUrl(config)
    providersStore.markProviderAdded(providerId)
    await providersStore.disposeProviderInstance(providerId)

    const provider = await providersStore.getProviderInstance<any>(providerId)
    let output = ''
    await llmStore.stream(model, provider, [{
      role: 'user',
      content: [
        { type: 'text', text: 'This is an image capability test. Reply with OK and nothing else if you can read this request.' },
        { type: 'image_url', image_url: { url: TEST_IMAGE_DATA_URL } },
      ],
    } as any], {
      supportsTools: false,
      waitForTools: false,
      captureToolErrors: false,
      onStreamEvent: (event) => {
        if (event.type === 'text-delta')
          output += event.text
      },
    })

    config.preferredVisionModel = model
    config.apiTestPassed = true
    config.apiTestConfigHash = buildConfigHash(config)
    config.lastApiTestAt = new Date().toISOString()
    providersStore.forceProviderConfigured(providerId)
    activeProvider.value = providerId
    activeModel.value = model
    await fetchProviderModels().catch(() => undefined)

    connectionStatus.value = 'success'
    connectionMessage.value = `图片测试通过${output.trim() ? `：${output.trim().slice(0, 120)}` : ''}。视觉模块已启用该服务来源。`
  }
  catch (error) {
    providersStore.setProviderUnconfigured(providerId)
    connectionStatus.value = 'error'
    connectionMessage.value = error instanceof Error ? error.message : '视觉 API 测试失败。'
  }
  finally {
    isTestingApi.value = false
  }
}

onMounted(async () => {
  ensureProviderConfig()
  if (providerRuntimeState.value?.isConfigured && providerModels.value.length === 0)
    await providersStore.fetchVisionModelsForProvider(providerId)
})
</script>

<template>
  <ProviderSettingsLayout
    :provider-name="providerMetadata.localizedName"
    :provider-icon="providerMetadata.icon"
    :provider-icon-color="providerMetadata.iconColor"
    :on-back="() => router.back()"
  >
    <ProviderSettingsContainer>
      <ProviderBasicSettings
        title="视觉 API"
        description="为视觉模块配置图片理解服务来源。"
      >
        <ProviderApiKeyInput
          v-model="apiKey"
          :provider-name="providerMetadata.localizedName"
          placeholder="sk-..."
        />
      </ProviderBasicSettings>

      <ProviderAdvancedSettings title="接口地址">
        <div flex="~ col gap-4">
          <label v-if="isDashscopeVisionProvider" flex="~ col gap-2">
            <span text="sm neutral-500 dark:neutral-400">区域</span>
            <select
              v-model="region"
              class="rounded-lg border border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="cn">中国大陆</option>
              <option value="intl">国际站</option>
            </select>
          </label>
          <ProviderBaseUrlInput
            v-model="baseUrl"
            label="接口地址"
            description="OpenAI 兼容接口地址。千问百炼国内站使用 https://dashscope.aliyuncs.com/compatible-mode/v1/"
            :placeholder="defaultBaseUrl"
          />
        </div>
      </ProviderAdvancedSettings>

      <div flex="~ col gap-3">
        <div
          class="rounded-lg border px-4 py-3 text-sm"
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
            <span>{{ providerRuntimeState?.isConfigured && isApiTestCurrent ? '视觉 API 已通过图片测试' : '视觉 API 尚未通过图片测试' }}</span>
          </div>
          <div class="mt-1 opacity-80">
            {{ connectionMessage || '保存配置后获取视觉模型，再运行图片测试。只有测试通过的视觉模型才会点亮视觉模块。' }}
          </div>
        </div>

        <div class="flex flex-wrap gap-3">
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-4 py-2 text-sm transition-colors dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="isSavingConfig || isFetchingModels || isTestingApi"
            @click="saveProviderConfig"
          >
            <div i-solar:diskette-bold-duotone />
            <span>{{ isSavingConfig ? '保存中...' : '保存配置' }}</span>
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-4 py-2 text-sm transition-colors dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="isSavingConfig || isFetchingModels || isTestingApi || !apiKey || !baseUrl"
            @click="fetchProviderModels"
          >
            <div :class="isFetchingModels || isLoadingModels ? 'i-solar:refresh-bold-duotone animate-spin' : 'i-solar:list-check-bold-duotone'" />
            <span>{{ isFetchingModels || isLoadingModels ? '获取中...' : '获取视觉模型' }}</span>
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-lg bg-primary-500 px-4 py-2 text-sm text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="isSavingConfig || isFetchingModels || isTestingApi || !canTestApi"
            @click="testApiAndEnableProvider"
          >
            <div :class="isTestingApi ? 'i-solar:refresh-bold-duotone animate-spin' : 'i-solar:check-circle-bold-duotone'" />
            <span>{{ isTestingApi ? '测试中...' : '测试图片并启用' }}</span>
          </button>
        </div>
      </div>

      <ProviderAdvancedSettings title="视觉模型">
        <div flex="~ col gap-4">
          <div v-if="modelLoadError">
            <ErrorContainer title="获取视觉模型失败" :error="modelLoadError" />
          </div>

          <template v-if="providerModels.length > 0">
            <RadioCardManySelect
              v-model="selectedModel"
              v-model:search-query="modelSearchQuery"
              :items="providerModels"
              :searchable="true"
              :allow-custom="true"
              search-placeholder="搜索视觉模型..."
              search-no-results-title="没有找到视觉模型"
              search-no-results-description="这里只显示支持视觉理解的模型。"
              search-results-text="{count} / {total} 个模型"
              custom-input-placeholder="输入自定义视觉模型 ID"
              expand-button-text="显示更多"
              collapse-button-text="收起"
              custom-option-description="自定义视觉模型"
              expanded-class="mb-12"
            />
          </template>
          <template v-else>
            <Alert type="info">
              <template #title>
                尚未加载视觉模型
              </template>
              <template #content>
                点击“获取视觉模型”。如果服务来源不支持列出模型，也可以手动输入一个已知的视觉模型 ID。
              </template>
            </Alert>
            <RadioCardManySelect
              v-model="selectedModel"
              v-model:search-query="modelSearchQuery"
              :items="[]"
              :searchable="true"
              :allow-custom="true"
              search-placeholder="输入模型 ID..."
              search-no-results-title="使用该内容作为自定义模型"
              search-no-results-description="{query}"
              search-results-text="{count} / {total} 个模型"
              custom-input-placeholder="输入自定义视觉模型 ID"
              expand-button-text="显示更多"
              collapse-button-text="收起"
              custom-option-description="自定义视觉模型"
            />
          </template>
        </div>
      </ProviderAdvancedSettings>
    </ProviderSettingsContainer>
  </ProviderSettingsLayout>
</template>

<route lang="yaml">
meta:
  layout: settings
  stageTransition:
    name: slide
</route>
