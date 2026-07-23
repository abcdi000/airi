<script setup lang="ts">
import { Button, FieldCheckbox, FieldInput, Textarea } from '@proj-airi/ui'

import ComputerUsePolicyEditor from '../components/ComputerUsePolicyEditor.vue'
import ManagerPage from '../components/ManagerPage.vue'

import { useServerManager } from '../useServerManager'

const manager = useServerManager()
const presets = [
  { id: 'playwright' as const, label: 'Playwright', detail: '网页浏览与操作', icon: 'i-solar:global-bold-duotone' },
  { id: 'computer_use' as const, label: 'Windows Computer Use', detail: '本机窗口与桌面控制', icon: 'i-solar:cursor-square-bold-duotone' },
  { id: 'minecraft' as const, label: 'Minecraft', detail: 'Minecraft Java 联机控制', icon: 'i-solar:gamepad-bold-duotone' },
  { id: 'steam' as const, label: 'Steam', detail: '游戏库、游玩状态与资料查询', icon: 'i-simple-icons:steam' },
  { id: 'anilist' as const, label: 'AniList', detail: '动漫、角色与追番信息查询', icon: 'i-solar:clapperboard-play-bold-duotone' },
]
</script>

<template>
  <ManagerPage title="MCP 服务" description="所有在线工具只在 Server 启动一份，并由会话权限和资源租约统一管理。" icon="i-solar:widget-5-bold-duotone">
    <template #actions>
      <Button label="保存全部" icon="i-solar:diskette-bold-duotone" :loading="manager.busy.value" @click="manager.saveMcp" />
    </template>
    <div :class="['grid min-h-[520px] grid-cols-[250px_minmax(0,1fr)] overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-800']">
      <aside :class="['border-r border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-800 dark:bg-neutral-900/40']">
        <div :class="['mb-3 flex items-center justify-between px-1']">
          <span :class="['text-xs font-semibold text-neutral-500']">服务器</span><button type="button" title="添加空白 MCP" :class="['grid size-7 place-items-center rounded hover:bg-neutral-200 dark:hover:bg-neutral-800']" @click="manager.addMcpPreset('blank')">
            <span :class="['i-solar:add-circle-bold size-4']" />
          </button>
        </div>
        <button v-for="draft in manager.mcpDrafts.value" :key="draft.id" type="button" :class="['mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left text-sm transition-colors', manager.selectedMcpId.value === draft.id ? 'bg-white text-cyan-800 shadow-sm dark:bg-neutral-800 dark:text-cyan-200' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800']" @click="manager.selectedMcpId.value = draft.id">
          <span :class="[draft.url ? 'i-solar:link-circle-bold-duotone' : 'i-solar:command-bold-duotone', 'size-4']" /><span :class="['min-w-0 flex-1 truncate']">{{ draft.name || '未命名 MCP' }}</span><span :class="['size-1.5 rounded-full', draft.enabled ? 'bg-emerald-500' : 'bg-neutral-400']" />
        </button>
        <div v-if="manager.mcpDrafts.value.length === 0" :class="['px-3 py-6 text-center text-xs text-neutral-500']">
          还没有 MCP 服务
        </div>
        <div :class="['mt-5 border-t border-neutral-200 pt-4 dark:border-neutral-800']">
          <div :class="['mb-2 px-1 text-xs font-semibold text-neutral-500']">
            快速预设
          </div><button v-for="preset in presets" :key="preset.id" type="button" :class="['mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800']" @click="manager.addMcpPreset(preset.id)">
            <span :class="[preset.icon, 'size-4 text-cyan-600']" /><span><span :class="['block text-xs font-medium']">{{ preset.label }}</span><span :class="['block text-[11px] text-neutral-500']">{{ preset.detail }}</span></span>
          </button>
        </div>
      </aside>
      <div v-if="manager.selectedMcp.value" :class="['min-w-0 overflow-y-auto p-6']">
        <div :class="['mb-5 flex items-center justify-between border-b border-neutral-200 pb-4 dark:border-neutral-800']">
          <div>
            <h2 :class="['font-semibold']">
              {{ manager.selectedMcp.value.name || '新 MCP 服务' }}
            </h2><p :class="['text-xs text-neutral-500']">
              使用命令启动本地进程，或填写远程 Streamable HTTP 地址。
            </p>
          </div><button type="button" title="删除服务" :class="['grid size-8 place-items-center rounded text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30']" @click="manager.removeMcp(manager.selectedMcp.value!.id)">
            <span :class="['i-solar:trash-bin-trash-bold size-4']" />
          </button>
        </div>
        <div :class="['space-y-4']">
          <div :class="['grid grid-cols-2 gap-4']">
            <FieldInput v-model="manager.selectedMcp.value.name" label="名称" /><FieldCheckbox v-model="manager.selectedMcp.value.enabled" label="启用此服务" />
          </div>
          <div :class="['grid grid-cols-2 gap-4']">
            <FieldInput v-model="manager.selectedMcp.value.command" label="启动命令" /><FieldInput v-model="manager.selectedMcp.value.url" label="远程 URL" />
          </div>
          <FieldInput v-model="manager.selectedMcp.value.cwd" label="工作目录" />
          <ComputerUsePolicyEditor
            v-if="manager.selectedMcp.value.name === 'computer_use'"
            v-model="manager.selectedMcp.value.envText"
          />
          <div :class="['grid grid-cols-2 gap-4']">
            <Textarea v-model="manager.selectedMcp.value.argsText" label="参数（每行一项）" /><Textarea v-model="manager.selectedMcp.value.envText" label="环境变量（KEY=VALUE）" />
          </div>
          <Textarea v-if="manager.selectedMcp.value.url" v-model="manager.selectedMcp.value.headersText" label="请求头（KEY=VALUE）" />
          <div :class="['grid grid-cols-3 gap-4']">
            <label :class="['text-sm']"><span :class="['mb-1.5 block']">启动方式</span><select v-model="manager.selectedMcp.value.startupMode" :class="['h-10 w-full rounded-md border border-neutral-200 bg-transparent px-3 dark:border-neutral-800']"><option value="on_startup">Server 启动时</option><option value="on_first_use">首次使用时</option><option value="manual">手动</option></select></label><FieldInput v-model="manager.selectedMcp.value.requestTimeoutMs" type="number" label="请求超时 ms" /><FieldInput v-model="manager.selectedMcp.value.maxTotalTimeoutMs" type="number" label="总超时 ms" />
          </div>
          <div :class="['grid grid-cols-2 gap-4 rounded-md bg-neutral-50 p-3 dark:bg-neutral-900/50']">
            <FieldCheckbox v-model="manager.selectedMcp.value.longRunning" label="长时间运行工具" />
            <FieldCheckbox v-model="manager.selectedMcp.value.persistent" label="保持进程常驻" />
          </div>
          <Button variant="secondary" label="测试当前配置" icon="i-solar:test-tube-bold-duotone" :disabled="manager.running.value" :loading="manager.busy.value" @click="manager.testMcp(manager.selectedMcp.value!)" />
          <p v-if="manager.running.value" :class="['text-xs text-neutral-500']">
            测试未保存配置前请先停止 Server，避免同一物理工具启动两份。
          </p>
        </div>
      </div>
      <div v-else :class="['grid place-items-center text-sm text-neutral-500']">
        从左侧选择服务，或添加一个预设。
      </div>
    </div>
    <div v-if="manager.tools.value?.activeResourceLeases.length" :class="['border-t border-neutral-200 pt-5 dark:border-neutral-800']">
      <h2 :class="['mb-2 text-sm font-semibold']">
        活动资源租约
      </h2><div v-for="lease in manager.tools.value.activeResourceLeases" :key="lease.id" :class="['flex items-center justify-between border-b border-neutral-200 py-3 text-sm dark:border-neutral-800']">
        <span>{{ lease.resource }} · {{ lease.toolName }}</span><Button size="sm" variant="secondary" label="终止" @click="manager.terminateLease(lease.id)" />
      </div>
    </div>
  </ManagerPage>
</template>
