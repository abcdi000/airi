<script setup lang="ts">
import type { ChatProvider } from '@xsai-ext/providers/utils'

import { errorMessageFrom } from '@moeru/std'
import { isStageTamagotchi } from '@proj-airi/stage-shared'
import { ChatSessionsDrawer, ChatTtsDebugPanel } from '@proj-airi/stage-ui/components/scenarios/chat'
import { HearingConfig } from '@proj-airi/stage-ui/components/scenarios/dialogs/audio-input/index'
import { useAudioAnalyzer } from '@proj-airi/stage-ui/composables'
import { useAudioContext } from '@proj-airi/stage-ui/stores/audio'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useLumiAgentStore } from '@proj-airi/stage-ui/stores/lumi-agent'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { useSettings, useSettingsAudioDevice } from '@proj-airi/stage-ui/stores/settings'
import { useTtsDebugStore } from '@proj-airi/stage-ui/stores/tts-debug'
import { BasicTextarea } from '@proj-airi/ui'
import { useLocalStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger, PopoverContent, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import IndicatorMicVolume from './IndicatorMicVolume.vue'

import { useTranscriptions } from '../../composables/use-transcriptions'

const messageInput = ref<string>('')
const hearingPopoverOpen = ref(false)
const sessionsDrawerOpen = ref(false)
const isComposing = ref(false)
const DOUBLE_ENTER_INTERVAL_MS = 300
const TRAILING_NEWLINES_REGEX = /[\r\n]+$/
const SEND_MODES = ['enter', 'ctrl-enter', 'double-enter'] as const
type SendMode = (typeof SEND_MODES)[number]
const sendMode = useLocalStorage<SendMode>('ui/chat/settings/send-mode', 'enter')
const lastEnterTime = ref(0)

const providersStore = useProvidersStore()
const { activeProvider, activeModel } = storeToRefs(useConsciousnessStore())
const { themeColorsHueDynamic } = storeToRefs(useSettings())

const { askPermission } = useSettingsAudioDevice()
const { enabled, stream } = storeToRefs(useSettingsAudioDevice())
const chatOrchestrator = useChatOrchestratorStore()
const chatSession = useChatSessionStore()
const lumiAgentStore = useLumiAgentStore()
const ttsDebugStore = useTtsDebugStore()
const { ingest, onAfterMessageComposed } = chatOrchestrator
const { messages } = storeToRefs(chatSession)
const { audioContext } = useAudioContext()
const { t } = useI18n()
const VOICE_GATE_POLL_MS = 80
const VOICE_START_MIN_RMS = 0.045
const VOICE_STOP_MIN_RMS = 0.018
const VOICE_START_CONSECUTIVE_FRAMES = 3
const VOICE_NOISE_FLOOR_EMA = 0.08
const VOICE_NOISE_START_MULTIPLIER = 3.5
const VOICE_STOP_SILENCE_MS = 1800
const VOICE_RESTART_COOLDOWN_MS = 450
const sendModeLabels = computed<Record<SendMode, string>>(() => ({
  'enter': t('stage.send-mode.enter'),
  'ctrl-enter': t('stage.send-mode.ctrl-enter'),
  'double-enter': t('stage.send-mode.double-enter'),
}))

const { isListening, startStreamingTranscription, stopStreamingTranscription, autoSendEnabled } = useTranscriptions(
  {
    messageInputRef: messageInput,
    sendMessage: handleSend,
    isStageTamagotchi,
  },
)

async function handleSend() {
  if (!messageInput.value.trim() || isComposing.value) {
    return
  }

  const textToSend = messageInput.value
  messageInput.value = ''

  try {
    const providerConfig = providersStore.getProviderConfig(activeProvider.value)

    await ingest(textToSend, {
      chatProvider: await providersStore.getProviderInstance(activeProvider.value) as ChatProvider,
      model: activeModel.value,
      providerConfig,
    })
  }
  catch (error) {
    // preserve any user input when failed to send the message
    messageInput.value = [textToSend, messageInput.value.trim()].filter(Boolean).join(' ')
    chatSession.setSessionMessages(chatSession.activeSessionId, [
      ...messages.value.slice(0, -1),
      {
        role: 'error',
        content: errorMessageFrom(error) ?? 'Failed to send message',
      },
    ])
  }
}

function sendFromKeyboard() {
  messageInput.value = messageInput.value.replace(TRAILING_NEWLINES_REGEX, '')
  void handleSend()
}

function toggleTtsDebugPanel() {
  ttsDebugStore.togglePanel()
}

function handleMessageInputKeydown(event: KeyboardEvent) {
  if (isComposing.value || event.key !== 'Enter')
    return

  const hasControl = event.ctrlKey || event.metaKey
  const hasShift = event.shiftKey

  switch (sendMode.value) {
    case 'enter':
      if (!hasShift && !hasControl) {
        event.preventDefault()
        sendFromKeyboard()
      }
      return
    case 'ctrl-enter':
      if (hasControl) {
        event.preventDefault()
        sendFromKeyboard()
      }
      return
    case 'double-enter':
      if (!hasShift && !hasControl) {
        const now = Date.now()
        if (now - lastEnterTime.value < DOUBLE_ENTER_INTERVAL_MS) {
          event.preventDefault()
          sendFromKeyboard()
          lastEnterTime.value = 0
        }
        else {
          lastEnterTime.value = now
        }
      }
  }
}

watch(hearingPopoverOpen, async (value) => {
  if (value) {
    await askPermission()
  }
})

onAfterMessageComposed(async () => {
})

const { startAnalyzer, stopAnalyzer } = useAudioAnalyzer()
let analyzerSource: MediaStreamAudioSourceNode | undefined
let voiceGateSource: MediaStreamAudioSourceNode | undefined
let voiceGateAnalyser: AnalyserNode | undefined
let voiceGateInterval: ReturnType<typeof setInterval> | undefined
let voiceGateBuffer: Float32Array<ArrayBuffer> | undefined
let voiceGateStarting = false
let voiceGateStopping = false
let voiceGateLastVoiceAt = 0
let voiceGateLastStopAt = 0
let voiceGateNoiseFloor = 0.01
let voiceGateSpeechFrames = 0

function teardownAnalyzer() {
  try {
    analyzerSource?.disconnect()
  }
  catch {}
  analyzerSource = undefined
  stopAnalyzer()
}

function teardownVoiceGate() {
  if (voiceGateInterval) {
    clearInterval(voiceGateInterval)
    voiceGateInterval = undefined
  }
  try {
    voiceGateSource?.disconnect()
  }
  catch {}
  voiceGateSource = undefined
  voiceGateAnalyser = undefined
  voiceGateBuffer = undefined
  voiceGateStarting = false
  voiceGateStopping = false
  voiceGateLastVoiceAt = 0
  voiceGateNoiseFloor = 0.01
  voiceGateSpeechFrames = 0
}

function getVoiceGateRms() {
  if (!voiceGateAnalyser || !voiceGateBuffer)
    return 0

  voiceGateAnalyser.getFloatTimeDomainData(voiceGateBuffer)
  let sum = 0
  for (const sample of voiceGateBuffer)
    sum += sample * sample

  return Math.sqrt(sum / voiceGateBuffer.length)
}

async function pollVoiceGate() {
  if (!enabled.value || !stream.value || !voiceGateAnalyser)
    return

  const now = Date.now()
  const rms = getVoiceGateRms()
  const startThreshold = Math.max(VOICE_START_MIN_RMS, voiceGateNoiseFloor * VOICE_NOISE_START_MULTIPLIER)
  const stopThreshold = Math.max(VOICE_STOP_MIN_RMS, voiceGateNoiseFloor * 1.8)
  const speaking = isListening.value ? rms >= stopThreshold : rms >= startThreshold

  if (!isListening.value && !speaking) {
    voiceGateNoiseFloor = voiceGateNoiseFloor * (1 - VOICE_NOISE_FLOOR_EMA) + rms * VOICE_NOISE_FLOOR_EMA
    voiceGateSpeechFrames = 0
    return
  }

  if (speaking) {
    voiceGateLastVoiceAt = now
    voiceGateSpeechFrames += 1

    if (!isListening.value && voiceGateSpeechFrames >= VOICE_START_CONSECUTIVE_FRAMES && !voiceGateStarting && now - voiceGateLastStopAt >= VOICE_RESTART_COOLDOWN_MS) {
      voiceGateStarting = true
      try {
        await startStreamingTranscription()
      }
      catch (error) {
        console.error('启动语音识别失败：', error)
      }
      finally {
        voiceGateStarting = false
      }
    }

    return
  }

  voiceGateSpeechFrames = 0

  if (isListening.value && !voiceGateStopping && voiceGateLastVoiceAt > 0 && now - voiceGateLastVoiceAt >= VOICE_STOP_SILENCE_MS) {
    voiceGateStopping = true
    try {
      await stopStreamingTranscription(false)
    }
    catch (error) {
      console.error('停止语音识别失败：', error)
    }
    finally {
      voiceGateLastStopAt = Date.now()
      voiceGateLastVoiceAt = 0
      voiceGateStopping = false
    }
  }
}

async function setupVoiceGate() {
  teardownVoiceGate()
  if (!enabled.value || !stream.value)
    return

  if (audioContext.state === 'suspended')
    await audioContext.resume()

  voiceGateAnalyser = audioContext.createAnalyser()
  voiceGateAnalyser.fftSize = 1024
  voiceGateBuffer = new Float32Array(voiceGateAnalyser.fftSize)
  voiceGateSource = audioContext.createMediaStreamSource(stream.value)
  voiceGateSource.connect(voiceGateAnalyser)

  voiceGateInterval = setInterval(() => {
    void pollVoiceGate()
  }, VOICE_GATE_POLL_MS)
}

async function setupAnalyzer() {
  teardownAnalyzer()
  if (!hearingPopoverOpen.value || !enabled.value || !stream.value)
    return
  if (audioContext.state === 'suspended')
    await audioContext.resume()
  const analyser = startAnalyzer(audioContext)
  if (!analyser)
    return
  analyzerSource = audioContext.createMediaStreamSource(stream.value)
  analyzerSource.connect(analyser)
}

watch([enabled, stream, hearingPopoverOpen], () => {
  setupAnalyzer()
}, { immediate: true })

watch([enabled, stream], async () => {
  if (!enabled.value) {
    teardownVoiceGate()
    if (isListening.value)
      await stopStreamingTranscription()
    return
  }

  try {
    await setupVoiceGate()
  }
  catch (error) {
    console.error('初始化本地语音门控失败：', error)
  }
}, { immediate: true })

onUnmounted(() => {
  teardownAnalyzer()
  teardownVoiceGate()
})

watch(sendMode, () => {
  lastEnterTime.value = 0
})
</script>

<template>
  <div h="<md:full" flex gap-2 class="ph-no-capture">
    <div
      :class="[
        'relative',
        'w-full',
        'bg-primary-200/20 dark:bg-primary-400/20',
      ]"
    >
      <BasicTextarea
        v-model="messageInput"
        :submit-on-enter="false"
        :placeholder="t('stage.message')"
        text="primary-600 dark:primary-100  placeholder:primary-500 dark:placeholder:primary-200"
        bg="transparent"
        min-h="[100px]" max-h="[300px]" w-full
        rounded-t-xl p-4 font-medium pb="[60px]"
        outline-none transition="all duration-250 ease-in-out placeholder:all placeholder:duration-250 placeholder:ease-in-out"
        :class="{
          'transition-colors-none placeholder:transition-colors-none': themeColorsHueDynamic,
        }"
        @keydown="handleMessageInputKeydown"
        @compositionstart="isComposing = true"
        @compositionend="isComposing = false"
      />

      <ChatTtsDebugPanel />

      <!-- Bottom-left action button: Microphone -->
      <div
        absolute bottom-2 left-2 z-10 flex items-center gap-2
      >
        <!-- Conversations drawer trigger -->
        <button
          :class="[
            'h-8 w-8 flex items-center justify-center rounded-md outline-none transition-all duration-200 active:scale-95',
            'text-lg text-neutral-500 dark:text-neutral-400',
          ]"
          title="Conversations"
          @click="sessionsDrawerOpen = true"
        >
          <div class="i-solar:chat-line-bold-duotone h-5 w-5" />
        </button>

        <ChatSessionsDrawer v-model="sessionsDrawerOpen" />

        <button
          :class="[
            'h-8 w-8 flex items-center justify-center rounded-md outline-none transition-all duration-200 active:scale-95',
            'text-lg text-neutral-500 dark:text-neutral-400',
          ]"
          title="Claude Code 任务"
          @click="lumiAgentStore.openTaskWindow()"
        >
          <div class="i-solar:archive-bold-duotone h-5 w-5" />
        </button>

        <button
          :class="[
            'h-8 w-8 flex items-center justify-center rounded-md outline-none transition-all duration-200 active:scale-95',
            ttsDebugStore.enabled
              ? 'bg-cyan-500/15 text-cyan-600 dark:text-cyan-200'
              : 'text-lg text-neutral-500 dark:text-neutral-400',
          ]"
          title="TTS 调试"
          @click="toggleTtsDebugPanel"
        >
          <div class="i-solar:soundwave-bold-duotone h-5 w-5" />
        </button>

        <DropdownMenuRoot>
          <DropdownMenuTrigger as-child>
            <button
              :class="[
                'h-8 w-8 flex items-center justify-center rounded-md outline-none transition-all duration-200 active:scale-95',
                'text-lg text-neutral-500 dark:text-neutral-400',
              ]"
              :title="t('stage.send-mode.title')"
            >
              <div class="i-solar:keyboard-bold-duotone h-5 w-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent
              side="top"
              align="start"
              :side-offset="8"
              :class="[
                'z-50 min-w-[180px] rounded-xl border border-neutral-200/60 bg-neutral-50/90 p-1',
                'shadow-lg backdrop-blur-md dark:border-neutral-800/30 dark:bg-neutral-900/80',
                'flex flex-col gap-1',
              ]"
            >
              <DropdownMenuItem
                v-for="mode in SEND_MODES"
                :key="mode"
                :class="[
                  'w-full flex cursor-pointer items-center rounded-lg px-3 py-2 text-xs outline-none transition-colors',
                  'hover:bg-primary-100/60 dark:hover:bg-primary-900/40',
                  sendMode === mode ? 'bg-primary-100/60 text-primary-600 font-medium dark:bg-primary-900/40 dark:text-primary-300' : 'text-neutral-600 dark:text-neutral-300',
                ]"
                @select="sendMode = mode"
              >
                <div class="mr-2 h-4 w-4 flex items-center justify-center">
                  <div v-if="sendMode === mode" class="i-ph:check-bold h-4 w-4" />
                </div>
                <span>{{ sendModeLabels[mode] }}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>

        <!-- Microphone icon button -->
        <PopoverRoot v-model:open="hearingPopoverOpen">
          <PopoverTrigger as-child>
            <button
              :class="[
                'h-8 w-8 flex items-center justify-center rounded-md outline-none',
                'transition-all duration-200 active:scale-95',
              ]"
              text="lg neutral-500 dark:neutral-400"
              :title="t('settings.hearing.title')"
            >
              <Transition name="fade" mode="out-in">
                <IndicatorMicVolume v-if="enabled" class="h-5 w-5" :color-class="isListening ? undefined : 'text-neutral-500 dark:text-neutral-400'" />
                <div v-else class="i-ph:microphone-slash h-5 w-5" />
              </Transition>
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            :side-offset="8"
            :class="[
              'w-72 max-w-[18rem] rounded-xl border border-neutral-200/60 bg-neutral-50/90 p-4',
              'shadow-lg backdrop-blur-md dark:border-neutral-800/30 dark:bg-neutral-900/80',
              'flex flex-col gap-3',
            ]"
          >
            <HearingConfig
              v-model:auto-send="autoSendEnabled"
              :transcription="isListening"
              :granted="true"
            />
          </PopoverContent>
        </PopoverRoot>
      </div>
    </div>
  </div>
</template>
