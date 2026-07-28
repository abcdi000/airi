import type { Card, ccv3 } from '@proj-airi/ccc'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { watchDebounced } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import SystemPromptV2 from '../../constants/prompts/system-v2'

import { createLumiAiriCard, LUMI_AIRI_CARD_ID } from '../../constants/lumi-card'
import { DEFAULT_ARTISTRY_WIDGET_SPAWNING_PROMPT } from '../../constants/prompts/character-defaults'
import { capturePosthogEvent } from '../analytics/posthog'
import { useSettingsStageModel } from '../settings/stage-model'
import { useArtistryStore } from './artistry'
import { useConsciousnessStore } from './consciousness'
import { useSpeechStore } from './speech'

export interface AiriExtension {
  card?: {
    /**
     * Prevents built-in persona refreshes from overwriting a card that the
     * user intentionally edited.
     *
     * @default false
     */
    customized?: boolean
    /** Built-in card version from which this customization originated. */
    basedOnVersion?: string
  }

  modules: {
    consciousness: {
      provider: string // Example: "openai"
      model: string // Example: "gpt-4o"
    }

    speech: {
      provider: string // Example: "elevenlabs"
      model: string // Example: "eleven_multilingual_v2"
      voice_id: string // Example: "alloy"

      pitch?: number
      rate?: number
      ssml?: boolean
      language?: string
    }

    vrm?: {
      source?: 'file' | 'url'
      file?: string // Example: "vrm/model.vrm"
      url?: string // Example: "https://example.com/vrm/model.vrm"
    }

    live2d?: {
      source?: 'file' | 'url'
      file?: string // Example: "live2d/model.json"
      url?: string // Example: "https://example.com/live2d/model.json"
    }

    // ID from display-models store (e.g. 'preset-live2d-1', 'display-model-<nanoid>')
    displayModelId?: string
    activeBackgroundId?: string

    artistry?: {
      enabled?: boolean
      provider?: string
      model?: string
      directorProvider?: string
      directorModel?: string
      promptPrefix?: string
      workflowId?: string
      widgetInstruction?: string
      spawnMode?: 'bg' | 'widget' | 'inline' | 'bg_widget'
      options?: Record<string, any>
      autonomousEnabled?: boolean
      autonomousThreshold?: number
      autonomousTarget?: 'user' | 'assistant'
    }
  }

  agents: {
    [key: string]: { // example: minecraft
      prompt: string
      enabled?: boolean
    }
  }
}

export interface AiriCard extends Card {
  extensions: {
    airi: AiriExtension
  } & Card['extensions']
}

/**
 * Builds the minimal identity anchor consumed by the Lumi Agent Runtime.
 *
 * Use when:
 * - Supplying basic character identity without replacing current runtime prompts.
 * - Hashing the effective identity configuration for runtime reuse.
 *
 * Expects:
 * - Detailed runtime policy remains owned by Lumi Agent Runtime.
 *
 * Returns:
 * - Name, short identity, and core personality only.
 */
export function buildAgentRuntimeIdentityAnchor(card: AiriCard): string {
  return [
    `名字：${card.name}`,
    card.description?.trim() ? `身份：${card.description.trim()}` : '',
    card.personality?.trim() ? `核心性格：${card.personality.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export const useAiriCardStore = defineStore('airi-card', () => {
  const { t } = useI18n()

  const cards = useLocalStorageManualReset<Map<string, AiriCard>>('airi-cards', new Map())
  const activeCardId = useLocalStorageManualReset<string>('airi-card-active-id', 'default')

  const activeCard = computed(() => cards.value.get(activeCardId.value))

  const consciousnessStore = useConsciousnessStore()
  const speechStore = useSpeechStore()
  const artistryStore = useArtistryStore()
  const stageModelStore = useSettingsStageModel()

  const {
    activeProvider: activeConsciousnessProvider,
    activeModel: activeConsciousnessModel,
  } = storeToRefs(consciousnessStore)

  const {
    activeSpeechProvider,
    activeSpeechVoiceId,
    activeSpeechModel,
  } = storeToRefs(speechStore)

  const addCard = (card: AiriCard | Card | ccv3.CharacterCardV3) => {
    const newCardId = nanoid()
    cards.value.set(newCardId, newAiriCard(card))
    return newCardId
  }

  const removeCard = (id: string) => {
    cards.value.delete(id)
    capturePosthogEvent('character_deleted', { character_id: id })
  }

  const updateCard = (id: string, updates: AiriCard | Card | ccv3.CharacterCardV3) => {
    const existingCard = cards.value.get(id)
    if (!existingCard)
      return false

    const updatedCard = {
      ...existingCard,
      ...updates,
    }

    cards.value.set(id, newAiriCard(updatedCard))
    return true
  }

  const getCard = (id: string) => {
    return cards.value.get(id)
  }

  function hasUsableSpeechModule(speech: Partial<AiriExtension['modules']['speech']> | undefined): boolean {
    return !!speech?.provider && speech.provider !== 'speech-noop'
  }

  function updateActiveCardDisplayModel(displayModelId: string | undefined) {
    const cardId = activeCardId.value
    const card = cards.value.get(cardId)
    if (!card)
      return false

    const extension = resolveAiriExtension(card)
    const modules: AiriExtension['modules'] = {
      ...extension.modules,
      displayModelId,
    }

    cards.value.set(cardId, {
      ...card,
      extensions: {
        ...card.extensions,
        airi: {
          ...extension,
          modules,
        },
      },
    })

    return true
  }

  function resolveAiriExtension(card: Card | ccv3.CharacterCardV3): AiriExtension {
    // Get existing extension if available
    const existingExtension = ('data' in card
      ? card.data?.extensions?.airi
      : card.extensions?.airi) as AiriExtension

    // Create default modules config
    const defaultModules = {
      consciousness: {
        provider: activeConsciousnessProvider.value,
        model: activeConsciousnessModel.value,
      },
      speech: {
        provider: activeSpeechProvider.value,
        model: activeSpeechModel.value,
        voice_id: activeSpeechVoiceId.value,
      },
      displayModelId: stageModelStore.stageModelSelected,
      artistry: {
        enabled: false,
        provider: artistryStore.globalProvider,
        model: artistryStore.globalModel,
        directorProvider: activeConsciousnessProvider.value,
        directorModel: activeConsciousnessModel.value,
        promptPrefix: artistryStore.globalPromptPrefix,
        widgetInstruction: DEFAULT_ARTISTRY_WIDGET_SPAWNING_PROMPT,
        spawnMode: 'bg_widget' as const,
        options: artistryStore.globalProviderOptions,
        autonomousEnabled: false,
        autonomousThreshold: 70,
        autonomousTarget: 'assistant' as const,
      },
    } as const

    // Return default if no extension exists
    if (!existingExtension) {
      return {
        modules: defaultModules,
        agents: {},
      }
    }

    const existingSpeech = existingExtension.modules?.speech
    const speech = hasUsableSpeechModule(existingSpeech) || !hasUsableSpeechModule(defaultModules.speech)
      ? {
          provider: existingSpeech?.provider ?? defaultModules.speech.provider,
          model: existingSpeech?.model ?? defaultModules.speech.model,
          voice_id: existingSpeech?.voice_id ?? defaultModules.speech.voice_id,
          pitch: existingSpeech?.pitch,
          rate: existingSpeech?.rate,
          ssml: existingSpeech?.ssml,
          language: existingSpeech?.language,
        }
      : defaultModules.speech

    // Merge existing extension with defaults
    return {
      card: existingExtension.card,
      modules: {
        consciousness: {
          provider: existingExtension.modules?.consciousness?.provider ?? defaultModules.consciousness.provider,
          model: existingExtension.modules?.consciousness?.model ?? defaultModules.consciousness.model,
        },
        speech,
        vrm: existingExtension.modules?.vrm,
        live2d: existingExtension.modules?.live2d,
        displayModelId: existingExtension.modules?.displayModelId ?? defaultModules.displayModelId,
        activeBackgroundId: existingExtension.modules?.activeBackgroundId,
        artistry: {
          enabled: existingExtension.modules?.artistry?.enabled ?? (existingExtension as any).artistry?.enabled ?? defaultModules.artistry.enabled,
          provider: existingExtension.modules?.artistry?.provider ?? (existingExtension as any).artistry?.provider ?? defaultModules.artistry.provider,
          model: existingExtension.modules?.artistry?.model ?? (existingExtension as any).artistry?.model ?? defaultModules.artistry.model,
          directorProvider: existingExtension.modules?.artistry?.directorProvider ?? (existingExtension as any).artistry?.directorProvider ?? defaultModules.artistry.directorProvider,
          directorModel: existingExtension.modules?.artistry?.directorModel ?? (existingExtension as any).artistry?.directorModel ?? defaultModules.artistry.directorModel,
          promptPrefix: existingExtension.modules?.artistry?.promptPrefix ?? (existingExtension as any).artistry?.promptPrefix ?? (existingExtension as any).artistry?.prompt_prefix ?? defaultModules.artistry.promptPrefix,
          workflowId: existingExtension.modules?.artistry?.workflowId ?? (existingExtension as any).artistry?.workflowId ?? (existingExtension as any).artistry?.remixId,
          widgetInstruction: existingExtension.modules?.artistry?.widgetInstruction ?? (existingExtension as any).artistry?.widgetInstruction ?? defaultModules.artistry.widgetInstruction,
          spawnMode: existingExtension.modules?.artistry?.spawnMode ?? (existingExtension as any).artistry?.spawnMode ?? defaultModules.artistry.spawnMode,
          options: existingExtension.modules?.artistry?.options ?? (existingExtension as any).artistry?.options ?? defaultModules.artistry.options,
          autonomousEnabled: existingExtension.modules?.artistry?.autonomousEnabled ?? (existingExtension as any).artistry?.autonomousEnabled ?? defaultModules.artistry.autonomousEnabled,
          autonomousThreshold: existingExtension.modules?.artistry?.autonomousThreshold ?? (existingExtension as any).artistry?.autonomousThreshold ?? defaultModules.artistry.autonomousThreshold,
          autonomousTarget: existingExtension.modules?.artistry?.autonomousTarget ?? (existingExtension as any).artistry?.autonomousTarget ?? defaultModules.artistry.autonomousTarget,
        },
      },
      agents: existingExtension.agents ?? {},
    }
  }

  function newAiriCard(card: Card | ccv3.CharacterCardV3): AiriCard {
    // Handle ccv3 format if needed
    if ('data' in card) {
      const ccv3Card = card as ccv3.CharacterCardV3
      return {
        name: ccv3Card.data.name,
        version: ccv3Card.data.character_version ?? '1.0.0',
        description: ccv3Card.data.description ?? '',
        creator: ccv3Card.data.creator ?? '',
        notes: ccv3Card.data.creator_notes ?? '',
        notesMultilingual: ccv3Card.data.creator_notes_multilingual,
        personality: ccv3Card.data.personality ?? '',
        scenario: ccv3Card.data.scenario ?? '',
        greetings: [
          ccv3Card.data.first_mes,
          ...(ccv3Card.data.alternate_greetings ?? []),
        ],
        greetingsGroupOnly: ccv3Card.data.group_only_greetings ?? [],
        systemPrompt: ccv3Card.data.system_prompt ?? '',
        postHistoryInstructions: ccv3Card.data.post_history_instructions ?? '',
        messageExample: ccv3Card.data.mes_example
          ? ccv3Card.data.mes_example
              .split('<START>\n')
              .filter(Boolean)
              .map(example => example.split('\n')
                .map((line) => {
                  if (line.startsWith('{{char}}:') || line.startsWith('{{user}}:'))
                    return line as `{{char}}: ${string}` | `{{user}}: ${string}`
                  throw new Error(`Invalid message example format: ${line}`)
                }))
          : [],
        tags: ccv3Card.data.tags ?? [],
        extensions: {
          airi: resolveAiriExtension(ccv3Card),
          ...ccv3Card.data.extensions,
        },
      }
    }

    return {
      ...card,
      extensions: {
        airi: resolveAiriExtension(card),
        ...card.extensions,
      },
    }
  }

  function refreshBuiltInLumiCardIfNeeded() {
    const latest = newAiriCard(createLumiAiriCard())
    const existing = cards.value.get(LUMI_AIRI_CARD_ID)

    if (!existing) {
      cards.value.set(LUMI_AIRI_CARD_ID, latest)
      return
    }

    const existingExtension = resolveAiriExtension(existing)
    if (existingExtension.card?.customized)
      return

    if (existing.version === latest.version)
      return

    cards.value.set(LUMI_AIRI_CARD_ID, {
      ...existing,
      name: latest.name,
      version: latest.version,
      description: latest.description,
      creator: latest.creator,
      notes: latest.notes,
      personality: latest.personality,
      scenario: latest.scenario,
      greetings: latest.greetings,
      greetingsGroupOnly: latest.greetingsGroupOnly,
      systemPrompt: latest.systemPrompt,
      postHistoryInstructions: latest.postHistoryInstructions,
      messageExample: latest.messageExample,
      tags: latest.tags,
      extensions: {
        ...existing.extensions,
        airi: existingExtension,
      },
    })
  }

  function initialize() {
    if (!cards.value.has('default')) {
      cards.value.set('default', newAiriCard({
        name: 'ReLU',
        version: '1.0.0',
        description: SystemPromptV2(
          t('base.prompt.prefix'),
          t('base.prompt.suffix'),
        ).content,
      }))
    }
    refreshBuiltInLumiCardIfNeeded()
    if (!activeCardId.value)
      activeCardId.value = 'default'
  }

  watchDebounced(activeCard, (newCard: AiriCard | undefined) => {
    artistryStore.resetToGlobal()

    if (!newCard)
      return

    // TODO: Minecraft Agent, etc
    const extension = resolveAiriExtension(newCard)
    if (!extension)
      return

    activeConsciousnessProvider.value = extension?.modules?.consciousness?.provider
    activeConsciousnessModel.value = extension?.modules?.consciousness?.model

    if (hasUsableSpeechModule(extension?.modules?.speech) || !hasUsableSpeechModule({
      provider: activeSpeechProvider.value,
      model: activeSpeechModel.value,
      voice_id: activeSpeechVoiceId.value,
    })) {
      activeSpeechProvider.value = extension?.modules?.speech?.provider
      activeSpeechModel.value = extension?.modules?.speech?.model
      activeSpeechVoiceId.value = extension?.modules?.speech?.voice_id
    }

    // Apply body model if the card has a display model configured.
    // NOTICE: must set via store property directly (not storeToRefs .value) so Pinia's
    // proxy correctly calls the writable computed setter → stageModelSelectedState → updateStageModel().
    if (extension.modules?.displayModelId) {
      stageModelStore.stageModelSelected = extension.modules.displayModelId
    }

    if (extension.modules?.artistry) {
      if (extension.modules.artistry.provider)
        artistryStore.activeProvider = extension.modules.artistry.provider
      if (extension.modules.artistry.model)
        artistryStore.activeModel = extension.modules.artistry.model
      if (extension.modules.artistry.promptPrefix)
        artistryStore.defaultPromptPrefix = extension.modules.artistry.promptPrefix
      if (extension.modules.artistry.options)
        artistryStore.providerOptions = extension.modules.artistry.options
    }
  }, { debounce: 300, maxWait: 1000 })

  function resetState() {
    activeCardId.reset()
    cards.reset()
  }

  return {
    cards,
    activeCard,
    activeCardId,
    addCard,
    removeCard,
    updateCard,
    updateActiveCardDisplayModel,
    getCard,
    resetState,
    initialize,

    currentModels: computed(() => {
      return {
        consciousness: {
          provider: activeConsciousnessProvider.value,
          model: activeConsciousnessModel.value,
        },
        speech: {
          provider: activeSpeechProvider.value,
          model: activeSpeechModel.value,
          voice_id: activeSpeechVoiceId.value,
        },
        displayModelId: stageModelStore.stageModelSelected,
        activeBackgroundId: activeCard.value?.extensions?.airi?.modules?.activeBackgroundId,
      } satisfies AiriExtension['modules']
    }),

    systemPrompt: computed(() => {
      const card = activeCard.value
      if (!card)
        return ''

      const components = [
        card.systemPrompt,
        card.description,
        card.personality,
        card.extensions?.airi?.modules?.artistry?.widgetInstruction,
      ].filter(Boolean)

      return components.join('\n\n')
    }),

    agentRuntimeIdentityAnchor: computed(() => {
      const card = activeCard.value
      return card ? buildAgentRuntimeIdentityAnchor(card) : ''
    }),
  }
})
