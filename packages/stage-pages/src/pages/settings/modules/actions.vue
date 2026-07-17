<script setup lang="ts">
import { AGENT_PERMISSION_MODES, routeAgentTask } from '@proj-airi/stage-ui/libs/lumi-agent'
import { useLumiAgentStore } from '@proj-airi/stage-ui/stores/lumi-agent'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'

const agentStore = useLumiAgentStore()
const {
  enabled,
  claudeCommand,
  lumiSandboxRoot,
  trustedProjectsText,
  selfProjectRootsText,
  forbiddenPathsText,
  defaultPermissionMode,
  sandboxAutoApprove,
  maxTaskTimeoutMs,
  allowedCondaEnvsText,
  defaultCondaEnv,
  recentLogs,
  commandCandidates,
  lastError,
  configured,
} = storeToRefs(agentStore)

const sampleRequest = ref('帮我做一个番茄钟网页')
const testResult = computed(() => routeAgentTask(sampleRequest.value, agentStore.settings))
const statusText = ref('')
const busy = ref(false)
const commandBusy = ref(false)

async function searchClaudeCommand() {
  commandBusy.value = true
  try {
    const result = await agentStore.searchClaudeCommand()
    if (result.path)
      statusText.value = `已找到 Claude Code 命令：${result.path}`
    else
      statusText.value = result.error ? `自动搜索失败：${result.error}` : '没有自动找到 Claude Code 命令，请使用“选择文件”手动指定。'
  }
  catch (error) {
    statusText.value = `自动搜索失败：${error instanceof Error ? error.message : String(error)}`
  }
  finally {
    commandBusy.value = false
  }
}

async function pickClaudeCommand() {
  commandBusy.value = true
  try {
    const result = await agentStore.pickClaudeCommand()
    statusText.value = result.path ? `已选择 Claude Code 命令：${result.path}` : '已取消选择。'
  }
  catch (error) {
    statusText.value = `选择文件失败：${error instanceof Error ? error.message : String(error)}`
  }
  finally {
    commandBusy.value = false
  }
}

async function refreshLogs() {
  busy.value = true
  try {
    await agentStore.refreshRecentLogs(10)
    statusText.value = '最近任务日志已刷新。'
  }
  catch (error) {
    statusText.value = `刷新失败：${error instanceof Error ? error.message : String(error)}`
  }
  finally {
    busy.value = false
  }
}

function resetSettings() {
  agentStore.resetSettings()
  statusText.value = '动作模块配置已恢复默认。'
}
</script>

<template>
  <div class="mx-auto max-w-4xl flex flex-col gap-5 px-4 pb-12">
    <section class="rounded-lg bg-neutral-100/70 p-4 dark:bg-neutral-900/70">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="text-sm text-neutral-500">
            Claude Code CLI Delegation
          </div>
          <h2 class="text-2xl font-semibold">
            动作
          </h2>
          <p class="mt-1 text-sm text-neutral-500">
            让 Lumi 在安全边界内，把外部网页、文档、代码任务交给 Claude Code CLI。
          </p>
        </div>
        <div class="rounded-full px-3 py-1 text-sm" :class="configured ? 'bg-emerald-500/15 text-emerald-500' : 'bg-amber-500/15 text-amber-500'">
          {{ configured ? '已启用' : '未就绪' }}
        </div>
      </div>
    </section>

    <section class="rounded-lg bg-neutral-100/70 p-4 dark:bg-neutral-900/70">
      <h3 class="text-lg font-semibold">
        基础配置
      </h3>
      <div class="mt-4 grid gap-4">
        <label class="flex items-center gap-3">
          <input v-model="enabled" type="checkbox">
          <span>启用 Claude Code 动作模块</span>
        </label>

        <label class="grid gap-2">
          <span class="text-sm text-neutral-500">Claude 命令</span>
          <div class="flex flex-wrap gap-2">
            <input v-model="claudeCommand" class="min-w-0 flex-1 rounded-lg bg-white/80 px-3 py-2 font-mono dark:bg-neutral-950" placeholder="claude">
            <button class="rounded-lg bg-cyan-500 px-4 py-2 text-white disabled:opacity-50" :disabled="commandBusy" type="button" @click="searchClaudeCommand">
              自动搜索
            </button>
            <button class="rounded-lg bg-neutral-300 px-4 py-2 dark:bg-neutral-800 disabled:opacity-50" :disabled="commandBusy" type="button" @click="pickClaudeCommand">
              选择文件
            </button>
          </div>
          <span class="text-xs text-neutral-500">
            Windows 上通常是 <span class="font-mono">C:\Users\你的用户名\AppData\Roaming\npm\claude.cmd</span>。如果终端能运行但 AIRI 不能运行，请优先选择完整路径。
          </span>
          <div v-if="commandCandidates.length > 0" class="grid gap-1 rounded-lg bg-white/70 p-3 text-xs dark:bg-neutral-950/70">
            <div class="font-medium text-neutral-500">
              已找到的候选路径
            </div>
            <button
              v-for="candidate in commandCandidates"
              :key="candidate"
              class="truncate rounded bg-neutral-200 px-2 py-1 text-left font-mono dark:bg-neutral-800"
              type="button"
              @click="claudeCommand = candidate"
            >
              {{ candidate }}
            </button>
          </div>
        </label>

        <label class="grid gap-1">
          <span class="text-sm text-neutral-500">LumiSandbox 根目录</span>
          <input v-model="lumiSandboxRoot" class="rounded-lg bg-white/80 px-3 py-2 font-mono dark:bg-neutral-950" placeholder="例如 D:\LumiSandbox">
          <span class="text-xs text-neutral-500">必须配置后，Lumi 才能在沙箱内自动执行低风险任务。不要把这里设置为 AIRI/Lumi 源码目录。</span>
        </label>

        <label class="flex items-center gap-3">
          <input v-model="sandboxAutoApprove" type="checkbox">
          <span>允许沙箱内低风险任务自动执行</span>
        </label>

        <label class="grid gap-1">
          <span class="text-sm text-neutral-500">最大任务时间 ms</span>
          <input v-model.number="maxTaskTimeoutMs" type="number" min="10000" max="1800000" step="10000" class="rounded-lg bg-white/80 px-3 py-2 dark:bg-neutral-950">
        </label>

        <label class="grid gap-1">
          <span class="text-sm text-neutral-500">默认权限模式</span>
          <select v-model="defaultPermissionMode" class="rounded-lg bg-white/80 px-3 py-2 dark:bg-neutral-950">
            <option v-for="mode in AGENT_PERMISSION_MODES" :key="mode" :value="mode">
              {{ mode }}
            </option>
          </select>
        </label>
      </div>
    </section>

    <section class="rounded-lg bg-neutral-100/70 p-4 dark:bg-neutral-900/70">
      <h3 class="text-lg font-semibold">
        路径边界
      </h3>
      <div class="mt-4 grid gap-4">
        <label class="grid gap-1">
          <span class="text-sm text-neutral-500">可信项目目录，一行一个</span>
          <textarea v-model="trustedProjectsText" rows="4" class="rounded-lg bg-white/80 px-3 py-2 font-mono dark:bg-neutral-950" />
        </label>
        <label class="grid gap-1">
          <span class="text-sm text-neutral-500">Lumi / AIRI 自身项目目录，一行一个</span>
          <textarea v-model="selfProjectRootsText" rows="4" class="rounded-lg bg-white/80 px-3 py-2 font-mono dark:bg-neutral-950" placeholder="例如 D:\pyProject\AIRI\airi" />
        </label>
        <label class="grid gap-1">
          <span class="text-sm text-neutral-500">禁止访问目录，一行一个</span>
          <textarea v-model="forbiddenPathsText" rows="4" class="rounded-lg bg-white/80 px-3 py-2 font-mono dark:bg-neutral-950" />
        </label>
      </div>
    </section>

    <section class="rounded-lg bg-neutral-100/70 p-4 dark:bg-neutral-900/70">
      <h3 class="text-lg font-semibold">
        Conda
      </h3>
      <div class="mt-4 grid gap-4">
        <label class="grid gap-1">
          <span class="text-sm text-neutral-500">允许使用的 conda 环境，一行一个，base 会被自动拒绝</span>
          <textarea v-model="allowedCondaEnvsText" rows="3" class="rounded-lg bg-white/80 px-3 py-2 font-mono dark:bg-neutral-950" />
        </label>
        <label class="grid gap-1">
          <span class="text-sm text-neutral-500">默认 conda 环境</span>
          <input v-model="defaultCondaEnv" class="rounded-lg bg-white/80 px-3 py-2 dark:bg-neutral-950">
        </label>
      </div>
    </section>

    <section class="rounded-lg bg-neutral-100/70 p-4 dark:bg-neutral-900/70">
      <h3 class="text-lg font-semibold">
        路由测试
      </h3>
      <div class="mt-4 grid gap-3">
        <input v-model="sampleRequest" class="rounded-lg bg-white/80 px-3 py-2 dark:bg-neutral-950">
        <pre class="max-h-56 overflow-auto rounded-lg bg-white/80 p-3 text-xs dark:bg-neutral-950">{{ JSON.stringify(testResult, null, 2) }}</pre>
      </div>
    </section>

    <section class="rounded-lg bg-neutral-100/70 p-4 dark:bg-neutral-900/70">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="text-lg font-semibold">
          最近任务日志
        </h3>
        <div class="flex gap-2">
          <button class="rounded-lg bg-cyan-500 px-4 py-2 text-white disabled:opacity-50" :disabled="busy" @click="refreshLogs">
            刷新日志
          </button>
          <button class="rounded-lg bg-neutral-300 px-4 py-2 dark:bg-neutral-800" @click="resetSettings">
            恢复默认
          </button>
        </div>
      </div>
      <p v-if="statusText" class="mt-3 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-500">
        {{ statusText }}
      </p>
      <p v-if="lastError" class="mt-3 rounded-lg bg-red-500/10 p-3 text-sm text-red-400">
        {{ lastError }}
      </p>
      <div class="mt-4 grid gap-3">
        <div v-if="recentLogs.length === 0" class="rounded-lg border border-dashed border-neutral-300 p-4 text-sm text-neutral-500 dark:border-neutral-700">
          还没有任务日志。任务执行后会写入 LumiSandbox/agent-logs。
        </div>
        <details v-for="log in recentLogs" :key="log.taskId" class="rounded-lg bg-white/70 p-3 dark:bg-neutral-950/70">
          <summary class="cursor-pointer font-medium">
            {{ log.taskId }} / {{ log.taskType }} / {{ log.status }}
          </summary>
          <pre class="mt-3 max-h-72 overflow-auto whitespace-pre-wrap text-xs">{{ JSON.stringify(log, null, 2) }}</pre>
        </details>
      </div>
    </section>
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.modules.actions.title
  subtitleKey: settings.title
  descriptionKey: settings.pages.modules.actions.description
  icon: i-solar:command-bold-duotone
  stageTransition:
    name: slide
</route>
