import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useProvidersStore } from '../providers'
import { useSpeechStore } from './speech'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    locale: 'zh-CN',
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

describe('speech module configuration status', () => {
  beforeEach(() => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size
      },
    })
    setActivePinia(createPinia())
  })

  it('treats MiMo voice clone as configured when the provider has a voice sample', () => {
    const providersStore = useProvidersStore()
    providersStore.providers['mimo-audio-speech'] = {
      apiKey: 'mimo_test_key',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5-tts-voiceclone',
      voiceSample: 'data:audio/wav;base64,UklGRg==',
    }

    const speechStore = useSpeechStore()
    speechStore.activeSpeechProvider = 'mimo-audio-speech'
    speechStore.activeSpeechModel = 'mimo-v2.5-tts-voiceclone'
    speechStore.activeSpeechVoiceId = ''

    expect(speechStore.configured).toBe(true)
  })

  it('does not treat MiMo voice clone as configured without a voice sample', () => {
    const providersStore = useProvidersStore()
    providersStore.providers['mimo-audio-speech'] = {
      apiKey: 'mimo_test_key',
      baseUrl: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5-tts-voiceclone',
      voiceSample: '',
    }

    const speechStore = useSpeechStore()
    speechStore.activeSpeechProvider = 'mimo-audio-speech'
    speechStore.activeSpeechModel = 'mimo-v2.5-tts-voiceclone'
    speechStore.activeSpeechVoiceId = ''

    expect(speechStore.configured).toBe(false)
  })

  it('accepts a previously tested DashScope CosyVoice endpoint without a trailing slash', async () => {
    const providersStore = useProvidersStore()
    const config = {
      apiKey: 'dashscope_test_key',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
      model: 'cosyvoice-v3.5-flash',
      customVoiceId: 'cosyvoice-v3.5-flash-lumi-test',
      region: 'cn',
      format: 'wav',
      sampleRate: 24000,
      languageHint: 'zh',
      apiTestPassed: true,
      apiTestConfigHash: JSON.stringify({
        apiKey: 'dashscope_test_key',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
        model: 'cosyvoice-v3.5-flash',
        customVoiceId: 'cosyvoice-v3.5-flash-lumi-test',
        region: 'cn',
        format: 'wav',
        sampleRate: 24000,
        languageHint: 'zh',
      }),
    }

    const validation = await providersStore.getProviderMetadata('alibaba-cloud-model-studio').validators.validateProviderConfig(config)

    expect(validation.valid).toBe(true)
  })

  it('treats Alibaba CosyVoice v3.5 as configured when a custom voice_id is present', () => {
    const providersStore = useProvidersStore()
    providersStore.providers['alibaba-cloud-model-studio'] = {
      apiKey: 'dashscope_test_key',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer',
      model: 'cosyvoice-v3.5-flash',
      customVoiceId: 'cosyvoice-v3.5-flash-lumi-test',
    }

    const speechStore = useSpeechStore()
    speechStore.activeSpeechProvider = 'alibaba-cloud-model-studio'
    speechStore.activeSpeechModel = 'cosyvoice-v3.5-flash'
    speechStore.activeSpeechVoiceId = ''

    expect(speechStore.configured).toBe(true)
  })
})
