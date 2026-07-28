<script setup lang="ts">
import type { ChatAssistantMessage, ChatHistoryItem, ContextMessage } from '../../../../types/chat'
import type { ChatToolCallRendererRegistry } from './tool-call-renderer'

import { computed, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import ChatAssistantItem from './assistant-item.vue'
import ChatErrorItem from './error-item.vue'
import ChatUserItem from './user-item.vue'

import { useChatHistoryScroll } from '../composables/use-chat-history-scroll'
import { chatScrollContainerKey } from '../constants'
import { getChatHistoryItemKey } from '../utils'
import { projectHistoryMessage } from './history-message-projection'

const props = withDefaults(defineProps<{
  messages: ChatHistoryItem[]
  streamingMessage?: ChatAssistantMessage & { createdAt?: number }
  sending?: boolean
  assistantLabel?: string
  userLabel?: string
  errorLabel?: string
  retryLabel?: string
  splitAssistantTextBubbles?: boolean
  variant?: 'desktop' | 'mobile'
  toolCallRenderers?: ChatToolCallRendererRegistry
  baseIndex?: number
  initialRenderLimit?: number
  pageSize?: number
}>(), {
  sending: false,
  variant: 'desktop',
  toolCallRenderers: () => ({}),
  baseIndex: 0,
  initialRenderLimit: 160,
  pageSize: 80,
})

const emit = defineEmits<{
  (e: 'copyMessage', payload: { message: ChatHistoryItem, index: number, key: string | number }): void
  (e: 'deleteMessage', payload: { message: ChatHistoryItem, index: number, key: string | number }): void
  (e: 'retryMessage', payload: { message: ChatHistoryItem, index: number, key: string | number }): void
}>()

const chatHistoryRef = ref<HTMLDivElement>()
provide(chatScrollContainerKey, chatHistoryRef)

const { t } = useI18n()
const labels = computed(() => ({
  assistant: props.assistantLabel ?? t('stage.chat.message.character-name.airi'),
  user: props.userLabel ?? t('stage.chat.message.character-name.you'),
  error: props.errorLabel ?? t('stage.chat.message.character-name.core-system'),
  retry: props.retryLabel ?? t('stage.chat.actions.retry'),
}))

const streaming = computed<ChatAssistantMessage & { context?: ContextMessage } & { createdAt?: number }>(() => props.streamingMessage ?? { role: 'assistant', content: '', slices: [], tool_results: [], createdAt: Date.now() })
const showStreamingPlaceholder = computed(() => (streaming.value.slices?.length ?? 0) === 0 && !streaming.value.content)
const streamingTs = computed(() => streaming.value?.createdAt)
function shouldShowPlaceholder(message: ChatHistoryItem) {
  const ts = streamingTs.value
  if (ts == null)
    return false

  return message.context?.createdAt === ts || message.createdAt === ts
}
const fullRenderMessages = computed<ChatHistoryItem[]>(() => {
  // Preserve array positions so delete/retry actions still address the original
  // session entry while runtime diagnostics use the assistant card renderer.
  const visibleMessages = props.messages.map(projectHistoryMessage)
  if (!props.sending)
    return visibleMessages

  const streamTs = streamingTs.value
  if (!streamTs)
    return visibleMessages

  const hasStreamAlready = streamTs && visibleMessages.some(msg => msg?.role === 'assistant' && msg?.createdAt === streamTs)
  if (hasStreamAlready)
    return visibleMessages

  return [...visibleMessages, streaming.value]
})

const pagedStartOffset = ref(0)
const renderMessages = computed<ChatHistoryItem[]>(() => fullRenderMessages.value.slice(pagedStartOffset.value))
const canLoadEarlier = computed(() => pagedStartOffset.value > 0)

watch(
  () => [fullRenderMessages.value.length, props.initialRenderLimit] as const,
  ([length, limit], previous) => {
    const previousLength = previous?.[0]
    const nextDefaultStart = Math.max(0, length - limit)
    if (previousLength === undefined || pagedStartOffset.value >= Math.max(0, previousLength - limit))
      pagedStartOffset.value = nextDefaultStart
    else
      pagedStartOffset.value = Math.min(pagedStartOffset.value, nextDefaultStart)
  },
  { immediate: true },
)

useChatHistoryScroll({
  containerRef: chatHistoryRef,
  messages: renderMessages,
  getKey: getChatHistoryItemKey,
})

function getOriginalIndex(localIndex: number) {
  return props.baseIndex + pagedStartOffset.value + localIndex
}

function getFullLocalIndex(localIndex: number) {
  return pagedStartOffset.value + localIndex
}

function loadEarlierMessages() {
  pagedStartOffset.value = Math.max(0, pagedStartOffset.value - props.pageSize)
}

function emitCopyMessage(message: ChatHistoryItem, index: number) {
  const originalIndex = getOriginalIndex(index)
  emit('copyMessage', {
    message,
    index: originalIndex,
    key: getChatHistoryItemKey(message, originalIndex),
  })
}

function emitDeleteMessage(message: ChatHistoryItem, index: number) {
  const originalIndex = getOriginalIndex(index)
  emit('deleteMessage', {
    message,
    index: originalIndex,
    key: getChatHistoryItemKey(message, originalIndex),
  })
}

function emitRetryMessage(message: ChatHistoryItem, index: number) {
  const originalIndex = getOriginalIndex(index)
  emit('retryMessage', {
    message,
    index: originalIndex,
    key: getChatHistoryItemKey(message, originalIndex),
  })
}
</script>

<template>
  <div ref="chatHistoryRef" v-auto-animate flex="~ col" relative h-full w-full overflow-y-auto rounded-xl px="<sm:2" py="<sm:2" :class="variant === 'mobile' ? 'gap-1' : 'gap-2'">
    <button
      v-if="canLoadEarlier"
      type="button"
      class="mx-auto my-1 border border-primary-200/50 rounded-full px-3 py-1 text-xs text-primary-600 transition dark:border-primary-700/50 hover:bg-primary-50 dark:text-primary-200 dark:hover:bg-primary-900/30"
      @click="loadEarlierMessages"
    >
      加载更早消息
    </button>
    <template v-for="(message, index) in renderMessages" :key="getChatHistoryItemKey(message, getOriginalIndex(index))">
      <div
        v-if="message.role === 'error' || message.role === 'assistant' || message.role === 'user'"
        :data-chat-message-index="getOriginalIndex(index)"
        :data-chat-message-key="String(getChatHistoryItemKey(message, getOriginalIndex(index)))"
        :data-chat-message-role="message.role"
      >
        <ChatErrorItem
          v-if="message.role === 'error'"
          :message="message"
          :label="labels.error"
          :retry-label="labels.retry"
          :can-retry="fullRenderMessages[getFullLocalIndex(index) - 1]?.role === 'user'"
          :show-placeholder="sending && index === renderMessages.length - 1"
          :variant="variant"
          @copy="emitCopyMessage(message, index)"
          @retry="emitRetryMessage(message, index)"
          @delete="emitDeleteMessage(message, index)"
        />
        <ChatAssistantItem
          v-else-if="message.role === 'assistant'"
          :message="message"
          :label="labels.assistant"
          :show-placeholder="shouldShowPlaceholder(message) && showStreamingPlaceholder"
          :variant="variant"
          :split-text-bubbles="splitAssistantTextBubbles"
          :tool-call-renderers="toolCallRenderers"
          @copy="emitCopyMessage(message, index)"
          @delete="emitDeleteMessage(message, index)"
        />
        <ChatUserItem
          v-else-if="message.role === 'user'"
          :message="message"
          :label="labels.user"
          :variant="variant"
          @copy="emitCopyMessage(message, index)"
          @delete="emitDeleteMessage(message, index)"
        />
      </div>
    </template>
  </div>
</template>
