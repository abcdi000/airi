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
  it('seeds a minimal Lumi identity card without changing active card', () => {
    const cardStore = useAiriCardStore()

    cardStore.initialize()

    const lumi = cardStore.getCard('lumi')
    expect(cardStore.activeCardId).toBe('default')
    expect(lumi?.name).toBe('Lumi')
    expect(lumi?.description).not.toBe('')
    expect(lumi?.personality).not.toBe('')
    expect(lumi?.systemPrompt).toBe('')
    expect(lumi?.scenario).toBe('')
    expect(lumi?.postHistoryInstructions).toBe('')
    expect(lumi?.messageExample).toEqual([])
  })

  /**
   * @example
   * it('projects only basic identity fields into the Agent Runtime prompt', () => {})
   */
  it('projects only basic identity fields into the Agent Runtime prompt', () => {
    const cardStore = useAiriCardStore()
    cardStore.initialize()
    cardStore.activeCardId = 'lumi'

    const lumi = cardStore.getCard('lumi')
    if (!lumi)
      throw new Error('Expected built-in Lumi card')

    cardStore.updateCard('lumi', {
      ...lumi,
      description: 'runtime-description',
      personality: 'runtime-personality',
      systemPrompt: 'legacy-system-prompt',
      scenario: 'runtime-scenario',
      postHistoryInstructions: 'runtime-guidance',
      messageExample: [
        [
          '{{user}}: runtime-user-example',
          '{{char}}: runtime-lumi-example',
        ],
      ],
      extensions: {
        ...lumi.extensions,
        airi: {
          ...lumi.extensions.airi,
          modules: {
            ...lumi.extensions.airi.modules,
            artistry: {
              ...lumi.extensions.airi.modules.artistry,
              widgetInstruction: 'artistry-only-instruction',
            },
          },
        },
      },
    })

    expect(cardStore.agentRuntimeIdentityAnchor).toContain('名字：Lumi')
    expect(cardStore.agentRuntimeIdentityAnchor).toContain('runtime-description')
    expect(cardStore.agentRuntimeIdentityAnchor).toContain('runtime-personality')
    expect(cardStore.agentRuntimeIdentityAnchor).not.toContain('legacy-system-prompt')
    expect(cardStore.agentRuntimeIdentityAnchor).not.toContain('runtime-scenario')
    expect(cardStore.agentRuntimeIdentityAnchor).not.toContain('runtime-guidance')
    expect(cardStore.agentRuntimeIdentityAnchor).not.toContain('runtime-user-example')
    expect(cardStore.agentRuntimeIdentityAnchor).not.toContain('runtime-lumi-example')
    expect(cardStore.agentRuntimeIdentityAnchor).not.toContain('artistry-only-instruction')
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
    expect(lumi?.version).toBe('2.0.0')
    expect(lumi?.description).not.toBe('old')
    expect(lumi?.personality).not.toBe('old')
    expect(lumi?.systemPrompt).toBe('')
    expect(lumi?.scenario).toBe('')
    expect(lumi?.postHistoryInstructions).toBe('')
    expect(lumi?.messageExample).toEqual([])
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
