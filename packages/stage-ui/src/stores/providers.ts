import type {
  ChatProvider,
  ChatProviderWithExtraOptions,
  EmbedProvider,
  EmbedProviderWithExtraOptions,
  SpeechProvider,
  SpeechProviderWithExtraOptions,
  TranscriptionProvider,
  TranscriptionProviderWithExtraOptions,
} from '@xsai-ext/providers/utils'
import type { ProgressInfo } from '@xsai-transformers/shared/types'
import type {
  UnDeepgramOptions,
  UnElevenLabsOptions,
  UnMicrosoftOptions,
  UnVolcengineOptions,
  VoiceProviderWithExtraOptions,
} from 'unspeech'

import type { ProviderOnboardingField } from '../libs/providers/types'
import type { AliyunRealtimeSpeechExtraOptions } from './providers/aliyun/stream-transcription'
import type { DashScopeRealtimeAsrExtraOptions } from './providers/dashscope/stream-transcription'

import { errorMessageFrom } from '@moeru/std'
import { isStageTamagotchi, isUrl } from '@proj-airi/stage-shared'
import { getCachedWebGPUCapabilities, isWebGPUSupported } from '@proj-airi/stage-shared/webgpu'
import { computedAsync, useIntervalFn, useLocalStorage } from '@vueuse/core'
import {
  createOpenAI,
} from '@xsai-ext/providers/create'
import { createPlayer2 } from '@xsai-ext/providers/special/create'
import {
  createModelProvider,
  createSpeechProvider,
  createTranscriptionProvider,
  merge,
} from '@xsai-ext/providers/utils'
import { listModels } from '@xsai/model'
import { uniqBy } from 'es-toolkit'
import { defineStore } from 'pinia'
import {
  createUnDeepgram,
  createUnElevenLabs,
  createUnMicrosoft,
  createUnVolcengine,
  listVoices,
} from 'unspeech'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { getKokoroAdapter } from '../libs/inference/adapters/kokoro'
import { getProviderValidationIntervalMs, listProviders as listDefinedProviders, ProviderValidationCheck } from '../libs/providers'
import { getDefaultKokoroModel, KOKORO_MODELS, kokoroModelsToModelInfo } from '../workers/kokoro/constants'
import { useAuthStore } from './auth'
import { createAliyunNLSProvider as createAliyunNlsStreamProvider } from './providers/aliyun/stream-transcription'
import { convertProviderDefinitionsToMetadata } from './providers/converters'
import { models as elevenLabsModels } from './providers/elevenlabs/list-models'
import { buildOpenAICompatibleProvider } from './providers/openai-compatible-builder'
import { buildOpenRouterAudioSpeechProvider } from './providers/openrouter/audio-speech'
import { createWebSpeechAPIProvider } from './providers/web-speech-api'

const ALIYUN_NLS_REGIONS = [
  'cn-shanghai',
  'cn-shanghai-internal',
  'cn-beijing',
  'cn-beijing-internal',
  'cn-shenzhen',
  'cn-shenzhen-internal',
] as const

type AliyunNlsRegion = typeof ALIYUN_NLS_REGIONS[number]

const DASHSCOPE_COSYVOICE_ENDPOINT_CN = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
const DASHSCOPE_COSYVOICE_ENDPOINT_INTL = 'https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
const DASHSCOPE_OPENAI_COMPAT_ENDPOINT_CN = 'https://dashscope.aliyuncs.com/compatible-mode/v1/'
const DASHSCOPE_OPENAI_COMPAT_ENDPOINT_INTL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/'
const DASHSCOPE_ASR_ENDPOINT_CN = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
const DASHSCOPE_ASR_ENDPOINT_INTL = 'wss://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference'
const DEFAULT_COSYVOICE_MODEL = 'cosyvoice-v3.5-flash'
const DEFAULT_COSYVOICE_CLONE_VOICE_ID = 'cosyvoice-v3.5-flash-lumi-7e8e554c8a344a3eb13a9d3f729f0750'
const DEFAULT_DASHSCOPE_VISION_MODEL = 'qwen3-vl-flash'
const DEFAULT_DASHSCOPE_ASR_MODEL = 'fun-asr-realtime'

const DASHSCOPE_KNOWN_VISION_MODEL_IDS = new Set([
  'qwen-vl-plus',
  'qwen-vl-max',
  'qwen2-vl-7b-instruct',
  'qwen2-vl-72b-instruct',
  'qwen2.5-vl-3b-instruct',
  'qwen2.5-vl-7b-instruct',
  'qwen2.5-vl-32b-instruct',
  'qwen2.5-vl-72b-instruct',
  'qwen3-vl-plus',
  'qwen3-vl-flash',
  'qwen3-vl-235b-a22b-thinking',
  'qwen3-vl-235b-a22b-instruct',
  'qwen3.5-plus',
  'qwen3.5-flash',
  'qwen3.6-plus',
  'qwen3.6-flash',
  'qwen3.7-plus',
])

function dashscopeCosyVoiceConfigHash(config: Record<string, unknown>) {
  return JSON.stringify({
    apiKey: readProviderString(config, 'apiKey'),
    baseUrl: normalizeDashscopeCosyVoiceBaseUrl(config),
    model: readProviderString(config, 'model', DEFAULT_COSYVOICE_MODEL),
    customVoiceId: readProviderString(config, 'customVoiceId', DEFAULT_COSYVOICE_CLONE_VOICE_ID),
    region: readProviderString(config, 'region', 'cn'),
    format: readProviderString(config, 'format', 'wav'),
    sampleRate: readProviderNumber(config, 'sampleRate', 24000),
    languageHint: readProviderString(config, 'languageHint', 'zh'),
  })
}

function dashscopeVisionConfigHash(config: Record<string, unknown>) {
  return JSON.stringify({
    apiKey: readProviderString(config, 'apiKey'),
    baseUrl: normalizeDashscopeVisionBaseUrl(config),
    preferredVisionModel: readProviderString(config, 'preferredVisionModel', DEFAULT_DASHSCOPE_VISION_MODEL),
    region: readProviderString(config, 'region', 'cn'),
  })
}

function dashscopeAsrConfigHash(config: Record<string, unknown>) {
  return JSON.stringify({
    apiKey: readProviderString(config, 'apiKey'),
    baseUrl: normalizeDashscopeAsrBaseUrl(config),
    model: readProviderString(config, 'model', DEFAULT_DASHSCOPE_ASR_MODEL),
    region: readProviderString(config, 'region', 'cn'),
    sampleRate: readProviderNumber(config, 'sampleRate', 16000),
    languageHints: readProviderString(config, 'languageHints', 'zh'),
    workspaceId: readProviderString(config, 'workspaceId'),
  })
}

function openAICompatibleVisionConfigHash(config: Record<string, unknown>) {
  return JSON.stringify({
    apiKey: readProviderString(config, 'apiKey'),
    baseUrl: normalizeOpenAICompatibleBaseUrl(config.baseUrl, 'https://api.openai.com/v1/'),
    preferredVisionModel: readProviderString(config, 'preferredVisionModel'),
  })
}

function normalizeDashscopeCosyVoiceBaseUrl(config: Record<string, unknown>) {
  const explicit = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : ''
  if (explicit && !explicit.includes('unspeech.hyp3r.link'))
    return explicit

  return config.region === 'intl'
    ? DASHSCOPE_COSYVOICE_ENDPOINT_INTL
    : DASHSCOPE_COSYVOICE_ENDPOINT_CN
}

function dashscopeFormatToMime(format: string) {
  switch (format) {
    case 'mp3': return 'audio/mpeg'
    case 'wav': return 'audio/wav'
    case 'pcm': return 'audio/L16'
    case 'opus': return 'audio/opus'
    default: return 'application/octet-stream'
  }
}

function decodeBase64ToBytes(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i)
  return bytes
}

function readProviderString(config: Record<string, unknown>, key: string, fallback = '') {
  const value = config[key]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function readProviderNumber(config: Record<string, unknown>, key: string, fallback: number) {
  const value = config[key]
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeOpenAICompatibleBaseUrl(value: unknown, fallback = '') {
  let baseUrl = typeof value === 'string' ? value.trim() : ''
  if (!baseUrl)
    baseUrl = fallback
  if (baseUrl && !baseUrl.endsWith('/'))
    baseUrl += '/'
  return baseUrl
}

function normalizeDashscopeVisionBaseUrl(config: Record<string, unknown>) {
  const explicit = normalizeOpenAICompatibleBaseUrl(config.baseUrl)
  if (explicit)
    return explicit

  return config.region === 'intl'
    ? DASHSCOPE_OPENAI_COMPAT_ENDPOINT_INTL
    : DASHSCOPE_OPENAI_COMPAT_ENDPOINT_CN
}

function normalizeDashscopeAsrBaseUrl(config: Record<string, unknown>) {
  const workspaceId = readProviderString(config, 'workspaceId')
  const explicit = typeof config.baseUrl === 'string'
    ? config.baseUrl.trim().replace('{WorkspaceId}', workspaceId)
    : ''
  if (explicit)
    return explicit

  return config.region === 'intl'
    ? DASHSCOPE_ASR_ENDPOINT_INTL.replace('{WorkspaceId}', workspaceId)
    : DASHSCOPE_ASR_ENDPOINT_CN
}

function isDashscopeVisionModelId(modelId: string) {
  const id = modelId.toLowerCase()
  if (!id)
    return false

  if ([
    'embed',
    'embedding',
    'rerank',
    'tts',
    'speech',
    'audio',
    'whisper',
    'coder',
    'math',
  ].some(token => id.includes(token))) {
    return false
  }

  if (DASHSCOPE_KNOWN_VISION_MODEL_IDS.has(id))
    return true

  return /^qwen(?:\d+(?:\.\d+)?)?-vl(?:-|$)/.test(id)
    || /^qwen\d+(?:\.\d+)?-(?:plus|flash)(?:-|$)/.test(id)
}

function modelLooksVisionCapable(model: any) {
  const id = String(model.id || model.name || '').toLowerCase()
  const haystack = JSON.stringify({
    id: model.id,
    name: model.name,
    description: model.description,
    capabilities: model.capabilities,
    modalities: model.modalities,
    input_modalities: model.input_modalities,
    inputModalities: model.inputModalities,
    architecture: model.architecture,
  }).toLowerCase()

  if ([
    'embedding',
    'rerank',
    'tts',
    'speech',
    'audio',
    'whisper',
    'transcribe',
    'coder',
    'math',
  ].some(token => id.includes(token))) {
    return false
  }

  if (haystack.includes('image') || haystack.includes('vision') || haystack.includes('visual') || haystack.includes('multimodal'))
    return true

  return isDashscopeVisionModelId(id)
    || /\b(?:vl|vqa)\b/.test(id.replace(/[-_.]/g, ' '))
    || id.includes('llava')
    || id.includes('pixtral')
    || id.includes('glm-4v')
    || id.includes('kimi-vl')
    || id.includes('internvl')
    || id.includes('minicpm-v')
    || id.includes('molmo')
    || id.includes('phi-vision')
    || id.includes('gpt-4o')
    || id.includes('gpt-4.1')
    || id.includes('gpt-5')
    || id.includes('o3')
    || id.includes('o4-mini')
    || id.includes('gemini')
    || id.includes('claude-3')
    || id.includes('claude-4')
    || id.includes('llama-4')
}

function filterVisionModels(providerId: string, models: any[]): ModelInfo[] {
  return models
    .filter(modelLooksVisionCapable)
    .map((model: any) => {
      const id = String(model.id || model.name || '')
      return {
        id,
        name: model.name || model.display_name || id,
        provider: providerId,
        description: model.description || '',
        contextLength: model.context_length || model.contextLength || 0,
        deprecated: Boolean(model.deprecated),
        capabilities: ['vision', 'image-understanding'],
      } satisfies ModelInfo
    })
}

function mapDashscopeVisionModel(providerId: string, model: any): ModelInfo {
  const id = String(model.id || model.name || '')
  return {
    id,
    name: model.name || model.display_name || id,
    provider: providerId,
    description: model.description || 'Qwen image/video understanding model via DashScope OpenAI-compatible API.',
    contextLength: model.context_length || model.contextLength || 0,
    deprecated: Boolean(model.deprecated),
    capabilities: ['vision', 'image-understanding'],
  }
}

async function parseDashscopeCosyVoiceAudio(response: Response, format: string): Promise<Response> {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('text/event-stream')) {
    const text = await response.text()
    const chunks: Uint8Array[] = []
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:'))
        continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]')
        continue
      try {
        const json = JSON.parse(payload)
        const audioData = json?.output?.audio?.data
        if (typeof audioData === 'string' && audioData)
          chunks.push(decodeBase64ToBytes(audioData))
      }
      catch {}
    }
    if (chunks.length > 0) {
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
      const merged = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
      }
      return new Response(merged, { headers: { 'content-type': dashscopeFormatToMime(format) } })
    }
  }

  const data = await response.json()
  const audioData = data?.output?.audio?.data
  if (typeof audioData === 'string' && audioData) {
    return new Response(decodeBase64ToBytes(audioData), {
      headers: { 'content-type': dashscopeFormatToMime(format) },
    })
  }

  const audioUrl = data?.output?.audio?.url
  if (typeof audioUrl !== 'string' || !audioUrl)
    throw new Error(`DashScope CosyVoice response missing output.audio.url/data: ${JSON.stringify(data).slice(0, 500)}`)

  const audioResponse = await fetch(audioUrl)
  if (!audioResponse.ok)
    throw new Error(`DashScope CosyVoice audio download failed: ${audioResponse.status} ${await audioResponse.text().catch(() => '')}`.slice(0, 500))

  const bytes = await audioResponse.arrayBuffer()
  return new Response(bytes, {
    headers: { 'content-type': audioResponse.headers.get('content-type') || dashscopeFormatToMime(format) },
  })
}

function buildDashscopeCosyVoiceProvider(config: Record<string, unknown>): SpeechProvider {
  const apiKey = readProviderString(config, 'apiKey')
  return {
    speech: (model: string, _options?: Record<string, unknown>) => {
      return {
        baseURL: normalizeDashscopeCosyVoiceBaseUrl(config),
        model: model || readProviderString(config, 'model', DEFAULT_COSYVOICE_MODEL),
        fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
          const body = typeof init?.body === 'string'
            ? JSON.parse(init.body) as Record<string, unknown>
            : {}
          const requestedModel = readProviderString(body, 'model', model || readProviderString(config, 'model', DEFAULT_COSYVOICE_MODEL))
          const format = readProviderString(config, 'format', readProviderString(body, 'response_format', 'wav'))
          const voice = readProviderString(body, 'voice')
            || readProviderString(config, 'customVoiceId')
            || readProviderString(config, 'voice')
            || DEFAULT_COSYVOICE_CLONE_VOICE_ID

          if (!apiKey)
            throw new Error('DashScope API key is required for CosyVoice.')
          if (!voice)
            throw new Error('CosyVoice voice_id is required. Create or paste a cloned voice_id first.')

          const input: Record<string, unknown> = {
            text: readProviderString(body, 'input'),
            voice,
            format,
            sample_rate: readProviderNumber(config, 'sampleRate', 24000),
          }

          const rate = readProviderNumber(config, 'rate', Number.NaN)
          const pitch = readProviderNumber(config, 'pitch', Number.NaN)
          const volume = readProviderNumber(config, 'volume', Number.NaN)
          const instruction = readProviderString(config, 'instruction')
          const languageHint = readProviderString(config, 'languageHint')
          if (Number.isFinite(rate))
            input.rate = rate
          if (Number.isFinite(pitch))
            input.pitch = pitch
          if (Number.isFinite(volume))
            input.volume = volume
          if (instruction)
            input.instruction = instruction
          if (languageHint)
            input.language_hints = [languageHint]
          if (config.enableSsml === true)
            input.enable_ssml = true

          const upstream = await fetch(normalizeDashscopeCosyVoiceBaseUrl(config), {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              ...(config.streamOutput === true ? { 'X-DashScope-SSE': 'enable' } : {}),
            },
            body: JSON.stringify({
              model: requestedModel,
              input,
            }),
          })

          if (!upstream.ok)
            return new Response(await upstream.text().catch(() => ''), { status: upstream.status, statusText: upstream.statusText })

          return await parseDashscopeCosyVoiceAudio(upstream, format)
        },
      }
    },
  }
}

export interface ProviderMetadata {
  id: string
  order?: number
  category: 'chat' | 'embed' | 'speech' | 'transcription' | 'vision'
  tasks: string[]
  nameKey: string // i18n key for provider name
  name: string // Default name (fallback)
  localizedName?: string
  descriptionKey: string // i18n key for description
  description: string // Default description (fallback)
  localizedDescription?: string
  configured?: boolean
  /**
   * Indicates whether the provider is available.
   * If not specified, the provider is always available.
   *
   * May be specified when any of the following criteria is required:
   *
   * Platform requirements:
   *
   * - app-* providers are only available on desktop, this is responsible for Tauri runtime checks
   * - web-* providers are only available on web, this means Node.js and Tauri should not be imported or used
   *
   * System spec requirements:
   *
   * - may requires WebGPU / NVIDIA / other types of GPU,
   *   on Web, WebGPU will automatically compiled to use targeting GPU hardware
   * - may requires significant amount of GPU memory to run, especially for
   *   using of small language models within browser or Tauri app
   * - may requires significant amount of memory to run, especially for those
   *   non-WebGPU supported environments.
   */
  isAvailableBy?: () => Promise<boolean> | boolean
  /**
   * Iconify JSON icon name for the provider.
   *
   * Icons are available for most of the AI provides under @proj-airi/lobe-icons.
   */
  icon?: string
  iconColor?: string
  /**
   * In case of having image instead of icon, you can specify the image URL here.
   */
  iconImage?: string
  defaultOptions?: () => Record<string, unknown>
  onboardingFields?: ProviderOnboardingField[]
  createProvider: (
    config: Record<string, unknown>,
  ) =>
    | ChatProvider
    | ChatProviderWithExtraOptions
    | EmbedProvider
    | EmbedProviderWithExtraOptions
    | SpeechProvider
    | SpeechProviderWithExtraOptions
    | TranscriptionProvider
    | TranscriptionProviderWithExtraOptions
    | Promise<ChatProvider>
    | Promise<ChatProviderWithExtraOptions>
    | Promise<EmbedProvider>
    | Promise<EmbedProviderWithExtraOptions>
    | Promise<SpeechProvider>
    | Promise<SpeechProviderWithExtraOptions>
    | Promise<TranscriptionProvider>
    | Promise<TranscriptionProviderWithExtraOptions>
  capabilities: {
    listModels?: (config: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<ModelInfo[]>
    listVoices?: (config: Record<string, unknown>, model?: string) => Promise<VoiceInfo[]>
    loadModel?: (config: Record<string, unknown>, hooks?: { onProgress?: (progress: ProgressInfo) => Promise<void> | void }) => Promise<void>
  }
  validators: {
    /**
     * Validate a provider's configuration.
     *
     * PITFALL: When `skipChatPingCheck` is not set, the ChatCompletions validator
     * (if present) may send a real `generateText("ping")` request that consumes
     * API tokens. All automatic/background callers may consider pass `skipChatPingCheck: true`.
     */
    validateProviderConfig: (config: Record<string, unknown>, options?: { skipChatPingCheck?: boolean, onlyChatPingCheck?: boolean }) => Promise<{
      errors: unknown[]
      reason: string
      valid: boolean
    }> | {
      errors: unknown[]
      reason: string
      valid: boolean
    }
    /**
     * Whether the "skip chat ping check" checkbox should be shown in the UI.
     *
     * Automatically derived: `true` when the provider has a ChatCompletions
     * runtime validator AND `disableChatPingCheckUI` is not set on the definition.
     */
    chatPingCheckAvailable: boolean
  }
  /**
   * If true, the provider does not require user-provided credentials (e.g. API keys).
   * Used for official/built-in providers that authenticate via session.
   */
  requiresCredentials?: boolean
  transcriptionFeatures?: {
    supportsGenerate: boolean
    supportsStreamOutput: boolean
    supportsStreamInput: boolean
  }
  pricing?: 'free' | 'paid' | 'internal'
  deployment?: 'local' | 'cloud'
  beginnerRecommended?: boolean
}

export interface ModelInfo {
  id: string
  name: string
  provider: string
  description?: string
  capabilities?: string[]
  contextLength?: number
  deprecated?: boolean
}

export interface VoiceInfo {
  id: string
  name: string
  provider: string
  compatibleModels?: string[]
  description?: string
  gender?: string
  deprecated?: boolean
  previewURL?: string
  languages: {
    code: string
    title: string
  }[]
}

export interface ProviderRuntimeState {
  isConfigured: boolean
  validatedCredentialHash?: string
  models: ModelInfo[]
  isLoadingModels: boolean
  modelLoadError: string | null
}

export const useProvidersStore = defineStore('providers', () => {
  const providerCredentials = useLocalStorage<Record<string, Record<string, unknown>>>('settings/credentials/providers', {})
  const addedProviders = useLocalStorage<Record<string, boolean>>('settings/providers/added', {})
  const providerInstanceCache = ref<Record<string, unknown>>({})
  const { t } = useI18n()
  const baseUrlValidator = computed(() => (baseUrl: unknown) => {
    let msg = ''
    if (!baseUrl) {
      msg = 'Base URL is required.'
    }
    else if (typeof baseUrl !== 'string') {
      msg = 'Base URL must be a string.'
    }
    else if (!isUrl(baseUrl) || new URL(baseUrl).host.length === 0) {
      msg = 'Base URL is not absolute. Try to include a scheme (http:// or https://).'
    }
    else if (!baseUrl.endsWith('/')) {
      msg = 'Base URL must end with a trailing slash (/).'
    }
    if (msg) {
      return {
        errors: [new Error(msg)],
        reason: msg,
        valid: false,
      }
    }
    return null
  })

  async function isBrowserAndMemoryEnough() {
    if (isStageTamagotchi())
      return false

    const webGPUAvailable = await isWebGPUSupported()
    if (webGPUAvailable) {
      return true
    }

    if ('navigator' in globalThis && globalThis.navigator != null && 'deviceMemory' in globalThis.navigator && typeof globalThis.navigator.deviceMemory === 'number') {
      const memory = globalThis.navigator.deviceMemory
      // Check if the device has at least 8GB of RAM
      if (memory >= 8) {
        return true
      }
    }

    return false
  }

  // Centralized provider metadata with provider factory functions
  const authState = useAuthStore()
  const providerMetadata: Record<string, ProviderMetadata> = {
    'alibaba-cloud-model-studio-vision': buildOpenAICompatibleProvider({
      id: 'alibaba-cloud-model-studio-vision',
      category: 'vision',
      tasks: ['vision', 'image-to-text', 'image-understanding', 'visual-question-answering'],
      name: 'Alibaba Bailian Vision',
      nameKey: 'settings.pages.providers.provider.alibaba-cloud-model-studio-vision.title',
      description: 'Qwen image understanding via DashScope OpenAI-compatible API.',
      descriptionKey: 'settings.pages.providers.provider.alibaba-cloud-model-studio-vision.description',
      icon: 'i-lobe-icons:alibabacloud',
      iconColor: 'i-lobe-icons:alibabacloud-color',
      defaultBaseUrl: DASHSCOPE_OPENAI_COMPAT_ENDPOINT_CN,
      defaultOptions: () => ({
        apiKey: '',
        baseUrl: DASHSCOPE_OPENAI_COMPAT_ENDPOINT_CN,
        region: 'cn',
        preferredVisionModel: DEFAULT_DASHSCOPE_VISION_MODEL,
        apiTestPassed: false,
        apiTestConfigHash: '',
      }),
      creator: createOpenAI,
      capabilities: {
        listModels: async (config: Record<string, unknown>) => {
          const apiKey = readProviderString(config, 'apiKey')
          const baseURL = normalizeDashscopeVisionBaseUrl(config)
          if (!apiKey || !baseURL)
            return []

          const models = await listModels({
            apiKey,
            baseURL,
          })

          return models
            .filter((model: any) => isDashscopeVisionModelId(String(model.id || model.name || '')))
            .map(model => mapDashscopeVisionModel('alibaba-cloud-model-studio-vision', model))
        },
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config: Record<string, unknown>) => {
          const errors: Error[] = []
          if (!readProviderString(config, 'apiKey'))
            errors.push(new Error('DashScope API key is required.'))
          if (!normalizeDashscopeVisionBaseUrl(config))
            errors.push(new Error('DashScope OpenAI-compatible base URL is required.'))
          if (config.apiTestPassed !== true || config.apiTestConfigHash !== dashscopeVisionConfigHash(config))
            errors.push(new Error('Run the vision API test after changing configuration.'))

          return {
            errors,
            reason: errors.map(error => error.message).join(', '),
            valid: errors.length === 0,
          }
        },
      },
      pricing: 'paid',
      deployment: 'cloud',
    }),
    'openai-compatible-vision': buildOpenAICompatibleProvider({
      id: 'openai-compatible-vision',
      category: 'vision',
      tasks: ['vision', 'image-to-text', 'image-understanding', 'visual-question-answering'],
      name: 'OpenAI Compatible Vision',
      nameKey: 'settings.pages.providers.provider.openai-compatible-vision.title',
      description: 'Connect to any OpenAI-compatible multimodal API and use only vision-capable models.',
      descriptionKey: 'settings.pages.providers.provider.openai-compatible-vision.description',
      icon: 'i-lobe-icons:openai',
      defaultBaseUrl: 'https://api.openai.com/v1/',
      creator: createOpenAI,
      capabilities: {
        listModels: async (config: Record<string, unknown>) => {
          const apiKey = readProviderString(config, 'apiKey')
          const baseURL = normalizeOpenAICompatibleBaseUrl(config.baseUrl, 'https://api.openai.com/v1/')
          if (!apiKey || !baseURL)
            return []

          const models = await listModels({
            apiKey,
            baseURL,
          })

          return filterVisionModels('openai-compatible-vision', models)
        },
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config: Record<string, unknown>) => {
          const errors: Error[] = []
          if (!readProviderString(config, 'apiKey'))
            errors.push(new Error('API Key is required.'))
          if (!normalizeOpenAICompatibleBaseUrl(config.baseUrl))
            errors.push(new Error('Base URL is required.'))
          if (config.apiTestPassed !== true || config.apiTestConfigHash !== openAICompatibleVisionConfigHash(config))
            errors.push(new Error('Run the vision API test after changing configuration.'))

          return {
            errors,
            reason: errors.map(error => error.message).join(', '),
            valid: errors.length === 0,
          }
        },
      },
      pricing: 'paid',
      deployment: 'cloud',
    }),
    'speech-noop': {
      id: 'speech-noop',
      category: 'speech',
      tasks: ['text-to-speech', 'tts'],
      nameKey: 'settings.pages.providers.provider.speech-noop.title',
      name: 'None',
      descriptionKey: 'settings.pages.providers.provider.speech-noop.description',
      description: 'No speech output.',
      icon: 'i-solar:volume-cross-bold-duotone',
      defaultOptions: () => ({}),
      createProvider: async () => ({
        speech: () => ({
          baseURL: 'http://speech-noop.invalid/v1/',
          model: 'noop',
        }),
      }),
      capabilities: {
        listModels: async () => [],
        listVoices: async () => [],
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: () => ({
          errors: [],
          reason: '',
          valid: true,
        }),
      },
    },
    'app-local-audio-speech': buildOpenAICompatibleProvider({
      id: 'app-local-audio-speech',
      name: 'App (Local)',
      nameKey: 'settings.pages.providers.provider.app-local-audio-speech.title',
      descriptionKey: 'settings.pages.providers.provider.app-local-audio-speech.description',
      icon: 'i-lobe-icons:huggingface',
      description: 'https://github.com/huggingface/candle',
      category: 'speech',
      tasks: ['text-to-speech', 'tts'],
      isAvailableBy: isStageTamagotchi,
      creator: createOpenAI,
      validation: [],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          if (!config.baseUrl) {
            return {
              errors: [new Error('Base URL is required.')],
              reason: 'Base URL is required. This is likely a bug, report to developers on https://github.com/moeru-ai/airi/issues.',
              valid: false,
            }
          }

          return {
            errors: [],
            reason: '',
            valid: true,
          }
        },
      },
    }),
    'app-local-audio-transcription': buildOpenAICompatibleProvider({
      id: 'app-local-audio-transcription',
      name: 'App (Local)',
      nameKey: 'settings.pages.providers.provider.app-local-audio-transcription.title',
      descriptionKey: 'settings.pages.providers.provider.app-local-audio-transcription.description',
      icon: 'i-lobe-icons:huggingface',
      description: 'https://github.com/huggingface/candle',
      category: 'transcription',
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt'],
      isAvailableBy: isStageTamagotchi,
      creator: createOpenAI,
      validation: [],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          if (!config.baseUrl) {
            return {
              errors: [new Error('Base URL is required.')],
              reason: 'Base URL is required. This is likely a bug, report to developers on https://github.com/moeru-ai/airi/issues.',
              valid: false,
            }
          }

          return {
            errors: [],
            reason: '',
            valid: true,
          }
        },
      },
    }),
    'browser-local-audio-speech': buildOpenAICompatibleProvider({
      id: 'browser-local-audio-speech',
      name: 'Browser (Local)',
      nameKey: 'settings.pages.providers.provider.browser-local-audio-speech.title',
      descriptionKey: 'settings.pages.providers.provider.browser-local-audio-speech.description',
      icon: 'i-lobe-icons:huggingface',
      description: 'https://github.com/moeru-ai/xsai-transformers',
      category: 'speech',
      tasks: ['text-to-speech', 'tts'],
      isAvailableBy: isBrowserAndMemoryEnough,
      creator: createOpenAI,
      validation: [],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          if (!config.baseUrl) {
            return {
              errors: [new Error('Base URL is required.')],
              reason: 'Base URL is required. This is likely a bug, report to developers on https://github.com/moeru-ai/airi/issues.',
              valid: false,
            }
          }

          return {
            errors: [],
            reason: '',
            valid: true,
          }
        },
      },
    }),
    'browser-local-audio-transcription': buildOpenAICompatibleProvider({
      id: 'browser-local-audio-transcription',
      name: 'Browser (Local)',
      nameKey: 'settings.pages.providers.provider.browser-local-audio-transcription.title',
      descriptionKey: 'settings.pages.providers.provider.browser-local-audio-transcription.description',
      icon: 'i-lobe-icons:huggingface',
      description: 'https://github.com/moeru-ai/xsai-transformers',
      category: 'transcription',
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt'],
      isAvailableBy: isBrowserAndMemoryEnough,
      creator: createOpenAI,
      validation: [],
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          if (!config.baseUrl) {
            return {
              errors: [new Error('Base URL is required.')],
              reason: 'Base URL is required. This is likely a bug, report to developers on https://github.com/moeru-ai/airi/issues.',
              valid: false,
            }
          }

          return {
            errors: [],
            reason: '',
            valid: true,
          }
        },
      },
    }),
    'openai-audio-speech': buildOpenAICompatibleProvider({
      id: 'openai-audio-speech',
      name: 'OpenAI',
      nameKey: 'settings.pages.providers.provider.openai.title',
      descriptionKey: 'settings.pages.providers.provider.openai.description',
      icon: 'i-lobe-icons:openai',
      description: 'openai.com',
      category: 'speech',
      tasks: ['text-to-speech'],
      defaultBaseUrl: 'https://api.openai.com/v1/',
      creator: createOpenAI,
      validation: [ProviderValidationCheck.Health],
      capabilities: {
        // NOTE: OpenAI does not provide an API endpoint to retrieve available voices.
        // Voices are hardcoded here - this is a provider limitation, not an application limitation.
        // Voice compatibility per https://platform.openai.com/docs/api-reference/audio/createSpeech:
        // - tts-1 and tts-1-hd support: alloy, ash, coral, echo, fable, onyx, nova, sage, shimmer (9 voices)
        // - gpt-4o-mini-tts supports all 13 voices: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin, cedar
        listVoices: async (_config: Record<string, unknown>) => {
          return [
            {
              id: 'alloy',
              name: 'Alloy',
              provider: 'openai-audio-speech',
              languages: [],
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
            },
            {
              id: 'ash',
              name: 'Ash',
              provider: 'openai-audio-speech',
              languages: [],
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
            },
            {
              id: 'ballad',
              name: 'Ballad',
              provider: 'openai-audio-speech',
              languages: [],
              compatibleModels: ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
            },
            {
              id: 'coral',
              name: 'Coral',
              provider: 'openai-audio-speech',
              languages: [],
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
            },
            {
              id: 'echo',
              name: 'Echo',
              provider: 'openai-audio-speech',
              languages: [],
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
            },
            {
              id: 'fable',
              name: 'Fable',
              provider: 'openai-audio-speech',
              languages: [],
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
            },
            {
              id: 'onyx',
              name: 'Onyx',
              provider: 'openai-audio-speech',
              languages: [],
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
            },
            {
              id: 'nova',
              name: 'Nova',
              provider: 'openai-audio-speech',
              languages: [],
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
            },
            {
              id: 'sage',
              name: 'Sage',
              provider: 'openai-audio-speech',
              languages: [],
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
            },
            {
              id: 'shimmer',
              name: 'Shimmer',
              provider: 'openai-audio-speech',
              languages: [],
              compatibleModels: ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
            },
            {
              id: 'verse',
              name: 'Verse',
              provider: 'openai-audio-speech',
              languages: [],
              compatibleModels: ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
            },
            {
              id: 'marin',
              name: 'Marin',
              provider: 'openai-audio-speech',
              languages: [],
              compatibleModels: ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
            },
            {
              id: 'cedar',
              name: 'Cedar',
              provider: 'openai-audio-speech',
              languages: [],
              compatibleModels: ['gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15'],
            },
          ] satisfies VoiceInfo[]
        },
        listModels: async () => {
          // TESTING NOTES: All 4 models tested and confirmed working with fable voice:
          // - tts-1: {model: "tts-1", input: "test", voice: "fable"} ✓
          // - tts-1-hd: {model: "tts-1-hd", input: "test", voice: "fable"} ✓
          // - gpt-4o-mini-tts: {model: "gpt-4o-mini-tts", input: "test", voice: "fable"} ✓
          // - gpt-4o-mini-tts-2025-12-15: {model: "gpt-4o-mini-tts-2025-12-15", input: "test", voice: "fable"} ✓
          return [
            {
              id: 'tts-1',
              name: 'TTS-1',
              provider: 'openai-audio-speech',
              description: 'Optimized for real-time text-to-speech tasks',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'tts-1-hd',
              name: 'TTS-1-HD',
              provider: 'openai-audio-speech',
              description: 'Higher fidelity audio output',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'gpt-4o-mini-tts',
              name: 'GPT-4o Mini TTS',
              provider: 'openai-audio-speech',
              description: 'GPT-4o Mini optimized for text-to-speech',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'gpt-4o-mini-tts-2025-12-15',
              name: 'GPT-4o Mini TTS (2025-12-15)',
              provider: 'openai-audio-speech',
              description: 'GPT-4o Mini TTS snapshot from 2025-12-15',
              contextLength: 0,
              deprecated: false,
            },
          ]
        },
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API Key is required'),
            !config.baseUrl && new Error('Base URL is required. Default to https://api.openai.com/v1/ for official OpenAI API.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: !!config.apiKey && !!config.baseUrl,
          }
        },
      },
    }),
    'openai-compatible-audio-speech': buildOpenAICompatibleProvider({
      id: 'openai-compatible-audio-speech',
      name: 'OpenAI Compatible',
      nameKey: 'settings.pages.providers.provider.openai-compatible.title',
      descriptionKey: 'settings.pages.providers.provider.openai-compatible.description',
      icon: 'i-lobe-icons:openai',
      description: 'Connect to any API that follows the OpenAI specification.',
      category: 'speech',
      tasks: ['text-to-speech'],
      capabilities: {
        listVoices: async () => {
          return []
        },
        listModels: async (config: Record<string, unknown>) => {
          // Filter models to only include TTS models
          const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
          let baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl.trim() : ''

          if (!baseUrl.endsWith('/'))
            baseUrl += '/'

          if (!apiKey || !baseUrl) {
            return []
          }

          const provider = await createOpenAI(apiKey, baseUrl)
          if (!provider || typeof provider.model !== 'function') {
            return []
          }

          const models = await listModels({
            apiKey,
            baseURL: baseUrl,
          })

          // Filter for TTS models - look for models with "tts" in the ID
          return models
            .filter((model: any) => {
              const modelId = model.id.toLowerCase()
              // Include models that contain "tts" in their ID
              return modelId.includes('tts')
            })
            .map((model: any) => {
              return {
                id: model.id,
                name: model.name || model.display_name || model.id,
                provider: 'openai-compatible-audio-speech',
                description: model.description || '',
                contextLength: model.context_length || 0,
                deprecated: false,
              } satisfies ModelInfo
            })
        },
      },
      creator: createOpenAI,
    }),
    'openai-audio-transcription': buildOpenAICompatibleProvider({
      id: 'openai-audio-transcription',
      name: 'OpenAI',
      nameKey: 'settings.pages.providers.provider.openai.title',
      descriptionKey: 'settings.pages.providers.provider.openai.description',
      icon: 'i-lobe-icons:openai',
      description: 'openai.com',
      category: 'transcription',
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt'],
      defaultBaseUrl: 'https://api.openai.com/v1/',
      creator: createOpenAI,
      validation: [ProviderValidationCheck.Health],
      capabilities: {
        listModels: async () => {
          // OpenAI transcription models are hardcoded (no API endpoint to list them)
          return [
            {
              id: 'gpt-4o-transcribe',
              name: 'GPT-4o Transcribe',
              provider: 'openai-audio-transcription',
              description: 'High-quality transcription model',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'gpt-4o-mini-transcribe',
              name: 'GPT-4o Mini Transcribe',
              provider: 'openai-audio-transcription',
              description: 'Faster, cost-effective transcription model',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'gpt-4o-mini-transcribe-2025-12-15',
              name: 'GPT-4o Mini Transcribe (2025-12-15)',
              provider: 'openai-audio-transcription',
              description: 'GPT-4o Mini Transcribe snapshot from 2025-12-15',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'whisper-1',
              name: 'Whisper-1',
              provider: 'openai-audio-transcription',
              description: 'Powered by our open source Whisper V2 model',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'gpt-4o-transcribe-diarize',
              name: 'GPT-4o Transcribe Diarize',
              provider: 'openai-audio-transcription',
              description: 'Transcription with speaker diarization',
              contextLength: 0,
              deprecated: false,
            },
          ] satisfies ModelInfo[]
        },
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API Key is required'),
            !config.baseUrl && new Error('Base URL is required. Default to https://api.openai.com/v1/ for official OpenAI API.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: !!config.apiKey && !!config.baseUrl,
          }
        },
      },
    }),
    'openai-compatible-audio-transcription': buildOpenAICompatibleProvider({
      id: 'openai-compatible-audio-transcription',
      name: 'OpenAI Compatible',
      nameKey: 'settings.pages.providers.provider.openai-compatible.title',
      descriptionKey: 'settings.pages.providers.provider.openai-compatible.description',
      icon: 'i-lobe-icons:openai',
      description: 'Connect to any API that follows the OpenAI specification.',
      category: 'transcription',
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt'],
      creator: createOpenAI,
      capabilities: {
        // Override listModels to return empty array - transcription models cannot be fetched from /v1/models
        // Users must manually enter transcription model names (e.g., whisper-1, gpt-4o-transcribe)
        // The /v1/models endpoint only returns chat models, not transcription models
        listModels: async () => {
          return []
        },
      },
    }),
    'alibaba-cloud-model-studio-transcription': {
      id: 'alibaba-cloud-model-studio-transcription',
      category: 'transcription',
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt', 'streaming-transcription'],
      nameKey: 'settings.pages.providers.provider.alibaba-cloud-model-studio-transcription.title',
      name: 'Alibaba Cloud Model Studio ASR',
      descriptionKey: 'settings.pages.providers.provider.alibaba-cloud-model-studio-transcription.description',
      description: 'DashScope realtime speech recognition',
      icon: 'i-lobe-icons:alibabacloud',
      defaultOptions: () => ({
        apiKey: '',
        baseUrl: DASHSCOPE_ASR_ENDPOINT_CN,
        region: 'cn',
        model: DEFAULT_DASHSCOPE_ASR_MODEL,
        sampleRate: 16000,
        languageHints: 'zh',
        maxSentenceSilence: 700,
        semanticPunctuationEnabled: false,
        punctuationPredictionEnabled: true,
        inverseTextNormalizationEnabled: true,
        heartbeat: true,
      }),
      transcriptionFeatures: {
        supportsGenerate: false,
        supportsStreamOutput: true,
        supportsStreamInput: true,
      },
      createProvider: async (config) => {
        const apiKey = readProviderString(config, 'apiKey')
        const baseUrl = normalizeDashscopeAsrBaseUrl(config)
        const model = readProviderString(config, 'model', DEFAULT_DASHSCOPE_ASR_MODEL)
        const sampleRate = readProviderNumber(config, 'sampleRate', model.includes('8k') ? 8000 : 16000)
        const languageHints = readProviderString(config, 'languageHints', 'zh')
          .split(',')
          .map(value => value.trim())
          .filter(Boolean)

        if (!apiKey)
          throw new Error('DashScope API key is required.')

        return {
          transcription: (modelOverride: string, extraOptions?: DashScopeRealtimeAsrExtraOptions) => ({
            apiKey,
            baseURL: baseUrl,
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            model: modelOverride || model,
            sampleRate,
            languageHints,
            workspaceId: readProviderString(config, 'workspaceId'),
            vocabularyId: readProviderString(config, 'vocabularyId'),
            maxSentenceSilence: readProviderNumber(config, 'maxSentenceSilence', 700),
            semanticPunctuationEnabled: config.semanticPunctuationEnabled === true,
            punctuationPredictionEnabled: config.punctuationPredictionEnabled !== false,
            inverseTextNormalizationEnabled: config.inverseTextNormalizationEnabled !== false,
            disfluencyRemovalEnabled: config.disfluencyRemovalEnabled === true,
            multiThresholdModeEnabled: config.multiThresholdModeEnabled === true,
            heartbeat: config.heartbeat !== false,
            ...extraOptions,
          }),
        } as TranscriptionProviderWithExtraOptions<string, DashScopeRealtimeAsrExtraOptions>
      },
      capabilities: {
        listModels: async () => {
          return [
            {
              id: 'fun-asr-realtime',
              name: 'Fun-ASR Realtime',
              provider: 'alibaba-cloud-model-studio-transcription',
              description: 'Recommended low-latency realtime ASR with hotword support and Chinese dialect coverage.',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'fun-asr-realtime-2026-02-28',
              name: 'Fun-ASR Realtime 2026-02-28',
              provider: 'alibaba-cloud-model-studio-transcription',
              description: 'Versioned realtime Fun-ASR model.',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'fun-asr-realtime-2025-11-07',
              name: 'Fun-ASR Realtime 2025-11-07',
              provider: 'alibaba-cloud-model-studio-transcription',
              description: 'Versioned realtime Fun-ASR model.',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'paraformer-realtime-v2',
              name: 'Paraformer Realtime v2',
              provider: 'alibaba-cloud-model-studio-transcription',
              description: 'Legacy realtime ASR model supporting Chinese, English, Japanese, Korean, German, French, and Russian.',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'paraformer-realtime-8k-v2',
              name: 'Paraformer Realtime 8k v2',
              provider: 'alibaba-cloud-model-studio-transcription',
              description: '8kHz telephone-scene realtime ASR model.',
              contextLength: 0,
              deprecated: false,
            },
          ] satisfies ModelInfo[]
        },
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors: Error[] = []
          const apiKey = readProviderString(config, 'apiKey')
          const baseUrl = normalizeDashscopeAsrBaseUrl(config)
          const model = readProviderString(config, 'model', DEFAULT_DASHSCOPE_ASR_MODEL)
          const sampleRate = readProviderNumber(config, 'sampleRate', 16000)

          if (!apiKey)
            errors.push(new Error('DashScope API key is required.'))
          if (!baseUrl || !baseUrl.startsWith('wss://'))
            errors.push(new Error('DashScope ASR Base URL must start with wss://.'))
          if (baseUrl.includes('{WorkspaceId}'))
            errors.push(new Error('International DashScope ASR endpoint requires Workspace ID.'))
          if (!model)
            errors.push(new Error('Realtime ASR model is required.'))
          if (model.includes('8k') && sampleRate !== 8000)
            errors.push(new Error('8k realtime ASR models require sampleRate=8000.'))
          if (!model.includes('8k') && sampleRate !== 16000)
            errors.push(new Error('Realtime ASR microphone input should use sampleRate=16000.'))
          if (config.apiTestPassed === true && config.apiTestConfigHash !== dashscopeAsrConfigHash(config))
            errors.push(new Error('Configuration changed after the last successful ASR test. Test again if you need the green provider status.'))

          return {
            errors,
            reason: errors.length > 0 ? errors.map(error => error.message).join(', ') : '',
            valid: errors.length === 0 || errors.every(error => error.message.includes('last successful ASR test')),
          }
        },
      },
    },
    'aliyun-nls-transcription': {
      id: 'aliyun-nls-transcription',
      category: 'transcription',
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt', 'streaming-transcription'],
      nameKey: 'settings.pages.providers.provider.aliyun-nls.title',
      name: 'Aliyun NLS',
      descriptionKey: 'settings.pages.providers.provider.aliyun-nls.description',
      description: 'nls-console.aliyun.com',
      icon: 'i-lobe-icons:alibabacloud',
      defaultOptions: () => ({
        accessKeyId: '',
        accessKeySecret: '',
        appKey: '',
        region: 'cn-shanghai',
      }),
      transcriptionFeatures: {
        supportsGenerate: false,
        supportsStreamOutput: true,
        supportsStreamInput: true,
      },
      createProvider: async (config) => {
        const toString = (value: unknown) => typeof value === 'string' ? value.trim() : ''

        const accessKeyId = toString(config.accessKeyId)
        const accessKeySecret = toString(config.accessKeySecret)
        const appKey = toString(config.appKey)
        const region = toString(config.region)
        const resolvedRegion = ALIYUN_NLS_REGIONS.includes(region as AliyunNlsRegion) ? region as AliyunNlsRegion : 'cn-shanghai'

        if (!accessKeyId || !accessKeySecret || !appKey)
          throw new Error('Aliyun NLS credentials are incomplete.')

        const provider = createAliyunNlsStreamProvider(accessKeyId, accessKeySecret, appKey, { region: resolvedRegion })

        return {
          transcription: (model: string, extraOptions?: AliyunRealtimeSpeechExtraOptions) => provider.speech(model, {
            ...extraOptions,
            sessionOptions: {
              format: 'pcm',
              sample_rate: 16000,
              enable_punctuation_prediction: true,
              enable_intermediate_result: true,
              enable_words: true,
              ...extraOptions?.sessionOptions,
            },
          }),
        } as TranscriptionProviderWithExtraOptions<string, AliyunRealtimeSpeechExtraOptions>
      },
      capabilities: {
        listModels: async () => {
          return [
            {
              id: 'aliyun-nls-v1',
              name: 'Aliyun NLS Realtime',
              provider: 'aliyun-nls-transcription',
              description: 'Realtime streaming transcription using Aliyun NLS.',
              contextLength: 0,
              deprecated: false,
            },
          ]
        },
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors: Error[] = []
          const toString = (value: unknown) => typeof value === 'string' ? value.trim() : ''

          const accessKeyId = toString(config.accessKeyId)
          const accessKeySecret = toString(config.accessKeySecret)
          const appKey = toString(config.appKey)
          const region = toString(config.region)

          if (!accessKeyId)
            errors.push(new Error('Access Key ID is required.'))
          if (!accessKeySecret)
            errors.push(new Error('Access Key Secret is required.'))
          if (!appKey)
            errors.push(new Error('App Key is required.'))
          if (region && !ALIYUN_NLS_REGIONS.includes(region as AliyunNlsRegion))
            errors.push(new Error('Region is invalid.'))

          return {
            errors,
            reason: errors.length > 0 ? errors.map(error => error.message).join(', ') : '',
            valid: errors.length === 0,
          }
        },
      },
    },
    'browser-web-speech-api': {
      id: 'browser-web-speech-api',
      category: 'transcription',
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt', 'streaming-transcription'],
      nameKey: 'settings.pages.providers.provider.browser-web-speech-api.title',
      name: 'Web Speech API (Browser)',
      descriptionKey: 'settings.pages.providers.provider.browser-web-speech-api.description',
      description: 'Browser-native speech recognition. No API keys.',
      icon: 'i-solar:microphone-bold-duotone',
      defaultOptions: () => ({
        language: 'en-US',
        continuous: true,
        interimResults: true,
        maxAlternatives: 1,
      }),
      transcriptionFeatures: {
        supportsGenerate: false,
        supportsStreamOutput: true,
        supportsStreamInput: true,
      },
      isAvailableBy: async () => {
        // Web Speech API is only available in browser contexts, NOT in Electron
        // Even though Electron uses Chromium, Web Speech API requires Google's embedded API keys
        // which are not available in Electron, causing it to fail at runtime
        if (typeof window === 'undefined')
          return false

        // Explicitly exclude Electron - Web Speech API doesn't work there
        if (isStageTamagotchi())
          return false

        // Check if API is available in browser
        return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window
      },
      createProvider: async (_config) => {
        // Web Speech API doesn't need config, but we accept it for consistency
        return createWebSpeechAPIProvider()
      },
      capabilities: {
        listModels: async () => {
          return [
            {
              id: 'web-speech-api',
              name: 'Web Speech API',
              provider: 'browser-web-speech-api',
              description: 'Browser-native speech recognition (no API keys required)',
              contextLength: 0,
              deprecated: false,
            },
          ]
        },
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: () => {
          // Web Speech API requires no configuration, just browser support
          // Always return valid if browser supports it, so it auto-configures
          const isAvailable = typeof window !== 'undefined'
            && ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)

          if (!isAvailable) {
            return {
              errors: [new Error('Web Speech API is not available. It requires a browser context with SpeechRecognition support (Chrome, Edge, Safari).')],
              reason: 'Web Speech API is not available in this environment.',
              valid: false,
            }
          }

          // Auto-configure if available (no credentials needed)
          return {
            errors: [],
            reason: '',
            valid: true,
          }
        },
      },
    },
    'elevenlabs': {
      id: 'elevenlabs',
      category: 'speech',
      tasks: ['text-to-speech'],
      nameKey: 'settings.pages.providers.provider.elevenlabs.title',
      name: 'ElevenLabs',
      descriptionKey: 'settings.pages.providers.provider.elevenlabs.description',
      description: 'elevenlabs.io',
      icon: 'i-simple-icons:elevenlabs',
      defaultOptions: () => ({
        baseUrl: 'https://unspeech.hyp3r.link/v1/',
        voiceSettings: {
          similarityBoost: 0.75,
          stability: 0.5,
        },
      }),
      createProvider: async config => createUnElevenLabs((config.apiKey as string).trim(), (config.baseUrl as string).trim()) as SpeechProviderWithExtraOptions<string, UnElevenLabsOptions>,
      capabilities: {
        listModels: async () => {
          return elevenLabsModels.map((model) => {
            return {
              id: model.model_id,
              name: model.name,
              provider: 'elevenlabs',
              description: model.description,
              contextLength: 0,
              deprecated: false,
            } satisfies ModelInfo
          })
        },
        listVoices: async (config) => {
          const provider = createUnElevenLabs((config.apiKey as string).trim(), (config.baseUrl as string).trim()) as VoiceProviderWithExtraOptions<UnElevenLabsOptions>

          const voices = await listVoices({
            ...provider.voice(),
          })

          if (!voices || !Array.isArray(voices)) {
            return []
          }

          // Find indices of Aria and Bill
          const ariaIndex = voices.findIndex(voice => voice.name.includes('Aria'))
          const billIndex = voices.findIndex(voice => voice.name.includes('Bill'))

          // Determine the range to move (ensure valid indices and proper order)
          const startIndex = ariaIndex !== -1 ? ariaIndex : 0
          const endIndex = billIndex !== -1 ? billIndex : voices.length - 1
          const lowerIndex = Math.min(startIndex, endIndex)
          const higherIndex = Math.max(startIndex, endIndex)

          // Rearrange voices: voices outside the range first, then voices within the range
          const rearrangedVoices = [
            ...voices.slice(0, lowerIndex),
            ...voices.slice(higherIndex + 1),
            ...voices.slice(lowerIndex, higherIndex + 1),
          ]

          return rearrangedVoices.map((voice) => {
            return {
              id: voice.id,
              name: voice.name,
              provider: 'elevenlabs',
              previewURL: voice.preview_audio_url,
              languages: voice.languages,
            }
          })
        },
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API key is required.'),
            !config.baseUrl && new Error('Base URL is required.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: !!config.apiKey && !!config.baseUrl,
          }
        },
      },
    },
    'deepgram-tts': {
      id: 'deepgram-tts',
      category: 'speech',
      tasks: ['text-to-speech'],
      nameKey: 'settings.pages.providers.provider.deepgram-tts.title',
      name: 'Deepgram',
      descriptionKey: 'settings.pages.providers.provider.deepgram-tts.description',
      description: 'deepgram.com',
      icon: 'i-simple-icons:deepgram',
      defaultOptions: () => ({
        baseUrl: 'https://unspeech.hyp3r.link/v1/',
      }),
      createProvider: async (config) => {
        const provider = createUnDeepgram((config.apiKey as string).trim(), (config.baseUrl as string).trim()) as SpeechProviderWithExtraOptions<string, UnDeepgramOptions>
        return provider
      },
      capabilities: {
        listModels: async () => {
          return [
            {
              id: 'aura-2',
              name: 'Aura 2',
              provider: 'deepgram-tts',
              description: 'Latest generation Aura model',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'aura-1',
              name: 'Aura 1',
              provider: 'deepgram-tts',
              description: 'First generation Aura model',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'aura',
              name: 'Aura (Legacy)',
              provider: 'deepgram-tts',
              description: 'Original Aura model',
              contextLength: 0,
              deprecated: true,
            },
          ]
        },
        listVoices: async (config) => {
          const provider = createUnDeepgram((config.apiKey as string).trim(), (config.baseUrl as string).trim()) as VoiceProviderWithExtraOptions<UnDeepgramOptions>

          const voices = await listVoices({
            ...provider.voice(),
          })

          return voices.map((voice) => {
            return {
              id: voice.id,
              name: voice.name,
              provider: 'deepgram-tts',
              description: voice.description,
              languages: voice.languages,
              gender: voice.labels?.gender,
            }
          })
        },
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors: Error[] = []
          if (!config.apiKey) {
            errors.push(new Error('API key is required.'))
          }

          const baseUrlValidationResult = baseUrlValidator.value(config.baseUrl)
          if (baseUrlValidationResult) {
            errors.push(...(baseUrlValidationResult.errors as Error[]))
          }

          return {
            errors,
            reason: errors.map(e => e.message).join(', '),
            valid: errors.length === 0,
          }
        },
      },
    },
    'microsoft-speech': {
      id: 'microsoft-speech',
      category: 'speech',
      tasks: ['text-to-speech'],
      nameKey: 'settings.pages.providers.provider.microsoft-speech.title',
      name: 'Microsoft / Azure Speech',
      descriptionKey: 'settings.pages.providers.provider.microsoft-speech.description',
      description: 'speech.microsoft.com',
      iconColor: 'i-lobe-icons:microsoft',
      defaultOptions: () => ({
        baseUrl: 'https://unspeech.hyp3r.link/v1/',
      }),
      createProvider: async config => createUnMicrosoft((config.apiKey as string).trim(), (config.baseUrl as string).trim()) as SpeechProviderWithExtraOptions<string, UnMicrosoftOptions>,
      capabilities: {
        listModels: async () => {
          return [
            {
              id: 'v1',
              name: 'v1',
              provider: 'microsoft-speech',
              description: '',
              contextLength: 0,
              deprecated: false,
            },
          ]
        },
        listVoices: async (config) => {
          const provider = createUnMicrosoft((config.apiKey as string).trim(), (config.baseUrl as string).trim()) as VoiceProviderWithExtraOptions<UnMicrosoftOptions>

          const voices = await listVoices({
            ...provider.voice({ region: config.region as string }),
          })

          return voices.map((voice) => {
            return {
              id: voice.id,
              name: voice.name,
              provider: 'microsoft-speech',
              previewURL: voice.preview_audio_url,
              languages: voice.languages,
              gender: voice.labels?.gender,
            }
          })
        },
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API key is required.'),
            !config.baseUrl && new Error('Base URL is required.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: !!config.apiKey && !!config.baseUrl,
          }
        },
      },
    },
    'index-tts-vllm': {
      id: 'index-tts-vllm',
      category: 'speech',
      tasks: ['text-to-speech'],
      nameKey: 'settings.pages.providers.provider.index-tts-vllm.title',
      name: 'Index-TTS by Bilibili',
      descriptionKey: 'settings.pages.providers.provider.index-tts-vllm.description',
      description: 'index-tts.github.io',
      iconColor: 'i-lobe-icons:bilibiliindex',
      defaultOptions: () => ({
        baseUrl: 'http://localhost:11996/tts/',
        model: 'IndexTTS-1.5',
      }),
      createProvider: async (config) => {
        const provider: SpeechProvider = {
          speech: () => {
            const req = {
              baseURL: config.baseUrl as string,
              model: (config.model as string) || 'IndexTTS-1.5',
            }
            return req
          },
        }
        return provider
      },
      capabilities: {
        listModels: async () => {
          return [
            {
              id: 'IndexTTS-1.5',
              name: 'IndexTTS-1.5',
              provider: 'index-tts-vllm',
              description: 'Default model for Index-TTS vLLM deployment',
              contextLength: 0,
              deprecated: false,
            },
          ]
        },
        listVoices: async (config) => {
          const voicesUrl = config.baseUrl as string
          const response = await fetch(`${voicesUrl}audio/voices`)
          if (!response.ok) {
            throw new Error(`Failed to fetch voices: ${response.statusText}`)
          }
          const voices = await response.json()
          return Object.keys(voices).map((voice: any) => {
            return {
              id: voice,
              name: voice,
              provider: 'index-tts-vllm',
              // previewURL: voice.preview_audio_url,
              languages: [{ code: 'cn', title: 'Chinese' }, { code: 'en', title: 'English' }],
            }
          })
        },
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: async (config) => {
          const errors = [
            !config.baseUrl && new Error('Base URL is required. Default to http://localhost:11996/tts/ for Index-TTS.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 5000)
            const response = await fetch(`${config.baseUrl as string}audio/voices`, { signal: controller.signal })
            clearTimeout(timeout)

            if (!response.ok) {
              const reason = `IndexTTS unreachable: HTTP ${response.status} ${response.statusText}`
              return { errors: [new Error(reason)], reason, valid: false }
            }
          }
          catch (err) {
            const reason = `IndexTTS connection failed: ${String(err)}`
            return { errors: [err as Error], reason, valid: false }
          }

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: errors.length === 0,
          }
        },
      },
    },
    'alibaba-cloud-model-studio': {
      id: 'alibaba-cloud-model-studio',
      category: 'speech',
      tasks: ['text-to-speech'],
      nameKey: 'settings.pages.providers.provider.alibaba-cloud-model-studio.title',
      name: 'Alibaba Cloud Model Studio',
      descriptionKey: 'settings.pages.providers.provider.alibaba-cloud-model-studio.description',
      description: 'bailian.console.aliyun.com',
      iconColor: 'i-lobe-icons:alibabacloud',
      defaultOptions: () => ({
        baseUrl: DASHSCOPE_COSYVOICE_ENDPOINT_CN,
        region: 'cn',
        model: DEFAULT_COSYVOICE_MODEL,
        customVoiceId: DEFAULT_COSYVOICE_CLONE_VOICE_ID,
        format: 'wav',
        sampleRate: 24000,
        languageHint: 'zh',
        apiTestPassed: false,
        apiTestConfigHash: '',
      }),
      createProvider: async config => buildDashscopeCosyVoiceProvider(config),
      capabilities: {
        listVoices: async (config, modelOverride) => {
          const model = modelOverride || readProviderString(config, 'model', DEFAULT_COSYVOICE_MODEL)
          const customVoiceId = readProviderString(config, 'customVoiceId', DEFAULT_COSYVOICE_CLONE_VOICE_ID)
          const voices: VoiceInfo[] = []

          if (customVoiceId) {
            voices.push({
              id: customVoiceId,
              name: customVoiceId.includes('lumi') ? 'Lumi Clone' : customVoiceId,
              description: 'CosyVoice cloned/custom voice_id.',
              provider: 'alibaba-cloud-model-studio',
              compatibleModels: [model],
              languages: [{ code: 'zh-CN', title: 'Chinese' }],
              gender: 'female',
            })
          }

          // v3.5 models are clone/design-only and do not expose system voices.
          // Keep a tiny built-in roster for older models so users can still
          // sanity-test their key without first enrolling a custom voice.
          if (!model.startsWith('cosyvoice-v3.5')) {
            voices.push(
              {
                id: model === 'cosyvoice-v2' ? 'longxiaochun_v2' : 'longanyang',
                name: model === 'cosyvoice-v2' ? 'Longxiaochun v2' : 'Longanyang',
                description: 'Common CosyVoice system voice.',
                provider: 'alibaba-cloud-model-studio',
                compatibleModels: [model],
                languages: [{ code: 'zh-CN', title: 'Chinese' }],
                gender: 'female',
              },
            )
          }

          return uniqBy(voices, voice => voice.id)
        },
        listModels: async () => {
          return [
            {
              id: 'cosyvoice-v3.5-flash',
              name: 'CosyVoice v3.5 Flash',
              provider: 'alibaba-cloud-model-studio',
              description: 'Low-latency CosyVoice v3.5 model for voice clone/design voices. Beijing region only.',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'cosyvoice-v3.5-plus',
              name: 'CosyVoice v3.5 Plus',
              provider: 'alibaba-cloud-model-studio',
              description: 'Higher-quality CosyVoice v3.5 model for voice clone/design voices. Beijing region only.',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'cosyvoice-v3-flash',
              name: 'CosyVoice v3 Flash',
              provider: 'alibaba-cloud-model-studio',
              description: 'CosyVoice v3 flash model. Supports system and custom voices.',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'cosyvoice-v3-plus',
              name: 'CosyVoice v3 Plus',
              provider: 'alibaba-cloud-model-studio',
              description: 'CosyVoice v3 plus model. Supports system and custom voices.',
              contextLength: 0,
              deprecated: false,
            },
            {
              id: 'cosyvoice-v2',
              name: 'CosyVoice v2',
              provider: 'alibaba-cloud-model-studio',
              description: 'Older CosyVoice model kept for compatibility.',
              contextLength: 0,
              deprecated: false,
            },
          ]
        },
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const baseUrl = readProviderString(config, 'baseUrl')
          const errors = [
            !config.apiKey && new Error('API key is required.'),
            !baseUrl && new Error('Base URL is required.'),
            baseUrl && (!isUrl(baseUrl) || new URL(baseUrl).host.length === 0) && new Error('Base URL must be an absolute URL.'),
            !config.customVoiceId && new Error('CosyVoice voice_id is required.'),
            config.apiTestPassed !== true && new Error('Run a successful API test before enabling Alibaba Cloud Model Studio.'),
            config.apiTestConfigHash !== dashscopeCosyVoiceConfigHash(config) && new Error('Configuration changed after the last successful API test. Run the test again.'),
          ].filter(Boolean)

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: errors.length === 0,
          }
        },
      },
    },
    'volcengine': {
      id: 'volcengine',
      category: 'speech',
      tasks: ['text-to-speech'],
      nameKey: 'settings.pages.providers.provider.volcengine.title',
      name: 'settings.pages.providers.provider.volcengine.title',
      descriptionKey: 'settings.pages.providers.provider.volcengine.description',
      description: 'volcengine.com',
      iconColor: 'i-lobe-icons:volcengine',
      defaultOptions: () => ({
        baseUrl: 'https://unspeech.hyp3r.link/v1/',
      }),
      createProvider: async config => createUnVolcengine((config.apiKey as string).trim(), (config.baseUrl as string).trim()),
      capabilities: {
        listVoices: async (config) => {
          const provider = createUnVolcengine((config.apiKey as string).trim(), (config.baseUrl as string).trim()) as VoiceProviderWithExtraOptions<UnVolcengineOptions>

          const voices = await listVoices({
            ...provider.voice(),
          })

          return voices.map((voice) => {
            return {
              id: voice.id,
              name: voice.name,
              provider: 'volcano-engine',
              previewURL: voice.preview_audio_url,
              languages: voice.languages,
              gender: voice.labels?.gender,
            }
          })
        },
        listModels: async () => {
          return [
            {
              id: 'v1',
              name: 'v1',
              provider: 'volcano-engine',
              description: '',
              contextLength: 0,
              deprecated: false,
            },
          ]
        },
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API key is required.'),
            !config.baseUrl && new Error('Base URL is required.'),
            !((config.app as any)?.appId) && new Error('App ID is required.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: !!config.apiKey && !!config.baseUrl && !!config.app && !!(config.app as any).appId,
          }
        },
      },
    },
    'minimax-speech': {
      id: 'minimax-speech',
      category: 'speech',
      tasks: ['text-to-speech'],
      nameKey: 'settings.pages.providers.provider.minimax-speech.title',
      name: 'MiniMax Speech',
      descriptionKey: 'settings.pages.providers.provider.minimax-speech.description',
      description: 'minimax.io',
      icon: 'i-lobe-icons:minimax',
      iconColor: 'i-lobe-icons:minimax-color',
      defaultOptions: () => ({
        apiKey: '',
        baseUrl: 'https://api.minimax.io',
      }),
      createProvider: async (config) => {
        const apiKey = (config.apiKey as string).trim()
        const baseUrl = ((config.baseUrl as string) || 'https://api.minimax.io').replace(/\/$/, '')

        const provider: SpeechProvider = {
          speech: () => ({
            baseURL: `${baseUrl}/v1/`,
            model: 'speech-2.8-hd',
            fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
              if (!init?.body || typeof init.body !== 'string') {
                throw new Error('Invalid request body')
              }

              const body = JSON.parse(init.body)
              const text = body.input as string
              const voiceId = (body.voice as string) || 'English_Graceful_Lady'
              const model = (body.model as string) || 'speech-2.8-hd'

              const response = await fetch(`${baseUrl}/v1/t2a_v2`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                  model,
                  text,
                  stream: true,
                  voice_setting: {
                    voice_id: voiceId,
                    speed: 1,
                    vol: 1,
                    pitch: 0,
                  },
                  audio_setting: {
                    sample_rate: 32000,
                    bitrate: 128000,
                    format: 'mp3',
                    channel: 1,
                  },
                }),
              })

              if (!response.ok || !response.body) {
                throw new Error(`MiniMax TTS request failed: ${response.status} ${response.statusText}`)
              }

              // Parse SSE stream and collect hex-encoded audio chunks
              const reader = response.body.getReader()
              const decoder = new TextDecoder()
              const audioChunks: Uint8Array[] = []
              let buffer = ''

              while (true) {
                const { done, value } = await reader.read()
                if (done)
                  break
                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split('\n')
                buffer = lines.pop() || ''
                for (const line of lines) {
                  if (!line.startsWith('data:'))
                    continue
                  const jsonStr = line.slice(5).trim()
                  if (!jsonStr || jsonStr === '[DONE]')
                    continue
                  try {
                    const eventData = JSON.parse(jsonStr)
                    const audio = eventData?.data?.audio
                    // status 2 is the final summary chunk; skip it to avoid duplication
                    if (audio && eventData?.data?.status !== 2) {
                      const hexStr = audio as string
                      const bytes = new Uint8Array(hexStr.length / 2)
                      for (let i = 0; i < hexStr.length; i += 2) {
                        bytes[i / 2] = Number.parseInt(hexStr.slice(i, i + 2), 16)
                      }
                      audioChunks.push(bytes)
                    }
                  }
                  catch {
                    // ignore malformed SSE events
                  }
                }
              }

              const totalLength = audioChunks.reduce((sum, chunk) => sum + chunk.length, 0)
              const combined = new Uint8Array(totalLength)
              let offset = 0
              for (const chunk of audioChunks) {
                combined.set(chunk, offset)
                offset += chunk.length
              }

              return new Response(combined.buffer, {
                status: 200,
                headers: { 'Content-Type': 'audio/mpeg' },
              })
            },
          }),
        }
        return provider
      },
      capabilities: {
        listModels: async () => [
          {
            id: 'speech-2.8-hd',
            name: 'Speech 2.8 HD',
            provider: 'minimax-speech',
            description: 'High-definition TTS model with natural prosody',
            contextLength: 0,
            deprecated: false,
          },
          {
            id: 'speech-2.8-turbo',
            name: 'Speech 2.8 Turbo',
            provider: 'minimax-speech',
            description: 'Fast TTS model for low-latency scenarios',
            contextLength: 0,
            deprecated: false,
          },
        ],
        listVoices: async () => [
          { id: 'English_Graceful_Lady', name: 'Graceful Lady', provider: 'minimax-speech', gender: 'female', languages: [{ code: 'en', title: 'English' }] },
          { id: 'English_Insightful_Speaker', name: 'Insightful Speaker', provider: 'minimax-speech', gender: 'male', languages: [{ code: 'en', title: 'English' }] },
          { id: 'English_radiant_girl', name: 'Radiant Girl', provider: 'minimax-speech', gender: 'female', languages: [{ code: 'en', title: 'English' }] },
          { id: 'English_Persuasive_Man', name: 'Persuasive Man', provider: 'minimax-speech', gender: 'male', languages: [{ code: 'en', title: 'English' }] },
          { id: 'English_Lucky_Robot', name: 'Lucky Robot', provider: 'minimax-speech', gender: 'neutral', languages: [{ code: 'en', title: 'English' }] },
          { id: 'English_expressive_narrator', name: 'Expressive Narrator', provider: 'minimax-speech', gender: 'neutral', languages: [{ code: 'en', title: 'English' }] },
          { id: 'Mandarin_Gentle_Woman', name: 'Gentle Woman', provider: 'minimax-speech', gender: 'female', languages: [{ code: 'zh', title: 'Chinese' }] },
          { id: 'Mandarin_Steadfast_Man', name: 'Steadfast Man', provider: 'minimax-speech', gender: 'male', languages: [{ code: 'zh', title: 'Chinese' }] },
          { id: 'Mandarin_Sweet_Girl', name: 'Sweet Girl', provider: 'minimax-speech', gender: 'female', languages: [{ code: 'zh', title: 'Chinese' }] },
          { id: 'Mandarin_Magnetic_Gentleman', name: 'Magnetic Gentleman', provider: 'minimax-speech', gender: 'male', languages: [{ code: 'zh', title: 'Chinese' }] },
        ],
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API key is required.'),
          ].filter(Boolean)

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: !!config.apiKey,
          }
        },
      },
    },
    'openrouter-audio-speech': buildOpenRouterAudioSpeechProvider(v => baseUrlValidator.value(v)),
    'mimo-audio-speech': {
      id: 'mimo-audio-speech',
      category: 'speech',
      tasks: ['text-to-speech'],
      nameKey: 'settings.pages.providers.provider.mimo.title',
      name: 'Xiaomi MiMo',
      descriptionKey: 'settings.pages.providers.provider.mimo.description',
      description: 'api.xiaomimimo.com',
      icon: 'i-simple-icons:xiaomi',
      defaultOptions: () => ({
        baseUrl: 'https://api.xiaomimimo.com/v1',
        model: 'mimo-v2.5-tts',
        voice: 'mimo_default',
        format: 'wav',
      }),
      createProvider: async (config) => {
        const apiKey = (config.apiKey as string)?.trim() ?? ''
        const baseUrl = ((config.baseUrl as string) || 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '')
        const defaultModel = (config.model as string) || 'mimo-v2.5-tts'
        const defaultVoice = (config.voice as string) || 'mimo_default'
        const defaultFormat = (config.format as string) || 'wav'

        const provider: SpeechProvider = {
          speech: () => ({
            baseURL: `${baseUrl}/`,
            model: defaultModel,
            fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
              if (!init?.body || typeof init.body !== 'string') {
                throw new Error('Invalid request body')
              }

              const body = JSON.parse(init.body)
              const text = body.input as string
              const modelId = (body.model as string) || defaultModel
              if (!apiKey) {
                throw new Error('MiMo API key is required. Configure the Xiaomi MiMo provider API key first.')
              }
              const format = (body.response_format as string) || defaultFormat
              const stylePrompt = typeof body.style_prompt === 'string'
                ? body.style_prompt.trim()
                : typeof config.stylePrompt === 'string'
                  ? config.stylePrompt.trim()
                  : ''
              const voiceSample = typeof body.voice_sample === 'string'
                ? body.voice_sample.trim()
                : typeof config.voiceSample === 'string'
                  ? config.voiceSample.trim()
                  : ''

              const userPrompt = stylePrompt

              const audio: Record<string, string> = { format }
              if (modelId === 'mimo-v2.5-tts-voiceclone') {
                if (!voiceSample) {
                  throw new Error('MiMo voice clone requires a base64 audio sample in data URI format.')
                }
                audio.voice = voiceSample
              }
              else if (modelId === 'mimo-v2.5-tts') {
                audio.voice = (body.voice as string) || defaultVoice
              }

              if (modelId === 'mimo-v2.5-tts-voicedesign' && !stylePrompt) {
                throw new Error('MiMo voice design requires a style prompt in the user message.')
              }

              const response = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'api-key': apiKey,
                  'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                  model: modelId,
                  messages: [
                    { role: 'user', content: userPrompt },
                    { role: 'assistant', content: text },
                  ],
                  audio,
                }),
              })

              if (!response.ok || !response.body) {
                const errorText = await response.text().catch(() => '')
                throw new Error(`MiMo TTS request failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText.slice(0, 500)}` : ''}`)
              }

              const data = await response.json()
              const audioBase64 = data?.choices?.[0]?.message?.audio?.data
              if (!audioBase64) {
                throw new Error('MiMo TTS response missing audio data')
              }

              const binaryString = atob(audioBase64)
              const bytes = new Uint8Array(binaryString.length)
              for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i)
              }

              const contentType = format === 'wav' ? 'audio/wav' : format === 'mp3' ? 'audio/mpeg' : `audio/${format}`
              return new Response(bytes.buffer, {
                status: 200,
                headers: { 'Content-Type': contentType },
              })
            },
          }),
        }
        return provider
      },
      capabilities: {
        listModels: async () => [
          {
            id: 'mimo-v2.5-tts',
            name: 'MiMo v2.5 TTS',
            provider: 'mimo-audio-speech',
            description: 'Preset voice synthesis with the built-in MiMo voice list',
            contextLength: 0,
            deprecated: false,
          },
          {
            id: 'mimo-v2.5-tts-voicedesign',
            name: 'MiMo v2.5 TTS Voice Design',
            provider: 'mimo-audio-speech',
            description: 'Design a new voice from a natural language description',
            contextLength: 0,
            deprecated: false,
          },
          {
            id: 'mimo-v2.5-tts-voiceclone',
            name: 'MiMo v2.5 TTS Voice Clone',
            provider: 'mimo-audio-speech',
            description: 'Clone a voice from an mp3/wav audio sample',
            contextLength: 0,
            deprecated: false,
          },
        ],
        listVoices: async () => [
          { id: 'mimo_default', name: 'MiMo 默认', provider: 'mimo-audio-speech', gender: 'female', languages: [{ code: 'en', title: 'English' }, { code: 'zh', title: 'Chinese' }] },
          { id: '冰糖', name: '冰糖', provider: 'mimo-audio-speech', gender: 'female', languages: [{ code: 'zh', title: 'Chinese' }] },
          { id: '茉莉', name: '茉莉', provider: 'mimo-audio-speech', gender: 'female', languages: [{ code: 'zh', title: 'Chinese' }] },
          { id: '苏打', name: '苏打', provider: 'mimo-audio-speech', gender: 'male', languages: [{ code: 'zh', title: 'Chinese' }] },
          { id: '白桦', name: '白桦', provider: 'mimo-audio-speech', gender: 'male', languages: [{ code: 'zh', title: 'Chinese' }] },
          { id: 'mimo_default', name: 'MiMo-默认', provider: 'mimo-audio-speech', gender: 'female', languages: [{ code: 'en', title: 'English' }, { code: 'zh', title: 'Chinese' }] },
          { id: '冰糖', name: '冰糖', provider: 'mimo-audio-speech', gender: 'female', languages: [{ code: 'zh', title: 'Chinese' }] },
          { id: '茉莉', name: '茉莉', provider: 'mimo-audio-speech', gender: 'female', languages: [{ code: 'zh', title: 'Chinese' }] },
          { id: '苏打', name: '苏打', provider: 'mimo-audio-speech', gender: 'male', languages: [{ code: 'zh', title: 'Chinese' }] },
          { id: '白桦', name: '白桦', provider: 'mimo-audio-speech', gender: 'male', languages: [{ code: 'zh', title: 'Chinese' }] },
          { id: 'Mia', name: 'Mia', provider: 'mimo-audio-speech', gender: 'female', languages: [{ code: 'en', title: 'English' }] },
          { id: 'Chloe', name: 'Chloe', provider: 'mimo-audio-speech', gender: 'female', languages: [{ code: 'en', title: 'English' }] },
          { id: 'Milo', name: 'Milo', provider: 'mimo-audio-speech', gender: 'male', languages: [{ code: 'en', title: 'English' }] },
          { id: 'Dean', name: 'Dean', provider: 'mimo-audio-speech', gender: 'male', languages: [{ code: 'en', title: 'English' }] },
        ].filter((voice, index, voices) => {
          const officialVoiceIds = new Set(['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'])
          return officialVoiceIds.has(voice.id) && voices.findIndex(candidate => candidate.id === voice.id) === index
        }),
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API key is required.'),
            !config.baseUrl && new Error('Base URL is required.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          return {
            errors,
            reason: errors.map(e => (e as Error).message).join(', ') || '',
            valid: !!config.apiKey && !!config.baseUrl,
          }
        },
      },
    },
    'comet-api-speech': buildOpenAICompatibleProvider({
      id: 'comet-api-speech',
      name: 'CometAPI Speech',
      nameKey: 'settings.pages.providers.provider.comet-api.title',
      descriptionKey: 'settings.pages.providers.provider.comet-api.description',
      icon: 'i-lobe-icons:cometapi',
      description: 'cometapi.com',
      category: 'speech',
      tasks: ['text-to-speech'],
      defaultBaseUrl: 'https://api.cometapi.com/v1/',
      creator: (apiKey, baseURL = 'https://api.cometapi.com/v1/') => merge(
        createModelProvider({ apiKey, baseURL }),
        createSpeechProvider({ apiKey, baseURL }),
      ),
      validation: [ProviderValidationCheck.ModelList],
    }),
    'comet-api-transcription': buildOpenAICompatibleProvider({
      id: 'comet-api-transcription',
      name: 'CometAPI Transcription',
      nameKey: 'settings.pages.providers.provider.comet-api.title',
      descriptionKey: 'settings.pages.providers.provider.comet-api.description',
      icon: 'i-lobe-icons:cometapi',
      description: 'cometapi.com',
      category: 'transcription',
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt'],
      defaultBaseUrl: 'https://api.cometapi.com/v1/',
      creator: (apiKey, baseURL = 'https://api.cometapi.com/v1/') => merge(
        createModelProvider({ apiKey, baseURL }),
        createTranscriptionProvider({ apiKey, baseURL }),
      ),
      validation: [ProviderValidationCheck.ModelList],
    }),
    'mimo-audio-transcription': {
      id: 'mimo-audio-transcription',
      category: 'transcription',
      tasks: ['speech-to-text', 'automatic-speech-recognition', 'asr', 'stt'],
      nameKey: 'settings.pages.providers.provider.mimo.title',
      name: 'Xiaomi MiMo',
      descriptionKey: 'settings.pages.providers.provider.mimo.description',
      description: 'api.xiaomimimo.com',
      icon: 'i-simple-icons:xiaomi',
      defaultOptions: () => ({
        baseUrl: 'https://api.xiaomimimo.com/v1/',
        model: 'mimo-v2-omni',
      }),
      createProvider: async (config) => {
        const apiKey = (config.apiKey as string)?.trim() ?? ''
        const rawBaseUrl = `${((config.baseUrl as string) || 'https://api.xiaomimimo.com/v1/').replace(/\/+$/, '')}/`
        const defaultModel = (config.model as string) || 'mimo-v2-omni'

        const provider: TranscriptionProvider = {
          transcription: model => ({
            baseURL: rawBaseUrl,
            model: model || defaultModel,
            headers: {},
            fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
              const formData = init?.body as FormData
              const file = formData?.get('file') as Blob | null
              const modelName = (formData?.get('model') as string) || defaultModel

              if (!file) {
                throw new Error('No audio file provided for transcription.')
              }

              // Read the file as base64 data URI (works with both Blob and File)
              const base64DataUri: string = await new Promise((resolve, reject) => {
                const reader = new FileReader()
                reader.onload = () => resolve(reader.result as string)
                reader.onerror = () => reject(new Error('Failed to read audio file'))
                reader.readAsDataURL(file)
              })

              // Extract format and base64 data from data URI
              // data:audio/wav;base64,UklGR...
              const mimeType = base64DataUri.split(';')[0]?.split(':')[1] || 'audio/wav'
              const formatFromMime = mimeType.split('/')[1] || 'wav'
              const base64Data = base64DataUri.split(',')[1]

              // Map MIME sub-type to MiMo supported audio format
              const audioFormat = formatFromMime === 'webm'
                ? 'webm'
                : formatFromMime === 'mp4'
                  ? 'mp4'
                  : formatFromMime === 'mpeg' || formatFromMime === 'mp3'
                    ? 'mp3'
                    : 'wav'

              // MiMo audio understanding uses chat completions with input_audio,
              // not a dedicated transcription endpoint
              const response = await fetch(`${rawBaseUrl}chat/completions`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'api-key': apiKey,
                },
                body: JSON.stringify({
                  model: modelName,
                  messages: [
                    {
                      role: 'user',
                      content: [
                        { type: 'text', text: 'Transcribe the audio content.' },
                        {
                          type: 'input_audio',
                          input_audio: {
                            data: base64Data,
                            format: audioFormat,
                          },
                        },
                      ],
                    },
                  ],
                }),
              })

              if (!response.ok) {
                const errorBody = await response.text().catch(() => '')
                throw new Error(
                  `MiMo transcription failed: ${response.status} ${response.statusText}${errorBody ? ` — ${errorBody}` : ''}`,
                )
              }

              const data = await response.json()
              const text = data?.choices?.[0]?.message?.content || ''

              // Return in OpenAI transcription response format { text: "..." }
              return new Response(JSON.stringify({ text }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              })
            },
          }),
        }

        return provider
      },
      capabilities: {
        listModels: async () => [
          {
            id: 'mimo-v2-omni',
            name: 'MiMo V2 Omni',
            provider: 'mimo-audio-transcription',
            description: 'Omni-modal model with native audio understanding and speech-to-text',
            contextLength: 256000,
            deprecated: false,
          },
          {
            id: 'mimo-v2.5',
            name: 'MiMo V2.5',
            provider: 'mimo-audio-transcription',
            description: 'Latest omni-modal model with audio understanding, 1M context',
            contextLength: 1_000_000,
            deprecated: false,
          },
        ],
      },
      transcriptionFeatures: {
        supportsGenerate: true,
        supportsStreamOutput: false,
        supportsStreamInput: false,
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: (config) => {
          const errors = [
            !config.apiKey && new Error('API key is required.'),
            !config.baseUrl && new Error('Base URL is required.'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res) {
            return res
          }

          return {
            errors,
            reason: errors.map(e => (e as Error).message).join(', ') || '',
            valid: !!config.apiKey && !!config.baseUrl,
          }
        },
      },
    },
    'player2-speech': {
      id: 'player2-speech',
      category: 'speech',
      tasks: ['text-to-speech'],
      nameKey: 'settings.pages.providers.provider.player2.title',
      name: 'Player2 Speech',
      descriptionKey: 'settings.pages.providers.provider.player2.description',
      description: 'player2.game',
      icon: 'i-lobe-icons:player2',
      defaultOptions: () => ({
        baseUrl: 'http://localhost:4315/v1/',
      }),
      createProvider: async config => createPlayer2((config.baseUrl as string).trim(), 'airi'),
      capabilities: {
        listModels: async () => {
          return [
            {
              id: 'player2-tts',
              name: 'Player2 Speech',
              provider: 'player2-speech',
              description: 'Default model for Player2 speech endpoint',
              contextLength: 0,
              deprecated: false,
            },
          ]
        },
        listVoices: async (config) => {
          const baseUrl = (config.baseUrl as string).endsWith('/') ? (config.baseUrl as string).slice(0, -1) : config.baseUrl as string
          return await fetch(`${baseUrl}/tts/voices`).then(res => res.json()).then(({ voices }) => (voices as { id: string, language: 'american_english' | 'british_english' | 'japanese' | 'mandarin_chinese' | 'spanish' | 'french' | 'hindi' | 'italian' | 'brazilian_portuguese', name: string, gender: string }[]).map(({ id, language, name, gender }) => (
            {

              id,
              name,
              provider: 'player2-speech',
              gender,
              languages: [{
                american_english: {
                  code: 'en',
                  title: 'English',
                },
                british_english: {
                  code: 'en',
                  title: 'English',
                },
                japanese: {
                  code: 'ja',
                  title: 'Japanese',
                },
                mandarin_chinese: {
                  code: 'zh',
                  title: 'Chinese',
                },
                spanish: {
                  code: 'es',
                  title: 'Spanish',
                },
                french: {
                  code: 'fr',
                  title: 'French',
                },
                hindi: {
                  code: 'hi',
                  title: 'Hindi',
                },

                italian: {
                  code: 'it',
                  title: 'Italian',
                },
                brazilian_portuguese:
                {
                  code: 'pt',
                  title: 'Portuguese',
                },

              }[language]],
            }
          )))
        },
      },
      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: async (config) => {
          const errors = [
            !config.baseUrl && new Error('Base URL is required. Default to http://localhost:4315/v1/'),
          ].filter(Boolean)

          const res = baseUrlValidator.value(config.baseUrl)
          if (res)
            return res

          try {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 5000)
            const response = await fetch(`${config.baseUrl as string}health`, {
              method: 'GET',
              headers: {
                'player2-game-key': 'airi',
              },
              signal: controller.signal,
            })
            clearTimeout(timeout)

            if (!response.ok) {
              const reason = `Player2 speech unreachable: HTTP ${response.status} ${response.statusText}`
              return { errors: [new Error(reason)], reason, valid: false }
            }
          }
          catch (err) {
            const reason = `Player2 speech connection failed: ${String(err)}`
            return { errors: [err as Error], reason, valid: false }
          }

          return {
            errors,
            reason: errors.filter(e => e).map(e => String(e)).join(', ') || '',
            valid: errors.length === 0,
          }
        },
      },
    },
    'kokoro-local': {
      id: 'kokoro-local',
      category: 'speech',
      tasks: ['text-to-speech'],
      nameKey: 'settings.pages.providers.provider.kokoro-local.title',
      name: 'Kokoro TTS',
      descriptionKey: 'settings.pages.providers.provider.kokoro-local.description',
      description: 'Local text-to-speech using Kokoro-82M.',
      icon: 'i-lobe-icons:speaker',

      defaultOptions: () => {
        const capabilities = getCachedWebGPUCapabilities()
        const hasWebGPU = capabilities?.supported ?? (typeof navigator !== 'undefined' && !!navigator.gpu)
        const fp16Supported = capabilities?.fp16Supported ?? false
        const model = getDefaultKokoroModel(hasWebGPU, fp16Supported)
        return {
          model,
          voiceId: '',
        }
      },

      createProvider: async (_config) => {
        // Import the worker manager
        const workerManagerPromise = getKokoroAdapter()

        const provider: SpeechProvider = {
          speech: () => {
            return {
              baseURL: 'http://kokoro-local/v1/',
              model: 'kokoro-82m',
              fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
                try {
                  // Parse OpenAI-compatible request body
                  if (!init?.body || typeof init.body !== 'string') {
                    throw new Error('Invalid request body')
                  }
                  const body = JSON.parse(init.body)
                  const text = body.input
                  const voice = body.voice

                  if (!voice) {
                    throw new Error('Voice parameter is required')
                  }

                  // Generate audio in the worker thread
                  const buffer = await (await workerManagerPromise).generate(text, voice)

                  return new Response(buffer, {
                    status: 200,
                    headers: {
                      'Content-Type': 'audio/wav',
                    },
                  })
                }
                catch (error) {
                  console.error('Kokoro TTS generation failed:', error)
                  throw error
                }
              },
            }
          },
        }

        return provider
      },

      capabilities: {
        listModels: async (_config: Record<string, unknown>) => {
          const caps = getCachedWebGPUCapabilities()
          const hasWebGPU = caps?.supported ?? (typeof navigator !== 'undefined' && !!navigator.gpu)
          const fp16Supported = caps?.fp16Supported ?? false
          return kokoroModelsToModelInfo(hasWebGPU, t, fp16Supported)
        },

        loadModel: async (config: Record<string, unknown>, _hooks?: { onProgress?: (progress: ProgressInfo) => Promise<void> | void }) => {
          const modelId = config.model as string

          if (!modelId) {
            throw new Error('No model specified')
          }

          const modelDef = KOKORO_MODELS.find(m => m.id === modelId)
          if (!modelDef) {
            throw new Error(`Invalid model: ${modelId}. Must be one of: ${KOKORO_MODELS.map(m => m.id).join(', ')}`)
          }

          // Validate platform requirements
          if (modelDef.platform === 'webgpu') {
            const hasWebGPU = getCachedWebGPUCapabilities()?.supported ?? (typeof navigator !== 'undefined' && !!navigator.gpu)
            if (!hasWebGPU) {
              throw new Error('WebGPU is required for this model but is not available in your browser')
            }
          }

          try {
            const workerManager = await getKokoroAdapter()
            await workerManager.loadModel(modelDef.quantization, modelDef.platform, {
              onProgress: _hooks?.onProgress
                ? (p) => {
                    // Map unified ProgressPayload back to ProgressInfo shape
                    // that the provider hooks expect (HuggingFace transformers format)
                    _hooks.onProgress!({
                      name: p.file ?? '',
                      file: p.file ?? '',
                      progress: p.percent >= 0 ? p.percent : 0,
                      status: 'progress',
                      loaded: p.loaded ?? 0,
                      total: p.total ?? 0,
                    } as ProgressInfo)
                  }
                : undefined,
            })
          }
          catch (error) {
            console.error('Failed to load Kokoro model:', error)
            throw error
          }
        },

        listVoices: (() => {
          let lastLoadedModelId: string | null = null
          return async (config: Record<string, unknown>) => {
            try {
              const workerManager = await getKokoroAdapter()
              const modelId = config.model as string

              // Reload the model if it hasn't been loaded yet or if the model ID changed
              if (workerManager.state !== 'ready' || (modelId && modelId !== lastLoadedModelId)) {
                if (modelId) {
                  const modelDef = KOKORO_MODELS.find(m => m.id === modelId)
                  if (modelDef) {
                    if (modelDef.platform === 'webgpu') {
                      const hasWebGPU = getCachedWebGPUCapabilities()?.supported ?? (typeof navigator !== 'undefined' && !!navigator.gpu)
                      if (!hasWebGPU) {
                        throw new Error('WebGPU is required for this model but is not available in your browser')
                      }
                    }

                    await workerManager.loadModel(modelDef.quantization, modelDef.platform)
                    lastLoadedModelId = modelId
                  }
                }
              }

              const modelVoices = workerManager.getVoices()

              // Language code mapping
              const languageMap: Record<string, { code: string, title: string }> = {
                'en-us': { code: 'en-US', title: 'English (US)' },
                'en-gb': { code: 'en-GB', title: 'English (UK)' },
                'ja': { code: 'ja', title: 'Japanese' },
                'zh-cn': { code: 'zh-CN', title: 'Chinese (Mandarin)' },
                'es': { code: 'es', title: 'Spanish' },
                'fr': { code: 'fr', title: 'French' },
                'hi': { code: 'hi', title: 'Hindi' },
                'it': { code: 'it', title: 'Italian' },
                'pt-br': { code: 'pt-BR', title: 'Portuguese (Brazil)' },
              }

              // Transform the voices object to the expected array format
              return Object.entries(modelVoices).map(([id, voice]: [string, { language: string, name: string, gender: string }]) => {
                const languageCode = voice.language.toLowerCase()
                const languageInfo = languageMap[languageCode] || { code: languageCode, title: voice.language }

                return {
                  id,
                  name: `${voice.name} (${voice.gender}, ${languageInfo.title.split('(')[0].trim()})`,
                  provider: 'kokoro-local',
                  languages: [languageInfo],
                  gender: voice.gender.toLowerCase(),
                }
              })
            }
            catch (error) {
              console.error('Failed to fetch Kokoro voices:', error)
              // Return empty array if model not loaded yet
              return []
            }
          }
        })(),
      },

      validators: {
        chatPingCheckAvailable: false,
        validateProviderConfig: async (config: any) => {
          const model = config.model as string

          if (!model) {
            return {
              errors: [new Error('No model selected')],
              reason: 'Please select a model from the dropdown menu',
              valid: false,
            }
          }

          if (!KOKORO_MODELS.some(m => m.id === model)) {
            return {
              errors: [new Error(`Invalid model: ${model}`)],
              reason: `Invalid model. Must be one of: ${KOKORO_MODELS.map(m => m.id).join(', ')}`,
              valid: false,
            }
          }

          return {
            errors: [],
            reason: '',
            valid: true,
          }
        },
      },
    },
  }

  // Progressive migration bridge:
  // translate unified provider definitions from libs/providers to legacy store metadata.
  // Existing metadata remains as fallback for providers not yet migrated.
  const definedProviders = listDefinedProviders()

  const translatedProviderMetadata = convertProviderDefinitionsToMetadata(
    definedProviders,
    t,
    providerMetadata,
  )

  const providerValidationIntervalMsById = new Map<string, number>()
  for (const definition of definedProviders) {
    const intervalMs = getProviderValidationIntervalMs({
      definition,
      contextOptions: { t },
    })
    if (intervalMs && intervalMs > 0) {
      providerValidationIntervalMsById.set(definition.id, intervalMs)
    }
  }

  // Merge unified registry definitions into providerMetadata.
  // Unified defineProvider() entries always take precedence over legacy hand-written
  // metadata. Legacy entries are kept only as fallback for providers not yet migrated
  // to defineProvider().
  // TODO: progressively migrate legacy speech/transcription providers to defineProvider()
  // and remove the hand-written metadata above entirely.
  for (const [providerId, translated] of Object.entries(translatedProviderMetadata)) {
    providerMetadata[providerId] = translated
  }

  // const validatedCredentials = ref<Record<string, string>>({})
  const providerRuntimeState = ref<Record<string, ProviderRuntimeState>>({})
  const visionProviderRuntimeState = ref<Record<string, Pick<ProviderRuntimeState, 'models' | 'isLoadingModels' | 'modelLoadError'>>>({})
  const providerValidationInFlight = new Map<string, Promise<boolean>>()
  const modelListRequests = new Map<string, { controller: AbortController, sequence: number }>()
  let modelListRequestSequence = 0
  const providerRevalidationLoops = new Map<string, { resume: () => void }>()

  const configuredProviders = computed(() => {
    const result: Record<string, boolean> = {}
    for (const [key, state] of Object.entries(providerRuntimeState.value)) {
      result[key] = state.isConfigured
    }

    return result
  })

  function markProviderAdded(providerId: string) {
    addedProviders.value[providerId] = true
  }

  function unmarkProviderAdded(providerId: string) {
    delete addedProviders.value[providerId]
  }

  // Configuration validation functions
  async function validateProvider(providerId: string, options: { force?: boolean } = {}): Promise<boolean> {
    const metadata = providerMetadata[providerId]
    if (!metadata)
      return false

    // Web Speech API doesn't require credentials - use empty config if not present
    if (providerId === 'browser-web-speech-api') {
      if (!providerCredentials.value[providerId]) {
        providerCredentials.value[providerId] = getDefaultProviderConfig(providerId)
      }
    }

    const config = providerCredentials.value[providerId]
    if (!config && providerId !== 'browser-web-speech-api')
      return false

    const configString = JSON.stringify(config || {})
    const runtimeState = providerRuntimeState.value[providerId]
    const cacheKey = `${providerId}:${configString}`
    const forceValidation = options.force === true

    if (!forceValidation && runtimeState?.validatedCredentialHash === configString && typeof runtimeState.isConfigured === 'boolean')
      return runtimeState.isConfigured

    if (!forceValidation) {
      const pending = providerValidationInFlight.get(cacheKey)
      if (pending) {
        return pending
      }
    }

    const runValidation = async () => {
      // PITFALL: Please consider skip chat ping check during automatic/background validation,
      // since this can consume API tokens and may only be triggered
      // by user action (e.g. "Ping API" button on settings pages) or other user intentions.
      const validationResult = await metadata.validators.validateProviderConfig(config || {}, {
        skipChatPingCheck: true,
      })

      if (providerRuntimeState.value[providerId]) {
        providerRuntimeState.value[providerId].isConfigured = validationResult.valid
        providerRuntimeState.value[providerId].validatedCredentialHash = configString
        // Auto-mark Web Speech API as added if valid and available
        if (validationResult.valid && ['browser-web-speech-api', 'player2'].includes(providerId)) {
          markProviderAdded(providerId)
        }
      }

      return validationResult.valid
    }

    if (forceValidation) {
      return runValidation()
    }

    const task = runValidation()
    providerValidationInFlight.set(cacheKey, task)
    return task.finally(() => {
      providerValidationInFlight.delete(cacheKey)
    })
  }

  // Create computed properties for each provider's configuration status

  function getDefaultProviderConfig(providerId: string) {
    const metadata = providerMetadata[providerId]
    const defaultOptions = metadata?.defaultOptions?.() || {}
    return {
      ...defaultOptions,
      ...(Object.hasOwn(defaultOptions, 'baseUrl') ? {} : { baseUrl: '' }),
    }
  }

  // Initialize provider configurations
  function initializeProvider(providerId: string) {
    if (!providerCredentials.value[providerId]) {
      providerCredentials.value[providerId] = getDefaultProviderConfig(providerId)
    }
    if (!providerRuntimeState.value[providerId]) {
      providerRuntimeState.value[providerId] = {
        isConfigured: false,
        models: [],
        isLoadingModels: false,
        modelLoadError: null,
      }
    }
    if (!visionProviderRuntimeState.value[providerId]) {
      visionProviderRuntimeState.value[providerId] = {
        models: [],
        isLoadingModels: false,
        modelLoadError: null,
      }
    }
  }

  // Initialize all providers
  Object.keys(providerMetadata).forEach(initializeProvider)

  function startPeriodicRuntimeValidation() {
    for (const [providerId, intervalMs] of providerValidationIntervalMsById.entries()) {
      if (!providerMetadata[providerId] || intervalMs <= 0)
        continue

      if (providerRevalidationLoops.has(providerId)) {
        continue
      }

      const loop = useIntervalFn(() => {
        void validateProvider(providerId, { force: true })
      }, intervalMs, { immediate: false, immediateCallback: false })
      loop.resume()
      providerRevalidationLoops.set(providerId, loop)
    }
  }

  // Update configuration status for all configured providers
  async function updateConfigurationStatus() {
    await Promise.all(Object.entries(providerMetadata)
      // TODO: ignore un-configured provider
      // .filter(([_, provider]) => provider.configured)
      .map(async ([providerId]) => {
        try {
          if (providerRuntimeState.value[providerId]) {
            const isValid = await validateProvider(providerId)
            providerRuntimeState.value[providerId].isConfigured = isValid
          }
        }
        catch {
          if (providerRuntimeState.value[providerId]) {
            providerRuntimeState.value[providerId].isConfigured = false
          }
        }
      }))
  }

  // Call initially and watch for changes
  watch(providerCredentials, updateConfigurationStatus, { deep: true, immediate: true })
  startPeriodicRuntimeValidation()

  watch(() => authState.isAuthenticated, updateConfigurationStatus)

  // Available providers (only those that are properly configured)
  const availableProviders = computed(() => Object.keys(providerMetadata).filter(providerId => providerRuntimeState.value[providerId]?.isConfigured))

  // Store available models for each provider
  const availableModels = computed(() => {
    const result: Record<string, ModelInfo[]> = {}
    for (const [key, state] of Object.entries(providerRuntimeState.value)) {
      result[key] = state.models
    }
    return result
  })

  const isLoadingModels = computed(() => {
    const result: Record<string, boolean> = {}
    for (const [key, state] of Object.entries(providerRuntimeState.value)) {
      result[key] = state.isLoadingModels
    }
    return result
  })

  const modelLoadError = computed(() => {
    const result: Record<string, string | null> = {}
    for (const [key, state] of Object.entries(providerRuntimeState.value)) {
      result[key] = state.modelLoadError
    }
    return result
  })

  const isLoadingVisionModels = computed(() => {
    const result: Record<string, boolean> = {}
    for (const [key, state] of Object.entries(visionProviderRuntimeState.value)) {
      result[key] = state.isLoadingModels
    }
    return result
  })

  const visionModelLoadError = computed(() => {
    const result: Record<string, string | null> = {}
    for (const [key, state] of Object.entries(visionProviderRuntimeState.value)) {
      result[key] = state.modelLoadError
    }
    return result
  })

  function deleteProvider(providerId: string) {
    modelListRequests.get(providerId)?.controller.abort()
    modelListRequests.delete(providerId)
    delete providerCredentials.value[providerId]
    delete providerRuntimeState.value[providerId]
    delete visionProviderRuntimeState.value[providerId]
    unmarkProviderAdded(providerId)
  }

  function forceProviderConfigured(providerId: string) {
    if (providerRuntimeState.value[providerId]) {
      providerRuntimeState.value[providerId].isConfigured = true
      // Also cache the current config to prevent re-validation from overwriting
      const config = providerCredentials.value[providerId]
      if (config) {
        providerRuntimeState.value[providerId].validatedCredentialHash = JSON.stringify(config)
      }
    }
    markProviderAdded(providerId)
  }

  function setProviderUnconfigured(providerId: string) {
    if (providerRuntimeState.value[providerId]) {
      providerRuntimeState.value[providerId].isConfigured = false
      providerRuntimeState.value[providerId].validatedCredentialHash = undefined
    }
    unmarkProviderAdded(providerId)
  }

  async function resetProviderSettings() {
    for (const request of modelListRequests.values())
      request.controller.abort()
    modelListRequests.clear()
    providerCredentials.value = {}
    addedProviders.value = {}
    providerRuntimeState.value = {}
    visionProviderRuntimeState.value = {}

    Object.keys(providerMetadata).forEach(initializeProvider)
    await updateConfigurationStatus()
  }

  // Function to fetch models for a specific provider
  async function fetchModelsForProvider(providerId: string) {
    const metadata = providerMetadata[providerId]
    if (!metadata)
      return []

    const config = providerCredentials.value[providerId]
    if (!config && metadata.requiresCredentials !== false)
      return []

    const runtimeState = providerRuntimeState.value[providerId]
    modelListRequests.get(providerId)?.controller.abort()
    const request = {
      controller: new AbortController(),
      sequence: ++modelListRequestSequence,
    }
    modelListRequests.set(providerId, request)
    if (runtimeState) {
      runtimeState.isLoadingModels = true
      runtimeState.modelLoadError = null
    }

    try {
      const models = metadata.capabilities.listModels
        ? await metadata.capabilities.listModels(config || {}, { signal: request.controller.signal })
        : []

      if (modelListRequests.get(providerId)?.sequence !== request.sequence)
        return runtimeState?.models ?? []

      // Transform and store the models
      if (runtimeState) {
        runtimeState.models = uniqBy(models.filter(model => !!model.id), m => m.id)
          .map(model => ({
            id: model.id,
            name: model.name,
            description: model.description,
            contextLength: model.contextLength,
            deprecated: model.deprecated,
            provider: providerId,
          }))
        return runtimeState.models
      }
      return []
    }
    catch (error) {
      if (request.controller.signal.aborted)
        return runtimeState?.models ?? []
      console.error(`Error fetching models for ${providerId}:`, error)
      if (runtimeState) {
        runtimeState.modelLoadError = errorMessageFrom(error) ?? 'Unknown error'
      }
      return []
    }
    finally {
      if (modelListRequests.get(providerId)?.sequence === request.sequence) {
        modelListRequests.delete(providerId)
      }
      if (runtimeState && modelListRequests.get(providerId) === undefined) {
        runtimeState.isLoadingModels = false
      }
    }
  }

  // Get models for a specific provider
  function getModelsForProvider(providerId: string) {
    return providerRuntimeState.value[providerId]?.models || []
  }

  async function fetchVisionModelsForProvider(providerId: string) {
    const metadata = providerMetadata[providerId]
    if (!metadata)
      return []

    const config = providerCredentials.value[providerId]
    if (!config && metadata.requiresCredentials !== false)
      return []

    if (!visionProviderRuntimeState.value[providerId]) {
      visionProviderRuntimeState.value[providerId] = {
        models: [],
        isLoadingModels: false,
        modelLoadError: null,
      }
    }

    const runtimeState = visionProviderRuntimeState.value[providerId]
    runtimeState.isLoadingModels = true
    runtimeState.modelLoadError = null

    try {
      const rawModels = metadata.capabilities.listModels ? await metadata.capabilities.listModels(config || {}) : []
      const models = metadata.category === 'vision'
        ? rawModels
        : filterVisionModels(providerId, rawModels)

      runtimeState.models = uniqBy(models.filter(model => !!model.id), m => m.id)
        .map(model => ({
          id: model.id,
          name: model.name,
          description: model.description,
          contextLength: model.contextLength,
          deprecated: model.deprecated,
          provider: providerId,
          capabilities: model.capabilities,
        }))
      return runtimeState.models
    }
    catch (error) {
      console.error(`Error fetching vision models for ${providerId}:`, error)
      runtimeState.modelLoadError = errorMessageFrom(error) ?? 'Unknown error'
      return []
    }
    finally {
      runtimeState.isLoadingModels = false
    }
  }

  function getVisionModelsForProvider(providerId: string) {
    return visionProviderRuntimeState.value[providerId]?.models || []
  }

  // Get all available models across all configured providers
  const allAvailableModels = computed(() => {
    const models: ModelInfo[] = []
    for (const providerId of availableProviders.value) {
      models.push(...(providerRuntimeState.value[providerId]?.models || []))
    }
    return models
  })

  // Load models for all configured providers
  async function loadModelsForConfiguredProviders() {
    for (const providerId of availableProviders.value) {
      if (providerMetadata[providerId].capabilities.listModels) {
        await fetchModelsForProvider(providerId)
      }
    }
  }
  const previousCredentialHashes = ref<Record<string, string>>({})

  // Watch for credential changes and refetch models accordingly
  watch(providerCredentials, (newCreds) => {
    const changedProviders: string[] = []

    for (const providerId in newCreds) {
      const currentConfig = newCreds[providerId]
      const currentHash = JSON.stringify(currentConfig)
      const previousHash = previousCredentialHashes.value[providerId]

      if (currentHash !== previousHash) {
        changedProviders.push(providerId)
        previousCredentialHashes.value[providerId] = currentHash
      }
    }

    for (const providerId of changedProviders) {
      // Since credentials changed, dispose the cached instance so new creds take effect.
      void disposeProviderInstance(providerId)

      // If the provider is configured and has the capability, refetch its models
      if (providerRuntimeState.value[providerId]?.isConfigured && providerMetadata[providerId]?.capabilities.listModels) {
        fetchModelsForProvider(providerId)
      }
    }
  }, { deep: true, immediate: true })

  // Function to get localized provider metadata
  function getProviderMetadata(providerId: string) {
    const metadata = providerMetadata[providerId]

    if (!metadata)
      throw new Error(`Provider metadata for ${providerId} not found`)

    return {
      ...metadata,
      localizedName: t(metadata.nameKey, metadata.name),
      localizedDescription: t(metadata.descriptionKey, metadata.description),
    }
  }

  // Get all providers metadata (for settings page).
  // Order: defined providers first (already sorted by order in registry), then legacy-only providers.
  const definedProviderIds = new Set(definedProviders.map(d => d.id))

  const allProvidersMetadata = computed(() => {
    const localize = (metadata: ProviderMetadata) => ({
      ...metadata,
      localizedName: t(metadata.nameKey, metadata.name),
      localizedDescription: t(metadata.descriptionKey, metadata.description),
      configured: providerRuntimeState.value[metadata.id]?.isConfigured || false,
    })

    const ordered = definedProviders
      .filter(d => providerMetadata[d.id])
      .map(d => localize(providerMetadata[d.id]))

    const legacy = Object.values(providerMetadata)
      .filter(m => !definedProviderIds.has(m.id))
      .map(localize)

    return [...ordered, ...legacy]
  })

  function getTranscriptionFeatures(providerId: string) {
    const metadata = providerMetadata[providerId]
    const features = metadata?.transcriptionFeatures

    return {
      supportsGenerate: features?.supportsGenerate ?? true,
      supportsStreamOutput: features?.supportsStreamOutput ?? false,
      supportsStreamInput: features?.supportsStreamInput ?? false,
    }
  }

  // Function to get provider object by provider id
  async function getProviderInstance<R extends
  | ChatProvider
  | ChatProviderWithExtraOptions
  | EmbedProvider
  | EmbedProviderWithExtraOptions
  | SpeechProvider
  | SpeechProviderWithExtraOptions
  | TranscriptionProvider
  | TranscriptionProviderWithExtraOptions,
  >(providerId: string): Promise<R> {
    const cached = providerInstanceCache.value[providerId] as R | undefined
    if (cached)
      return cached

    const metadata = providerMetadata[providerId]
    if (!metadata)
      throw new Error(`Provider metadata for ${providerId} not found`)

    // Providers that don't require credentials use empty config
    let config = providerCredentials.value[providerId]
    const noCredentials = metadata.requiresCredentials === false || providerId === 'browser-web-speech-api'
    if (!config && noCredentials) {
      config = getDefaultProviderConfig(providerId) || {}
      providerCredentials.value[providerId] = config
    }

    if (!config && !noCredentials)
      throw new Error(`Provider credentials for ${providerId} not found`)

    try {
      const instance = await metadata.createProvider(config || {}) as R
      providerInstanceCache.value[providerId] = instance
      return instance
    }
    catch (error) {
      console.error(`Error creating provider instance for ${providerId}:`, error)
      throw error
    }
  }

  async function disposeProviderInstance(providerId: string) {
    modelListRequests.get(providerId)?.controller.abort()
    modelListRequests.delete(providerId)
    const instance = providerInstanceCache.value[providerId] as { dispose?: () => Promise<void> | void } | undefined
    if (instance?.dispose)
      await instance.dispose()

    delete providerInstanceCache.value[providerId]
  }

  const availableProvidersMetadata = computedAsync<ProviderMetadata[]>(async () => {
    const providers: ProviderMetadata[] = []

    for (const provider of allProvidersMetadata.value) {
      const p = getProviderMetadata(provider.id)
      const isAvailableBy = p.isAvailableBy || (() => true)

      const isAvailable = await isAvailableBy()
      if (isAvailable) {
        providers.push(provider)
      }
    }

    return providers
  }, [])

  const allChatProvidersMetadata = computed(() => {
    return availableProvidersMetadata.value.filter(metadata => metadata.category === 'chat')
  })

  const allAudioSpeechProvidersMetadata = computed(() => {
    return availableProvidersMetadata.value.filter(metadata => metadata.category === 'speech')
  })

  const allAudioTranscriptionProvidersMetadata = computed(() => {
    return availableProvidersMetadata.value.filter(metadata => metadata.category === 'transcription')
  })

  const allVisionProvidersMetadata = computed(() => {
    return availableProvidersMetadata.value.filter((metadata) => {
      if (metadata.category === 'vision')
        return true
      if (metadata.category !== 'chat')
        return false
      // The chat OpenAI-compatible provider is intentionally not reused here:
      // vision has its own OpenAI-compatible provider so consciousness and
      // vision can point at different base URLs/API vendors.
      return metadata.id !== 'openai-compatible'
    })
  })

  const configuredChatProvidersMetadata = computed(() => {
    return allChatProvidersMetadata.value.filter(metadata => configuredProviders.value[metadata.id])
  })

  const configuredSpeechProvidersMetadata = computed(() => {
    return allAudioSpeechProvidersMetadata.value.filter(metadata => configuredProviders.value[metadata.id])
  })

  const configuredTranscriptionProvidersMetadata = computed(() => {
    return allAudioTranscriptionProvidersMetadata.value.filter(metadata => configuredProviders.value[metadata.id])
  })

  const configuredVisionProvidersMetadata = computed(() => {
    return allVisionProvidersMetadata.value.filter(metadata => configuredProviders.value[metadata.id])
  })

  function isProviderConfigDirty(providerId: string) {
    const config = providerCredentials.value[providerId]
    if (!config)
      return false

    const defaultOptions = getDefaultProviderConfig(providerId)
    return JSON.stringify(config) !== JSON.stringify(defaultOptions)
  }

  function shouldListProvider(providerId: string) {
    return !!addedProviders.value[providerId] || isProviderConfigDirty(providerId)
  }

  const persistedProvidersMetadata = computed(() => {
    return availableProvidersMetadata.value.filter(metadata => shouldListProvider(metadata.id))
  })

  const persistedChatProvidersMetadata = computed(() => {
    return persistedProvidersMetadata.value.filter(metadata => metadata.category === 'chat')
  })

  const persistedSpeechProvidersMetadata = computed(() => {
    return persistedProvidersMetadata.value.filter(metadata => metadata.category === 'speech')
  })

  const persistedTranscriptionProvidersMetadata = computed(() => {
    return persistedProvidersMetadata.value.filter(metadata => metadata.category === 'transcription')
  })

  const persistedVisionProvidersMetadata = computed(() => {
    return persistedProvidersMetadata.value.filter(metadata => metadata.category === 'vision')
  })

  function getProviderConfig(providerId: string) {
    return providerCredentials.value[providerId]
  }

  return {
    providers: providerCredentials,
    getProviderConfig,
    addedProviders,
    markProviderAdded,
    unmarkProviderAdded,
    deleteProvider,
    availableProviders,
    configuredProviders,
    providerRuntimeState,
    visionProviderRuntimeState,
    providerMetadata,
    getProviderMetadata,
    getTranscriptionFeatures,
    allProvidersMetadata,
    initializeProvider,
    validateProvider,
    availableModels,
    isLoadingModels,
    modelLoadError,
    isLoadingVisionModels,
    visionModelLoadError,
    fetchModelsForProvider,
    getModelsForProvider,
    fetchVisionModelsForProvider,
    getVisionModelsForProvider,
    allAvailableModels,
    loadModelsForConfiguredProviders,
    getProviderInstance,
    disposeProviderInstance,
    resetProviderSettings,
    forceProviderConfigured,
    setProviderUnconfigured,
    availableProvidersMetadata,
    allChatProvidersMetadata,
    allAudioSpeechProvidersMetadata,
    allAudioTranscriptionProvidersMetadata,
    allVisionProvidersMetadata,
    configuredChatProvidersMetadata,
    configuredSpeechProvidersMetadata,
    configuredTranscriptionProvidersMetadata,
    configuredVisionProvidersMetadata,
    persistedProvidersMetadata,
    persistedChatProvidersMetadata,
    persistedSpeechProvidersMetadata,
    persistedTranscriptionProvidersMetadata,
    persistedVisionProvidersMetadata,
  }
})
