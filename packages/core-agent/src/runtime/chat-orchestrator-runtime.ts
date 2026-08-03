import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { CommonContentPart, Message, ToolMessage } from '@xsai/shared-chat'

import type { AgentContextPort } from '../contracts/context-port'
import type { AgentForegroundStreamPort } from '../contracts/stream-port'
import type { ChatAssistantMessage, ChatHistoryItem, ChatInteractionContext, ChatSlices, ChatStreamEventContext, ContextMessage, StreamingAssistantMessage } from '../types/chat'
import type { StreamEvent, StreamOptions, StreamUsage } from '../types/llm'

import { errorMessageFrom } from '@moeru/std'
import { createQueue } from '@proj-airi/stream-kit'

import { formatContextPromptText } from '../messages/context-prompt'
import { formatTimePrefix } from '../messages/datetime-prefix'
import { createChatHooks } from './agent-hooks'
import { createContextRegistry } from './context-registry'
import { useLlmmarkerParser } from './llm-marker-parser'
import { categorizeResponse, createStreamingCategorizer } from './response-categoriser'

const STREAMING_UI_FLUSH_CHUNK_SIZE = 24

type Awaitable<T> = T | Promise<T>

function notifyModelObserver<T>(observer: ((input: T) => void) | undefined, input: T) {
  try {
    observer?.(input)
  }
  catch (error) {
    console.warn('[chat-orchestrator] model observer failed', error)
  }
}

function prependTextToContent<T extends { content?: unknown }>(msg: T, text: string): T {
  const content = msg.content
  if (content === undefined)
    return { ...msg, content: text }
  if (typeof content === 'string')
    return { ...msg, content: `${text}${content}` }

  if (Array.isArray(content)) {
    const first = content[0] as { type?: string, text?: string } | undefined
    if (first && first.type === 'text' && typeof first.text === 'string') {
      const next = [{ ...first, text: `${text}${first.text}` }, ...content.slice(1)]
      return { ...msg, content: next }
    }
    return { ...msg, content: [{ type: 'text', text }, ...content] }
  }

  return msg
}

function appendTextToContent<T extends { content?: unknown }>(msg: T, text: string): T {
  const content = msg.content
  if (content === undefined)
    return { ...msg, content: text }
  if (typeof content === 'string')
    return { ...msg, content: `${content}${text}` }

  if (Array.isArray(content))
    return { ...msg, content: [...content, { type: 'text', text }] }

  return msg
}

function flattenContentPartsForTextOnlyProvider<T extends { content?: unknown }>(msg: T): T {
  const content = msg.content
  if (!Array.isArray(content))
    return msg

  const text = content
    .map(part => (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part) ? String(part.text ?? '') : '')
    .join('')

  return { ...msg, content: text }
}

function replaceAssistantSpeech(message: StreamingAssistantMessage, speech: string) {
  const toolProgress = message.slices
    .filter((slice): slice is Extract<ChatSlices, { type: 'text' }> => slice.type === 'text' && slice.source === 'tool-progress')
    .map(slice => slice.text)
    .filter(Boolean)
  message.content = [...toolProgress, speech].filter(Boolean).join('\n')

  const firstTextIndex = message.slices.findIndex(slice => slice.type === 'text' && slice.source !== 'tool-progress')
  if (firstTextIndex < 0) {
    if (speech)
      message.slices.push({ type: 'text', text: speech })
    return
  }

  let textWritten = false
  message.slices = message.slices
    .map((slice) => {
      if (slice.type !== 'text' || slice.source === 'tool-progress')
        return slice
      if (!textWritten) {
        textWritten = true
        return { ...slice, text: speech }
      }
      return { ...slice, text: '' }
    })
    .filter(slice => slice.type !== 'text' || slice.text.length > 0)
}

function cloneStreamingMessage(message: StreamingAssistantMessage): StreamingAssistantMessage {
  try {
    return structuredClone(message)
  }
  catch {
    return JSON.parse(JSON.stringify(message)) as StreamingAssistantMessage
  }
}

function getAssistantMessageText(message: StreamingAssistantMessage): string {
  if (typeof message.content === 'string')
    return message.content

  return message.slices
    .filter(slice => slice.type === 'text')
    .map(slice => slice.text)
    .join('')
}

/**
 * Returns only text authored as Lumi's visible reply.
 *
 * Tool progress remains part of the persisted assistant message so the local
 * debug UI can render it, but it must not enter external replies, room ledgers,
 * TTS, or other consumers of a completed turn.
 */
function getAssistantVisibleText(message: StreamingAssistantMessage): string {
  if (message.slices.length > 0) {
    return message.slices
      .filter((slice): slice is Extract<ChatSlices, { type: 'text' }> =>
        slice.type === 'text' && slice.source !== 'tool-progress')
      .map(slice => slice.text)
      .join('')
  }

  return typeof message.content === 'string' ? message.content : ''
}

function readProviderNumber(config: Record<string, unknown> | undefined, key: string, fallback = 0) {
  const value = config?.[key]
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

function limitProviderHistoryMessages(messages: ChatHistoryItem[], providerConfig?: Record<string, unknown>) {
  const maxContextMessages = Math.round(readProviderNumber(providerConfig, 'maxContextMessages', 0))
  if (maxContextMessages <= 0 || messages.length <= maxContextMessages)
    return messages

  const systemPrefix: ChatHistoryItem[] = []
  const rest = messages.slice()
  while (rest[0]?.role === 'system')
    systemPrefix.push(rest.shift()!)

  return [
    ...systemPrefix,
    ...rest.slice(-maxContextMessages),
  ]
}

function resolveProviderMaxStreamSteps(providerConfig?: Record<string, unknown>) {
  const maxToolSteps = Math.round(readProviderNumber(providerConfig, 'maxToolSteps', 0))
  if (maxToolSteps > 0)
    return maxToolSteps

  const maxStreamSteps = Math.round(readProviderNumber(providerConfig, 'maxStreamSteps', 0))
  if (maxStreamSteps > 0)
    return maxStreamSteps

  return undefined
}

/**
 * Options accepted by the chat orchestrator runtime for one user send.
 */
export interface ChatOrchestratorSendOptions {
  /** Provider model identifier used for the outbound LLM request. */
  model: string
  /** Concrete chat provider implementation selected by the caller. */
  chatProvider: ChatProvider
  /** Provider-specific request options, currently used for headers. */
  providerConfig?: Record<string, unknown>
  /** Immutable actor and participant identity for this turn. */
  interaction?: ChatInteractionContext
  /**
   * Optional shared execution lane. Sends in one lane remain FIFO even when
   * they belong to different sessions.
   */
  executionLane?: string
  /** Stable assistant actor ID persisted on the response. */
  assistantActorId?: string
  /** Assistant display name persisted on the response. */
  assistantActorDisplayName?: string
  /** Optional per-send history projection applied before provider messages are built. */
  providerHistoryTransform?: (messages: ChatHistoryItem[]) => ChatHistoryItem[] | Promise<ChatHistoryItem[]>
  /** Image attachments appended to the user message content parts. */
  attachments?: { type: 'image', data: string, mimeType: string }[]
  /** Extra text appended to the provider-facing user message without changing chat history. */
  providerUserContext?: string
  /**
   * Complete semantic text for a host-managed Agent Runtime turn.
   *
   * Use after a trusted vision or hearing module has resolved non-text input.
   * This text is available to cognition, planning, and reply generation but is
   * never persisted as the user-visible chat message.
   */
  agentUserText?: string
  /** Whether image attachments should be sent to the chat provider. Defaults to true. */
  sendAttachmentsToProvider?: boolean
  /** Optional final provider-message projection hook. Does not mutate persisted chat history. */
  providerMessageTransform?: (messages: Message[]) => Message[]
  /** Observes the exact tool-capable model request immediately before streaming starts. */
  onModelRequestStarted?: (input: {
    model: string
    messages: Message[]
    startedAt: number
  }) => void
  /**
   * Observes raw stream events without changing parsing or visible output.
   *
   * Keep this callback synchronous and lightweight. It runs on the provider's
   * streaming path and must not delay user-visible generation.
   */
  onModelStreamEvent?: (event: StreamEvent) => void
  /** Observes provider usage for each completed Planner/tool step. */
  onModelUsage?: (usage: StreamUsage) => void
  /** Observes completion timing for the tool-capable model request. */
  onModelRequestFinished?: (input: {
    model: string
    startedAt: number
    completedAt: number
    firstTokenLatencyMs?: number
    durationMs: number
    status: 'completed' | 'error'
    error?: string
  }) => void
  /**
   * Receives privacy-safe progress from a host-managed Agent Runtime.
   *
   * Hidden reasoning, tool arguments, and tool results must never cross this
   * callback. It is intended for remote chat transports that need to show
   * which user-visible action Lumi is currently performing.
   */
  onAgentToolProgress?: (progress: {
    toolName: string
    status: 'started' | 'succeeded' | 'failed' | 'skipped'
    timestamp: number
    durationMs?: number
    errorCode?: string
  }) => void | Promise<void>
  /** Optional final assistant speech cleanup hook. Does not affect provider reasoning content. */
  assistantSpeechTransform?: (speech: string) => string
  /**
   * Optional asynchronous boundary between the tool-capable model and visible speech.
   *
   * Use for Planner/Replyer architectures after the provider has completed all
   * tool steps. The returned text is parsed, persisted, and emitted as the
   * assistant response. The raw provider text remains internal.
   */
  assistantResponseTransform?: (input: {
    rawText: string
    providerMessages: Message[]
    interaction?: ChatInteractionContext
    sessionId: string
  }) => Awaitable<string>
  /**
   * Buffers provider text until {@link assistantResponseTransform} completes.
   *
   * @default false
   */
  deferAssistantText?: boolean
  /** Optional final assistant message projection hook. Can split or rewrite the persisted message. */
  assistantMessageTransform?: (message: StreamingAssistantMessage, messageText: string) => StreamingAssistantMessage[]
  /** Converts confirmed tool outcomes into visible in-message progress text. */
  toolResultTextTransform?: (params: { toolName: string, result: unknown, isError: boolean }) => string | undefined
  /** Tool definitions passed through to the LLM stream port. */
  tools?: StreamOptions['tools']
  /** Final per-turn policy applied after builtin and caller tools are merged. */
  toolTransform?: StreamOptions['toolTransform']
  /** Original transport input metadata used by bridge/devtools observers. */
  input?: ChatStreamEventContext['input']
  /** Uses the text as provider-facing input without persisting a visible user bubble. */
  hiddenUserMessage?: boolean
  /** Final assistant texts that should be treated as intentional silence and not appended. */
  suppressAssistantTexts?: string[]
  /** Called when the final assistant text matches an intentional-silence marker. */
  onAssistantSuppressed?: (text: string) => void
}

interface QueuedSend {
  sendingMessage: string
  options: ChatOrchestratorSendOptions
  generation: number
  sessionId: string
  cancelled?: boolean
  deferred: {
    resolve: () => void
    reject: (error: unknown) => void
  }
}

/**
 * Serializable view of a queued send waiting to be processed.
 */
export interface QueuedSendSnapshot {
  /** Session that owns the queued send. */
  sessionId: string
  /** Session generation captured when the send was enqueued. */
  generation: number
  /** Whether the queued send has been rejected before execution. */
  cancelled: boolean
  /** First 120 characters of the pending user message. */
  messagePreview: string
  /** Whether the queued send carries image attachments. */
  hasAttachments: boolean
  /** Optional input event type for transport-originated sends. */
  inputType?: NonNullable<ChatStreamEventContext['input']>['type']
}

/**
 * Session operations required by the core chat orchestrator runtime.
 */
export interface ChatOrchestratorSessionPort {
  /** Ensures a session exists before messages are appended. */
  ensureSession: (sessionId: string) => void
  /** Returns chronological chat history for a session. */
  getSessionMessages: (sessionId: string) => ChatHistoryItem[]
  /** Appends a finalized user/assistant/tool history item. */
  appendSessionMessage: (sessionId: string, message: ChatHistoryItem) => void
  /** Returns a monotonic generation used to reject stale queued sends. */
  getSessionGeneration: (sessionId: string) => number
}

/**
 * LLM streaming boundary used by the core chat orchestrator runtime.
 */
export interface ChatOrchestratorLLMPort {
  /** Streams one composed chat request and emits normalized stream events. */
  stream: (model: string, chatProvider: ChatProvider, messages: Message[], options?: StreamOptions) => Promise<void>
}

/**
 * Lifecycle record emitted around prompt composition.
 */
export interface ChatOrchestratorLifecycleRecord {
  /** Composition phase being observed. */
  phase: 'before-compose' | 'prompt-context-built' | 'after-compose'
  /** Logical event channel for context observability. */
  channel: 'chat'
  /** Session associated with this send. */
  sessionId: string
  /** Optional compact preview of the user text. */
  textPreview?: string
  /** Phase-specific payload for devtools and diagnostics. */
  details?: unknown
}

/**
 * Prompt projection emitted after the runtime has composed provider messages.
 */
export interface ChatOrchestratorPromptProjection {
  /** Session associated with the projected prompt. */
  sessionId: string
  /** Raw user message text that triggered the prompt. */
  message: string
  /** Active context snapshot read during prompt composition. */
  contexts: Record<string, ContextMessage[]>
  /** Historical standalone context prompt shape, kept for compatibility. */
  promptMessage?: Message | null
  /** Provider-ready message array sent to the LLM port. */
  composedMessage?: Message[]
}

/**
 * Reactive state mirrored by UI facades.
 */
export interface ChatOrchestratorRuntimeState {
  /** Whether the runtime currently owns an active send. */
  sending: boolean
  /** Number of sends waiting behind the active one. */
  pendingQueuedSendCount: number
}

/**
 * Dependency surface used by the platform-agnostic chat orchestrator runtime.
 */
export interface ChatOrchestratorRuntimeDeps {
  /** Session persistence and generation guard port. */
  session: ChatOrchestratorSessionPort
  /** Context registry facade used for runtime context ingest and prompt snapshots. */
  context: Pick<AgentContextPort, 'ingest' | 'snapshot'>
  /** Foreground assistant stream port controlled by the UI facade. */
  foregroundStream: AgentForegroundStreamPort
  /** Provider-agnostic LLM streaming port. */
  llm: ChatOrchestratorLLMPort
  /** Returns the currently visible session ID. */
  getActiveSessionId: () => string
  /** Returns the currently active provider ID for categorization policy. */
  getActiveProvider: () => string | undefined
  /** Returns optional prompt text appended to the provider system message for this send. */
  getSystemPromptSupplement?: () => string | undefined
  /** Runtime context providers ingested immediately before prompt composition. */
  runtimeContextProviders?: Array<(event: { messageText: string, sessionId: string, interaction?: ChatInteractionContext }) => Awaitable<ContextMessage | null | undefined>>
  /** Clock used for persisted message timestamps. @default Date.now */
  now?: () => number
  /** Monotonic clock used for elapsed telemetry in milliseconds. @default performance.now */
  monotonicNow?: () => number
  /** ID factory used for persisted chat messages. @default crypto.randomUUID fallback */
  createId?: () => string
  /** Optional adapter for removing framework proxies before provider composition. */
  unwrapMessage?: <T>(message: T) => T
  /** Called whenever writable runtime state changes. */
  onStateChange?: (state: ChatOrchestratorRuntimeState) => void
  /** Called after one runtime-owned send completes or fails. */
  onSendSettled?: (event: { sessionId: string }) => void
  /** Called when a send starts and the first assistant placeholder is created. */
  onTrackFirstMessage?: () => void
  /** Called when a user message send begins. */
  onMessageSendStarted?: (event: {
    source: 'text' | 'voice'
    model: string
  }) => void
  /** Called immediately before the provider LLM request starts. */
  onLlmRequestStarted?: (event: {
    model: string
    provider: string
    hasVoice: boolean
  }) => void
  /** Called when the first text token arrives from the provider stream. */
  onLlmFirstToken?: (event: {
    model: string
    ttfbMs: number
  }) => void
  /** Called after the assistant stream is parsed and rendered into runtime state. */
  onAssistantResponseRendered?: (event: {
    model: string
    latencyMs: number
  }) => void
  /** Called after one user-to-assistant message round completes successfully. */
  onMessageRound?: (event: {
    durationMs: number
    hasVoice: boolean
    model: string
  }) => void
  /** Called for context/prompt lifecycle observability. */
  onLifecycle?: (record: ChatOrchestratorLifecycleRecord) => void
  /** Called with the final provider prompt projection. */
  onPromptProjection?: (payload: ChatOrchestratorPromptProjection) => void
  /** Called after the user message has been appended to session history. */
  onUserMessageAppended?: (event: {
    sessionId: string
    message: Extract<ChatHistoryItem, { role: 'user' }> & { id: string }
    messageText: string
    interaction?: ChatInteractionContext
  }) => void
  /** Called after the assistant message has been finalized into session history. */
  onAssistantMessageAppended?: (event: {
    sessionId: string
    message: StreamingAssistantMessage
    messageText: string
    interaction?: ChatInteractionContext
  }) => void
  /** Called after user turn persistence, before provider prompt composition. */
  onUserTurnReady?: (event: {
    sessionId: string
    messageText: string
    sessionMessages: ChatHistoryItem[]
    hasAttachments: boolean
    interaction?: ChatInteractionContext
  }) => Awaitable<void>
  /** Called after assistant streaming and hook finalization. */
  onAssistantTurnReady?: (event: {
    sessionId: string
    messageText: string
    sessionMessages: ChatHistoryItem[]
    hasAttachments: boolean
    hiddenUserMessage?: boolean
    interaction?: ChatInteractionContext
  }) => void
}

/**
 * Platform-agnostic chat orchestrator runtime API.
 */
export interface ChatOrchestratorRuntime {
  /** Enqueues a user send, preserving FIFO order within its target session. */
  ingest: (sendingMessage: string, options: ChatOrchestratorSendOptions, targetSessionId?: string) => Promise<void>
  /** Rejects queued sends that have not started yet. */
  cancelPendingSends: (sessionId?: string) => void
  /** Returns serializable snapshots of currently queued sends. */
  getPendingQueuedSendSnapshot: () => QueuedSendSnapshot[]
  /** Returns the current queued send count. */
  getPendingQueuedSendCount: () => number
  /** Reads the writable sending flag. */
  getSending: () => boolean
  /** Updates the writable sending flag and notifies facade mirrors. */
  setSending: (next: boolean) => void
  /** Hook registry preserved from the previous stage-ui store API. */
  hooks: ReturnType<typeof createChatHooks>
}

function defaultCreateId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function shouldSuppressAssistantText(text: string, suppressedTexts?: string[]) {
  if (!suppressedTexts?.length)
    return false

  const normalized = text.trim().toLowerCase()
  return suppressedTexts.some(item => normalized === item.trim().toLowerCase())
}

/**
 * Creates the core chat orchestrator runtime used behind UI facades.
 *
 * Use when:
 * - A platform wants AIRI chat send orchestration without Vue/Pinia coupling.
 * - Session, context, foreground stream, and LLM integrations are provided as adapters.
 *
 * Expects:
 * - Session messages are returned in chronological order.
 * - `foregroundStream.patch` replaces the visible streaming assistant message.
 *
 * Returns:
 * - A runtime with send queue APIs, hook registry, writable sending state, and queue snapshots.
 */
export function createChatOrchestratorRuntime(deps: ChatOrchestratorRuntimeDeps): ChatOrchestratorRuntime {
  const hooks = createChatHooks()
  const now = deps.now ?? (() => Date.now())
  const monotonicNow = deps.monotonicNow ?? (() => globalThis.performance?.now?.() ?? Date.now())
  const createId = deps.createId ?? defaultCreateId
  const unwrapMessage = deps.unwrapMessage ?? (<T>(message: T) => message)

  let sending = false
  let activeSendCount = 0
  let pendingQueuedSends: QueuedSend[] = []

  function emitStateChange() {
    deps.onStateChange?.({
      sending,
      pendingQueuedSendCount: pendingQueuedSends.length,
    })
  }

  function setSending(next: boolean) {
    if (sending === next)
      return
    sending = next
    emitStateChange()
  }

  function isForegroundSession(sessionId: string) {
    return sessionId === deps.getActiveSessionId()
  }

  function patchForegroundStream(sessionId: string, message: StreamingAssistantMessage) {
    if (isForegroundSession(sessionId))
      deps.foregroundStream.patch(cloneStreamingMessage(message))
  }

  function resetForegroundStream(sessionId: string) {
    if (isForegroundSession(sessionId))
      deps.foregroundStream.reset()
  }

  function createTurnContext() {
    const registry = createContextRegistry()
    const activeContexts = deps.context.snapshot()

    return {
      ingest(message: ContextMessage) {
        // Preserve shared observability while prompt composition reads only
        // the context snapshot owned by this individual turn.
        deps.context.ingest(message)
        const result = registry.ingest(message)
        if (!result)
          return
        activeContexts[result.sourceKey] = result.mutation === 'append'
          ? [...(activeContexts[result.sourceKey] ?? []), structuredClone(message)]
          : [structuredClone(message)]
      },
      snapshot: () => structuredClone(activeContexts),
    }
  }

  async function ingestRuntimeContexts(
    event: { messageText: string, sessionId: string, interaction?: ChatInteractionContext },
    turnContext: ReturnType<typeof createTurnContext>,
  ) {
    for (const provider of deps.runtimeContextProviders ?? []) {
      const contextMessage = await provider(event)
      if (contextMessage)
        turnContext.ingest(contextMessage)
    }
  }

  function buildProviderMessages(sessionMessagesForSend: ChatHistoryItem[], interaction?: ChatInteractionContext) {
    const nowTs = now()

    return sessionMessagesForSend.map((msg) => {
      const { context: _context, id: _id, createdAt, actorId: _actorId, actorDisplayName, ...withoutContext } = msg
      const rawMessage = unwrapMessage(withoutContext)

      if (rawMessage.role === 'user') {
        const speakerPrefix = interaction?.conversationType === 'group' && actorDisplayName
          ? `[Speaker: ${actorDisplayName}]\n`
          : ''
        return prependTextToContent(rawMessage, `${formatTimePrefix(createdAt ?? nowTs)}${speakerPrefix}`)
      }

      if (rawMessage.role === 'assistant') {
        const { slices: _slices, tool_results: _toolResults, categorization: _categorization, ...rest } = rawMessage as ChatAssistantMessage
        return unwrapMessage(rest)
      }

      return rawMessage
    })
  }

  async function performSend(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    generation: number,
    sessionId: string,
  ) {
    if (!sendingMessage && !options.attachments?.length)
      return

    deps.session.ensureSession(sessionId)

    const sendingCreatedAt = now()
    const turnContext = createTurnContext()

    // TODO: Expire or prune stale runtime contexts from disconnected services before composing.
    const streamingMessageContext: ChatStreamEventContext = {
      message: {
        role: 'user',
        content: sendingMessage,
        createdAt: sendingCreatedAt,
        id: createId(),
        actorId: options.interaction?.actorId,
        actorDisplayName: options.interaction?.actorDisplayName,
      },
      contexts: turnContext.snapshot(),
      composedMessage: [],
      input: options.input,
    }

    const isStaleGeneration = () => deps.session.getSessionGeneration(sessionId) !== generation
    const shouldAbort = () => isStaleGeneration()
    if (shouldAbort())
      return

    activeSendCount += 1
    setSending(true)

    const buildingMessage: StreamingAssistantMessage = {
      role: 'assistant',
      content: '',
      slices: [],
      tool_results: [],
      createdAt: now(),
      id: createId(),
      actorId: options.assistantActorId,
      actorDisplayName: options.assistantActorDisplayName,
    }
    patchForegroundStream(sessionId, buildingMessage)
    deps.onTrackFirstMessage?.()
    deps.onMessageSendStarted?.({
      source: options.input ? 'voice' : 'text',
      model: options.model,
    })
    const roundStartedAt = monotonicNow()

    try {
      const contentParts: CommonContentPart[] = [{ type: 'text', text: sendingMessage }]

      if (options.attachments) {
        for (const attachment of options.attachments) {
          if (attachment.type === 'image') {
            contentParts.push({
              type: 'image_url',
              image_url: {
                url: `data:${attachment.mimeType};base64,${attachment.data}`,
              },
            })
          }
        }
      }

      const finalContent = contentParts.length > 1 ? contentParts : sendingMessage
      if (!streamingMessageContext.input) {
        streamingMessageContext.input = {
          type: 'input:text',
          data: {
            text: sendingMessage,
          },
        }
      }

      if (shouldAbort())
        return

      const userMessageId = createId()
      const userMessage = {
        role: 'user' as const,
        content: finalContent,
        createdAt: sendingCreatedAt,
        id: userMessageId,
        actorId: options.interaction?.actorId,
        actorDisplayName: options.interaction?.actorDisplayName,
      }
      if (!options.hiddenUserMessage)
        deps.session.appendSessionMessage(sessionId, userMessage)

      // Cloud sync v1: only the raw text part round-trips; image attachments
      // and other non-text parts stay local.
      if (!options.hiddenUserMessage) {
        deps.onUserMessageAppended?.({
          sessionId,
          message: userMessage,
          messageText: sendingMessage,
          interaction: options.interaction,
        })
      }

      const sessionMessagesForSend = options.hiddenUserMessage
        ? [...deps.session.getSessionMessages(sessionId), userMessage]
        : deps.session.getSessionMessages(sessionId)
      if (!options.hiddenUserMessage) {
        await deps.onUserTurnReady?.({
          sessionId,
          messageText: sendingMessage,
          sessionMessages: sessionMessagesForSend,
          hasAttachments: !!options.attachments?.length,
          interaction: options.interaction,
        })
      }

      // Datetime is no longer injected through the side-channel context store.
      // It is applied at message-assembly time (see below) as a user-turn
      // local-time prefix, matching Lumi's original ChatSession behavior.
      await ingestRuntimeContexts({ messageText: sendingMessage, sessionId, interaction: options.interaction }, turnContext)
      streamingMessageContext.contexts = turnContext.snapshot()
      deps.onLifecycle?.({
        phase: 'before-compose',
        channel: 'chat',
        sessionId,
        textPreview: sendingMessage,
        details: {
          contexts: streamingMessageContext.contexts,
        },
      })
      await hooks.emitBeforeMessageComposedHooks(sendingMessage, streamingMessageContext)

      const categorizer = createStreamingCategorizer(deps.getActiveProvider())
      let streamPosition = 0
      const suppressionCandidates = (options.suppressAssistantTexts ?? [])
        .map(text => text.trim().toLowerCase())
        .filter(Boolean)
      let pendingSuppressionText = ''
      let suppressionPrefixResolved = suppressionCandidates.length === 0

      const emitSpeechLiteral = async (speech: string) => {
        if (!speech.trim())
          return

        await hooks.emitTokenLiteralHooks(speech, streamingMessageContext)

        const lastSlice = buildingMessage.slices.findLast(slice => slice.type === 'text' && slice.source !== 'tool-progress')
        if (lastSlice?.type === 'text') {
          lastSlice.text += speech
        }
        else {
          buildingMessage.slices.push({
            type: 'text',
            text: speech,
          })
        }
        buildingMessage.content = buildingMessage.slices
          .filter((slice): slice is Extract<ChatSlices, { type: 'text' }> => slice.type === 'text')
          .map(slice => slice.text)
          .join('\n')
        patchForegroundStream(sessionId, buildingMessage)
      }

      const consumeSpeechLiteral = async (speech: string) => {
        if (suppressionPrefixResolved) {
          await emitSpeechLiteral(speech)
          return
        }

        pendingSuppressionText += speech
        const probe = pendingSuppressionText.trim().toLowerCase()
        const mayStillBeSuppressed = !probe
          || suppressionCandidates.some(candidate => candidate.startsWith(probe))
        if (mayStillBeSuppressed)
          return

        suppressionPrefixResolved = true
        const pending = pendingSuppressionText
        pendingSuppressionText = ''
        await emitSpeechLiteral(pending)
      }

      const parser = useLlmmarkerParser({
        onLiteral: async (literal) => {
          if (shouldAbort())
            return

          categorizer.consume(literal)

          const speechOnly = categorizer.filterToSpeech(literal, streamPosition)
          streamPosition += literal.length

          await consumeSpeechLiteral(speechOnly)
        },
        onSpecial: async (special) => {
          if (shouldAbort())
            return

          await hooks.emitTokenSpecialHooks(special, streamingMessageContext)
        },
        onEnd: async (fullText) => {
          if (isStaleGeneration())
            return

          const finalCategorization = categorizeResponse(fullText, deps.getActiveProvider())
          const finalSpeech = options.assistantSpeechTransform
            ? options.assistantSpeechTransform(finalCategorization.speech)
            : finalCategorization.speech
          const finalSuppressed = shouldSuppressAssistantText(finalSpeech, options.suppressAssistantTexts)
            || shouldSuppressAssistantText(fullText, options.suppressAssistantTexts)
          if (!finalSuppressed && pendingSuppressionText) {
            suppressionPrefixResolved = true
            const pending = pendingSuppressionText
            pendingSuppressionText = ''
            await emitSpeechLiteral(pending)
          }

          const reasoningContentField = buildingMessage.categorization?.reasoning?.trim()
          buildingMessage.categorization = {
            speech: finalSpeech,
            reasoning: reasoningContentField || finalCategorization.reasoning,
          }
          if (finalSpeech !== finalCategorization.speech)
            replaceAssistantSpeech(buildingMessage, finalSpeech)
          patchForegroundStream(sessionId, buildingMessage)
        },
        minLiteralEmitLength: STREAMING_UI_FLUSH_CHUNK_SIZE,
      })

      const toolNamesByCallId = new Map<string, string>()
      const appendToolProgress = async (toolCallId: string, result: unknown, isError: boolean) => {
        const toolName = toolNamesByCallId.get(toolCallId)
        if (!toolName)
          return

        const text = options.toolResultTextTransform?.({ toolName, result, isError })?.trim()
        if (!text)
          return

        buildingMessage.slices.push({ type: 'text', text, source: 'tool-progress' })
        buildingMessage.content = buildingMessage.slices
          .filter((slice): slice is Extract<ChatSlices, { type: 'text' }> => slice.type === 'text')
          .map(slice => slice.text)
          .join('\n')
        patchForegroundStream(sessionId, buildingMessage)
      }

      const toolCallQueue = createQueue<ChatSlices>({
        handlers: [
          async (ctx) => {
            if (shouldAbort())
              return
            if (ctx.data.type === 'tool-call') {
              buildingMessage.slices.push(ctx.data)
              patchForegroundStream(sessionId, buildingMessage)
              return
            }

            if (ctx.data.type === 'tool-call-result') {
              buildingMessage.tool_results.push(ctx.data)
              patchForegroundStream(sessionId, buildingMessage)
            }
          },
        ],
      })

      const limitedProviderHistory = limitProviderHistoryMessages(sessionMessagesForSend, options.providerConfig)
      const providerHistoryMessages = options.providerHistoryTransform
        ? await options.providerHistoryTransform(limitedProviderHistory)
        : limitedProviderHistory
      const newMessages = buildProviderMessages(providerHistoryMessages, options.interaction)
      const systemPromptSupplement = deps.getSystemPromptSupplement?.()?.trim()
      if (systemPromptSupplement) {
        const systemMessage = newMessages.find(message => message.role === 'system')
        if (systemMessage) {
          systemMessage.content = `${systemMessage.content}\n\n${systemPromptSupplement}`
        }
        else {
          newMessages.unshift({
            role: 'system',
            content: systemPromptSupplement,
          })
        }
      }

      const contextsSnapshot = turnContext.snapshot()
      const contextPromptText = formatContextPromptText(contextsSnapshot)
      if (contextPromptText) {
        const lastMessage = newMessages.at(-1)
        if (lastMessage && lastMessage.role === 'user') {
          const existingParts = typeof lastMessage.content === 'string'
            ? [{ type: 'text' as const, text: lastMessage.content }]
            : lastMessage.content

          lastMessage.content = [
            ...existingParts,
            { type: 'text' as const, text: `\n${contextPromptText}` },
          ]
        }

        deps.onLifecycle?.({
          phase: 'prompt-context-built',
          channel: 'chat',
          sessionId,
          details: {
            contexts: contextsSnapshot,
            promptText: contextPromptText,
          },
        })
      }

      const providerUserContext = options.providerUserContext?.trim()
      if (providerUserContext) {
        const lastMessage = newMessages.at(-1)
        if (lastMessage && lastMessage.role === 'user')
          Object.assign(lastMessage, appendTextToContent(lastMessage, `\n\n${providerUserContext}`))
      }

      const providerMessagesBase = options.sendAttachmentsToProvider === false
        ? newMessages.map(message => flattenContentPartsForTextOnlyProvider(message))
        : newMessages
      const providerMessages = options.providerMessageTransform
        ? options.providerMessageTransform(providerMessagesBase as Message[])
        : providerMessagesBase

      streamingMessageContext.composedMessage = providerMessages as Message[]
      deps.onPromptProjection?.({
        sessionId,
        message: sendingMessage,
        contexts: contextsSnapshot,
        promptMessage: undefined,
        composedMessage: providerMessages as Message[],
      })
      deps.onLifecycle?.({
        phase: 'after-compose',
        channel: 'chat',
        sessionId,
        textPreview: sendingMessage,
        details: {
          composedMessage: providerMessages,
        },
      })

      await hooks.emitAfterMessageComposedHooks(sendingMessage, streamingMessageContext)
      await hooks.emitBeforeSendHooks(sendingMessage, streamingMessageContext)

      let fullText = ''
      const headers = (options.providerConfig?.headers || {}) as Record<string, string>

      if (shouldAbort())
        return

      const llmRequestStartedAt = monotonicNow()
      const llmRequestStartedWallTime = Date.now()
      let llmFirstTokenEmitted = false
      let llmFirstTokenLatencyMs: number | undefined
      deps.onLlmRequestStarted?.({
        model: options.model,
        provider: deps.getActiveProvider() || 'unknown',
        hasVoice: !!options.input,
      })
      notifyModelObserver(options.onModelRequestStarted, {
        model: options.model,
        messages: providerMessages as Message[],
        startedAt: llmRequestStartedWallTime,
      })

      try {
        await deps.llm.stream(options.model, options.chatProvider, providerMessages as Message[], {
          headers,
          tools: options.tools,
          waitForTools: true,
          maxSteps: resolveProviderMaxStreamSteps(options.providerConfig),
          captureToolErrors: true,
          onUsage: async (usage) => {
            notifyModelObserver(options.onModelUsage, usage)
          },
          onStreamEvent: async (event: StreamEvent) => {
            switch (event.type) {
              case 'tool-call':
                toolNamesByCallId.set(event.toolCallId, event.toolName)
                toolCallQueue.enqueue({
                  type: 'tool-call',
                  toolCall: event,
                })

                break
              case 'tool-result':
                toolCallQueue.enqueue({
                  type: 'tool-call-result',
                  id: event.toolCallId,
                  result: event.result,
                })
                await appendToolProgress(event.toolCallId, event.result, false)

                break
              case 'tool-error':
                toolCallQueue.enqueue({
                  type: 'tool-call-result',
                  id: event.toolCallId,
                  isError: true,
                  result: event.result,
                })
                await appendToolProgress(event.toolCallId, event.result, true)

                break
              case 'text-delta':
                if (!llmFirstTokenEmitted) {
                  llmFirstTokenEmitted = true
                  llmFirstTokenLatencyMs = Math.round(monotonicNow() - llmRequestStartedAt)
                  deps.onLlmFirstToken?.({
                    model: options.model,
                    ttfbMs: llmFirstTokenLatencyMs,
                  })
                }
                fullText += event.text
                if (!options.deferAssistantText)
                  await parser.consume(event.text)
                break
              case 'reasoning-delta': {
                if (shouldAbort())
                  return

                const { reasoning = '' } = buildingMessage.categorization ?? {}
                const nextReasoning = reasoning + event.text
                buildingMessage.categorization = {
                  speech: typeof buildingMessage.content === 'string' ? buildingMessage.content : '',
                  reasoning: nextReasoning,
                }
                const crossesBoundary
                  = Math.floor(nextReasoning.length / STREAMING_UI_FLUSH_CHUNK_SIZE)
                    > Math.floor(reasoning.length / STREAMING_UI_FLUSH_CHUNK_SIZE)
                if (!reasoning || crossesBoundary)
                  patchForegroundStream(sessionId, buildingMessage)
                break
              }
              case 'finish':
                break
              case 'error':
                throw event.error ?? new Error('Stream error')
            }
            notifyModelObserver(options.onModelStreamEvent, event)
          },
        })
        const completedAt = Date.now()
        notifyModelObserver(options.onModelRequestFinished, {
          model: options.model,
          startedAt: llmRequestStartedWallTime,
          completedAt,
          firstTokenLatencyMs: llmFirstTokenLatencyMs,
          durationMs: Math.max(0, completedAt - llmRequestStartedWallTime),
          status: 'completed',
        })
      }
      catch (error) {
        const completedAt = Date.now()
        notifyModelObserver(options.onModelRequestFinished, {
          model: options.model,
          startedAt: llmRequestStartedWallTime,
          completedAt,
          firstTokenLatencyMs: llmFirstTokenLatencyMs,
          durationMs: Math.max(0, completedAt - llmRequestStartedWallTime),
          status: 'error',
          error: errorMessageFrom(error) ?? String(error),
        })
        throw error
      }

      let visibleFullText = fullText
      if (options.assistantResponseTransform) {
        visibleFullText = await options.assistantResponseTransform({
          rawText: fullText,
          providerMessages: providerMessages as Message[],
          interaction: options.interaction,
          sessionId,
        })
      }
      if (options.deferAssistantText)
        await parser.consume(visibleFullText)
      await parser.end()
      deps.onAssistantResponseRendered?.({
        model: options.model,
        latencyMs: Math.round(monotonicNow() - llmRequestStartedAt),
      })

      const assistantTextForSuppression = typeof buildingMessage.content === 'string'
        ? buildingMessage.content
        : ''
      const suppressedAssistant = shouldSuppressAssistantText(assistantTextForSuppression, options.suppressAssistantTexts)
        || shouldSuppressAssistantText(visibleFullText, options.suppressAssistantTexts)
      if (!isStaleGeneration() && suppressedAssistant) {
        options.onAssistantSuppressed?.(assistantTextForSuppression || visibleFullText)
      }

      const finalAssistantMessages = !isStaleGeneration() && !suppressedAssistant
        ? (
            options.assistantMessageTransform
              ? options.assistantMessageTransform(cloneStreamingMessage(buildingMessage), visibleFullText)
              : [buildingMessage]
          ).filter(message => message.slices.length > 0 || getAssistantMessageText(message).trim().length > 0)
        : []

      if (finalAssistantMessages.length > 0) {
        for (const finalAssistant of finalAssistantMessages) {
          const messageText = getAssistantMessageText(finalAssistant)
          deps.session.appendSessionMessage(sessionId, finalAssistant)
          deps.onAssistantMessageAppended?.({
            sessionId,
            message: finalAssistant,
            messageText,
            interaction: options.interaction,
          })
        }
      }

      await hooks.emitStreamEndHooks(streamingMessageContext)
      if (!suppressedAssistant)
        await hooks.emitAssistantResponseEndHooks(visibleFullText, streamingMessageContext)

      await hooks.emitAfterSendHooks(sendingMessage, streamingMessageContext)
      if (!suppressedAssistant) {
        for (const finalAssistant of finalAssistantMessages) {
          const messageText = getAssistantMessageText(finalAssistant)
          await hooks.emitAssistantMessageHooks({ ...finalAssistant }, messageText, streamingMessageContext)
        }

        const turnOutput = finalAssistantMessages.at(-1) ?? buildingMessage
        const outputText = finalAssistantMessages
          .map(getAssistantVisibleText)
          .filter(text => text.trim().length > 0)
          .join('\n\n') || visibleFullText
        await hooks.emitChatTurnCompleteHooks({
          output: { ...turnOutput },
          outputText,
          toolCalls: sessionMessagesForSend.filter(msg => msg.role === 'tool') as ToolMessage[],
        }, streamingMessageContext)
      }

      if (!suppressedAssistant) {
        deps.onAssistantTurnReady?.({
          sessionId,
          messageText: finalAssistantMessages
            .map(getAssistantVisibleText)
            .filter(text => text.trim().length > 0)
            .join('\n\n') || visibleFullText,
          sessionMessages: sessionMessagesForSend,
          hasAttachments: !!options.attachments?.length,
          hiddenUserMessage: options.hiddenUserMessage,
          interaction: options.interaction,
        })
      }

      resetForegroundStream(sessionId)
      deps.onMessageRound?.({
        durationMs: Math.round(monotonicNow() - roundStartedAt),
        hasVoice: !!options.input,
        model: options.model,
      })
    }
    catch (error) {
      console.error('Error sending message:', error)
      throw error
    }
    finally {
      activeSendCount = Math.max(0, activeSendCount - 1)
      setSending(activeSendCount > 0)
      deps.onSendSettled?.({ sessionId })
    }
  }

  function createSessionSendQueue() {
    const queue = createQueue<QueuedSend>({
      handlers: [
        async ({ data }) => {
          const { sendingMessage, options, generation, deferred, sessionId, cancelled } = data

          if (cancelled)
            return

          if (deps.session.getSessionGeneration(sessionId) !== generation) {
            deferred.reject(new Error('Chat session was reset before send could start'))
            return
          }

          try {
            await performSend(sendingMessage, options, generation, sessionId)
            deferred.resolve()
          }
          catch (error) {
            deferred.reject(error)
          }
        },
      ],
    })

    queue.on('enqueue', (queuedSend) => {
      pendingQueuedSends.push(queuedSend)
      emitStateChange()
    })

    queue.on('dequeue', (queuedSend) => {
      pendingQueuedSends = pendingQueuedSends.filter(item => item !== queuedSend)
      emitStateChange()
    })

    return queue
  }

  // Conversations own independent FIFO lanes by default. Callers may bind
  // several conversations to one resource lane while a shared tool/runtime
  // still requires strict serialization.
  const sessionSendQueues = new Map<string, ReturnType<typeof createSessionSendQueue>>()

  function ingest(
    sendingMessage: string,
    options: ChatOrchestratorSendOptions,
    targetSessionId?: string,
  ) {
    const sessionId = targetSessionId || deps.getActiveSessionId()
    const generation = deps.session.getSessionGeneration(sessionId)
    const executionLane = options.executionLane?.trim() || sessionId

    return new Promise<void>((resolve, reject) => {
      let sendQueue = sessionSendQueues.get(executionLane)
      if (!sendQueue) {
        sendQueue = createSessionSendQueue()
        sessionSendQueues.set(executionLane, sendQueue)
      }
      sendQueue.enqueue({
        sendingMessage,
        options,
        generation,
        sessionId,
        deferred: { resolve, reject },
      })
    })
  }

  function cancelPendingSends(sessionId?: string) {
    for (const queued of pendingQueuedSends) {
      if (sessionId && queued.sessionId !== sessionId)
        continue

      queued.cancelled = true
      queued.deferred.reject(new Error('Chat session was reset before send could start'))
    }

    pendingQueuedSends = sessionId
      ? pendingQueuedSends.filter(item => item.sessionId !== sessionId)
      : []
    emitStateChange()
  }

  function getPendingQueuedSendSnapshot() {
    return pendingQueuedSends.map(queued => ({
      sessionId: queued.sessionId,
      generation: queued.generation,
      cancelled: !!queued.cancelled,
      messagePreview: queued.sendingMessage.slice(0, 120),
      hasAttachments: !!queued.options.attachments?.length,
      inputType: queued.options.input?.type,
    } satisfies QueuedSendSnapshot))
  }

  return {
    ingest,
    cancelPendingSends,
    getPendingQueuedSendSnapshot,
    getPendingQueuedSendCount: () => pendingQueuedSends.length,
    getSending: () => sending,
    setSending,
    hooks,
  }
}
