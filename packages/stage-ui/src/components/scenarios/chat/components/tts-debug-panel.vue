<script setup lang="ts">
import type { TtsDebugSegment, TtsDebugSegmentStatus } from '../../../../stores/tts-debug'

import { storeToRefs } from 'pinia'
import { computed } from 'vue'

import { useTtsDebugStore } from '../../../../stores/tts-debug'

const debugStore = useTtsDebugStore()
const { panelOpen, enabled, currentSessionId, currentSegments, currentEvents, activeCount } = storeToRefs(debugStore)

const orderedEvents = computed(() => currentEvents.value.slice(-80).reverse())
const sessionLabel = computed(() => currentSessionId.value ? currentSessionId.value.slice(0, 18) : '无活动会话')

function laneLabel(lane: string | undefined) {
  if (lane === 'local')
    return '本地'
  if (lane === 'cloud')
    return 'API'
  if (lane === 'playback')
    return '播放'
  return '会话'
}

function laneClass(lane: string | undefined) {
  if (lane === 'local')
    return 'bg-cyan-500/15 text-cyan-700 dark:text-cyan-200'
  if (lane === 'cloud')
    return 'bg-violet-500/15 text-violet-700 dark:text-violet-200'
  if (lane === 'playback')
    return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-200'
  return 'bg-neutral-500/15 text-neutral-700 dark:text-neutral-200'
}

function statusLabel(status: TtsDebugSegmentStatus) {
  const labels: Record<TtsDebugSegmentStatus, string> = {
    queued: '等待',
    synthesizing: '生成中',
    delayed: '延迟',
    retrying: '重试',
    ready: '已生成',
    queued_playback: '待播放',
    playing: '播放中',
    played: '已播放',
    fallback: '切换线路',
    failed: '失败',
    skipped: '跳过',
  }
  return labels[status]
}

function statusClass(status: TtsDebugSegmentStatus) {
  if (status === 'playing')
    return 'bg-primary-500/20 text-primary-700 dark:text-primary-200'
  if (status === 'failed' || status === 'skipped')
    return 'bg-red-500/15 text-red-700 dark:text-red-200'
  if (status === 'retrying' || status === 'delayed' || status === 'fallback')
    return 'bg-amber-500/20 text-amber-800 dark:text-amber-200'
  if (status === 'ready' || status === 'queued_playback' || status === 'played')
    return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-200'
  return 'bg-neutral-500/15 text-neutral-700 dark:text-neutral-200'
}

function phaseLabel(phase: string) {
  const labels: Record<string, string> = {
    session_started: '会话开始',
    segment_queued: '分段入队',
    synth_start: '开始生成',
    synth_delay: '等待限速',
    synth_retry: '重试生成',
    synth_ready: '生成完成',
    segment_emitted: '送入播放',
    segment_fallback: '线路切换',
    segment_failed: '分段失败',
    segment_skipped: '跳过分段',
    playback_started: '开始播放',
    playback_finished: '播放结束',
    playback_interrupted: '播放中断',
    session_done: '会话结束',
    session_cancelled: '会话取消',
  }
  return labels[phase] ?? phase
}

function formatMs(ms: number | undefined) {
  if (!ms)
    return ''
  if (ms < 1000)
    return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function segmentMeta(segment: TtsDebugSegment) {
  return [
    segment.durationMs ? `生成 ${formatMs(segment.durationMs)}` : '',
    segment.audioDurationMs ? `音频 ${formatMs(segment.audioDurationMs)}` : '',
    segment.retryCount ? `重试 ${segment.retryCount}` : '',
    segment.delayMs ? `等待 ${formatMs(segment.delayMs)}` : '',
    segment.statusCode ? `HTTP ${segment.statusCode}` : '',
  ].filter(Boolean).join(' · ')
}
</script>

<template>
  <div
    v-if="panelOpen"
    class="tts-debug-panel absolute bottom-[calc(100%+0.75rem)] left-0 right-0 z-40 mx-2 max-h-[56vh] overflow-hidden rounded-xl border border-cyan-400/35 bg-neutral-50/95 shadow-2xl backdrop-blur-xl dark:border-cyan-500/25 dark:bg-neutral-950/92"
  >
    <div class="flex items-center justify-between gap-3 border-b border-neutral-200/70 px-4 py-3 dark:border-neutral-800/80">
      <div class="min-w-0">
        <div class="flex items-center gap-2 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          <div class="i-solar:soundwave-bold-duotone h-4 w-4 text-cyan-500" />
          <span>TTS 调试</span>
          <span class="rounded-full bg-cyan-500/12 px-2 py-0.5 text-xs text-cyan-700 dark:text-cyan-200">
            {{ enabled ? '实时监听' : '已暂停' }}
          </span>
        </div>
        <div class="mt-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
          {{ sessionLabel }} · 活跃 {{ activeCount }} · 分段 {{ currentSegments.length }}
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <button
          class="h-8 w-8 flex items-center justify-center rounded-lg text-neutral-500 transition hover:bg-neutral-200/70 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
          title="清空调试记录"
          @click="debugStore.clear()"
        >
          <div class="i-solar:trash-bin-minimalistic-bold-duotone h-4 w-4" />
        </button>
        <button
          class="h-8 w-8 flex items-center justify-center rounded-lg text-neutral-500 transition hover:bg-neutral-200/70 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
          title="关闭调试窗口"
          @click="panelOpen = false"
        >
          <div class="i-solar:close-circle-bold-duotone h-4 w-4" />
        </button>
      </div>
    </div>

    <div class="grid max-h-[calc(56vh-58px)] gap-3 overflow-y-auto p-3 lg:grid-cols-[1.15fr_0.85fr]">
      <section class="min-h-0">
        <div class="mb-2 flex items-center justify-between text-xs font-medium text-neutral-500 dark:text-neutral-400">
          <span>分段流水线</span>
          <span>{{ currentSegments.length ? '按文本顺序排列' : '等待下一次语音生成' }}</span>
        </div>
        <div class="flex flex-col gap-2">
          <div
            v-for="segment in currentSegments"
            :key="segment.id"
            class="rounded-lg border border-neutral-200/70 bg-white/80 p-3 text-sm dark:border-neutral-800/80 dark:bg-neutral-900/70"
          >
            <div class="mb-2 flex flex-wrap items-center gap-2">
              <span class="text-xs font-mono text-neutral-500">#{{ segment.index + 1 }}</span>
              <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="laneClass(segment.lane)">
                {{ laneLabel(segment.lane) }}
              </span>
              <span class="rounded-full px-2 py-0.5 text-xs font-medium" :class="statusClass(segment.status)">
                {{ statusLabel(segment.status) }}
              </span>
              <span v-if="segmentMeta(segment)" class="text-xs text-neutral-500 dark:text-neutral-400">
                {{ segmentMeta(segment) }}
              </span>
            </div>
            <div class="whitespace-pre-wrap break-words leading-relaxed text-neutral-800 dark:text-neutral-100">
              {{ segment.text || '(空分段)' }}
            </div>
            <div v-if="segment.detail || segment.error" class="mt-2 rounded-md bg-neutral-100/80 px-2 py-1.5 text-xs text-neutral-600 dark:bg-neutral-950/80 dark:text-neutral-300">
              <div v-if="segment.detail">
                {{ segment.detail }}
              </div>
              <div v-if="segment.error" class="text-red-600 dark:text-red-300">
                {{ segment.error }}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="min-h-0">
        <div class="mb-2 flex items-center justify-between text-xs font-medium text-neutral-500 dark:text-neutral-400">
          <span>事件流</span>
          <span>{{ currentEvents.length }} 条</span>
        </div>
        <div class="max-h-[42vh] overflow-y-auto rounded-lg bg-neutral-100/70 p-2 font-mono text-xs dark:bg-neutral-900/70">
          <div
            v-for="event in orderedEvents"
            :key="event.id"
            class="mb-1.5 rounded-md bg-white/70 px-2 py-1.5 dark:bg-neutral-950/70"
          >
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-neutral-400">{{ formatTime(event.timestamp) }}</span>
              <span class="rounded px-1.5 py-0.5" :class="laneClass(event.lane)">
                {{ laneLabel(event.lane) }}
              </span>
              <span class="text-neutral-700 dark:text-neutral-200">{{ phaseLabel(event.phase) }}</span>
              <span v-if="event.segmentIndex != null" class="text-neutral-500">#{{ event.segmentIndex + 1 }}</span>
              <span v-if="event.delayMs" class="text-amber-700 dark:text-amber-300">delay {{ formatMs(event.delayMs) }}</span>
              <span v-if="event.durationMs" class="text-emerald-700 dark:text-emerald-300">{{ formatMs(event.durationMs) }}</span>
            </div>
            <div v-if="event.detail || event.error" class="mt-1 whitespace-pre-wrap break-words text-neutral-500 dark:text-neutral-400">
              {{ event.error || event.detail }}
            </div>
          </div>
          <div v-if="orderedEvents.length === 0" class="px-2 py-6 text-center text-neutral-500">
            还没有 TTS 调试事件。
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
