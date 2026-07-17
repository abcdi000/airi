import type { SpeechProvider } from '@xsai-ext/providers/utils'

import { z } from 'zod'

import { defineProvider } from '../registry'

const DEFAULT_BASE_URL = 'http://127.0.0.1:8766/v1/'
const DEFAULT_MODEL = 'Qwen/Qwen3-TTS-12Hz-0.6B-Base'

const qwen3TtsLocalConfigSchema = z.object({
  baseUrl: z.string().optional().default(DEFAULT_BASE_URL),
  model: z.string().optional().default(DEFAULT_MODEL),
  voiceId: z.string().optional().default('lumi_clone'),
  language: z.string().optional().default('Chinese'),
  refAudioPath: z.string().optional().default(''),
  refText: z.string().optional().default(''),
  speaker: z.string().optional().default('Serena'),
  xVectorOnlyMode: z.boolean().optional().default(false),
  hybridCloudRequestTimeoutMs: z.number().optional().default(18000),
})

type Qwen3TtsLocalConfig = z.input<typeof qwen3TtsLocalConfigSchema>

function normalizeBaseUrl(baseUrl: string | undefined) {
  const value = (baseUrl || DEFAULT_BASE_URL).trim()
  return value.endsWith('/') ? value : `${value}/`
}

function buildModels(providerId: string) {
  return [
    {
      id: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
      name: 'Qwen3-TTS 0.6B Base (Voice Clone)',
      provider: providerId,
      description: 'Smallest Qwen3-TTS voice clone model. Best first test for laptop GPUs.',
    },
    {
      id: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
      name: 'Qwen3-TTS 1.7B Base (Voice Clone)',
      provider: providerId,
      description: 'Higher quality voice clone model with higher VRAM and latency cost.',
    },
    {
      id: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
      name: 'Qwen3-TTS 0.6B Custom Voice',
      provider: providerId,
      description: 'Preset-speaker model for quick local tests without reference audio.',
    },
    {
      id: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
      name: 'Qwen3-TTS 1.7B Custom Voice',
      provider: providerId,
      description: 'Higher quality preset-speaker model.',
    },
  ]
}

export const providerQwen3TtsLocal = defineProvider<Qwen3TtsLocalConfig>({
  id: 'qwen3-tts-local',
  order: 41,
  name: 'Qwen3-TTS Local',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.qwen3-tts-local.title'),
  description: 'Local Qwen3-TTS voice synthesis service.',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.qwen3-tts-local.description'),
  tasks: ['text-to-speech', 'tts'],
  icon: 'i-lobe-icons:huggingface',
  requiresCredentials: false,
  capabilities: {
    speech: { transport: 'bidirectional-ws' },
  },
  createProviderConfig: ({ t }) => qwen3TtsLocalConfigSchema.extend({
    baseUrl: qwen3TtsLocalConfigSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: 'Local Qwen3-TTS service URL. Default: http://127.0.0.1:8766/v1/',
      placeholderLocalized: DEFAULT_BASE_URL,
    }),
  }),
  createProvider(config) {
    const baseUrl = normalizeBaseUrl(config.baseUrl)
    const provider: SpeechProvider = {
      speech: (model: string, options?: Record<string, unknown>) => {
        return {
          baseURL: baseUrl,
          model: model || config.model || DEFAULT_MODEL,
          fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
            const body = typeof init?.body === 'string'
              ? JSON.parse(init.body) as Record<string, unknown>
              : {}

            const mergedBody = {
              ...body,
              model: body.model || model || config.model || DEFAULT_MODEL,
              voice: body.voice || config.voiceId || 'lumi_clone',
              extra_body: {
                ...(typeof body.extra_body === 'object' && body.extra_body != null ? body.extra_body as Record<string, unknown> : {}),
                ...options,
                language: options?.language || config.language || 'Chinese',
                ref_audio: options?.ref_audio || config.refAudioPath || '',
                ref_text: options?.ref_text || config.refText || '',
                speaker: options?.speaker || config.speaker || 'Serena',
                x_vector_only_mode: options?.x_vector_only_mode ?? config.xVectorOnlyMode === true,
              },
            }

            return globalThis.fetch(new URL('audio/speech', baseUrl), {
              ...init,
              method: init?.method || 'POST',
              headers: {
                ...(init?.headers as Record<string, string> | undefined),
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(mergedBody),
            })
          },
        }
      },
    }
    return provider
  },
  validationRequiredWhen(config) {
    return !!normalizeBaseUrl(config.baseUrl)
  },
  extraMethods: {
    listModels: async (config) => {
      const baseUrl = normalizeBaseUrl(config.baseUrl)
      try {
        const res = await globalThis.fetch(new URL('audio/models', baseUrl), { signal: AbortSignal.timeout(1500) })
        if (res.ok) {
          const data = await res.json() as { models?: Array<{ id: string, name?: string, description?: string }> }
          if (Array.isArray(data.models) && data.models.length > 0) {
            return data.models.map(model => ({
              id: model.id,
              name: model.name || model.id,
              description: model.description || '',
              provider: 'qwen3-tts-local',
            }))
          }
        }
      }
      catch {}

      return buildModels('qwen3-tts-local')
    },
    listVoices: async (config) => {
      const baseUrl = normalizeBaseUrl(config.baseUrl)
      try {
        const res = await globalThis.fetch(new URL('audio/voices', baseUrl), { signal: AbortSignal.timeout(1500) })
        if (res.ok) {
          const data = await res.json() as { voices?: Array<{ id: string, name?: string, description?: string }> }
          if (Array.isArray(data.voices) && data.voices.length > 0) {
            return data.voices.map(voice => ({
              id: voice.id,
              name: voice.name || voice.id,
              description: voice.description || '',
              provider: 'qwen3-tts-local',
              languages: [{ code: 'zh-CN', title: 'Chinese' }],
              gender: 'female',
            }))
          }
        }
      }
      catch {}

      return [{
        id: config.voiceId || 'lumi_clone',
        name: config.voiceId || 'Lumi Clone',
        provider: 'qwen3-tts-local',
        description: 'Local Qwen3-TTS reference voice.',
        languages: [{ code: 'zh-CN', title: 'Chinese' }],
        gender: 'female',
      }]
    },
  },
  validators: {
    validateConfig: [() => ({
      id: 'qwen3-tts-local:base-url',
      name: 'Base URL',
      validator: (config) => {
        try {
          const baseUrl = normalizeBaseUrl(config.baseUrl)
          const url = new URL(baseUrl)
          if (!['http:', 'https:'].includes(url.protocol)) {
            return {
              errors: [{ error: new Error('Base URL must use http or https') }],
              reason: 'Base URL must use http or https',
              reasonKey: '',
              valid: false,
            }
          }
          return { errors: [], reason: '', reasonKey: '', valid: true }
        }
        catch (error) {
          return {
            errors: [{ error }],
            reason: 'Base URL is invalid',
            reasonKey: '',
            valid: false,
          }
        }
      },
    })],
  },
})
