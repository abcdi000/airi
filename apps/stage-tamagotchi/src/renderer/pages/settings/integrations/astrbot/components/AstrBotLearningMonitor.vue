<script setup lang="ts">
import type { ElectronLumiAstrBotGatewayConfig, ElectronLumiAstrBotStudyGroup } from '../../../../../../shared/eventa'

import { Button } from '@proj-airi/ui'
import { computed, toRefs } from 'vue'

import { useAstrBotLearningMonitor } from '../useAstrBotLearningMonitor'

const props = defineProps<{
  mode: ElectronLumiAstrBotGatewayConfig['learningMode']
  groups: ElectronLumiAstrBotStudyGroup[]
  batchSize: number
  historyLimit: number
  concurrentGroups: number
}>()

const { batchSize, concurrentGroups, groups, mode } = toRefs(props)
const monitor = useAstrBotLearningMonitor({ mode, groups, batchSize, concurrentGroups })
const statusClasses = computed(() => ({
  idle: 'bg-neutral-400',
  warning: 'bg-amber-500',
  processing: 'bg-sky-500 animate-pulse',
  live: 'bg-emerald-500 animate-pulse',
})[monitor.status.value.tone])

function formatTime(timestamp?: number) {
  if (!timestamp)
    return '尚未收到'
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp)
}

function eventIcon(kind: 'message' | 'batch' | 'sticker' | 'warning') {
  if (kind === 'message')
    return 'i-solar:chat-round-dots-bold-duotone'
  if (kind === 'sticker')
    return 'i-solar:sticker-smile-circle-2-bold-duotone'
  if (kind === 'warning')
    return 'i-solar:danger-triangle-bold-duotone'
  return 'i-solar:magic-stick-3-bold-duotone'
}

function changeIcon(kind: 'expression' | 'jargon' | 'behavior') {
  if (kind === 'jargon')
    return 'i-solar:dictionary-bold-duotone'
  if (kind === 'behavior')
    return 'i-solar:users-group-rounded-bold-duotone'
  return 'i-solar:chat-round-like-bold-duotone'
}
</script>

<template>
  <section :class="['flex flex-col gap-6 border-t border-neutral-200 pt-6 dark:border-neutral-800']">
    <header :class="['flex flex-wrap items-start justify-between gap-4']">
      <div>
        <h2 :class="['text-base font-semibold']">
          学习监控台
        </h2>
        <p :class="['mt-1 max-w-2xl text-sm text-neutral-500 dark:text-neutral-400']">
          实时查看只读群消息、缓冲进度、语言变化和表情包收藏或发送事件。这里不会展示或读取私聊记忆。
        </p>
      </div>
      <div :class="['flex flex-wrap items-center justify-end gap-3 text-sm']">
        <Button
          v-if="monitor.pendingCount.value >= batchSize && monitor.activeObservationBatches.value.length === 0"
          variant="secondary"
          icon="i-solar:play-circle-bold-duotone"
          label="继续处理等待队列"
          @click="monitor.resumePending"
        />
        <Button
          v-if="monitor.missedMessageCount.value > 0"
          :disabled="monitor.isReprocessing.value"
          @click="monitor.reprocessMissed"
        >
          <div :class="[monitor.isReprocessing.value ? 'i-solar:refresh-circle-bold animate-spin' : 'i-solar:restart-bold', 'mr-2 size-4']" />
          {{ monitor.isReprocessing.value ? '正在重新归纳' : `重新归纳遗漏消息 (${monitor.missedMessageCount.value})` }}
        </Button>
        <div :class="['flex items-center gap-2']">
          <span :class="['size-2.5 rounded-full', statusClasses]" />
          <div>
            <div :class="['font-medium']">
              {{ monitor.status.value.label }}
            </div>
            <div :class="['text-xs text-neutral-500']">
              {{ monitor.status.value.detail }}
            </div>
          </div>
        </div>
      </div>
    </header>
    <p
      v-if="monitor.reprocessResult.value"
      :class="['border-l-2 border-sky-500 bg-sky-500/8 px-3 py-2 text-sm text-neutral-700 dark:text-neutral-200']"
    >
      {{ monitor.reprocessResult.value }}
    </p>

    <div :class="['grid grid-cols-2 gap-x-5 gap-y-4 border-y border-neutral-200 py-5 md:grid-cols-5 dark:border-neutral-800']">
      <div>
        <div :class="['text-xs text-neutral-500']">
          监控保留
        </div>
        <div :class="['mt-1 text-2xl font-semibold']">
          {{ monitor.recentObservationCount.value }}
          <span :class="['text-xs font-normal text-neutral-500']">/ {{ historyLimit }}</span>
        </div>
      </div>
      <div>
        <div :class="['text-xs text-neutral-500']">
          等待归纳
        </div>
        <div :class="['mt-1 text-2xl font-semibold']">
          {{ monitor.pendingCount.value }}
        </div>
      </div>
      <div>
        <div :class="['text-xs text-neutral-500']">
          已处理消息
        </div>
        <div :class="['mt-1 text-2xl font-semibold']">
          {{ monitor.processedMessageCount.value }}
        </div>
      </div>
      <div>
        <div :class="['text-xs text-neutral-500']">
          知识变化
        </div>
        <div :class="['mt-1 text-2xl font-semibold']">
          {{ monitor.changedKnowledgeCount.value }}
        </div>
      </div>
      <div>
        <div :class="['text-xs text-neutral-500']">
          表情库存
        </div>
        <div :class="['mt-1 text-2xl font-semibold']">
          {{ monitor.stickerLibrary.value?.stats.owned ?? 0 }}
        </div>
      </div>
    </div>

    <div v-if="monitor.sourceProgress.value.length" :class="['flex flex-col gap-4']">
      <div
        v-for="source in monitor.sourceProgress.value"
        :key="source.id"
        :class="['grid items-center gap-3 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]']"
      >
        <div :class="['min-w-0']">
          <div :class="['truncate text-sm font-medium']">
            {{ source.displayName || source.groupId }}
          </div>
          <div :class="['text-xs text-neutral-500']">
            {{ source.recentlyReceived }} 条最近消息 · {{ formatTime(source.lastReceivedAt) }}
          </div>
        </div>
        <div :class="['h-2 overflow-hidden rounded bg-neutral-200 dark:bg-neutral-800']">
          <div
            :class="['h-full bg-sky-500 transition-[width] duration-300']"
            :style="{ width: `${source.progress}%` }"
          />
        </div>
        <div :class="['text-right text-xs tabular-nums text-neutral-500']">
          {{ source.pending }} / {{ batchSize }}
        </div>
      </div>
    </div>

    <div :class="['grid gap-8 lg:grid-cols-2']">
      <section :class="['min-w-0']">
        <h3 :class="['mb-3 text-sm font-semibold']">
          实时事件
        </h3>
        <div v-if="monitor.recentEvents.value.length" :class="['max-h-96 overflow-y-auto border-t border-neutral-200 dark:border-neutral-800']">
          <div
            v-for="event in monitor.recentEvents.value"
            :key="event.id"
            :class="['flex gap-3 border-b border-neutral-200 py-3 dark:border-neutral-800']"
          >
            <div :class="[eventIcon(event.kind), 'mt-0.5 size-5 shrink-0 text-neutral-500']" />
            <div :class="['min-w-0 flex-1']">
              <div :class="['flex items-center justify-between gap-3']">
                <span :class="['truncate text-sm font-medium']">{{ event.title }}</span>
                <time :class="['shrink-0 text-xs text-neutral-500']">{{ formatTime(event.timestamp) }}</time>
              </div>
              <p :class="['mt-1 whitespace-pre-wrap break-words text-sm text-neutral-600 dark:text-neutral-300']">
                {{ event.detail }}
              </p>
            </div>
          </div>
        </div>
        <p v-else :class="['border-t border-neutral-200 py-8 text-center text-sm text-neutral-500 dark:border-neutral-800']">
          还没有收到学习群消息
        </p>
      </section>

      <section :class="['min-w-0']">
        <h3 :class="['mb-3 text-sm font-semibold']">
          最近学习变化
        </h3>
        <div v-if="monitor.recentChanges.value.length" :class="['max-h-96 overflow-y-auto border-t border-neutral-200 dark:border-neutral-800']">
          <div
            v-for="change in monitor.recentChanges.value"
            :key="change.id"
            :class="['flex gap-3 border-b border-neutral-200 py-3 dark:border-neutral-800']"
          >
            <div :class="[changeIcon(change.kind), 'mt-0.5 size-5 shrink-0 text-sky-600 dark:text-sky-400']" />
            <div :class="['min-w-0 flex-1']">
              <div :class="['flex items-center justify-between gap-3']">
                <span :class="['truncate text-sm font-medium']">{{ change.label }}</span>
                <time :class="['shrink-0 text-xs text-neutral-500']">{{ formatTime(change.timestamp) }}</time>
              </div>
              <p :class="['mt-1 break-words text-sm text-neutral-600 dark:text-neutral-300']">
                {{ change.detail }}
              </p>
            </div>
          </div>
        </div>
        <p v-else :class="['border-t border-neutral-200 py-8 text-center text-sm text-neutral-500 dark:border-neutral-800']">
          完成首批归纳后，这里会显示新增或更新的表达、黑话和行为
        </p>
      </section>
    </div>
  </section>
</template>
