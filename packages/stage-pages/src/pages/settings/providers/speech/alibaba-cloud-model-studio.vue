<script setup lang="ts">
import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import {
  SpeechPlayground,
  SpeechProviderSettings,
} from '@proj-airi/stage-ui/components'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { FieldCheckbox, FieldInput, FieldRange, FieldTextArea } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const providerId = 'alibaba-cloud-model-studio'
const defaultModel = 'cosyvoice-v3.5-flash'
const defaultVoiceId = 'cosyvoice-v3.5-flash-lumi-7e8e554c8a344a3eb13a9d3f729f0750'

const defaultVoiceSettings = {
  speed: 1.0,
}

type ConnectionStatus = 'idle' | 'saved' | 'testing' | 'success' | 'error'

const pitch = ref<number>(0)
const speed = ref<number>(1.0)
const volume = ref<number>(0)
const isSavingConfig = ref(false)
const isTestingApi = ref(false)
const connectionStatus = ref<ConnectionStatus>('idle')
const connectionMessage = ref('')

const speechStore = useSpeechStore()
const providersStore = useProvidersStore()
const { providers } = storeToRefs(providersStore)
const { t } = useI18n()

// Check if API key is configured
const apiKeyConfigured = computed(() => !!providers.value[providerId]?.apiKey)
const providerConfig = computed(() => providers.value[providerId] ??= {})
const providerRuntimeState = computed(() => providersStore.providerRuntimeState[providerId])
const isApiTestCurrent = computed(() => {
  return providerConfig.value.apiTestPassed === true
    && providerConfig.value.apiTestConfigHash === buildConfigHash(providerConfig.value)
})

const customVoiceId = computed({
  get: () => providerConfig.value.customVoiceId as string || defaultVoiceId,
  set: value => providerConfig.value.customVoiceId = value,
})

const region = computed({
  get: () => providerConfig.value.region as string || 'cn',
  set: (value: string) => {
    providerConfig.value.region = value
    if (value === 'cn')
      providerConfig.value.baseUrl = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
    else
      providerConfig.value.baseUrl = 'https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
  },
})

const format = computed({
  get: () => providerConfig.value.format as string || 'wav',
  set: value => providerConfig.value.format = value,
})

const sampleRate = computed({
  get: () => String(providerConfig.value.sampleRate ?? 24000),
  set: (value: string | number) => {
    const parsed = Number(value)
    providerConfig.value.sampleRate = Number.isFinite(parsed) ? parsed : 24000
  },
})

const languageHint = computed({
  get: () => providerConfig.value.languageHint as string || 'zh',
  set: value => providerConfig.value.languageHint = value,
})

const instruction = computed({
  get: () => providerConfig.value.instruction as string || '',
  set: value => providerConfig.value.instruction = value,
})

const streamOutput = computed({
  get: () => providerConfig.value.streamOutput === true,
  set: value => providerConfig.value.streamOutput = value,
})

const availableVoices = computed(() => {
  return speechStore.availableVoices[providerId] || []
})

function readString(config: Record<string, unknown>, key: string, fallback = '') {
  const value = config[key]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function readNumber(config: Record<string, unknown>, key: string, fallback: number) {
  const value = config[key]
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizedBaseUrl(config: Record<string, unknown>) {
  const baseUrl = readString(config, 'baseUrl')
  if (baseUrl && !baseUrl.includes('unspeech.hyp3r.link'))
    return baseUrl

  return readString(config, 'region', 'cn') === 'intl'
    ? 'https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
    : 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
}

function buildConfigHash(config: Record<string, unknown>) {
  return JSON.stringify({
    apiKey: readString(config, 'apiKey'),
    baseUrl: normalizedBaseUrl(config),
    model: readString(config, 'model', defaultModel),
    customVoiceId: readString(config, 'customVoiceId', defaultVoiceId),
    region: readString(config, 'region', 'cn'),
    format: readString(config, 'format', 'wav'),
    sampleRate: readNumber(config, 'sampleRate', 24000),
    languageHint: readString(config, 'languageHint', 'zh'),
  })
}

function ensureDefaultConfig() {
  providersStore.initializeProvider(providerId)
  const config = providersStore.getProviderConfig(providerId)
  config.region ??= 'cn'
  config.baseUrl = normalizedBaseUrl(config)
  config.model ??= defaultModel
  config.customVoiceId ??= defaultVoiceId
  config.format ??= 'wav'
  config.sampleRate ??= 24000
  config.languageHint ??= 'zh'
  config.apiTestPassed ??= false
  config.apiTestConfigHash ??= ''
  return config
}

async function refreshProviderModelsAndVoices() {
  const config = providersStore.getProviderConfig(providerId)
  await providersStore.fetchModelsForProvider(providerId)
  await speechStore.loadVoicesForProvider(providerId, config.model as string | undefined)
}

async function saveProviderConfig() {
  isSavingConfig.value = true
  connectionStatus.value = 'idle'
  connectionMessage.value = ''

  try {
    ensureDefaultConfig()
    providersStore.markProviderAdded(providerId)
    await providersStore.disposeProviderInstance(providerId)
    const valid = await providersStore.validateProvider(providerId, { force: true })
    if (valid)
      await refreshProviderModelsAndVoices()
    connectionStatus.value = valid ? 'saved' : 'idle'
    connectionMessage.value = valid
      ? '配置已保存，API 测试仍然有效。'
      : '配置已保存。当前配置还没有通过 API 测试，测试通过后才会在发声模块中点亮。'
  }
  catch (error) {
    connectionStatus.value = 'error'
    connectionMessage.value = error instanceof Error ? error.message : '保存配置失败。'
  }
  finally {
    isSavingConfig.value = false
  }
}

async function testApiAndEnableProvider() {
  isTestingApi.value = true
  connectionStatus.value = 'testing'
  connectionMessage.value = '正在调用千问百炼生成一段很短的测试音频...'

  try {
    const config = ensureDefaultConfig()
    config.apiTestPassed = false
    config.apiTestConfigHash = ''
    providersStore.markProviderAdded(providerId)
    await providersStore.disposeProviderInstance(providerId)

    const model = readString(config, 'model', defaultModel)
    const voiceId = readString(config, 'customVoiceId', defaultVoiceId)
    const audio = await handleGenerateSpeech('Lumi 发声 API 测试。', voiceId, false)
    if (!audio.byteLength)
      throw new Error('千问百炼返回了空音频。')

    config.apiTestPassed = true
    config.apiTestConfigHash = buildConfigHash(config)
    config.lastApiTestAt = new Date().toISOString()
    providersStore.forceProviderConfigured(providerId)
    await refreshProviderModelsAndVoices()

    speechStore.activeSpeechProvider = providerId
    speechStore.activeSpeechModel = model
    speechStore.activeSpeechVoiceId = voiceId
    speechStore.activeSpeechVoice = {
      id: voiceId,
      name: voiceId.includes('lumi') ? 'Lumi Clone' : voiceId,
      description: 'CosyVoice cloned/custom voice_id.',
      previewURL: '',
      languages: [{ code: 'zh-CN', title: 'Chinese' }],
      provider: providerId,
      gender: 'female',
    }

    connectionStatus.value = 'success'
    connectionMessage.value = 'API 测试通过，已启用千问百炼并设为当前发声模块。'
  }
  catch (error) {
    providersStore.setProviderUnconfigured(providerId)
    connectionStatus.value = 'error'
    connectionMessage.value = error instanceof Error ? error.message : '千问百炼 API 测试失败。'
  }
  finally {
    isTestingApi.value = false
  }
}

async function handleGenerateSpeech(input: string, voiceId: string, _useSSML: boolean) {
  const provider = await providersStore.getProviderInstance(providerId) as SpeechProviderWithExtraOptions<string, any>
  if (!provider) {
    throw new Error('Failed to initialize speech provider')
  }

  const currentConfig = providersStore.getProviderConfig(providerId)
  const model = currentConfig.model as string | undefined || defaultModel

  return await speechStore.speech(
    provider,
    model,
    input,
    voiceId || customVoiceId.value,
    {
      ...currentConfig,
      ...defaultVoiceSettings,
    },
  )
}

onMounted(async () => {
  const providerConfig = ensureDefaultConfig()
  const providerMetadata = providersStore.getProviderMetadata(providerId)
  const validation = await providerMetadata.validators.validateProviderConfig(providerConfig)
  if (validation.valid) {
    await speechStore.loadVoicesForProvider(providerId, providerConfig.model as string | undefined)
  }
  else {
    console.info('Alibaba Cloud Model Studio is saved but not enabled yet:', validation.reason)
  }
})

watch(pitch, async () => {
  const providerConfig = providersStore.getProviderConfig(providerId)
  providerConfig.pitch = pitch.value
})

watch(speed, async () => {
  const providerConfig = providersStore.getProviderConfig(providerId)
  providerConfig.speed = speed.value
})

watch(volume, async () => {
  const providerConfig = providersStore.getProviderConfig(providerId)
  providerConfig.volume = volume.value
})

watch(providers, async () => {
  const providerConfig = providersStore.getProviderConfig(providerId)
  const providerMetadata = providersStore.getProviderMetadata(providerId)
  const validation = await providerMetadata.validators.validateProviderConfig(providerConfig)
  if (validation.valid) {
    await speechStore.loadVoicesForProvider(providerId)
  }
  else {
    console.info('Alibaba Cloud Model Studio config is not enabled yet:', validation.reason)
  }
}, {
  immediate: true,
})
</script>

<template>
  <SpeechProviderSettings
    :provider-id="providerId"
    :default-model="defaultModel"
    :additional-settings="defaultVoiceSettings"
  >
    <template #basic-settings>
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
            <span>{{ providerRuntimeState?.isConfigured && isApiTestCurrent ? '千问百炼已通过 API 测试' : '千问百炼尚未通过 API 测试' }}</span>
          </div>
          <div class="mt-1 opacity-80">
            {{ connectionMessage || '保存后点击“测试并启用”，成功后它会出现在发声模块并点亮。' }}
          </div>
        </div>

        <div class="flex flex-wrap gap-3">
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-lg border border-neutral-300 px-4 py-2 text-sm transition-colors dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="isSavingConfig || isTestingApi"
            @click="saveProviderConfig"
          >
            <div i-solar:diskette-bold-duotone />
            <span>{{ isSavingConfig ? '保存中...' : '保存配置' }}</span>
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-lg bg-primary-500 px-4 py-2 text-sm text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="isSavingConfig || isTestingApi || !apiKeyConfigured || !customVoiceId.trim()"
            @click="testApiAndEnableProvider"
          >
            <div :class="isTestingApi ? 'i-solar:refresh-bold-duotone animate-spin' : 'i-solar:check-circle-bold-duotone'" />
            <span>{{ isTestingApi ? '测试中...' : '测试并启用' }}</span>
          </button>
        </div>
      </div>
    </template>

    <!-- Voice settings specific to ElevenLabs -->
    <template #voice-settings>
      <div flex="~ col gap-4">
        <FieldInput
          v-model="customVoiceId"
          label="CosyVoice voice_id"
          description="声音复刻/声音设计返回的 voice_id。v3.5 模型必须使用自定义音色。"
          :placeholder="defaultVoiceId"
        />

        <FieldInput
          v-model="region"
          label="地域"
          description="v3.5 模型仅北京地域可用。cn=北京，intl=新加坡。"
          placeholder="cn"
        />

        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <FieldInput
            v-model="format"
            label="音频格式"
            description="支持 wav、mp3、pcm、opus。"
            placeholder="wav"
          />
          <FieldInput
            v-model="sampleRate"
            label="采样率"
            description="建议 24000。"
            placeholder="24000"
          />
        </div>

        <FieldInput
          v-model="languageHint"
          label="语言提示"
          description="例如 zh、en、ja；当前建议中文使用 zh。"
          placeholder="zh"
        />

        <FieldTextArea
          v-model="instruction"
          label="指令控制"
          description="可选。控制语速、情绪、风格等，不会显示在聊天里。"
          placeholder="用自然、温柔但不客服化的语气说话，语速略慢，情绪真实。"
        />

        <FieldCheckbox
          v-model="streamOutput"
          label="使用官方 HTTP 流式返回"
          description="实验项：通过 SSE 接收音频块并聚合播放。真正低延迟播放需后续接入实时播放队列。"
        />

        <FieldRange
          v-model="pitch"
          :label="t('settings.pages.providers.provider.common.fields.field.pitch.label')"
          :description="t('settings.pages.providers.provider.common.fields.field.pitch.description')"
          :min="-100"
          :max="100" :step="1" :format-value="value => `${value}%`"
        />

        <!-- Speed control - common to most providers -->
        <FieldRange
          v-model="speed"
          :label="t('settings.pages.providers.provider.common.fields.field.speed.label')"
          :description="t('settings.pages.providers.provider.common.fields.field.speed.description')"
          :min="0.5"
          :max="2.0" :step="0.01"
        />

        <!-- Volume control - available in some providers -->
        <FieldRange
          v-model="volume"
          :label="t('settings.pages.providers.provider.common.fields.field.volume.label')"
          :description="t('settings.pages.providers.provider.common.fields.field.volume.description')"
          :min="-100"
          :max="100" :step="1" :format-value="value => `${value}%`"
        />
      </div>
    </template>

    <!-- Replace the default playground with our standalone component -->
    <template #playground>
      <SpeechPlayground
        :available-voices="availableVoices"
        :generate-speech="handleGenerateSpeech"
        :api-key-configured="apiKeyConfigured"
        default-text="Doggy，这是 Lumi 的 CosyVoice 克隆音色测试。现在听起来像不像一点了？"
      />
    </template>
  </SpeechProviderSettings>
</template>

<route lang="yaml">
  meta:
    layout: settings
    stageTransition:
      name: slide
  </route>
