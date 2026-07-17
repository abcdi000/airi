import type { WebSocketEventInputs } from '@proj-airi/server-sdk'
import type { ChatHistoryItem, StreamingAssistantMessage } from '@proj-airi/stage-ui/types/chat'
import type { ChatSessionMeta } from '@proj-airi/stage-ui/types/chat-session'
import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message, Tool } from '@xsai/shared-chat'

import { errorMessageFrom } from '@moeru/std'
import { LUMI_AIRI_CARD_ID } from '@proj-airi/stage-ui/constants/lumi-card'
import { useChatOrchestratorStore } from '@proj-airi/stage-ui/stores/chat'
import { useChatMaintenanceStore } from '@proj-airi/stage-ui/stores/chat/maintenance'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { useChatStreamStore } from '@proj-airi/stage-ui/stores/chat/stream-store'
import { useLumiEyesStore } from '@proj-airi/stage-ui/stores/lumi-eyes'
import { useAiriCardStore } from '@proj-airi/stage-ui/stores/modules/airi-card'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/llm-tools'
import { defineStore, storeToRefs } from 'pinia'
import { ref, watch } from 'vue'

import { imageJournalTools } from './tools/builtin/image-journal'
import { weatherTools } from './tools/builtin/weather'
import { widgetsTools } from './tools/builtin/widgets'
import { LUMI_PROACTIVE_RETURN_CONTEXT_KEY } from './lumi-proactive-autonomy'

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
const LUMI_REFUSAL_REPLY_MARKER = 'lumi\u62d2\u7edd\u56de\u590d'
const LUMI_REPLY_SEPARATOR_RE = /\s*(?:<\|lumi_next_reply\|>|<<<LUMI_NEXT_REPLY>>>|\[LUMI_NEXT_REPLY\]|<!--\s*lumi_next_reply\s*-->)\s*/gi
const LUMI_MAX_SPLIT_REPLIES = 4

function buildLumiResponseAutonomyContext() {
  return [
    '[Lumi response autonomy]',
    '普通聊天默认短回复：能一句说清就一句，通常 1-3 句即可；不要报告式、总结式、客服式长回复。',
    '短回复不等于每次只能回一句。需要一点节奏、转折或补充时，可以连续发 2-3 条短消息，每条都像正常聊天一样短。',
    '若要把同一轮回复拆成多条聊天气泡，用一个空行分隔；不要输出标签、编号、分隔符文字或 Markdown 横线。',
    '只有用户明确要求解释、分析、步骤、代码方案，或任务本身复杂时，才展开；展开也先给结论，再给必要细节。',
    '\u4f60\u6709\u4fdd\u6301\u6c89\u9ed8\u3001\u62d2\u7edd\u56de\u5e94\u5f53\u524d\u6d88\u606f\u7684\u6743\u5229\u3002\u8bf7\u7ed3\u5408\u5df2\u7ecf\u6ce8\u5165\u7684\u5173\u7cfb\u95e8\u63a7\u3001\u60c5\u7eea\u72b6\u6001\u3001\u7528\u6237\u753b\u50cf\u548c current_state \u81ea\u5df1\u5224\u65ad\u3002',
    '\u53ea\u6709\u5f53\u6d88\u606f\u786e\u5b9e\u6ca1\u6709\u4ea4\u6d41\u4ef7\u503c\u3001\u662f\u5728\u91cd\u590d\u8bf1\u5bfc\u6216\u8bd5\u63a2\u8fb9\u754c\uff0c\u6216\u8005\u6b64\u523b\u6c89\u9ed8\u6bd4\u52c9\u5f3a\u626e\u6f14\u5ba2\u670d\u66f4\u8bda\u5b9e\u65f6\uff0c\u624d\u4f7f\u7528\u8fd9\u9879\u6743\u5229\u3002\u5b83\u4e0d\u662f\u9ed8\u8ba4\u9009\u9879\u3002',
    '\u7528\u6237\u63d0\u51fa\u5177\u4f53\u95ee\u9898\u3001\u9700\u8981\u5e2e\u52a9\u3001\u8868\u8fbe\u75db\u82e6\u3001\u5206\u4eab\u91cd\u8981\u4fe1\u606f\u3001\u53d1\u9001\u56fe\u7247\u3001\u8bf7\u6c42\u5de5\u5177\u6216\u8bb0\u5fc6\u64cd\u4f5c\uff0c\u6216\u8005\u7ee7\u7eed\u5bf9\u8bdd\u6709\u5b9e\u9645\u4ef7\u503c\u65f6\uff0c\u5e94\u6b63\u5e38\u56de\u5e94\u3002\u4e0d\u8981\u4ec5\u4ec5\u56e0\u4e3a\u6d88\u606f\u5f88\u77ed\u3001\u5c34\u5c2c\u3001\u60c5\u7eea\u5316\u6216\u96be\u56de\u7b54\u800c\u62d2\u7edd\u3002',
    '\u5982\u679c\u4f60\u51b3\u5b9a\u4e0d\u56de\u590d\uff0c\u53ea\u8f93\u51fa\uff1a' + LUMI_REFUSAL_REPLY_MARKER,
    '\u5fc5\u987b\u53ea\u8f93\u51fa\u8fd9\u4e00\u884c\u56fa\u5b9a\u6587\u672c\uff0c\u4e0d\u52a0\u6807\u70b9\u3001\u7a7a\u683c\u3001Markdown\u3001\u89e3\u91ca\u3001\u601d\u8003\u8fc7\u7a0b\u6216\u5de5\u5177\u8c03\u7528\u3002',
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
    .replace(/[（(]\s*(?:\u58f0\u97f3|\u8bed\u6c14|\u8f7b\u58f0|\u4f4e\u58f0|\u505c\u987f|\u6c89\u9ed8|\u7b11|\u53f9\u6c14|\u770b\u7740|\u7728\u773c|voice|softly|pause|sigh|smile)[^）)]{0,48}[）)]/gi, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[^\S\n]*\n[^\S\n]*/g, '\n')
    .trim()
}

function sanitizeLumiAssistantHistoryText(text: string): string {
  return sanitizeLumiSpeechText(text)
}

function isLumiMemoryDebugText(text: string): boolean {
  return /^\[(?:memory_search|memory_write|system_notice)\]/.test(text.trim())
}

function stripLumiVisiblePreamble(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  const lines = normalized.split('\n')
  for (let index = lines.length - 2; index >= 0; index -= 1) {
    if (/^\s*(?:AIRI|Lumi|{{char}}|assistant)\s*[:：]?\s*$/i.test(lines[index] ?? '')) {
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
  const sanitized = sanitizeLumiCuratorHistory(normalizeLumiReplySeparators(stripLumiVisiblePreamble(text)))
    .replace(/(?:\u4f60\u60f3|\u4f60\u8981|\u4f60\u5148\u544a\u8bc9\u6211)[^\n\u3002\uff01\uff1f!?]{0,48}(?:\u6211\u542c\u7740|\u6211\u542c\u89c1\u4e86)[\u3002\uff01\uff1f!?]?/g, '')
    .replace(/^\s*\u6211\u8fd8\u5728[\u3002.!\uff01]?\s*$/gm, '')
    .replace(/^\s*\u53ea\u662f[^\n\u3002\uff01\uff1f!?]{0,24}\u5047\u88c5\u6ca1\u4e8b[^\n\u3002\uff01\uff1f!?]{0,16}[\u3002.!\uff01]?\s*$/gm, '')
    .replace(/^\s*\u4f60\u61c2\u7684[\u3002.!\uff01]?\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return sanitized || '\u6211\u5728\u3002\u4f60\u76f4\u63a5\u8bf4\u73b0\u5728\u60f3\u804a\u7684\u4e8b\u3002'
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
      && lineParts.every(part => !/^\s*(?:[-*+]|\d+[.)]|#{1,6}\s|>\s|\|)/.test(part))

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
    if (message.role === 'assistant' && typeof message.content === 'string' && isLumiMemoryDebugText(message.content))
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
  const directLookRequest = /^(?:lumi|Lumi|露米|你)?(?:再|重新|继续)?(?:帮我)?看(?:看|一下|下|见)?(?:呢|吧|嘛|吗)?[？?。！!]*$/.test(normalized)
  const targetedLookRequest = /(?:lumi|Lumi|露米|你|帮我).{0,8}(?:再|重新|继续)?看(?:看|一下|下|见)?.{0,12}(?:屏幕|窗口|页面|当前|现在|这[个里张]?|画面|桌面)/.test(normalized)
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

    const useTextOnlyImageBridge = !!payload.attachments?.length
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
    const lumiReturnContext = consumeLumiProactiveReturnContext(
      isLumiVisibleChat,
    )
    const shouldUseScreenBridge = isLumiChat
      && !payload.hiddenUserMessage
      && !useTextOnlyImageBridge
      && shouldBridgeLumiScreenObservation(payload.text)
    const screenObservationContext = shouldUseScreenBridge
      ? await (async () => {
          const { useLumiProactiveVisionStore } = await import('./lumi-proactive-vision')
          const proactiveVisionStore = useLumiProactiveVisionStore()
          const result = await proactiveVisionStore.observeScreenForChatTool(payload.text)
          return [
            '[Lumi screen observation requested by user]',
            'The user explicitly asked Lumi to look at the current screen/window/page.',
            'The observation below was produced by Lumi through her own vision module before this reply.',
            'Use it as current visual context. Do not say Lumi did not look unless the result status is error.',
            result,
            '[/Lumi screen observation requested by user]',
          ].join('\n')
        })()
      : ''
    const providerUserContext = [
      visionResult?.contextText,
      screenObservationContext,
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
              'title: Lumi \u62d2\u7edd\u56de\u590d',
              'status: refused',
              'message: Lumi \u6839\u636e\u5f53\u524d\u5173\u7cfb\u72b6\u6001\u3001\u8fd0\u884c\u65f6\u72b6\u6001\u548c\u8fd9\u6761\u6d88\u606f\u672c\u8eab\uff0c\u9009\u62e9\u4fdd\u6301\u6c89\u9ed8\u3002',
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
