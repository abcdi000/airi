import type {
  LumiAgentRuntimeConfig,
  LumiAgentRuntimeMode,
  PlannerFinalizationMode,
} from '@proj-airi/lumi-agent-runtime'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'

/**
 * Desktop migration settings for Lumi's shared Agent Runtime.
 *
 * Existing desktop installations begin in shadow mode so the old visible
 * conversation path remains the rollback source until the operator explicitly
 * enables the shared runtime.
 */
export const useLumiAgentRuntimeSettingsStore = defineStore('lumi-agent-runtime-settings', () => {
  const mode = useLocalStorageManualReset<LumiAgentRuntimeMode>(
    'settings/lumi/shared-agent-runtime/mode',
    'shadow',
  )
  const plannerMaxRounds = useLocalStorageManualReset(
    'settings/lumi/shared-agent-runtime/planner-max-rounds',
    10,
  )
  const plannerFinalizationMode = useLocalStorageManualReset<PlannerFinalizationMode>(
    'settings/lumi/shared-agent-runtime/planner-finalization-mode',
    'stop_after_successful_reply',
  )
  const mergeWindowMs = useLocalStorageManualReset(
    'settings/lumi/shared-agent-runtime/merge-window-ms',
    80,
  )
  const toolMaxConcurrency = useLocalStorageManualReset(
    'settings/lumi/shared-agent-runtime/tool-max-concurrency',
    4,
  )
  const toolStepTimeoutMs = useLocalStorageManualReset(
    'settings/lumi/shared-agent-runtime/tool-step-timeout-ms',
    30_000,
  )
  const deferredToolsEnabled = useLocalStorageManualReset(
    'settings/lumi/shared-agent-runtime/deferred-tools-enabled',
    true,
  )
  const expressionSelectorEnabled = useLocalStorageManualReset(
    'settings/lumi/shared-agent-runtime/expression-selector-enabled',
    true,
  )
  const directLanguageFeedbackEnabled = useLocalStorageManualReset(
    'settings/lumi/shared-agent-runtime/direct-language-feedback-enabled',
    true,
  )
  const promptLoggingEnabled = useLocalStorageManualReset(
    'settings/lumi/shared-agent-runtime/prompt-logging-enabled',
    false,
  )
  const plannerHistoryBudgetTokens = useLocalStorageManualReset(
    'settings/lumi/shared-agent-runtime/planner-history-budget-tokens',
    700_000,
  )
  const contextCompactionThresholdTokens = useLocalStorageManualReset(
    'settings/lumi/shared-agent-runtime/context-compaction-threshold-tokens',
    760_000,
  )
  const contextRecentTokens = useLocalStorageManualReset(
    'settings/lumi/shared-agent-runtime/context-recent-tokens',
    160_000,
  )
  const contextCompactionIdleMs = useLocalStorageManualReset(
    'settings/lumi/shared-agent-runtime/context-compaction-idle-ms',
    15_000,
  )

  function runtimeConfig(): LumiAgentRuntimeConfig {
    const minimumThreshold = Math.min(1_000_000, plannerHistoryBudgetTokens.value + 60_000)
    if (contextCompactionThresholdTokens.value < minimumThreshold)
      contextCompactionThresholdTokens.value = minimumThreshold
    const maximumRecent = Math.max(1_000, Math.floor(contextCompactionThresholdTokens.value / 2))
    if (contextRecentTokens.value > maximumRecent)
      contextRecentTokens.value = maximumRecent
    return {
      runtimeMode: mode.value,
      plannerMaxRounds: plannerMaxRounds.value,
      plannerFinalizationMode: plannerFinalizationMode.value,
      mergeWindowMs: mergeWindowMs.value,
      toolMaxConcurrency: toolMaxConcurrency.value,
      toolStepTimeoutMs: toolStepTimeoutMs.value,
      deferredToolsEnabled: deferredToolsEnabled.value,
      expressionSelectorEnabled: expressionSelectorEnabled.value,
      directLanguageFeedbackEnabled: directLanguageFeedbackEnabled.value,
      promptLoggingEnabled: promptLoggingEnabled.value,
      plannerHistoryBudgetTokens: plannerHistoryBudgetTokens.value,
      contextCompactionThresholdTokens: contextCompactionThresholdTokens.value,
      contextRecentTokens: contextRecentTokens.value,
      contextCompactionIdleMs: contextCompactionIdleMs.value,
    }
  }

  return {
    mode,
    plannerMaxRounds,
    plannerFinalizationMode,
    mergeWindowMs,
    toolMaxConcurrency,
    toolStepTimeoutMs,
    deferredToolsEnabled,
    expressionSelectorEnabled,
    directLanguageFeedbackEnabled,
    promptLoggingEnabled,
    plannerHistoryBudgetTokens,
    contextCompactionThresholdTokens,
    contextRecentTokens,
    contextCompactionIdleMs,
    runtimeConfig,
  }
})
