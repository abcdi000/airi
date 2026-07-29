<script setup lang="ts">
import { useLumiMainTimelineStore } from '@proj-airi/stage-ui/stores/lumi-main-timeline'
import { Button, FieldInput } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { computed, shallowRef } from 'vue'

const store = useLumiMainTimelineStore()
const {
  conversationSummaries,
  maxContextTokens,
  outputReserveTokens,
  promptReserveTokens,
} = storeToRefs(store)

const summaries = computed(() =>
  Object.values(conversationSummaries.value).sort((left, right) => right.updatedAt - left.updatedAt),
)
const visibleSummaryCount = shallowRef(20)
const summaryBatchSize = 20
const visibleSummaries = computed(() => summaries.value.slice(0, visibleSummaryCount.value))
const hasMoreSummaries = computed(() => visibleSummaries.value.length < summaries.value.length)

function loadMoreSummaries(event: Event) {
  const target = event.currentTarget as HTMLElement
  const reachedEnd = target.scrollTop + target.clientHeight >= target.scrollHeight - 120
  if (reachedEnd && hasMoreSummaries.value)
    visibleSummaryCount.value += summaryBatchSize
}
const contextWindow = computed({
  get: () => maxContextTokens.value,
  set: value => maxContextTokens.value = Number(value),
})
const outputReserve = computed({
  get: () => outputReserveTokens.value,
  set: value => outputReserveTokens.value = Number(value),
})
const promptReserve = computed({
  get: () => promptReserveTokens.value,
  set: value => promptReserveTokens.value = Number(value),
})

function clearAllSummaries() {
  for (const conversationId of Object.keys(conversationSummaries.value))
    store.clearSummary(conversationId)
}
</script>

<template>
  <div :class="['flex flex-col gap-8']">
    <section :class="['grid gap-5 border-b border-neutral-200 pb-8 md:grid-cols-3 dark:border-neutral-800']">
      <div :class="['md:col-span-3']">
        <h2 :class="['text-lg font-semibold']">
          上下文连续性
        </h2>
        <p :class="['mt-1 max-w-3xl text-sm text-neutral-500']">
          Lumi 按 Token 预算保留完整近况。接近窗口上限时，意识模型会把较早对话压缩为滚动摘要，原始聊天记录不会被删除。
        </p>
      </div>
      <FieldInput
        v-model="contextWindow"
        type="number"
        label="模型上下文窗口"
        description="DeepSeek V4 支持 1,000,000 Token。其他模型请填写其真实上限。"
        :min="32000"
        :max="1000000"
      />
      <FieldInput
        v-model="outputReserve"
        type="number"
        label="输出与推理预留"
        description="为本轮推理和最终回复预留的空间。"
        :min="1024"
        :max="384000"
      />
      <FieldInput
        v-model="promptReserve"
        type="number"
        label="人格、记忆与工具预留"
        description="为系统提示、记忆检索和工具定义预留的空间。"
        :min="1024"
        :max="200000"
      />
    </section>

    <section :class="['flex flex-col gap-4']">
      <div :class="['flex flex-wrap items-start justify-between gap-3']">
        <div>
          <h2 :class="['text-lg font-semibold']">
            滚动摘要
          </h2>
          <p :class="['mt-1 text-sm text-neutral-500']">
            只在会话接近预算时生成。每个私聊或群聊分别保存，不跨会话混用。
          </p>
        </div>
        <Button
          v-if="summaries.length"
          size="sm"
          variant="secondary"
          icon="i-solar:trash-bin-trash-bold-duotone"
          @click="clearAllSummaries"
        >
          清除全部摘要
        </Button>
      </div>

      <div
        v-if="summaries.length"
        :class="[
          'max-h-[70dvh]',
          'overflow-y-auto',
          'overscroll-contain',
          'divide-y divide-neutral-200 border-y border-neutral-200',
          'pr-2 [scrollbar-gutter:stable]',
          'dark:divide-neutral-800 dark:border-neutral-800',
        ]"
        @scroll="loadMoreSummaries"
      >
        <article
          v-for="summary in visibleSummaries"
          :key="summary.conversationId"
          :class="['flex flex-col gap-3 py-5']"
        >
          <div :class="['flex flex-wrap items-start justify-between gap-3']">
            <div :class="['min-w-0']">
              <div :class="['truncate font-medium']">
                {{ summary.conversationId }}
              </div>
              <div :class="['mt-1 text-xs text-neutral-500']">
                已覆盖 {{ summary.sourceMessageCount }} 条消息 · 约 {{ summary.estimatedSourceTokens.toLocaleString() }} Token · {{ new Date(summary.updatedAt).toLocaleString() }}
              </div>
            </div>
            <Button
              size="sm"
              variant="secondary"
              shape="square"
              icon="i-solar:trash-bin-trash-bold-duotone"
              title="清除该会话摘要"
              @click="store.clearSummary(summary.conversationId)"
            />
          </div>
          <pre :class="['max-h-52 overflow-auto whitespace-pre-wrap text-sm leading-6 text-neutral-600 dark:text-neutral-300']">{{ summary.summary }}</pre>
        </article>
        <div :class="['py-3 text-center text-xs tabular-nums text-neutral-500']">
          {{ visibleSummaries.length }} / {{ summaries.length }}
        </div>
      </div>
      <div v-else :class="['border-y border-neutral-200 py-12 text-center text-sm text-neutral-500 dark:border-neutral-800']">
        暂无摘要。当前会话尚未接近上下文预算。
      </div>
    </section>
  </div>
</template>
