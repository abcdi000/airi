import type { VisionWorkloadId } from '@proj-airi/stage-ui/composables'
import type { ChatHistoryItem } from '@proj-airi/stage-ui/types/chat'
import type { SourcesOptions } from 'electron'
import type { Message, Tool } from '@xsai/shared-chat'

import { defineInvoke } from '@moeru/eventa'
import { errorMessageFrom } from '@moeru/std'
import { getElectronEventaContext } from '@proj-airi/electron-vueuse'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { VISION_WORKLOADS } from '@proj-airi/stage-ui/composables'
import { LUMI_AIRI_CARD_ID } from '@proj-airi/stage-ui/constants/lumi-card'
import { extractMessageText } from '@proj-airi/stage-ui/libs/chat-sync'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/llm-toolset-prompts'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/llm-tools'
import { useLumiAgentStore } from '@proj-airi/stage-ui/stores/lumi-agent'
import { useLumiCurrentStateStore } from '@proj-airi/stage-ui/stores/lumi-current-state'
import { useLumiUserProfileStore } from '@proj-airi/stage-ui/stores/lumi-user-profile'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useVisionStore } from '@proj-airi/stage-ui/stores/modules/vision'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { generateText } from '@xsai/generate-text'
import { tool } from '@xsai/tool'
import { defineStore, storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { z } from 'zod'

import { electron, electronGetWindowLifecycleState } from '../../shared/eventa'
import { useVisionScreenCapture } from '../composables/use-vision-screen-capture'
import { useChatSyncStore } from './chat-sync'
import { useLumiAutonomousLifeStore } from './lumi-autonomous-life'
import { useLumiDiarySchedulerStore } from './lumi-diary-scheduler'
import {
  buildAutonomousDecisionPrompt,
  evaluateAutonomousSettingChange,
  fallbackAutonomousDecision,
  LUMI_PROACTIVE_RETURN_CONTEXT_KEY,
  parseAutonomousDecision,
} from './lumi-proactive-autonomy'
import type {
  AutonomousSettingAuditEntry,
  LumiAutonomousDecisionInput,
  LumiAutonomousDecisionLogEntry,
  LumiAutonomousDecisionOutput,
  LumiAutonomousSummaryMode,
} from './lumi-proactive-autonomy'
import { useLumiSelfTodoStore } from './lumi-self-todo'

const DEFAULT_MIN_INTERVAL_MS = 2 * 60 * 1000
const DEFAULT_MAX_INTERVAL_MS = 8 * 60 * 1000
const DEFAULT_COOLDOWN_MS = 3 * 60 * 1000
const DEFAULT_WORKLOAD_ID: VisionWorkloadId = 'screen:interpret'
const LUMI_PROACTIVE_VISION_TOOLS_PROVIDER = 'lumi-proactive-vision'
const SILENCE_MARKERS = ['<silence>', '[silence]', 'silence', '不发送', '静默']
const ENVIRONMENT_CONTEXT_LIMIT = 8
const RUNTIME_STATUS_STORAGE_KEY = 'runtime/lumi-proactive-vision/status'
const CAPTURE_IMAGE_CHANNEL_NAME = 'lumi-proactive-vision-capture-image'
const AUTONOMOUS_DECISION_TIMEOUT_MS = 18_000
const AUTONOMOUS_LOG_LIMIT = 80
const PRIVATE_NOTE_LIMIT = 80
const DEFAULT_IDLE_DAILY_MAX_MESSAGES = 4
const DEFAULT_AGENT_SUGGESTION_COOLDOWN_MS = 30 * 60 * 1000
const DEFAULT_OBSERVATION_NO_EFFECT_THRESHOLD = 3
const DEFAULT_LUMI_WORLD_ROOT = 'D:\\LumiSandbox\\LumiWorld'
const PROACTIVE_ERROR_NOTICE_COOLDOWN_MS = 10 * 60 * 1000
const VISION_FAILURE_BACKOFF_BASE_MS = 2 * 60 * 1000
const VISION_FAILURE_BACKOFF_MAX_MS = 20 * 60 * 1000

type LumiScreenActivity =
  | 'video'
  | 'coding'
  | 'reading'
  | 'browsing'
  | 'chatting'
  | 'gaming'
  | 'creative'
  | 'settings'
  | 'idle'
  | 'unknown'

type LumiObservationSalience = 'low' | 'medium' | 'high'

interface LumiEnvironmentContextEntry {
  id: string
  observedAt: number
  activity: LumiScreenActivity
  salience: LumiObservationSalience
  source: 'scheduled' | 'tool'
  environment: LumiNonVisualEnvironmentSnapshot
  summary: string
  observation: string
  signature: string
}

interface LumiNonVisualEnvironmentSnapshot {
  app: {
    route: string
    title: string
    visibility: DocumentVisibilityState
    focused: boolean
    online: boolean
    language: string
  }
  capture: {
    selectedSourceId: string
    selectedSourceName: string
    selectedSourceType: 'screen' | 'window' | 'unknown'
    activeStreamSourceId: string
    videoWidth: number
    videoHeight: number
    sourceCount: number
    screenSourceCount: number
    windowSourceCount: number
    availableWindowTitles: string[]
    availableScreenNames: string[]
  }
  windowLifecycle?: {
    focused: boolean
    minimized: boolean
    visible: boolean
    reason: string
    updatedAt: number
  }
  cursor?: {
    x: number
    y: number
  }
}

interface LumiAutonomousPrivateNote {
  id: string
  createdAt: number
  observationSummary: string
  note: string
  reason: string
}

interface LumiRuntimeLogEntry {
  id: string
  createdAt: number
  kind: 'runtimeLog' | 'privateThought' | 'projectNote'
  summary: string
  reason: string
}

interface LumiProactiveLastDecisionState {
  action: string
  reason: string
  riskLevel: string
  confidence: number
  result: string
  at: number
}

function createHiddenVideoElement() {
  const video = document.createElement('video')
  video.muted = true
  video.autoplay = true
  video.playsInline = true
  video.style.position = 'fixed'
  video.style.left = '-9999px'
  video.style.top = '-9999px'
  video.style.width = '1px'
  video.style.height = '1px'
  video.setAttribute('aria-hidden', 'true')
  document.body.appendChild(video)
  return video
}

function createProactiveObservationInput(entry: LumiEnvironmentContextEntry, recentContext: LumiEnvironmentContextEntry[]) {
  const time = createObservationTimeContext(entry.observedAt)
  return [
    '[Lumi proactive screen observation]',
    'This is not a user message. Lumi actively looked at the user\'s current screen through the vision module.',
    'Use the normal Lumi personality, current conversation context, and memory tools exactly as in ordinary chat.',
    'Lumi should know this observation came from her own proactive screen-watching, not from the user typing or asking.',
    'The timestamp below is authoritative. If the screen image or vision description suggests a different time, treat it as screen content, not the real current time.',
    'Decision protocol:',
    '- If Lumi has something genuinely useful, warm, timely, or emotionally natural to say, output only that natural Lumi message.',
    '- If Lumi should stay quiet for any reason, output exactly <silence> and nothing else.',
    '- Never verbalize the quiet decision. Do not say things like "I will not disturb you", "I am just watching", or any apology for being quiet.',
    'If Lumi speaks, write only the natural message Lumi says to the user. Do not include inner monologue, bracketed action narration, tool traces, or analysis.',
    'Do not invent shared history or stored facts. Search memory only if the reply genuinely needs long-term recall.',
    'The short-term environment context below is temporary screen-awareness, not long-term memory and not proof of user preference.',
    '',
    'Current time at observation:',
    `- local: ${time.local}`,
    `- iso: ${time.iso}`,
    `- timezone: ${time.timeZone}`,
    '',
    'Non-visual environment context:',
    ...formatEnvironmentSnapshotLines(entry.environment),
    'Use this environment context only to understand the situation. It is not visual-model output, not long-term memory, and not proof of user preference.',
    '',
    `Current activity: ${entry.activity}`,
    `Observation salience: ${entry.salience}`,
    '',
    'Recent short-term environment context:',
    ...recentContext.slice(-5).map((item) => {
      const itemTime = createObservationTimeContext(item.observedAt)
      return `- ${itemTime.local} ${item.activity}/${item.salience} via ${item.environment.capture.selectedSourceName || item.environment.capture.selectedSourceId || 'unknown source'}: ${item.summary}`
    }),
    '',
    'Screen observation:',
    entry.observation,
    '[/Lumi proactive screen observation]',
  ].join('\n')
}

function isProactivePseudoSilence(text: string) {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
  if (!normalized)
    return true

  return [
    /^(?:<silence>|\[silence\]|silence|不发送|静默)$/,
    /不(?:打扰|扰|吵)你/,
    /先不(?:打扰|扰|吵)/,
    /我(?:就|先)?(?:不|不会)(?:打扰|扰|吵)你/,
    /我(?:只是|先)?(?:看着|陪着|在旁边)/,
    /你忙你的/,
    /我在(?:这里|旁边).*?(?:不说话|不打扰|不吵)/,
  ].some(pattern => pattern.test(normalized))
}

function createObservationId() {
  return `lumi-observation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function writeRuntimeStatus(status: Record<string, unknown>) {
  try {
    localStorage.setItem(RUNTIME_STATUS_STORAGE_KEY, JSON.stringify({
      ...status,
      updatedAt: Date.now(),
    }))
  }
  catch (error) {
    console.warn('[lumi-proactive-vision] Failed to publish runtime status', error)
  }
}

function compactObservationText(text: string, maxLength = 180) {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength)
    return compact
  return `${compact.slice(0, maxLength - 1)}...`
}

function createObservationSignature(text: string) {
  const normalized = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\d{1,2}:\d{2}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600)

  let hash = 0
  for (let index = 0; index < normalized.length; index += 1)
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0

  return `${hash.toString(36)}:${normalized.slice(0, 80)}`
}

function isVisionInferenceTimeoutMessage(message: string) {
  return /vision inference timed out/i.test(message)
}

async function downscaleImageDataUrlForVision(dataUrl: string, options: { maxWidth?: number, maxHeight?: number, quality?: number } = {}) {
  if (typeof Image === 'undefined' || typeof document === 'undefined')
    return dataUrl

  const maxWidth = options.maxWidth ?? 1280
  const maxHeight = options.maxHeight ?? 720
  const quality = options.quality ?? 0.82

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('Failed to load captured image for resizing'))
      img.src = dataUrl
    })

    const sourceWidth = image.naturalWidth || image.width
    const sourceHeight = image.naturalHeight || image.height
    if (sourceWidth <= 0 || sourceHeight <= 0)
      return dataUrl

    const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1)
    const targetWidth = Math.max(1, Math.round(sourceWidth * scale))
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale))
    if (scale >= 1 && dataUrl.startsWith('data:image/jpeg'))
      return dataUrl

    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    const context = canvas.getContext('2d')
    if (!context)
      return dataUrl

    context.drawImage(image, 0, 0, targetWidth, targetHeight)
    return canvas.toDataURL('image/jpeg', quality)
  }
  catch (error) {
    console.warn('[lumi-proactive-vision] Failed to downscale vision input image; using original capture.', error)
    return dataUrl
  }
}

function createObservationTimeContext(observedAt = Date.now()) {
  const observedDate = new Date(observedAt)
  return {
    iso: observedDate.toISOString(),
    local: observedDate.toLocaleString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    unixMs: observedDate.getTime(),
  }
}

function getSourceType(sourceId: string): LumiNonVisualEnvironmentSnapshot['capture']['selectedSourceType'] {
  if (sourceId.startsWith('screen:'))
    return 'screen'
  if (sourceId.startsWith('window:'))
    return 'window'
  return 'unknown'
}

function compactSourceName(name: string) {
  return name.replace(/\s+/g, ' ').trim().slice(0, 120)
}

function formatEnvironmentSnapshotLines(snapshot: LumiNonVisualEnvironmentSnapshot) {
  const lines = [
    `- app_route: ${snapshot.app.route || '/'}`,
    `- app_title: ${snapshot.app.title || 'untitled'}`,
    `- app_visibility: ${snapshot.app.visibility}`,
    `- app_focused: ${snapshot.app.focused}`,
    `- online: ${snapshot.app.online}`,
    `- language: ${snapshot.app.language}`,
    `- capture_source: ${snapshot.capture.selectedSourceType} ${snapshot.capture.selectedSourceName || snapshot.capture.selectedSourceId || 'unknown'}`,
    `- active_stream_source_id: ${snapshot.capture.activeStreamSourceId || 'none'}`,
    `- captured_frame_size: ${snapshot.capture.videoWidth}x${snapshot.capture.videoHeight}`,
    `- available_sources: screens=${snapshot.capture.screenSourceCount}, windows=${snapshot.capture.windowSourceCount}, total=${snapshot.capture.sourceCount}`,
  ]

  if (snapshot.capture.availableScreenNames.length)
    lines.push(`- available_screens: ${snapshot.capture.availableScreenNames.join(' | ')}`)
  if (snapshot.capture.availableWindowTitles.length)
    lines.push(`- visible_window_titles_sample: ${snapshot.capture.availableWindowTitles.join(' | ')}`)
  if (snapshot.windowLifecycle) {
    lines.push(
      `- airi_window_lifecycle: focused=${snapshot.windowLifecycle.focused}, minimized=${snapshot.windowLifecycle.minimized}, visible=${snapshot.windowLifecycle.visible}, reason=${snapshot.windowLifecycle.reason}`,
    )
  }
  if (snapshot.cursor)
    lines.push(`- cursor_screen_position: x=${snapshot.cursor.x}, y=${snapshot.cursor.y}`)

  return lines
}

function classifyActivity(text: string): LumiScreenActivity {
  const normalized = text.toLowerCase()
  if (/\b(bilibili|youtube|video|movie|episode|anime|番剧|视频|电影|播放|字幕)\b/.test(normalized))
    return 'video'
  if (/\b(vscode|code|typescript|javascript|python|git|terminal|stack trace|error|console|编译|代码|报错)\b/.test(normalized))
    return 'coding'
  if (/\b(plugin|settings|config|preference|设置|插件|配置)\b/.test(normalized))
    return 'settings'
  if (/\b(game|steam|unity|unreal|游戏)\b/.test(normalized))
    return 'gaming'
  if (/\b(manga|comic|drawing|image|canvas|photoshop|漫画|图片|绘画|画面)\b/.test(normalized))
    return 'creative'
  if (/\b(chat|message|discord|wechat|聊天|消息|评论)\b/.test(normalized))
    return 'chatting'
  if (/\b(pdf|doc|paper|article|book|论文|文档|阅读|文章)\b/.test(normalized))
    return 'reading'
  if (/\b(browser|url|page|search|tab|网页|浏览器|搜索)\b/.test(normalized))
    return 'browsing'
  if (/\b(desktop|blank|idle|空白|桌面)\b/.test(normalized))
    return 'idle'
  return 'unknown'
}

function estimateSalience(text: string, activity: LumiScreenActivity, repeated: boolean): LumiObservationSalience {
  const normalized = text.toLowerCase()
  if (repeated)
    return 'low'
  if (/\b(error|failed|warning|deadline|urgent|exception|crash|报错|失败|警告|崩溃|截止|紧急)\b/.test(normalized))
    return 'high'
  if (/\b(question|ask|confused|help|problem|问题|帮|看不懂|怎么办)\b/.test(normalized))
    return 'high'
  if (activity === 'coding' || activity === 'settings' || activity === 'video' || activity === 'creative' || activity === 'reading')
    return 'medium'
  return 'low'
}

function createSystemNotice(entry: LumiEnvironmentContextEntry, decision: string) {
  const time = createObservationTimeContext(entry.observedAt)
  return [
    '[system_notice]',
    'status: observed',
    `activity: ${entry.activity}`,
    `salience: ${entry.salience}`,
    `decision: ${decision}`,
    `source: ${entry.source}`,
    `summary: ${entry.summary}`,
    `observed_at: ${time.local}`,
    `observed_at_iso: ${time.iso}`,
    `timezone: ${time.timeZone}`,
    `capture_source: ${entry.environment.capture.selectedSourceType} ${entry.environment.capture.selectedSourceName || entry.environment.capture.selectedSourceId || 'unknown'}`,
    `app_route: ${entry.environment.app.route || '/'}`,
    `app_focused: ${entry.environment.app.focused}`,
    entry.environment.cursor ? `cursor: ${entry.environment.cursor.x},${entry.environment.cursor.y}` : 'cursor: unavailable',
    '',
    entry.observation.slice(0, 1600),
  ].join('\n')
}

function createErrorSystemNotice(error: string, sourceId: string, decision = 'error') {
  const time = createObservationTimeContext()
  return [
    '[system_notice]',
    'status: error',
    'activity: unknown',
    'salience: high',
    `decision: ${decision}`,
    `source_id: ${sourceId || 'none'}`,
    `observed_at: ${time.local}`,
    `observed_at_iso: ${time.iso}`,
    `timezone: ${time.timeZone}`,
    '',
    error,
  ].join('\n')
}

function createAutonomousSystemNotice(input: {
  title?: string
  status: string
  action: string
  reason: string
  result?: string
  changes?: string[]
}) {
  return [
    '[system_notice]',
    `title: ${input.title || 'Lumi 自主行动'}`,
    `status: ${input.status}`,
    `action: ${input.action}`,
    `reason: ${input.reason}`,
    input.result ? `result: ${input.result}` : '',
    ...(input.changes ?? []).map(change => `- ${change}`),
  ].filter(Boolean).join('\n')
}

function latestAssistantMessageText(messages: ChatHistoryItem[], previousCount: number) {
  const assistantMessage = messages
    .slice(previousCount)
    .reverse()
    .find((message) => {
      if (message.role !== 'assistant')
        return false
      return !/^\[(?:memory_search|memory_write|system_notice)\]/.test(extractMessageText(message).trim())
    })
  return assistantMessage ? extractMessageText(assistantMessage).trim() : ''
}

function latestMessageAt(messages: ChatHistoryItem[], role: 'user' | 'assistant') {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === role)
      return message.createdAt ?? 0
  }
  return 0
}

export const useLumiProactiveVisionStore = defineStore('lumi-proactive-vision', () => {
  const enabled = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/enabled', false)
  const sourceId = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/source-id', '')
  const workloadId = useLocalStorageManualReset<VisionWorkloadId>('settings/plugins/lumi-proactive-vision/workload-id', DEFAULT_WORKLOAD_ID)
  const minIntervalMs = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/min-interval-ms', DEFAULT_MIN_INTERVAL_MS)
  const maxIntervalMs = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/max-interval-ms', DEFAULT_MAX_INTERVAL_MS)
  const cooldownMs = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/cooldown-ms', DEFAULT_COOLDOWN_MS)
  const publishOnlyWhenLumiActive = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/only-lumi-card', true)
  const autonomousEnabled = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/autonomous-enabled', true)
  const quietMode = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/quiet-mode', false)
  const summaryMode = useLocalStorageManualReset<LumiAutonomousSummaryMode>('settings/plugins/lumi-proactive-vision/summary-mode', 'normal')
  const idleDailyMaxMessages = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/idle-daily-max-messages', DEFAULT_IDLE_DAILY_MAX_MESSAGES)
  const agentSuggestionCooldownMs = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/agent-suggestion-cooldown-ms', DEFAULT_AGENT_SUGGESTION_COOLDOWN_MS)
  const observationNoEffectThreshold = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/no-effect-threshold', DEFAULT_OBSERVATION_NO_EFFECT_THRESHOLD)
  const allowAutonomousSandboxTasks = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/allow-autonomous-sandbox-tasks', true)
  const lumiWorldRoot = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/lumi-world-root', DEFAULT_LUMI_WORLD_ROOT)
  const decisionLog = useLocalStorageManualReset<LumiAutonomousDecisionLogEntry[]>('settings/plugins/lumi-proactive-vision/decision-log', [])
  const privateNotes = useLocalStorageManualReset<LumiAutonomousPrivateNote[]>('settings/plugins/lumi-proactive-vision/private-notes', [])
  const runtimeLogs = useLocalStorageManualReset<LumiRuntimeLogEntry[]>('settings/plugins/lumi-proactive-vision/runtime-logs', [])
  const settingChangeAudit = useLocalStorageManualReset<AutonomousSettingAuditEntry[]>('settings/plugins/lumi-proactive-vision/setting-change-audit', [])
  const todayProactiveDate = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/today-proactive-date', '')
  const todayProactiveMessageCount = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/today-proactive-message-count', 0)
  const ignoredProactiveStreak = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/ignored-proactive-streak', 0)
  const lowChangeStreak = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/low-change-streak', 0)
  const noProgressStreak = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/no-progress-streak', 0)
  const awaitingProactiveResponseSince = useLocalStorageManualReset<number | null>('settings/plugins/lumi-proactive-vision/awaiting-response-since', null)
  const lastAutonomousAgentAt = useLocalStorageManualReset<number | null>('settings/plugins/lumi-proactive-vision/last-autonomous-agent-at', null)

  const sourcesOptions = ref<SourcesOptions>({
    types: ['screen', 'window'],
    fetchWindowIcons: true,
    thumbnailSize: {
      // Listing sources must remain metadata-only. A still frame is captured
      // from the selected stream, so probing every window thumbnail is wasteful
      // and makes Chromium WGC touch invalid HWNDs on Windows.
      width: 0,
      height: 0,
    },
  })
  const {
    sources,
    activeSourceId,
    activeSource,
    activeStream,
    activeStreamSourceId,
    isRefetching,
    hasFetchedOnce,
    refetchSources,
    startStream,
    stopStream,
    cleanup,
    captureFrame,
    captureSourceDataUrl,
  } = useVisionScreenCapture(sourcesOptions)

  const consciousnessStore = useConsciousnessStore()
  const visionStore = useVisionStore()
  const providersStore = useProvidersStore()
  const currentStateStore = useLumiCurrentStateStore()
  const userProfileStore = useLumiUserProfileStore()
  const agentStore = useLumiAgentStore()
  const diarySchedulerStore = useLumiDiarySchedulerStore()
  const autonomousLifeStore = useLumiAutonomousLifeStore()
  const selfTodoStore = useLumiSelfTodoStore()
  const chatSession = useChatSessionStore()
  const chatSyncStore = useChatSyncStore()
  const cardStore = useAiriCardStore()
  const {
    activeProvider: consciousnessProvider,
    activeModel: consciousnessModel,
  } = storeToRefs(consciousnessStore)

  const running = ref(false)
  const processing = ref(false)
  const lastError = ref('')
  const lastObservation = ref('')
  const lastMessage = ref('')
  const lastCaptureAt = ref<number | null>(null)
  const lastCaptureSourceId = ref('')
  const lastCaptureSourceName = ref('')
  const lastCapturedImageDataUrl = ref('')
  const lastVisionInputImageDataUrl = ref('')
  const lastMessageAt = ref<number | null>(null)
  const lastScheduledDelayMs = ref<number | null>(null)
  const nextScheduledAt = ref<number | null>(null)
  const lastTickStartedAt = ref<number | null>(null)
  const lastTickFinishedAt = ref<number | null>(null)
  const lastSkipReason = ref('')
  const tickCount = ref(0)
  const skippedCount = ref(0)
  const captureFailureCount = ref(0)
  const environmentContext = ref<LumiEnvironmentContextEntry[]>([])
  const currentActivity = ref<LumiScreenActivity>('unknown')
  const lastSalience = ref<LumiObservationSalience>('low')
  const lastDecision = ref<LumiProactiveLastDecisionState | null>(null)
  const lastObservationSignature = ref('')
  const visionFailureBackoffUntil = ref<number | null>(null)
  const applyingAutonomousSettingsPatch = ref(false)
  const runtimeStatusPublishingEnabled = ref(false)
  let lastObservedSettingsSnapshot = ''

  const captureImageChannel = new BroadcastChannel(CAPTURE_IMAGE_CHANNEL_NAME)
  const captureImageChannelInstanceId = crypto.randomUUID()
  let lastCaptureImagesClearedAt = 0

  function currentCaptureImageSnapshot() {
    return {
      type: 'snapshot' as const,
      senderId: captureImageChannelInstanceId,
      capturedAt: lastCaptureAt.value,
      sourceId: lastCaptureSourceId.value,
      sourceName: lastCaptureSourceName.value,
      capturedImageDataUrl: lastCapturedImageDataUrl.value,
      visionInputImageDataUrl: lastVisionInputImageDataUrl.value,
    }
  }

  function publishLastCaptureImages() {
    if (!lastCapturedImageDataUrl.value || !lastVisionInputImageDataUrl.value)
      return
    captureImageChannel.postMessage(currentCaptureImageSnapshot())
  }

  function requestLastCaptureImages() {
    captureImageChannel.postMessage({
      type: 'request',
      senderId: captureImageChannelInstanceId,
    })
  }

  captureImageChannel.addEventListener('message', (event: MessageEvent) => {
    const message = event.data
    if (!message || typeof message !== 'object' || message.senderId === captureImageChannelInstanceId)
      return

    if (message.type === 'request') {
      publishLastCaptureImages()
      return
    }

    if (message.type === 'clear') {
      const clearedAt = Number(message.clearedAt || 0)
      if (clearedAt >= lastCaptureImagesClearedAt) {
        lastCaptureImagesClearedAt = clearedAt
        clearLastCaptureImages(false)
      }
      return
    }

    if (message.type !== 'snapshot')
      return

    const capturedAt = Number(message.capturedAt || 0)
    if (!capturedAt || capturedAt <= lastCaptureImagesClearedAt || capturedAt < Number(lastCaptureAt.value || 0))
      return

    lastCaptureAt.value = capturedAt
    lastCaptureSourceId.value = String(message.sourceId || '')
    lastCaptureSourceName.value = String(message.sourceName || '')
    lastCapturedImageDataUrl.value = String(message.capturedImageDataUrl || '')
    lastVisionInputImageDataUrl.value = String(message.visionInputImageDataUrl || '')
  })

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let video: HTMLVideoElement | undefined
  let observeScreenToolRegistered = false
  let lastErrorNoticeAt = 0
  let lastErrorNoticeKey = ''

  const configured = computed(() => {
    return Boolean(visionStore.activeProvider && visionStore.activeModel && consciousnessProvider.value && consciousnessModel.value)
  })

  const normalizedIdleDailyMaxMessages = computed(() => Math.min(12, Math.max(0, Math.round(Number(idleDailyMaxMessages.value) || DEFAULT_IDLE_DAILY_MAX_MESSAGES))))
  const normalizedObservationNoEffectThreshold = computed(() => Math.min(8, Math.max(1, Math.round(Number(observationNoEffectThreshold.value) || DEFAULT_OBSERVATION_NO_EFFECT_THRESHOLD))))

  function setLastDecision(input: {
    action: string
    reason?: string
    riskLevel?: string
    confidence?: number
    result?: string
  }) {
    lastDecision.value = {
      action: input.action,
      reason: input.reason || '',
      riskLevel: input.riskLevel || 'none',
      confidence: typeof input.confidence === 'number' ? input.confidence : 0,
      result: input.result || '',
      at: Date.now(),
    }
  }

  function deriveLumiWorldTaskName(decision: LumiAutonomousDecisionOutput) {
    const raw = decision.executionPlan.taskName
      || decision.targetPath.split(/[\\/]/).filter(Boolean).pop()
      || decision.desire
      || 'lumi-world'
    const slug = raw
      .replace(/[^\w\u4E00-\u9FA5-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80)
    return slug || 'lumi-world'
  }

  const workloadOptions = computed(() => VISION_WORKLOADS.map(workload => ({
    label: workload.label,
    value: workload.id,
  })))

  function normalizedIntervalBounds() {
    const min = Math.max(30_000, Number(minIntervalMs.value) || DEFAULT_MIN_INTERVAL_MS)
    const max = Math.max(min, Number(maxIntervalMs.value) || DEFAULT_MAX_INTERVAL_MS)
    return { min, max }
  }

  function sampleHumanLikeDelayMs() {
    const { min, max } = normalizedIntervalBounds()
    if (max <= min)
      return min

    const centered = (Math.random() + Math.random()) / 2
    const longPauseBias = Math.random() < 0.15 ? Math.random() ** 0.35 : 0
    const ratio = Math.max(centered, longPauseBias)
    return Math.round(min + (max - min) * ratio)
  }

  function clearScheduledTick() {
    if (timeoutHandle)
      clearTimeout(timeoutHandle)
    timeoutHandle = undefined
    nextScheduledAt.value = null
  }

  function scheduleNextTick() {
    if (!running.value)
      return

    clearScheduledTick()
    const delay = sampleHumanLikeDelayMs()
    lastScheduledDelayMs.value = delay
    nextScheduledAt.value = Date.now() + delay
    timeoutHandle = setTimeout(() => {
      timeoutHandle = undefined
      nextScheduledAt.value = null
      void runTick().finally(() => scheduleNextTick())
    }, delay)
  }

  watch([minIntervalMs, maxIntervalMs], () => {
    if (running.value)
      scheduleNextTick()
  })

  function publishRuntimeStatus() {
    writeRuntimeStatus({
      running: running.value,
      processing: processing.value,
      enabled: enabled.value,
      configured: configured.value,
      currentActivity: currentActivity.value,
      lastSalience: lastSalience.value,
      lastDecision: lastDecision.value,
      quietMode: quietMode.value,
      summaryMode: summaryMode.value,
      lumiWorldRoot: lumiWorldRoot.value,
      ignoredProactiveStreak: ignoredProactiveStreak.value,
      lowChangeStreak: lowChangeStreak.value,
      lastCaptureAt: lastCaptureAt.value,
      lastScheduledDelayMs: lastScheduledDelayMs.value,
      nextScheduledAt: nextScheduledAt.value,
      lastTickStartedAt: lastTickStartedAt.value,
      lastTickFinishedAt: lastTickFinishedAt.value,
      lastSkipReason: lastSkipReason.value,
      tickCount: tickCount.value,
      skippedCount: skippedCount.value,
      lastError: lastError.value,
      visionFailureBackoffUntil: visionFailureBackoffUntil.value,
    })
  }

  watch([
    running,
    processing,
    enabled,
    configured,
    currentActivity,
    lastSalience,
    lastDecision,
    quietMode,
    summaryMode,
    ignoredProactiveStreak,
    lowChangeStreak,
    lastCaptureAt,
    lastScheduledDelayMs,
    nextScheduledAt,
    lastTickStartedAt,
    lastTickFinishedAt,
    lastSkipReason,
    tickCount,
    skippedCount,
    lastError,
    visionFailureBackoffUntil,
    runtimeStatusPublishingEnabled,
  ], () => {
    if (runtimeStatusPublishingEnabled.value)
      publishRuntimeStatus()
  }, { immediate: true })

  function setRuntimeStatusPublishingEnabled(nextEnabled: boolean) {
    if (!nextEnabled && runtimeStatusPublishingEnabled.value)
      publishRuntimeStatus()
    runtimeStatusPublishingEnabled.value = nextEnabled
  }

  function recordSkippedTick(reason: string) {
    skippedCount.value += 1
    lastSkipReason.value = reason
    lastTickFinishedAt.value = Date.now()
  }

  function currentLocalDateKey() {
    const date = new Date()
    const year = date.getFullYear()
    const month = `${date.getMonth() + 1}`.padStart(2, '0')
    const day = `${date.getDate()}`.padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  function resetDailyCounterIfNeeded() {
    const key = currentLocalDateKey()
    if (todayProactiveDate.value === key)
      return
    todayProactiveDate.value = key
    todayProactiveMessageCount.value = 0
  }

  function refreshResponseMetrics(messages: ChatHistoryItem[], now = Date.now()) {
    resetDailyCounterIfNeeded()
    const latestUserAt = latestMessageAt(messages, 'user')
    const awaitingSince = Number(awaitingProactiveResponseSince.value || 0)
    if (!awaitingSince)
      return

    if (latestUserAt > awaitingSince) {
      const previousIgnoredStreak = Number(ignoredProactiveStreak.value || 0)
      ignoredProactiveStreak.value = 0
      awaitingProactiveResponseSince.value = null
      if (quietMode.value || previousIgnoredStreak > 0) {
        const returnContext = [
          '[Lumi proactive return context]',
          'The user has returned after a quiet/idle period.',
          'Mention at most once, naturally and briefly, that Lumi reduced disturbance and can share a concise summary if useful.',
          'Do not send multiple catch-up messages. Do not apologize for being quiet.',
          `ignored_proactive_streak_before_return: ${previousIgnoredStreak}`,
          `quiet_mode: ${quietMode.value}`,
          '[/Lumi proactive return context]',
        ].join('\n')
        localStorage.setItem(LUMI_PROACTIVE_RETURN_CONTEXT_KEY, returnContext)
      }
      return
    }

    if (now - awaitingSince > Math.max(Number(cooldownMs.value) || DEFAULT_COOLDOWN_MS, 2 * 60 * 1000)) {
      ignoredProactiveStreak.value = Number(ignoredProactiveStreak.value || 0) + 1
      awaitingProactiveResponseSince.value = null
    }
  }

  function buildReturnSummaryContext() {
    const value = localStorage.getItem(LUMI_PROACTIVE_RETURN_CONTEXT_KEY) || ''
    if (value)
      localStorage.removeItem(LUMI_PROACTIVE_RETURN_CONTEXT_KEY)
    return value
  }

  function updateVisionFailureBackoff(message: string) {
    if (!isVisionInferenceTimeoutMessage(message))
      return

    const failures = Math.max(1, Number(captureFailureCount.value || 1))
    const backoffMs = Math.min(
      VISION_FAILURE_BACKOFF_MAX_MS,
      VISION_FAILURE_BACKOFF_BASE_MS * 2 ** Math.min(4, failures - 1),
    )
    visionFailureBackoffUntil.value = Date.now() + backoffMs
    lastScheduledDelayMs.value = Math.max(Number(lastScheduledDelayMs.value || 0), backoffMs)
  }

  function clearVisionFailureBackoff() {
    visionFailureBackoffUntil.value = null
  }

  function shouldAppendScheduledErrorNotice(message: string) {
    const key = isVisionInferenceTimeoutMessage(message)
      ? 'vision-timeout'
      : message.slice(0, 160)
    const now = Date.now()
    if (key === lastErrorNoticeKey && now - lastErrorNoticeAt < PROACTIVE_ERROR_NOTICE_COOLDOWN_MS)
      return false

    lastErrorNoticeKey = key
    lastErrorNoticeAt = now
    return true
  }

  function buildAutonomyBudgetState() {
    const today = new Date().toISOString().slice(0, 10)
    const todayLogs = decisionLog.value.filter((entry) => {
      const at = new Date(entry.timestamp).toISOString().slice(0, 10)
      return at === today
    })
    return {
      maxStepsPerDay: Math.max(0, Math.round(Number(autonomousLifeStore.dailyActionBudget) || 10)),
      usedStepsToday: Number(autonomousLifeStore.todayActionCount || 0),
      maxAgentTasksPerDay: 2,
      usedAgentTasksToday: todayLogs.filter(entry => String(entry.result || '').startsWith('agent_') || entry.selectedMode === 'continue_self_project').length,
      maxNewProjectsPerDay: 1,
      usedNewProjectsToday: todayLogs.filter(entry => entry.selectedMode === 'generate_or_select_idea' && /converted|project/i.test(String(entry.result || ''))).length,
    }
  }

  function recordDecisionLog(input: {
    entry: LumiEnvironmentContextEntry
    decision: LumiAutonomousDecisionOutput
    result: string
    settingsChanged?: string[]
    userNotified?: boolean
    followUpNeeded?: boolean
  }) {
    const logEntry: LumiAutonomousDecisionLogEntry = {
      id: `autonomy-${createObservationId()}`,
      timestamp: Date.now(),
      observationSummary: input.entry.summary,
      desire: input.decision.desire,
      motivation: input.decision.motivation,
      plan: input.decision.plan,
      targetPath: input.decision.targetPath,
      targetSpace: input.decision.targetSpace,
      visibility: input.decision.visibility,
      selectedMode: input.decision.mode,
      selectedAction: input.decision.selectedAction,
      reason: input.decision.reason,
      riskLevel: input.decision.riskLevel,
      confidence: input.decision.confidence,
      budgetState: buildAutonomyBudgetState(),
      activeProjectId: selfTodoStore.activeProject?.id,
      executableTodoId: selfTodoStore.getNextExecutableTodo()?.id,
      availableIdeasCount: autonomousLifeStore.ideas.length,
      userInteractionSuppressed: input.decision.mode !== 'interact_with_user',
      internalActionContinued: input.decision.mode === 'continue_self_project' || input.decision.mode === 'generate_or_select_idea' || input.decision.mode === 'reflect',
      settingsChanged: input.settingsChanged ?? [],
      userNotified: Boolean(input.userNotified),
      result: input.result,
      followUpNeeded: Boolean(input.followUpNeeded),
    }
    decisionLog.value = [logEntry, ...decisionLog.value].slice(0, AUTONOMOUS_LOG_LIMIT)
  }

  function recordRuntimeLog(kind: LumiRuntimeLogEntry['kind'], summary: string, reason: string) {
    const entry: LumiRuntimeLogEntry = {
      id: `runtime-log-${createObservationId()}`,
      createdAt: Date.now(),
      kind,
      summary: summary.slice(0, 1200),
      reason: reason.slice(0, 500),
    }
    runtimeLogs.value = [entry, ...runtimeLogs.value].slice(0, AUTONOMOUS_LOG_LIMIT)
  }

  function isRuntimeOnlyNoteText(text: string) {
    return /用户未回应|未回应|保持安静|继续安静|quiet|silence|ignored|低变化|low-change|observe_quietly|continue_self_project|generate_or_select_idea|runtime|调参|冷却/.test(text)
  }

  function isDuplicatePrivateThought(text: string) {
    const normalized = text.trim().replace(/\s+/g, ' ').slice(0, 300)
    if (!normalized)
      return true
    return privateNotes.value.slice(0, 8).some((note) => {
      const previous = String(note.note || '').trim().replace(/\s+/g, ' ').slice(0, 300)
      return previous === normalized || previous.includes(normalized) || normalized.includes(previous)
    })
  }

  function privateThoughtHourlyLimitReached() {
    const since = Date.now() - 60 * 60 * 1000
    return privateNotes.value.filter(note => Number(note.createdAt || 0) >= since).length >= 6
  }

  function recordPrivateNote(entry: LumiEnvironmentContextEntry, decision: LumiAutonomousDecisionOutput) {
    const text = decision.executionPlan.note || entry.summary
    const reason = decision.reason || ''
    if (isRuntimeOnlyNoteText(`${text} ${reason}`)) {
      recordRuntimeLog('runtimeLog', text, reason)
      return false
    }
    if (isDuplicatePrivateThought(text) || privateThoughtHourlyLimitReached()) {
      recordRuntimeLog('runtimeLog', text, 'duplicate_or_hourly_limit_private_thought')
      return false
    }
    const note: LumiAutonomousPrivateNote = {
      id: `private-note-${createObservationId()}`,
      createdAt: Date.now(),
      observationSummary: entry.summary,
      note: text,
      reason: decision.reason,
    }
    privateNotes.value = [note, ...privateNotes.value].slice(0, PRIVATE_NOTE_LIMIT)
    recordRuntimeLog('privateThought', text, reason)
    return true
  }

  function applyAutonomousSettingsPatch(decision: LumiAutonomousDecisionOutput) {
    const patch = decision.executionPlan.settingsPatch
    if (!patch)
      return []

    const changes: string[] = []
    const evidence = `${decision.mode}:${decision.reason}:${decision.motivation}`.slice(0, 1000)
    const blocked: string[] = []
    function applySetting(key: string, oldValue: unknown, newValue: unknown, apply: () => void, describe: () => string) {
      if (oldValue === newValue)
        return
      const result = evaluateAutonomousSettingChange({
        key,
        oldValue,
        newValue,
        evidence,
        audit: settingChangeAudit.value,
      })
      const auditEntry: AutonomousSettingAuditEntry = {
        key,
        oldValue,
        newValue,
        direction: result.direction,
        evidence,
        source: 'auto',
        createdAt: Date.now(),
        cooldownUntil: result.cooldownUntil,
        manualOverrideUntil: result.manualOverrideUntil,
        blockedReason: result.allowed ? undefined : result.reason,
      }
      settingChangeAudit.value = [auditEntry, ...settingChangeAudit.value].slice(0, AUTONOMOUS_LOG_LIMIT)
      if (!result.allowed) {
        blocked.push(`${key}: ${result.reason}`)
        recordRuntimeLog('runtimeLog', `${key} 自动调参被阻止`, result.reason)
        return
      }
      applyingAutonomousSettingsPatch.value = true
      try {
        apply()
      }
      finally {
        applyingAutonomousSettingsPatch.value = false
      }
      changes.push(describe())
    }

    if (typeof patch.minIntervalSeconds === 'number') {
      const previous = Number(minIntervalMs.value)
      const next = patch.minIntervalSeconds * 1000
      applySetting('minIntervalMs', previous, next, () => {
        minIntervalMs.value = next
      }, () => `最短观察间隔: ${Math.round(previous / 1000)}秒 -> ${patch.minIntervalSeconds}秒`)
    }
    if (typeof patch.maxIntervalSeconds === 'number') {
      const previous = Number(maxIntervalMs.value)
      const next = Math.max(Number(minIntervalMs.value), patch.maxIntervalSeconds * 1000)
      applySetting('maxIntervalMs', previous, next, () => {
        maxIntervalMs.value = next
      }, () => `最长观察间隔: ${Math.round(previous / 1000)}秒 -> ${Math.round(next / 1000)}秒`)
    }
    if (typeof patch.cooldownSeconds === 'number') {
      const previous = Number(cooldownMs.value)
      const next = patch.cooldownSeconds * 1000
      applySetting('cooldownMs', previous, next, () => {
        cooldownMs.value = next
      }, () => `主动发言冷却: ${Math.round(previous / 1000)}秒 -> ${patch.cooldownSeconds}秒`)
    }
    if (typeof patch.idleDailyMaxMessages === 'number') {
      const previous = Number(idleDailyMaxMessages.value)
      const next = patch.idleDailyMaxMessages
      applySetting('idleDailyMaxMessages', previous, next, () => {
        idleDailyMaxMessages.value = next
      }, () => `空闲每日最多发言: ${previous} -> ${next}`)
    }
    if (typeof patch.agentSuggestionCooldownSeconds === 'number') {
      const previous = Number(agentSuggestionCooldownMs.value)
      const next = patch.agentSuggestionCooldownSeconds * 1000
      applySetting('agentSuggestionCooldownMs', previous, next, () => {
        agentSuggestionCooldownMs.value = next
      }, () => `Agent 建议冷却: ${Math.round(previous / 1000)}秒 -> ${patch.agentSuggestionCooldownSeconds}秒`)
    }
    if (typeof patch.quietMode === 'boolean') {
      const previous = Boolean(quietMode.value)
      const next = patch.quietMode
      applySetting('quietMode', previous, next, () => {
        quietMode.value = next
      }, () => `安静模式: ${previous ? '开启' : '关闭'} -> ${next ? '开启' : '关闭'}`)
    }
    if (patch.summaryMode) {
      const previous = summaryMode.value
      const next = patch.summaryMode
      applySetting('summaryMode', previous, next, () => {
        summaryMode.value = next
      }, () => `观察摘要模式: ${previous} -> ${next}`)
    }
    if (patch.diaryDailyTime) {
      const previous = diarySchedulerStore.dailyTime
      const next = patch.diaryDailyTime
      applySetting('diaryDailyTime', previous, next, () => {
        diarySchedulerStore.dailyTime = next
      }, () => `日记生成时间: ${previous} -> ${next}`)
    }

    if (blocked.length)
      changes.push(`自动调参拦截: ${blocked.join('；')}`)
    return changes
  }

  function currentAutonomousSettingValues() {
    return {
      minIntervalMs: Number(minIntervalMs.value),
      maxIntervalMs: Number(maxIntervalMs.value),
      cooldownMs: Number(cooldownMs.value),
      idleDailyMaxMessages: Number(idleDailyMaxMessages.value),
      agentSuggestionCooldownMs: Number(agentSuggestionCooldownMs.value),
      quietMode: Boolean(quietMode.value),
      summaryMode: summaryMode.value,
      diaryDailyTime: diarySchedulerStore.dailyTime,
    }
  }

  watch([
    minIntervalMs,
    maxIntervalMs,
    cooldownMs,
    idleDailyMaxMessages,
    agentSuggestionCooldownMs,
    quietMode,
    summaryMode,
    () => diarySchedulerStore.dailyTime,
  ], () => {
    const nextValues = currentAutonomousSettingValues()
    const nextSnapshot = JSON.stringify(nextValues)
    if (!lastObservedSettingsSnapshot) {
      lastObservedSettingsSnapshot = nextSnapshot
      return
    }
    if (applyingAutonomousSettingsPatch.value) {
      lastObservedSettingsSnapshot = nextSnapshot
      return
    }

    const previousValues = JSON.parse(lastObservedSettingsSnapshot) as Record<string, unknown>
    const now = Date.now()
    const manualOverrideUntil = now + 720 * 60_000
    const entries: AutonomousSettingAuditEntry[] = []
    for (const [key, newValue] of Object.entries(nextValues)) {
      const oldValue = previousValues[key]
      if (oldValue === newValue)
        continue
      const result = evaluateAutonomousSettingChange({
        key,
        oldValue,
        newValue,
        evidence: 'manual_override',
        audit: settingChangeAudit.value,
        now,
      })
      entries.push({
        key,
        oldValue,
        newValue,
        direction: result.direction,
        evidence: 'manual_override',
        source: 'manual',
        createdAt: now,
        manualOverrideUntil,
      })
    }
    if (entries.length)
      settingChangeAudit.value = [...entries, ...settingChangeAudit.value].slice(0, AUTONOMOUS_LOG_LIMIT)
    lastObservedSettingsSnapshot = nextSnapshot
  })
  lastObservedSettingsSnapshot = JSON.stringify(currentAutonomousSettingValues())

  async function refreshSources() {
    await refetchSources()
    if (sourceId.value && sources.value.some(source => source.id === sourceId.value)) {
      activeSourceId.value = sourceId.value
      return
    }

    // A persisted window ID may become stale when that window closes. Keep the
    // configured boundary intact so a window selection never silently widens
    // into a full-screen capture.
    if (sourceId.value) {
      activeSourceId.value = ''
      return
    }

    const firstScreen = sources.value.find(source => source.id.startsWith('screen:'))
    const fallback = firstScreen ?? sources.value[0]
    if (fallback) {
      sourceId.value = fallback.id
      activeSourceId.value = fallback.id
    }
  }

  function selectSource(nextSourceId: string) {
    sourceId.value = nextSourceId
    activeSourceId.value = nextSourceId
  }

  async function attachVideoStream(stream: MediaStream) {
    video ??= createHiddenVideoElement()
    video.srcObject = stream
    await video.play()

    if (video.readyState >= 2)
      return

    await new Promise<void>((resolve) => {
      const onLoadedMetadata = () => {
        video?.removeEventListener('loadedmetadata', onLoadedMetadata)
        resolve()
      }
      video?.addEventListener('loadedmetadata', onLoadedMetadata)
    })
  }

  async function tryStartStreamForSource(nextSourceId: string) {
    activeSourceId.value = nextSourceId
    const stream = await startStream()
    await attachVideoStream(stream)
  }

  async function ensureVideoStream(targetSourceId = sourceId.value) {
    if (!targetSourceId) {
      await refreshSources()
      targetSourceId = sourceId.value
    }
    if (!targetSourceId)
      throw new Error('No screen source selected')

    try {
      await tryStartStreamForSource(targetSourceId)
    }
    catch (error) {
      stopStream()
      throw new Error(`Capture source is not capturable: ${targetSourceId}. ${errorMessageFrom(error) ?? String(error)}`)
    }
  }

  async function captureScreenImageDataUrl(options: { stopStreamAfterCapture?: boolean, targetSourceId?: string } = {}) {
    let streamError = ''
    let targetSourceId = options.targetSourceId ?? sourceId.value

    if (!targetSourceId) {
      await refreshSources()
      targetSourceId = sourceId.value
    }
    if (!targetSourceId)
      throw new Error('No capture source selected')

    // One-shot observations preserve the requested source exactly. Main-process
    // capture may switch implementation, but never broadens a window to a screen.
    if (options.stopStreamAfterCapture) {
      try {
        return await captureSourceDataUrl(targetSourceId)
      }
      catch (error) {
        streamError = errorMessageFrom(error) || String(error)
        throw new Error(`Failed to capture the requested source ${targetSourceId}. ${streamError}`)
      }
    }

    try {
      await ensureVideoStream(targetSourceId)
      if (!video)
        throw new Error('Vision video stream is not ready')

      const dataUrl = captureFrame(video, 0.82, 1280, 720)
      if (dataUrl) {
        if (options.stopStreamAfterCapture)
          stopStream()
        return dataUrl
      }
      throw new Error('Failed to capture screen frame')
    }
    catch (error) {
      streamError ||= errorMessageFrom(error) || String(error)
      stopStream()
    }

    try {
      return await captureSourceDataUrl(targetSourceId)
    }
    catch (error) {
      const fallbackError = errorMessageFrom(error) || String(error)
      throw new Error(`Failed to capture the requested source ${targetSourceId}. ${streamError} ${fallbackError}`)
    }
  }

  async function understandScreen(options: { stopStreamAfterCapture?: boolean, targetSourceId?: string } = {}) {
    const capturedSourceId = options.targetSourceId ?? sourceId.value
    let dataUrl = ''
    try {
      dataUrl = await captureScreenImageDataUrl(options)
    }
    finally {
      if (options.targetSourceId) {
        activeSourceId.value = sources.value.some(source => source.id === sourceId.value)
          ? sourceId.value
          : ''
      }
    }
    const optimizedDataUrl = await downscaleImageDataUrlForVision(dataUrl)

    lastCapturedImageDataUrl.value = dataUrl
    lastVisionInputImageDataUrl.value = optimizedDataUrl
    lastCaptureSourceId.value = capturedSourceId
    lastCaptureSourceName.value = sources.value.find(source => source.id === capturedSourceId)?.name || capturedSourceId
    lastCaptureAt.value = Date.now()
    publishLastCaptureImages()
    const { useVisionInference } = await import('@proj-airi/stage-ui/composables')
    const { runVisionInference } = useVisionInference()
    return await runVisionInference({
      imageDataUrl: optimizedDataUrl,
      workloadId: workloadId.value,
    })
  }

  async function ensureActiveChatSession() {
    if (!chatSession.isReady)
      await chatSession.initialize()
    const sessionId = chatSession.activeSessionId
    if (!sessionId)
      throw new Error('No active chat session is available')
    await chatSession.loadSession(sessionId)
    chatSession.ensureSession(sessionId)
    return sessionId
  }

  async function createNonVisualEnvironmentSnapshot(): Promise<LumiNonVisualEnvironmentSnapshot> {
    const selectedSource = activeSource.value
    const selectedSourceId = sourceId.value || activeStreamSourceId.value || selectedSource?.id || ''
    const screenSources = sources.value.filter(source => source.id.startsWith('screen:'))
    const windowSources = sources.value.filter(source => source.id.startsWith('window:'))
    const snapshot: LumiNonVisualEnvironmentSnapshot = {
      app: {
        route: window.location.hash || window.location.pathname || '/',
        title: document.title || '',
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        online: navigator.onLine,
        language: navigator.language || '',
      },
      capture: {
        selectedSourceId,
        selectedSourceName: compactSourceName(selectedSource?.name ?? ''),
        selectedSourceType: getSourceType(selectedSourceId),
        activeStreamSourceId: activeStreamSourceId.value,
        videoWidth: video?.videoWidth ?? 0,
        videoHeight: video?.videoHeight ?? 0,
        sourceCount: sources.value.length,
        screenSourceCount: screenSources.length,
        windowSourceCount: windowSources.length,
        availableWindowTitles: windowSources
          .map(source => compactSourceName(source.name))
          .filter(Boolean)
          .slice(0, 8),
        availableScreenNames: screenSources
          .map(source => compactSourceName(source.name))
          .filter(Boolean)
          .slice(0, 4),
      },
    }

    try {
      const context = getElectronEventaContext()
      const getWindowLifecycleState = defineInvoke(context, electronGetWindowLifecycleState)
      const state = await getWindowLifecycleState()
      if (state) {
        snapshot.windowLifecycle = {
          focused: state.focused,
          minimized: state.minimized,
          visible: state.visible,
          reason: state.reason,
          updatedAt: state.updatedAt,
        }
      }
    }
    catch (error) {
      console.warn('[lumi-proactive-vision] Failed to read window lifecycle for environment snapshot', error)
    }

    try {
      const context = getElectronEventaContext()
      const getCursorScreenPoint = defineInvoke(context, electron.screen.getCursorScreenPoint)
      const point = await getCursorScreenPoint()
      if (point && typeof point.x === 'number' && typeof point.y === 'number')
        snapshot.cursor = { x: point.x, y: point.y }
    }
    catch (error) {
      console.warn('[lumi-proactive-vision] Failed to read cursor position for environment snapshot', error)
    }

    return snapshot
  }

  async function createEnvironmentEntry(observation: string, source: LumiEnvironmentContextEntry['source']) {
    const signature = createObservationSignature(observation)
    const repeated = Boolean(lastObservationSignature.value && lastObservationSignature.value === signature)
    const activity = classifyActivity(observation)
    const salience = estimateSalience(observation, activity, repeated)
    const environment = await createNonVisualEnvironmentSnapshot()
    const entry: LumiEnvironmentContextEntry = {
      id: createObservationId(),
      observedAt: Date.now(),
      activity,
      salience,
      source,
      environment,
      summary: compactObservationText(observation),
      observation,
      signature,
    }

    environmentContext.value = [
      ...environmentContext.value,
      entry,
    ].slice(-ENVIRONMENT_CONTEXT_LIMIT)
    currentActivity.value = activity
    lastSalience.value = salience
    lastObservationSignature.value = signature
    return { entry, repeated }
  }

  function appendSystemNoticeToSession(sessionId: string, notice: string) {
    const content = notice.startsWith('[system_notice]') ? notice : `[system_notice]\n${notice}`
    const message: ChatHistoryItem = {
      id: `system-notice-${createObservationId()}`,
      role: 'assistant',
      content,
      slices: [{ type: 'text', text: content }],
      tool_results: [],
      createdAt: Date.now(),
    }
    chatSession.setSessionMessages(sessionId, [
      ...chatSession.getSessionMessages(sessionId),
      message,
    ])
  }

  function pruneProactivePseudoSilenceMessages(sessionId: string, previousCount: number) {
    const messages = chatSession.getSessionMessages(sessionId)
    let pruned = false
    const nextMessages = messages.filter((message, index) => {
      if (index < previousCount)
        return true
      if (message.role !== 'assistant')
        return true

      const text = extractMessageText(message).trim()
      if (/^\[(?:memory_search|memory_write|system_notice)\]/.test(text))
        return true
      if (!isProactivePseudoSilence(text))
        return true

      pruned = true
      return false
    })

    if (pruned)
      chatSession.setSessionMessages(sessionId, nextMessages)
    return pruned
  }

  function buildAutonomousDecisionInput(entry: LumiEnvironmentContextEntry, repeated: boolean, messages: ChatHistoryItem[]): LumiAutonomousDecisionInput {
    const now = Date.now()
    const latestUserAt = latestMessageAt(messages, 'user')
    const idleMinutes = latestUserAt > 0 ? Math.max(0, Math.round((now - latestUserAt) / 60_000)) : 999
    const activeProject = selfTodoStore.activeProject
    const executableTodo = selfTodoStore.getNextExecutableTodo()
    const profileContext = userProfileStore.buildRelevantContext({
      messageText: entry.observation,
      recentMessages: messages,
      limit: 6,
    })

    return {
      observationSummary: entry.summary,
      activity: entry.activity,
      salience: entry.salience,
      repeated,
      nowIso: new Date(now).toISOString(),
      idleMinutes,
      ignoredProactiveStreak: Number(ignoredProactiveStreak.value || 0),
      lowChangeStreak: Number(lowChangeStreak.value || 0),
      noProgressStreak: Number(noProgressStreak.value || 0),
      todayProactiveMessageCount: Number(todayProactiveMessageCount.value || 0),
      idleDailyMaxMessages: normalizedIdleDailyMaxMessages.value,
      quietMode: Boolean(quietMode.value),
      summaryMode: summaryMode.value,
      allowAutonomousSandboxTasks: Boolean(allowAutonomousSandboxTasks.value),
      agentConfigured: Boolean(agentStore.enabled && String(lumiWorldRoot.value || DEFAULT_LUMI_WORLD_ROOT).trim()),
      diaryAvailable: Boolean(diarySchedulerStore.enabled),
      lumiWorldRoot: String(lumiWorldRoot.value || DEFAULT_LUMI_WORLD_ROOT),
      lifeTickEnabled: Boolean(autonomousLifeStore.enabled),
      activeProjectId: activeProject?.id,
      activeProjectTitle: activeProject?.title,
      executableTodoId: executableTodo?.id,
      executableTodoContent: executableTodo?.content,
      availableIdeasCount: autonomousLifeStore.ideas.length,
      pendingReflectionCount: 0,
      explicitNegativeFeedback: false,
      budgetState: buildAutonomyBudgetState(),
      currentStateContext: currentStateStore.buildPromptContext(),
      userProfileContext: profileContext,
      recentDiarySummary: diarySchedulerStore.lastStatus || '',
    }
  }

  async function decideAfterObservation(entry: LumiEnvironmentContextEntry, repeated: boolean, messages: ChatHistoryItem[]) {
    const input = buildAutonomousDecisionInput(entry, repeated, messages)
    if (!autonomousEnabled.value)
      return fallbackAutonomousDecision({ ...input, quietMode: false, summaryMode: 'normal' })

    if (input.repeated && input.salience === 'low')
      return fallbackAutonomousDecision(input)
    if (input.ignoredProactiveStreak >= normalizedObservationNoEffectThreshold.value)
      return fallbackAutonomousDecision(input)

    try {
      const providerId = consciousnessProvider.value
      const modelId = consciousnessModel.value
      if (!providerId || !modelId)
        return fallbackAutonomousDecision(input)
      const chatProvider = await providersStore.getProviderInstance<any>(providerId)
      if (!chatProvider)
        return fallbackAutonomousDecision(input)

      const chatConfig = chatProvider.chat(modelId)
      const decisionMessages: Message[] = [
        { role: 'system', content: 'You are a strict JSON decision engine for Lumi proactive observation.' },
        { role: 'user', content: buildAutonomousDecisionPrompt(input) },
      ]
      const response = await Promise.race([
        generateText({
          ...chatConfig,
          messages: decisionMessages,
          headers: { 'Accept-Encoding': 'identity' },
        }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Autonomous decision timed out')), AUTONOMOUS_DECISION_TIMEOUT_MS)
        }),
      ])
      return parseAutonomousDecision(response.text || '', input)
    }
    catch (error) {
      console.warn('[lumi-proactive-vision] autonomous decision fallback:', error)
      return fallbackAutonomousDecision(input)
    }
  }

  async function runSayMessageAction(sessionId: string, entry: LumiEnvironmentContextEntry, decision: LumiAutonomousDecisionOutput) {
    const messageCountBeforeSend = chatSession.getSessionMessages(sessionId).length
    await chatSyncStore.requestIngest({
      text: [
        createProactiveObservationInput(entry, environmentContext.value),
        '',
        '[Autonomous intention]',
        `desire: ${decision.desire}`,
        `motivation: ${decision.motivation}`,
        `plan: ${decision.plan}`,
        `targetSpace: ${decision.targetSpace}`,
        `visibility: ${decision.visibility}`,
        `riskLevel: ${decision.riskLevel}`,
        decision.executionPlan.messagePrompt ? `messagePrompt: ${decision.executionPlan.messagePrompt}` : '',
        '[/Autonomous intention]',
      ].filter(Boolean).join('\n'),
      sessionId,
      hiddenUserMessage: true,
      suppressAssistantTexts: SILENCE_MARKERS,
      systemNotices: [],
    })

    const message = latestAssistantMessageText(chatSession.getSessionMessages(sessionId), messageCountBeforeSend)
    const pseudoSilence = message ? isProactivePseudoSilence(message) : true
    if (pseudoSilence)
      pruneProactivePseudoSilenceMessages(sessionId, messageCountBeforeSend)
    lastMessage.value = pseudoSilence ? '<silence>' : message
    if (!pseudoSilence && message) {
      lastMessageAt.value = Date.now()
      awaitingProactiveResponseSince.value = lastMessageAt.value
      todayProactiveMessageCount.value = Number(todayProactiveMessageCount.value || 0) + 1
    }
    return pseudoSilence ? 'silence' : 'sent_message'
  }

  async function executeAutonomousDecision(sessionId: string, entry: LumiEnvironmentContextEntry, decision: LumiAutonomousDecisionOutput) {
    setLastDecision({
      action: decision.desire || decision.selectedAction,
      reason: `${decision.targetSpace}/${decision.visibility}: ${decision.reason}`,
      riskLevel: decision.riskLevel,
      confidence: decision.confidence,
      result: decision.selectedAction,
    })
    appendSystemNoticeToSession(sessionId, createSystemNotice(entry, decision.selectedAction))

    if (decision.mode === 'continue_self_project') {
      const result = await autonomousLifeStore.runLifeTick({ force: true })
      lastMessage.value = '<self_project>'
      appendSystemNoticeToSession(sessionId, createAutonomousSystemNotice({
        status: result.acted ? 'updated' : 'skipped',
        action: decision.mode,
        reason: decision.reason,
        result: result.changedTodoIds.length > 0 ? `changed ${result.changedTodoIds.length}` : 'no_executable_step',
      }))
      recordDecisionLog({
        entry,
        decision,
        result: result.acted ? `self_project:${result.changedTodoIds.join(',') || 'acted'}` : 'self_project:no_action',
      })
      return
    }

    if (decision.mode === 'generate_or_select_idea') {
      const result = await autonomousLifeStore.runLifeTick({ force: true, useClaude: false })
      lastMessage.value = '<idea_pool>'
      appendSystemNoticeToSession(sessionId, createAutonomousSystemNotice({
        status: result.acted ? 'updated' : 'skipped',
        action: decision.mode,
        reason: decision.reason,
        result: result.decision.mode,
      }))
      recordDecisionLog({ entry, decision, result: `idea_pool:${result.decision.mode}` })
      return
    }

    if (decision.mode === 'reflect') {
      const result = await autonomousLifeStore.runLifeTick({ force: true, useClaude: false })
      lastMessage.value = '<reflection>'
      recordDecisionLog({ entry, decision, result: `reflect:${result.decision.mode}` })
      return
    }

    if (decision.mode === 'rest') {
      autonomousLifeStore.setRest(decision.reason || 'Lumi chose to rest and reconsider later.', 60 * 60 * 1000)
      lastMessage.value = '<rest>'
      recordDecisionLog({ entry, decision, result: 'rest_with_reconsideration' })
      return
    }

    if (decision.selectedAction === 'say_message' || decision.selectedAction === 'ask_user_permission') {
      const result = await runSayMessageAction(sessionId, entry, decision)
      recordDecisionLog({
        entry,
        decision,
        result,
        userNotified: result === 'sent_message',
        followUpNeeded: decision.selectedAction === 'ask_user_permission',
      })
      return
    }

    if (decision.selectedAction === 'write_private_note') {
      const written = recordPrivateNote(entry, decision)
      lastMessage.value = written ? '<private_note>' : '<runtime_log>'
      recordDecisionLog({ entry, decision, result: written ? 'private_note_written' : 'runtime_log_written' })
      return
    }

    if (decision.selectedAction === 'write_daily_summary') {
      appendSystemNoticeToSession(sessionId, createAutonomousSystemNotice({
        status: 'running',
        action: decision.selectedAction,
        reason: decision.reason,
        result: 'requesting_diary_write',
      }))
      await diarySchedulerStore.writeToday('autonomous')
      lastMessage.value = '<diary_summary>'
      recordDecisionLog({ entry, decision, result: 'diary_requested', userNotified: true })
      return
    }

    if (decision.selectedAction === 'adjust_low_risk_setting') {
      const changes = applyAutonomousSettingsPatch(decision)
      appendSystemNoticeToSession(sessionId, createAutonomousSystemNotice({
        status: changes.length ? 'updated' : 'no_change',
        action: decision.selectedAction,
        reason: decision.reason,
        result: changes.length ? 'settings_changed' : 'no_setting_changed',
        changes,
      }))
      if (decision.executionPlan.note)
        recordPrivateNote(entry, decision)
      lastMessage.value = '<settings_adjusted>'
      recordDecisionLog({ entry, decision, result: changes.length ? 'settings_changed' : 'no_change', settingsChanged: changes, userNotified: true })
      return
    }

    if (decision.selectedAction === 'create_sandbox_artifact' || decision.selectedAction === 'prepare_agent_task') {
      if (!allowAutonomousSandboxTasks.value || !agentStore.enabled || !String(lumiWorldRoot.value || DEFAULT_LUMI_WORLD_ROOT).trim()) {
        appendSystemNoticeToSession(sessionId, createAutonomousSystemNotice({
          status: 'blocked',
          action: decision.selectedAction,
          reason: decision.reason,
          result: 'sandbox_not_available',
        }))
        recordDecisionLog({ entry, decision, result: 'blocked_sandbox_not_available', followUpNeeded: true })
        return
      }

      if (lastAutonomousAgentAt.value && Date.now() - lastAutonomousAgentAt.value < Number(agentSuggestionCooldownMs.value)) {
        recordDecisionLog({ entry, decision, result: 'skipped_agent_cooldown' })
        return
      }

      const taskPrompt = decision.executionPlan.taskPrompt || [
        'This is Lumi acting inside her own LumiWorld space after a proactive observation.',
        `LumiWorld root: ${lumiWorldRoot.value || DEFAULT_LUMI_WORLD_ROOT}`,
        `desire: ${decision.desire}`,
        `motivation: ${decision.motivation}`,
        `plan: ${decision.plan}`,
        decision.targetPath ? `preferred relative target path: ${decision.targetPath}` : '',
        `visibility: ${decision.visibility}`,
        `screen observation summary: ${entry.summary}`,
        '',
        'Hard boundaries:',
        '- Work only inside the current working directory, which is inside LumiWorld.',
        '- You may create folders, files, drafts, private notes, experiments, or small projects.',
        '- Do not read secrets, API keys, system config, browser data, SSH keys, tokens, AIRI/Lumi source code, or unrelated user files.',
        '- Do not delete audit logs or try to bypass permissions.',
        '- Keep the result low-risk and self-contained.',
      ].join('\n')
      const lumiWorldSettings = {
        ...agentStore.settings,
        lumiSandboxRoot: String(lumiWorldRoot.value || DEFAULT_LUMI_WORLD_ROOT),
        defaultPermissionMode: 'sandbox_auto' as const,
        sandboxAutoApprove: true,
      }
      const result = await agentStore.runClaudeTask({
        userRequest: taskPrompt,
        taskType: 'coding_help',
        permissionMode: 'sandbox_auto',
        targetName: deriveLumiWorldTaskName(decision),
        settings: lumiWorldSettings,
      })
      lastAutonomousAgentAt.value = Date.now()
      appendSystemNoticeToSession(sessionId, createAutonomousSystemNotice({
        status: result.status,
        action: decision.selectedAction,
        reason: decision.reason,
        result: result.taskId,
      }))
      recordDecisionLog({ entry, decision, result: `agent_${result.status}:${result.taskId}`, userNotified: true, followUpNeeded: result.status !== 'success' })
      return
    }

    lastMessage.value = '<silence>'
    recordDecisionLog({ entry, decision, result: decision.mode === 'observe_quietly' ? 'observe_quietly' : 'no_action' })
  }

  async function runTick(options: { force?: boolean } = {}) {
    if (!enabled.value && !options.force) {
      recordSkippedTick('disabled')
      return
    }
    if (processing.value) {
      recordSkippedTick('already_processing')
      return
    }
    lastTickStartedAt.value = Date.now()
    lastSkipReason.value = ''
    if (!options.force && visionFailureBackoffUntil.value && Date.now() < visionFailureBackoffUntil.value) {
      recordSkippedTick('vision_failure_backoff')
      return
    }
    cardStore.initialize()
    if (publishOnlyWhenLumiActive.value && cardStore.activeCardId !== LUMI_AIRI_CARD_ID) {
      recordSkippedTick('lumi_card_inactive')
      return
    }
    if (!configured.value) {
      lastError.value = 'Vision or consciousness model is not configured.'
      recordSkippedTick('model_not_configured')
      return
    }
    if (lastMessageAt.value && Date.now() - lastMessageAt.value < cooldownMs.value) {
      recordSkippedTick('proactive_message_cooldown')
      return
    }

    processing.value = true
    tickCount.value += 1
    try {
      const sessionId = await ensureActiveChatSession()
      refreshResponseMetrics(chatSession.getSessionMessages(sessionId))
      const observation = await understandScreen({ stopStreamAfterCapture: true })
      captureFailureCount.value = 0
      clearVisionFailureBackoff()
      lastObservation.value = observation
      const { entry, repeated } = await createEnvironmentEntry(observation, 'scheduled')
      lowChangeStreak.value = repeated && entry.salience === 'low'
        ? Number(lowChangeStreak.value || 0) + 1
        : 0
      const decision = await decideAfterObservation(entry, repeated, chatSession.getSessionMessages(sessionId))
      await executeAutonomousDecision(sessionId, entry, decision)
      if (decision.mode === 'observe_quietly' || decision.mode === 'rest')
        skippedCount.value += 1
      lastError.value = ''
    }
    catch (error) {
      const message = errorMessageFrom(error) ?? 'Unknown proactive vision error'
      captureFailureCount.value += 1
      lastError.value = message
      updateVisionFailureBackoff(message)
      setLastDecision({
        action: 'error',
        reason: message,
        result: 'failed',
      })
      const sessionId = chatSession.activeSessionId
      if (sessionId && (options.force || shouldAppendScheduledErrorNotice(message)))
        appendSystemNoticeToSession(sessionId, createErrorSystemNotice(message, sourceId.value))
      if (captureFailureCount.value >= 2)
        stopStream()
    }
    finally {
      processing.value = false
      lastTickFinishedAt.value = Date.now()
    }
  }

  async function listObservationSourcesForChatTool() {
    await refetchSources()
    activeSourceId.value = sources.value.some(source => source.id === sourceId.value)
      ? sourceId.value
      : ''
    return JSON.stringify({
      status: 'ok',
      sources: sources.value.map(source => ({
        sourceId: source.id,
        type: source.id.startsWith('window:') ? 'window' : 'screen',
        name: source.name,
      })),
      instruction: 'Choose the most relevant source for the user request, then call lumi_observe_screen with its exact sourceId. Choose a screen only when the whole desktop context is genuinely needed.',
    })
  }

  async function observeScreenForChatTool(reason: string, targetSourceId: string) {
    cardStore.initialize()
    if (publishOnlyWhenLumiActive.value && cardStore.activeCardId !== LUMI_AIRI_CARD_ID) {
      return JSON.stringify({
        status: 'inactive_persona',
        observation: '',
        instruction: 'Lumi is not the active persona, so do not use screen observation in this reply.',
      })
    }

    if (!configured.value) {
      return JSON.stringify({
        status: 'not_configured',
        observation: '',
        instruction: 'The vision module or consciousness module is not configured. Tell the user screen observation is not ready.',
      })
    }

    try {
      await refetchSources()
      const targetSource = sources.value.find(source => source.id === targetSourceId)
      if (!targetSource)
        throw new Error(`The requested capture source is no longer available: ${targetSourceId}. List sources again and choose a current source.`)

      tickCount.value += 1
      processing.value = true
      const observation = await understandScreen({
        stopStreamAfterCapture: true,
        targetSourceId,
      })
      captureFailureCount.value = 0
      clearVisionFailureBackoff()
      lastObservation.value = observation
      const { entry } = await createEnvironmentEntry(observation, 'tool')
      const time = createObservationTimeContext(entry.observedAt)
      setLastDecision({
        action: 'observe_screen_tool',
        reason: 'Screen observation tool was called by the chat chain.',
        result: 'tool_result',
      })
      const sessionId = chatSession.activeSessionId
      if (sessionId)
        appendSystemNoticeToSession(sessionId, createSystemNotice(entry, 'tool_result'))
      lastError.value = ''

      return JSON.stringify({
        status: 'ok',
        source: 'lumi_own_screen_observation',
        captureTarget: {
          sourceId: targetSourceId,
          type: targetSource.id.startsWith('window:') ? 'window' : 'screen',
          name: targetSource.name,
        },
        reason,
        activity: entry.activity,
        salience: entry.salience,
        currentTime: {
          local: time.local,
          iso: time.iso,
          timeZone: time.timeZone,
          unixMs: time.unixMs,
          instruction: 'This is the authoritative current time when Lumi observed the screen. Use it over any time guessed from the image.',
        },
        environment: entry.environment,
        observation,
        recentContext: environmentContext.value.slice(-5).map(item => ({
          observedAt: item.observedAt,
          observedAtLocal: createObservationTimeContext(item.observedAt).local,
          observedAtIso: createObservationTimeContext(item.observedAt).iso,
          activity: item.activity,
          salience: item.salience,
          captureSourceName: item.environment.capture.selectedSourceName,
          appRoute: item.environment.app.route,
          summary: item.summary,
        })),
        instruction: 'Use this as Lumi\'s own current screen observation. The user did not send this as a chat message; Lumi actively looked at the screen.',
      })
    }
    catch (error) {
      const message = errorMessageFrom(error) ?? 'Unknown screen observation error'
      captureFailureCount.value += 1
      lastError.value = message
      if (captureFailureCount.value >= 2)
        stopStream()
      const sessionId = chatSession.activeSessionId
      if (sessionId)
        appendSystemNoticeToSession(sessionId, createErrorSystemNotice(message, targetSourceId, 'tool_error'))
      return JSON.stringify({
        status: 'error',
        error: message,
        observation: '',
        instruction: 'Screen observation failed. Briefly tell the user Lumi could not see the screen right now.',
      })
    }
    finally {
      processing.value = false
    }
  }

  function createListObservationSourcesTool(): Promise<Tool> {
    return tool({
      name: 'lumi_list_observation_sources',
      description: 'List the screens and individual desktop windows Lumi can currently observe. Call this before lumi_observe_screen so Lumi can choose the relevant target itself.',
      parameters: z.object({}).strict(),
      execute: async () => listObservationSourcesForChatTool(),
    })
  }

  function createObserveScreenTool(): Promise<Tool> {
    return tool({
      name: 'lumi_observe_screen',
      description: 'Observe exactly one current desktop source chosen by Lumi. First call lumi_list_observation_sources, then pass the selected sourceId. This tool never substitutes the configured proactive-vision source or silently broadens a window capture to the whole screen.',
      parameters: z.object({
        reason: z.string().min(1).describe('Why Lumi needs to look at the screen for this reply.'),
        sourceId: z.string().min(1).describe('Exact sourceId returned by lumi_list_observation_sources for the screen or window Lumi chose.'),
      }).strict(),
      execute: async payload => observeScreenForChatTool(payload.reason, payload.sourceId),
    })
  }

  async function registerObserveScreenTool() {
    if (observeScreenToolRegistered)
      return

    await useLlmToolsStore().registerTools(LUMI_PROACTIVE_VISION_TOOLS_PROVIDER, Promise.all([
      createListObservationSourcesTool(),
      createObserveScreenTool(),
    ]))
    useLlmToolsetPromptsStore().registerToolsetPrompts(LUMI_PROACTIVE_VISION_TOOLS_PROVIDER, [
      {
        id: 'lumi-observe-screen-guidance',
        title: 'Lumi Screen Observation',
        content: [
          'When the active persona is Lumi, first call `lumi_list_observation_sources`, choose the window or screen relevant to the user request, then call `lumi_observe_screen` with that exact sourceId.',
          'Call it when the user explicitly asks Lumi to look at the screen/current page/current window, or when a normal reply genuinely needs current screen awareness.',
          'Prefer a relevant individual window when its title identifies the requested content. Choose a screen only when the request needs cross-window or whole-desktop context.',
          'The source configured in settings belongs only to scheduled proactive vision. Do not assume it is the right source for a chat tool call.',
          'Do not call it for ordinary chat, memory recall, emotional replies, or image attachments already handled by Lumi Eyes.',
          'The tool result is Lumi\'s own observation, not a user message. Lumi must not say the user sent the screen unless the user actually did.',
        ].join('\n'),
      },
    ])
    observeScreenToolRegistered = true
  }

  function clearObserveScreenTool() {
    observeScreenToolRegistered = false
    useLlmToolsStore().clearTools(LUMI_PROACTIVE_VISION_TOOLS_PROVIDER)
    useLlmToolsetPromptsStore().clearToolsetPrompts(LUMI_PROACTIVE_VISION_TOOLS_PROVIDER)
  }

  async function start() {
    if (running.value)
      return
    running.value = true
    enabled.value = true
    lastSkipReason.value = ''
    lastScheduledDelayMs.value = 0
    nextScheduledAt.value = Date.now() + 1500
    void refreshSources().catch((error) => {
      lastError.value = `Failed to refresh capture sources during startup: ${errorMessageFrom(error) ?? String(error)}`
      recordRuntimeLog('runtimeLog', 'Proactive vision source refresh failed during startup.', lastError.value)
    })
    timeoutHandle = setTimeout(() => {
      timeoutHandle = undefined
      nextScheduledAt.value = null
      void runTick().finally(() => scheduleNextTick())
    }, 1500)
  }

  function stop(options: { disable?: boolean, keepLastError?: boolean } = {}) {
    running.value = false
    if (options.disable !== false)
      enabled.value = false
    clearScheduledTick()
    stopStream()
    if (video) {
      video.pause()
      video.srcObject = null
      video.remove()
      video = undefined
    }
    if (!options.keepLastError)
      captureFailureCount.value = 0
  }

  function resetState() {
    stop()
    cleanup()
    sourceId.reset()
    workloadId.reset()
    minIntervalMs.reset()
    maxIntervalMs.reset()
    cooldownMs.reset()
    publishOnlyWhenLumiActive.reset()
    autonomousEnabled.reset()
    quietMode.reset()
    summaryMode.reset()
    idleDailyMaxMessages.reset()
    agentSuggestionCooldownMs.reset()
    observationNoEffectThreshold.reset()
    allowAutonomousSandboxTasks.reset()
    lumiWorldRoot.reset()
    decisionLog.reset()
    privateNotes.reset()
    runtimeLogs.reset()
    settingChangeAudit.reset()
    todayProactiveDate.reset()
    todayProactiveMessageCount.reset()
    ignoredProactiveStreak.reset()
    lowChangeStreak.reset()
    noProgressStreak.reset()
    awaitingProactiveResponseSince.reset()
    lastAutonomousAgentAt.reset()
    lastError.value = ''
    lastObservation.value = ''
    lastMessage.value = ''
    lastCaptureAt.value = null
    clearLastCaptureImages()
    lastMessageAt.value = null
    lastScheduledDelayMs.value = null
    tickCount.value = 0
    skippedCount.value = 0
    captureFailureCount.value = 0
    environmentContext.value = []
    currentActivity.value = 'unknown'
    lastSalience.value = 'low'
    lastDecision.value = null
    lastObservationSignature.value = ''
  }

  function clearLastCaptureImages(broadcast = true) {
    const clearedAt = Date.now()
    lastCaptureImagesClearedAt = Math.max(lastCaptureImagesClearedAt, clearedAt)
    lastCaptureSourceId.value = ''
    lastCaptureSourceName.value = ''
    lastCapturedImageDataUrl.value = ''
    lastVisionInputImageDataUrl.value = ''
    if (broadcast) {
      captureImageChannel.postMessage({
        type: 'clear',
        senderId: captureImageChannelInstanceId,
        clearedAt,
      })
    }
  }

  return {
    enabled,
    running,
    processing,
    configured,
    sourceId,
    workloadId,
    minIntervalMs,
    maxIntervalMs,
    cooldownMs,
    publishOnlyWhenLumiActive,
    autonomousEnabled,
    quietMode,
    summaryMode,
    idleDailyMaxMessages,
    agentSuggestionCooldownMs,
    observationNoEffectThreshold,
    allowAutonomousSandboxTasks,
    lumiWorldRoot,
    decisionLog,
    privateNotes,
    runtimeLogs,
    settingChangeAudit,
    todayProactiveMessageCount,
    ignoredProactiveStreak,
    lowChangeStreak,
    noProgressStreak,
    normalizedIdleDailyMaxMessages,
    normalizedObservationNoEffectThreshold,
    sources,
    activeSource,
    activeStream,
    isRefetching,
    hasFetchedOnce,
    workloadOptions,
    lastError,
    lastObservation,
    lastMessage,
    lastCaptureAt,
    lastCaptureSourceId,
    lastCaptureSourceName,
    lastCapturedImageDataUrl,
    lastVisionInputImageDataUrl,
    lastMessageAt,
    lastScheduledDelayMs,
    nextScheduledAt,
    lastTickStartedAt,
    lastTickFinishedAt,
    lastSkipReason,
    tickCount,
    skippedCount,
    captureFailureCount,
    environmentContext,
    currentActivity,
    lastSalience,
    lastDecision,
    clearLastCaptureImages,
    requestLastCaptureImages,
    decideAfterObservation,
    executeAutonomousDecision,
    recordDecisionLog,
    buildReturnSummaryContext,
    listObservationSourcesForChatTool,
    observeScreenForChatTool,
    refreshSources,
    selectSource,
    runTick,
    registerObserveScreenTool,
    clearObserveScreenTool,
    setRuntimeStatusPublishingEnabled,
    start,
    stop,
    resetState,
  }
})
