<script setup lang="ts">
import { useElectronEventaInvoke } from '@proj-airi/electron-vueuse'
import { electron } from '@proj-airi/electron-eventa'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useLumiAgentStore } from '@proj-airi/stage-ui/stores/lumi-agent'
import { useLocalStorage } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { electronOpenSettings, electronStartDraggingWindow, electronWindowAnimateBounds, electronWindowClose, electronWindowSetAlwaysOnTop, electronWindowStopBoundsAnimation } from '../../shared/eventa'
import InteractiveArea from '../components/InteractiveArea.vue'
import { useChatSyncStore } from '../stores/chat-sync'
import { useLumiProactiveVisionStore } from '../stores/lumi-proactive-vision'
import { useStageWindowLifecycleStore } from '../stores/stage-window-lifecycle'

const lifecycleStore = useStageWindowLifecycleStore()
const chatSession = useChatSessionStore()
const chatSyncStore = useChatSyncStore()
const lumiAgentStore = useLumiAgentStore()
const proactiveVisionStore = useLumiProactiveVisionStore()
const { windowLifecycle } = storeToRefs(lifecycleStore)
const { messages } = storeToRefs(chatSession)
const {
  enabled: proactiveEnabled,
  running: proactiveRunning,
  processing: proactiveProcessing,
  configured: proactiveConfigured,
  currentActivity,
  lastSalience,
  lastCaptureAt,
} = storeToRefs(proactiveVisionStore)

const miniChatEnabled = useLocalStorage('settings/plugins/lumi-chat-mini/enabled', false)
const inactiveOpacity = useLocalStorage('settings/plugins/lumi-chat-mini/inactive-opacity', 0.62)
const alwaysOnTop = useLocalStorage('settings/plugins/lumi-chat-mini/always-on-top', true)
const edgeDockEnabled = useLocalStorage('settings/plugins/lumi-chat-mini/edge-dock-enabled', true)
const edgeDockThreshold = useLocalStorage('settings/plugins/lumi-chat-mini/edge-dock-threshold', 24)
const edgeDockVisibleSize = useLocalStorage('settings/plugins/lumi-chat-mini/edge-dock-visible-size', 18)
const proactiveRuntimeStatus = useLocalStorage<Record<string, any>>('runtime/lumi-proactive-vision/status', {})
const flashActive = ref(false)

const closeWindow = useElectronEventaInvoke(electronWindowClose)
const setAlwaysOnTop = useElectronEventaInvoke(electronWindowSetAlwaysOnTop)
const openSettings = useElectronEventaInvoke(electronOpenSettings)
const startDraggingWindow = useElectronEventaInvoke(electronStartDraggingWindow)
const animateWindowBounds = useElectronEventaInvoke(electronWindowAnimateBounds)
const stopWindowBoundsAnimation = useElectronEventaInvoke(electronWindowStopBoundsAnimation)
const getWindowBounds = useElectronEventaInvoke(electron.window.getBounds)
const getAllDisplays = useElectronEventaInvoke(electron.screen.getAllDisplays)
const getCursorScreenPoint = useElectronEventaInvoke(electron.screen.getCursorScreenPoint)

let flashReady = false
let seenMessageCount = 0
let flashTimer: ReturnType<typeof setTimeout> | undefined
let readyTimer: ReturnType<typeof setTimeout> | undefined
let edgeMonitorTimer: ReturnType<typeof setInterval> | undefined
let dockAnimating = false
let suppressExpandUntil = 0
let lastPointerExpandCheckAt = 0
let dragStartedDockState: MiniChatDockState | undefined
let dragGuardTimer: ReturnType<typeof setTimeout> | undefined
let dragSettleTimer: ReturnType<typeof setInterval> | undefined
let dragSettleLastBounds = ''
let dragSettleStableCount = 0
let dragSettleStartedAt = 0
let edgeMonitorBusy = false
let resizeSettledTimer: ReturnType<typeof setTimeout> | undefined

type MiniChatDockEdge = 'left' | 'right' | 'top' | 'bottom'
type MiniChatDockState = 'free' | 'collapsed' | 'expanded'

interface MiniChatBounds {
  x: number
  y: number
  width: number
  height: number
}

interface MiniChatWorkArea {
  x: number
  y: number
  width: number
  height: number
}

interface MiniChatPoint {
  x: number
  y: number
}

const dockState = ref<MiniChatDockState>('free')
const dockedEdge = ref<MiniChatDockEdge | null>(null)
const dockVisualOffset = ref({ x: 0, y: 0 })
const dockVisualTransition = ref('none')
const windowResizing = ref(false)

const proactiveRuntimeFresh = computed(() => {
  const updatedAt = Number(proactiveRuntimeStatus.value.updatedAt || 0)
  return updatedAt > 0 && Date.now() - updatedAt < 15 * 60 * 1000
})

const syncedProactiveRunning = computed(() => {
  return proactiveRunning.value || (proactiveRuntimeFresh.value && proactiveRuntimeStatus.value.running === true)
})

const syncedProactiveProcessing = computed(() => {
  return proactiveProcessing.value || (proactiveRuntimeFresh.value && proactiveRuntimeStatus.value.processing === true)
})

const proactiveStatusText = computed(() => {
  if (syncedProactiveProcessing.value)
    return '观察中'
  if (syncedProactiveRunning.value)
    return '运行中'
  if (proactiveEnabled.value || proactiveRuntimeStatus.value.enabled)
    return '已启用，等待调度'
  if (!proactiveConfigured.value && !proactiveRuntimeStatus.value.configured)
    return '未配置'
  return '未启用'
})

const activityLabels: Record<string, string> = {
  video: '视频',
  coding: '编程',
  reading: '阅读',
  browsing: '浏览',
  chatting: '聊天',
  gaming: '游戏',
  creative: '创作',
  settings: '设置',
  idle: '空闲',
  unknown: '未知',
}

const salienceLabels: Record<string, string> = {
  low: '低关注',
  medium: '中关注',
  high: '高关注',
}

const proactiveContextText = computed(() => {
  const activity = String(proactiveRuntimeStatus.value.currentActivity || currentActivity.value || 'unknown')
  const salience = String(proactiveRuntimeStatus.value.lastSalience || lastSalience.value || 'low')
  const captureAt = Number(proactiveRuntimeStatus.value.lastCaptureAt || lastCaptureAt.value || 0)
  if (!captureAt)
    return '暂无观察结果'
  return `${activityLabels[activity] || activity} · ${salienceLabels[salience] || salience}`
})

const shellStyle = computed(() => {
  const style: Record<string, string> = {
    opacity: windowLifecycle.value.focused || flashActive.value ? '1' : String(inactiveOpacity.value),
    transform: `translate3d(${dockVisualOffset.value.x}px, ${dockVisualOffset.value.y}px, 0)`,
    transition: dockVisualTransition.value === 'none'
      ? 'opacity 160ms ease'
      : `${dockVisualTransition.value}, opacity 160ms ease`,
    willChange: 'transform, opacity',
    backfaceVisibility: 'hidden',
    contain: 'layout paint',
  }

  return style
})

function triggerIncomingMessageFlash() {
  flashActive.value = false
  requestAnimationFrame(() => {
    flashActive.value = true
    if (flashTimer)
      clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      flashActive.value = false
      flashTimer = undefined
    }, 1400)
  })
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function areaRight(area: MiniChatWorkArea) {
  return area.x + area.width
}

function areaBottom(area: MiniChatWorkArea) {
  return area.y + area.height
}

function boundsCenter(bounds: MiniChatBounds) {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  }
}

function pointInBounds(point: MiniChatPoint, bounds: MiniChatBounds, margin = 0) {
  return point.x >= bounds.x - margin
    && point.x <= bounds.x + bounds.width + margin
    && point.y >= bounds.y - margin
    && point.y <= bounds.y + bounds.height + margin
}

function workAreaForBounds(bounds: MiniChatBounds, displays: Array<{ workArea: MiniChatWorkArea }>) {
  const center = boundsCenter(bounds)
  const containing = displays.find((display) => {
    const area = display.workArea
    return center.x >= area.x && center.x <= areaRight(area) && center.y >= area.y && center.y <= areaBottom(area)
  })
  if (containing)
    return containing.workArea

  return displays
    .map(display => ({
      area: display.workArea,
      distance: Math.abs(center.x - (display.workArea.x + display.workArea.width / 2))
        + Math.abs(center.y - (display.workArea.y + display.workArea.height / 2)),
    }))
    .sort((a, b) => a.distance - b.distance)[0]?.area
}

function nearestDockEdge(bounds: MiniChatBounds, area: MiniChatWorkArea, includeCollapsed = false): MiniChatDockEdge | null {
  const threshold = edgeDockThreshold.value
  const visible = clamp(edgeDockVisibleSize.value, 10, 64)

  if (includeCollapsed) {
    const collapsedCandidates: Array<{ edge: MiniChatDockEdge, distance: number }> = []
    const boundsRight = bounds.x + bounds.width
    const boundsBottom = bounds.y + bounds.height

    if (bounds.x < area.x && boundsRight <= area.x + visible + threshold)
      collapsedCandidates.push({ edge: 'left', distance: Math.abs(boundsRight - area.x) })
    if (bounds.x >= areaRight(area) - visible - threshold && boundsRight > areaRight(area))
      collapsedCandidates.push({ edge: 'right', distance: Math.abs(areaRight(area) - bounds.x) })
    if (bounds.y < area.y && boundsBottom <= area.y + visible + threshold)
      collapsedCandidates.push({ edge: 'top', distance: Math.abs(boundsBottom - area.y) })
    if (bounds.y >= areaBottom(area) - visible - threshold && boundsBottom > areaBottom(area))
      collapsedCandidates.push({ edge: 'bottom', distance: Math.abs(areaBottom(area) - bounds.y) })

    const collapsedEdge = collapsedCandidates.sort((a, b) => a.distance - b.distance)[0]?.edge
    if (collapsedEdge)
      return collapsedEdge
  }

  const edgeCandidates: Array<{ edge: MiniChatDockEdge, distance: number }> = [
    { edge: 'left', distance: bounds.x - area.x },
    { edge: 'right', distance: areaRight(area) - (bounds.x + bounds.width) },
    { edge: 'top', distance: bounds.y - area.y },
    { edge: 'bottom', distance: areaBottom(area) - (bounds.y + bounds.height) },
  ]
  const candidates = edgeCandidates.filter(candidate => candidate.distance <= threshold)

  return candidates.sort((a, b) => a.distance - b.distance)[0]?.edge ?? null
}

function isCollapsedAtEdge(bounds: MiniChatBounds, area: MiniChatWorkArea, edge: MiniChatDockEdge) {
  const visible = clamp(edgeDockVisibleSize.value, 10, 64)
  const tolerance = 4
  const boundsRight = bounds.x + bounds.width
  const boundsBottom = bounds.y + bounds.height

  if (edge === 'left')
    return bounds.x < area.x && Math.abs(boundsRight - (area.x + visible)) <= tolerance + edgeDockThreshold.value
  if (edge === 'right')
    return boundsRight > areaRight(area) && Math.abs(bounds.x - (areaRight(area) - visible)) <= tolerance + edgeDockThreshold.value
  if (edge === 'top')
    return bounds.y < area.y && Math.abs(boundsBottom - (area.y + visible)) <= tolerance + edgeDockThreshold.value
  return boundsBottom > areaBottom(area) && Math.abs(bounds.y - (areaBottom(area) - visible)) <= tolerance + edgeDockThreshold.value
}

function collapsedBounds(bounds: MiniChatBounds, area: MiniChatWorkArea, edge: MiniChatDockEdge): MiniChatBounds {
  const visible = clamp(edgeDockVisibleSize.value, 10, 64)
  const x = clamp(bounds.x, area.x, Math.max(area.x, areaRight(area) - bounds.width))
  const y = clamp(bounds.y, area.y, Math.max(area.y, areaBottom(area) - bounds.height))

  if (edge === 'left')
    return { ...bounds, x: area.x - bounds.width + visible, y }
  if (edge === 'right')
    return { ...bounds, x: areaRight(area) - visible, y }
  if (edge === 'top')
    return { ...bounds, x, y: area.y - bounds.height + visible }
  return { ...bounds, x, y: areaBottom(area) - visible }
}

function expandedBounds(bounds: MiniChatBounds, area: MiniChatWorkArea, edge: MiniChatDockEdge): MiniChatBounds {
  const x = clamp(bounds.x, area.x, Math.max(area.x, areaRight(area) - bounds.width))
  const y = clamp(bounds.y, area.y, Math.max(area.y, areaBottom(area) - bounds.height))

  if (edge === 'left')
    return { ...bounds, x: area.x, y }
  if (edge === 'right')
    return { ...bounds, x: areaRight(area) - bounds.width, y }
  if (edge === 'top')
    return { ...bounds, x, y: area.y }
  return { ...bounds, x, y: areaBottom(area) - bounds.height }
}

async function resolveDockContext(options: { includeCollapsed?: boolean } = {}) {
  const [bounds, displays, cursor] = await Promise.all([getWindowBounds(), getAllDisplays(), getCursorScreenPoint()])
  if (!bounds.width || !bounds.height || !displays.length)
    return null

  const area = workAreaForBounds(bounds, displays)
  if (!area)
    return null

  const edge = nearestDockEdge(bounds, area, options.includeCollapsed)
  if (!edge)
    return null

  return { bounds, area, edge, cursor, cursorInside: pointInBounds(cursor, bounds, 1) }
}

function serializeBounds(bounds: MiniChatBounds) {
  return `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
}

function cancelDockAnimation() {
  setDockAnimating(false)
  dockVisualTransition.value = 'none'
  dockVisualOffset.value = { x: 0, y: 0 }
  void stopWindowBoundsAnimation()
}

function setDockAnimating(value: boolean) {
  dockAnimating = value
}

async function slideCollapseToEdge(target: MiniChatBounds) {
  cancelDockAnimation()
  setDockAnimating(true)
  try {
    dockVisualTransition.value = 'none'
    dockVisualOffset.value = { x: 0, y: 0 }
    await animateWindowBounds([target, 155])
  }
  finally {
    setDockAnimating(false)
  }
}

async function slideExpandFromEdge(target: MiniChatBounds) {
  cancelDockAnimation()
  setDockAnimating(true)
  try {
    dockVisualTransition.value = 'none'
    dockVisualOffset.value = { x: 0, y: 0 }
    await animateWindowBounds([target, 145])
  }
  finally {
    setDockAnimating(false)
  }
}

async function collapseToEdge(options: { ignoreCursorInside?: boolean } = {}) {
  if (!edgeDockEnabled.value || dockAnimating)
    return

  const context = await resolveDockContext()
  if (!context)
    return
  if (!options.ignoreCursorInside && context.cursorInside)
    return

  dockedEdge.value = context.edge
  dockState.value = 'collapsed'
  suppressExpandUntil = Date.now() + 300
  await slideCollapseToEdge(collapsedBounds(context.bounds, context.area, context.edge))
}

async function expandFromEdge() {
  if (!edgeDockEnabled.value || dockAnimating || Date.now() < suppressExpandUntil)
    return

  const context = await resolveDockContext({ includeCollapsed: true })
  if (!context)
    return

  if (!isCollapsedAtEdge(context.bounds, context.area, context.edge))
    return

  dockedEdge.value = context.edge
  dockState.value = 'expanded'
  await slideExpandFromEdge(expandedBounds(context.bounds, context.area, context.edge))
}

function stopDragSettleWatcher() {
  if (!dragSettleTimer)
    return
  clearInterval(dragSettleTimer)
  dragSettleTimer = undefined
}

function startDragSettleWatcher() {
  stopDragSettleWatcher()
  dragSettleLastBounds = ''
  dragSettleStableCount = 0
  dragSettleStartedAt = Date.now()

  dragSettleTimer = setInterval(() => {
    void (async () => {
      const bounds = await getWindowBounds()
      const serialized = serializeBounds(bounds)
      if (serialized === dragSettleLastBounds) {
        dragSettleStableCount += 1
      }
      else {
        dragSettleLastBounds = serialized
        dragSettleStableCount = 0
      }

      const elapsed = Date.now() - dragSettleStartedAt
      if (dragSettleStableCount < 2 && elapsed < 1800)
        return

      stopDragSettleWatcher()
      if (dragGuardTimer) {
        clearTimeout(dragGuardTimer)
        dragGuardTimer = undefined
      }
      dragStartedDockState = undefined
      suppressExpandUntil = Date.now() + 160
      void collapseToEdge({ ignoreCursorInside: true }).catch(error => console.warn('[mini-chat] edge dock collapse after drag failed', error))
    })().catch(error => console.warn('[mini-chat] edge dock drag settle failed', error))
  }, 90)
}

async function inspectEdgeDockState() {
  if (!edgeDockEnabled.value || dockAnimating)
    return
  if (windowResizing.value)
    return
  if (dragStartedDockState)
    return
  if (edgeMonitorBusy)
    return

  edgeMonitorBusy = true
  try {
    const context = await resolveDockContext({ includeCollapsed: true })
    if (!context) {
      dockState.value = 'free'
      dockedEdge.value = null
      return
    }

    const collapsed = isCollapsedAtEdge(context.bounds, context.area, context.edge)
    if (collapsed) {
      dockState.value = 'collapsed'
      dockedEdge.value = context.edge
      if (context.cursorInside)
        void expandFromEdge().catch(error => console.warn('[mini-chat] edge dock expand failed', error))
      return
    }

    if (context.cursorInside) {
      dockState.value = dockState.value === 'collapsed' ? 'expanded' : dockState.value
      return
    }

    await collapseToEdge()
  }
  finally {
    edgeMonitorBusy = false
  }
}

function handlePointerLeave() {
}

function handlePointerMove() {
  if (dockState.value !== 'collapsed')
    return

  const now = Date.now()
  if (now - lastPointerExpandCheckAt < 180)
    return

  lastPointerExpandCheckAt = now
  void expandFromEdge().catch(error => console.warn('[mini-chat] edge dock expand failed', error))
}

function isControlTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && Boolean(target.closest('[data-mini-chat-no-drag]'))
}

function handleTitleMouseDown(event: MouseEvent) {
  if (event.button !== 0 || isControlTarget(event.target))
    return

  event.preventDefault()
  dragStartedDockState = dockState.value
  dockState.value = 'free'
  dockedEdge.value = null
  suppressExpandUntil = Date.now() + 900
  if (dragGuardTimer)
    clearTimeout(dragGuardTimer)
  dragGuardTimer = setTimeout(() => {
    dragStartedDockState = undefined
    dragGuardTimer = undefined
    void collapseToEdge({ ignoreCursorInside: true }).catch(error => console.warn('[mini-chat] edge dock fallback collapse failed', error))
  }, 1800)
  cancelDockAnimation()
  startDragSettleWatcher()
  void startDraggingWindow().catch(error => console.warn('[mini-chat] native drag failed', error))
}

function handleTitleMouseUp() {
  stopDragSettleWatcher()
  if (dragGuardTimer) {
    clearTimeout(dragGuardTimer)
    dragGuardTimer = undefined
  }
  dragStartedDockState = undefined
  void collapseToEdge({ ignoreCursorInside: true }).catch(error => console.warn('[mini-chat] edge dock mouseup collapse failed', error))
}

function markWindowResizing() {
  windowResizing.value = true
  if (resizeSettledTimer)
    clearTimeout(resizeSettledTimer)
  resizeSettledTimer = setTimeout(() => {
    windowResizing.value = false
    resizeSettledTimer = undefined
  }, 180)
}

watch(alwaysOnTop, (value) => {
  void setAlwaysOnTop(Boolean(value))
}, { immediate: true })

watch(() => messages.value.length, (count) => {
  if (!flashReady) {
    seenMessageCount = count
    return
  }

  if (count <= seenMessageCount) {
    seenMessageCount = count
    return
  }

  const newMessages = messages.value.slice(seenMessageCount)
  seenMessageCount = count

  if (windowLifecycle.value.focused)
    return
  if (newMessages.some(message => message.role === 'assistant' || message.role === 'error'))
    triggerIncomingMessageFlash()
})

onMounted(() => {
  seenMessageCount = messages.value.length
  readyTimer = setTimeout(() => {
    seenMessageCount = messages.value.length
    flashReady = true
  }, 1200)
  window.addEventListener('resize', markWindowResizing)
  edgeMonitorTimer = setInterval(() => {
    void inspectEdgeDockState().catch(error => console.warn('[mini-chat] edge dock monitor failed', error))
  }, 320)
})

onBeforeUnmount(() => {
  if (flashTimer)
    clearTimeout(flashTimer)
  if (readyTimer)
    clearTimeout(readyTimer)
  if (edgeMonitorTimer)
    clearInterval(edgeMonitorTimer)
  if (dragGuardTimer)
    clearTimeout(dragGuardTimer)
  if (resizeSettledTimer)
    clearTimeout(resizeSettledTimer)
  stopDragSettleWatcher()
  window.removeEventListener('resize', markWindowResizing)
  cancelDockAnimation()
})

function openPluginSettings() {
  void openSettings({ route: '/settings/plugins' })
}

function observeOnce() {
  void chatSyncStore.requestIngest({
    sessionId: chatSession.activeSessionId,
    hiddenUserMessage: true,
    text: [
      '[Lumi manual screen observation request]',
      'This is not a user message. The user clicked the floating chat Observe once button.',
      'If the `lumi_observe_screen` tool is available, call it now to look at the current screen, then reply naturally as Lumi in the normal chat.',
      'If screen observation fails or is unavailable, briefly tell the user what failed.',
      'Do not pretend the user sent an image. This is Lumi actively looking at the screen.',
      '[/Lumi manual screen observation request]',
    ].join('\n'),
    systemNotices: [
      [
        '[system_notice]',
        'status: requested',
        'activity: unknown',
        'salience: medium',
        'decision: mini_chat_requested_observe_once',
        'source: mini_chat',
        `observed_at: ${new Date().toLocaleString()}`,
        '',
        '浮窗请求 Lumi 主动观察一次屏幕。实际采集应由主聊天 authority 执行。',
      ].join('\n'),
    ],
  })
}

function closeMiniChat() {
  miniChatEnabled.value = false
  void closeWindow()
}
</script>

<template>
  <div
    :style="shellStyle"
    :class="[
      'h-full w-full flex flex-col overflow-hidden border border-primary-200/40 rounded-2xl bg-white/88 shadow-2xl shadow-black/20 backdrop-blur-xl transition-opacity duration-200 dark:border-primary-900/50 dark:bg-neutral-950/88',
      flashActive ? 'mini-chat-flash' : '',
      windowResizing ? 'mini-chat-resizing' : '',
    ]"
    @mouseenter="expandFromEdge"
    @mouseleave="handlePointerLeave"
    @mousemove="handlePointerMove"
  >
    <div
      class="h-10 shrink-0 cursor-move select-none flex items-center justify-between border-b border-neutral-200/70 px-3 dark:border-neutral-800/70"
      @mousedown="handleTitleMouseDown"
      @mouseup="handleTitleMouseUp"
    >
      <div class="min-w-0 flex items-center gap-2 text-sm font-semibold">
        <div class="i-solar:chat-round-like-bold-duotone size-5 text-primary-500" />
        <span class="truncate">Lumi Chat</span>
      </div>
      <div class="flex items-center gap-1" data-mini-chat-no-drag>
        <button
          class="h-7 w-7 flex items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-45 dark:hover:bg-neutral-800"
          type="button"
          title="观察一次屏幕"
          :disabled="proactiveProcessing"
          @click="observeOnce"
        >
          <div :class="proactiveProcessing ? 'i-eos-icons:three-dots-loading size-4' : 'i-solar:eye-scan-bold-duotone size-4'" />
        </button>
        <button
          class="h-7 w-7 flex items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-cyan-500 dark:hover:bg-neutral-800 dark:hover:text-cyan-300"
          type="button"
          title="Claude Code 任务"
          @click="lumiAgentStore.openTaskWindow()"
        >
          <div class="i-solar:archive-bold-duotone size-4" />
        </button>
        <button
          :class="[
            'h-7 w-7 flex items-center justify-center rounded-md transition-colors',
            alwaysOnTop ? 'bg-primary-100 text-primary-600 dark:bg-primary-900/40 dark:text-primary-200' : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800',
          ]"
          type="button"
          title="保持最前"
          @click="alwaysOnTop = !alwaysOnTop"
        >
          <div class="i-solar:pin-bold-duotone size-4" />
        </button>
        <button
          class="h-7 w-7 flex items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 dark:hover:bg-neutral-800"
          type="button"
          title="插件设置"
          @click="openPluginSettings"
        >
          <div class="i-solar:settings-bold-duotone size-4" />
        </button>
        <button
          class="h-7 w-7 flex items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-red-100 hover:text-red-500 dark:hover:bg-red-950/40"
          type="button"
          title="关闭"
          @click="closeMiniChat"
        >
          <div class="i-solar:close-circle-bold-duotone size-4" />
        </button>
      </div>
    </div>

    <div class="shrink-0 border-b border-neutral-200/60 px-3 py-1.5 text-xs text-neutral-600 dark:border-neutral-800/70 dark:text-neutral-300">
      <div class="flex min-w-0 items-center gap-2">
        <span
          :class="[
            'size-2 shrink-0 rounded-full',
            syncedProactiveRunning ? (syncedProactiveProcessing ? 'bg-amber-400' : 'bg-emerald-400') : proactiveEnabled ? 'bg-sky-400' : 'bg-neutral-300 dark:bg-neutral-700',
          ]"
        />
        <span class="truncate">主动视觉 {{ proactiveStatusText }}</span>
        <span v-if="false" class="truncate">
          主动视觉 {{ proactiveRunning ? (proactiveProcessing ? '观察中' : '运行中') : '未运行' }}
        </span>
        <span class="shrink-0 opacity-60">/</span>
        <span class="truncate">{{ proactiveContextText }}</span>
      </div>
    </div>

    <InteractiveArea class="mini-chat-content min-h-0 flex-1 p-3" />
  </div>
</template>

<style scoped>
.mini-chat-content {
  contain: layout paint;
}

.mini-chat-resizing {
  backdrop-filter: none !important;
  box-shadow: 0 10px 28px rgba(15, 23, 42, 0.18) !important;
}

.mini-chat-resizing :deep(*) {
  transition-duration: 0ms !important;
}

.mini-chat-flash {
  animation: mini-chat-incoming-flash 1.4s ease-out;
}

@keyframes mini-chat-incoming-flash {
  0% {
    border-color: rgba(56, 189, 248, 0.95);
    box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.78), 0 18px 42px rgba(15, 23, 42, 0.28);
  }
  42% {
    border-color: rgba(56, 189, 248, 0.98);
    box-shadow: 0 0 0 8px rgba(56, 189, 248, 0.28), 0 18px 42px rgba(15, 23, 42, 0.28);
  }
  100% {
    box-shadow: 0 0 0 18px rgba(56, 189, 248, 0), 0 18px 42px rgba(15, 23, 42, 0.2);
  }
}
</style>

<route lang="yaml">
meta:
  layout: stage
</route>

