<script setup lang="ts">
import type { LumiOnlineMessage } from '@proj-airi/lumi-online'
import type { LumiRoomEvent } from '@proj-airi/server-sdk'

import { nextTick, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  events: readonly (LumiRoomEvent | LumiOnlineMessage)[]
}>()

const { t } = useI18n()
const scroller = useTemplateRef<HTMLDivElement>('scroller')

watch(() => props.events.length, async () => {
  await nextTick()
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' })
}, { immediate: true })

function formatTime(timestamp: number) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime()))
    return '--:--'

  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatDateTime(timestamp: number) {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}
</script>

<template>
  <div ref="scroller" :class="['min-h-0 flex-1 overflow-y-auto px-4 py-5']">
    <div v-if="!props.events.length" :class="['h-full flex flex-col items-center justify-center gap-2 text-center']">
      <div class="i-solar:chat-round-dots-bold-duotone h-8 w-8 text-neutral-300 dark:text-neutral-600" />
      <p :class="['m-0 text-sm text-neutral-500 dark:text-neutral-400']">
        {{ t('stage.lumi-room.empty') }}
      </p>
    </div>

    <ol v-else :class="['m-0 flex list-none flex-col gap-4 p-0']">
      <li
        v-for="event in props.events"
        :key="event.sequence"
        :class="[
          'flex flex-col gap-1',
          event.role === 'assistant' ? 'items-start' : 'items-end',
        ]"
      >
        <div :class="['flex items-center gap-2 px-1 text-[11px] text-neutral-400 dark:text-neutral-500']">
          <span>{{ event.role === 'assistant' ? 'Lumi' : (event.actorDisplayName || t('stage.lumi-room.participant')) }}</span>
          <span>#{{ event.sequence }}</span>
          <time :datetime="formatDateTime(event.createdAt)">{{ formatTime(event.createdAt) }}</time>
        </div>
        <p
          :class="[
            'm-0 max-w-[86%] whitespace-pre-wrap break-words rounded-lg px-3.5 py-2.5 text-sm leading-6',
            event.role === 'assistant'
              ? 'bg-white text-neutral-800 shadow-sm ring-1 ring-neutral-200 dark:bg-neutral-900 dark:text-neutral-100 dark:ring-neutral-800'
              : 'bg-cyan-600 text-white dark:bg-cyan-700',
          ]"
        >
          {{ event.content }}
        </p>
      </li>
    </ol>
  </div>
</template>
