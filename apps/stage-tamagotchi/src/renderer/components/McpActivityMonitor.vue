<script setup lang="ts">
import type { McpActivityEvent } from '@proj-airi/stage-ui/tools/mcp'

import { errorMessageFrom } from '@moeru/std'
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { MCP_ACTIVITY_CHANNEL_NAME, MCP_ACTIVITY_STORAGE_KEY } from '@proj-airi/stage-ui/tools/mcp'
import { useBroadcastChannel, useLocalStorage } from '@vueuse/core'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

import { electronMcpCallTool, electronWindowClose } from '../../shared/eventa'

const props = withDefaults(defineProps<{
  standalone?: boolean
}>(), {
  standalone: false,
})

type Activity = McpActivityEvent & {
  updatedAt: number
  backgroundActionId?: number
  backgroundActive?: boolean
  backgroundLifecycleStatus?: string
  backgroundPhase?: string
  backgroundStatusText?: string
  userInterrupted?: boolean
}

interface MonitorPosition {
  x: number
  y: number
}

const STUCK_AFTER_MS = 20_000
const STATUS_POLL_MS = 2_000
const MAX_ITEMS = 12
const PANEL_WIDTH = 400
const PANEL_MIN_VISIBLE = 72
const TOOL_NAME_LABELS: Record<string, string> = {
  'minecraft::observe-world': '观察周围世界',
  'minecraft::list-entities': '列出附近实体',
  'minecraft::follow-entity': '跟随移动目标',
  'minecraft::combat-engage': '自动战斗',
  'minecraft::flee-from-entity': '远离危险实体',
  'minecraft::guard-area': '守卫区域',
  'minecraft::cancel-action': '取消当前动作',
  'minecraft::get-action-status': '查看动作状态',
  'minecraft::move-to-position': '移动到坐标',
  'minecraft::fly-to': '飞到坐标',
  'minecraft::collect-blocks': '采集方块',
  'minecraft::collect-drops': '拾取掉落物',
  'minecraft::eat-food': '进食',
  'minecraft::configure-auto-eat': '配置自动进食',
  'minecraft::equip-best-armor': '装备最佳护甲',
  'minecraft::equip-best-tool-for-block': '装备合适工具',
  'minecraft::list-inventory': '查看背包',
  'minecraft::craft-item': '合成物品',
  'minecraft::list-recipes': '列出可用配方',
  'minecraft::get-recipe': '查看合成配方',
  'minecraft::can-craft': '检查能否合成',
  'minecraft::place-block': '放置方块',
  'minecraft::place-workbench': '放置工作台',
  'minecraft::dig-block': '挖掘方块',
  'minecraft::get-block': '查看方块',
  'minecraft::find-block': '查找方块',
  'minecraft::get-server-status': '查看服务器状态',
  'minecraft::look-at': '看向坐标',
  'minecraft::look-at-entity': '看向实体',
  'minecraft::set-control-state': '设置移动按键',
  'minecraft::clear-control-states': '清除移动按键',
  'minecraft::chat': '发送游戏聊天',
  'minecraft::disconnect': '断开连接',
  'minecraft::viewer-start': '启动观察器',
  'minecraft::viewer-stop': '停止观察器',
  'minecraft::viewer-status': '查看观察器状态',
  'minecraft::wait': '等待',
}

const collapsed = useLocalStorage('ui/debug/minecraft-mcp-activity-monitor/collapsed', false)
const position = useLocalStorage<MonitorPosition>('ui/debug/minecraft-mcp-activity-monitor/position', { x: 24, y: 24 })
const positionInitialized = useLocalStorage('ui/debug/minecraft-mcp-activity-monitor/position-initialized', false)
const panelOpen = ref(props.standalone)
const activities = ref<Activity[]>([])
const now = ref(Date.now())
const cancellingTraceIds = ref(new Set<string>())
const dragState = ref<{ pointerId: number, offsetX: number, offsetY: number } | null>(null)
let clockTimer: number | undefined
let statusPollTimer: number | undefined
let statusPollInFlight = false

const chatSession = useChatSessionStore()
const callMcpTool = useElectronEventaInvoke(electronMcpCallTool)
const closeWindow = useElectronEventaInvoke(electronWindowClose)
const { data } = useBroadcastChannel<McpActivityEvent, McpActivityEvent>({
  name: MCP_ACTIVITY_CHANNEL_NAME,
})

const sortedActivities = computed(() => {
  return [...activities.value].sort((a, b) => {
    const aRunning = isActionActive(a)
    const bRunning = isActionActive(b)
    if (aRunning !== bRunning)
      return aRunning ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
})

const visibleActivities = computed(() => sortedActivities.value.slice(0, MAX_ITEMS))
const runningCount = computed(() => activities.value.filter(activity => isActionActive(activity)).length)
const stuckCount = computed(() => activities.value.filter(activity => isStuck(activity)).length)
const panelStyle = computed(() => props.standalone
  ? {}
  : {
      left: `${position.value.x}px`,
      top: `${position.value.y}px`,
    })

watch(data, (event) => {
  if (!isMinecraftActivityEvent(event))
    return

  upsertActivity(event)
})

onMounted(() => {
  if (props.standalone)
    collapsed.value = false

  hydrateStoredActivities()

  if (!props.standalone && !positionInitialized.value) {
    position.value = {
      x: Math.max(16, window.innerWidth - PANEL_WIDTH - 20),
      y: 16,
    }
    positionInitialized.value = true
  }
  clampPosition()
  clockTimer = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
  statusPollTimer = window.setInterval(() => {
    void pollBackgroundActionStatus()
  }, STATUS_POLL_MS)
  window.addEventListener('resize', clampPosition)
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', stopDrag)
})

onUnmounted(() => {
  if (clockTimer != null)
    window.clearInterval(clockTimer)
  if (statusPollTimer != null)
    window.clearInterval(statusPollTimer)
  window.removeEventListener('resize', clampPosition)
  window.removeEventListener('pointermove', handlePointerMove)
  window.removeEventListener('pointerup', stopDrag)
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isMinecraftActivityEvent(value: unknown): value is McpActivityEvent {
  return isRecord(value)
    && value.kind === 'mcp-activity'
    && typeof value.traceId === 'string'
    && typeof value.target === 'string'
    && value.target.startsWith('minecraft::')
}

function hydrateStoredActivities() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(MCP_ACTIVITY_STORAGE_KEY) || '[]')
    if (!Array.isArray(raw))
      return
    const stored = raw
      .filter(isMinecraftActivityEvent)
      .map(event => toActivity(event, event.endedAt ?? event.startedAt ?? Date.now()))
      .slice(0, MAX_ITEMS)
    if (stored.length > 0) {
      activities.value = stored
      panelOpen.value = true
    }
  }
  catch {
    // The monitor is diagnostic only; corrupt localStorage should not affect MCP calls.
  }
}

function persistActivitySnapshot() {
  try {
    window.localStorage.setItem(MCP_ACTIVITY_STORAGE_KEY, JSON.stringify(sortedActivities.value.slice(0, 40)))
  }
  catch {
    // Best effort.
  }
}

function toActivity(event: McpActivityEvent, updatedAt: number): Activity {
  const text = resultPreview(event)
  const backgroundActionId = parseBackgroundActionId(text)
  const previous = activities.value.find(activity => activity.traceId === event.traceId)
  return {
    ...previous,
    ...event,
    updatedAt,
    backgroundActionId: previous?.backgroundActionId ?? backgroundActionId,
    backgroundActive: previous?.backgroundActive ?? (event.status === 'completed' && backgroundActionId != null),
  }
}

function upsertActivity(event: McpActivityEvent) {
  panelOpen.value = true
  const updatedAt = Date.now()
  const index = activities.value.findIndex(activity => activity.traceId === event.traceId)
  const next = toActivity(event, updatedAt)

  if (index >= 0)
    activities.value.splice(index, 1, next)
  else
    activities.value.unshift(next)

  activities.value = sortedActivities.value.slice(0, MAX_ITEMS)
  persistActivitySnapshot()
}

function clampPosition() {
  if (props.standalone)
    return

  const maxX = Math.max(0, window.innerWidth - PANEL_MIN_VISIBLE)
  const maxY = Math.max(0, window.innerHeight - PANEL_MIN_VISIBLE)
  position.value = {
    x: Math.min(Math.max(0, position.value.x), maxX),
    y: Math.min(Math.max(0, position.value.y), maxY),
  }
}

function beginDrag(event: PointerEvent) {
  if (props.standalone)
    return

  dragState.value = {
    pointerId: event.pointerId,
    offsetX: event.clientX - position.value.x,
    offsetY: event.clientY - position.value.y,
  }
}

function handlePointerMove(event: PointerEvent) {
  const drag = dragState.value
  if (!drag || drag.pointerId !== event.pointerId)
    return

  position.value = {
    x: event.clientX - drag.offsetX,
    y: event.clientY - drag.offsetY,
  }
  clampPosition()
}

function stopDrag() {
  dragState.value = null
}

function closePanel() {
  if (props.standalone) {
    void closeWindow()
    return
  }
  panelOpen.value = false
}

function clearSettled() {
  activities.value = activities.value.filter(activity => isActionActive(activity))
  persistActivitySnapshot()
}

function elapsedMs(activity: Activity) {
  if (isActionActive(activity))
    return Math.max(0, now.value - activity.startedAt)
  return activity.durationMs ?? Math.max(0, (activity.endedAt ?? activity.updatedAt) - activity.startedAt)
}

function formatDuration(ms: number) {
  if (ms < 1000)
    return `${ms} ms`
  if (ms < 60_000)
    return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${Math.floor(ms / 60_000)} m ${Math.floor((ms % 60_000) / 1000)} s`
}

function isBackgroundAction(activity: Activity) {
  return activity.backgroundActive === true
}

function isWaitingDecision(activity: Activity) {
  const structured = minecraftStructured(activity)
  return activity.backgroundLifecycleStatus === 'waiting_for_decision'
    || structured?.status === 'waiting_for_decision'
    || structured?.minecraftActionStatus === 'waiting_for_decision'
}

function isActionActive(activity: Activity) {
  return !activity.userInterrupted && !isWaitingDecision(activity) && (activity.status === 'running' || isBackgroundAction(activity))
}

function isStuck(activity: Activity) {
  return activity.status === 'running' && elapsedMs(activity) >= STUCK_AFTER_MS
}

function statusLabel(activity: Activity) {
  if (activity.userInterrupted)
    return '用户中断'
  if (isWaitingDecision(activity))
    return '等待决策'
  if (isBackgroundAction(activity))
    return '后台运行'
  if (isStuck(activity))
    return '可能卡住'
  if (activity.status === 'running')
    return '运行中'
  if (activity.status === 'completed')
    return '完成'
  if (activity.status === 'suppressed')
    return '已合并'
  return '失败'
}

function statusIcon(activity: Activity) {
  if (activity.userInterrupted)
    return 'i-solar:stop-circle-bold-duotone'
  if (isWaitingDecision(activity))
    return 'i-solar:pause-circle-bold-duotone'
  if (isStuck(activity))
    return 'i-solar:danger-triangle-bold-duotone'
  if (isBackgroundAction(activity) || activity.status === 'running')
    return 'i-svg-spinners:ring-resize'
  if (activity.status === 'completed')
    return 'i-solar:check-circle-bold-duotone'
  if (activity.status === 'suppressed')
    return 'i-solar:minimize-square-2-bold-duotone'
  return 'i-solar:close-circle-bold-duotone'
}

function statusTone(activity: Activity) {
  if (activity.userInterrupted)
    return 'border-zinc-300/70 bg-zinc-50/90 text-zinc-800 dark:border-zinc-400/40 dark:bg-zinc-950/70 dark:text-zinc-100'
  if (isWaitingDecision(activity))
    return 'border-amber-300/70 bg-amber-50/90 text-amber-800 dark:border-amber-400/40 dark:bg-amber-950/70 dark:text-amber-100'
  if (isStuck(activity))
    return 'border-amber-300/70 bg-amber-50/90 text-amber-800 dark:border-amber-400/40 dark:bg-amber-950/70 dark:text-amber-100'
  if (isBackgroundAction(activity) || activity.status === 'running')
    return 'border-sky-300/70 bg-sky-50/90 text-sky-800 dark:border-sky-400/40 dark:bg-sky-950/70 dark:text-sky-100'
  if (activity.status === 'completed')
    return 'border-emerald-300/70 bg-emerald-50/90 text-emerald-800 dark:border-emerald-400/40 dark:bg-emerald-950/70 dark:text-emerald-100'
  if (activity.status === 'suppressed')
    return 'border-violet-300/70 bg-violet-50/90 text-violet-800 dark:border-violet-400/40 dark:bg-violet-950/70 dark:text-violet-100'
  return 'border-rose-300/70 bg-rose-50/90 text-rose-800 dark:border-rose-400/40 dark:bg-rose-950/70 dark:text-rose-100'
}

function displayTarget(target: string) {
  const [server, tool] = target.split('::')
  if (!tool)
    return target
  return `${server} / ${tool}`
}

function displayToolLabel(target: string) {
  return TOOL_NAME_LABELS[target] ?? 'Minecraft 工具'
}

function stringifyPreview(value: unknown, maxLength = 180) {
  if (value == null)
    return ''
  let text = ''
  try {
    text = typeof value === 'string'
      ? value
      : JSON.stringify(value)
  }
  catch {
    text = '[无法序列化]'
  }
  if (!text)
    return ''
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text
}

function extractResultText(result: unknown) {
  if (!result || typeof result !== 'object')
    return stringifyPreview(result, 1000)

  const record = result as Record<string, unknown>
  const content = record.content
  if (Array.isArray(content)) {
    const text = content
      .map((item) => {
        if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string')
          return (item as Record<string, string>).text
        return ''
      })
      .filter(Boolean)
      .join('\n')
    if (text)
      return text
  }
  return stringifyPreview(result, 1000)
}

function resultPreview(activity: Pick<Activity, 'error' | 'result'> & Partial<Pick<Activity, 'backgroundStatusText' | 'backgroundPhase' | 'backgroundLifecycleStatus'>>) {
  if (activity.error)
    return activity.error
  if (activity.backgroundLifecycleStatus === 'waiting_for_decision' && activity.backgroundStatusText)
    return activity.backgroundStatusText
  if (activity.backgroundPhase && activity.backgroundStatusText)
    return activity.backgroundStatusText
  return stringifyPreview(extractResultText(activity.result), 220)
}

function minecraftStructured(activity: Pick<Activity, 'result'>): Record<string, unknown> | undefined {
  if (!activity.result || typeof activity.result !== 'object')
    return undefined
  const structured = (activity.result as Record<string, unknown>).structuredContent
  return isRecord(structured) ? structured : undefined
}

function parseBackgroundActionId(text: string) {
  const match = text.match(/Started Minecraft background action id=(\d+)/i)
  if (!match)
    return undefined
  return Number.parseInt(match[1], 10)
}

function parseCurrentActionId(statusText: string) {
  const jsonId = statusText.match(/"id"\s*:\s*(\d+)/)
  if (jsonId)
    return Number.parseInt(jsonId[1], 10)

  const textId = statusText.match(/Current action:[\s\S]*?\bid=(\d+)/i)
  if (textId)
    return Number.parseInt(textId[1], 10)

  return undefined
}

function parseCurrentActionSnapshot(statusText: string): Record<string, unknown> | undefined {
  const startMarker = 'Current action:'
  const endMarker = '\nAuto eat:'
  const start = statusText.indexOf(startMarker)
  if (start < 0)
    return undefined

  const valueStart = start + startMarker.length
  const end = statusText.indexOf(endMarker, valueStart)
  const raw = statusText.slice(valueStart, end >= 0 ? end : undefined).trim()
  if (!raw.startsWith('{'))
    return undefined

  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : undefined
  }
  catch {
    return undefined
  }
}

function parseLastResult(statusText: string) {
  const marker = 'last result:'
  const index = statusText.toLowerCase().lastIndexOf(marker)
  if (index < 0)
    return ''
  return statusText.slice(index + marker.length).trim()
}

function settleBackgroundAction(activity: Activity, status: 'completed' | 'failed', message: string) {
  activity.backgroundActive = false
  activity.status = status
  activity.endedAt = Date.now()
  activity.durationMs = activity.endedAt - activity.startedAt
  activity.backgroundStatusText = message
  activity.result = {
    content: [{ type: 'text', text: message }],
  }
  if (status === 'failed')
    activity.error = message
  activity.updatedAt = activity.endedAt
}

async function pollBackgroundActionStatus() {
  const activeBackground = activities.value.filter(activity =>
    activity.backgroundActive
    && !isWaitingDecision(activity)
    && !activity.userInterrupted
    && typeof activity.backgroundActionId === 'number',
  )
  if (activeBackground.length === 0 || statusPollInFlight)
    return

  statusPollInFlight = true
  try {
    const result = await callMcpTool({
      name: 'minecraft::get-action-status',
      arguments: {},
      debug: {
        modelToolName: 'ui_minecraft_action_status_poll',
        mcpTarget: 'minecraft::get-action-status',
      },
    })
    const statusText = extractResultText(result)
    const currentSnapshot = parseCurrentActionSnapshot(statusText)
    const currentId = parseCurrentActionId(statusText)
    const lastResult = parseLastResult(statusText)
    const isIdle = /Current action:\s*idle/i.test(statusText)

    let changed = false
    for (const activity of activeBackground) {
      if (currentId === activity.backgroundActionId) {
        if (currentSnapshot) {
          activity.backgroundLifecycleStatus = typeof currentSnapshot.status === 'string' ? currentSnapshot.status : undefined
          activity.backgroundPhase = typeof currentSnapshot.phase === 'string' ? currentSnapshot.phase : undefined
          const decision = isRecord(currentSnapshot.decision) ? currentSnapshot.decision : undefined
          activity.backgroundStatusText = typeof decision?.message === 'string'
            ? decision.message
            : activity.backgroundPhase
              ? `Minecraft action phase: ${activity.backgroundPhase}`
              : activity.backgroundStatusText
          if (activity.backgroundLifecycleStatus === 'waiting_for_decision') {
            activity.backgroundActive = false
            activity.status = 'completed'
            activity.endedAt = Date.now()
            activity.durationMs = activity.endedAt - activity.startedAt
          }
          activity.updatedAt = Date.now()
          changed = true
        }
        continue
      }

      const message = currentId != null && currentId !== activity.backgroundActionId
        ? `Minecraft 后台动作 ${activity.backgroundActionId} 已不再是当前动作；当前动作是 ${currentId}。它可能已结束，或被新的动作替换。`
        : lastResult || (isIdle
          ? `Minecraft 后台动作 ${activity.backgroundActionId} 已结束，当前没有正在执行的动作。`
          : `Minecraft 后台动作 ${activity.backgroundActionId} 已不在当前动作状态中。`)

      const failed = /^Failed:/i.test(lastResult)
        || /^Cancelled:/i.test(lastResult)
        || /Stopped current Minecraft action/i.test(lastResult)
      settleBackgroundAction(activity, failed ? 'failed' : 'completed', message)
      changed = true
    }

    if (changed) {
      activities.value = sortedActivities.value.slice(0, MAX_ITEMS)
      persistActivitySnapshot()
    }
  }
  catch (error) {
    console.warn('[MinecraftMcpMonitor] Failed to poll background action status:', error)
  }
  finally {
    statusPollInFlight = false
  }
}

function appendUserInterruptNotice(activity: Activity, resultText: string) {
  const sessionId = chatSession.activeSessionId
  if (!sessionId)
    return

  const content = [
    '[system_notice]',
    'title: Minecraft MCP 动作被用户中断',
    'status: cancelled',
    `target: ${activity.target}`,
    activity.modelToolName ? `modelToolName: ${activity.modelToolName}` : '',
    'message: 用户刚刚在 MCP 活动浮窗中强行中断了当前 Minecraft 动作。Lumi 应当把这次结果视为用户主动取消，而不是自然失败；不要立即用相同参数重复尝试，除非用户明确要求或新的观察显示必须这么做。',
    `cancelResult: ${resultText}`,
  ].filter(Boolean).join('\n')

  chatSession.setSessionMessages(sessionId, [
    ...chatSession.getSessionMessages(sessionId),
    {
      id: `minecraft-mcp-cancel-${Date.now().toString(36)}`,
      role: 'system',
      content,
      createdAt: Date.now(),
    },
  ])
}

async function interruptActivity(activity: Activity) {
  if (!isActionActive(activity) || cancellingTraceIds.value.has(activity.traceId))
    return

  cancellingTraceIds.value = new Set([...cancellingTraceIds.value, activity.traceId])
  try {
    const result = await callMcpTool({
      name: 'minecraft::cancel-action',
      arguments: {
        reason: `cancelled by user from MCP activity monitor while ${activity.target} was active`,
      },
      debug: {
        modelToolName: 'ui_minecraft_cancel_action',
        mcpTarget: 'minecraft::cancel-action',
      },
    })
    const resultText = stringifyPreview(extractResultText(result), 500) || 'cancel-action returned no text'
    activity.userInterrupted = true
    activity.backgroundActive = false
    activity.status = 'failed'
    activity.error = `用户已中断。${resultText}`
    activity.endedAt = Date.now()
    activity.durationMs = activity.endedAt - activity.startedAt
    activity.updatedAt = activity.endedAt
    appendUserInterruptNotice(activity, resultText)
    persistActivitySnapshot()
  }
  catch (error) {
    activity.error = errorMessageFrom(error) ?? String(error)
    activity.status = 'failed'
    activity.backgroundActive = false
    activity.endedAt = Date.now()
    activity.durationMs = activity.endedAt - activity.startedAt
    activity.updatedAt = activity.endedAt
    persistActivitySnapshot()
  }
  finally {
    const next = new Set(cancellingTraceIds.value)
    next.delete(activity.traceId)
    cancellingTraceIds.value = next
  }
}
</script>

<template>
  <div
    v-if="panelOpen"
    :class="props.standalone ? 'h-screen w-screen p-2' : 'pointer-events-none fixed z-60 max-w-[calc(100vw-2rem)]'"
    :style="panelStyle"
  >
    <button
      v-if="collapsed"
      class="pointer-events-auto h-10 flex items-center gap-2 border border-neutral-200/80 rounded-lg bg-white/90 px-3 text-sm text-neutral-800 shadow-black/10 shadow-lg backdrop-blur-md transition dark:border-white/12 dark:bg-neutral-950/80 hover:bg-white dark:text-neutral-100 dark:hover:bg-neutral-900"
      title="展开 Minecraft MCP 活动"
      type="button"
      @click="collapsed = false"
    >
      <span class="i-solar:gamepad-bold-duotone size-4 text-emerald-500" />
      <span class="font-medium">Minecraft MCP</span>
      <span
        v-if="runningCount > 0"
        class="rounded-full bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-700 dark:bg-sky-400/15 dark:text-sky-200"
      >
        {{ runningCount }}
      </span>
    </button>

    <section
      v-else
      class="pointer-events-auto max-h-full flex flex-col overflow-hidden border border-white/70 rounded-lg bg-white/92 text-neutral-900 shadow-2xl shadow-black/15 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/84 dark:text-neutral-50"
      :class="props.standalone ? 'h-full w-full' : 'w-[min(25rem,calc(100vw-2rem))]'"
      aria-label="Minecraft MCP 活动"
    >
      <header
        class="app-region-drag flex cursor-move items-center justify-between gap-3 border-b border-neutral-200/70 px-3 py-2 dark:border-white/10"
        @pointerdown="beginDrag"
      >
        <div class="min-w-0 flex items-center gap-2">
          <span class="i-solar:gamepad-bold-duotone size-4 shrink-0 text-emerald-500" />
          <div class="min-w-0">
            <div class="truncate text-sm font-semibold">
              Minecraft MCP 活动
            </div>
            <div class="mt-0.5 flex flex-wrap gap-1 text-[11px] text-neutral-500 dark:text-neutral-400">
              <span>{{ runningCount }} 运行中</span>
              <span v-if="stuckCount > 0" class="text-amber-600 dark:text-amber-300">{{ stuckCount }} 可能卡住</span>
              <span v-if="activities.length === 0">等待 Mineflayer 工具调用</span>
            </div>
          </div>
        </div>

        <div class="app-region-no-drag flex shrink-0 items-center gap-1">
          <button
            class="grid size-7 cursor-pointer place-items-center rounded-md text-neutral-500 transition hover:bg-neutral-100 dark:text-neutral-400 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
            title="清除已完成"
            type="button"
            @pointerdown.stop
            @click="clearSettled"
          >
            <span class="i-solar:eraser-bold-duotone size-4" />
          </button>
          <button
            class="grid size-7 cursor-pointer place-items-center rounded-md text-neutral-500 transition hover:bg-neutral-100 dark:text-neutral-400 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
            title="收起"
            type="button"
            @pointerdown.stop
            @click="collapsed = true"
          >
            <span class="i-solar:minimize-square-3-bold-duotone size-4" />
          </button>
          <button
            class="grid size-7 cursor-pointer place-items-center rounded-md text-neutral-500 transition hover:bg-neutral-100 dark:text-neutral-400 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
            title="关闭"
            type="button"
            @pointerdown.stop
            @click="closePanel"
          >
            <span class="i-solar:close-circle-bold-duotone size-4" />
          </button>
        </div>
      </header>

      <div class="scrollbar-track-transparent scrollbar-thumb-neutral-300 dark:scrollbar-thumb-neutral-700 min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
        <div
          v-if="visibleActivities.length === 0"
          class="grid min-h-28 place-items-center border border-neutral-200 rounded-md border-dashed text-xs text-neutral-500 dark:border-white/10 dark:text-neutral-400"
        >
          暂无 Minecraft MCP 调用
        </div>

        <div v-else class="space-y-2">
          <article
            v-for="activity in visibleActivities"
            :key="activity.traceId"
            class="overflow-hidden border rounded-md bg-white/80 shadow-sm dark:bg-neutral-900/70"
            :class="statusTone(activity)"
          >
            <div class="flex items-start gap-2 p-2">
              <span :class="[statusIcon(activity), 'mt-0.5 size-4 shrink-0']" />
              <div class="min-w-0 flex-1">
                <div class="min-w-0 flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <div class="truncate text-xs font-semibold">
                      {{ displayToolLabel(activity.target) }}
                    </div>
                    <div class="mt-0.5 truncate text-[10px] font-mono opacity-75">
                      MCP 原名: {{ activity.target }}
                    </div>
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <button
                      v-if="isActionActive(activity)"
                      class="rounded-full bg-rose-500/12 px-1.5 py-0.5 text-[10px] text-rose-700 font-semibold transition disabled:cursor-not-allowed hover:bg-rose-500/20 dark:text-rose-200 disabled:opacity-60"
                      :disabled="cancellingTraceIds.has(activity.traceId)"
                      title="中断当前 Minecraft 动作"
                      type="button"
                      @click="interruptActivity(activity)"
                    >
                      {{ cancellingTraceIds.has(activity.traceId) ? '中断中' : '中断' }}
                    </button>
                    <div class="rounded-full bg-white/65 px-1.5 py-0.5 text-[10px] font-medium dark:bg-black/20">
                      {{ statusLabel(activity) }}
                    </div>
                  </div>
                </div>

                <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] opacity-78">
                  <span>{{ formatDuration(elapsedMs(activity)) }}</span>
                  <span class="truncate">{{ displayTarget(activity.target) }}</span>
                  <span v-if="activity.modelToolName" class="truncate font-mono">模型入口: {{ activity.modelToolName }}</span>
                  <span v-if="activity.modelToolCallId" class="truncate font-mono">{{ activity.modelToolCallId }}</span>
                </div>

                <div
                  v-if="stringifyPreview(activity.arguments)"
                  class="mt-1 break-words rounded bg-white/60 px-1.5 py-1 text-[10px] leading-snug font-mono dark:bg-black/20"
                >
                  {{ stringifyPreview(activity.arguments) }}
                </div>

                <div
                  v-if="resultPreview(activity)"
                  class="mt-1 whitespace-pre-wrap break-words text-[11px] leading-snug opacity-86"
                >
                  {{ resultPreview(activity) }}
                </div>
              </div>
            </div>

            <div
              v-if="isActionActive(activity)"
              class="h-0.75 overflow-hidden bg-black/5 dark:bg-white/8"
            >
              <div class="mcp-activity-runner h-full w-1/2 bg-current opacity-55" />
            </div>
          </article>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.app-region-drag {
  -webkit-app-region: drag;
}

.app-region-no-drag,
button {
  -webkit-app-region: no-drag;
}

.mcp-activity-runner {
  animation: mcp-activity-runner 1.2s ease-in-out infinite;
}

@keyframes mcp-activity-runner {
  0% {
    transform: translateX(-120%);
  }

  100% {
    transform: translateX(220%);
  }
}
</style>
