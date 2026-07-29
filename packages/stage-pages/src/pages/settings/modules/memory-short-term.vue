<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useLumiCurrentStateStore } from '@proj-airi/stage-ui/stores/lumi-current-state'
import { LUMI_PROMPT_HISTORY_MAX, LUMI_PROMPT_HISTORY_MIN, useLumiMainTimelineStore } from '@proj-airi/stage-ui/stores/lumi-main-timeline'
import { Button, FieldRange } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { shallowRef } from 'vue'

import WorkingMemoryProjection from '../../../components/workingMemoryProjection.vue'

const currentStateStore = useLumiCurrentStateStore()
const mainTimelineStore = useLumiMainTimelineStore()
const chatOrchestratorStore = useChatOrchestratorStore()
const {
  currentState,
  persistenceDbPath,
  persistenceLastError,
} = storeToRefs(currentStateStore)
const { maxRecentChatMessagesForPrompt, normalizedMaxRecentChatMessagesForPrompt } = storeToRefs(mainTimelineStore)

const statusText = shallowRef('')
const busy = shallowRef(false)

async function refreshProjection() {
  busy.value = true
  try {
    const result = await chatOrchestratorStore.refreshLumiCurrentStateNow()
    statusText.value = result?.status === 'refreshed'
      ? '已从认知宿主重新读取当前会话的 Working Memory 投影。'
      : `未刷新：${result?.status ?? 'unknown'}`
  }
  catch (error) {
    statusText.value = `刷新失败：${errorMessageFrom(error) ?? '未知错误'}`
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div :class="['mx-auto max-w-5xl flex flex-col gap-6 px-4 pb-12']">
    <header :class="['flex flex-wrap items-start justify-between gap-4 border-b border-neutral-200 pb-5 dark:border-neutral-800']">
      <div :class="['min-w-0']">
        <div :class="['text-sm text-neutral-500']">
          Lumi Cognitive Runtime
        </div>
        <h2 :class="['mt-1 text-2xl font-semibold']">
          Working Memory 投影
        </h2>
        <p :class="['mt-2 max-w-3xl text-sm leading-6 text-neutral-500']">
          这里显示当前人物与当前私聊会话的只读工作记忆。内容由统一认知宿主维护，不再通过独立模型定时重写，也不能在此直接编辑。
        </p>
      </div>
      <Button
        variant="secondary"
        icon="i-solar:refresh-line-duotone"
        label="重新读取"
        :loading="busy"
        :disabled="busy"
        @click="refreshProjection"
      />
    </header>

    <div
      v-if="statusText"
      :class="['border-l-2 border-primary-500 bg-primary-500/8 px-3 py-2 text-sm text-primary-700 dark:text-primary-200']"
    >
      {{ statusText }}
    </div>

    <WorkingMemoryProjection :state="currentState" />

    <section :class="['grid gap-6 border-b border-neutral-200 pb-6 md:grid-cols-[minmax(0,1fr)_minmax(16rem,0.7fr)] dark:border-neutral-800']">
      <FieldRange
        v-model="maxRecentChatMessagesForPrompt"
        label="Prompt 最近消息数"
        description="控制进入对话上下文的近期原始消息窗口；Working Memory 与长期召回由认知宿主单独组装。"
        :min="LUMI_PROMPT_HISTORY_MIN"
        :max="LUMI_PROMPT_HISTORY_MAX"
        :step="1"
        :format-value="() => `${normalizedMaxRecentChatMessagesForPrompt} 条`"
      />

      <div :class="['min-w-0 border-l-2 border-neutral-200 pl-4 dark:border-neutral-800']">
        <div :class="['text-sm font-medium']">
          旧 current_state 迁移归档
        </div>
        <div :class="['mt-2 break-all text-xs leading-5 text-neutral-500']">
          {{ persistenceDbPath || '当前运行环境未提供旧数据库路径' }}
        </div>
        <div :class="['mt-2 text-xs leading-5 text-neutral-500']">
          旧数据库仅用于兼容迁移和备份，不再是当前工作记忆的写入来源。
        </div>
      </div>
    </section>

    <div
      v-if="persistenceLastError"
      :class="['border-l-2 border-red-500 bg-red-500/8 px-3 py-2 text-sm text-red-600']"
    >
      旧归档读取异常：{{ persistenceLastError }}
    </div>
  </div>
</template>
