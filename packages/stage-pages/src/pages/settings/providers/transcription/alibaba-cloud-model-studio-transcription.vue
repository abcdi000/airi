<script setup lang="ts">
import type { RemovableRef } from '@vueuse/core'
import type { TranscriptionProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import vadWorkletUrl from '@proj-airi/stage-ui/workers/vad/process.worklet?worker&url'

import {
  Alert,
  ProviderAdvancedSettings,
  ProviderApiKeyInput,
  ProviderBaseUrlInput,
  ProviderBasicSettings,
  ProviderSettingsContainer,
  ProviderSettingsLayout,
} from '@proj-airi/stage-ui/components'
import { useProviderValidation } from '@proj-airi/stage-ui/composables/use-provider-validation'
import { useHearingStore } from '@proj-airi/stage-ui/stores/modules/hearing'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { Button, FieldCheckbox, FieldCombobox, FieldInput, FieldRange } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'

const providerId = 'alibaba-cloud-model-studio-transcription'

const hearingStore = useHearingStore()
const providersStore = useProvidersStore()
const { providers } = storeToRefs(providersStore) as { providers: RemovableRef<Record<string, any>> }

function ensureConfig() {
  providersStore.initializeProvider(providerId)
  if (!providers.value[providerId])
    providers.value[providerId] = {}
}

function configValue<T>(key: string, fallback: T) {
  return computed<T>({
    get: () => (providers.value[providerId]?.[key] ?? fallback) as T,
    set: (value) => {
      ensureConfig()
      providers.value[providerId][key] = value
    },
  })
}

const apiKey = configValue('apiKey', '')
const baseUrl = configValue('baseUrl', 'wss://dashscope.aliyuncs.com/api-ws/v1/inference')
const region = configValue<'cn' | 'intl'>('region', 'cn')
const model = configValue('model', 'fun-asr-realtime')
const workspaceId = configValue('workspaceId', '')
const languageHints = configValue('languageHints', 'zh')
const vocabularyId = configValue('vocabularyId', '')
const sampleRate = configValue('sampleRate', 16000)
const sampleRateText = computed({
  get: () => String(sampleRate.value),
  set: (value: string) => {
    sampleRate.value = Number.parseInt(value, 10) || 16000
  },
})
const maxSentenceSilence = configValue('maxSentenceSilence', 700)
const semanticPunctuationEnabled = configValue('semanticPunctuationEnabled', false)
const punctuationPredictionEnabled = configValue('punctuationPredictionEnabled', true)
const inverseTextNormalizationEnabled = configValue('inverseTextNormalizationEnabled', true)
const disfluencyRemovalEnabled = configValue('disfluencyRemovalEnabled', false)
const multiThresholdModeEnabled = configValue('multiThresholdModeEnabled', false)
const heartbeat = configValue('heartbeat', true)

const providerModels = computed(() => providersStore.getModelsForProvider(providerId))
const isLoadingModels = computed(() => providersStore.isLoadingModels[providerId] || false)
const apiKeyConfigured = computed(() => !!apiKey.value)
const savedMessage = ref('')
const isTesting = ref(false)
const testError = ref('')
const testStatus = ref('等待开始测试。')
const testText = ref('')
const testPartialText = ref('')

const mediaStream = shallowRef<MediaStream>()
const audioContext = shallowRef<AudioContext>()
const workletNode = shallowRef<AudioWorkletNode>()
const mediaStreamSource = shallowRef<MediaStreamAudioSourceNode>()
const audioStreamController = shallowRef<ReadableStreamDefaultController<ArrayBuffer>>()
const testAbortController = shallowRef<AbortController>()

const {
  t,
  router,
  providerMetadata,
  isValidating,
  isValid,
  validationMessage,
  handleResetSettings,
  forceValid,
} = useProviderValidation(providerId)

onMounted(async () => {
  ensureConfig()
  await providersStore.fetchModelsForProvider(providerId)
})

function applyRegionDefaults() {
  baseUrl.value = region.value === 'intl'
    ? workspaceId.value.trim()
      ? `wss://${workspaceId.value.trim()}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference`
      : 'wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference'
    : 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
}

function saveConfig() {
  ensureConfig()
  providers.value[providerId].apiTestConfigHash = JSON.stringify({
    apiKey: apiKey.value,
    baseUrl: baseUrl.value,
    model: model.value,
    region: region.value,
    sampleRate: sampleRate.value,
    languageHints: languageHints.value,
    workspaceId: workspaceId.value,
  })
  savedMessage.value = '配置已保存。可以到听觉模块选择此服务并开始语音识别测试。'
}

async function enableForHearing() {
  saveConfig()
  hearingStore.activeTranscriptionProvider = providerId
  hearingStore.activeTranscriptionModel = model.value
  hearingStore.autoSendEnabled = true
  savedMessage.value = '已保存，并设置为当前听觉模块的语音识别服务。'
}

function float32ToInt16(buffer: Float32Array) {
  const output = new Int16Array(buffer.length)
  for (let i = 0; i < buffer.length; i++) {
    const value = Math.max(-1, Math.min(1, buffer[i]))
    output[i] = value < 0 ? value * 0x8000 : value * 0x7FFF
  }
  return output
}

async function initializeAudioGraph(stream: MediaStream) {
  const context = new AudioContext({ sampleRate: sampleRate.value, latencyHint: 'interactive' })
  await context.audioWorklet.addModule(vadWorkletUrl)

  const node = new AudioWorkletNode(context, 'vad-audio-worklet-processor')
  node.port.onmessage = ({ data }: MessageEvent<{ buffer?: Float32Array }>) => {
    const buffer = data.buffer
    const controller = audioStreamController.value
    if (!buffer || !controller)
      return

    const pcm16 = float32ToInt16(buffer)
    controller.enqueue(pcm16.buffer.slice(0))
  }

  const source = context.createMediaStreamSource(stream)
  source.connect(node)

  const silentGain = context.createGain()
  silentGain.gain.value = 0
  node.connect(silentGain)
  silentGain.connect(context.destination)

  audioContext.value = context
  workletNode.value = node
  mediaStreamSource.value = source

  if (context.state === 'suspended')
    await context.resume()
}

async function startRealtimeTest() {
  if (isTesting.value)
    return

  testError.value = ''
  testText.value = ''
  testPartialText.value = ''
  testStatus.value = '正在请求麦克风权限...'
  saveConfig()

  const abortController = new AbortController()
  testAbortController.value = abortController

  const audioStream = new ReadableStream<ArrayBuffer>({
    start(controller) {
      audioStreamController.value = controller
    },
    cancel: () => {
      audioStreamController.value = undefined
    },
  })

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: sampleRate.value,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    mediaStream.value = stream

    testStatus.value = '正在连接阿里百炼实时识别...'

    const provider = await providersStore.getProviderInstance<TranscriptionProviderWithExtraOptions<string, any>>(providerId)
    if (!provider)
      throw new Error('无法初始化阿里百炼语音识别服务。')

    const result = await hearingStore.transcription(
      providerId,
      provider,
      model.value,
      { inputAudioStream: audioStream },
      undefined,
      {
        providerOptions: {
          abortSignal: abortController.signal,
        },
      },
    )

    if (result.mode !== 'stream' || !result.textStream)
      throw new Error('阿里百炼听觉没有返回实时识别流。')

    await initializeAudioGraph(stream)
    isTesting.value = true
    testStatus.value = '正在听你说话。停顿后，这里会出现最终识别文本。'

    void (async () => {
      try {
        if (result.fullStream) {
          void (async () => {
            try {
              const reader = result.fullStream.getReader()
              while (true) {
                const { done, value } = await reader.read()
                if (done)
                  break
                const delta = value?.delta?.trim()
                if (delta && isTesting.value)
                  testPartialText.value = delta
              }
            }
            catch (error) {
              if (!abortController.signal.aborted)
                console.warn('读取阿里百炼中间识别结果失败：', error)
            }
          })()
        }

        const reader = result.textStream.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done)
            break
          if (value?.trim()) {
            testText.value = [testText.value.trim(), value.trim()].filter(Boolean).join('\n')
            testPartialText.value = ''
            testStatus.value = '收到一句最终识别结果，可以继续说下一句。'
          }
        }

        const finalText = await result.text
        if (finalText?.trim())
          testText.value = finalText.trim()
        if (!testError.value)
          testStatus.value = '测试已结束。'
      }
      catch (error) {
        if (!abortController.signal.aborted) {
          testError.value = error instanceof Error ? error.message : String(error)
          testStatus.value = '测试出错。'
        }
      }
      finally {
        isTesting.value = false
      }
    })()
  }
  catch (error) {
    testError.value = error instanceof Error ? error.message : String(error)
    testStatus.value = '测试启动失败。'
    await stopRealtimeTest(true)
  }
}

async function stopRealtimeTest(abort = false) {
  try {
    if (abort && testAbortController.value && !testAbortController.value.signal.aborted)
      testAbortController.value.abort(new DOMException('测试已取消', 'AbortError'))
  }
  catch {}

  try {
    if (abort)
      audioStreamController.value?.error(new DOMException('测试已取消', 'AbortError'))
    else
      audioStreamController.value?.close()
  }
  catch {}
  audioStreamController.value = undefined

  try {
    mediaStreamSource.value?.disconnect()
  }
  catch {}
  mediaStreamSource.value = undefined

  try {
    workletNode.value?.port.postMessage({ type: 'stop' })
    workletNode.value?.disconnect()
  }
  catch {}
  workletNode.value = undefined

  mediaStream.value?.getTracks().forEach(track => track.stop())
  mediaStream.value = undefined

  if (audioContext.value) {
    try {
      await audioContext.value.close()
    }
    catch {}
    audioContext.value = undefined
  }

  testAbortController.value = undefined
  isTesting.value = false
  testPartialText.value = ''
  if (!testError.value)
    testStatus.value = abort ? '测试已取消。' : '正在等待百炼返回最终结果...'
}

onBeforeUnmount(() => {
  void stopRealtimeTest(true)
})

async function handleUseForHearingAndTest() {
  await enableForHearing()
  await startRealtimeTest()
}

async function handleStopTest() {
  await stopRealtimeTest(false)
}

async function handleAbortTest() {
  await stopRealtimeTest(true)
}

async function handleStartTest() {
  await enableForHearing()
  await startRealtimeTest()
}

async function handleSaveOnly() {
  saveConfig()
}

async function handleEnableOnly() {
  await enableForHearing()
}

</script>

<template>
  <ProviderSettingsLayout
    :provider-name="providerMetadata?.localizedName"
    :provider-icon-color="providerMetadata?.iconColor"
    :on-back="() => router.back()"
  >
    <div flex="~ col md:row gap-6">
      <ProviderSettingsContainer class="w-full md:w-[44%]">
        <ProviderBasicSettings
          title="基础配置"
          description="为听觉模块配置阿里百炼实时语音识别。"
          :on-reset="handleResetSettings"
        >
          <ProviderApiKeyInput
            v-model="apiKey"
            provider-name="阿里百炼"
            placeholder="sk-..."
          />

          <FieldCombobox
            v-model="region"
            label="区域"
            description="中国大陆通常选择中国大陆；国际站可选择国际。"
            :options="[
              { label: '中国大陆', value: 'cn' },
              { label: '国际', value: 'intl' },
            ]"
            @update:model-value="applyRegionDefaults"
          />

          <FieldCombobox
            v-model="model"
            label="识别模型"
            description="低延迟语音聊天推荐 fun-asr-realtime。"
            :options="providerModels.map(m => ({ value: m.id, label: `${m.name} (${m.id})` }))"
            :disabled="isLoadingModels || providerModels.length === 0"
            placeholder="选择模型..."
          />

          <FieldInput
            v-model="languageHints"
            label="语言提示"
            description="多个语言用英文逗号分隔，例如 zh,en。留空则自动识别。"
            placeholder="zh"
          />

          <FieldInput
            v-model="workspaceId"
            label="业务空间 ID"
            description="中国大陆可选；国际站必填，并会用于生成 WebSocket 地址。"
            placeholder="可选"
          />

          <div class="flex flex-col gap-2 md:flex-row">
            <Button type="button" class="flex-1" @click="handleSaveOnly">
              保存配置
            </Button>
            <Button type="button" class="flex-1" @click="handleEnableOnly">
              保存并设为听觉
            </Button>
          </div>
        </ProviderBasicSettings>

        <ProviderAdvancedSettings title="接口与断句">
          <ProviderBaseUrlInput
            v-model="baseUrl"
            placeholder="wss://dashscope.aliyuncs.com/api-ws/v1/inference"
            required
          />

          <FieldInput
            v-model="vocabularyId"
            label="热词表 ID"
            description="可选。Fun-ASR 可用热词提高术语识别准确率。"
            placeholder="可选"
          />

          <FieldCombobox
            v-model="sampleRateText"
            label="采样率"
            description="普通实时模型用 16000，8k 电话模型用 8000。"
            :options="[
              { label: '16000 Hz', value: '16000' },
              { label: '8000 Hz', value: '8000' },
            ]"
          />

          <FieldRange
            v-model="maxSentenceSilence"
            label="断句静音阈值"
            description="越小越快返回，但更容易切碎句子。语音聊天建议 500-900ms。"
            :min="200"
            :max="2000"
            :step="50"
            :format-value="value => `${value} ms`"
          />

          <FieldCheckbox
            v-model="semanticPunctuationEnabled"
            label="语义断句"
            description="更准但更慢；陪伴聊天建议关闭。"
          />
          <FieldCheckbox
            v-model="punctuationPredictionEnabled"
            label="自动标点"
          />
          <FieldCheckbox
            v-model="inverseTextNormalizationEnabled"
            label="数字归一化"
            description="把中文数字尽量转成阿拉伯数字。"
          />
          <FieldCheckbox
            v-model="disfluencyRemovalEnabled"
            label="过滤语气词"
            description="如果想保留更真实的口语感，建议关闭。"
          />
          <FieldCheckbox
            v-model="multiThresholdModeEnabled"
            label="多阈值模式"
            description="可减少过长语句，建议先保持关闭。"
          />
          <FieldCheckbox
            v-model="heartbeat"
            label="心跳保活"
            description="持续开麦时建议开启。"
          />
        </ProviderAdvancedSettings>

        <Alert v-if="savedMessage" type="success">
          <template #title>
            {{ savedMessage }}
          </template>
        </Alert>

        <Alert v-if="!isValid && isValidating === 0 && validationMessage" type="error">
          <template #title>
            <div class="w-full flex items-center justify-between">
              <span>{{ t('settings.dialogs.onboarding.validationFailed') }}</span>
              <button
                type="button"
                class="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-600 font-medium transition-colors dark:bg-red-800/30 hover:bg-red-200 dark:text-red-300 dark:hover:bg-red-700/40"
                @click="forceValid"
              >
                {{ t('settings.pages.providers.common.continueAnyway') }}
              </button>
            </div>
          </template>
          <template v-if="validationMessage" #content>
            <div class="whitespace-pre-wrap break-all">
              {{ validationMessage }}
            </div>
          </template>
        </Alert>
        <Alert v-if="isValid && isValidating === 0" type="success">
          <template #title>
            {{ t('settings.dialogs.onboarding.validationSuccess') }}
          </template>
        </Alert>
      </ProviderSettingsContainer>

      <div flex="~ col gap-6" class="w-full md:w-[56%]">
        <div class="rounded-2xl border border-neutral-200/70 bg-neutral-50/70 p-5 shadow-sm dark:border-neutral-800/60 dark:bg-neutral-900/50">
          <div class="flex flex-col gap-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 class="text-xl text-neutral-900 font-semibold dark:text-neutral-100">
                  麦克风实时测试
                </h2>
                <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                  点击开始后直接说话。百炼检测到你停顿后，会把最终识别文本显示在下面。
                </p>
              </div>
              <span
                class="rounded-full px-3 py-1 text-xs font-medium"
                :class="isTesting ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' : 'bg-neutral-500/10 text-neutral-500 dark:text-neutral-300'"
              >
                {{ isTesting ? '正在监听' : '未测试' }}
              </span>
            </div>

            <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
              <Button
                type="button"
                class="md:col-span-2"
                :disabled="!apiKeyConfigured || isTesting"
                @click="handleStartTest"
              >
                <span class="i-ph:microphone h-5 w-5" />
                开始说话测试
              </Button>
              <Button
                v-if="isTesting"
                type="button"
                variant="secondary"
                @click="handleStopTest"
              >
                <span class="i-ph:stop-circle h-5 w-5" />
                结束并取最终结果
              </Button>
              <Button
                v-else
                type="button"
                variant="secondary"
                :disabled="!apiKeyConfigured"
                @click="handleUseForHearingAndTest"
              >
                保存并测试
              </Button>
            </div>

            <Button
              v-if="isTesting"
              type="button"
              variant="secondary"
              @click="handleAbortTest"
            >
              取消本次测试
            </Button>

            <Alert v-if="!apiKeyConfigured" type="warning">
              <template #title>
                先填写 API Key，再开始麦克风测试。
              </template>
            </Alert>

            <Alert v-if="testError" type="error">
              <template #title>
                实时识别出错
              </template>
              <template #content>
                <div class="whitespace-pre-wrap break-all">
                  {{ testError }}
                </div>
              </template>
            </Alert>

            <div class="rounded-xl border border-primary-500/20 bg-primary-500/8 p-4 text-sm text-primary-700 dark:text-primary-200">
              {{ testStatus }}
            </div>

            <div class="min-h-44 rounded-xl border border-dashed border-neutral-300 bg-white/70 p-4 dark:border-neutral-700 dark:bg-neutral-950/40">
              <div class="mb-2 text-sm text-neutral-500 dark:text-neutral-400">
                识别结果
              </div>
              <div v-if="testText" class="whitespace-pre-wrap text-base text-neutral-900 font-medium leading-relaxed dark:text-neutral-100">
                {{ testText }}
              </div>
              <div v-if="testPartialText" class="mt-3 rounded-lg bg-cyan-500/10 p-3 text-sm text-cyan-700 dark:text-cyan-200">
                <div class="mb-1 text-xs opacity-75">
                  正在识别
                </div>
                {{ testPartialText }}
              </div>
              <div v-else class="text-sm text-neutral-400 dark:text-neutral-600">
                {{ testText ? '可以继续说下一句。' : '还没有识别结果。开始测试后说一句话，停顿一下再看这里。' }}
              </div>
            </div>

            <div class="grid gap-2 text-xs text-neutral-500 dark:text-neutral-400 md:grid-cols-2">
              <div>服务：阿里百炼听觉</div>
              <div>模型：{{ model }}</div>
              <div>采样率：{{ sampleRate }} Hz</div>
              <div>断句静音：{{ maxSentenceSilence }} ms</div>
            </div>
          </div>
        </div>
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
