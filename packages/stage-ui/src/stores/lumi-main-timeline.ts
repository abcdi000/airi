import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed } from 'vue'

export const LUMI_PROMPT_HISTORY_MIN = 6
export const LUMI_PROMPT_HISTORY_MAX = 80
export const LUMI_PROMPT_HISTORY_DEFAULT = 24

export function clampLumiPromptHistoryLimit(value: number) {
  if (!Number.isFinite(value))
    return LUMI_PROMPT_HISTORY_DEFAULT
  return Math.min(LUMI_PROMPT_HISTORY_MAX, Math.max(LUMI_PROMPT_HISTORY_MIN, Math.round(value)))
}

export const useLumiMainTimelineStore = defineStore('lumi-main-timeline', () => {
  const maxRecentChatMessagesForPrompt = useLocalStorageManualReset<number>(
    'settings/lumi/main-timeline/max-recent-chat-messages-for-prompt',
    LUMI_PROMPT_HISTORY_DEFAULT,
  )

  const normalizedMaxRecentChatMessagesForPrompt = computed(() =>
    clampLumiPromptHistoryLimit(maxRecentChatMessagesForPrompt.value),
  )

  function setMaxRecentChatMessagesForPrompt(value: number) {
    maxRecentChatMessagesForPrompt.value = clampLumiPromptHistoryLimit(value)
  }

  return {
    maxRecentChatMessagesForPrompt,
    normalizedMaxRecentChatMessagesForPrompt,
    setMaxRecentChatMessagesForPrompt,
  }
})
