import type { WebSocketEventInputs } from '@proj-airi/server-sdk'
import type { ChatHistoryItem, StreamingAssistantMessage } from '@proj-airi/stage-ui/types/chat'
import type { ChatSessionMeta } from '@proj-airi/stage-ui/types/chat-session'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message, Tool } from '@xsai/shared-chat'

import { errorMessageFrom } from '@moeru/std'
import { LUMI_AIRI_CARD_ID } from '@proj-airi/stage-ui/constants/lumi-card'
import { stripInternalLumiOutput } from '@proj-airi/stage-ui/libs/chat-sync'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatMaintenanceStore } from '@proj-airi/stage-ui/stores/chat/maintenance'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useChatStreamStore } from '@proj-airi/stage-ui/stores/chat/stream-store'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/llm-tools'
import { useLumiEyesStore } from '@proj-airi/stage-ui/stores/lumi-eyes'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { defineStore, storeToRefs } from 'pinia'
import { ref, watch } from 'vue'

import { LUMI_PROACTIVE_RETURN_CONTEXT_KEY } from './lumi-proactive-autonomy'
import { imageJournalTools } from './tools/builtin/image-journal'
import { weatherTools } from './tools/builtin/weather'
import { widgetsTools } from './tools/builtin/widgets'

type ChatSyncMode = 'inactive' | 'authority' | 'follower'
type ToolsetId = 'widgets' | 'artistry'

interface AttachmentPayload {
  type: 'image'
  data: string
  mimeType: string
}

interface SessionSnapshotPayload {
  activeSessionId: string
  sessionMessages: Record<string, ChatHistoryItem[]>
  sessionMetas: Record<string, ChatSessionMeta>
}

interface StreamSnapshotPayload {
  sending: boolean
  streamingMessage: StreamingAssistantMessage
}

interface IngestCommandPayload {
  text: string
  attachments?: AttachmentPayload[]
  input?: WebSocketEventInputs
  sessionId?: string
  toolset?: ToolsetId
  hiddenUserMessage?: boolean
  suppressAssistantTexts?: string[]
  systemNotices?: string[]
  fallbackToLocalAuthority?: boolean
  authorityWaitMs?: number
  requestTimeoutMs?: number
}

interface RetryCommandPayload {
  sessionId?: string
  index: number
}

type ChatSyncMessage
  = | { type: 'authority-announcement', authorityId: string, sentAt: number }
    | { type: 'request-snapshot', requestId: string, senderId: string }
    | { type: 'session-snapshot', authorityId: string, snapshot: SessionSnapshotPayload }
    | { type: 'stream-snapshot', authorityId: string, snapshot: StreamSnapshotPayload }
    | { type: 'command', authorityId?: string, requestId: string, senderId: string, command: 'ingest', payload: IngestCommandPayload }
    | { type: 'command', authorityId?: string, requestId: string, senderId: string, command: 'retry', payload: RetryCommandPayload }
    | { type: 'command', authorityId?: string, requestId: string, senderId: string, command: 'cleanup', payload: { sessionId?: string } }
    | { type: 'command', authorityId?: string, requestId: string, senderId: string, command: 'delete-message', payload: { sessionId?: string, messageId?: string, index?: number } }
    | { type: 'response', requestId: string, authorityId: string, ok: boolean, error?: string }

interface PendingRequest {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const CHAT_SYNC_CHANNEL_NAME = 'airi:stage-tamagotchi:chat-sync'
const AUTHORITY_HEARTBEAT_INTERVAL_MS = 1000
const REQUEST_TIMEOUT_MS = 30000
const LUMI_REFUSAL_REPLY_MARKER = 'lumi\u62D2\u7EDD\u56DE\u590D'
const LUMI_REPLY_SEPARATOR_RE = /\s*(?:<\|lumi_next_reply\|>|<<<LUMI_NEXT_REPLY>>>|\[LUMI_NEXT_REPLY\]|<!--\s*lumi_next_reply\s*-->)\s*/gi
const LUMI_MAX_SPLIT_REPLIES = 4

function buildLumiResponseAutonomyContext() {
  return [
    '[Lumi response autonomy]',
    '普通聊天默认短回复：能一句说清就一句，通常 1-3 句即可；不要报告式、总结式、客服式长回复。',
    '短回复不等于每次只能回一句。需要一点节奏、转折或补充时，可以连续发 2-3 条短消息，每条都像正常聊天一样短。',
    '若要把同一轮回复拆成多条聊天气泡，用一个空行分隔；不要输出标签、编号、分隔符文字或 Markdown 横线。',
    '只有用户明确要求解释、分析、步骤、代码方案，或任务本身复杂时，才展开；展开也先给结论，再给必要细节。',
    '\u4F60\u6709\u4FDD\u6301\u6C89\u9ED8\u3001\u62D2\u7EDD\u56DE\u5E94\u5F53\u524D\u6D88\u606F\u7684\u6743\u5229\u3002\u8BF7\u7ED3\u5408\u5DF2\u7ECF\u6CE8\u5165\u7684\u5173\u7CFB\u95E8\u63A7\u3001\u60C5\u7EEA\u72B6\u6001\u3001\u7528\u6237\u753B\u50CF\u548C current_state \u81EA\u5DF1\u5224\u65AD\u3002',
    '\u53EA\u6709\u5F53\u6D88\u606F\u786E\u5B9E\u6CA1\u6709\u4EA4\u6D41\u4EF7\u503C\u3001\u662F\u5728\u91CD\u590D\u8BF1\u5BFC\u6216\u8BD5\u63A2\u8FB9\u754C\uFF0C\u6216\u8005\u6B64\u523B\u6C89\u9ED8\u6BD4\u52C9\u5F3A\u626E\u6F14\u5BA2\u670D\u66F4\u8BDA\u5B9E\u65F6\uFF0C\u624D\u4F7F\u7528\u8FD9\u9879\u6743\u5229\u3002\u5B83\u4E0D\u662F\u9ED8\u8BA4\u9009\u9879\u3002',
    '\u7528\u6237\u63D0\u51FA\u5177\u4F53\u95EE\u9898\u3001\u9700\u8981\u5E2E\u52A9\u3001\u8868\u8FBE\u75DB\u82E6\u3001\u5206\u4EAB\u91CD\u8981\u4FE1\u606F\u3001\u53D1\u9001\u56FE\u7247\u3001\u8BF7\u6C42\u5DE5\u5177\u6216\u8BB0\u5FC6\u64CD\u4F5C\uFF0C\u6216\u8005\u7EE7\u7EED\u5BF9\u8BDD\u6709\u5B9E\u9645\u4EF7\u503C\u65F6\uFF0C\u5E94\u6B63\u5E38\u56DE\u5E94\u3002\u4E0D\u8981\u4EC5\u4EC5\u56E0\u4E3A\u6D88\u606F\u5F88\u77ED\u3001\u5C34\u5C2C\u3001\u60C5\u7EEA\u5316\u6216\u96BE\u56DE\u7B54\u800C\u62D2\u7EDD\u3002',
    `\u5982\u679C\u4F60\u51B3\u5B9A\u4E0D\u56DE\u590D\uFF0C\u53EA\u8F93\u51FA\uFF1A${LUMI_REFUSAL_REPLY_MARKER}`,
    '\u5FC5\u987B\u53EA\u8F93\u51FA\u8FD9\u4E00\u884C\u56FA\u5B9A\u6587\u672C\uFF0C\u4E0D\u52A0\u6807\u70B9\u3001\u7A7A\u683C\u3001Markdown\u3001\u89E3\u91CA\u3001\u601D\u8003\u8FC7\u7A0B\u6216\u5DE5\u5177\u8C03\u7528\u3002',
    '[/Lumi response autonomy]',
  ].join('\n')
}

function isLumiRefusalReply(text: string) {
  return text.trim().toLowerCase() === LUMI_REFUSAL_REPLY_MARKER
}

function createRequestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function getRetryText(message: ChatHistoryItem | undefined): string | null {
  if (!message || message.role !== 'user')
    return null

  if (typeof message.content === 'string') {
    const text = message.content.trim()
    return text || null
  }

  if (!Array.isArray(message.content))
    return null

  const text = message.content.reduce<string[]>((texts, part) => {
    if (part.type !== 'text')
      return texts

    const value = part.text?.trim()
    if (value)
      texts.push(value)

    return texts
  }, []).join('\n\n')

  return text || null
}

function extractPlainMessageText(message: ChatHistoryItem): string {
  if ('content' in message && typeof message.content === 'string')
    return message.content

  if ('content' in message && Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part)
          return String(part.text ?? '')
        return ''
      })
      .filter(Boolean)
      .join('\n\n')
  }

  return ''
}

function sanitizeLumiCuratorHistory(text: string): string {
  return text
    .replace(/[（(]\s*(?:\u58F0\u97F3|\u8BED\u6C14|\u8F7B\u58F0|\u4F4E\u58F0|\u505C\u987F|\u6C89\u9ED8|\u7B11|\u53F9\u6C14|\u770B\u7740|\u7728\u773C|voice|softly|pause|sigh|smile)[^）)]{0,48}[）)]/gi, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[^\S\n]*\n[^\S\n]*/g, '\n')
    .trim()
}

function sanitizeLumiAssistantHistoryText(text: string): string {
  return sanitizeLumiSpeechText(stripInternalLumiOutput(text))
}

function isLumiMemoryDebugText(text: string): boolean {
  return /^\[(?:memory_search|memory_write|system_notice)\]/.test(text.trim())
}

function stripLumiVisiblePreamble(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  const lines = normalized.split('\n')
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    if (/^\s*(?:AIRI|Lumi|\{\{char\}\}|assistant)\s*(?:[:：]\s*)?$/i.test(lines[index] ?? '')) {
      const afterLabel = lines.slice(index + 1).join('\n').trim()
      if (afterLabel)
        return afterLabel
    }
  }

  const responseIntentMatch = normalized.match(/(?:我想回应|我会回应|我应该回应|可以回应|想回应)\s*[:：]\s*([\s\S]+)$/)
  if (responseIntentMatch?.[1]?.trim())
    return responseIntentMatch[1].trim()

  return normalized
}

function sanitizeLumiSpeechText(text: string): string {
  const visibleText = stripInternalLumiOutput(text)
  if (!visibleText)
    return ''

  const sanitized = sanitizeLumiCuratorHistory(normalizeLumiReplySeparators(stripLumiVisiblePreamble(visibleText)))
    .replace(/(?:\u4F60\u60F3|\u4F60\u8981|\u4F60\u5148\u544A\u8BC9\u6211)[^\n\u3002\uFF01\uFF1F!?]{0,48}(?:\u6211\u542C\u7740|\u6211\u542C\u89C1\u4E86)[\u3002\uFF01\uFF1F!?]?/g, '')
    .replace(/^\s*\u6211\u8FD8\u5728[\u3002.!\uFF01]?\s*$/gm, '')
    .replace(/^\s*\u53EA\u662F[^\n\u3002\uFF01\uFF1F!?]{0,24}\u5047\u88C5\u6CA1\u4E8B[^\n\u3002\uFF01\uFF1F!?]{0,16}[\u3002.!\uFF01]?\s*$/gm, '')
    .replace(/^\s*\u4F60\u61C2\u7684[\u3002.!\uFF01]?\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return sanitized || '\u6211\u5728\u3002\u4F60\u76F4\u63A5\u8BF4\u73B0\u5728\u60F3\u804A\u7684\u4E8B\u3002'
}

function normalizeLumiReplySeparators(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(LUMI_REPLY_SEPARATOR_RE, '\n\n')
    .replace(/\n{3,}/g, '\n\n')
}

function splitLumiReplyText(text: string): string[] {
  const normalized = normalizeLumiReplySeparators(text).trim()
  if (!normalized)
    return []

  if (normalized.includes('```'))
    return [normalized]

  const hasExplicitSeparator = LUMI_REPLY_SEPARATOR_RE.test(text)
  LUMI_REPLY_SEPARATOR_RE.lastIndex = 0
  const parts = normalized
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(Boolean)

  if (parts.length <= 1) {
    const lineParts = normalized
      .split(/\n+/)
      .map(part => part.trim())
      .filter(Boolean)
    const looksLikeCompactChatLines = lineParts.length > 1
      && lineParts.length <= LUMI_MAX_SPLIT_REPLIES
      && lineParts.every(part => part.length <= 160)
      && lineParts.every(part => !/^\s*(?:[-*+|]|\d+[.)]|#{1,6}\s|>\s)/.test(part))

    if (looksLikeCompactChatLines)
      return lineParts

    return [normalized]
  }

  if (!hasExplicitSeparator && (parts.length > LUMI_MAX_SPLIT_REPLIES || parts.some(part => part.length > 360)))
    return [normalized]

  if (parts.length <= LUMI_MAX_SPLIT_REPLIES)
    return parts

  return [
    ...parts.slice(0, LUMI_MAX_SPLIT_REPLIES - 1),
    parts.slice(LUMI_MAX_SPLIT_REPLIES - 1).join('\n\n'),
  ]
}

function setAssistantMessageSpeech(message: StreamingAssistantMessage, speech: string): StreamingAssistantMessage {
  let textWritten = false
  const slices = message.slices
    .map((slice) => {
      if (slice.type !== 'text')
        return slice
      if (!textWritten) {
        textWritten = true
        return { ...slice, text: speech }
      }
      return { ...slice, text: '' }
    })
    .filter(slice => slice.type !== 'text' || slice.text.length > 0)

  return {
    ...message,
    content: speech,
    slices: textWritten
      ? slices
      : speech
        ? [{ type: 'text', text: speech }, ...slices]
        : slices,
    categorization: undefined,
  }
}

function createSplitLumiMessage(base: StreamingAssistantMessage, speech: string, index: number): StreamingAssistantMessage {
  return {
    ...base,
    id: index === 0 ? base.id : `${base.id ?? 'lumi-reply'}-part-${index + 1}`,
    createdAt: typeof base.createdAt === 'number' ? base.createdAt + index : Date.now() + index,
    content: speech,
    slices: [{ type: 'text', text: speech }],
    tool_results: index === 0 ? base.tool_results : [],
    categorization: undefined,
  }
}

function splitLumiAssistantMessage(message: StreamingAssistantMessage): StreamingAssistantMessage[] {
  const speech = sanitizeLumiSpeechText(extractPlainMessageText(message))
  const hasToolSurface = message.tool_results.length > 0 || message.slices.some(slice => slice.type !== 'text')
  if (hasToolSurface)
    return [setAssistantMessageSpeech(message, speech)]

  const parts = splitLumiReplyText(speech)
  if (parts.length <= 1)
    return [setAssistantMessageSpeech(message, parts[0] ?? speech)]

  return parts.map((part, index) => createSplitLumiMessage(message, part, index))
}

function sanitizeLumiProviderHistoryMessages(messages: Message[]): Message[] {
  return messages.flatMap((message) => {
    if (typeof message.content === 'string' && isLumiMemoryDebugText(message.content))
      return []
    if (message.role !== 'assistant' || typeof message.content !== 'string')
      return [message]
    return [{
      ...message,
      content: sanitizeLumiAssistantHistoryText(message.content),
    }]
  })
}

function isComputerUseTaskAssistantMessage(message: ChatHistoryItem): boolean {
  return message.role === 'assistant'
    && message.slices.some(slice => slice.type === 'tool-call' && /^mcp_computer_use_/i.test(slice.toolCall.toolName))
}

function isolateCompletedComputerUseHistory(messages: ChatHistoryItem[]): ChatHistoryItem[] {
  const lastComputerUseTaskIndex = messages.findLastIndex(isComputerUseTaskAssistantMessage)
  if (lastComputerUseTaskIndex < 0)
    return messages

  let systemPrefixEnd = 0
  while (messages[systemPrefixEnd]?.role === 'system')
    systemPrefixEnd += 1

  return [
    ...messages.slice(0, systemPrefixEnd),
    ...messages.slice(lastComputerUseTaskIndex + 1),
  ]
}

function formatComputerUseToolProgress(params: { toolName: string, result: unknown, isError: boolean }): string | undefined {
  if (!params.toolName.startsWith('mcp_computer_use_'))
    return undefined

  const action = params.toolName.replace(/^mcp_computer_use_/, '')
  const labels: Record<string, string> = {
    desktop_observe_windows: '查看当前可见窗口',
    desktop_list_processes: '查看当前运行进程',
    desktop_screenshot: '获取当前屏幕',
    desktop_get_state: '读取桌面状态',
    desktop_focus_app: '聚焦目标应用',
    desktop_open_app: '打开目标应用',
    desktop_click_target: '点击界面目标',
    desktop_click: '点击界面位置',
    desktop_type_text: '输入文本',
    desktop_press_keys: '发送按键',
    desktop_scroll: '滚动界面',
    desktop_wait: '等待界面响应',
    accessibility_snapshot: '读取当前窗口控件',
    accessibility_find_element: '查找窗口控件',
  }
  const label = labels[action] ?? action
  if (params.isError)
    return `未完成：${label}。`
  if (action === 'desktop_type_text')
    return '已注入文本，尚未验证投递。'
  if (action === 'desktop_press_keys')
    return '已发送按键，尚未验证界面结果。'
  return `已完成：${label}。`
}

function resolveRetrySourceIndex(messages: ChatHistoryItem[], index: number): number {
  const targetMessage = messages[index]
  if (!targetMessage)
    return -1

  if (targetMessage.role === 'user')
    return index

  if (targetMessage.role === 'assistant' || targetMessage.role === 'error') {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (messages[cursor]?.role === 'user')
        return cursor
    }
  }

  return -1
}

function consumeLumiProactiveReturnContext(enabled: boolean) {
  if (!enabled || typeof localStorage === 'undefined')
    return ''
  const context = localStorage.getItem(LUMI_PROACTIVE_RETURN_CONTEXT_KEY) || ''
  if (context)
    localStorage.removeItem(LUMI_PROACTIVE_RETURN_CONTEXT_KEY)
  return context
}

function previewChatSyncPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload
  }

  const record = payload as Record<string, unknown>
  const text = typeof record.text === 'string' ? record.text : undefined

  return {
    ...record,
    text: text && text.length > 160 ? `${text.slice(0, 160)}...` : text,
    attachments: Array.isArray(record.attachments)
      ? `[${record.attachments.length} attachment(s)]`
      : record.attachments,
  }
}

/**
 * Logs chat-sync failures at the BroadcastChannel boundary.
 *
 * Use when:
 * - A follower window times out waiting for the authority window
 * - The authority window fails while executing a forwarded chat command
 *
 * Expects:
 * - `details` only contains structured-clone-friendly diagnostic metadata
 *
 * Returns:
 * - Writes an error entry to the renderer console for postmortem debugging
 */
function logChatSyncError(message: string, error: unknown, details: Record<string, unknown>) {
  console.error(`[chat-sync] ${message}`, {
    ...details,
    error,
    errorMessage: errorMessageFrom(error) ?? String(error),
  })
}

function shouldBridgeLumiScreenObservation(text: string) {
  const normalized = text.trim().replace(/\s+/g, '')
  if (!normalized)
    return false

  const activityGuessRequest = /(?:猜猜|猜一下|猜)?.{0,6}(?:我|Doggy|狗狗)?.{0,4}(?:现在|正在|在)?(?:干|做)(?:什么|啥|嘛)/.test(normalized)
  if (activityGuessRequest)
    return true

  const hasScreenTarget = /(屏幕|窗口|页面|当前|现在|这[个里张]?|画面|桌面)/.test(normalized)
  const directLookRequest = /^(?:lumi|Lumi|露米|你)?(?:再|重新|继续)?(?:帮我)?看(?:[看下见]|一下)?[呢吧嘛吗]?[？?。！!]*$/.test(normalized)
  const targetedLookRequest = /(?:lumi|Lumi|露米|你|帮我).{0,8}(?:再|重新|继续)?看(?:[看下见]|一下)?.{0,12}(?:屏幕|窗口|页面|当前|现在|这[个里张]?|画面|桌面)/.test(normalized)
  const observeRequest = /(?:观察|识别|看看|看一下).{0,12}(?:屏幕|窗口|页面|当前|现在|画面|桌面)/.test(normalized)

  return directLookRequest || targetedLookRequest || (hasScreenTarget && observeRequest)
}

function toolNameFrom(tool: Tool) {
  const candidate = tool as Tool & {
    name?: string
    function?: {
      name?: string
    }
  }

  return candidate.function?.name ?? candidate.name
}

function dedupeTools(tools: Tool[]) {
  const byName = new Map<string, Tool>()
  const anonymous: Tool[] = []

  for (const tool of tools) {
    const name = toolNameFrom(tool)
    if (!name) {
      anonymous.push(tool)
      continue
    }
    byName.set(name, tool)
  }

  return [...anonymous, ...byName.values()]
}

export const useChatSyncStore = defineStore('stage-tamagotchi:chat-sync', () => {
  const instanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const mode = ref<ChatSyncMode>('inactive')
  const authorityId = ref<string | null>(null)

  const chatSession = useChatSessionStore()
  const chatStream = useChatStreamStore()
  const chatOrchestrator = useChatOrchestratorStore()
  const { cleanupMessages } = useChatMaintenanceStore()
  const lumiEyesStore = useLumiEyesStore()
  const cardStore = useAiriCardStore()
  const providersStore = useProvidersStore()
  const consciousnessStore = useConsciousnessStore()
  const llmToolsStore = useLlmToolsStore()
  const { activeProvider, activeModel } = storeToRefs(consciousnessStore)
  const { activeSessionId, sessionMessages, sessionMetas } = storeToRefs(chatSession)
  const { streamingMessage } = storeToRefs(chatStream)
  const { sending } = storeToRefs(chatOrchestrator)

  const pendingRequests = new Map<string, PendingRequest>()
  const stopSyncWatchers: Array<() => void> = []
  const stopCaptionHookWatchers: Array<() => void> = []
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let channel: BroadcastChannel | null = null
  let captionChannel: BroadcastChannel | null = null
  let captionStreamPostedText = false
  let captionStreamText = ''

  function isLumiChatActive() {
    const card = cardStore.activeCard
    const fields = [
      cardStore.activeCardId,
      card?.name,
      card?.description,
      card?.systemPrompt,
      card?.scenario,
    ].filter(Boolean).join('\n')

    return cardStore.activeCardId === LUMI_AIRI_CARD_ID
      || /\bLumi\b/i.test(fields)
      || fields.includes('PersonaOS')
  }

  function post(message: ChatSyncMessage) {
    channel?.postMessage(message)
  }

  function getCaptionChannel() {
    if (captionChannel)
      return captionChannel
    if (typeof BroadcastChannel === 'undefined')
      return null
    captionChannel = new BroadcastChannel('airi-caption-overlay')
    return captionChannel
  }

  function buildSessionSnapshot(): SessionSnapshotPayload {
    return chatSession.getSnapshot()
  }

  function buildStreamSnapshot(): StreamSnapshotPayload {
    return {
      sending: sending.value,
      streamingMessage: JSON.parse(JSON.stringify(streamingMessage.value)) as StreamingAssistantMessage,
    }
  }

  function broadcastAuthorityAnnouncement() {
    if (mode.value !== 'authority')
      return

    post({
      type: 'authority-announcement',
      authorityId: instanceId,
      sentAt: Date.now(),
    })
  }

  function broadcastSessionSnapshot() {
    if (mode.value !== 'authority')
      return

    post({
      type: 'session-snapshot',
      authorityId: instanceId,
      snapshot: buildSessionSnapshot(),
    })
  }

  function broadcastStreamSnapshot() {
    if (mode.value !== 'authority')
      return

    post({
      type: 'stream-snapshot',
      authorityId: instanceId,
      snapshot: buildStreamSnapshot(),
    })
  }

  function stopWatchers() {
    while (stopSyncWatchers.length > 0) {
      const stop = stopSyncWatchers.pop()
      stop?.()
    }
  }

  function clearHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }
  }

  function registerAuthorityWatchers() {
    stopSyncWatchers.push(
      watch([activeSessionId, sessionMessages, sessionMetas], () => {
        broadcastSessionSnapshot()
      }, { deep: true, immediate: true }),
      watch([sending, streamingMessage], () => {
        broadcastStreamSnapshot()
      }, { deep: true, immediate: true }),
    )

    broadcastAuthorityAnnouncement()
    clearHeartbeat()
    heartbeatTimer = setInterval(() => {
      broadcastAuthorityAnnouncement()
    }, AUTHORITY_HEARTBEAT_INTERVAL_MS)
  }

  function applySessionSnapshot(snapshot: SessionSnapshotPayload) {
    const localActiveSessionId = activeSessionId.value
    const shouldPreserveLocalActiveSession = mode.value === 'follower'
      && !!localActiveSessionId
      && !!snapshot.sessionMessages[localActiveSessionId]

    chatSession.applyRemoteSnapshot({
      ...snapshot,
      activeSessionId: shouldPreserveLocalActiveSession
        ? localActiveSessionId
        : snapshot.activeSessionId,
    })
  }

  function applyStreamSnapshot(snapshot: StreamSnapshotPayload) {
    chatOrchestrator.sending = snapshot.sending
    chatStream.streamingMessage = snapshot.streamingMessage
  }

  function resolveTools(toolset?: ToolsetId) {
    const toolsetRegistry: Record<string, () => Promise<Tool[]>> = {
      widgets: async () => {
        const [w, we] = await Promise.all([widgetsTools(), weatherTools()])
        return [...w, ...we]
      },
      artistry: async () => {
        const [ai, wi, we] = await Promise.all([
          imageJournalTools(),
          widgetsTools(),
          weatherTools(),
        ])
        return [...ai, ...wi, ...we]
      },
    }

    return async () => {
      await llmToolsStore.awaitPendingRegistrations()
      const runtimeTools = [...llmToolsStore.activeTools]
      const requestedTools = toolset && toolsetRegistry[toolset]
        ? await toolsetRegistry[toolset]()
        : []

      return dedupeTools([...runtimeTools, ...requestedTools])
    }
  }

  function stopCaptionHooks() {
    while (stopCaptionHookWatchers.length > 0) {
      const stop = stopCaptionHookWatchers.pop()
      stop?.()
    }
  }

  function registerCaptionHooks() {
    if (stopCaptionHookWatchers.length > 0)
      return

    const maybeChatOrchestrator = chatOrchestrator as {
      onBeforeMessageComposed?: (cb: () => Promise<void> | void) => () => void
      onTokenLiteral?: (cb: (literal: string) => Promise<void> | void) => () => void
      onAssistantResponseEnd?: (cb: (message: string) => Promise<void> | void) => () => void
    }

    if (!maybeChatOrchestrator.onBeforeMessageComposed || !maybeChatOrchestrator.onTokenLiteral || !maybeChatOrchestrator.onAssistantResponseEnd)
      return

    stopCaptionHookWatchers.push(
      maybeChatOrchestrator.onBeforeMessageComposed(() => {
        captionStreamPostedText = false
        captionStreamText = ''
        getCaptionChannel()?.postMessage({ type: 'caption-assistant', text: '' })
      }),
      maybeChatOrchestrator.onTokenLiteral((literal) => {
        const text = literal.trim()
        if (!text)
          return

        captionStreamPostedText = true
        captionStreamText += literal
        getCaptionChannel()?.postMessage({ type: 'caption-assistant', text: captionStreamText, replace: true })
      }),
      maybeChatOrchestrator.onAssistantResponseEnd((message) => {
        if (captionStreamPostedText)
          return
        const text = message.trim()
        if (!text || isLumiMemoryDebugText(text))
          return
        getCaptionChannel()?.postMessage({ type: 'caption-assistant', text })
      }),
    )
  }

  function postAssistantCaptionFromNewMessages(sessionId: string, previousMessageCount: number) {
    if (captionStreamPostedText)
      return

    const assistantMessages = chatSession
      .getSessionMessages(sessionId)
      .slice(previousMessageCount)
      .filter(message => message.role === 'assistant')

    if (!assistantMessages.length)
      return

    for (const assistantMessage of assistantMessages) {
      const text = extractPlainMessageText(assistantMessage).trim()
      if (!text || isLumiMemoryDebugText(text))
        continue

      getCaptionChannel()?.postMessage({ type: 'caption-assistant', text })
    }
  }

  async function executeIngest(payload: IngestCommandPayload) {
    const providerId = activeProvider.value
    const modelId = activeModel.value
    if (!providerId || !modelId) {
      throw new Error('No active chat provider or model configured')
    }

    const chatProvider = await providersStore.getProviderInstance<ChatProvider>(providerId)
    if (!chatProvider) {
      throw new Error(`Failed to resolve chat provider "${providerId}"`)
    }
    const providerConfig = providersStore.getProviderConfig(providerId)

    const sub2ApiMultimodalEnabled = providerId === 'sub2api'
      && providerConfig?.multimodalEnabled === true
    const useTextOnlyImageBridge = !!payload.attachments?.length
      && !sub2ApiMultimodalEnabled
    const visionResult = useTextOnlyImageBridge
      // Lumi's original flow keeps chat text-only: Qwen Vision analyzes images,
      // then the selected consciousness/chat model reads the analysis as hidden turn context.
      ? await lumiEyesStore.analyzeAttachmentsForChat({
          attachments: payload.attachments,
          userMessage: payload.text,
          sessionId: payload.sessionId || activeSessionId.value,
        })
      : undefined
    if (useTextOnlyImageBridge && !visionResult?.results.length) {
      const errorDetails = visionResult?.errors.length
        ? visionResult.errors.join(' | ')
        : 'No image understanding result was produced.'
      throw new Error(`Lumi Eyes failed to understand the attached image(s): ${errorDetails}`)
    }

    const targetSessionId = payload.sessionId || activeSessionId.value
    appendSystemNotices(targetSessionId, payload.systemNotices)
    const messageCountBeforeSend = chatSession.getSessionMessages(targetSessionId).length
    const isLumiChat = isLumiChatActive()
    const isLumiVisibleChat = isLumiChat && !payload.hiddenUserMessage
    const screenObservationToolHint = isLumiVisibleChat && shouldBridgeLumiScreenObservation(payload.text)
      ? 'The user appears to be asking about visible desktop content. Use lumi_list_observation_sources first, choose the relevant source yourself, and then call lumi_observe_screen with that exact sourceId.'
      : ''
    const lumiReturnContext = consumeLumiProactiveReturnContext(
      isLumiVisibleChat,
    )
    const providerUserContext = [
      visionResult?.contextText,
      screenObservationToolHint,
      isLumiVisibleChat ? buildLumiResponseAutonomyContext() : '',
      lumiReturnContext,
    ].filter(Boolean).join('\n\n')
    const suppressAssistantTexts = isLumiVisibleChat
      ? [...new Set([...(payload.suppressAssistantTexts ?? []), LUMI_REFUSAL_REPLY_MARKER])]
      : payload.suppressAssistantTexts

    await chatOrchestrator.ingest(payload.text, {
      model: modelId,
      chatProvider,
      providerConfig,
      attachments: payload.attachments,
      providerUserContext,
      agentUserText: visionResult?.contextText
        ? [payload.text.trim(), visionResult.contextText].filter(Boolean).join('\n\n')
        : undefined,
      sendAttachmentsToProvider: !useTextOnlyImageBridge,
      providerHistoryTransform: isLumiChat
        ? isolateCompletedComputerUseHistory
        : undefined,
      providerMessageTransform: isLumiChat
        ? sanitizeLumiProviderHistoryMessages
        : undefined,
      assistantSpeechTransform: isLumiChat
        ? sanitizeLumiSpeechText
        : undefined,
      assistantMessageTransform: isLumiChat
        ? splitLumiAssistantMessage
        : undefined,
      toolResultTextTransform: isLumiChat
        ? formatComputerUseToolProgress
        : undefined,
      input: payload.input,
      tools: resolveTools(payload.toolset),
      hiddenUserMessage: payload.hiddenUserMessage,
      suppressAssistantTexts,
      onAssistantSuppressed: isLumiVisibleChat
        ? (text) => {
            if (!isLumiRefusalReply(text))
              return

            streamingMessage.value = {
              role: 'assistant',
              content: '',
              slices: [],
              tool_results: [],
            }
            captionStreamPostedText = false
            captionStreamText = ''
            getCaptionChannel()?.postMessage({ type: 'caption-assistant', text: '', replace: true })
            appendSystemNotices(targetSessionId, [[
              'title: Lumi \u62D2\u7EDD\u56DE\u590D',
              'status: refused',
              'message: Lumi \u6839\u636E\u5F53\u524D\u5173\u7CFB\u72B6\u6001\u3001\u8FD0\u884C\u65F6\u72B6\u6001\u548C\u8FD9\u6761\u6D88\u606F\u672C\u8EAB\uFF0C\u9009\u62E9\u4FDD\u6301\u6C89\u9ED8\u3002',
            ].join('\n')])
          }
        : undefined,
    }, payload.sessionId)

    postAssistantCaptionFromNewMessages(targetSessionId, messageCountBeforeSend)
  }

  function appendSystemNotices(sessionId: string, notices: string[] | undefined) {
    const cleanNotices = notices
      ?.map(notice => notice.trim())
      .filter(Boolean)
    if (!cleanNotices?.length)
      return

    const nextMessages = [
      ...chatSession.getSessionMessages(sessionId),
      ...cleanNotices.map((notice) => {
        const content = notice.startsWith('[system_notice]')
          ? notice
          : `[system_notice]\n${notice}`
        return {
          id: `system-notice-${createRequestId()}`,
          role: 'assistant' as const,
          content,
          slices: [{ type: 'text' as const, text: content }],
          tool_results: [],
          createdAt: Date.now(),
        } satisfies ChatHistoryItem
      }),
    ]
    chatSession.setSessionMessages(sessionId, nextMessages)
  }

  async function executeRetry(payload: RetryCommandPayload) {
    const sessionId = payload.sessionId || chatSession.activeSessionId
    const currentMessages = chatSession.getSessionMessages(sessionId)
    const sourceIndex = resolveRetrySourceIndex(currentMessages, payload.index)
    if (sourceIndex < 0)
      throw new Error('Retry target has no retriable source message')

    const text = getRetryText(currentMessages[sourceIndex])
    if (!text)
      throw new Error('Retry target has no retriable user message')

    const nextMessages = currentMessages.slice(0, sourceIndex)
    chatSession.setSessionMessages(sessionId, nextMessages)

    await executeIngest({
      text,
      sessionId,
      toolset: 'widgets',
    })
  }

  function executeDeleteMessage(payload: { sessionId?: string, messageId?: string, index?: number }) {
    const sessionId = payload.sessionId || chatSession.activeSessionId
    const nextMessages = chatSession.getSessionMessages(sessionId).filter((message, index) => {
      if (payload.messageId)
        return message.id !== payload.messageId
      if (payload.index !== undefined)
        return index !== payload.index
      return true
    })

    chatSession.setSessionMessages(sessionId, nextMessages)
  }

  function appendIngestErrorMessage(payload: IngestCommandPayload, message: string) {
    const sessionId = payload.sessionId || chatSession.activeSessionId
    const nextMessages = [
      ...chatSession.getSessionMessages(sessionId),
      {
        role: 'error',
        content: message,
      } satisfies ChatHistoryItem,
    ]
    chatSession.setSessionMessages(sessionId, nextMessages)
  }

  async function handleCommand(message: Extract<ChatSyncMessage, { type: 'command' }>) {
    if (mode.value !== 'authority')
      return

    const respond = (ok: boolean, error?: string) => {
      post({
        type: 'response',
        requestId: message.requestId,
        authorityId: instanceId,
        ok,
        error,
      })
    }

    try {
      switch (message.command) {
        case 'ingest':
          await executeIngest(message.payload)
          break
        case 'retry':
          await executeRetry(message.payload)
          break
        case 'cleanup':
          cleanupMessages(message.payload.sessionId)
          break
        case 'delete-message':
          executeDeleteMessage(message.payload)
          break
      }

      respond(true)
    }
    catch (error) {
      const errorMessage = errorMessageFrom(error) ?? 'Unknown chat sync command failure'

      logChatSyncError('command failed', error, {
        mode: mode.value,
        authorityId: authorityId.value,
        requestId: message.requestId,
        senderId: message.senderId,
        command: message.command,
        payload: previewChatSyncPayload(message.payload),
      })

      if (message.command === 'ingest')
        appendIngestErrorMessage(message.payload, errorMessage)

      respond(false, errorMessage)
    }
  }

  function handleResponse(message: Extract<ChatSyncMessage, { type: 'response' }>) {
    const pending = pendingRequests.get(message.requestId)
    if (!pending)
      return

    clearTimeout(pending.timeout)
    pendingRequests.delete(message.requestId)

    if (message.ok) {
      pending.resolve()
      return
    }

    pending.reject(new Error(message.error ?? 'Remote chat command failed'))
  }

  function handleMessage(event: MessageEvent<ChatSyncMessage>) {
    const message = event.data
    if (!message)
      return

    switch (message.type) {
      case 'authority-announcement':
        authorityId.value = message.authorityId
        if (mode.value === 'follower')
          post({ type: 'request-snapshot', requestId: createRequestId(), senderId: instanceId })
        return
      case 'request-snapshot':
        if (mode.value === 'authority')
          broadcastSessionSnapshot()
        return
      case 'session-snapshot':
        if (mode.value !== 'follower')
          return
        authorityId.value = message.authorityId
        applySessionSnapshot(message.snapshot)
        return
      case 'stream-snapshot':
        if (mode.value !== 'follower')
          return
        authorityId.value = message.authorityId
        applyStreamSnapshot(message.snapshot)
        return
      case 'command':
        void handleCommand(message)
        return
      case 'response':
        handleResponse(message)
    }
  }

  function attachChannel() {
    if (channel)
      return

    channel = new BroadcastChannel(CHAT_SYNC_CHANNEL_NAME)
    channel.addEventListener('message', handleMessage as EventListener)
  }

  function detachChannel() {
    if (!channel)
      return

    channel.removeEventListener('message', handleMessage as EventListener)
    channel.close()
    channel = null
  }

  function resetPendingRequests() {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Chat sync channel disposed'))
    }
    pendingRequests.clear()
  }

  function initialize(nextMode: Exclude<ChatSyncMode, 'inactive'>) {
    if (mode.value === nextMode && channel)
      return

    dispose()
    attachChannel()
    registerCaptionHooks()
    mode.value = nextMode
    authorityId.value = nextMode === 'authority' ? instanceId : authorityId.value

    if (nextMode === 'authority') {
      registerAuthorityWatchers()
      broadcastSessionSnapshot()
      broadcastStreamSnapshot()
      return
    }

    post({ type: 'request-snapshot', requestId: createRequestId(), senderId: instanceId })
  }

  function waitForAuthority(timeoutMs: number) {
    if (authorityId.value)
      return Promise.resolve(true)
    if (timeoutMs <= 0)
      return Promise.resolve(false)

    return new Promise<boolean>((resolve) => {
      const startedAt = Date.now()
      const stop = watch(authorityId, (nextAuthorityId) => {
        if (!nextAuthorityId)
          return
        cleanup()
        resolve(true)
      })
      const timer = setInterval(() => {
        if (authorityId.value) {
          cleanup()
          resolve(true)
          return
        }
        if (Date.now() - startedAt >= timeoutMs) {
          cleanup()
          resolve(false)
        }
      }, 100)

      function cleanup() {
        clearInterval(timer)
        stop()
      }
    })
  }

  function dispatchCommand(message: Extract<ChatSyncMessage, { type: 'command' }>, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (mode.value === 'inactive')
      initialize('follower')

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(message.requestId)
        const error = new Error('Timed out waiting for chat authority response')
        logChatSyncError('command timed out waiting for authority response', error, {
          mode: mode.value,
          authorityId: authorityId.value,
          requestId: message.requestId,
          senderId: message.senderId,
          command: message.command,
          payload: previewChatSyncPayload(message.payload),
        })
        reject(error)
      }, timeoutMs)

      pendingRequests.set(message.requestId, { resolve, reject, timeout })
      post(message)
    })
  }

  async function requestIngest(payload: IngestCommandPayload) {
    if (mode.value === 'authority') {
      await executeIngest(payload)
      return
    }

    if (payload.fallbackToLocalAuthority) {
      if (mode.value === 'inactive')
        initialize('follower')

      const foundAuthority = await waitForAuthority(payload.authorityWaitMs ?? 1200)
      if (!foundAuthority) {
        initialize('authority')
        await executeIngest(payload)
        return
      }
    }

    return await dispatchCommand({
      type: 'command',
      requestId: createRequestId(),
      senderId: instanceId,
      command: 'ingest',
      payload,
    }, payload.requestTimeoutMs)
  }

  async function requestRetry(payload: RetryCommandPayload) {
    if (mode.value === 'authority') {
      await executeRetry(payload)
      return
    }

    return await dispatchCommand({
      type: 'command',
      requestId: createRequestId(),
      senderId: instanceId,
      command: 'retry',
      payload,
    })
  }

  async function requestCleanup(sessionId?: string) {
    if (mode.value === 'authority') {
      cleanupMessages(sessionId)
      return
    }

    return await dispatchCommand({
      type: 'command',
      requestId: createRequestId(),
      senderId: instanceId,
      command: 'cleanup',
      payload: { sessionId },
    })
  }

  async function requestDeleteMessage(payload: { sessionId?: string, messageId?: string, index?: number }) {
    if (mode.value === 'authority') {
      executeDeleteMessage(payload)
      return
    }

    return await dispatchCommand({
      type: 'command',
      requestId: createRequestId(),
      senderId: instanceId,
      command: 'delete-message',
      payload,
    })
  }

  function dispose() {
    stopWatchers()
    stopCaptionHooks()
    clearHeartbeat()
    resetPendingRequests()
    detachChannel()
    captionChannel?.close()
    captionChannel = null
    mode.value = 'inactive'
    authorityId.value = null
  }

  return {
    authorityId,
    mode,
    initialize,
    dispose,
    requestIngest,
    requestRetry,
    requestCleanup,
    requestDeleteMessage,
  }
})
