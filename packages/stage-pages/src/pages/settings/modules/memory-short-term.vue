<script setup lang="ts">
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useLumiCurrentStateStore } from '@proj-airi/stage-ui/stores/lumi-current-state'
import { LUMI_PROMPT_HISTORY_MAX, LUMI_PROMPT_HISTORY_MIN, useLumiMainTimelineStore } from '@proj-airi/stage-ui/stores/lumi-main-timeline'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'

const currentStateStore = useLumiCurrentStateStore()
const mainTimelineStore = useLumiMainTimelineStore()
const chatOrchestratorStore = useChatOrchestratorStore()
const {
  currentState,
  updateEveryTurns,
  normalizedUpdateEveryTurns,
  persistenceDbPath,
  persistenceLastError,
} = storeToRefs(currentStateStore)
const { maxRecentChatMessagesForPrompt, normalizedMaxRecentChatMessagesForPrompt } = storeToRefs(mainTimelineStore)

const editingJson = ref('')
const statusText = ref('')
const busy = ref(false)

void currentStateStore.initializePersistence()

watch(currentState, () => {
  editingJson.value = JSON.stringify(currentState.value, null, 2)
}, { immediate: true, deep: true })

const exportedJson = computed(() => JSON.stringify(currentStateStore.exportSnapshot(), null, 2))

async function saveEditedState() {
  try {
    busy.value = true
    const parsed = JSON.parse(editingJson.value)
    await currentStateStore.saveCurrentState(parsed)
    statusText.value = '短期意识状态已保存。'
  }
  catch (error) {
    statusText.value = `保存失败：${error instanceof Error ? error.message : String(error)}`
  }
  finally {
    busy.value = false
  }
}

async function clearState() {
  busy.value = true
  try {
    await currentStateStore.clearCurrentState()
    statusText.value = '短期意识状态已清空。'
  }
  finally {
    busy.value = false
  }
}

async function refreshState() {
  busy.value = true
  try {
    const result = await chatOrchestratorStore.refreshLumiCurrentStateNow()
    statusText.value = result?.status === 'updated'
      ? '已调用意识模型刷新短期意识状态。'
      : `刷新结束：${result?.status ?? 'unknown'}`
  }
  catch (error) {
    statusText.value = `刷新失败：${error instanceof Error ? error.message : String(error)}`
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-4xl flex flex-col gap-5 px-4 pb-12">
    <section class="rounded-lg bg-neutral-100/70 p-4 dark:bg-neutral-900/70">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="text-sm text-neutral-500">
            Lumi current_state
          </div>
          <h2 class="text-2xl font-semibold">
            短期意识状态
          </h2>
        </div>
        <div class="flex flex-wrap gap-2">
          <button class="rounded-md bg-primary-500 px-3 py-2 text-sm text-white disabled:opacity-50" :disabled="busy" @click="refreshState">
            手动刷新
          </button>
          <button class="rounded-md bg-neutral-200 px-3 py-2 text-sm dark:bg-neutral-800 disabled:opacity-50" :disabled="busy" @click="saveEditedState">
            保存编辑
          </button>
          <button class="rounded-md bg-red-500/15 px-3 py-2 text-sm text-red-600 disabled:opacity-50" :disabled="busy" @click="clearState">
            清空
          </button>
        </div>
      </div>
      <div class="mt-4 grid gap-3 md:grid-cols-4">
        <label class="flex flex-col gap-2 rounded-md bg-white/60 p-3 dark:bg-black/20">
          <span class="text-sm text-neutral-500">每几轮自动更新</span>
          <input v-model.number="updateEveryTurns" min="1" max="20" type="number" class="rounded-md border border-neutral-300 bg-transparent px-3 py-2 outline-none dark:border-neutral-700">
          <span class="text-xs text-neutral-500">当前生效：{{ normalizedUpdateEveryTurns }} 轮</span>
        </label>
        <label class="flex flex-col gap-2 rounded-md bg-white/60 p-3 dark:bg-black/20">
          <span class="text-sm text-neutral-500">Prompt 最近消息数</span>
          <input v-model.number="maxRecentChatMessagesForPrompt" :min="LUMI_PROMPT_HISTORY_MIN" :max="LUMI_PROMPT_HISTORY_MAX" type="number" class="rounded-md border border-neutral-300 bg-transparent px-3 py-2 outline-none dark:border-neutral-700">
          <span class="text-xs text-neutral-500">当前生效：{{ normalizedMaxRecentChatMessagesForPrompt }} 条</span>
        </label>
        <div class="rounded-md bg-white/60 p-3 dark:bg-black/20">
          <div class="text-sm text-neutral-500">
            SQLite
          </div>
          <div class="mt-2 break-all text-xs">
            {{ persistenceDbPath || '尚未连接数据库' }}
          </div>
        </div>
        <div class="rounded-md bg-white/60 p-3 dark:bg-black/20">
          <div class="text-sm text-neutral-500">
            最近更新时间
          </div>
          <div class="mt-2 text-sm">
            {{ currentState.updatedAt || '暂无' }}
          </div>
        </div>
      </div>
      <div v-if="statusText" class="mt-3 rounded-md bg-primary-500/10 px-3 py-2 text-sm text-primary-700 dark:text-primary-200">
        {{ statusText }}
      </div>
      <div v-if="persistenceLastError" class="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">
        {{ persistenceLastError }}
      </div>
    </section>

    <section class="grid gap-4 lg:grid-cols-2">
      <div class="rounded-lg bg-neutral-100/70 p-4 dark:bg-neutral-900/70">
        <h3 class="mb-3 text-lg font-semibold">
          查看与编辑
        </h3>
        <textarea v-model="editingJson" class="min-h-[520px] w-full resize-y rounded-md border border-neutral-300 bg-white/70 p-3 font-mono text-sm outline-none dark:border-neutral-700 dark:bg-black/30" spellcheck="false" />
      </div>
      <div class="rounded-lg bg-neutral-100/70 p-4 dark:bg-neutral-900/70">
        <h3 class="mb-3 text-lg font-semibold">
          导出预览
        </h3>
        <pre class="max-h-[520px] overflow-auto rounded-md bg-white/70 p-3 text-xs dark:bg-black/30">{{ exportedJson }}</pre>
      </div>
    </section>
  </div>
</template>
