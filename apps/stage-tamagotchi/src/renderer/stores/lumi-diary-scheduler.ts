import type { ChatHistoryItem } from '@proj-airi/stage-ui/types/chat'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { extractMessageText } from '@proj-airi/stage-ui/libs/chat-sync'
import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { useChatSyncStore } from './chat-sync'

const CHECK_INTERVAL_MS = 60 * 1000
const DEFAULT_DAILY_TIME = '23:00'
const SILENCE_MARKERS = ['<silence>', '[silence]', 'silence']

function localDateKey(date = new Date()) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDailyTime(value: string) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match)
    return { hour: 23, minute: 0 }

  const hour = Math.min(23, Math.max(0, Number(match[1])))
  const minute = Math.min(59, Math.max(0, Number(match[2])))
  return { hour, minute }
}

function targetTimeFor(date: Date, value: string) {
  const { hour, minute } = parseDailyTime(value)
  const target = new Date(date)
  target.setHours(hour, minute, 0, 0)
  return target
}

function shouldRunToday(now: Date, dailyTime: string, lastRunDate: string) {
  return now.getTime() >= targetTimeFor(now, dailyTime).getTime()
    && lastRunDate !== localDateKey(now)
}

function formatMessageForDiary(message: ChatHistoryItem) {
  const text = extractMessageText(message)
    .replace(/\s+/g, ' ')
    .trim()
  if (!text || /^\[(?:memory_search|memory_write|system_notice)\]/.test(text))
    return ''

  const time = message.createdAt ? new Date(message.createdAt).toLocaleString() : 'unknown time'
  return `[${time}] ${message.role}: ${text.slice(0, 800)}`
}

function collectTodayMessages(messages: ChatHistoryItem[], now = new Date()) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  return messages
    .filter(message => !message.createdAt || message.createdAt >= start.getTime())
    .map(formatMessageForDiary)
    .filter(Boolean)
    .slice(-80)
}

function buildDiaryIngestText(input: {
  date: string
  localTime: string
  trigger: 'scheduled' | 'manual' | 'autonomous'
  todayMessages: string[]
}) {
  return [
    '[Lumi scheduled diary request]',
    'This is not a user message. It is Lumi\'s diary scheduler asking Lumi to write today\'s diary.',
    'First call `lumi_diary_read_day` for the date below if it is available, so you know whether today already has a diary.',
    'Then use `lumi_diary_write_entry` if it is available.',
    'If today already has a diary, add a thoughtful update or intentional revision based on the existing entry instead of writing as if this is the first entry of the day.',
    'Use mode `append` for ordinary same-day updates. Use mode `replace` only if you intentionally rewrite the whole day entry while preserving important earlier details.',
    'Write Markdown diary prose for today in Lumi\'s private voice.',
    'Use the current conversation context, memory/profile context, today impressions, and the chat excerpts below.',
    'Keep factual events separate from feelings. Do not invent events, preferences, or shared history.',
    'Do not expose chain-of-thought. The diary content should be polished prose, not analysis.',
    'After the diary tool call succeeds, reply exactly <silence> unless there is an important reason to tell the user.',
    '',
    `date: ${input.date}`,
    `local_time: ${input.localTime}`,
    `trigger: ${input.trigger}`,
    '',
    'Today chat excerpts:',
    input.todayMessages.length ? input.todayMessages.join('\n') : '- No substantial chat excerpts were available today.',
    '[/Lumi scheduled diary request]',
  ].join('\n')
}

function createSystemNotice(input: { date: string, trigger: string, status: string, messageCount: number }) {
  return [
    '[system_notice]',
    'title: Lumi 日记',
    `status: ${input.status}`,
    `date: ${input.date}`,
    `trigger: ${input.trigger}`,
    `today_messages: ${input.messageCount}`,
    '',
    'Lumi 正在整理今天的聊天、印象和记忆，尝试写入自己的日记。',
  ].join('\n')
}

export const useLumiDiarySchedulerStore = defineStore('lumi-diary-scheduler', () => {
  const enabled = useLocalStorageManualReset('settings/plugins/lumi-diary/auto-write-enabled', false)
  const dailyTime = useLocalStorageManualReset('settings/plugins/lumi-diary/auto-write-time', DEFAULT_DAILY_TIME)
  const lastRunDate = useLocalStorageManualReset('settings/plugins/lumi-diary/last-run-date', '')
  const lastRunAt = useLocalStorageManualReset<number | null>('settings/plugins/lumi-diary/last-run-at', null)
  const lastStatus = ref('')
  const running = ref(false)
  const writing = ref(false)

  let timer: ReturnType<typeof setTimeout> | null = null

  const nextTargetAt = computed(() => {
    const now = new Date()
    const todayTarget = targetTimeFor(now, dailyTime.value)
    if (now.getTime() < todayTarget.getTime() || lastRunDate.value !== localDateKey(now))
      return todayTarget.getTime()
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    return targetTimeFor(tomorrow, dailyTime.value).getTime()
  })

  function clearTimer() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function scheduleNextCheck() {
    clearTimer()
    if (!running.value || !enabled.value)
      return

    timer = setTimeout(() => {
      void checkAndRun().finally(scheduleNextCheck)
    }, CHECK_INTERVAL_MS)
  }

  async function ensureActiveSession() {
    const chatSession = useChatSessionStore()
    if (!chatSession.isReady)
      await chatSession.initialize()
    const sessionId = chatSession.activeSessionId
    if (!sessionId)
      throw new Error('No active chat session is available for Lumi diary.')
    await chatSession.loadSession(sessionId)
    chatSession.ensureSession(sessionId)
    return sessionId
  }

  async function writeToday(trigger: 'scheduled' | 'manual' | 'autonomous' = 'manual') {
    if (writing.value)
      return

    writing.value = true
    try {
      const now = new Date()
      const date = localDateKey(now)
      const chatSession = useChatSessionStore()
      const chatSyncStore = useChatSyncStore()
      const sessionId = await ensureActiveSession()
      const todayMessages = collectTodayMessages(chatSession.getSessionMessages(sessionId), now)
      await chatSyncStore.requestIngest({
        text: buildDiaryIngestText({
          date,
          localTime: now.toLocaleString(),
          trigger,
          todayMessages,
        }),
        sessionId,
        hiddenUserMessage: true,
        suppressAssistantTexts: SILENCE_MARKERS,
        fallbackToLocalAuthority: true,
        authorityWaitMs: 1200,
        requestTimeoutMs: 180000,
        systemNotices: [createSystemNotice({
          date,
          trigger,
          status: 'writing',
          messageCount: todayMessages.length,
        })],
      })

      lastRunDate.value = date
      lastRunAt.value = Date.now()
      lastStatus.value = `written:${date}:${trigger}`
    }
    catch (error) {
      lastStatus.value = error instanceof Error ? error.message : String(error)
      throw error
    }
    finally {
      writing.value = false
    }
  }

  async function checkAndRun() {
    if (!enabled.value || writing.value)
      return
    const now = new Date()
    if (!shouldRunToday(now, dailyTime.value, lastRunDate.value))
      return
    await writeToday('scheduled')
  }

  function start() {
    if (running.value)
      return
    running.value = true
    void checkAndRun().finally(scheduleNextCheck)
  }

  function stop() {
    running.value = false
    clearTimer()
  }

  function resetState() {
    stop()
    enabled.reset()
    dailyTime.reset()
    lastRunDate.reset()
    lastRunAt.reset()
    lastStatus.value = ''
  }

  return {
    enabled,
    dailyTime,
    lastRunDate,
    lastRunAt,
    lastStatus,
    nextTargetAt,
    running,
    writing,
    checkAndRun,
    resetState,
    start,
    stop,
    writeToday,
  }
})
