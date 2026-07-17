import type { StreamingTtsDebugEvent, StreamingTtsDebugLane, StreamingTtsDebugPhase } from '../libs/speech/streaming-pipeline'

import { useLocalStorage } from '@vueuse/core'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export type TtsDebugSegmentStatus
  = | 'queued'
    | 'synthesizing'
    | 'delayed'
    | 'retrying'
    | 'ready'
    | 'queued_playback'
    | 'playing'
    | 'played'
    | 'fallback'
    | 'failed'
    | 'skipped'

export interface TtsDebugSegment {
  id: string
  sessionId: string
  index: number
  lane: StreamingTtsDebugLane
  text: string
  status: TtsDebugSegmentStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  audioDurationMs?: number
  retryCount: number
  delayMs?: number
  attempt?: number
  statusCode?: number
  detail?: string
  error?: string
}

export interface TtsDebugLogEntry extends StreamingTtsDebugEvent {
  id: string
}

const MAX_EVENTS = 180
const MAX_SESSIONS = 3
const CHANNEL_NAME = 'airi-tts-debug'
const INSTANCE_ID = `tts-debug-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

interface TtsDebugBroadcastMessage {
  type: 'tts-debug-event'
  originId: string
  event: StreamingTtsDebugEvent
}

export const useTtsDebugStore = defineStore('tts-debug', () => {
  const enabled = useLocalStorage('ui/chat/tts-debug/enabled', false)
  const panelOpen = useLocalStorage('ui/chat/tts-debug/panel-open', false)
  const currentSessionId = ref<string>('')
  const sessions = ref<string[]>([])
  const segments = ref<TtsDebugSegment[]>([])
  const events = ref<TtsDebugLogEntry[]>([])
  let channel: BroadcastChannel | undefined

  const currentSegments = computed(() => {
    if (!currentSessionId.value)
      return []
    return segments.value
      .filter(segment => segment.sessionId === currentSessionId.value)
      .sort((a, b) => a.index - b.index)
  })

  const currentEvents = computed(() => {
    if (!currentSessionId.value)
      return []
    return events.value.filter(event => event.sessionId === currentSessionId.value)
  })

  const activeCount = computed(() => currentSegments.value.filter(segment => !['played', 'failed', 'skipped'].includes(segment.status)).length)
  const hasActiveSession = computed(() => currentSegments.value.length > 0 || currentEvents.value.length > 0)

  function setEnabled(value: boolean) {
    enabled.value = value
    panelOpen.value = value
  }

  function togglePanel() {
    const next = !panelOpen.value
    panelOpen.value = next
    if (next)
      enabled.value = true
  }

  function clear() {
    segments.value = []
    events.value = []
    sessions.value = []
    currentSessionId.value = ''
  }

  ensureBroadcastChannel()

  function recordEvent(event: StreamingTtsDebugEvent) {
    broadcastEvent(event)
    acceptEvent(event)
  }

  function acceptEvent(event: StreamingTtsDebugEvent) {
    if (!enabled.value)
      return

    if (event.phase === 'session_started')
      beginSession(event.sessionId)
    else if (event.sessionId && !currentSessionId.value)
      beginSession(event.sessionId)

    appendEvent(event)
    applyEventToSegment(event)
  }

  function appendEvent(event: StreamingTtsDebugEvent) {
    events.value.push({
      ...event,
      id: `${event.sessionId}:${event.timestamp}:${events.value.length}`,
    })
    if (events.value.length > MAX_EVENTS)
      events.value.splice(0, events.value.length - MAX_EVENTS)
  }

  function broadcastEvent(event: StreamingTtsDebugEvent) {
    ensureBroadcastChannel()
    channel?.postMessage({
      type: 'tts-debug-event',
      originId: INSTANCE_ID,
      event,
    } satisfies TtsDebugBroadcastMessage)
  }

  function ensureBroadcastChannel() {
    if (channel || typeof BroadcastChannel === 'undefined')
      return
    channel = new BroadcastChannel(CHANNEL_NAME)
    channel.addEventListener('message', (message) => {
      const data = message.data as TtsDebugBroadcastMessage | undefined
      if (!data || data.type !== 'tts-debug-event' || data.originId === INSTANCE_ID)
        return
      acceptEvent(data.event)
    })
  }

  function beginSession(sessionId: string) {
    currentSessionId.value = sessionId
    sessions.value = [sessionId, ...sessions.value.filter(id => id !== sessionId)].slice(0, MAX_SESSIONS)
    const keep = new Set(sessions.value)
    segments.value = segments.value.filter(segment => keep.has(segment.sessionId))
    events.value = events.value.filter(event => keep.has(event.sessionId))
  }

  function markPlaybackStart(item: { intentId?: string, segmentId?: string, text?: string }) {
    const parsed = parsePlaybackItem(item)
    if (!parsed)
      return
    const match = findSegmentForPlayback(item)
    const now = Date.now()
    if (match) {
      updateSegment(match.sessionId, match.index, {
        status: 'playing',
        updatedAt: now,
        startedAt: match.startedAt ?? now,
        text: match.text || item.text || '',
      })
    }
    recordSyntheticPlaybackEvent('playback_started', parsed.sessionId, parsed.segmentIndex, 'playback', item.text)
  }

  function markPlaybackEnd(item: { intentId?: string, segmentId?: string, text?: string }) {
    const parsed = parsePlaybackItem(item)
    if (!parsed)
      return
    const match = findSegmentForPlayback(item)
    const now = Date.now()
    if (match) {
      updateSegment(match.sessionId, match.index, {
        status: 'played',
        updatedAt: now,
        finishedAt: now,
        text: match.text || item.text || '',
      })
    }
    recordSyntheticPlaybackEvent('playback_finished', parsed.sessionId, parsed.segmentIndex, 'playback', item.text)
  }

  function markPlaybackInterrupted(item: { intentId?: string, segmentId?: string, text?: string }, reason: string) {
    const parsed = parsePlaybackItem(item)
    if (!parsed)
      return
    const match = findSegmentForPlayback(item)
    if (match) {
      updateSegment(match.sessionId, match.index, {
        status: 'failed',
        updatedAt: Date.now(),
        error: reason,
      })
    }
    recordSyntheticPlaybackEvent('playback_interrupted', parsed.sessionId, parsed.segmentIndex, 'playback', item.text, reason)
  }

  function applyEventToSegment(event: StreamingTtsDebugEvent) {
    if (event.segmentIndex == null)
      return

    const status = statusForPhase(event.phase)
    const now = event.timestamp
    const segment = ensureSegment(event)
    const retryCount = event.phase === 'synth_retry' ? segment.retryCount + 1 : segment.retryCount

    updateSegment(event.sessionId, event.segmentIndex, {
      lane: event.lane && event.lane !== 'playback' ? event.lane : segment.lane,
      text: event.text ?? segment.text,
      status,
      updatedAt: now,
      startedAt: event.phase === 'synth_start' ? now : segment.startedAt,
      finishedAt: ['synth_ready', 'segment_failed', 'segment_skipped'].includes(event.phase) ? now : segment.finishedAt,
      durationMs: event.durationMs ?? segment.durationMs,
      audioDurationMs: event.audioDurationMs ?? segment.audioDurationMs,
      retryCount,
      delayMs: event.delayMs ?? segment.delayMs,
      attempt: event.attempt ?? segment.attempt,
      statusCode: event.status ?? segment.statusCode,
      detail: event.detail ?? segment.detail,
      error: event.error ?? segment.error,
    })
  }

  function ensureSegment(event: StreamingTtsDebugEvent): TtsDebugSegment {
    const existing = segments.value.find(segment => segment.sessionId === event.sessionId && segment.index === event.segmentIndex)
    if (existing)
      return existing

    const created: TtsDebugSegment = {
      id: `${event.sessionId}:${event.segmentIndex}`,
      sessionId: event.sessionId,
      index: event.segmentIndex ?? 0,
      lane: event.lane ?? 'session',
      text: event.text ?? '',
      status: statusForPhase(event.phase),
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
      retryCount: 0,
    }
    segments.value.push(created)
    return created
  }

  function updateSegment(sessionId: string, index: number, patch: Partial<TtsDebugSegment>) {
    const i = segments.value.findIndex(segment => segment.sessionId === sessionId && segment.index === index)
    if (i < 0)
      return
    segments.value[i] = {
      ...segments.value[i],
      ...patch,
    }
  }

  function findSegmentForPlayback(item: { intentId?: string, segmentId?: string }) {
    const parsed = parsePlaybackItem(item)
    if (!parsed)
      return null
    return segments.value.find(segment => segment.sessionId === parsed.sessionId && segment.index === parsed.segmentIndex) ?? null
  }

  function parsePlaybackItem(item: { intentId?: string, segmentId?: string }) {
    const sessionId = item.intentId
    if (!sessionId)
      return null
    const segmentIndex = parseSegmentIndex(sessionId, item.segmentId)
    if (segmentIndex == null)
      return null
    return { sessionId, segmentIndex }
  }

  function parseSegmentIndex(intentId: string, segmentId?: string) {
    if (!segmentId || !segmentId.startsWith(`${intentId}-`))
      return null
    const raw = segmentId.slice(intentId.length + 1)
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }

  function recordSyntheticPlaybackEvent(
    phase: StreamingTtsDebugPhase,
    sessionId: string,
    segmentIndex: number,
    lane: StreamingTtsDebugLane,
    text?: string,
    error?: string,
  ) {
    const event: StreamingTtsDebugEvent = {
      sessionId,
      phase,
      timestamp: Date.now(),
      lane,
      segmentIndex,
      text,
      error,
    }
    broadcastEvent(event)
    acceptEvent(event)
  }

  function statusForPhase(phase: StreamingTtsDebugPhase): TtsDebugSegmentStatus {
    switch (phase) {
      case 'segment_queued':
        return 'queued'
      case 'synth_start':
        return 'synthesizing'
      case 'synth_delay':
        return 'delayed'
      case 'synth_retry':
        return 'retrying'
      case 'synth_ready':
        return 'ready'
      case 'segment_emitted':
        return 'queued_playback'
      case 'segment_fallback':
        return 'fallback'
      case 'segment_failed':
        return 'failed'
      case 'segment_skipped':
        return 'skipped'
      case 'playback_started':
        return 'playing'
      case 'playback_finished':
        return 'played'
      case 'playback_interrupted':
        return 'failed'
      default:
        return 'queued'
    }
  }

  return {
    enabled,
    panelOpen,
    currentSessionId,
    sessions,
    segments,
    events,
    currentSegments,
    currentEvents,
    activeCount,
    hasActiveSession,
    setEnabled,
    togglePanel,
    clear,
    recordEvent,
    markPlaybackStart,
    markPlaybackEnd,
    markPlaybackInterrupted,
  }
})
