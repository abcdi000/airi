<script setup lang="ts">
import type { LumiCurrentState } from '@proj-airi/stage-ui/stores/lumi-current-state'

import { computed } from 'vue'

const props = defineProps<{
  state: LumiCurrentState
}>()

const projectionSections = computed(() => [
  {
    key: 'topics',
    title: '活跃话题',
    icon: 'i-solar:chat-round-dots-line-duotone',
    items: props.state.recentTopics,
  },
  {
    key: 'goals',
    title: '当前目标与决定',
    icon: 'i-solar:target-line-duotone',
    items: props.state.recentImportantDecisions,
  },
  {
    key: 'projects',
    title: '当前项目',
    icon: 'i-solar:folder-with-files-line-duotone',
    items: props.state.activeProjects,
  },
  {
    key: 'open-loops',
    title: '未完成事项',
    icon: 'i-solar:checklist-minimalistic-line-duotone',
    items: props.state.unfinishedTasks,
  },
  {
    key: 'temporary-state',
    title: '用户临时状态',
    icon: 'i-solar:heart-pulse-2-line-duotone',
    items: props.state.userRecentMood ? [props.state.userRecentMood] : [],
  },
  {
    key: 'relationship',
    title: '当前关系情境',
    icon: 'i-solar:users-group-rounded-line-duotone',
    items: props.state.relationshipContext ? [props.state.relationshipContext] : [],
  },
  {
    key: 'continuation',
    title: '续接点',
    icon: 'i-solar:forward-2-line-duotone',
    items: props.state.lastContinuationPoint ? [props.state.lastContinuationPoint] : [],
  },
])

const populatedSectionCount = computed(() => projectionSections.value.filter(section => section.items.length > 0).length)

function formatUpdatedAt(value: string) {
  if (!value)
    return '暂无投影'
  const date = new Date(value)
  if (Number.isNaN(date.getTime()))
    return value
  return date.toLocaleString()
}
</script>

<template>
  <section :class="['border-y border-neutral-200 dark:border-neutral-800']">
    <div :class="['grid gap-4 py-4 sm:grid-cols-3']">
      <div>
        <div :class="['text-xs text-neutral-500']">
          已填充区域
        </div>
        <div :class="['mt-1 text-lg font-semibold tabular-nums']">
          {{ populatedSectionCount }} / {{ projectionSections.length }}
        </div>
      </div>
      <div>
        <div :class="['text-xs text-neutral-500']">
          来源消息
        </div>
        <div :class="['mt-1 text-lg font-semibold tabular-nums']">
          {{ props.state.sourceMessageIds.length }}
        </div>
      </div>
      <div>
        <div :class="['text-xs text-neutral-500']">
          最近更新时间
        </div>
        <div :class="['mt-1 text-sm font-medium']">
          {{ formatUpdatedAt(props.state.updatedAt) }}
        </div>
      </div>
    </div>

    <div :class="['grid border-t border-neutral-200 md:grid-cols-2 dark:border-neutral-800']">
      <section
        v-for="section in projectionSections"
        :key="section.key"
        :class="['min-w-0 border-b border-neutral-200 py-4 md:odd:pr-5 md:even:border-l md:even:pl-5 dark:border-neutral-800']"
      >
        <div :class="['mb-2 flex items-center gap-2']">
          <div :class="[section.icon, 'size-4 text-primary-500']" />
          <h3 :class="['text-sm font-semibold']">
            {{ section.title }}
          </h3>
          <span :class="['text-xs text-neutral-500 tabular-nums']">
            {{ section.items.length }}
          </span>
        </div>
        <ul v-if="section.items.length" :class="['flex flex-col gap-2']">
          <li
            v-for="(item, index) in section.items"
            :key="`${section.key}:${index}:${item}`"
            :class="['break-words border-l-2 border-primary-400/50 pl-3 text-sm leading-6 text-neutral-700 dark:text-neutral-200']"
          >
            {{ item }}
          </li>
        </ul>
        <div v-else :class="['text-sm text-neutral-400']">
          暂无
        </div>
      </section>
    </div>

    <details v-if="props.state.sourceMessageIds.length" :class="['py-4']">
      <summary :class="['cursor-pointer text-sm font-medium text-neutral-600 dark:text-neutral-300']">
        查看来源消息 ID
      </summary>
      <div :class="['mt-3 flex flex-wrap gap-2']">
        <code
          v-for="messageId in props.state.sourceMessageIds"
          :key="messageId"
          :class="['max-w-full break-all bg-neutral-100 px-2 py-1 text-xs dark:bg-neutral-900']"
        >{{ messageId }}</code>
      </div>
    </details>
  </section>
</template>
