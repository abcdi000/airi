<script setup lang="ts">
import type { ChatAssistantMessage, ChatHistoryItem, ChatSlices, ChatSlicesText, ChatSlicesToolCallResult } from '../../../../types/chat'
import type { ChatToolCallRendererRegistry } from './tool-call-renderer'

import { isStageCapacitor, isStageWeb } from '@proj-airi/stage-shared'
import { computed } from 'vue'

import ChatResponsePart from './response-part.vue'
import ChatToolCallBlock from './tool-call-block.vue'

import { stripInternalLumiOutput } from '../../../../libs/chat-sync'
import { MarkdownRenderer } from '../../../markdown'
import { getChatHistoryItemCopyText } from '../utils'
import { ChatActionMenu } from './action-menu'
import { parseAssistantDiagnostic } from './assistant-diagnostic'
import { createToolCallResultLookup, resolveToolCallBlockState } from './tool-call-results'

const props = withDefaults(defineProps<{
  message: ChatAssistantMessage
  label: string
  showPlaceholder?: boolean
  variant?: 'desktop' | 'mobile'
  splitTextBubbles?: boolean
  toolCallRenderers?: ChatToolCallRendererRegistry
}>(), {
  showPlaceholder: false,
  variant: 'desktop',
  splitTextBubbles: false,
  toolCallRenderers: () => ({}),
})

const emit = defineEmits<{
  (e: 'copy'): void
  (e: 'delete'): void
}>()

const resolvedSlices = computed<ChatSlices[]>(() => {
  if (props.message.slices?.length) {
    return props.message.slices
      .map((slice) => {
        if (slice.type !== 'text')
          return slice
        return {
          ...slice,
          text: stripInternalLumiOutput(slice.text),
        }
      })
      .filter(slice => slice.type !== 'text' || slice.text.length > 0)
  }

  if (typeof props.message.content === 'string' && props.message.content.trim()) {
    const text = stripInternalLumiOutput(props.message.content)
    return text ? [{ type: 'text', text } satisfies ChatSlicesText] : []
  }

  if (Array.isArray(props.message.content)) {
    const textPart = props.message.content.find(part => 'type' in part && part.type === 'text') as { text?: string } | undefined
    if (textPart?.text)
      return [{ type: 'text', text: stripInternalLumiOutput(textPart.text) } satisfies ChatSlicesText]
  }

  return []
})

const toolResultById = computed(() => {
  return createToolCallResultLookup(resolvedSlices.value, props.message.tool_results)
})

function getToolCallResult(slice: ChatSlices): ChatSlicesToolCallResult | undefined {
  if (slice.type !== 'tool-call') {
    return undefined
  }

  return toolResultById.value.get(slice.toolCall.toolCallId)
}

function getToolCallState(slice: ChatSlices): 'executing' | 'done' | 'error' {
  return resolveToolCallBlockState(getToolCallResult(slice))
}

function getToolCallRenderer(slice: ChatSlices) {
  if (slice.type !== 'tool-call') {
    return ChatToolCallBlock
  }

  return props.toolCallRenderers[slice.toolCall.toolName] ?? ChatToolCallBlock
}

const showLoader = computed(() => props.showPlaceholder && resolvedSlices.value.length === 0)
const containerClass = computed(() => props.variant === 'mobile' ? 'mr-0' : 'mr-12')
const boxClasses = computed(() => [
  props.variant === 'mobile' ? 'px-2 py-2 text-sm bg-primary-50/90 dark:bg-primary-950/90' : 'px-3 py-3 bg-primary-50/80 dark:bg-primary-950/80',
])
const copyText = computed(() => stripInternalLumiOutput(getChatHistoryItemCopyText(props.message as ChatHistoryItem)))
const plainText = computed(() => resolvedSlices.value
  .filter((slice): slice is ChatSlicesText => slice.type === 'text')
  .map(slice => slice.text)
  .join('\n')
  .trim())
const debugBubble = computed(() => parseAssistantDiagnostic(props.message))
const splitBubbleTexts = computed(() => {
  if (!props.splitTextBubbles)
    return []

  if (resolvedSlices.value.some(slice => slice.type !== 'text'))
    return []

  const text = stripVisibleAssistantPreamble(plainText.value)
  if (!text || text.includes('```'))
    return []

  const lineParts = text
    .split(/\r?\n+/)
    .map(part => part.trim())
    .filter(Boolean)

  const looksLikeShortChatLines = lineParts.length > 1
    && lineParts.length <= 4
    && lineParts.every(part => part.length <= 180)
    && lineParts.every(part => !/^\s*(?:[\-*+|]|\d+[.)]|#{1,6}\s|>\s)/.test(part))

  return looksLikeShortChatLines ? lineParts : []
})

function stripVisibleAssistantPreamble(text: string) {
  const normalized = text.trim()
  const lines = normalized.split(/\r?\n/)
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    if (/^\s*(?:AIRI|Lumi|\{\{char\}\}|assistant)\s*(?:[:：]\s*)?$/i.test(lines[index] ?? '')) {
      const afterLabel = lines.slice(index + 1).join('\n').trim()
      if (afterLabel)
        return afterLabel
    }
  }

  for (const prefix of ['我想回应', '我会回应', '我应该回应', '可以回应', '想回应']) {
    for (const separator of [':', '：']) {
      const marker = `${prefix}${separator}`
      const markerIndex = normalized.lastIndexOf(marker)
      if (markerIndex < 0)
        continue
      const responseText = normalized.slice(markerIndex + marker.length).trim()
      if (responseText)
        return responseText
    }
  }

  return normalized
}
</script>

<template>
  <div v-if="debugBubble" flex justify-center class="ph-no-capture px-4">
    <ChatActionMenu
      :copy-text="copyText"
      :can-delete="!showPlaceholder"
      @copy="emit('copy')"
      @delete="emit('delete')"
    >
      <template #default="{ setMeasuredElement }">
        <div
          :ref="setMeasuredElement"
          class="max-w-176 w-full border border-emerald-200/80 rounded-lg bg-emerald-50/90 px-3 py-2 text-emerald-900 shadow-sm dark:border-emerald-700/50 dark:bg-emerald-950/70 dark:text-emerald-100"
        >
          <details>
            <summary class="cursor-pointer select-none text-sm font-medium outline-none">
              <span>{{ debugBubble.title }}</span>
              <span v-if="debugBubble.summary" class="ml-2 text-emerald-700/75 dark:text-emerald-200/75">{{ debugBubble.summary }}</span>
            </summary>
            <pre class="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs leading-relaxed font-mono">{{ debugBubble.body }}</pre>
          </details>
        </div>
      </template>
    </ChatActionMenu>
  </div>
  <div v-else flex :class="containerClass" class="ph-no-capture">
    <ChatActionMenu
      :copy-text="copyText"
      :can-delete="!showPlaceholder"
      @copy="emit('copy')"
      @delete="emit('delete')"
    >
      <template #default="{ setMeasuredElement }">
        <div
          :ref="setMeasuredElement"
          flex="~ col"
          gap-2
        >
          <template v-if="splitBubbleTexts.length > 1">
            <div
              v-for="(bubbleText, bubbleIndex) in splitBubbleTexts"
              :key="bubbleIndex"
              data-chat-assistant-bubble="split"
              flex="~ col" shadow="sm primary-200/50 dark:none"
              min-w-20 gap-2 rounded-xl h="unset <sm:fit"
              :class="[
                boxClasses,
                (isStageWeb() || isStageCapacitor()) && props.variant === 'mobile' ? 'select-none sm:select-auto' : '',
              ]"
            >
              <div v-if="bubbleIndex === 0" class="<sm:hidden">
                <span text-sm text="black/60 dark:white/65" font-normal>{{ label }}</span>
              </div>
              <div class="break-words" text="primary-700 dark:primary-100">
                <MarkdownRenderer :content="bubbleText" />
              </div>
            </div>
          </template>

          <div
            v-else
            data-chat-assistant-bubble="single"
            flex="~ col" shadow="sm primary-200/50 dark:none"
            min-w-20 gap-2 rounded-xl h="unset <sm:fit"
            :class="[
              boxClasses,
              (isStageWeb() || isStageCapacitor()) && props.variant === 'mobile' ? 'select-none sm:select-auto' : '',
            ]"
          >
            <ChatResponsePart
              v-if="message.categorization && !splitTextBubbles"
              :message="message"
              :variant="variant"
            />
            <div class="<sm:hidden">
              <span text-sm text="black/60 dark:white/65" font-normal>{{ label }}</span>
            </div>
            <div v-if="resolvedSlices.length > 0" class="flex flex-col gap-2 break-words" text="primary-700 dark:primary-100">
              <template v-for="(slice, sliceIndex) in resolvedSlices" :key="sliceIndex">
                <component
                  :is="getToolCallRenderer(slice)"
                  v-if="slice.type === 'tool-call'"
                  :tool-name="slice.toolCall.toolName"
                  :args="slice.toolCall.args"
                  :state="getToolCallState(slice)"
                  :result="getToolCallResult(slice)?.result"
                />
                <template v-else-if="slice.type === 'tool-call-result'" />
                <template v-else-if="slice.type === 'text'">
                  <MarkdownRenderer :content="stripVisibleAssistantPreamble(slice.text)" />
                </template>
                <img
                  v-else-if="slice.type === 'image'"
                  :src="slice.url"
                  :alt="slice.alt || 'Lumi 表情'"
                  :class="['max-h-64 max-w-full self-start rounded-md object-contain']"
                >
              </template>
            </div>
            <div v-else-if="showLoader" i-eos-icons:three-dots-loading />
          </div>
        </div>
      </template>
    </ChatActionMenu>
  </div>
</template>
