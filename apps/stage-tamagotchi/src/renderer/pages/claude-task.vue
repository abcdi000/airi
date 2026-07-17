<script setup lang="ts">
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  electronClaudeCodeAgentApproveTaskPermission,
  electronClaudeCodeAgentCancelTask,
  electronClaudeCodeAgentGetTaskSnapshot,
  electronClaudeCodeAgentListLogs,
  electronClaudeCodeAgentRejectTaskPermission,
  electronClaudeCodeAgentRunTask,
  electronWindowClose,
} from '../../shared/eventa'

const route = useRoute()
const router = useRouter()
const taskId = computed(() => String(route.query.taskId || ''))
const getSnapshot = useElectronEventaInvoke(electronClaudeCodeAgentGetTaskSnapshot)
const listLogs = useElectronEventaInvoke(electronClaudeCodeAgentListLogs)
const runTask = useElectronEventaInvoke(electronClaudeCodeAgentRunTask)
const cancelTask = useElectronEventaInvoke(electronClaudeCodeAgentCancelTask)
const approvePermission = useElectronEventaInvoke(electronClaudeCodeAgentApproveTaskPermission)
const rejectPermission = useElectronEventaInvoke(electronClaudeCodeAgentRejectTaskPermission)
const closeWindow = useElectronEventaInvoke(electronWindowClose)

const snapshot = ref<any>({ events: [], running: false })
const historyLogs = ref<any[]>([])
const followupText = ref('')
const busy = ref(false)
let timer: ReturnType<typeof setInterval> | undefined

const events = computed(() => snapshot.value.events ?? [])
const log = computed(() => snapshot.value.log)
const createdEvent = computed(() => events.value.find((event: any) => event.type === 'created'))
const task = computed(() => log.value?.task ?? createdEvent.value?.data)
const permissionRequest = computed(() => {
  const request = [...events.value].reverse().find((event: any) => event.type === 'permission_request')
  const decision = [...events.value].reverse().find((event: any) => event.type === 'permission_decision')
  return request && !decision && !log.value ? request : undefined
})
const changedFiles = computed(() => log.value?.changedFiles ?? [])
const outputEvents = computed(() => events.value.filter((event: any) => event.type === 'stdout' || event.type === 'stderr'))
const latestOutputPreview = computed(() => {
  const text = [...outputEvents.value].reverse().map((event: any) => event.message || '').find(Boolean) || ''
  return text.length > 500 ? text.slice(-500) : text
})
const taskTitle = computed(() => task.value?.displayName || log.value?.displayName || 'Lumi Claude Code 任务')
const statusText = computed(() => {
  if (permissionRequest.value)
    return '等待确认'
  if (snapshot.value.running)
    return '运行中'
  if (log.value?.status)
    return formatStatus(log.value.status)
  return events.value.length ? '等待结果' : '等待任务'
})

function formatStatus(status: string) {
  const map: Record<string, string> = {
    running: '运行中',
    success: '已完成',
    failed: '失败',
    cancelled: '已取消',
    timeout: '超时',
  }
  return map[status] || status
}

function formatEventType(type: string) {
  const map: Record<string, string> = {
    created: '创建',
    started: '启动',
    stdout: '输出',
    stderr: '错误输出',
    error: '错误',
    completed: '完成',
    permission_request: '权限请求',
    permission_decision: '权限决定',
  }
  return map[type] || type
}

async function refresh() {
  if (!taskId.value) {
    historyLogs.value = await listLogs({ limit: 100 }) as any[]
    snapshot.value = { events: [], running: false }
    return
  }
  snapshot.value = await getSnapshot({ taskId: taskId.value }) as any
}

async function openTask(id: string) {
  await router.replace({ path: '/claude-task', query: { taskId: id } })
  await refresh()
}

async function showHistory() {
  await router.replace({ path: '/claude-task' })
  await refresh()
}

async function continueCurrentTask() {
  const text = followupText.value.trim()
  if (!taskId.value || !text)
    return
  busy.value = true
  try {
    const result = await runTask({
      userRequest: text,
      continueFromTaskId: taskId.value,
      detached: true,
    }) as any
    followupText.value = ''
    if (result?.taskId)
      await openTask(result.taskId)
  }
  finally {
    busy.value = false
  }
}

async function cancelCurrentTask() {
  if (!taskId.value)
    return
  busy.value = true
  try {
    await cancelTask({ taskId: taskId.value })
    await refresh()
  }
  finally {
    busy.value = false
  }
}

async function approveCurrentPermission() {
  if (!taskId.value)
    return
  busy.value = true
  try {
    await approvePermission({ taskId: taskId.value })
    await refresh()
  }
  finally {
    busy.value = false
  }
}

async function rejectCurrentPermission() {
  if (!taskId.value)
    return
  busy.value = true
  try {
    await rejectPermission({ taskId: taskId.value })
    await refresh()
  }
  finally {
    busy.value = false
  }
}

function closeCurrentWindow() {
  void closeWindow()
}

onMounted(() => {
  void refresh()
  timer = setInterval(() => void refresh().catch(() => {}), 800)
})

onUnmounted(() => {
  if (timer)
    clearInterval(timer)
})
</script>

<template>
  <div class="h-screen overflow-hidden bg-black/72 text-cyan-50 backdrop-blur-xl">
    <div class="h-full flex flex-col rounded-2xl border border-cyan-400/25 bg-neutral-950/88 shadow-2xl">
      <header class="flex items-center justify-between gap-3 border-b border-cyan-400/15 px-4 py-3" style="-webkit-app-region: drag;">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="h-2.5 w-2.5 rounded-full" :class="snapshot.running ? 'bg-emerald-400' : permissionRequest ? 'bg-amber-400' : 'bg-neutral-500'" />
            <h1 class="truncate text-lg font-semibold">
              {{ taskTitle }}
            </h1>
          </div>
          <p class="mt-1 truncate text-xs text-cyan-100/60">
            {{ taskId || '等待任务 ID' }}
          </p>
        </div>
        <div class="flex items-center gap-2" style="-webkit-app-region: no-drag;">
          <button class="rounded-lg bg-cyan-500/15 px-3 py-1.5 text-sm text-cyan-100 hover:bg-cyan-500/20" @click="showHistory">
            历史
          </button>
          <button class="rounded-lg bg-red-500/15 px-3 py-1.5 text-sm text-red-200 disabled:opacity-40" :disabled="(!snapshot.running && !permissionRequest) || busy" @click="cancelCurrentTask">
            取消
          </button>
          <button class="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/15" @click="closeCurrentWindow">
            关闭
          </button>
        </div>
      </header>

      <main class="min-h-0 flex-1 overflow-auto p-4">
        <template v-if="!taskId">
          <section class="rounded-xl border border-cyan-400/15 bg-cyan-950/30 p-3">
            <h2 class="text-base font-semibold text-cyan-50">
              历史任务
            </h2>
            <p class="mt-1 text-xs text-cyan-100/60">
              选择一个任务可以查看过程，也可以继续在原工作目录上追问。
            </p>
          </section>

          <section class="mt-4 grid gap-3">
            <article
              v-for="item in historyLogs"
              :key="item.taskId"
              class="rounded-xl border border-cyan-400/15 bg-black/30 p-3 text-sm hover:border-cyan-300/35"
            >
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <h3 class="truncate font-semibold text-cyan-50">
                    {{ item.displayName || item.taskType || item.taskId }}
                  </h3>
                  <p class="mt-1 truncate text-xs text-cyan-100/55">
                    {{ item.taskId }}
                  </p>
                </div>
                <span class="rounded-full px-2 py-1 text-xs" :class="item.status === 'success' ? 'bg-emerald-400/15 text-emerald-100' : item.status === 'failed' ? 'bg-red-400/15 text-red-100' : 'bg-cyan-400/15 text-cyan-100'">
                  {{ formatStatus(item.status) }}
                </span>
              </div>
              <p class="mt-3 line-clamp-2 text-cyan-50/75">
                {{ item.latestUserRequest || item.userRequest }}
              </p>
              <div class="mt-3 flex items-center justify-between gap-3 text-xs text-cyan-100/50">
                <span>{{ new Date(item.createdAt || item.startedAt).toLocaleString() }}</span>
                <span>变更 {{ item.changedFiles?.length || 0 }}</span>
              </div>
              <button class="mt-3 rounded-lg bg-cyan-500/15 px-3 py-2 text-sm text-cyan-100 hover:bg-cyan-500/25" @click="openTask(item.taskId)">
                打开任务
              </button>
            </article>
            <div v-if="historyLogs.length === 0" class="rounded-xl border border-dashed border-cyan-400/20 p-8 text-center text-sm text-cyan-100/50">
              暂无历史任务。
            </div>
          </section>
        </template>

        <template v-else>
          <section class="rounded-xl border border-cyan-400/15 bg-cyan-950/30 p-3">
            <div class="flex flex-wrap items-center gap-2 text-sm">
              <span class="rounded-full bg-cyan-400/15 px-2 py-1 text-cyan-100">状态 {{ statusText }}</span>
              <span v-if="task?.permissionMode" class="rounded-full bg-violet-400/15 px-2 py-1 text-violet-100">{{ task.permissionMode }}</span>
            </div>
            <div v-if="task?.cwd" class="mt-3 break-all rounded-lg bg-black/35 p-2 font-mono text-xs text-cyan-100/70">
              {{ task.cwd }}
            </div>
          </section>

          <section v-if="permissionRequest" class="mt-4 rounded-xl border border-amber-300/40 bg-amber-950/35 p-3">
            <h2 class="text-sm font-semibold text-amber-100">
              权限确认
            </h2>
            <p class="mt-2 text-sm text-amber-50/85">
              {{ permissionRequest.message }}
            </p>
            <p v-if="permissionRequest.data?.reason" class="mt-1 text-xs text-amber-50/65">
              {{ permissionRequest.data.reason }}
            </p>
            <div class="mt-3 flex flex-wrap gap-2">
              <button class="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-40" :disabled="busy" @click="approveCurrentPermission">
                批准在沙盒执行
              </button>
              <button class="rounded-lg bg-red-500/20 px-3 py-2 text-sm text-red-100 disabled:opacity-40" :disabled="busy" @click="rejectCurrentPermission">
                拒绝
              </button>
            </div>
          </section>

          <section v-if="snapshot.running" class="mt-4 rounded-xl border border-cyan-300/20 bg-cyan-950/30 p-3">
            <div class="flex items-center justify-between gap-3">
              <div>
                <h2 class="text-sm font-semibold text-cyan-50">
                  Claude Code 正在执行
                </h2>
                <p class="mt-1 text-xs text-cyan-100/60">
                  已收到 {{ outputEvents.length }} 条输出，窗口会持续同步。
                </p>
              </div>
              <span class="h-3 w-3 animate-pulse rounded-full bg-emerald-300" />
            </div>
            <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-cyan-950">
              <div class="h-full w-1/2 animate-pulse rounded-full bg-cyan-300/70" />
            </div>
            <pre v-if="latestOutputPreview" class="mt-3 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/35 p-3 font-mono text-xs leading-relaxed text-cyan-50/75">{{ latestOutputPreview }}</pre>
          </section>

          <section v-if="task?.userRequest || task?.generatedPrompt" class="mt-4 rounded-xl border border-cyan-400/15 bg-black/25 p-3">
            <h2 class="text-sm font-semibold text-cyan-100">
              Lumi 发送给 Claude Code 的内容
            </h2>
            <div v-if="task?.userRequest" class="mt-2 rounded-lg bg-cyan-950/35 p-3 text-sm leading-relaxed text-cyan-50/85">
              {{ task.userRequest }}
            </div>
            <details v-if="task?.generatedPrompt" class="mt-3">
              <summary class="cursor-pointer text-xs text-cyan-100/70">
                查看完整任务 Prompt
              </summary>
              <pre class="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/45 p-3 font-mono text-xs leading-relaxed text-cyan-50/75">{{ task.generatedPrompt }}</pre>
            </details>
          </section>

          <section v-if="changedFiles.length > 0" class="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-950/25 p-3">
            <h2 class="text-sm font-semibold text-emerald-100">
              文件变更
            </h2>
            <ul class="mt-2 grid gap-1 text-xs text-emerald-50/80">
              <li v-for="file in changedFiles" :key="file" class="break-all font-mono">
                {{ file }}
              </li>
            </ul>
          </section>

          <section class="mt-4 grid gap-3">
            <article v-for="event in events" :key="event.id" class="rounded-xl border p-3 text-sm" :class="event.type === 'stderr' || event.type === 'error' ? 'border-red-400/25 bg-red-950/25' : event.type === 'permission_request' ? 'border-amber-400/30 bg-amber-950/25' : event.type === 'stdout' ? 'border-cyan-400/15 bg-black/30' : 'border-emerald-400/15 bg-emerald-950/20'">
              <div class="mb-2 flex items-center justify-between gap-2 text-xs opacity-70">
                <span>{{ formatEventType(event.type) }}</span>
                <span>{{ new Date(event.createdAt).toLocaleTimeString() }}</span>
              </div>
              <pre class="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{{ event.message }}</pre>
            </article>
            <div v-if="events.length === 0" class="rounded-xl border border-dashed border-cyan-400/20 p-8 text-center text-sm text-cyan-100/50">
              暂无任务事件。
            </div>
          </section>
        </template>
      </main>

      <footer v-if="taskId" class="border-t border-cyan-400/15 p-3">
        <div class="flex gap-2" style="-webkit-app-region: no-drag;">
          <textarea
            v-model="followupText"
            class="min-h-12 flex-1 resize-none rounded-xl border border-cyan-400/20 bg-black/35 px-3 py-2 text-sm text-cyan-50 outline-none placeholder:text-cyan-100/35"
            placeholder="继续这个任务，比如：把按钮改蓝一点，或者检查刚才为什么失败..."
            @keydown.ctrl.enter.prevent="continueCurrentTask"
          />
          <button class="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40" :disabled="busy || !followupText.trim()" @click="continueCurrentTask">
            继续
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>
