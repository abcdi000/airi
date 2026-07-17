<script setup lang="ts">
import type { SpeechProvider } from '@xsai-ext/providers/utils'

import {
  ProviderSettingsContainer,
  ProviderSettingsLayout,
  SpeechPlayground,
} from '@proj-airi/stage-ui/components'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { Callout, ComboboxSelect, FieldCheckbox, FieldInput, FieldTextArea } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

const providerId = 'qwen3-tts-local'
const defaultModel = 'Qwen/Qwen3-TTS-12Hz-0.6B-Base'
const defaultBaseUrl = 'http://127.0.0.1:8766/v1/'

const router = useRouter()
const speechStore = useSpeechStore()
const providersStore = useProvidersStore()
const { providers } = storeToRefs(providersStore)

const providerMetadata = computed(() => providersStore.getProviderMetadata(providerId))
const providerConfig = computed(() => providers.value[providerId] ??= {})
const availableVoices = computed(() => speechStore.availableVoices[providerId] || [])
const providerModels = computed(() => providersStore.getModelsForProvider(providerId))
const modelsLoading = computed(() => providersStore.isLoadingModels[providerId] || false)
const voicesLoading = ref(false)
const healthMessage = ref('')
const helperProviderOptions = computed(() => {
  const candidates = providersStore.configuredSpeechProvidersMetadata
    .filter(provider => provider.id !== providerId && provider.id !== 'speech-noop')
    .map(provider => ({
      value: provider.id,
      label: provider.localizedName || provider.name || provider.id,
    }))
  if (!candidates.some(option => option.value === 'mimo-audio-speech'))
    candidates.unshift({ value: 'mimo-audio-speech', label: 'Xiaomi MiMo' })
  return candidates
})

const baseUrl = computed({
  get: () => providerConfig.value.baseUrl as string || defaultBaseUrl,
  set: value => providerConfig.value.baseUrl = value,
})

const model = computed({
  get: () => providerConfig.value.model as string || defaultModel,
  set: value => providerConfig.value.model = value,
})

const voiceId = computed({
  get: () => providerConfig.value.voiceId as string || 'lumi_clone',
  set: value => providerConfig.value.voiceId = value,
})

const language = computed({
  get: () => providerConfig.value.language as string || 'Chinese',
  set: value => providerConfig.value.language = value,
})

const refAudioPath = computed({
  get: () => providerConfig.value.refAudioPath as string || '',
  set: value => providerConfig.value.refAudioPath = value,
})

const refText = computed({
  get: () => providerConfig.value.refText as string || '',
  set: value => providerConfig.value.refText = value,
})

const speaker = computed({
  get: () => providerConfig.value.speaker as string || 'Serena',
  set: value => providerConfig.value.speaker = value,
})

const xVectorOnlyMode = computed({
  get: () => providerConfig.value.xVectorOnlyMode === true,
  set: value => providerConfig.value.xVectorOnlyMode = value,
})

const hybridEnabled = computed({
  get: () => providerConfig.value.hybridEnabled === true,
  set: value => providerConfig.value.hybridEnabled = value,
})

const hybridCloudProviderId = computed({
  get: () => providerConfig.value.hybridCloudProviderId as string || 'mimo-audio-speech',
  set: value => providerConfig.value.hybridCloudProviderId = value,
})

function numericConfig(key: string, fallback: number) {
  return computed({
    get: () => String(providerConfig.value[key] ?? fallback),
    set: (value: string | number) => {
      const parsed = Number(value)
      providerConfig.value[key] = Number.isFinite(parsed) ? parsed : fallback
    },
  })
}

const hybridFirstSegmentMinChars = numericConfig('hybridFirstSegmentMinChars', 30)
const hybridSegmentMinChars = numericConfig('hybridSegmentMinChars', 24)
const hybridLocalMaxChars = numericConfig('hybridLocalMaxChars', 70)
const hybridCloudMaxChars = numericConfig('hybridCloudMaxChars', 60)
const hybridCloudMinChars = numericConfig('hybridCloudMinChars', 24)
const hybridCloudMinIntervalMs = numericConfig('hybridCloudMinIntervalMs', 1200)
const hybridCloudSoftRpm = numericConfig('hybridCloudSoftRpm', 45)
const hybridCloudMaxRetries = numericConfig('hybridCloudMaxRetries', 3)
const hybridCloudInitialRetryDelayMs = numericConfig('hybridCloudInitialRetryDelayMs', 1500)
const hybridCloudCooldownMs = numericConfig('hybridCloudCooldownMs', 15000)
const hybridCloudRequestTimeoutMs = numericConfig('hybridCloudRequestTimeoutMs', 18000)

const hybridDebug = computed({
  get: () => providerConfig.value.hybridDebug === true,
  set: value => providerConfig.value.hybridDebug = value,
})

const modelOptions = computed(() => {
  return providerModels.value.map(model => ({
    value: model.id,
    label: model.name,
  }))
})

function normalizeBaseUrl(value: string) {
  return value.trim().endsWith('/') ? value.trim() : `${value.trim()}/`
}

async function handlePickReferenceAudio(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file)
    return

  const reader = new FileReader()
  refAudioPath.value = await new Promise<string>((resolve, reject) => {
    reader.addEventListener('load', () => resolve(String(reader.result || '')))
    reader.addEventListener('error', () => reject(reader.error))
    reader.readAsDataURL(file)
  })
}

async function refreshProviderState() {
  try {
    voicesLoading.value = true
    await providersStore.fetchModelsForProvider(providerId)
    await speechStore.loadVoicesForProvider(providerId)
    if (!speechStore.activeSpeechVoiceId && availableVoices.value[0]?.id)
      speechStore.activeSpeechVoiceId = availableVoices.value[0].id
  }
  finally {
    voicesLoading.value = false
  }
}

async function checkLocalService() {
  healthMessage.value = 'Checking local Qwen3-TTS service...'
  try {
    const res = await fetch(new URL('health', normalizeBaseUrl(baseUrl.value)), { signal: AbortSignal.timeout(3000) })
    const text = await res.text()
    healthMessage.value = res.ok ? `Service is reachable: ${text}` : `Service returned HTTP ${res.status}: ${text}`
  }
  catch (error) {
    healthMessage.value = `Cannot reach service: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function handleGenerateSpeech(input: string, selectedVoice: string) {
  const provider = await providersStore.getProviderInstance(providerId) as SpeechProvider
  if (!provider)
    throw new Error('Failed to initialize Qwen3-TTS provider')

  return await speechStore.speech(
    provider,
    model.value,
    input,
    selectedVoice || voiceId.value,
    {
      ...providerConfig.value,
      language: language.value,
      ref_audio: refAudioPath.value,
      ref_text: refText.value,
      speaker: speaker.value,
      x_vector_only_mode: xVectorOnlyMode.value,
    },
  )
}

onMounted(async () => {
  providersStore.initializeProvider(providerId)
  providerConfig.value.baseUrl ??= defaultBaseUrl
  providerConfig.value.model ??= defaultModel
  providerConfig.value.voiceId ??= 'lumi_clone'
  providerConfig.value.language ??= 'Chinese'
  providerConfig.value.hybridCloudProviderId ??= 'mimo-audio-speech'
  providerConfig.value.hybridFirstSegmentMinChars ??= 30
  providerConfig.value.hybridSegmentMinChars ??= 24
  providerConfig.value.hybridLocalMaxChars ??= 70
  providerConfig.value.hybridCloudMaxChars ??= 60
  providerConfig.value.hybridCloudMinChars ??= 24
  providerConfig.value.hybridCloudMinIntervalMs ??= 1200
  providerConfig.value.hybridCloudSoftRpm ??= 45
  providerConfig.value.hybridCloudMaxRetries ??= 3
  providerConfig.value.hybridCloudInitialRetryDelayMs ??= 1500
  providerConfig.value.hybridCloudCooldownMs ??= 15000
  providerConfig.value.hybridCloudRequestTimeoutMs ??= 18000
  await refreshProviderState()
})

watch(model, async () => {
  await speechStore.loadVoicesForProvider(providerId, model.value)
})
</script>

<template>
  <ProviderSettingsLayout
    :provider-name="providerMetadata?.localizedName || 'Qwen3-TTS Local'"
    :provider-icon="providerMetadata?.icon"
    :provider-icon-color="providerMetadata?.iconColor"
    :on-back="() => router.back()"
  >
    <div flex="~ col md:row gap-6">
      <ProviderSettingsContainer class="w-full md:w-[42%]">
        <div flex="~ col gap-5">
          <Callout label="本地 Qwen3-TTS">
            这是独立于 MiMo 的本地发声 provider。只有在发声模块选择它时，聊天才会走本地流式 TTS；切回 MiMo 不需要改代码。
          </Callout>

          <FieldInput
            v-model="baseUrl"
            label="本地服务地址"
            description="默认服务地址。服务脚本会监听这个地址。"
            :placeholder="defaultBaseUrl"
          />

          <div class="space-y-2">
            <div class="text-sm text-neutral-500 dark:text-neutral-400">
              模型
            </div>
            <ComboboxSelect
              v-model="model"
              :options="modelOptions"
              :disabled="modelsLoading"
              placeholder="选择 Qwen3-TTS 模型..."
            />
          </div>

          <FieldInput
            v-model="voiceId"
            label="声线 ID"
            description="用于 AIRI 选择声线。克隆模型实际使用下面的参考音频。"
            placeholder="lumi_clone"
          />

          <FieldInput
            v-model="language"
            label="语言"
            description="建议中文使用 Chinese。"
            placeholder="Chinese"
          />

          <FieldInput
            v-model="speaker"
            label="预置声线"
            description="仅 CustomVoice 模型使用，例如 Serena/Vivian。"
            placeholder="Serena"
          />

          <div flex="~ col gap-2">
            <FieldInput
              v-model="refAudioPath"
              label="参考音频路径 / Data URL"
              description="Voice Clone 模型使用。可填本地路径，也可用下面按钮选择 mp3/wav 自动转为 Data URL。"
              placeholder="D:\\voices\\lumi.wav"
            />
            <input type="file" accept=".wav,.mp3,audio/wav,audio/mpeg" @change="handlePickReferenceAudio">
          </div>

          <FieldTextArea
            v-model="refText"
            label="参考音频文本"
            description="Voice Clone 推荐填写参考音频的准确转写，能提高克隆稳定性。"
            placeholder="这里填写参考音频中说的话..."
          />

          <FieldCheckbox
            v-model="xVectorOnlyMode"
            label="仅使用说话人向量"
            description="不需要参考文本，但克隆质量可能下降。"
          />

          <div class="rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4 space-y-4">
            <FieldCheckbox
              v-model="hybridEnabled"
              label="启用混合发声"
              description="本地 Qwen3-TTS 抢首段，辅助 API provider 并行合成后续段；播放仍严格按顺序排队。"
            />

            <template v-if="hybridEnabled">
              <Callout label="混合发声调度">
                MiMo v2.5 TTS 当前不是真正低延迟流式输出，因此这里只把它作为受限速的后台补段通道。若遇到 429，会冷却并退避重试。
              </Callout>

              <div class="space-y-2">
                <div class="text-sm text-neutral-500 dark:text-neutral-400">
                  辅助 Provider
                </div>
                <ComboboxSelect
                  v-model="hybridCloudProviderId"
                  :options="helperProviderOptions"
                  placeholder="选择已经配置好的辅助发声 provider..."
                />
                <FieldInput
                  v-model="hybridCloudRequestTimeoutMs"
                  label="API 单次超时 ms"
                  description="MiMo 单次请求超过该时间就切回本地 Qwen3-TTS，避免阻塞有序播放队列。"
                  placeholder="18000"
                />
              </div>

              <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                <FieldInput
                  v-model="hybridFirstSegmentMinChars"
                  label="首段最少字数"
                  description="首段太短会割裂，建议不少于 30。"
                  placeholder="30"
                />
                <FieldInput
                  v-model="hybridSegmentMinChars"
                  label="后续段最少字数"
                  description="避免过碎请求。"
                  placeholder="24"
                />
                <FieldInput
                  v-model="hybridLocalMaxChars"
                  label="本地单段最多字数"
                  description="越小首响越快，但段落更多。"
                  placeholder="70"
                />
                <FieldInput
                  v-model="hybridCloudMaxChars"
                  label="API 单段最多字数"
                  description="控制 MiMo 单次合成耗时。"
                  placeholder="60"
                />
                <FieldInput
                  v-model="hybridCloudMinChars"
                  label="API 最少接单字数"
                  description="短段优先交给本地，减少 API 浪费。"
                  placeholder="24"
                />
                <FieldInput
                  v-model="hybridCloudMinIntervalMs"
                  label="API 最小请求间隔 ms"
                  description="避免连续请求触发限速。"
                  placeholder="1200"
                />
                <FieldInput
                  v-model="hybridCloudSoftRpm"
                  label="API 软 RPM 上限"
                  description="MiMo 文档硬上限为 100 RPM，建议保守设置。"
                  placeholder="45"
                />
                <FieldInput
                  v-model="hybridCloudMaxRetries"
                  label="API 最大重试"
                  description="429/5xx/网络失败时退避重试。"
                  placeholder="3"
                />
                <FieldInput
                  v-model="hybridCloudInitialRetryDelayMs"
                  label="初始重试延迟 ms"
                  description="每次失败后指数退避。"
                  placeholder="1500"
                />
                <FieldInput
                  v-model="hybridCloudCooldownMs"
                  label="429 冷却 ms"
                  description="遇到限速后暂停 API lane。"
                  placeholder="15000"
                />
              </div>

              <FieldCheckbox
                v-model="hybridDebug"
                label="输出混合发声调试日志"
                description="在开发者控制台显示每段分配、重试和完成状态。"
              />
            </template>
          </div>

          <div flex="~ row gap-3 wrap">
            <button rounded-lg bg="cyan-500 hover:cyan-400" px-4 py-2 text-sm text-white @click="checkLocalService">
              检查本地服务
            </button>
            <button rounded-lg bg="neutral-700 hover:neutral-600 dark:bg-neutral-300 dark:text-neutral-900" px-4 py-2 text-sm text-white @click="refreshProviderState">
              刷新模型/声线
            </button>
          </div>

          <div v-if="healthMessage" rounded-lg bg="neutral-100 dark:neutral-800" p-3 text-sm>
            {{ healthMessage }}
          </div>
        </div>
      </ProviderSettingsContainer>

      <div class="w-full md:w-[58%]">
        <SpeechPlayground
          :available-voices="availableVoices"
          :generate-speech="handleGenerateSpeech"
          :api-key-configured="true"
          :voices-loading="voicesLoading"
          default-text="Doggy，我在。这次是本地 Qwen3-TTS 的声音测试。"
        />
      </div>
    </div>
  </ProviderSettingsLayout>
</template>

<route lang="yaml">
meta:
  layout: settings
  stageTransition:
    name: slide
</route>
