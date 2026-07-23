<script setup lang="ts">
import type { ManagerPageId } from '../types'

import ManagerPage from '../components/ManagerPage.vue'

defineEmits<{
  navigate: [page: ManagerPageId]
}>()

const modules: Array<{
  id: string
  title: string
  description: string
  icon: string
  state: string
  target?: ManagerPageId
}> = [
  {
    id: 'consciousness',
    title: '意识',
    description: '回复生成、人格提示词与工具调用策略',
    icon: 'i-solar:ghost-bold-duotone',
    state: '服务器运行',
    target: 'consciousness',
  },
  {
    id: 'hearing',
    title: '听觉',
    description: '接收客户端音频并在服务器统一转写',
    icon: 'i-solar:microphone-3-bold-duotone',
    state: '服务器运行',
    target: 'transcription',
  },
  {
    id: 'vision',
    title: '视觉',
    description: '在线图片上传与服务器视觉推理尚未接入协议',
    icon: 'i-solar:eye-bold-duotone',
    state: '尚未接入',
  },
  {
    id: 'speech',
    title: '发声',
    description: '使用每台设备自己的 TTS、扬声器与音量配置',
    icon: 'i-solar:user-speak-rounded-bold-duotone',
    state: '客户端运行',
  },
  {
    id: 'appearance',
    title: '角色外观',
    description: 'Live2D、VRM、动作和渲染由客户端设备负责',
    icon: 'i-solar:palette-bold-duotone',
    state: '客户端运行',
  },
  {
    id: 'tools',
    title: '行动与工具',
    description: '在线 MCP、插件与 Agent 由唯一服务器执行',
    icon: 'i-solar:command-bold-duotone',
    state: '服务器运行',
    target: 'mcp',
  },
]
</script>

<template>
  <ManagerPage title="机体模块" description="查看在线 Lumi 各模块的运行位置，并进入服务器专属配置。" icon="i-solar:widget-5-bold-duotone">
    <div :class="['grid grid-cols-2 gap-3 xl:grid-cols-3']">
      <button
        v-for="(module, index) in modules"
        :key="module.id"
        v-motion
        :initial="{ opacity: 0, y: 8 }"
        :enter="{ opacity: 1, y: 0, transition: { delay: index * 45 } }"
        type="button"
        :disabled="!module.target"
        :class="[
          'flex min-h-32 flex-col justify-between rounded-md border p-4 text-left transition-colors',
          module.target
            ? 'border-neutral-200 hover:border-cyan-400 hover:bg-cyan-50/60 dark:border-neutral-800 dark:hover:border-cyan-800 dark:hover:bg-cyan-950/20'
            : 'cursor-default border-neutral-200 bg-neutral-50/60 dark:border-neutral-800 dark:bg-neutral-900/30',
        ]"
        @click="module.target && $emit('navigate', module.target)"
      >
        <span :class="['flex items-start justify-between gap-3']">
          <span :class="[module.icon, 'size-8 text-neutral-500']" />
          <span :class="['rounded px-2 py-1 text-xs', module.state === '服务器运行' ? 'bg-cyan-50 text-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-300' : module.state === '客户端运行' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800']">
            {{ module.state }}
          </span>
        </span>
        <span>
          <strong :class="['block text-base']">{{ module.title }}</strong>
          <span :class="['mt-1 block text-sm text-neutral-500 dark:text-neutral-400']">{{ module.description }}</span>
        </span>
      </button>
    </div>
  </ManagerPage>
</template>
