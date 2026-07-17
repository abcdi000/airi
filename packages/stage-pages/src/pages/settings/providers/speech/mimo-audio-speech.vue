<script setup lang="ts">
import type { SpeechProvider } from '@xsai-ext/providers/utils'

import {
  Alert,
  SpeechPlayground,
  SpeechProviderSettings,
} from '@proj-airi/stage-ui/components'
import { useProviderValidation } from '@proj-airi/stage-ui/composables/use-provider-validation'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { Button, FieldCombobox, FieldTextArea } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

interface MimoSpeechProviderConfig {
  apiKey?: string
  baseUrl?: string
  format?: string
  model?: string
  stylePrompt?: string
  voice?: string
  voiceSample?: string
}

const speechStore = useSpeechStore()
const providersStore = useProvidersStore()
const { providers } = storeToRefs(providersStore)
const { t } = useI18n()

const defaultVoiceSettings = {
  speed: 1.0,
}

const providerId = 'mimo-audio-speech'
const defaultModel = 'mimo-v2.5-tts'
const defaultVoice = 'mimo_default'
const maxVoiceSampleDataUriBytes = 10 * 1024 * 1024

const voiceSampleFileName = ref('')
const voiceSampleFileSize = ref(0)
const voiceSampleFileError = ref('')

const config = computed(() => providers.value[providerId] as MimoSpeechProviderConfig | undefined)

function ensureProviderConfig(): MimoSpeechProviderConfig {
  if (!providers.value[providerId]) {
    providers.value[providerId] = {}
  }

  return providers.value[providerId] as MimoSpeechProviderConfig
}

const providerModels = computed(() => providersStore.getModelsForProvider(providerId))
const modelOptions = computed(() => {
  const fallbackOptions = [
    { id: 'mimo-v2.5-tts', name: 'MiMo v2.5 TTS' },
    { id: 'mimo-v2.5-tts-voicedesign', name: 'MiMo v2.5 TTS Voice Design' },
    { id: 'mimo-v2.5-tts-voiceclone', name: 'MiMo v2.5 TTS Voice Clone' },
  ]

  return (providerModels.value.length > 0 ? providerModels.value : fallbackOptions).map(model => ({
    value: model.id,
    label: model.name,
  }))
})

const availableVoices = computed(() => speechStore.availableVoices[providerId] || [])

const isVoiceDesignModel = computed(() => model.value === 'mimo-v2.5-tts-voicedesign')
const isVoiceCloneModel = computed(() => model.value === 'mimo-v2.5-tts-voiceclone')
const stylePromptLabel = computed(() => {
  if (isVoiceCloneModel.value)
    return 'Style prompt (optional)'
  if (isVoiceDesignModel.value)
    return 'Voice design prompt'
  return 'Style prompt'
})

const stylePromptDescription = computed(() => {
  if (isVoiceCloneModel.value) {
    return 'Optional natural-language control sent as the user message. Leave it empty for pure voice cloning.'
  }

  if (isVoiceDesignModel.value) {
    return 'Natural-language control sent as the user message. MiMo voice design requires this prompt and does not use a preset voice.'
  }

  return 'Natural-language control sent as the user message. You can leave it empty for a neutral delivery.'
})

const model = computed({
  get: () => config.value?.model || defaultModel,
  set: (value) => {
    ensureProviderConfig().model = value
  },
})

const stylePrompt = computed({
  get: () => config.value?.stylePrompt || '',
  set: (value) => {
    ensureProviderConfig().stylePrompt = value
  },
})

const voiceSample = computed({
  get: () => config.value?.voiceSample || '',
  set: (value) => {
    ensureProviderConfig().voiceSample = value
  },
})

const apiKeyConfigured = computed(() => !!providers.value[providerId]?.apiKey)
const voiceSampleStatus = computed(() => {
  if (!voiceSample.value.trim())
    return ''

  if (voiceSampleFileName.value) {
    return `${voiceSampleFileName.value} · ${formatBytes(voiceSampleFileSize.value)}`
  }

  return 'Voice sample data URI configured'
})

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0)
    return '0 B'

  const units = ['B', 'KB', 'MB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function normalizeAudioMime(file: File) {
  const ext = file.name.split('.').pop()?.toLowerCase()
  if (ext === 'wav')
    return 'audio/wav'
  if (ext === 'mp3')
    return 'audio/mpeg'

  if (file.type === 'audio/wav' || file.type === 'audio/x-wav')
    return 'audio/wav'
  if (file.type === 'audio/mpeg' || file.type === 'audio/mp3')
    return 'audio/mpeg'

  return ''
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('Failed to read audio file.'))
    reader.readAsDataURL(file)
  })
}

async function handleVoiceSampleFileChange(event: Event) {
  voiceSampleFileError.value = ''

  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file)
    return

  const mime = normalizeAudioMime(file)
  if (!mime) {
    voiceSampleFileError.value = 'MiMo voice clone only supports mp3 or wav audio samples.'
    input.value = ''
    return
  }

  try {
    const rawDataUrl = await readFileAsDataUrl(file)
    const normalizedDataUrl = rawDataUrl.replace(/^data:[^;]+;base64,/, `data:${mime};base64,`)
    if (normalizedDataUrl.length > maxVoiceSampleDataUriBytes) {
      voiceSampleFileError.value = `The converted Base64 audio sample is ${formatBytes(normalizedDataUrl.length)}, which exceeds MiMo's 10 MB limit.`
      input.value = ''
      return
    }

    voiceSample.value = normalizedDataUrl
    voiceSampleFileName.value = file.name
    voiceSampleFileSize.value = file.size
  }
  catch (error) {
    voiceSampleFileError.value = error instanceof Error ? error.message : String(error)
  }
  finally {
    input.value = ''
  }
}

function clearVoiceSample() {
  voiceSample.value = ''
  voiceSampleFileName.value = ''
  voiceSampleFileSize.value = 0
  voiceSampleFileError.value = ''
}

onMounted(async () => {
  ensureProviderConfig()

  if (!config.value?.model) {
    model.value = defaultModel
  }

  await providersStore.loadModelsForConfiguredProviders()
  await providersStore.fetchModelsForProvider(providerId)
  await speechStore.loadVoicesForProvider(providerId)
})

async function handleGenerateSpeech(input: string, voiceId: string, _useSSML: boolean, modelId?: string) {
  const provider = await providersStore.getProviderInstance<SpeechProvider<string>>(providerId)
  if (!provider) {
    throw new Error('Failed to initialize speech provider')
  }

  const providerConfig = providersStore.getProviderConfig(providerId)
  const modelToUse = modelId || model.value || defaultModel
  const requestConfig = {
    ...providerConfig,
    ...defaultVoiceSettings,
    stylePrompt: stylePrompt.value,
    voiceSample: voiceSample.value,
  }

  if (modelToUse === 'mimo-v2.5-tts-voiceclone' && !voiceSample.value.trim()) {
    throw new Error('Voice clone model requires an mp3/wav sample. Select a local audio file first.')
  }

  const voiceToUse = modelToUse === 'mimo-v2.5-tts-voiceclone'
    ? voiceSample.value.trim()
    : voiceId || (config.value?.voice || defaultVoice)

  return await speechStore.speech(
    provider,
    modelToUse,
    input,
    voiceToUse,
    requestConfig,
  )
}

const {
  isValidating,
  isValid,
  validationMessage,
  forceValid,
} = useProviderValidation(providerId)
</script>

<template>
  <SpeechProviderSettings
    :provider-id="providerId"
    :default-model="defaultModel"
    :additional-settings="defaultVoiceSettings"
  >
    <template #voice-settings>
      <FieldCombobox
        v-model="model"
        label="Model"
        description="Select the MiMo TTS model to use for speech generation"
        :options="modelOptions"
        placeholder="Select a MiMo model..."
      />
      <FieldTextArea
        v-model="stylePrompt"
        :label="stylePromptLabel"
        :description="stylePromptDescription"
        placeholder="Describe the tone, pacing, emotion, and delivery style..."
        :required="isVoiceDesignModel"
      />
      <div v-if="isVoiceCloneModel" class="grid gap-3">
        <div class="grid gap-2">
          <div class="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            Voice sample file
          </div>
          <div class="text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">
            Select a local mp3/wav file. AIRI will convert it to MiMo's required data URI automatically.
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <label
              class="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary-500 px-3 py-2 text-sm text-white font-medium shadow-sm transition-colors hover:bg-primary-600"
            >
              <span class="i-solar-upload-minimalistic-bold-duotone" />
              <span>Select audio file</span>
              <input
                class="hidden"
                type="file"
                accept=".mp3,.wav,audio/mpeg,audio/mp3,audio/wav"
                @change="handleVoiceSampleFileChange"
              >
            </label>
            <Button
              v-if="voiceSample"
              type="button"
              variant="secondary"
              size="sm"
              @click="clearVoiceSample"
            >
              Clear sample
            </Button>
          </div>
          <div
            v-if="voiceSampleStatus"
            class="rounded-lg bg-neutral-100 px-3 py-2 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
          >
            {{ voiceSampleStatus }}
          </div>
          <div
            v-if="voiceSampleFileError"
            class="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-300"
          >
            {{ voiceSampleFileError }}
          </div>
        </div>
        <FieldTextArea
          v-model="voiceSample"
          label="Voice sample data URI (advanced)"
          description="Advanced fallback. MiMo expects data:{MIME_TYPE};base64,$BASE64_AUDIO and supports mp3/wav samples with converted Base64 under 10 MB."
          placeholder="data:audio/wav;base64,UklGRpyG..."
          :required="isVoiceCloneModel"
        />
      </div>
    </template>

    <template #playground>
      <SpeechPlayground
        :available-voices="availableVoices"
        :generate-speech="handleGenerateSpeech"
        :api-key-configured="apiKeyConfigured"
        :voices-loading="speechStore.isLoadingSpeechProviderVoices"
        :hide-voice-selection="isVoiceCloneModel || isVoiceDesignModel"
        default-text="Hello! This is a test of the Xiaomi MiMo Speech."
      />
    </template>

    <template #advanced-settings>
      <Alert type="info">
        <template #title>
          MiMo model behavior
        </template>
        <template #content>
          <div class="whitespace-pre-wrap break-words text-sm space-y-1">
            <div>`mimo-v2.5-tts` uses the preset voice list below.</div>
            <div>`mimo-v2.5-tts-voicedesign` uses the style prompt to design a new voice and does not accept `audio.voice`.</div>
            <div>`mimo-v2.5-tts-voiceclone` uses the selected mp3/wav voice sample and ignores the preset voice selector.</div>
            <div>MiMo v2.5 target speech text is sent as the assistant message. Style and voice design instructions are sent as the user message.</div>
            <div>Low-latency streaming is not available for MiMo v2.5 TTS in the current API; responses are synthesized after inference completes.</div>
          </div>
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
    </template>
  </SpeechProviderSettings>
</template>

<route lang="yaml">
meta:
  layout: settings
  stageTransition:
    name: slide
</route>
