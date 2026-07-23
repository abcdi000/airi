<script setup lang="ts">
import type { Component } from 'vue'

import type { ManagerPageId } from './types'

import { Callout } from '@proj-airi/ui'
import { computed, shallowRef } from 'vue'

import ConsciousnessPage from './pages/ConsciousnessPage.vue'
import DataPage from './pages/DataPage.vue'
import LogsPage from './pages/LogsPage.vue'
import McpPage from './pages/McpPage.vue'
import MemoryPage from './pages/MemoryPage.vue'
import ModulesPage from './pages/ModulesPage.vue'
import NetworkPage from './pages/NetworkPage.vue'
import OverviewPage from './pages/OverviewPage.vue'
import PluginsPage from './pages/PluginsPage.vue'
import TranscriptionPage from './pages/TranscriptionPage.vue'
import UsersPage from './pages/UsersPage.vue'

import { provideServerManager } from './useServerManager'

interface NavItem { id: ManagerPageId, label: string, icon: string, group: string }

const manager = provideServerManager()
const activePage = shallowRef<ManagerPageId>('overview')
const navigation: NavItem[] = [
  { id: 'overview', label: '总览', icon: 'i-solar:home-2-bold-duotone', group: 'SERVER' },
  { id: 'users', label: '用户与邀请', icon: 'i-solar:users-group-rounded-bold-duotone', group: 'SERVER' },
  { id: 'modules', label: '机体模块', icon: 'i-solar:widget-5-bold-duotone', group: 'LUMI' },
  { id: 'mcp', label: 'MCP 服务', icon: 'i-solar:widget-5-bold-duotone', group: 'TOOLS' },
  { id: 'plugins', label: '插件', icon: 'i-solar:plug-circle-bold-duotone', group: 'TOOLS' },
  { id: 'memory', label: '记忆与向量', icon: 'i-solar:database-bold-duotone', group: 'DATA' },
  { id: 'network', label: '网络与安全', icon: 'i-solar:shield-network-bold-duotone', group: 'DATA' },
  { id: 'data', label: '备份与迁移', icon: 'i-solar:archive-bold-duotone', group: 'DATA' },
  { id: 'logs', label: '日志与任务', icon: 'i-solar:document-text-bold-duotone', group: 'DATA' },
]
const pages: Record<ManagerPageId, Component> = {
  overview: OverviewPage,
  users: UsersPage,
  modules: ModulesPage,
  consciousness: ConsciousnessPage,
  transcription: TranscriptionPage,
  mcp: McpPage,
  plugins: PluginsPage,
  memory: MemoryPage,
  network: NetworkPage,
  data: DataPage,
  logs: LogsPage,
}
const groupedNavigation = computed(() => [...new Set(navigation.map(item => item.group))].map(group => ({ group, items: navigation.filter(item => item.group === group) })))
const processLabel = computed(() => ({ stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', error: '错误' })[manager.state.value?.processState ?? 'stopped'])

function selectPage(page: ManagerPageId) {
  if (activePage.value === page)
    return
  manager.clearNotices()
  activePage.value = page
}
</script>

<template>
  <div :class="['manager-shell grid min-h-screen grid-cols-[232px_minmax(0,1fr)] bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100']">
    <aside :class="['sticky top-0 h-screen overflow-y-auto border-r border-neutral-200 bg-neutral-50/80 px-3 py-5 dark:border-neutral-800 dark:bg-neutral-950']">
      <div :class="['mb-7 flex items-center gap-3 px-3']">
        <div :class="['grid size-9 place-items-center rounded-md bg-cyan-600 text-white shadow-sm']">
          <span :class="['i-solar:server-square-cloud-bold-duotone size-5']" />
        </div>
        <div>
          <div :class="['text-sm font-semibold']">
            Lumi Server
          </div>
          <div :class="['flex items-center gap-1.5 text-xs text-neutral-500']">
            <span :class="['size-1.5 rounded-full', manager.running.value ? 'bg-emerald-500' : 'bg-neutral-400']" />
            {{ processLabel }}
          </div>
        </div>
      </div>

      <nav v-for="group in groupedNavigation" :key="group.group" :class="['mb-5']">
        <div :class="['mb-1 px-3 text-[10px] font-semibold text-neutral-400']">
          {{ group.group }}
        </div>
        <button
          v-for="item in group.items"
          :key="item.id"
          type="button"
          :class="['relative mb-0.5 flex h-10 w-full items-center gap-3 overflow-hidden rounded-md px-3 text-left text-sm transition-colors duration-200', activePage === item.id ? 'text-cyan-800 dark:text-cyan-200' : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-white']"
          @click="selectPage(item.id)"
        >
          <span v-if="activePage === item.id" :class="['absolute inset-0 border border-cyan-200 bg-cyan-50 transition-all duration-200 dark:border-cyan-900 dark:bg-cyan-950/40']" />
          <span :class="[item.icon, 'relative size-4 shrink-0']" />
          <span :class="['relative']">{{ item.label }}</span>
        </button>
      </nav>
    </aside>

    <main :class="['min-w-0 overflow-hidden']">
      <div :class="['sticky top-0 z-20 flex h-12 items-center justify-end gap-3 border-b border-neutral-200 bg-white/90 px-7 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90']">
        <span :class="['text-xs text-neutral-500']">{{ manager.state.value?.configPath }}</span>
        <button type="button" title="刷新" :class="['grid size-8 place-items-center rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-900']" @click="manager.refresh">
          <span :class="['i-solar:refresh-bold size-4', manager.busy.value && 'animate-spin']" />
        </button>
      </div>
      <div :class="['mx-auto max-w-6xl p-7']">
        <Transition name="notice">
          <Callout v-if="manager.error.value || manager.state.value?.error" theme="orange" label="Server Manager 错误" :class="['mb-5']">
            {{ manager.error.value || manager.state.value?.error }}
          </Callout>
        </Transition>
        <Transition name="notice">
          <Callout v-if="manager.success.value" theme="lime" label="操作完成" :class="['mb-5']">
            {{ manager.success.value }}
          </Callout>
        </Transition>
        <Transition name="manager-page" mode="out-in">
          <component :is="pages[activePage]" :key="activePage" @navigate="selectPage" />
        </Transition>
      </div>
    </main>
  </div>
</template>

<style scoped>
.manager-page-enter-active,
.manager-page-leave-active,
.notice-enter-active,
.notice-leave-active { transition: opacity 180ms ease, transform 220ms cubic-bezier(.22, 1, .36, 1); }
.manager-page-enter-from { opacity: 0; transform: translateY(10px) scale(.992); }
.manager-page-leave-to { opacity: 0; transform: translateY(-5px) scale(.996); }
.notice-enter-from,
.notice-leave-to { opacity: 0; transform: translateY(-6px); }
@media (prefers-reduced-motion: reduce) {
  .manager-page-enter-active,
  .manager-page-leave-active,
  .notice-enter-active,
  .notice-leave-active { transition-duration: 1ms; }
}
</style>
