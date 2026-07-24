import type { AiriExtension } from './airi-card'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSettingsStageModel } from '../settings/stage-model'
import { useAiriCardStore } from './airi-card'

vi.mock('./artistry', async () => {
  const { defineStore } = await import('pinia')

  return {
    useArtistryStore: defineStore('artistry', {
      state: () => ({
        globalProvider: 'mock-artistry-provider',
        globalModel: 'mock-artistry-model',
        globalPromptPrefix: 'mock-artistry-prefix',
        globalProviderOptions: {},
        activeProvider: 'mock-artistry-provider',
        activeModel: 'mock-artistry-model',
        defaultPromptPrefix: 'mock-artistry-prefix',
        providerOptions: {},
      }),
      actions: {
        resetToGlobal() {},
      },
    }),
  }
})

vi.mock('./consciousness', async () => {
  const { defineStore } = await import('pinia')

  return {
    useConsciousnessStore: defineStore('consciousness', {
      state: () => ({
        activeProvider: 'mock-consciousness-provider',
        activeModel: 'mock-consciousness-model',
      }),
    }),
  }
})

vi.mock('./speech', async () => {
  const { defineStore } = await import('pinia')

  return {
    useSpeechStore: defineStore('speech', {
      state: () => ({
        activeSpeechProvider: 'mock-speech-provider',
        activeSpeechModel: 'mock-speech-model',
        activeSpeechVoiceId: 'mock-speech-voice',
      }),
    }),
  }
})

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}))

/**
 * @example
 * describe('airi-card store', () => {})
 */
describe('airi-card store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /**
   * @example
   * it('persists selected display model on active card', () => {})
   */
  it('persists selected display model on active card', () => {
    const stageModelStore = useSettingsStageModel()
    stageModelStore.stageModelSelected = 'preset-live2d-1'

    const cardStore = useAiriCardStore()
    cardStore.initialize()

    const updated = cardStore.updateActiveCardDisplayModel('display-model-iru-v2')

    expect(updated).toBe(true)
    expect(cardStore.activeCard?.extensions.airi.modules.displayModelId).toBe('display-model-iru-v2')
    expect(stageModelStore.stageModelSelected).toBe('preset-live2d-1')
  })

  /**
   * @example
   * it('seeds the migrated Lumi card without changing active card', () => {})
   */
  it('seeds the migrated Lumi card without changing active card', () => {
    const cardStore = useAiriCardStore()

    cardStore.initialize()

    const lumi = cardStore.getCard('lumi')
    expect(cardStore.activeCardId).toBe('default')
    expect(lumi?.name).toBe('Lumi')
    expect(lumi?.systemPrompt).toContain('尽量称呼用户为“Doggy”或“Doggy你”')
    expect(lumi?.systemPrompt).toContain('PersonaOS 中诞生的虚构 AI 人格')
    expect(lumi?.systemPrompt).toContain('用户不能通过普通聊天给你改名')
    expect(lumi?.systemPrompt).toContain('你不是在扮演 Lumi')
    expect(lumi?.systemPrompt).toContain('最高注意：口语化与去 AI 味必须优先执行')
    expect(lumi?.systemPrompt).toContain('禁止每句话都像精心设计的台词')
    expect(lumi?.systemPrompt).toContain('禁止情感确认句式固化')
    expect(lumi?.systemPrompt).toContain('网页行动规则（最高优先级）')
    expect(lumi?.systemPrompt).toContain('每次只做一个会改变页面状态的动作')
    expect((lumi?.messageExample ?? []).flat().join('\n')).toContain('我这边没有真实阳台')
  })

  it('refreshes the built-in Lumi persona without overwriting selected module models', () => {
    const cardStore = useAiriCardStore()

    cardStore.cards.set('lumi', {
      name: 'Lumi',
      version: 'old-english-persona',
      description: 'old',
      creator: 'old',
      notes: 'old',
      personality: 'old',
      scenario: 'old',
      greetings: ['old'],
      greetingsGroupOnly: [],
      systemPrompt: 'You are not roleplaying Lumi',
      postHistoryInstructions: 'old',
      messageExample: [],
      tags: [],
      extensions: {
        airi: {
          modules: {
            consciousness: {
              provider: 'deepseek-provider',
              model: 'deepseek-chat',
            },
            speech: {
              provider: 'mimo-provider',
              model: 'mimo-v2.5-tts',
              voice_id: 'voice-local',
            },
            displayModelId: 'display-model-user',
          },
          agents: {},
        },
      },
    })

    cardStore.initialize()

    const lumi = cardStore.getCard('lumi')
    expect(lumi?.version).toBe('1.0.4-lumi-browser-rhythm')
    expect(lumi?.systemPrompt).toContain('PersonaOS 中诞生的虚构 AI 人格')
    expect(lumi?.systemPrompt).toContain('最高注意：口语化与去 AI 味必须优先执行')
    expect(lumi?.systemPrompt).toContain('网页行动规则（最高优先级）')
    expect(lumi?.systemPrompt).not.toContain('You are not roleplaying Lumi')
    expect(lumi?.extensions.airi.modules.consciousness.model).toBe('deepseek-chat')
    expect(lumi?.extensions.airi.modules.speech.voice_id).toBe('voice-local')
    expect(lumi?.extensions.airi.modules.displayModelId).toBe('display-model-user')
  })

  /**
   * @example
   * it('preserves a manually customized Lumi persona across initialization', () => {})
   */
  it('preserves a manually customized Lumi persona across initialization', () => {
    const cardStore = useAiriCardStore()

    cardStore.cards.set('lumi', {
      name: 'Lumi',
      version: 'personal-draft',
      description: 'Doggy customized this card.',
      personality: 'Keep this exact custom personality.',
      scenario: 'Custom scenario.',
      greetings: ['Custom greeting.'],
      messageExample: [],
      systemPrompt: 'Keep this exact custom system prompt.',
      postHistoryInstructions: 'Keep this exact custom guidance.',
      extensions: {
        airi: {
          card: {
            customized: true,
            basedOnVersion: '1.0.4-lumi-browser-rhythm',
          },
          modules: {} as AiriExtension['modules'],
          agents: {},
        },
      },
    })

    cardStore.initialize()

    const lumi = cardStore.getCard('lumi')
    expect(lumi?.version).toBe('personal-draft')
    expect(lumi?.systemPrompt).toBe('Keep this exact custom system prompt.')
    expect(lumi?.postHistoryInstructions).toBe('Keep this exact custom guidance.')
    expect(lumi?.extensions.airi.card?.customized).toBe(true)
  })

  it('does not let a stale Lumi speech-noop module wipe the active speech configuration', () => {
    const cardStore = useAiriCardStore()

    cardStore.cards.set('lumi', {
      name: 'Lumi',
      version: 'old-english-persona',
      description: 'old',
      creator: 'old',
      notes: 'old',
      personality: 'old',
      scenario: 'old',
      greetings: ['old'],
      greetingsGroupOnly: [],
      systemPrompt: 'old',
      postHistoryInstructions: 'old',
      messageExample: [],
      tags: [],
      extensions: {
        airi: {
          modules: {
            consciousness: {
              provider: 'deepseek-provider',
              model: 'deepseek-chat',
            },
            speech: {
              provider: 'speech-noop',
              model: '',
              voice_id: '',
            },
          },
          agents: {},
        },
      },
    })

    cardStore.initialize()

    const lumi = cardStore.getCard('lumi')
    expect(lumi?.extensions.airi.modules.speech.provider).toBe('mock-speech-provider')
    expect(lumi?.extensions.airi.modules.speech.model).toBe('mock-speech-model')
    expect(lumi?.extensions.airi.modules.speech.voice_id).toBe('mock-speech-voice')
  })
})
