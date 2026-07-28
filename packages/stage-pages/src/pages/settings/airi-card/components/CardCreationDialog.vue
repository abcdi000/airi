<script setup lang="ts">
import type { Card } from '@proj-airi/ccc'
import type { AiriExtension } from '@proj-airi/stage-ui/stores/modules/airi-card'

import { LUMI_AIRI_CARD_ID } from '@proj-airi/stage-ui/constants/lumi-card'
import { DEFAULT_ARTISTRY_WIDGET_INSTRUCTION } from '@proj-airi/stage-ui/constants/prompts/artistry-instruction'
import { useDisplayModelsStore } from '@proj-airi/stage-ui/stores/display-models'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useArtistryStore } from '@proj-airi/stage-ui/stores/modules/artistry'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { useSettingsStageModel } from '@proj-airi/stage-ui/stores/settings/stage-model'
import { Button, FieldInput } from '@proj-airi/ui'
import { ComboboxSelect } from '@proj-airi/ui/components/form'
import { storeToRefs } from 'pinia'
import {
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'
import { computed, ref, toRaw, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import CardCreationTabArtistry from './tabs/CardCreationTabArtistry.vue'

interface Props {
  modelValue: boolean
  cardId?: string // If provided, edit mode; otherwise create mode
  initialTab?: string
}

interface LegacyArtistrySettings {
  provider?: string
  model?: string
  promptPrefix?: string
  widgetInstruction?: string
  options?: Record<string, unknown>
}

type AiriExtensionWithLegacyArtistry = AiriExtension & {
  artistry?: LegacyArtistrySettings
  modules?: AiriExtension['modules'] & {
    artistry?: LegacyArtistrySettings
  }
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const modelValue = defineModel<boolean>()

const { t } = useI18n()
const cardStore = useAiriCardStore()
const consciousnessStore = useConsciousnessStore()
const speechStore = useSpeechStore()
const providersStore = useProvidersStore()
const displayModelsStore = useDisplayModelsStore()
const stageModelStore = useSettingsStageModel()
const artistryStore = useArtistryStore()

const { activeProvider: consciousnessProvider, activeModel: defaultConsciousnessModel } = storeToRefs(consciousnessStore)
const { activeSpeechProvider: speechProvider, activeSpeechModel: defaultSpeechModel, activeSpeechVoiceId: defaultSpeechVoiceId } = storeToRefs(speechStore)
const { displayModels } = storeToRefs(displayModelsStore)
const { stageModelSelected: defaultDisplayModelId } = storeToRefs(stageModelStore)
const { activeProvider: defaultArtistryProvider } = storeToRefs(artistryStore)

// Determine if we're in edit mode
const isEditMode = computed(() => !!props.cardId)
const isBuiltInLumiCard = computed(() => props.cardId === LUMI_AIRI_CARD_ID)

// Modules configuration
const selectedConsciousnessProvider = ref<string>('')
const selectedConsciousnessModel = ref<string>('')
const selectedSpeechProvider = ref<string>('')
const selectedSpeechModel = ref<string>('')
const selectedSpeechVoiceId = ref<string>('')
const selectedDisplayModelId = ref<string>('')

// Artistry configuration
const selectedArtistryProvider = ref<string>('')
const selectedArtistryModel = ref<string>('')
const selectedArtistryPromptPrefix = ref<string>('')
const selectedArtistryWidgetInstruction = ref<string>('')
const selectedArtistrySpawnMode = ref<'bg' | 'widget' | 'inline' | 'bg_widget'>('bg_widget')
const selectedArtistryAutonomousEnabled = ref<boolean>(false)
const selectedArtistryAutonomousThreshold = ref<number>(70)
const selectedArtistryConfigStr = ref<string>('{\n  \n}')

// Computed: available display model options
const displayModelOptions = computed(() =>
  displayModels.value.map(model => ({
    value: model.id,
    label: model.name,
  })),
)

// Computed: available consciousness provider options
const consciousnessProviderOptions = computed(() => {
  return providersStore.configuredChatProvidersMetadata.map(provider => ({
    value: provider.id,
    label: provider.localizedName || provider.name,
  }))
})

// Computed: available consciousness models options
const consciousnessModelOptions = computed(() => {
  const provider = selectedConsciousnessProvider.value || consciousnessProvider.value
  if (!provider)
    return []
  const models = providersStore.getModelsForProvider(provider)
  return models.map(model => ({
    value: model.id,
    label: model.name || model.id,
  }))
})

// Computed: available speech provider options
const speechProviderOptions = computed(() => {
  return providersStore.configuredSpeechProvidersMetadata.map(provider => ({
    value: provider.id,
    label: provider.localizedName || provider.name,
  }))
})

// Computed: available speech models options
const speechModelOptions = computed(() => {
  const provider = selectedSpeechProvider.value || speechProvider.value
  if (!provider)
    return []
  const models = providersStore.getModelsForProvider(provider)
  return models.map(model => ({
    value: model.id,
    label: model.name || model.id,
  }))
})

// Computed: available speech voices options
const speechVoiceOptions = computed(() => {
  const provider = selectedSpeechProvider.value || speechProvider.value
  if (!provider)
    return []
  const voices = speechStore.getVoicesForProvider(provider)
  return voices.map(voice => ({
    value: voice.id,
    label: voice.name || voice.id,
  }))
})

// Computed: available artistry provider options
const artistryProviderOptions = computed(() => {
  return [
    { value: 'none', label: 'None (Disabled)' },
    { value: 'replicate', label: 'Replicate' },
    { value: 'comfyui', label: 'ComfyUI' },
    { value: 'nanobanana', label: 'Nano Banana' },
  ]
})

// Load models for current providers on init
watch(() => [consciousnessProvider.value, speechProvider.value], async ([consProvider, spProvider]) => {
  if (consProvider) {
    await consciousnessStore.loadModelsForProvider(consProvider)
  }
  if (spProvider) {
    await speechStore.loadVoicesForProvider(spProvider)
    const metadata = providersStore.getProviderMetadata(spProvider)
    if (metadata?.capabilities.listModels) {
      await providersStore.fetchModelsForProvider(spProvider)
    }
  }
}, { immediate: true })

// Watch consciousness provider changes and reload models
watch(selectedConsciousnessProvider, async (newProvider, oldProvider) => {
  if (oldProvider !== undefined && newProvider !== oldProvider && newProvider) {
    await consciousnessStore.loadModelsForProvider(newProvider)
    // Reset model selection to default or empty
    selectedConsciousnessModel.value = ''
  }
})

// Watch speech provider changes and reload models/voices
watch(selectedSpeechProvider, async (newProvider, oldProvider) => {
  if (oldProvider !== undefined && newProvider !== oldProvider && newProvider) {
    await speechStore.loadVoicesForProvider(newProvider)
    const metadata = providersStore.getProviderMetadata(newProvider)
    if (metadata?.capabilities.listModels) {
      await providersStore.fetchModelsForProvider(newProvider)
    }
    // Reset model and voice selection
    selectedSpeechModel.value = ''
    selectedSpeechVoiceId.value = ''
  }
})

// Reset voice when speech model changes (different models may have different voices)
watch(selectedSpeechModel, async (newModel, oldModel) => {
  // Only reset if model actually changed and we're not initializing
  const provider = selectedSpeechProvider.value || speechProvider.value
  if (oldModel !== undefined && newModel !== oldModel && provider) {
    // Reload voices for the current provider
    await speechStore.loadVoicesForProvider(provider)

    // Reset voice selection to default
    selectedSpeechVoiceId.value = defaultSpeechVoiceId.value || ''
  }
})

// Tab type definition
interface Tab {
  id: string
  label: string
  icon: string
}

// Active tab ID state
const activeTabId = ref('')

// Tabs for card details
const tabs: Tab[] = [
  { id: 'identity', label: t('settings.pages.card.creation.basic_persona'), icon: 'i-solar:user-id-bold-duotone' },
  { id: 'modules', label: t('settings.pages.card.modules'), icon: 'i-solar:widget-4-bold-duotone' },
  { id: 'artistry', label: t('settings.pages.modules.artistry.title'), icon: 'i-solar:gallery-bold-duotone' },
]

// Active tab state - set to first available tab by default
const activeTab = computed({
  get: () => {
    // If current active tab is not in available tabs, reset to first tab
    if (!tabs.some(tab => tab.id === activeTabId.value)) {
      if (props.initialTab && tabs.some(tab => tab.id === props.initialTab))
        return props.initialTab
      return tabs[0]?.id || ''
    }
    return activeTabId.value
  },
  set: (value: string) => {
    activeTabId.value = value
  },
})

// Reset active tab when dialog opens
watch(() => props.modelValue, (isOpen) => {
  if (isOpen) {
    if (props.initialTab && tabs.some(tab => tab.id === props.initialTab))
      activeTabId.value = props.initialTab
    else
      activeTabId.value = '' // Let computed handle default
  }
})

// Check for errors, and save built Cards :

const showError = ref<boolean>(false)
const errorMessage = ref<string>('')

function saveCard(card: Card): boolean {
  // Before saving, let's validate what the user entered :
  const rawCard: Card = toRaw(card)

  if (!rawCard.name?.trim()) {
    // No name
    showError.value = true
    errorMessage.value = t('settings.pages.card.creation.errors.name')
    return false
  }
  else if (!rawCard.description?.trim()) {
    // No description
    showError.value = true
    errorMessage.value = t('settings.pages.card.creation.errors.description')
    return false
  }
  else if (!rawCard.personality?.trim()) {
    // No personality
    showError.value = true
    errorMessage.value = t('settings.pages.card.creation.errors.personality')
    return false
  }
  // Validate Artistry JSON if provided
  if (selectedArtistryConfigStr.value.trim()) {
    try {
      const parsed = JSON.parse(selectedArtistryConfigStr.value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Not an object')
      }
    }
    catch {
      showError.value = true
      errorMessage.value = t('settings.pages.card.creation.errors.invalid_artistry_json')
      return false
    }
  }

  showError.value = false

  // Build options with final safety parse
  let artistryOptions: Record<string, any> | undefined
  if (selectedArtistryConfigStr.value.trim()) {
    try {
      artistryOptions = JSON.parse(selectedArtistryConfigStr.value)
    }
    catch {
      // Should not happen due to validation above
      artistryOptions = undefined
    }
  }

  // Build card with modules extension
  const existingAiriExtension = rawCard.extensions?.airi as AiriExtension | undefined
  const cardWithModules = {
    ...rawCard,
    // Character Card V3 requires this metadata, but editing Lumi should not
    // require users to understand or manually maintain a technical version.
    version: rawCard.version?.trim() || '1.0.0',
    extensions: {
      ...rawCard.extensions,
      airi: {
        ...existingAiriExtension,
        card: props.cardId === LUMI_AIRI_CARD_ID
          ? {
              ...existingAiriExtension?.card,
              customized: true,
              basedOnVersion: rawCard.version?.trim() || '1.0.0',
            }
          : existingAiriExtension?.card,
        modules: {
          ...existingAiriExtension?.modules,
          consciousness: {
            ...existingAiriExtension?.modules?.consciousness,
            provider: selectedConsciousnessProvider.value || consciousnessProvider.value,
            model: selectedConsciousnessModel.value || defaultConsciousnessModel.value,
          },
          speech: {
            ...existingAiriExtension?.modules?.speech,
            provider: selectedSpeechProvider.value || speechProvider.value,
            model: selectedSpeechModel.value || defaultSpeechModel.value,
            voice_id: selectedSpeechVoiceId.value || defaultSpeechVoiceId.value,
          },
          displayModelId: selectedDisplayModelId.value || defaultDisplayModelId.value,
          artistry: {
            provider: selectedArtistryProvider.value || defaultArtistryProvider.value,
            model: selectedArtistryModel.value,
            promptPrefix: selectedArtistryPromptPrefix.value,
            widgetInstruction: selectedArtistryWidgetInstruction.value,
            spawnMode: selectedArtistrySpawnMode.value,
            options: artistryOptions,
            autonomousEnabled: selectedArtistryAutonomousEnabled.value,
            autonomousThreshold: selectedArtistryAutonomousThreshold.value,
          },
        },
        agents: existingAiriExtension?.agents ?? {},
      } as AiriExtension,
    },
  }
  if (isEditMode.value && props.cardId) {
    // Edit mode: update existing card
    cardStore.updateCard(props.cardId, cardWithModules)
  }
  else {
    // Create mode: add new card
    cardStore.addCard(cardWithModules)
  }

  modelValue.value = false // Close this
  return true
}

// Cards data holders :

// Initialize card data - load from existing card if in edit mode
function initializeCard(): Card {
  // Extract existing card data if in edit mode
  const existingCard = (isEditMode.value && props.cardId) ? cardStore.getCard(props.cardId) : undefined
  const airiExt = existingCard?.extensions?.airi as AiriExtensionWithLegacyArtistry | undefined

  // Initialize module selections with fallback logic (handles all cases: create, edit with/without extension)
  selectedConsciousnessProvider.value = airiExt?.modules?.consciousness?.provider || consciousnessProvider.value
  selectedConsciousnessModel.value = airiExt?.modules?.consciousness?.model || defaultConsciousnessModel.value
  selectedSpeechProvider.value = airiExt?.modules?.speech?.provider || speechProvider.value
  selectedSpeechModel.value = airiExt?.modules?.speech?.model || defaultSpeechModel.value
  selectedSpeechVoiceId.value = airiExt?.modules?.speech?.voice_id || defaultSpeechVoiceId.value
  selectedDisplayModelId.value = airiExt?.modules?.displayModelId || defaultDisplayModelId.value

  // NOTICE: keep legacy `extensions.airi.artistry` fallback so existing cards continue to load.
  const artistrySettings = airiExt?.modules?.artistry || airiExt?.artistry
  selectedArtistryProvider.value = artistrySettings?.provider || defaultArtistryProvider.value
  selectedArtistryModel.value = artistrySettings?.model || ''
  selectedArtistryPromptPrefix.value = artistrySettings?.promptPrefix || ''
  selectedArtistryWidgetInstruction.value = artistrySettings?.widgetInstruction || DEFAULT_ARTISTRY_WIDGET_INSTRUCTION
  selectedArtistrySpawnMode.value = (artistrySettings as any)?.spawnMode || 'bg_widget'
  selectedArtistryAutonomousEnabled.value = (artistrySettings as any)?.autonomousEnabled ?? false
  selectedArtistryAutonomousThreshold.value = (artistrySettings as any)?.autonomousThreshold ?? 70

  try {
    selectedArtistryConfigStr.value = artistrySettings?.options ? JSON.stringify(artistrySettings.options, null, 2) : '{\n  \n}'
  }
  catch {
    selectedArtistryConfigStr.value = '{\n  \n}'
  }

  // Return existing card data or defaults
  if (existingCard) {
    return { ...toRaw(existingCard) }
  }

  return {
    name: t('settings.pages.card.creation.defaults.name'),
    nickname: undefined,
    version: '1.0.0',
    description: '',
    notes: undefined,
    personality: t('settings.pages.card.creation.defaults.personality'),
    scenario: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    greetings: [],
    messageExample: [],
  }
}

const card = ref<Card>(initializeCard())

// Reinitialize when cardId changes or dialog opens
watch(() => [props.modelValue, props.cardId], () => {
  if (props.modelValue) {
    card.value = initializeCard()
  }
})

function makeComputed<T extends keyof Card>(
  /*
  Function used to generate Computed values, with an optional sanitize function
  */
  key: T,
  transform?: (input: string) => string,
) {
  return computed({
    get: () => {
      return card.value[key] ?? ''
    },
    set: (val: string) => { // Set,
      card.value[key] = (transform ? transform(val) : val) as Card[T]
    },
  })
}

const cardName = makeComputed('name')
const cardNickname = makeComputed('nickname')
const cardDescription = makeComputed('description')

const cardPersonality = makeComputed('personality')

// Helper function to generate placeholder text for default values
function getDefaultPlaceholder(defaultValue: string | undefined): string {
  return defaultValue
    ? `${t('settings.pages.card.creation.use_default')} (${defaultValue})`
    : t('settings.pages.card.creation.use_default_not_configured')
}
</script>

<template>
  <DialogRoot :open="modelValue" @update:open="emit('update:modelValue', $event)">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-100 bg-black/50 backdrop-blur-sm data-[state=closed]:animate-fadeOut data-[state=open]:animate-fadeIn" />
      <DialogContent
        :class="[
          'fixed left-1/2 top-1/2 z-100 m-0',
          'max-h-[90vh] w-[min(94vw,960px)] max-w-[960px]',
          'flex flex-col overflow-hidden border border-neutral-200 rounded-lg',
          'bg-white p-5 shadow-xl dark:border-neutral-700 dark:bg-neutral-800 sm:p-7',
          '-translate-x-1/2 -translate-y-1/2',
          'data-[state=closed]:animate-contentHide data-[state=open]:animate-contentShow',
        ]"
        @interact-outside.prevent
      >
        <div class="min-h-0 w-full flex flex-1 flex-col gap-5">
          <div :class="['flex flex-wrap items-start justify-between gap-3']">
            <div>
              <DialogTitle text-2xl font-normal class="from-primary-500 to-primary-400 bg-gradient-to-r bg-clip-text text-transparent">
                {{ isEditMode ? t("settings.pages.card.edit_card") : t("settings.pages.card.create_card") }}
              </DialogTitle>
              <p :class="['mt-1 text-sm text-neutral-500 dark:text-neutral-400']">
                {{ t('settings.pages.card.creation.editor_subtitle') }}
              </p>
            </div>
            <div
              v-if="isEditMode"
              :class="[
                'flex items-center gap-2 rounded-md px-3 py-2',
                'bg-neutral-100 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300',
              ]"
            >
              <div class="i-solar:branching-paths-up-bold-duotone text-base" />
              {{ t('settings.pages.card.creation.managed_version') }} {{ card.version }}
            </div>
          </div>

          <!-- Dialog tabs -->
          <div>
            <div class="border-b border-neutral-200 dark:border-neutral-700">
              <div :class="['flex justify-start gap-1 overflow-x-auto -mb-px']">
                <button
                  v-for="tab in tabs"
                  :key="tab.id"
                  class="shrink-0 px-3 py-2 text-sm font-medium"
                  :class="[
                    activeTab === tab.id
                      ? 'text-primary-600 dark:text-primary-400 border-b-2 border-primary-500 dark:border-primary-400'
                      : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300',
                  ]"
                  @click="activeTab = tab.id"
                >
                  <div class="flex items-center gap-1">
                    <div :class="tab.icon" />
                    {{ tab.label }}
                  </div>
                </button>
              </div>
            </div>
          </div>

          <!-- Error div -->
          <div v-if="showError" :class="['w-full flex items-start gap-3 rounded-lg bg-red-100 p-4 text-red-800 dark:bg-red-950 dark:text-red-100']">
            <div :class="['i-solar:danger-triangle-bold mt-0.5 shrink-0 text-lg']" />
            <p class="min-w-0">
              {{ errorMessage }}
            </p>
          </div>

          <div :class="['min-h-0 flex-1 overflow-y-auto pr-1']">
            <Transition name="card-tab" mode="out-in">
              <div :key="activeTab" :class="['mx-auto w-full max-w-[820px] pb-2']">
                <!-- Identity details -->
                <div v-if="activeTab === 'identity'" :class="['flex flex-col gap-6']">
                  <div
                    v-if="isBuiltInLumiCard"
                    :class="[
                      'flex items-start gap-3 border-l-4 border-primary-400 bg-primary-50 px-4 py-3',
                      'text-sm text-neutral-700 dark:bg-primary-950/30 dark:text-neutral-200',
                    ]"
                  >
                    <div class="i-solar:info-circle-bold-duotone mt-0.5 shrink-0 text-lg text-primary-500" />
                    <p>{{ t('settings.pages.card.creation.offline_scope_notice') }}</p>
                  </div>

                  <div :class="['grid grid-cols-1 gap-5 sm:grid-cols-2']">
                    <FieldInput
                      v-model="cardName"
                      :label="t('settings.pages.card.creation.name')"
                      :description="t('settings.pages.card.creation.fields_info.name')"
                      :required="true"
                    />
                    <FieldInput
                      v-model="cardNickname"
                      :label="t('settings.pages.card.creation.nickname')"
                      :description="t('settings.pages.card.creation.fields_info.nickname')"
                    />
                  </div>
                  <FieldInput
                    v-model="cardDescription"
                    :label="t('settings.pages.card.creation.basic_identity')"
                    :single-line="false"
                    :required="true"
                    :description="t('settings.pages.card.creation.fields_info.basic_identity')"
                    input-class="min-h-32 resize-y px-4 py-3 text-[15px] leading-6"
                  />
                  <FieldInput
                    v-model="cardPersonality"
                    :label="t('settings.pages.card.creation.core_personality')"
                    :single-line="false"
                    :required="true"
                    :description="t('settings.pages.card.creation.fields_info.core_personality')"
                    input-class="min-h-40 resize-y px-4 py-3 text-[15px] leading-6"
                  />
                </div>
                <!-- Modules -->
                <div v-else-if="activeTab === 'modules'" :class="['w-full']">
                  <p class="mb-3">
                    {{ t('settings.pages.card.creation.modules_info') }}
                  </p>

                  <div :class="['grid grid-cols-1 gap-5 sm:grid-cols-2']">
                    <!-- Consciousness Provider -->
                    <div :class="['flex', 'flex-col', 'gap-2']">
                      <label :class="['flex', 'flex-row', 'items-center', 'gap-2', 'text-sm', 'text-neutral-500', 'dark:text-neutral-400']">
                        <div i-lucide:brain />
                        {{ t('settings.pages.card.chat.provider') }}
                      </label>
                      <ComboboxSelect
                        v-model="selectedConsciousnessProvider"
                        :options="consciousnessProviderOptions"
                        :placeholder="getDefaultPlaceholder(consciousnessProvider)"
                        class="w-full"
                      />
                    </div>

                    <!-- Consciousness Model -->
                    <div :class="['flex', 'flex-col', 'gap-2']">
                      <label :class="['flex', 'flex-row', 'items-center', 'gap-2', 'text-sm', 'text-neutral-500', 'dark:text-neutral-400']">
                        <div i-lucide:ghost />
                        {{ t('settings.pages.card.consciousness.model') }}
                      </label>
                      <ComboboxSelect
                        v-model="selectedConsciousnessModel"
                        :options="consciousnessModelOptions"
                        :placeholder="getDefaultPlaceholder(defaultConsciousnessModel)"
                        :disabled="!selectedConsciousnessProvider && !consciousnessProvider"
                        class="w-full"
                      />
                    </div>

                    <!-- Speech Provider -->
                    <div :class="['flex', 'flex-col', 'gap-2']">
                      <label :class="['flex', 'flex-row', 'items-center', 'gap-2', 'text-sm', 'text-neutral-500', 'dark:text-neutral-400']">
                        <div i-lucide:radio />
                        {{ t('settings.pages.card.speech.provider') }}
                      </label>
                      <ComboboxSelect
                        v-model="selectedSpeechProvider"
                        :options="speechProviderOptions"
                        :placeholder="getDefaultPlaceholder(speechProvider)"
                        class="w-full"
                      />
                    </div>

                    <!-- Speech Model -->
                    <div :class="['flex', 'flex-col', 'gap-2']">
                      <label :class="['flex', 'flex-row', 'items-center', 'gap-2', 'text-sm', 'text-neutral-500', 'dark:text-neutral-400']">
                        <div i-lucide:mic />
                        {{ t('settings.pages.card.speech.model') }}
                      </label>
                      <ComboboxSelect
                        v-model="selectedSpeechModel"
                        :options="speechModelOptions"
                        :placeholder="getDefaultPlaceholder(defaultSpeechModel)"
                        :disabled="!selectedSpeechProvider && !speechProvider"
                        class="w-full"
                      />
                    </div>

                    <!-- Speech Voice -->
                    <div :class="['flex', 'flex-col', 'gap-2']">
                      <label :class="['flex', 'flex-row', 'items-center', 'gap-2', 'text-sm', 'text-neutral-500', 'dark:text-neutral-400']">
                        <div i-lucide:music />
                        {{ t('settings.pages.card.speech.voice') }}
                      </label>
                      <ComboboxSelect
                        v-model="selectedSpeechVoiceId"
                        :options="speechVoiceOptions"
                        :placeholder="getDefaultPlaceholder(defaultSpeechVoiceId)"
                        :disabled="!selectedSpeechProvider && !speechProvider"
                        class="w-full"
                      />
                    </div>

                    <!-- Display Model (Body) -->
                    <div :class="['flex', 'flex-col', 'gap-2', 'sm:col-span-2']">
                      <label :class="['flex', 'flex-row', 'items-center', 'gap-2', 'text-sm', 'text-neutral-500', 'dark:text-neutral-400']">
                        <div i-solar:ghost-bold-duotone />
                        {{ t('settings.pages.card.body-model') }}
                      </label>
                      <ComboboxSelect
                        v-model="selectedDisplayModelId"
                        :options="displayModelOptions"
                        :placeholder="getDefaultPlaceholder(defaultDisplayModelId)"
                        class="w-full"
                      />
                    </div>
                  </div>
                </div>
                <!-- Artistry -->
                <CardCreationTabArtistry
                  v-else-if="activeTab === 'artistry'"
                  v-model:selected-artistry-provider="selectedArtistryProvider"
                  v-model:selected-artistry-model="selectedArtistryModel"
                  v-model:selected-artistry-prompt-prefix="selectedArtistryPromptPrefix"
                  v-model:selected-artistry-widget-instruction="selectedArtistryWidgetInstruction"
                  v-model:selected-artistry-autonomous-enabled="selectedArtistryAutonomousEnabled"
                  v-model:selected-artistry-autonomous-threshold="selectedArtistryAutonomousThreshold"
                  v-model:selected-artistry-spawn-mode="selectedArtistrySpawnMode"
                  v-model:selected-artistry-config-str="selectedArtistryConfigStr"
                  :artistry-provider-options="artistryProviderOptions"
                  :default-artistry-provider-placeholder="getDefaultPlaceholder(defaultArtistryProvider)"
                />
              </div>
            </Transition>
          </div>

          <div :class="['ml-auto flex shrink-0 flex-row gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-700']">
            <Button
              variant="secondary"
              icon="i-solar:undo-left-bold-duotone"
              :label="t('settings.pages.card.cancel')"
              :disabled="false"
              @click="modelValue = false"
            />
            <Button
              variant="primary"
              icon="i-solar:check-circle-bold-duotone"
              :label="isEditMode ? t('settings.pages.card.save') : t('settings.pages.card.creation.create')"
              :disabled="false"
              @click="saveCard(card)"
            />
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.card-tab-enter-active,
.card-tab-leave-active {
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

.card-tab-enter-from {
  opacity: 0;
  transform: translateX(8px);
}

.card-tab-leave-to {
  opacity: 0;
  transform: translateX(-8px);
}
</style>
