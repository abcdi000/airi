<script setup lang="ts">
import { Button, FieldInput } from '@proj-airi/ui'
import { computed, shallowRef } from 'vue'

import ManagerPage from '../components/ManagerPage.vue'

import { useServerManager } from '../useServerManager'

const manager = useServerManager()
const view = shallowRef<'internal' | 'external'>('internal')
const search = shallowRef('')

const builtInPlugins = computed(() => [
  { id: 'identity', name: '身份与隐私隔离', detail: '账号绑定、私聊权限与记忆作用域', icon: 'i-solar:shield-user-bold-duotone', enabled: true, locked: true },
  { id: 'memory', name: '长期记忆与向量', detail: '语义检索、记忆整理与后台补向量', icon: 'i-solar:database-bold-duotone', enabled: manager.state.value?.config.vector.enabled ?? false, locked: true },
  { id: 'diary', name: '每日私密日记', detail: '按服务器时间生成 Lumi 的每日回顾', icon: 'i-solar:notebook-bold-duotone', enabled: manager.configDraft.diaryEnabled, locked: false },
  { id: 'autonomous-life', name: '自主生活', detail: '无客户端在线时仍持续思考和安排任务', icon: 'i-solar:stars-minimalistic-bold-duotone', enabled: manager.configDraft.autonomousLifeEnabled, locked: false },
])
const filteredPlugins = computed(() => {
  const query = search.value.trim().toLowerCase()
  return query
    ? manager.plugins.value.filter(plugin => `${plugin.name} ${plugin.path}`.toLowerCase().includes(query))
    : manager.plugins.value
})
const loadedCount = computed(() => manager.pluginStatuses.value.filter(item => item.state === 'loaded').length)

function runtimeState(name: string) {
  return manager.pluginStatuses.value.find(item => item.name === name)
}

function selectView(next: typeof view.value) {
  manager.clearNotices()
  view.value = next
}
</script>

<template>
  <ManagerPage title="插件" description="管理服务器内置能力和具有 Server 入口的外部插件。" icon="i-solar:plug-circle-bold-duotone">
    <template #actions>
      <div :class="['flex gap-2']">
        <Button variant="secondary" label="添加插件" icon="i-solar:add-circle-bold-duotone" @click="manager.addPlugin" /><Button variant="secondary" label="重新加载" icon="i-solar:refresh-bold" :loading="manager.busy.value" @click="manager.reloadPlugins" />
      </div>
    </template>

    <div :class="['grid grid-cols-3 gap-3']">
      <div :class="['rounded-md border border-neutral-200 p-4 dark:border-neutral-800']">
        <div :class="['text-xs text-neutral-500']">
          内置模块
        </div><strong :class="['mt-1 block text-2xl']">{{ builtInPlugins.length }}</strong>
      </div>
      <div :class="['rounded-md border border-neutral-200 p-4 dark:border-neutral-800']">
        <div :class="['text-xs text-neutral-500']">
          外部插件
        </div><strong :class="['mt-1 block text-2xl']">{{ manager.plugins.value.length }}</strong>
      </div>
      <div :class="['rounded-md border border-neutral-200 p-4 dark:border-neutral-800']">
        <div :class="['text-xs text-neutral-500']">
          运行中
        </div><strong :class="['mt-1 block text-2xl text-emerald-600']">{{ loadedCount }}</strong>
      </div>
    </div>

    <div :class="['flex w-fit gap-1 rounded-md bg-neutral-100 p-1 dark:bg-neutral-900']">
      <button v-for="tab in [{ id: 'internal', label: '内置模块', icon: 'i-solar:widget-4-bold-duotone' }, { id: 'external', label: '外部插件', icon: 'i-solar:plug-circle-bold-duotone' }]" :key="tab.id" type="button" :class="['relative h-8 px-4 text-sm', view === tab.id ? 'text-cyan-800 dark:text-cyan-200' : 'text-neutral-500']" @click="selectView(tab.id as 'internal' | 'external')">
        <span v-if="view === tab.id" :class="['absolute inset-0 rounded bg-white shadow-sm dark:bg-neutral-800']" />
        <span :class="['relative flex items-center gap-2']"><span :class="[tab.icon, 'inline-block size-4']" />{{ tab.label }}</span>
      </button>
    </div>

    <Transition name="plugin-view" mode="out-in">
      <div :key="view">
        <div v-if="view === 'internal'" :class="['grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]']">
          <div :class="['divide-y divide-neutral-200 border-y border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800']">
            <div v-for="(plugin, index) in builtInPlugins" :key="plugin.id" v-motion :initial="{ opacity: 0, x: -8 }" :enter="{ opacity: 1, x: 0, transition: { delay: index * 50 } }" :class="['flex items-center gap-4 py-5']">
              <span :class="[plugin.icon, 'inline-block size-8 shrink-0 text-cyan-600']" />
              <div :class="['min-w-0 flex-1']">
                <div :class="['font-medium']">
                  {{ plugin.name }}
                </div><div :class="['mt-0.5 text-xs text-neutral-500']">
                  {{ plugin.detail }}
                </div>
              </div>
              <span v-if="plugin.locked" :class="['text-xs text-neutral-400']">{{ plugin.enabled ? '运行中' : '已关闭' }}</span>
              <button v-else type="button" role="switch" :aria-checked="plugin.enabled" :class="['relative h-6 w-11 shrink-0 overflow-hidden rounded-full transition-colors', plugin.enabled ? 'bg-cyan-600' : 'bg-neutral-300 dark:bg-neutral-700']" @click="plugin.id === 'diary' ? manager.configDraft.diaryEnabled = !plugin.enabled : manager.configDraft.autonomousLifeEnabled = !plugin.enabled">
                <span :class="['absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform', plugin.enabled ? 'translate-x-5' : 'translate-x-0']" />
              </button>
            </div>
          </div>
          <aside :class="['space-y-4 border-l border-neutral-200 pl-6 dark:border-neutral-800']">
            <h2 :class="['font-semibold']">
              运行参数
            </h2>
            <FieldInput v-model="manager.configDraft.diaryDailyTime" type="time" label="每日日记时间" />
            <div :class="['grid grid-cols-2 gap-3']">
              <FieldInput v-model="manager.configDraft.autonomousLifeMinMinutes" type="number" label="最短间隔（分钟）" /><FieldInput v-model="manager.configDraft.autonomousLifeMaxMinutes" type="number" label="最长间隔（分钟）" />
            </div>
            <Button label="保存内置模块" icon="i-solar:diskette-bold-duotone" :loading="manager.busy.value" @click="manager.saveBuiltInPlugins" />
          </aside>
        </div>

        <div v-else :class="['space-y-5']">
          <div :class="['flex items-center gap-2']">
            <div :class="['relative min-w-0 flex-1']">
              <span :class="['i-solar:magnifer-linear absolute left-3 top-2.5 size-4 text-neutral-400']" /><input v-model="search" type="search" placeholder="筛选插件" :class="['h-10 w-full rounded-md border border-neutral-200 bg-transparent pl-9 pr-3 text-sm outline-none focus:border-cyan-500 dark:border-neutral-800']">
            </div>
            <Button variant="secondary" label="打开目录" icon="i-solar:folder-open-bold-duotone" @click="manager.openPluginDirectory" />
          </div>
          <div :class="['text-xs text-neutral-500']">
            {{ manager.pluginDirectory.value }}
          </div>
          <div :class="['divide-y divide-neutral-200 border-y border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800']">
            <div v-for="plugin in filteredPlugins" :key="plugin.name" :class="['flex items-center gap-4 py-5']">
              <span :class="['i-solar:plug-circle-bold-duotone inline-block size-8 shrink-0', plugin.serverCompatible ? 'text-violet-600' : 'text-neutral-400']" />
              <div :class="['min-w-0 flex-1']">
                <div :class="['font-medium']">
                  {{ plugin.name }}
                </div>
                <div :class="['mt-0.5 text-xs text-neutral-500']">
                  {{ plugin.serverCompatible ? `${runtimeState(plugin.name)?.toolCount ?? 0} 个工具 · ${runtimeState(plugin.name)?.state ?? (plugin.enabled ? '等待启动' : '未启用')}` : '与 Server Runtime 不兼容' }}
                </div>
                <div v-if="runtimeState(plugin.name)?.lastError || plugin.error" :class="['mt-1 text-xs text-rose-600']">
                  {{ runtimeState(plugin.name)?.lastError || plugin.error }}
                </div>
              </div>
              <button type="button" role="switch" :aria-checked="plugin.enabled" :disabled="!plugin.serverCompatible" :class="['relative h-6 w-11 shrink-0 overflow-hidden rounded-full transition-colors', plugin.enabled ? 'bg-cyan-600' : 'bg-neutral-300 dark:bg-neutral-700', !plugin.serverCompatible && 'opacity-40']" @click="manager.togglePlugin(plugin.name, !plugin.enabled)">
                <span :class="['absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform', plugin.enabled ? 'translate-x-5' : 'translate-x-0']" />
              </button>
            </div>
            <div v-if="filteredPlugins.length === 0" :class="['py-10 text-center text-sm text-neutral-500']">
              没有找到可识别的外部插件。
            </div>
          </div>
          <div v-if="manager.plugins.value.some(item => item.name === 'lumi-diary')" :class="['grid gap-4 border-t border-neutral-200 pt-5 dark:border-neutral-800 md:grid-cols-[minmax(0,1fr)_auto] md:items-end']">
            <FieldInput v-model="manager.configDraft.diaryDirectory" label="Lumi Diary 目录" placeholder="留空使用 Documents/LumiDiary" />
            <Button label="保存插件配置" icon="i-solar:diskette-bold-duotone" :loading="manager.busy.value" @click="manager.savePluginSettings" />
          </div>
        </div>
      </div>
    </Transition>
  </ManagerPage>
</template>

<style scoped>
.plugin-view-enter-active,
.plugin-view-leave-active { transition: opacity 180ms ease, transform 240ms cubic-bezier(.22, 1, .36, 1); }
.plugin-view-enter-from { opacity: 0; transform: translateX(14px); }
.plugin-view-leave-to { opacity: 0; transform: translateX(-8px); }
@media (prefers-reduced-motion: reduce) {
  .plugin-view-enter-active,
  .plugin-view-leave-active { transition-duration: 1ms; }
}
</style>
