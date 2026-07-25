import type { LumiConversationSummary } from '../../../lumi-runtime/src'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed } from 'vue'

export const LUMI_PROMPT_HISTORY_MIN = 6
export const LUMI_PROMPT_HISTORY_MAX = 80
export const LUMI_PROMPT_HISTORY_DEFAULT = 24
export const LUMI_CONTEXT_TOKEN_MIN = 32_000
export const LUMI_CONTEXT_TOKEN_MAX = 1_000_000
export const LUMI_CONTEXT_TOKEN_DEFAULT = 1_000_000
export const LUMI_CONTEXT_OUTPUT_RESERVE_DEFAULT = 64_000
export const LUMI_CONTEXT_PROMPT_RESERVE_DEFAULT = 32_000

export function clampLumiPromptHistoryLimit(value: number) {
  if (!Number.isFinite(value))
    return LUMI_PROMPT_HISTORY_DEFAULT
  return Math.min(LUMI_PROMPT_HISTORY_MAX, Math.max(LUMI_PROMPT_HISTORY_MIN, Math.round(value)))
}

export const useLumiMainTimelineStore = defineStore('lumi-main-timeline', () => {
  // Kept for compatibility with existing self-adjustment records. Token-aware
  // projection below is authoritative for Lumi conversations.
  const maxRecentChatMessagesForPrompt = useLocalStorageManualReset<number>(
    'settings/lumi/main-timeline/max-recent-chat-messages-for-prompt',
    LUMI_PROMPT_HISTORY_DEFAULT,
  )
  const maxContextTokens = useLocalStorageManualReset<number>(
    'settings/lumi/main-timeline/max-context-tokens',
    LUMI_CONTEXT_TOKEN_DEFAULT,
  )
  const outputReserveTokens = useLocalStorageManualReset<number>(
    'settings/lumi/main-timeline/output-reserve-tokens',
    LUMI_CONTEXT_OUTPUT_RESERVE_DEFAULT,
  )
  const promptReserveTokens = useLocalStorageManualReset<number>(
    'settings/lumi/main-timeline/prompt-reserve-tokens',
    LUMI_CONTEXT_PROMPT_RESERVE_DEFAULT,
  )
  const conversationSummaries = useLocalStorageManualReset<Record<string, LumiConversationSummary>>(
    'settings/lumi/main-timeline/conversation-summaries-v1',
    {},
  )

  const normalizedMaxRecentChatMessagesForPrompt = computed(() =>
    clampLumiPromptHistoryLimit(maxRecentChatMessagesForPrompt.value),
  )

  function setMaxRecentChatMessagesForPrompt(value: number) {
    maxRecentChatMessagesForPrompt.value = clampLumiPromptHistoryLimit(value)
  }

  const normalizedMaxContextTokens = computed(() =>
    boundedTokens(maxContextTokens.value, LUMI_CONTEXT_TOKEN_MIN, LUMI_CONTEXT_TOKEN_MAX, LUMI_CONTEXT_TOKEN_DEFAULT),
  )
  const normalizedOutputReserveTokens = computed(() =>
    boundedTokens(outputReserveTokens.value, 1_024, 384_000, LUMI_CONTEXT_OUTPUT_RESERVE_DEFAULT),
  )
  const normalizedPromptReserveTokens = computed(() =>
    boundedTokens(promptReserveTokens.value, 1_024, 200_000, LUMI_CONTEXT_PROMPT_RESERVE_DEFAULT),
  )

  function summaryFor(conversationId: string) {
    return conversationSummaries.value[conversationId]
  }

  function saveSummary(summary: LumiConversationSummary) {
    conversationSummaries.value = {
      ...conversationSummaries.value,
      [summary.conversationId]: summary,
    }
  }

  function clearSummary(conversationId: string) {
    const next = { ...conversationSummaries.value }
    delete next[conversationId]
    conversationSummaries.value = next
  }

  return {
    clearSummary,
    conversationSummaries,
    maxRecentChatMessagesForPrompt,
    maxContextTokens,
    normalizedMaxRecentChatMessagesForPrompt,
    normalizedMaxContextTokens,
    normalizedOutputReserveTokens,
    normalizedPromptReserveTokens,
    outputReserveTokens,
    promptReserveTokens,
    saveSummary,
    setMaxRecentChatMessagesForPrompt,
    summaryFor,
  }
})

function boundedTokens(value: number, minimum: number, maximum: number, fallback: number) {
  if (!Number.isFinite(value))
    return fallback
  return Math.min(maximum, Math.max(minimum, Math.round(value)))
}
