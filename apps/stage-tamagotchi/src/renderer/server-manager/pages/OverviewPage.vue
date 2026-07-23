<script setup lang="ts">
import { Button, FieldCheckbox } from '@proj-airi/ui'
import { computed } from 'vue'

import ManagerPage from '../components/ManagerPage.vue'

import { useServerManager } from '../useServerManager'

const manager = useServerManager()
const cards = computed(() => {
  const value = manager.overview.value
  if (!value)
    return []
  return [
    { label: '人物', value: value.people, detail: `${value.boundAccounts} 个账号已绑定`, icon: 'i-solar:users-group-rounded-bold-duotone', color: 'text-cyan-600' },
    { label: '会话', value: value.conversations.direct + value.conversations.group, detail: `${value.conversations.direct} 私聊 · ${value.conversations.group} 群聊`, icon: 'i-solar:chat-round-dots-bold-duotone', color: 'text-violet-600' },
    { label: '消息', value: value.messages, detail: '仅显示数量，不提供正文入口', icon: 'i-solar:dialog-2-bold-duotone', color: 'text-blue-600' },
    { label: '活跃记忆', value: value.memories.active, detail: `${value.memories.candidate} 条待审阅`, icon: 'i-solar:database-bold-duotone', color: 'text-emerald-600' },
    { label: '日记与笔记', value: value.diaryEntries + value.privateNotes, detail: `${value.diaryEntries} 日记 · ${value.privateNotes} 私人笔记`, icon: 'i-solar:notebook-bold-duotone', color: 'text-orange-600' },
    { label: '后台任务', value: value.jobs.pending + value.jobs.running, detail: `${value.jobs.failed} 个失败任务`, icon: 'i-solar:clock-circle-bold-duotone', color: 'text-rose-600' },
  ]
})
</script>

<template>
  <ManagerPage title="服务器总览" description="集中查看 Lumi Server 的运行状态、数据健康与后台工作。" icon="i-solar:server-square-cloud-bold-duotone">
    <template #actions>
      <Button :icon="manager.running.value ? 'i-solar:stop-bold-duotone' : 'i-solar:play-bold-duotone'" :label="manager.running.value ? '有序停服' : '启动 Server'" :loading="manager.busy.value" @click="manager.toggleServer" />
    </template>
    <div :class="['flex items-center gap-4 border-b border-neutral-200 pb-6 dark:border-neutral-800']">
      <div :class="['relative grid size-14 place-items-center rounded-md bg-neutral-100 dark:bg-neutral-900']">
        <span :class="['i-solar:server-minimalistic-bold-duotone size-7', manager.running.value ? 'text-emerald-600' : 'text-neutral-400']" />
        <span :class="['absolute right-1 top-1 size-2 rounded-full', manager.running.value ? 'bg-emerald-500' : 'bg-neutral-400']" />
      </div>
      <div>
        <div :class="['text-lg font-semibold']">
          {{ manager.running.value ? 'Lumi Server 正在运行' : 'Lumi Server 已停止' }}
        </div>
        <div :class="['text-sm text-neutral-500']">
          PID {{ manager.state.value?.pid ?? '—' }} · {{ manager.state.value?.config.publicBaseURL }}
        </div>
      </div>
    </div>
    <div v-if="cards.length" :class="['grid grid-cols-2 gap-x-8 gap-y-2 xl:grid-cols-3']">
      <div v-for="(card, index) in cards" :key="card.label" v-motion :initial="{ opacity: 0, y: 12 }" :enter="{ opacity: 1, y: 0, transition: { delay: index * 45 } }" :class="['flex items-center gap-4 border-b border-neutral-200 py-5 dark:border-neutral-800']">
        <span :class="[card.icon, card.color, 'size-6 shrink-0']" />
        <div>
          <div :class="['text-xs text-neutral-500']">
            {{ card.label }}
          </div><div :class="['text-2xl font-semibold tabular-nums']">
            {{ card.value }}
          </div><div :class="['text-xs text-neutral-500']">
            {{ card.detail }}
          </div>
        </div>
      </div>
    </div>
    <div v-else :class="['py-8 text-center text-sm text-neutral-500']">
      启动 Server 后显示实时统计。
    </div>
    <FieldCheckbox :model-value="manager.state.value?.autoStart ?? false" label="随 Windows 启动 Server Manager" @update:model-value="manager.setAutoStart(Boolean($event))" />
  </ManagerPage>
</template>
