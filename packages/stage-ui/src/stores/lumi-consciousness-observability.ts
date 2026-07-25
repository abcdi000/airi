import type { StreamUsage } from '@proj-airi/core-agent'
import type { Message } from '@xsai/shared-chat'

import type { LumiConversationContextMessage } from '../../../lumi-runtime/src'

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { estimateLumiConversationTokens } from '../../../lumi-runtime/src'

const STORAGE_KEY = 'runtime/lumi/consciousness-request-log-v1'
const MAX_REQUESTS = 120
const FULL_DETAIL_REQUESTS = 8
const MAX_PROMPT_CHARACTERS = 180_000
const MAX_RESPONSE_CHARACTERS = 80_000

export type LumiConsciousnessRequestPurpose
  = | 'planner'
    | 'replyer'
    | 'replyer_retry'
    | 'expression_selector'
    | 'learning'
    | 'feedback'
    | 'sticker_classifier'
    | 'sticker_selector'
    | 'context_summary'
    | 'relationship_assessment'
    | 'current_state'
    | 'profile_curator'
    | 'profile_review'
    | 'memory_curator'
    | 'memory_topic'
    | 'other'

/** Message-only prefix evidence compared with a recent request on the same model and conversation. */
export interface LumiRequestPrefixDiagnostics {
  /** Recent request whose serialized message prefix matched best. */
  comparedRequestId: string
  /** Stage that produced the best matching cached-prefix candidate. */
  comparedPurpose: LumiConsciousnessRequestPurpose
  /** Complete messages shared before the first changed message. */
  commonMessageCount: number
  /** Conservative token estimate before the first changed byte. */
  estimatedCommonPrefixTokens: number
  /** Fraction of the current message payload covered by that common prefix. */
  estimatedReusableRatio: number
  /** First message whose role, name, or content differs. */
  firstDivergenceMessageIndex: number
}

/** One locally persisted, privacy-sensitive consciousness model request trace. */
export interface LumiConsciousnessRequestTrace {
  id: string
  purpose: LumiConsciousnessRequestPurpose
  model: string
  provider?: string
  conversationId?: string
  startedAt: number
  firstTokenAt?: number
  completedAt?: number
  status: 'streaming' | 'completed' | 'error'
  requestMessages?: LumiConversationContextMessage[]
  responseText: string
  responseTruncated?: boolean
  chunkCount: number
  estimatedInputTokens: number
  estimatedOutputTokens: number
  actualInputTokens?: number
  actualOutputTokens?: number
  promptCacheHitTokens?: number
  promptCacheMissTokens?: number
  /** Whether DeepSeek returned complete, internally consistent V4 cache accounting. */
  cacheAccounting?: 'measured' | 'unavailable' | 'inconsistent'
  /** Count of provider usage records included in this trace. */
  usageSamples?: number
  /** Count of usage records that included both DeepSeek cache fields. */
  cacheUsageSamples?: number
  /** Local message-prefix evidence; tool schemas and provider-side intervals are not included. */
  prefixDiagnostics?: LumiRequestPrefixDiagnostics
  firstTokenLatencyMs?: number
  durationMs?: number
  error?: string
}

/**
 * Records every desktop consciousness request while Prompt logging is enabled.
 *
 * Recent requests retain their exact prompt and streamed output. Older entries
 * retain timing and token statistics so the inspector stays useful without
 * exhausting browser storage.
 */
export const useLumiConsciousnessObservabilityStore = defineStore('lumi-consciousness-observability', () => {
  const requests = ref<LumiConsciousnessRequestTrace[]>(loadRequests())
  const activeCount = computed(() => requests.value.filter(request => request.status === 'streaming').length)
  let persistenceTimer: ReturnType<typeof setTimeout> | undefined

  function begin(input: {
    id: string
    purpose: LumiConsciousnessRequestPurpose
    model: string
    provider?: string
    conversationId?: string
    messages: Message[] | LumiConversationContextMessage[]
    startedAt?: number
  }) {
    const requestMessages = normalizeMessages(input.messages)
    const prefixDiagnostics = findBestPrefixDiagnostics({
      currentMessages: requestMessages,
      purpose: input.purpose,
      model: input.model,
      provider: input.provider,
      conversationId: input.conversationId,
      candidates: requests.value,
    })
    const trace: LumiConsciousnessRequestTrace = {
      id: input.id,
      purpose: input.purpose,
      model: input.model,
      provider: input.provider,
      conversationId: input.conversationId,
      startedAt: input.startedAt ?? Date.now(),
      status: 'streaming',
      requestMessages,
      responseText: '',
      chunkCount: 0,
      estimatedInputTokens: estimateLumiConversationTokens(requestMessages),
      estimatedOutputTokens: 0,
      prefixDiagnostics,
    }
    requests.value = compactRequests([...requests.value.filter(item => item.id !== input.id), trace])
    persistNow()
  }

  function appendDelta(id: string, delta: string, receivedAt = Date.now()) {
    if (!delta)
      return
    update(id, (trace) => {
      const available = Math.max(0, MAX_RESPONSE_CHARACTERS - trace.responseText.length)
      const appended = delta.slice(0, available)
      const responseText = trace.responseText + appended
      return {
        ...trace,
        firstTokenAt: trace.firstTokenAt ?? receivedAt,
        firstTokenLatencyMs: trace.firstTokenLatencyMs ?? Math.max(0, receivedAt - trace.startedAt),
        responseText,
        responseTruncated: trace.responseTruncated || appended.length < delta.length,
        chunkCount: trace.chunkCount + 1,
        estimatedOutputTokens: estimateTextTokens(responseText),
      }
    })
    schedulePersist()
  }

  function recordUsage(id: string, usage: StreamUsage) {
    update(id, (trace) => {
      const promptTokens = finiteUsage(usage.prompt_tokens)
      const completionTokens = finiteUsage(usage.completion_tokens)
      const cacheHitTokens = finiteUsage(usage.prompt_cache_hit_tokens)
      const cacheMissTokens = finiteUsage(usage.prompt_cache_miss_tokens)
      const hasCacheAccounting = cacheHitTokens !== undefined && cacheMissTokens !== undefined
      const cacheAccounting = hasCacheAccounting
        ? promptTokens !== undefined && promptTokens !== cacheHitTokens + cacheMissTokens
          ? 'inconsistent'
          : trace.cacheAccounting === 'inconsistent' ? 'inconsistent' : 'measured'
        : trace.cacheAccounting ?? 'unavailable'

      return {
        ...trace,
        actualInputTokens: addUsage(trace.actualInputTokens, promptTokens),
        actualOutputTokens: addUsage(trace.actualOutputTokens, completionTokens),
        promptCacheHitTokens: hasCacheAccounting
          ? addUsage(trace.promptCacheHitTokens, cacheHitTokens)
          : trace.promptCacheHitTokens,
        promptCacheMissTokens: hasCacheAccounting
          ? addUsage(trace.promptCacheMissTokens, cacheMissTokens)
          : trace.promptCacheMissTokens,
        cacheAccounting,
        usageSamples: (trace.usageSamples ?? 0) + 1,
        cacheUsageSamples: (trace.cacheUsageSamples ?? 0) + (hasCacheAccounting ? 1 : 0),
      }
    })
    schedulePersist()
  }

  function complete(id: string, input?: {
    completedAt?: number
    firstTokenLatencyMs?: number
    durationMs?: number
  }) {
    const completedAt = input?.completedAt ?? Date.now()
    update(id, trace => ({
      ...trace,
      completedAt,
      status: 'completed',
      firstTokenLatencyMs: input?.firstTokenLatencyMs ?? trace.firstTokenLatencyMs,
      durationMs: input?.durationMs ?? Math.max(0, completedAt - trace.startedAt),
    }))
    persistNow()
  }

  function fail(id: string, error: string, input?: {
    completedAt?: number
    firstTokenLatencyMs?: number
    durationMs?: number
  }) {
    const completedAt = input?.completedAt ?? Date.now()
    update(id, trace => ({
      ...trace,
      completedAt,
      status: 'error',
      error: error.slice(0, 4_000),
      firstTokenLatencyMs: input?.firstTokenLatencyMs ?? trace.firstTokenLatencyMs,
      durationMs: input?.durationMs ?? Math.max(0, completedAt - trace.startedAt),
    }))
    persistNow()
  }

  function refreshFromStorage() {
    requests.value = loadRequests()
  }

  function clear() {
    requests.value = []
    persistNow()
  }

  function deleteRequest(id: string) {
    requests.value = requests.value.filter(request => request.id !== id)
    persistNow()
  }

  function update(id: string, project: (trace: LumiConsciousnessRequestTrace) => LumiConsciousnessRequestTrace) {
    requests.value = requests.value.map(trace => trace.id === id ? project(trace) : trace)
  }

  function schedulePersist() {
    if (persistenceTimer)
      return
    persistenceTimer = setTimeout(() => {
      persistenceTimer = undefined
      persistNow()
    }, 160)
  }

  function persistNow() {
    if (persistenceTimer) {
      clearTimeout(persistenceTimer)
      persistenceTimer = undefined
    }
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(compactRequests(requests.value)))
    }
    catch (error) {
      console.warn('[lumi-consciousness-observability] failed to persist request traces', error)
    }
  }

  return {
    requests,
    activeCount,
    begin,
    appendDelta,
    recordUsage,
    complete,
    fail,
    refreshFromStorage,
    clear,
    deleteRequest,
  }
})

function finiteUsage(value: number | undefined) {
  return Number.isFinite(value) && value != null ? Math.max(0, Math.round(value)) : undefined
}

function addUsage(current: number | undefined, value: number | undefined) {
  return value === undefined ? current : (current ?? 0) + value
}

function loadRequests(): LumiConsciousnessRequestTrace[] {
  const serialized = globalThis.localStorage?.getItem(STORAGE_KEY)
  if (!serialized)
    return []
  try {
    const parsed: unknown = JSON.parse(serialized)
    return Array.isArray(parsed)
      ? parsed.filter(isRequestTrace).slice(-MAX_REQUESTS)
      : []
  }
  catch {
    return []
  }
}

function compactRequests(input: LumiConsciousnessRequestTrace[]) {
  return input.slice(-MAX_REQUESTS).map((trace, index, all) => {
    if (index >= all.length - FULL_DETAIL_REQUESTS)
      return trace
    return {
      ...trace,
      requestMessages: undefined,
      responseText: trace.responseText.slice(0, 2_000),
      responseTruncated: trace.responseTruncated || trace.responseText.length > 2_000,
    }
  })
}

function normalizeMessages(messages: Message[] | LumiConversationContextMessage[]) {
  let remainingCharacters = MAX_PROMPT_CHARACTERS
  return messages.flatMap((message, index): LumiConversationContextMessage[] => {
    if (remainingCharacters <= 0)
      return []
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .filter(part => part.type === 'text')
            .map(part => part.text)
            .join('\n')
        : ''
    const normalized = content.slice(0, remainingCharacters)
    remainingCharacters -= normalized.length
    if (!normalized)
      return []
    return [{
      id: 'id' in message && typeof message.id === 'string' ? message.id : `request-message-${index}`,
      role: message.role === 'system' || message.role === 'assistant' ? message.role : 'user',
      content: normalized,
      name: 'name' in message && typeof message.name === 'string' ? message.name : undefined,
    }]
  })
}

function isRequestTrace(value: unknown): value is LumiConsciousnessRequestTrace {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.purpose === 'string'
    && typeof record.model === 'string'
    && typeof record.startedAt === 'number'
    && typeof record.status === 'string'
    && typeof record.responseText === 'string'
    && typeof record.chunkCount === 'number'
}

function estimateTextTokens(text: string) {
  return Math.max(0, Math.ceil(new TextEncoder().encode(text).byteLength / 3))
}

function findBestPrefixDiagnostics(input: {
  currentMessages: LumiConversationContextMessage[]
  purpose: LumiConsciousnessRequestPurpose
  model: string
  provider?: string
  conversationId?: string
  candidates: LumiConsciousnessRequestTrace[]
}): LumiRequestPrefixDiagnostics | undefined {
  const comparable = input.candidates
    .filter(candidate =>
      candidate.requestMessages
      && candidate.model === input.model
      && candidate.provider === input.provider
      && (
        input.conversationId
          ? candidate.conversationId === input.conversationId
          : candidate.purpose === input.purpose && candidate.conversationId === undefined
      ),
    )
    .slice(-16)

  let best: LumiRequestPrefixDiagnostics | undefined
  for (const candidate of comparable) {
    const diagnostics = compareMessagePrefixes(
      input.currentMessages,
      candidate.requestMessages!,
      candidate.id,
      candidate.purpose,
    )
    if (!best || diagnostics.estimatedCommonPrefixTokens > best.estimatedCommonPrefixTokens)
      best = diagnostics
  }
  return best
}

function compareMessagePrefixes(
  current: LumiConversationContextMessage[],
  previous: LumiConversationContextMessage[],
  comparedRequestId: string,
  comparedPurpose: LumiConsciousnessRequestPurpose,
): LumiRequestPrefixDiagnostics {
  let commonMessageCount = 0
  while (
    commonMessageCount < current.length
    && commonMessageCount < previous.length
    && serializeMessage(current[commonMessageCount]!) === serializeMessage(previous[commonMessageCount]!)
  ) {
    commonMessageCount += 1
  }

  const exactPrefix = current.slice(0, commonMessageCount).map(serializeMessage).join('')
  const currentDivergence = current[commonMessageCount]
  const previousDivergence = previous[commonMessageCount]
  const partialPrefix = currentDivergence && previousDivergence
    ? commonStringPrefix(serializeMessage(currentDivergence), serializeMessage(previousDivergence))
    : ''
  const currentSerialized = current.map(serializeMessage).join('')
  const estimatedCommonPrefixTokens = estimateTextTokens(exactPrefix + partialPrefix)
  const estimatedCurrentTokens = Math.max(1, estimateTextTokens(currentSerialized))

  return {
    comparedRequestId,
    comparedPurpose,
    commonMessageCount,
    estimatedCommonPrefixTokens,
    estimatedReusableRatio: Math.min(1, estimatedCommonPrefixTokens / estimatedCurrentTokens),
    firstDivergenceMessageIndex: commonMessageCount,
  }
}

function serializeMessage(message: LumiConversationContextMessage) {
  return `${message.role}\u0000${message.name ?? ''}\u0000${message.content}\u0000`
}

function commonStringPrefix(left: string, right: string) {
  const maximum = Math.min(left.length, right.length)
  let index = 0
  while (index < maximum && left.charCodeAt(index) === right.charCodeAt(index))
    index += 1
  return left.slice(0, index)
}
