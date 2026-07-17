import type { ChatHistoryItem } from '@proj-airi/stage-ui/types/chat'
import type { Tool } from '@xsai/shared-chat'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/llm-toolset-prompts'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/llm-tools'
import {
  LUMI_PROMPT_HISTORY_MAX,
  LUMI_PROMPT_HISTORY_MIN,
  useLumiMainTimelineStore,
} from '@proj-airi/stage-ui/stores/lumi-main-timeline'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { tool } from '@xsai/tool'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { z } from 'zod'

import { useLumiProactiveVisionStore } from './lumi-proactive-vision'

const LUMI_SELF_ADJUSTMENT_TOOLS_PROVIDER = 'lumi-self-adjustment'

const MIN_OBSERVE_INTERVAL_SECONDS = 30
const MAX_MIN_OBSERVE_INTERVAL_SECONDS = 15 * 60
const MAX_OBSERVE_INTERVAL_SECONDS = 30 * 60
const MAX_COOLDOWN_SECONDS = 15 * 60
const MIN_SPEECH_PLAYBACK_VOLUME_PERCENT = 0
const MAX_SPEECH_PLAYBACK_VOLUME_PERCENT = 150

const OLLAMA_THINKING_MODES = ['auto', 'disable', 'enable', 'low', 'medium', 'high'] as const

type OllamaThinkingMode = typeof OLLAMA_THINKING_MODES[number]

interface SelfAdjustmentChangeLogEntry {
  id: string
  createdAt: number
  action: string
  reason: string
  changes: string[]
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed))
    return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function formatSeconds(valueMs: number) {
  return `${Math.round(valueMs / 1000)} 秒`
}

function safeModelId(value: string) {
  return /^[\w.:/@+\-]+$/.test(value) && value.length <= 160
}

export const useLumiSelfAdjustmentStore = defineStore('lumi-self-adjustment', () => {
  const enabled = useLocalStorageManualReset('settings/plugins/lumi-self-adjustment/enabled', false)
  const allowProactiveVisionTiming = useLocalStorageManualReset('settings/plugins/lumi-self-adjustment/allow-proactive-vision-timing', true)
  const allowConsciousnessModelSwitch = useLocalStorageManualReset('settings/plugins/lumi-self-adjustment/allow-consciousness-model-switch', true)
  const allowOllamaThinkingMode = useLocalStorageManualReset('settings/plugins/lumi-self-adjustment/allow-ollama-thinking-mode', true)
  const allowSpeechPlaybackVolume = useLocalStorageManualReset('settings/plugins/lumi-self-adjustment/allow-speech-playback-volume', true)
  const allowPromptHistoryLimit = useLocalStorageManualReset('settings/plugins/lumi-self-adjustment/allow-prompt-history-limit', true)
  const changeLog = useLocalStorageManualReset<SelfAdjustmentChangeLogEntry[]>('settings/plugins/lumi-self-adjustment/change-log', [])

  const registered = ref(false)
  const lastError = ref('')
  const lastChangeAt = ref<number | null>(null)

  const loaded = computed(() => registered.value)

  function appendSystemNotice(lines: string[]) {
    const chatSession = useChatSessionStore()
    const sessionId = chatSession.activeSessionId
    if (!sessionId)
      return

    chatSession.ensureSession(sessionId)
    const content = [
      '[system_notice]',
      'title: Lumi 自我调节',
      ...lines,
    ].join('\n')
    const message: ChatHistoryItem = {
      id: createId('lumi-self-adjustment-notice'),
      role: 'assistant',
      content,
      slices: [{ type: 'text', text: content }],
      tool_results: [],
      createdAt: Date.now(),
    }
    chatSession.setSessionMessages(sessionId, [
      ...chatSession.getSessionMessages(sessionId),
      message,
    ])
  }

  function recordChange(action: string, reason: string, changes: string[]) {
    const entry: SelfAdjustmentChangeLogEntry = {
      id: createId('self-adjustment'),
      createdAt: Date.now(),
      action,
      reason,
      changes,
    }
    changeLog.value = [
      entry,
      ...changeLog.value,
    ].slice(0, 20)
    lastChangeAt.value = entry.createdAt
    appendSystemNotice([
      'status: updated',
      `action: ${action}`,
      `reason: ${reason}`,
      ...changes.map(change => `- ${change}`),
    ])
  }

  function reject(action: string, reason: string, instruction: string) {
    appendSystemNotice([
      'status: rejected',
      `action: ${action}`,
      `reason: ${reason}`,
      `instruction: ${instruction}`,
    ])
    return JSON.stringify({
      status: enabled.value ? 'rejected' : 'disabled',
      action,
      reason,
      instruction,
    })
  }

  async function setProactiveVisionTiming(payload: {
    reason: string
    proactiveVision?: {
      minIntervalSeconds?: number
      maxIntervalSeconds?: number
      cooldownSeconds?: number
    }
  }) {
    if (!allowProactiveVisionTiming.value)
      return reject('set_proactive_vision_timing', payload.reason, 'Self-adjustment for proactive vision timing is disabled in plugin settings.')

    const proactiveVisionStore = useLumiProactiveVisionStore()
    const previous = {
      minIntervalMs: Number(proactiveVisionStore.minIntervalMs),
      maxIntervalMs: Number(proactiveVisionStore.maxIntervalMs),
      cooldownMs: Number(proactiveVisionStore.cooldownMs),
    }

    const nextMinSeconds = clampInteger(
      payload.proactiveVision?.minIntervalSeconds,
      Math.round(previous.minIntervalMs / 1000),
      MIN_OBSERVE_INTERVAL_SECONDS,
      MAX_MIN_OBSERVE_INTERVAL_SECONDS,
    )
    const nextMaxSeconds = clampInteger(
      payload.proactiveVision?.maxIntervalSeconds,
      Math.round(previous.maxIntervalMs / 1000),
      Math.max(nextMinSeconds, MIN_OBSERVE_INTERVAL_SECONDS),
      MAX_OBSERVE_INTERVAL_SECONDS,
    )
    const nextCooldownSeconds = clampInteger(
      payload.proactiveVision?.cooldownSeconds,
      Math.round(previous.cooldownMs / 1000),
      MIN_OBSERVE_INTERVAL_SECONDS,
      MAX_COOLDOWN_SECONDS,
    )

    proactiveVisionStore.minIntervalMs = nextMinSeconds * 1000
    proactiveVisionStore.maxIntervalMs = nextMaxSeconds * 1000
    proactiveVisionStore.cooldownMs = nextCooldownSeconds * 1000

    const changes: string[] = []
    if (previous.minIntervalMs !== proactiveVisionStore.minIntervalMs)
      changes.push(`主动观察最短间隔: ${formatSeconds(previous.minIntervalMs)} -> ${formatSeconds(proactiveVisionStore.minIntervalMs)}`)
    if (previous.maxIntervalMs !== proactiveVisionStore.maxIntervalMs)
      changes.push(`主动观察最长间隔: ${formatSeconds(previous.maxIntervalMs)} -> ${formatSeconds(proactiveVisionStore.maxIntervalMs)}`)
    if (previous.cooldownMs !== proactiveVisionStore.cooldownMs)
      changes.push(`主动发言冷却: ${formatSeconds(previous.cooldownMs)} -> ${formatSeconds(proactiveVisionStore.cooldownMs)}`)

    if (changes.length === 0) {
      return JSON.stringify({
        status: 'no_change',
        action: 'set_proactive_vision_timing',
        reason: payload.reason,
      })
    }

    recordChange('set_proactive_vision_timing', payload.reason, changes)
    return JSON.stringify({
      status: 'ok',
      action: 'set_proactive_vision_timing',
      changes,
      instruction: 'Tell the user briefly that Lumi adjusted proactive observation timing and why.',
    })
  }

  async function setConsciousnessModel(payload: {
    reason: string
    consciousness?: {
      model?: string
    }
  }) {
    if (!allowConsciousnessModelSwitch.value)
      return reject('set_consciousness_model', payload.reason, 'Self-adjustment for consciousness model switching is disabled in plugin settings.')

    const model = payload.consciousness?.model?.trim() ?? ''
    if (!model || !safeModelId(model))
      return reject('set_consciousness_model', payload.reason, 'The requested model id is empty or contains unsafe characters.')

    const consciousnessStore = useConsciousnessStore()
    const providersStore = useProvidersStore()
    const providerId = consciousnessStore.activeProvider
    if (!providerId)
      return reject('set_consciousness_model', payload.reason, 'No active consciousness provider is configured.')

    const metadata = providersStore.getProviderMetadata(providerId)
    if (metadata.capabilities.listModels) {
      const models = await providersStore.fetchModelsForProvider(providerId)
      const available = models.some(item => item.id === model)
      if (!available) {
        return reject(
          'set_consciousness_model',
          payload.reason,
          `Model "${model}" was not found under the current consciousness provider "${providerId}". Lumi may not switch provider or create unknown model ids.`,
        )
      }
    }

    const previous = consciousnessStore.activeModel
    if (previous === model) {
      return JSON.stringify({
        status: 'no_change',
        action: 'set_consciousness_model',
        reason: payload.reason,
      })
    }

    consciousnessStore.activeModel = model
    const changes = [
      `意识模型: ${previous || '未设置'} -> ${model}`,
    ]
    recordChange('set_consciousness_model', payload.reason, changes)
    return JSON.stringify({
      status: 'ok',
      action: 'set_consciousness_model',
      changes,
      instruction: 'Tell the user briefly that Lumi switched the consciousness model within the already configured provider.',
    })
  }

  async function setOllamaThinkingMode(payload: {
    reason: string
    ollama?: {
      thinkingMode?: OllamaThinkingMode
    }
  }) {
    if (!allowOllamaThinkingMode.value)
      return reject('set_ollama_thinking_mode', payload.reason, 'Self-adjustment for Ollama thinking mode is disabled in plugin settings.')

    const thinkingMode = payload.ollama?.thinkingMode
    if (!thinkingMode || !OLLAMA_THINKING_MODES.includes(thinkingMode))
      return reject('set_ollama_thinking_mode', payload.reason, 'The requested thinking mode is not supported.')

    const consciousnessStore = useConsciousnessStore()
    if (consciousnessStore.activeProvider !== 'ollama')
      return reject('set_ollama_thinking_mode', payload.reason, 'Thinking mode can only be adjusted when the consciousness provider is Ollama.')

    const providersStore = useProvidersStore()
    if (!providersStore.providers.ollama)
      providersStore.providers.ollama = {}
    const previous = String(providersStore.providers.ollama.thinkingMode || 'auto')
    if (previous === thinkingMode) {
      return JSON.stringify({
        status: 'no_change',
        action: 'set_ollama_thinking_mode',
        reason: payload.reason,
      })
    }

    providersStore.providers.ollama.thinkingMode = thinkingMode
    await providersStore.disposeProviderInstance('ollama')
    const changes = [
      `Ollama 思考模式: ${previous} -> ${thinkingMode}`,
    ]
    recordChange('set_ollama_thinking_mode', payload.reason, changes)
    return JSON.stringify({
      status: 'ok',
      action: 'set_ollama_thinking_mode',
      changes,
      instruction: 'Tell the user briefly that Lumi adjusted Ollama thinking mode.',
    })
  }

  async function setSpeechPlaybackVolume(payload: {
    reason: string
    speech?: {
      playbackVolumePercent?: number
    }
  }) {
    if (!allowSpeechPlaybackVolume.value)
      return reject('set_speech_playback_volume', payload.reason, 'Self-adjustment for speech playback volume is disabled in plugin settings.')

    const speechStore = useSpeechStore()
    const previousPercent = clampInteger(
      Number(speechStore.playbackVolume) * 100,
      100,
      MIN_SPEECH_PLAYBACK_VOLUME_PERCENT,
      MAX_SPEECH_PLAYBACK_VOLUME_PERCENT,
    )
    const nextPercent = clampInteger(
      payload.speech?.playbackVolumePercent,
      previousPercent,
      MIN_SPEECH_PLAYBACK_VOLUME_PERCENT,
      MAX_SPEECH_PLAYBACK_VOLUME_PERCENT,
    )

    if (previousPercent === nextPercent) {
      return JSON.stringify({
        status: 'no_change',
        action: 'set_speech_playback_volume',
        reason: payload.reason,
      })
    }

    speechStore.playbackVolume = nextPercent / 100
    const changes = [
      `发声播放音量: ${previousPercent}% -> ${nextPercent}%`,
    ]
    recordChange('set_speech_playback_volume', payload.reason, changes)
    return JSON.stringify({
      status: 'ok',
      action: 'set_speech_playback_volume',
      changes,
      instruction: 'Tell the user briefly that Lumi adjusted speech playback volume and why.',
    })
  }

  async function setLumiPromptHistoryLimit(payload: {
    reason: string
    lumiPrompt?: {
      maxRecentChatMessagesForPrompt?: number
    }
  }) {
    if (!allowPromptHistoryLimit.value)
      return reject('set_lumi_prompt_history_limit', payload.reason, 'Self-adjustment for Lumi prompt history limit is disabled in plugin settings.')

    const timelineStore = useLumiMainTimelineStore()
    const previous = Number(timelineStore.normalizedMaxRecentChatMessagesForPrompt)
    const next = clampInteger(
      payload.lumiPrompt?.maxRecentChatMessagesForPrompt,
      previous,
      LUMI_PROMPT_HISTORY_MIN,
      LUMI_PROMPT_HISTORY_MAX,
    )

    if (previous === next) {
      return JSON.stringify({
        status: 'no_change',
        action: 'set_lumi_prompt_history_limit',
        reason: payload.reason,
      })
    }

    timelineStore.setMaxRecentChatMessagesForPrompt(next)
    const changes = [
      `Lumi 最近上下文条数: ${previous} -> ${next}`,
    ]
    recordChange('set_lumi_prompt_history_limit', payload.reason, changes)
    return JSON.stringify({
      status: 'ok',
      action: 'set_lumi_prompt_history_limit',
      changes,
      instruction: 'Tell the user briefly that Lumi adjusted how many recent main-timeline messages are sent to the consciousness model.',
    })
  }

  async function executeAdjustment(payload: {
    action: 'set_proactive_vision_timing' | 'set_consciousness_model' | 'set_ollama_thinking_mode' | 'set_speech_playback_volume' | 'set_lumi_prompt_history_limit'
    reason: string
    proactiveVision?: {
      minIntervalSeconds?: number
      maxIntervalSeconds?: number
      cooldownSeconds?: number
    }
    consciousness?: {
      model?: string
    }
    ollama?: {
      thinkingMode?: OllamaThinkingMode
    }
    speech?: {
      playbackVolumePercent?: number
    }
    lumiPrompt?: {
      maxRecentChatMessagesForPrompt?: number
    }
  }) {
    if (!enabled.value)
      return reject(payload.action, payload.reason, 'Lumi self-adjustment plugin is disabled. Tell the user to enable it in Settings > Plugins first.')

    try {
      lastError.value = ''
      if (payload.action === 'set_proactive_vision_timing')
        return await setProactiveVisionTiming(payload)
      if (payload.action === 'set_consciousness_model')
        return await setConsciousnessModel(payload)
      if (payload.action === 'set_ollama_thinking_mode')
        return await setOllamaThinkingMode(payload)
      if (payload.action === 'set_speech_playback_volume')
        return await setSpeechPlaybackVolume(payload)
      if (payload.action === 'set_lumi_prompt_history_limit')
        return await setLumiPromptHistoryLimit(payload)
      return reject(payload.action, payload.reason, 'Unknown self-adjustment action.')
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lastError.value = message
      return reject(payload.action, payload.reason, message)
    }
  }

  function createSelfAdjustmentTool(): Promise<Tool> {
    return tool({
      name: 'lumi_adjust_settings',
      description: 'Let Lumi safely adjust a small whitelist of local settings: proactive screen observation timing, current consciousness model within the same provider, Ollama thinking mode, speech playback volume, and Lumi recent prompt history limit. This tool cannot change API keys, provider credentials, base URLs, plugin install paths, memory database settings, or other dangerous configuration.',
      parameters: z.object({
        action: z.enum(['set_proactive_vision_timing', 'set_consciousness_model', 'set_ollama_thinking_mode', 'set_speech_playback_volume', 'set_lumi_prompt_history_limit'])
          .describe('The safe setting adjustment to perform.'),
        reason: z.string().min(1).max(400)
          .describe('A concise reason based on the current conversation or observed user context.'),
        proactiveVision: z.object({
          minIntervalSeconds: z.number().int().optional()
            .describe('Minimum proactive observation interval in seconds. Allowed range: 30 to 900.'),
          maxIntervalSeconds: z.number().int().optional()
            .describe('Maximum proactive observation interval in seconds. Allowed range: minIntervalSeconds to 1800.'),
          cooldownSeconds: z.number().int().optional()
            .describe('Minimum cooldown between proactive messages in seconds. Allowed range: 30 to 900.'),
        }).optional(),
        consciousness: z.object({
          model: z.string().min(1).max(160).optional()
            .describe('Model id to use under the current consciousness provider. The provider/API key/base URL cannot be changed.'),
        }).optional(),
        ollama: z.object({
          thinkingMode: z.enum(OLLAMA_THINKING_MODES).optional()
            .describe('Ollama thinking mode. Only works when current consciousness provider is Ollama.'),
        }).optional(),
        speech: z.object({
          playbackVolumePercent: z.number().int().min(MIN_SPEECH_PLAYBACK_VOLUME_PERCENT).max(MAX_SPEECH_PLAYBACK_VOLUME_PERCENT).optional()
            .describe('Local speech playback volume percent. 100 is default. Allowed range: 0 to 150. This only changes local output volume, not API credentials or voice identity.'),
        }).optional(),
        lumiPrompt: z.object({
          maxRecentChatMessagesForPrompt: z.number().int().min(LUMI_PROMPT_HISTORY_MIN).max(LUMI_PROMPT_HISTORY_MAX).optional()
            .describe('How many recent Main Timeline messages Lumi sends to the consciousness model. Allowed range: 6 to 80. Older details remain available through summaries and RAG.'),
        }).optional(),
      }).strict(),
      execute: async payload => executeAdjustment(payload),
    })
  }

  async function registerTool() {
    if (registered.value)
      return

    await useLlmToolsStore().registerTools(LUMI_SELF_ADJUSTMENT_TOOLS_PROVIDER, Promise.all([
      createSelfAdjustmentTool(),
    ]))
    useLlmToolsetPromptsStore().registerToolsetPrompts(LUMI_SELF_ADJUSTMENT_TOOLS_PROVIDER, [
      {
        id: 'lumi-self-adjustment-guidance',
        title: 'Lumi Self Adjustment',
        content: [
          'When the active persona is Lumi, the tool `lumi_adjust_settings` lets Lumi safely adjust a small whitelist of local settings.',
          'Use it only when the adjustment clearly improves companionship, pacing, or the user explicitly asks for that safe change.',
          'Allowed changes: proactive screen observation min/max interval and cooldown; current consciousness model within the already configured provider; Ollama thinking mode when provider is Ollama; local speech playback volume from 0% to 150%; Lumi recent prompt history limit from 6 to 80 messages.',
          'Forbidden changes: API keys, provider selection, base URLs, credentials, plugin directories, memory/profile databases, deleting data, or anything outside the tool schema.',
          'Always provide a short reason. After a successful adjustment, mention the change naturally and briefly; the app also emits a visible system notice.',
          'Avoid thrashing settings. Prefer gentle interval and volume changes. If the user is busy, lengthen observation timing/cooldown; if the user is actively chatting and wants company, shorten them within safe limits. If speech is too loud/quiet or the environment suggests it, adjust playback volume gently.',
          'If the tool reports disabled or rejected, explain that self-adjustment is off or not allowed and tell the user they can change it in Settings > Plugins.',
        ].join('\n'),
      },
    ])
    registered.value = true
  }

  function clearTool() {
    registered.value = false
    useLlmToolsStore().clearTools(LUMI_SELF_ADJUSTMENT_TOOLS_PROVIDER)
    useLlmToolsetPromptsStore().clearToolsetPrompts(LUMI_SELF_ADJUSTMENT_TOOLS_PROVIDER)
  }

  function initializeToolRegistration() {
    void registerTool().catch((error) => {
      lastError.value = error instanceof Error ? error.message : String(error)
      console.warn('[lumi-self-adjustment] Failed to register tool:', error)
    })
  }

  function resetState() {
    clearTool()
    enabled.reset()
    allowProactiveVisionTiming.reset()
    allowConsciousnessModelSwitch.reset()
    allowOllamaThinkingMode.reset()
    allowSpeechPlaybackVolume.reset()
    allowPromptHistoryLimit.reset()
    changeLog.reset()
    lastError.value = ''
    lastChangeAt.value = null
  }

  return {
    enabled,
    loaded,
    registered,
    allowProactiveVisionTiming,
    allowConsciousnessModelSwitch,
    allowOllamaThinkingMode,
    allowSpeechPlaybackVolume,
    allowPromptHistoryLimit,
    changeLog,
    lastError,
    lastChangeAt,
    registerTool,
    clearTool,
    initializeToolRegistration,
    resetState,
  }
})
