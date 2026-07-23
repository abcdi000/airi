<script setup lang="ts">
import ManagerPage from '../components/ManagerPage.vue'

import { useServerManager } from '../useServerManager'

const manager = useServerManager()
</script>

<template>
  <ManagerPage title="日志与任务" description="查看 Server 生命周期日志与后台任务概况，不展示任何用户私聊正文。" icon="i-solar:document-text-bold-duotone">
    <div :class="['grid grid-cols-[minmax(0,1fr)_240px] gap-6']">
      <pre :class="['min-h-96 overflow-auto rounded-md bg-neutral-950 p-4 font-mono text-xs leading-6 text-neutral-200']">{{ manager.state.value?.logs.join('\n') || '等待 Server 输出…' }}</pre><aside :class="['border-l border-neutral-200 pl-5 dark:border-neutral-800']">
        <h2 :class="['text-sm font-semibold']">
          任务状态
        </h2><dl :class="['mt-4 space-y-3 text-sm']">
          <div v-for="(value, key) in manager.overview.value?.jobs" :key="key" :class="['flex justify-between border-b border-neutral-200 pb-2 dark:border-neutral-800']">
            <dt>{{ key }}</dt><dd :class="['tabular-nums']">
              {{ value }}
            </dd>
          </div>
        </dl>
      </aside>
    </div>
  </ManagerPage>
</template>
