<script setup lang="ts">
import type { ChatToolCallRendererRegistry } from '@proj-airi/stage-ui/components'
import type { ChatHistoryItem } from '@proj-airi/stage-ui/types/chat'

import { errorMessageFrom } from '@moeru/std'
import { ChatHistory, JournalPreviewModal } from '@proj-airi/stage-ui/components'
import { ChatTtsDebugPanel } from '@proj-airi/stage-ui/components/scenarios/chat'
import { useBackgroundStore } from '@proj-airi/stage-ui/stores/background'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useChatStreamStore } from '@proj-airi/stage-ui/stores/chat/stream-store'
import { useJournalPreviewStore } from '@proj-airi/stage-ui/stores/journal-preview'
import { useLumiAgentStore } from '@proj-airi/stage-ui/stores/lumi-agent'
import { MAX_LUMI_EYES_CHAT_IMAGES } from '@proj-airi/stage-ui/stores/lumi-eyes'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useTtsDebugStore } from '@proj-airi/stage-ui/stores/tts-debug'
import { BasicTextarea } from '@proj-airi/ui'
import { useLocalStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuPortal, DropdownMenuRoot, DropdownMenuTrigger } from 'reka-ui'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

import JournalToolCallBlock from './chat-tool-renderers/journal-tool-call-block.vue'
import ComputerUseController from './ComputerUseController.vue'

import { useChatSyncStore } from '../stores/chat-sync'

const router = useRouter()
const messageInput = ref('')
const lastEnterTime = ref(0)
type ImageAttachment = { type: 'image', data: string, mimeType: string, url: string }
const attachments = ref<ImageAttachment[]>([])

const chatOrchestrator = useChatOrchestratorStore()
const chatSession = useChatSessionStore()
const chatStream = useChatStreamStore()
const chatSyncStore = useChatSyncStore()
const backgroundStore = useBackgroundStore()
const journalPreviewStore = useJournalPreviewStore()
const airiCardStore = useAiriCardStore()
const lumiAgentStore = useLumiAgentStore()
const ttsDebugStore = useTtsDebugStore()

const { messages, visibleMessages, visibleMessageStartIndex } = storeToRefs(chatSession)
const { streamingMessage } = storeToRefs(chatStream)
const { sending } = storeToRefs(chatOrchestrator)
const { activeCardId, activeCard } = storeToRefs(airiCardStore)
const { t } = useI18n()
const { openImagePreview } = journalPreviewStore
const isComposing = ref(false)
const DOUBLE_ENTER_INTERVAL_MS = 300
const TRAILING_NEWLINES_REGEX = /[\r\n]+$/
const MAX_IMAGE_ATTACHMENTS = MAX_LUMI_EYES_CHAT_IMAGES
const SEND_MODES = ['enter', 'ctrl-enter', 'double-enter'] as const
type SendMode = (typeof SEND_MODES)[number]
const sendMode = useLocalStorage<SendMode>('ui/chat/settings/send-mode', 'enter')
const toolCallRenderers = {
  image_journal: JournalToolCallBlock,
  text_journal: JournalToolCallBlock,
} satisfies ChatToolCallRendererRegistry
const sendModeLabels = computed<Record<SendMode, string>>(() => ({
  'enter': t('stage.send-mode.enter'),
  'ctrl-enter': t('stage.send-mode.ctrl-enter'),
  'double-enter': t('stage.send-mode.double-enter'),
}))

const latestImageEntries = computed(() => {
  if (!activeCardId.value)
    return []
  return backgroundStore.journalEntries.slice(0, 3)
})

function navigateToImageJournal() {
  if (!activeCardId.value)
    return
  router.push(`/settings/airi-card?cardId=${activeCardId.value}&tab=gallery`)
}

async function handleSend() {
  if (isComposing.value) {
    return
  }

  if (!messageInput.value.trim() && !attachments.value.length) {
    return
  }

  const textToSend = messageInput.value
  const attachmentsToSend = attachments.value.map(att => ({ ...att }))
  const messageCountBeforeSend = messages.value.length

  // optimistic clear
  messageInput.value = ''
  attachments.value = []

  try {
    await chatSyncStore.requestIngest({
      text: textToSend,
      attachments: attachmentsToSend,
      // Chat image attachments are visual input, not an image-generation request.
      // Keep the artistry tools available for plain text turns only.
      toolset: attachmentsToSend.length > 0 ? undefined : 'artistry',
    })

    attachmentsToSend.forEach(att => URL.revokeObjectURL(att.url))
  }
  catch (error) {
    const sendReachedHistory = messages.value.length > messageCountBeforeSend
    if (sendReachedHistory) {
      attachmentsToSend.forEach(att => URL.revokeObjectURL(att.url))
    }
    else {
      // Restore only when the turn failed before it reached chat history.
      messageInput.value = textToSend
      attachments.value = attachmentsToSend
    }
    chatSession.setSessionMessages(chatSession.activeSessionId, [
      ...messages.value,
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

const fileInput = ref<HTMLInputElement | null>(null)

function handleManualAttach() {
  fileInput.value?.click()
}

function handleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement
  if (target.files?.length) {
    addImageFiles(Array.from(target.files))
  }
  target.value = ''
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

function readImageFile(file: File): Promise<ImageAttachment | undefined> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string | undefined
      const base64Data = dataUrl?.split(',')[1]
      if (!base64Data) {
        resolve(undefined)
        return
      }

      resolve({
        type: 'image',
        data: base64Data,
        mimeType: file.type,
        url: URL.createObjectURL(file),
      })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

async function addImageFiles(files: File[]) {
  const remaining = Math.max(0, MAX_IMAGE_ATTACHMENTS - attachments.value.length)
  if (remaining === 0)
    return

  const imageFiles = files
    .filter(file => file.type.startsWith('image/'))
    .slice(0, remaining)

  const loadedAttachments = (await Promise.all(imageFiles.map(readImageFile)))
    .filter((attachment): attachment is ImageAttachment => !!attachment)

  attachments.value.push(...loadedAttachments)
}

async function handleFilePaste(files: File[]) {
  await addImageFiles(files)
}

function handleDrop(event: DragEvent) {
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length)
    void addImageFiles(files)
}

function clearAttachments() {
  attachments.value.forEach(attachment => URL.revokeObjectURL(attachment.url))
  attachments.value = []
}

function removeAttachment(index: number) {
  const attachment = attachments.value[index]
  if (attachment) {
    URL.revokeObjectURL(attachment.url)
    attachments.value.splice(index, 1)
  }
}

watch(sendMode, () => {
  lastEnterTime.value = 0
})

const historyMessages = computed(() => visibleMessages.value as unknown as ChatHistoryItem[])
const assistantLabel = computed(() => activeCard.value?.name || 'AIRI')
const shouldSplitAssistantTextBubbles = computed(() => {
  const fields = [
    activeCardId.value,
    activeCard.value?.name,
    activeCard.value?.description,
    activeCard.value?.systemPrompt,
  ].filter(Boolean).join('\n')

  return /\bLumi\b/i.test(fields) || fields.includes('PersonaOS')
})

async function handleDeleteMessage(index: number) {
  await chatSyncStore.requestDeleteMessage({ index })
}

onMounted(() => {
  backgroundStore.initializeStore()
})

async function handleRetryMessage(index: number) {
  await chatSyncStore.requestRetry({
    sessionId: chatSession.activeSessionId,
    index,
  })
}
</script>

<template>
  <div
    h-full w-full flex="~ col gap-1"
    @dragover.prevent
    @drop.prevent="handleDrop"
  >
    <div w-full flex-1 overflow-hidden>
      <ChatHistory
        :messages="historyMessages"
        :base-index="visibleMessageStartIndex"
        :sending="sending"
        :streaming-message="streamingMessage"
        :assistant-label="assistantLabel"
        :split-assistant-text-bubbles="shouldSplitAssistantTextBubbles"
        :tool-call-renderers="toolCallRenderers"
        @delete-message="handleDeleteMessage($event.index)"
        @retry-message="handleRetryMessage($event.index)"
      />
    </div>

    <!-- Journal Preview Chips -->
    <div v-if="latestImageEntries.length > 0" class="flex gap-2 overflow-x-auto px-2 py-1 scrollbar-none">
      <div
        v-for="entry in latestImageEntries"
        :key="entry.id"
        :class="[
          'group relative h-14 w-14 shrink-0 cursor-pointer of-hidden rounded-lg',
          'border border-primary-200/30 transition-all hover:border-primary-500',
          'dark:border-primary-800/30 dark:hover:border-primary-400',
        ]"
        @click="openImagePreview(entry)"
      >
        <img :src="entry.url || ''" class="h-full w-full object-cover">
        <div :class="['absolute inset-0 flex items-end p-1', 'bg-gradient-to-t from-black/60 to-transparent']">
          <span class="truncate text-[8px] text-white font-medium">{{ entry.title }}</span>
        </div>

        <!-- Save Button (Top Right, Hover Only) -->
        <button
          :class="[
            'absolute right-1 top-1 z-10 p-1 rounded-md bg-black/40 text-white backdrop-blur-sm',
            'opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/60',
          ]"
          title="Save to computer"
          @click.stop="journalPreviewStore.downloadImage(entry.url || '', entry.title)"
        >
          <div class="i-solar:download-minimalistic-bold-duotone text-[10px]" />
        </button>
      </div>
    </div>
    <div
      v-if="attachments.length > 0"
      :class="[
        'flex flex-col gap-2 border-t border-primary-100 p-2',
      ]"
    >
      <div :class="['flex items-center justify-between gap-2']">
        <div :class="['flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400']">
          <div class="i-solar:gallery-send-bold-duotone size-4" />
          <span>{{ attachments.length }} image{{ attachments.length === 1 ? '' : 's' }} ready for Lumi Eyes</span>
        </div>
        <button
          :class="['rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-red-500 dark:hover:bg-neutral-800']"
          type="button"
          title="Remove all attached images"
          @click="clearAttachments"
        >
          Clear
        </button>
      </div>
      <div :class="['flex flex-wrap gap-2']">
        <div v-for="(attachment, index) in attachments" :key="index" class="relative">
          <img :src="attachment.url" :class="['h-20 w-20 rounded-md object-cover']">
          <button
            :class="[
              'absolute right-1 top-1 h-5 w-5 flex items-center justify-center rounded-full',
              'bg-red-500 text-xs text-white',
            ]"
            type="button"
            title="Remove image"
            @click="removeAttachment(index)"
          >
            &times;
          </button>
        </div>
      </div>
      <div v-if="attachments.length >= MAX_IMAGE_ATTACHMENTS" :class="['text-xs text-amber-600 dark:text-amber-300']">
        Image limit reached.
      </div>
    </div>
    <div relative w-full shrink-0>
      <ChatTtsDebugPanel />

      <div :class="['flex items-center justify-end gap-2 py-1']">
        <button
          :class="[
            'max-h-[10lh] min-h-[1lh]',
            ttsDebugStore.enabled
              ? 'bg-cyan-500/20 text-cyan-600 dark:text-cyan-200'
              : '',
          ]"
          bg="neutral-100 dark:neutral-800"
          text="lg neutral-500 dark:neutral-400"
          hover:text="cyan-500 dark:cyan-300"
          flex items-center justify-center rounded-md p-2 outline-none
          transition-colors transition-transform active:scale-95
          title="TTS 调试"
          @click="toggleTtsDebugPanel"
        >
          <div class="i-solar:soundwave-bold-duotone" />
        </button>

        <DropdownMenuRoot>
          <DropdownMenuTrigger as-child>
            <button
              :class="[
                'max-h-[10lh] min-h-[1lh] flex items-center justify-center rounded-md p-2 outline-none',
                'transition-colors transition-transform active:scale-95',
              ]"
              bg="neutral-100 dark:neutral-800"
              text="lg neutral-500 dark:neutral-400"
              :title="t('stage.send-mode.title')"
            >
              <div class="i-solar:keyboard-bold-duotone" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuPortal>
            <DropdownMenuContent
              align="end"
              side="top"
              :side-offset="8"
              :class="[
                'z-50 min-w-[180px] rounded-xl p-1 shadow',
                'bg-white dark:bg-neutral-800',
                'flex flex-col gap-1',
                'data-[side=top]:animate-slideDownAndFade',
                'data-[side=left]:animate-none',
                'data-[side=bottom]:animate-none',
                'data-[side=right]:animate-none',
              ]"
            >
              <DropdownMenuItem
                v-for="mode in SEND_MODES"
                :key="mode"
                :class="[
                  'w-full flex cursor-pointer items-center rounded-md px-3 py-2 text-left text-xs outline-none transition-colors',
                  'hover:bg-primary-50 dark:hover:bg-primary-900/20',
                  sendMode === mode ? 'bg-primary-50 text-primary-600 font-semibold dark:bg-primary-900/20 dark:text-primary-300' : 'text-neutral-500',
                ]"
                @select="sendMode = mode"
              >
                <div class="mr-2 h-4 w-4 flex shrink-0 items-center justify-center">
                  <div v-if="sendMode === mode" class="i-ph:check-bold text-base" />
                </div>
                <span>{{ sendModeLabels[mode] }}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>

        <button
          class="max-h-[10lh] min-h-[1lh]"
          bg="neutral-100 dark:neutral-800"
          text="lg neutral-500 dark:neutral-400"
          hover:text="cyan-500 dark:cyan-300"
          flex items-center justify-center rounded-md p-2 outline-none
          transition-colors transition-transform active:scale-95
          title="Claude Code 任务"
          @click="lumiAgentStore.openTaskWindow()"
        >
          <div class="i-solar:archive-bold-duotone" />
        </button>

        <button
          :class="[
            'max-h-[10lh] min-h-[1lh]',
          ]"
          bg="neutral-100 dark:neutral-800"
          text="lg neutral-500 dark:neutral-400"
          hover:text="red-500 dark:red-400"
          flex items-center justify-center rounded-md p-2 outline-none
          transition-colors transition-transform active:scale-95
          @click="() => chatSyncStore.requestCleanup()"
        >
          <div class="i-solar:trash-bin-2-bold-duotone" />
        </button>

        <!-- Image Journal Deep Link -->
        <button
          class="max-h-[10lh] min-h-[1lh]"
          bg="neutral-100 dark:neutral-800"
          text="lg neutral-500 dark:neutral-400"
          hover:text="primary-500 dark:primary-400"
          flex items-center justify-center rounded-md p-2 outline-none
          transition-colors transition-transform active:scale-95
          title="Image Journal"
          @click="navigateToImageJournal"
        >
          <div class="i-solar:gallery-bold-duotone" />
        </button>

        <!-- Attach Images For Chat -->
        <button
          class="max-h-[10lh] min-h-[1lh]"
          bg="neutral-100 dark:neutral-800"
          text="lg neutral-500 dark:neutral-400"
          hover:text="primary-500 dark:primary-400"
          flex items-center justify-center rounded-md p-2 outline-none
          transition-colors transition-transform active:scale-95
          :title="`Attach images for chat (${attachments.length}/${MAX_IMAGE_ATTACHMENTS})`"
          :disabled="attachments.length >= MAX_IMAGE_ATTACHMENTS"
          @click="handleManualAttach"
        >
          <div class="i-solar:gallery-send-bold-duotone" />
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="image/*"
          class="hidden"
          multiple
          @change="handleFileSelect"
        >
      </div>
      <BasicTextarea
        v-model="messageInput"
        :submit-on-enter="false"
        :placeholder="t('stage.message')"
        class="ph-no-capture [scrollbar-gutter:stable]"
        text="primary-600 dark:primary-100  placeholder:primary-500 dark:placeholder:primary-200"
        border="solid 2 primary-200/20 dark:primary-400/20"
        bg="primary-100/50 dark:primary-900/70"
        max-h="[10lh]" min-h="[1lh]"
        w-full shrink-0 resize-none overflow-y-auto rounded-xl p-2 font-medium outline-none
        transition="all duration-250 ease-in-out placeholder:all placeholder:duration-250 placeholder:ease-in-out"
        @compositionstart="isComposing = true"
        @compositionend="isComposing = false"
        @keydown="handleMessageInputKeydown"
        @paste-file="handleFilePaste"
      />
    </div>

    <!-- Shared Preview Modal -->
    <JournalPreviewModal />
    <ComputerUseController />
  </div>
</template>
