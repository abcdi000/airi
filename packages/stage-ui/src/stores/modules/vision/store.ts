import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { refManualReset } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed } from 'vue'

import { useProvidersStore } from '../../providers'

export const useVisionStore = defineStore('vision', () => {
  const providersStore = useProvidersStore()

  const activeProvider = useLocalStorageManualReset('settings/vision/active-provider', '')
  const activeModel = useLocalStorageManualReset('settings/vision/active-model', '')
  const activeCustomModelName = useLocalStorageManualReset('settings/vision/active-custom-model', '')
  const ollamaThinkingEnabled = useLocalStorageManualReset('settings/vision/ollama-thinking-enabled', false)
  const modelSearchQuery = refManualReset('')

  const providerMetadata = computed(() => {
    if (!activeProvider.value)
      return null

    const metadata = providersStore.providerMetadata[activeProvider.value] ?? null
    return metadata && ['vision', 'chat'].includes(metadata.category) ? metadata : null
  })

  const supportsModelListing = computed(() => {
    return providerMetadata.value?.capabilities.listModels !== undefined
  })

  const providerModels = computed(() => {
    if (!activeProvider.value)
      return []

    return providersStore.getVisionModelsForProvider(activeProvider.value)
  })

  const isLoadingActiveProviderModels = computed(() => {
    if (!activeProvider.value)
      return false

    return providersStore.isLoadingVisionModels[activeProvider.value] || false
  })

  const activeProviderModelError = computed(() => {
    if (!activeProvider.value)
      return null

    return providersStore.visionModelLoadError[activeProvider.value] || null
  })

  const configured = computed(() => {
    return !!activeProvider.value && !!activeModel.value && !!providerMetadata.value
  })

  function resetModelSelection() {
    activeModel.reset()
    activeCustomModelName.reset()
    modelSearchQuery.reset()
  }

  async function loadModelsForProvider(provider: string) {
    const metadata = providersStore.providerMetadata[provider]
    if (provider && metadata && ['vision', 'chat'].includes(metadata.category) && metadata.capabilities.listModels !== undefined) {
      await providersStore.fetchVisionModelsForProvider(provider)
    }
  }

  async function getModelsForProvider(provider: string) {
    const metadata = providersStore.providerMetadata[provider]
    if (provider && metadata && ['vision', 'chat'].includes(metadata.category) && metadata.capabilities.listModels !== undefined) {
      return providersStore.getVisionModelsForProvider(provider)
    }

    return []
  }

  function resetState() {
    activeProvider.reset()
    resetModelSelection()
  }

  return {
    activeProvider,
    activeModel,
    customModelName: activeCustomModelName,
    ollamaThinkingEnabled,
    modelSearchQuery,

    supportsModelListing,
    providerModels,
    isLoadingActiveProviderModels,
    activeProviderModelError,
    configured,

    resetModelSelection,
    loadModelsForProvider,
    getModelsForProvider,
    resetState,
  }
})
