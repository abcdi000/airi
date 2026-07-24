<script setup lang="ts">
import type { ChatHistoryItem, ChatMessage } from '../../../../types/chat'

import { isStageCapacitor, isStageWeb } from '@proj-airi/stage-shared'
import { computed } from 'vue'

import { MarkdownRenderer } from '../../../markdown'
import { ChatActionMenu } from '../components/action-menu'
import { getChatHistoryItemCopyText, getUserMessageDisplayText, getUserMessageImageUrls } from '../utils'

const props = withDefaults(defineProps<{
  message: Extract<ChatMessage, { role: 'user' }>
  label: string
  variant?: 'desktop' | 'mobile'
}>(), {
  variant: 'desktop',
})

const emit = defineEmits<{
  (e: 'copy'): void
  (e: 'delete'): void
}>()

const content = computed(() => getUserMessageDisplayText(props.message as ChatHistoryItem))
const imageUrls = computed(() => getUserMessageImageUrls(props.message as ChatHistoryItem))

const containerClasses = computed(() => [
  'flex',
  props.variant === 'mobile' ? 'ml-0 flex-row' : 'ml-12 flex-row-reverse',
])

const boxClasses = computed(() => [
  props.variant === 'mobile' ? 'px-2 py-2 text-sm bg-neutral-100/90 dark:bg-neutral-800/90' : 'px-3 py-3 bg-neutral-100/80 dark:bg-neutral-800/80',
])
const copyText = computed(() => getChatHistoryItemCopyText(props.message as ChatHistoryItem))
</script>

<template>
  <div v-if="message.role === 'user'" :class="containerClasses" class="ph-no-capture">
    <ChatActionMenu
      :copy-text="copyText"
      placement="left"
      @copy="emit('copy')"
      @delete="emit('delete')"
    >
      <template #default="{ setMeasuredElement }">
        <div
          :ref="setMeasuredElement"
          flex="~ col" shadow="sm neutral-200/50 dark:none"
          min-w-20 rounded-xl h="unset <sm:fit"
          :class="[
            boxClasses,
            (isStageWeb() || isStageCapacitor()) && props.variant === 'mobile' ? 'select-none sm:select-auto' : '',
          ]"
        >
          <div>
            <span text-sm text="black/60 dark:white/65" font-normal class="inline <sm:hidden">{{ label }}</span>
          </div>
          <div v-if="imageUrls.length" class="grid mb-2 max-w-[min(360px,70vw)] gap-2" :class="imageUrls.length === 1 ? 'grid-cols-1' : 'grid-cols-2'">
            <img
              v-for="(url, index) in imageUrls"
              :key="index"
              :src="url"
              alt="Attached image"
              class="max-h-56 w-full rounded-lg object-cover"
            >
          </div>
          <MarkdownRenderer
            v-if="content"
            :content="content as string"
            class="break-words"
          />
        </div>
      </template>
    </ChatActionMenu>
  </div>
</template>
