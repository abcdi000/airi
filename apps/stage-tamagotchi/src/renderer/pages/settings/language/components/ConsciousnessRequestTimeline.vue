<script setup lang="ts">
import type {
  LumiConsciousnessRequestPurpose,
  LumiConsciousnessRequestTrace,
} from '@proj-airi/stage-ui/stores/lumi-consciousness-observability'

import { useLumiConsciousnessObservabilityStore } from '@proj-airi/stage-ui/stores/lumi-consciousness-observability'
import { Button, DoubleCheckButton, SelectTab } from '@proj-airi/ui'
import { useIntervalFn } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, shallowRef, watch } from 'vue'

type DetailTab = 'response' | 'request'

const store = useLumiConsciousnessObservabilityStore()
const { requests, activeCount } = storeToRefs(store)
const selectedRequestId = shallowRef('')
const detailTab = shallowRef<DetailTab>('response')
const copied = shallowRef(false)

const orderedRequests = computed(() => requests.value.slice().reverse())
const requestOptions = computed(() =>
  orderedRequests.value.map(request => ({
    id: request.id,
    label: requestOption(request),
  })),
)
const selectedRequest = computed(() =>
  orderedRequests.value.find(request => request.id === selectedRequestId.value) ?? orderedRequests.value[0],
)
const contextSummaryCount = computed(() =>
  requests.value.filter(request => request.purpose === 'context_summary').length,
)
const averageDuration = computed(() => {
  const completed = requests.value.flatMap(request =>
    typeof request.durationMs === 'number' ? [request.durationMs] : [],
  )
  if (!completed.length)
    return undefined
  return Math.round(completed.reduce((total, duration) => total + duration, 0) / completed.length)
})

useIntervalFn(() => {
  store.refreshFromStorage()
}, 1_000, { immediate: true })

watch(orderedRequests, (next) => {
  if (!next.some(request => request.id === selectedRequestId.value))
    selectedRequestId.value = next[0]?.id ?? ''
}, { immediate: true })

function purposeLabel(purpose: LumiConsciousnessRequestPurpose) {
  return {
    planner: 'Planner 决策',
    replyer: 'Replyer 回复',
    replyer_retry: 'Replyer 重试',
    expression_selector: '表达选择',
    learning: '语言学习',
    feedback: '反馈理解',
    sticker_classifier: '表情理解',
    sticker_selector: '表情选择',
    context_summary: '上下文压缩',
    relationship_assessment: '关系评估',
    current_state: '当前状态更新',
    profile_curator: '用户印象整理',
    profile_review: '用户印象复核',
    memory_curator: '长期记忆整理',
    memory_topic: '记忆主题分析',
    other: '其他意识请求',
  }[purpose]
}

function statusLabel(status: LumiConsciousnessRequestTrace['status']) {
  return {
    streaming: '生成中',
    completed: '已完成',
    error: '失败',
  }[status]
}

function formatDuration(duration?: number) {
  if (duration === undefined)
    return '等待中'
  return duration >= 1_000 ? `${(duration / 1_000).toFixed(2)} s` : `${duration} ms`
}

function outputSpeed(request: LumiConsciousnessRequestTrace) {
  if (!request.durationMs || !request.estimatedOutputTokens)
    return '暂无'
  const generationMs = Math.max(1, request.durationMs - (request.firstTokenLatencyMs ?? 0))
  return `${(request.estimatedOutputTokens / (generationMs / 1_000)).toFixed(1)} token/s`
}

function cacheHitRate(request: LumiConsciousnessRequestTrace) {
  const hit = request.promptCacheHitTokens ?? 0
  const miss = request.promptCacheMissTokens ?? 0
  const total = hit + miss
  return total > 0 ? `${(hit / total * 100).toFixed(1)}%` : '未报告'
}

function cacheAccountingLabel(request: LumiConsciousnessRequestTrace) {
  if (request.cacheAccounting === 'measured')
    return `V4 实测 · ${request.cacheUsageSamples ?? 0} 段`
  if (request.cacheAccounting === 'inconsistent')
    return 'V4 数据不一致'
  return request.usageSamples ? '服务商未返回缓存字段' : '等待 usage'
}

function prefixEvidence(request: LumiConsciousnessRequestTrace) {
  const evidence = request.prefixDiagnostics
  if (!evidence)
    return '暂无可比较请求'
  return `${evidence.estimatedCommonPrefixTokens.toLocaleString()} tokens · ${(evidence.estimatedReusableRatio * 100).toFixed(1)}%`
}

function prefixComparedStage(request: LumiConsciousnessRequestTrace) {
  const evidence = request.prefixDiagnostics
  if (!evidence)
    return '冷启动'
  return `${purposeLabel(evidence.comparedPurpose)} · 第 ${evidence.firstDivergenceMessageIndex + 1} 条消息起变化`
}

function requestOption(request: LumiConsciousnessRequestTrace) {
  const time = new Date(request.startedAt).toLocaleTimeString()
  return `${time} · ${purposeLabel(request.purpose)} · ${statusLabel(request.status)} · ${formatDuration(request.durationMs)}`
}

function emptyResponseLabel(request: LumiConsciousnessRequestTrace) {
  if (request.status === 'streaming')
    return '等待模型返回内容…'
  if (request.status === 'error')
    return '请求失败，没有可显示的模型输出。'
  if (request.purpose === 'planner')
    return 'Planner 已完成，但本次没有返回普通文本或工具调用。'
  return '请求已完成，但模型返回内容为空。'
}

async function copyCurrent() {
  if (!selectedRequest.value)
    return
  const value = detailTab.value === 'response'
    ? selectedRequest.value.responseText
    : JSON.stringify(selectedRequest.value.requestMessages ?? [], null, 2)
  await navigator.clipboard.writeText(value)
  copied.value = true
  window.setTimeout(() => {
    copied.value = false
  }, 1_500)
}

function clearRequests() {
  selectedRequestId.value = ''
  store.clear()
}
</script>

<template>
  <section :class="['flex flex-col gap-5']">
    <div :class="['grid gap-3 sm:grid-cols-3']">
      <div :class="['border-y border-neutral-200 py-3 dark:border-neutral-800']">
        <div :class="['text-xs text-neutral-500']">
          已记录请求
        </div>
        <div :class="['mt-1 text-xl font-semibold tabular-nums']">
          {{ requests.length }}
        </div>
      </div>
      <div :class="['border-y border-neutral-200 py-3 dark:border-neutral-800']">
        <div :class="['text-xs text-neutral-500']">
          正在生成
        </div>
        <div :class="['mt-1 text-xl font-semibold tabular-nums']">
          {{ activeCount }}
        </div>
      </div>
      <div :class="['border-y border-neutral-200 py-3 dark:border-neutral-800']">
        <div :class="['text-xs text-neutral-500']">
          平均总耗时
        </div>
        <div :class="['mt-1 text-xl font-semibold tabular-nums']">
          {{ formatDuration(averageDuration) }}
        </div>
      </div>
    </div>

    <div :class="['border-l-3 border-cyan-500 bg-cyan-500/8 px-4 py-3 text-sm text-cyan-800 dark:text-cyan-200']">
      只有出现“上下文压缩”请求才代表本轮真的调用了摘要模型。当前记录中共触发 {{ contextSummaryCount }} 次。
    </div>

    <div v-if="!orderedRequests.length" :class="['py-12 text-center text-sm text-neutral-500']">
      开启 Prompt 记录并与 Lumi 聊天后，这里会实时显示每一次意识请求。
    </div>

    <template v-else>
      <div :class="['flex items-end gap-3']">
        <label :class="['min-w-0 flex-1']">
          <span :class="['mb-2 block text-xs font-medium text-neutral-500']">选择请求</span>
          <select
            v-model="selectedRequestId"
            :class="['h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm outline-none dark:border-neutral-800 dark:bg-neutral-900']"
          >
            <option v-for="option in requestOptions" :key="option.id" :value="option.id">
              {{ option.label }}
            </option>
          </select>
        </label>
        <DoubleCheckButton size="sm" variant="danger" @confirm="clearRequests">
          清空
          <template #confirm>
            确认清空
          </template>
          <template #cancel>
            取消
          </template>
        </DoubleCheckButton>
      </div>

      <template v-if="selectedRequest">
        <div :class="['grid grid-cols-2 gap-x-5 gap-y-3 border-y border-neutral-200 py-4 text-sm md:grid-cols-4 dark:border-neutral-800']">
          <div>
            <div :class="['text-xs text-neutral-500']">
              请求阶段
            </div>
            <div :class="['mt-1 font-medium']">
              {{ purposeLabel(selectedRequest.purpose) }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              首 Token 延迟
            </div>
            <div :class="['mt-1 font-medium tabular-nums']">
              {{ formatDuration(selectedRequest.firstTokenLatencyMs) }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              总耗时
            </div>
            <div :class="['mt-1 font-medium tabular-nums']">
              {{ formatDuration(selectedRequest.durationMs) }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              实际生成速度
            </div>
            <div :class="['mt-1 font-medium tabular-nums']">
              {{ outputSpeed(selectedRequest) }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              模型
            </div>
            <div :class="['mt-1 break-all font-medium']">
              {{ selectedRequest.model }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              可用工具
            </div>
            <div :class="['mt-1 font-medium tabular-nums']">
              {{ selectedRequest.toolCount ?? 0 }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              请求工具策略
            </div>
            <div :class="['mt-1 font-medium']">
              {{ selectedRequest.requestedToolChoice ?? '未设置' }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              实际发送策略
            </div>
            <div :class="['mt-1 font-medium']">
              {{ selectedRequest.effectiveToolChoice ?? '未设置' }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              思考模式
            </div>
            <div :class="['mt-1 font-medium']">
              {{ selectedRequest.thinkingMode ?? '供应商默认' }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              输入估算
            </div>
            <div :class="['mt-1 font-medium tabular-nums']">
              {{ selectedRequest.estimatedInputTokens.toLocaleString() }} tokens
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              实际输入
            </div>
            <div :class="['mt-1 font-medium tabular-nums']">
              {{ selectedRequest.actualInputTokens?.toLocaleString() ?? '未报告' }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              缓存命中
            </div>
            <div :class="['mt-1 font-medium tabular-nums text-emerald-600 dark:text-emerald-300']">
              {{ selectedRequest.promptCacheHitTokens?.toLocaleString() ?? '未报告' }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              缓存未命中
            </div>
            <div :class="['mt-1 font-medium tabular-nums text-amber-600 dark:text-amber-300']">
              {{ selectedRequest.promptCacheMissTokens?.toLocaleString() ?? '未报告' }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              本次命中率
            </div>
            <div :class="['mt-1 font-medium tabular-nums']">
              {{ cacheHitRate(selectedRequest) }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              缓存统计来源
            </div>
            <div :class="['mt-1 font-medium']">
              {{ cacheAccountingLabel(selectedRequest) }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              消息公共前缀估算
            </div>
            <div :class="['mt-1 font-medium tabular-nums']">
              {{ prefixEvidence(selectedRequest) }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              最佳前缀候选
            </div>
            <div :class="['mt-1 font-medium']">
              {{ prefixComparedStage(selectedRequest) }}
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              输出估算
            </div>
            <div :class="['mt-1 font-medium tabular-nums']">
              {{ selectedRequest.estimatedOutputTokens.toLocaleString() }} tokens
            </div>
          </div>
          <div>
            <div :class="['text-xs text-neutral-500']">
              流式片段
            </div>
            <div :class="['mt-1 font-medium tabular-nums']">
              {{ selectedRequest.chunkCount }}
            </div>
          </div>
        </div>

        <div
          v-if="selectedRequest.status === 'streaming'"
          :class="['flex items-center gap-2 text-sm text-cyan-600 dark:text-cyan-300']"
        >
          <span class="i-svg-spinners:3-dots-fade" />
          意识模型正在流式生成
        </div>
        <div
          v-else-if="selectedRequest.error"
          :class="['border-l-3 border-red-500 bg-red-500/8 px-4 py-3 text-sm text-red-700 dark:text-red-300']"
        >
          {{ selectedRequest.error }}
        </div>

        <div :class="['flex flex-wrap items-center justify-between gap-3']">
          <SelectTab
            v-model="detailTab"
            :options="[
              { label: '流式响应', value: 'response', icon: 'i-solar:play-stream-bold-duotone' },
              { label: '实际输入', value: 'request', icon: 'i-solar:code-square-bold-duotone' },
            ]"
            size="sm"
            tab-space="compact"
          />
          <Button
            size="sm"
            variant="secondary"
            :icon="copied ? 'i-solar:check-circle-bold-duotone' : 'i-solar:copy-bold-duotone'"
            @click="copyCurrent"
          >
            {{ copied ? '已复制' : '复制' }}
          </Button>
        </div>

        <pre
          v-if="detailTab === 'response'"
          :class="['min-h-32 max-h-[560px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-200 p-4 text-xs leading-5 font-mono dark:border-neutral-800']"
        >{{ selectedRequest.responseText || emptyResponseLabel(selectedRequest) }}</pre>
        <div v-else :class="['flex flex-col gap-3']">
          <div
            v-if="!selectedRequest.requestMessages"
            :class="['py-10 text-center text-sm text-neutral-500']"
          >
            此请求较早，完整 Prompt 已按存储上限清理，但耗时和 Token 统计仍然保留。
          </div>
          <article
            v-for="message in selectedRequest.requestMessages ?? []"
            :key="message.id"
            :class="['overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800']"
          >
            <div :class="['bg-neutral-100/70 px-3 py-2 text-xs font-semibold uppercase dark:bg-neutral-900']">
              {{ message.role }}
            </div>
            <pre :class="['max-h-80 overflow-auto whitespace-pre-wrap break-words p-4 text-xs leading-5 font-mono']">{{ message.content }}</pre>
          </article>
        </div>
      </template>
    </template>
  </section>
</template>
