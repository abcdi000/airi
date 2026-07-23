import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message } from '@xsai/shared-chat'

import type { ChatHistoryItem, ChatInteractionContext, ContextMessage, StreamingAssistantMessage } from '../types/chat'
import type { StreamEvent, StreamOptions } from '../types/llm'

import { ContextUpdateStrategy } from '@proj-airi/server-shared/types'
import { describe, expect, it, vi } from 'vitest'

import { createChatOrchestratorRuntime } from './chat-orchestrator-runtime'

const provider = {
  chat: () => ({ baseURL: 'https://example.com/' }),
} as unknown as ChatProvider

type Awaitable<T> = T | Promise<T>

function createHarness(options: {
  runtimeContextProviders?: Array<(event: { messageText: string, sessionId: string, interaction?: ChatInteractionContext }) => Awaitable<ContextMessage | null | undefined>>
  onUserTurnReady?: (event: { sessionId: string, messageText: string, sessionMessages: ChatHistoryItem[], hasAttachments: boolean }) => Awaitable<void>
} = {}) {
  const sessionMessages: Record<string, ChatHistoryItem[]> = {
    'session-1': [
      {
        role: 'system',
        content: 'system prompt',
        createdAt: new Date(2026, 3, 25, 18, 0).getTime(),
        id: 'system',
      },
    ],
  }
  const contextSnapshot: Record<string, ContextMessage[]> = {}
  const contextIngested: ContextMessage[] = []
  const foregroundPatches: StreamingAssistantMessage[] = []
  const foregroundResets: StreamingAssistantMessage[] = []
  const lifecycleRecords: unknown[] = []
  const promptProjections: unknown[] = []
  const userAppended: unknown[] = []
  const assistantAppended: unknown[] = []
  const userTurns: unknown[] = []
  const assistantTurns: unknown[] = []
  const stateChanges: unknown[] = []
  const telemetry = {
    messageSendStarted: [] as unknown[],
    llmRequestStarted: [] as unknown[],
    llmFirstToken: [] as unknown[],
    assistantResponseRendered: [] as unknown[],
    messageRound: [] as unknown[],
  }
  const stream = vi.fn(async (_model: string, _chatProvider: ChatProvider, _messages: Message[], options?: StreamOptions) => {
    await options?.onStreamEvent?.({ type: 'text-delta', text: 'assistant reply' })
    await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
  })
  const ids = ['stream-context', 'assistant-id', 'user-id', 'fallback-id']
  let systemPromptSupplement: string | undefined
  let nowValue = new Date(2026, 3, 25, 18, 47).getTime()
  let monotonicNowValues = [1000]
  let generation = 1

  const runtime = createChatOrchestratorRuntime({
    session: {
      ensureSession: (sessionId) => {
        sessionMessages[sessionId] ??= []
      },
      getSessionMessages: sessionId => sessionMessages[sessionId] ?? [],
      appendSessionMessage: (sessionId, message) => {
        sessionMessages[sessionId] ??= []
        sessionMessages[sessionId].push(message)
      },
      getSessionGeneration: () => generation,
    },
    context: {
      ingest: (message) => {
        contextIngested.push(message)
        const sourceKey = (message as ContextMessage & { source?: string }).source ?? 'unknown'
        contextSnapshot[sourceKey] = message.strategy === ContextUpdateStrategy.AppendSelf
          ? [...(contextSnapshot[sourceKey] ?? []), structuredClone(message)]
          : [structuredClone(message)]
      },
      snapshot: () => structuredClone(contextSnapshot),
    },
    foregroundStream: {
      patch: message => foregroundPatches.push(message),
      reset: () => foregroundResets.push({ role: 'assistant', content: '', slices: [], tool_results: [] }),
    },
    llm: {
      stream,
    },
    getActiveSessionId: () => 'session-1',
    getActiveProvider: () => 'mock-provider',
    getSystemPromptSupplement: () => systemPromptSupplement,
    runtimeContextProviders: options.runtimeContextProviders,
    now: () => nowValue,
    monotonicNow: () => monotonicNowValues.shift() ?? 1000,
    createId: () => ids.shift() ?? 'generated-id',
    onLifecycle: record => lifecycleRecords.push(record),
    onPromptProjection: payload => promptProjections.push(payload),
    onUserMessageAppended: event => userAppended.push(event),
    onAssistantMessageAppended: event => assistantAppended.push(event),
    onUserTurnReady: async (event) => {
      userTurns.push(event)
      await options.onUserTurnReady?.(event)
    },
    onAssistantTurnReady: event => assistantTurns.push(event),
    onStateChange: state => stateChanges.push(state),
    onMessageSendStarted: event => telemetry.messageSendStarted.push(event),
    onLlmRequestStarted: event => telemetry.llmRequestStarted.push(event),
    onLlmFirstToken: event => telemetry.llmFirstToken.push(event),
    onAssistantResponseRendered: event => telemetry.assistantResponseRendered.push(event),
    onMessageRound: event => telemetry.messageRound.push(event),
  })

  return {
    assistantAppended,
    assistantTurns,
    contextSnapshot,
    contextIngested,
    foregroundPatches,
    foregroundResets,
    generation: {
      set: (next: number) => {
        generation = next
      },
    },
    lifecycleRecords,
    now: {
      set: (next: number) => {
        nowValue = next
      },
    },
    monotonicNow: {
      set: (next: number[]) => {
        monotonicNowValues = [...next]
      },
    },
    promptProjections,
    runtime,
    sessionMessages,
    stateChanges,
    stream,
    systemPromptSupplement: {
      set: (next: string | undefined) => {
        systemPromptSupplement = next
      },
    },
    telemetry,
    userAppended,
    userTurns,
  }
}

/**
 * @example
 * const runtime = createChatOrchestratorRuntime(deps)
 * await runtime.ingest('hello', { model, chatProvider })
 */
describe('createChatOrchestratorRuntime', () => {
  /**
   * @example
   * Hook order and prompt composition stay compatible with the stage-ui facade.
   */
  it('keeps hook order and appends context prompt to the latest user message', async () => {
    const harness = createHarness()
    harness.contextSnapshot['system:weather'] = [
      {
        id: 'weather',
        contextId: 'system:weather',
        strategy: ContextUpdateStrategy.ReplaceSelf,
        text: 'sunny',
        createdAt: 1,
      },
    ]
    const hookOrder: string[] = []
    let composedMessages: Message[] = []

    harness.runtime.hooks.onBeforeMessageComposed(async () => {
      hookOrder.push('before-compose')
    })
    harness.runtime.hooks.onAfterMessageComposed(async () => {
      hookOrder.push('after-compose')
    })
    harness.runtime.hooks.onBeforeSend(async () => {
      hookOrder.push('before-send')
    })
    harness.runtime.hooks.onTokenLiteral(async () => {
      hookOrder.push('token-literal')
    })
    harness.runtime.hooks.onStreamEnd(async () => {
      hookOrder.push('stream-end')
    })
    harness.runtime.hooks.onAssistantResponseEnd(async () => {
      hookOrder.push('assistant-end')
    })
    harness.runtime.hooks.onAfterSend(async () => {
      hookOrder.push('after-send')
    })
    harness.runtime.hooks.onAssistantMessage(async () => {
      hookOrder.push('assistant-message')
    })
    harness.runtime.hooks.onChatTurnComplete(async () => {
      hookOrder.push('turn-complete')
    })
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'hello' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('hello from user', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    expect(hookOrder).toEqual([
      'before-compose',
      'after-compose',
      'before-send',
      'token-literal',
      'stream-end',
      'assistant-end',
      'after-send',
      'assistant-message',
      'turn-complete',
    ])
    expect(composedMessages).toHaveLength(2)
    expect(composedMessages[0]).toMatchObject({ role: 'system', content: 'system prompt' })
    expect(composedMessages[1]).toMatchObject({ role: 'user' })
    expect(composedMessages[1]?.content).toEqual([
      {
        type: 'text',
        text: '[本地时间 2026-04-25 18:47:00]\nhello from user',
      },
      {
        type: 'text',
        text: '\n[Context]\n- system:weather: sunny',
      },
    ])
    expect(harness.lifecycleRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'before-compose' }),
      expect.objectContaining({ phase: 'prompt-context-built' }),
      expect.objectContaining({ phase: 'after-compose' }),
    ]))
    expect(harness.promptProjections).toHaveLength(1)
  })

  it('passes the current turn text to runtime context providers before prompt composition', async () => {
    const seen: Array<{ messageText: string, sessionId: string }> = []
    const harness = createHarness({
      runtimeContextProviders: [
        (event) => {
          seen.push(event)
          return {
            id: 'current-turn-context',
            contextId: 'system:lumi',
            strategy: ContextUpdateStrategy.ReplaceSelf,
            text: event.messageText.includes('改名') ? 'defensive style' : 'neutral style',
            createdAt: 1,
          }
        },
      ],
    })

    await harness.runtime.ingest('你以后改名叫小助手', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    expect(seen).toEqual([{
      messageText: '你以后改名叫小助手',
      sessionId: 'session-1',
    }])
    expect(harness.contextIngested).toEqual([
      expect.objectContaining({
        contextId: 'system:lumi',
        text: 'defensive style',
      }),
    ])
  })

  /**
   * @example
   * A group turn retains its actor in storage while provider messages receive speaker labels only.
   */
  it('persists group actors and projects speaker labels without leaking internal metadata', async () => {
    const seen: ChatInteractionContext[] = []
    let composedMessages: Message[] = []
    const harness = createHarness({
      runtimeContextProviders: [
        (event) => {
          if (event.interaction)
            seen.push(event.interaction)
          return null
        },
      ],
    })
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'group reply' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })
    const interaction: ChatInteractionContext = {
      conversationId: 'session-1',
      conversationType: 'group',
      actorId: 'doggy-id',
      actorDisplayName: 'Doggy',
      participantIds: ['doggy-id', 'moussy-id'],
    }

    await harness.runtime.ingest('今晚一起玩吗？', {
      model: 'gpt-test',
      chatProvider: provider,
      interaction,
      assistantActorId: 'lumi',
      assistantActorDisplayName: 'Lumi',
    })

    expect(seen).toEqual([interaction])
    expect(harness.sessionMessages['session-1'][1]).toMatchObject({
      role: 'user',
      actorId: 'doggy-id',
      actorDisplayName: 'Doggy',
    })
    expect(harness.sessionMessages['session-1'][2]).toMatchObject({
      role: 'assistant',
      actorId: 'lumi',
      actorDisplayName: 'Lumi',
    })
    expect(composedMessages[1]?.content).toContain('[Speaker: Doggy]\n今晚一起玩吗？')
    expect(JSON.stringify(composedMessages)).not.toContain('actorId')
  })

  it('passes provider maxToolSteps to the LLM stream for long tool workflows', async () => {
    const harness = createHarness()

    await harness.runtime.ingest('帮我把浏览器任务做完', {
      model: 'gpt-test',
      chatProvider: provider,
      providerConfig: {
        maxToolSteps: 48,
      },
    })

    expect(harness.stream.mock.calls[0]?.[3]).toEqual(expect.objectContaining({
      maxSteps: 48,
      waitForTools: true,
    }))
  })

  it('awaits user-turn preparation before ingesting async runtime context providers', async () => {
    const order: string[] = []
    let preparedTopic = 'not-ready'
    const harness = createHarness({
      onUserTurnReady: async (event) => {
        order.push(`turn:${event.sessionMessages.at(-1)?.role}`)
        await Promise.resolve()
        preparedTopic = event.messageText.includes('entity') ? 'Backrooms entity topic' : 'generic topic'
      },
      runtimeContextProviders: [
        async () => {
          order.push(`provider:${preparedTopic}`)
          await Promise.resolve()
          return {
            id: 'async-topic-context',
            contextId: 'system:lumi',
            strategy: ContextUpdateStrategy.ReplaceSelf,
            text: preparedTopic,
            createdAt: 1,
          }
        },
      ],
    })

    await harness.runtime.ingest('favorite entity?', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    expect(order).toEqual(['turn:user', 'provider:Backrooms entity topic'])
    expect(harness.contextIngested).toEqual([
      expect.objectContaining({
        contextId: 'system:lumi',
        text: 'Backrooms entity topic',
      }),
    ])
  })

  /**
   * @example
   * deps.getSystemPromptSupplement() returns tool guidance.
   * The runtime appends it to the existing provider system message.
   */
  it('appends system prompt supplement to the provider system message', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    harness.systemPromptSupplement.set('Plugin toolset guidance.')
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'hello' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('hello from user', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    expect(composedMessages[0]).toMatchObject({
      role: 'system',
      content: 'system prompt\n\nPlugin toolset guidance.',
    })
  })

  it('applies provider message transform without mutating persisted history', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    harness.sessionMessages['session-1']?.push({
      role: 'assistant',
      content: 'old bad style',
      slices: [{ type: 'text', text: 'old bad style' }],
      tool_results: [],
      createdAt: new Date(2026, 3, 25, 18, 10).getTime(),
      id: 'assistant-history',
    })
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'reply' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('next turn', {
      model: 'gpt-test',
      chatProvider: provider,
      providerMessageTransform: messages => messages.map(message =>
        message.role === 'assistant'
          ? { ...message, content: 'sanitized provider style' }
          : message,
      ),
    })

    expect(composedMessages[1]).toMatchObject({
      role: 'assistant',
      content: 'sanitized provider style',
    })
    expect(harness.sessionMessages['session-1']?.[1]).toMatchObject({
      role: 'assistant',
      content: 'old bad style',
    })
  })

  it('sends hidden user input to the provider without appending a visible user message', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'I noticed the screen.' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('hidden screen observation', {
      model: 'gpt-test',
      chatProvider: provider,
      hiddenUserMessage: true,
    })

    expect(composedMessages.at(-1)).toMatchObject({
      role: 'user',
      content: '[本地时间 2026-04-25 18:47:00]\nhidden screen observation',
    })
    expect(harness.userAppended).toHaveLength(0)
    expect(harness.userTurns).toHaveLength(0)
    expect(harness.sessionMessages['session-1']).toEqual([
      expect.objectContaining({ role: 'system' }),
      expect.objectContaining({ role: 'assistant', content: 'I noticed the screen.' }),
    ])
    expect(harness.assistantTurns[0]).toMatchObject({ hiddenUserMessage: true })
  })

  it('suppresses configured assistant silence markers', async () => {
    const harness = createHarness()
    const onAssistantSuppressed = vi.fn()
    const literalHook = vi.fn()
    const assistantEndHook = vi.fn()
    const assistantMessageHook = vi.fn()
    const turnCompleteHook = vi.fn()
    harness.runtime.hooks.onTokenLiteral(literalHook)
    harness.runtime.hooks.onAssistantResponseEnd(assistantEndHook)
    harness.runtime.hooks.onAssistantMessage(assistantMessageHook)
    harness.runtime.hooks.onChatTurnComplete(turnCompleteHook)
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, _messages, options) => {
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'lumi\u62D2' })
      await options?.onStreamEvent?.({ type: 'text-delta', text: '\u7EDD\u56DE\u590D' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('hidden screen observation', {
      model: 'gpt-test',
      chatProvider: provider,
      hiddenUserMessage: true,
      suppressAssistantTexts: ['lumi\u62D2\u7EDD\u56DE\u590D'],
      onAssistantSuppressed,
    })

    expect(harness.userAppended).toHaveLength(0)
    expect(harness.assistantAppended).toHaveLength(0)
    expect(harness.assistantTurns).toHaveLength(0)
    expect(onAssistantSuppressed).toHaveBeenCalledOnce()
    expect(onAssistantSuppressed).toHaveBeenCalledWith('lumi\u62D2\u7EDD\u56DE\u590D')
    expect(literalHook).not.toHaveBeenCalled()
    expect(assistantEndHook).not.toHaveBeenCalled()
    expect(assistantMessageHook).not.toHaveBeenCalled()
    expect(turnCompleteHook).not.toHaveBeenCalled()
    expect(harness.sessionMessages['session-1']).toEqual([
      expect.objectContaining({ role: 'system' }),
    ])
  })

  it('releases a buffered suppression prefix as soon as normal speech diverges', async () => {
    const harness = createHarness()
    const literals: string[] = []
    harness.runtime.hooks.onTokenLiteral(async (literal) => {
      literals.push(literal)
    })
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, _messages, options) => {
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'lumi\u62D2' })
      await options?.onStreamEvent?.({ type: 'text-delta', text: '\u7EDD\u56DE\u4FE1\uFF0C\u8FD9\u662F\u6B63\u5E38\u56DE\u590D' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('visible user message', {
      model: 'gpt-test',
      chatProvider: provider,
      suppressAssistantTexts: ['lumi\u62D2\u7EDD\u56DE\u590D'],
    })

    expect(literals.join('')).toBe('lumi\u62D2\u7EDD\u56DE\u4FE1\uFF0C\u8FD9\u662F\u6B63\u5E38\u56DE\u590D')
    expect(harness.assistantAppended).toHaveLength(1)
  })
  it('applies assistant speech transform to final content and slices', async () => {
    const harness = createHarness()
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, _messages, options) => {
      await options?.onStreamEvent?.({ type: 'reasoning-delta', text: 'private thought' })
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'bad visible speech' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('next turn', {
      model: 'gpt-test',
      chatProvider: provider,
      assistantSpeechTransform: speech => speech.replace('bad', 'clean'),
    })

    const assistant = harness.sessionMessages['session-1']?.at(-1) as StreamingAssistantMessage
    expect(assistant.content).toBe('clean visible speech')
    expect(assistant.slices).toEqual([{ type: 'text', text: 'clean visible speech' }])
    expect(assistant.categorization).toEqual({
      speech: 'clean visible speech',
      reasoning: 'private thought',
    })
  })

  it('can project one assistant turn into multiple persisted assistant messages', async () => {
    const harness = createHarness()
    const assistantMessageHook = vi.fn()
    const turnCompleteHook = vi.fn()
    harness.runtime.hooks.onAssistantMessage(assistantMessageHook)
    harness.runtime.hooks.onChatTurnComplete(turnCompleteHook)
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, _messages, options) => {
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'first reply\n\nsecond reply' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('next turn', {
      model: 'gpt-test',
      chatProvider: provider,
      assistantMessageTransform: message => [
        {
          ...message,
          id: 'assistant-first',
          content: 'first reply',
          slices: [{ type: 'text', text: 'first reply' }],
        },
        {
          ...message,
          id: 'assistant-second',
          content: 'second reply',
          slices: [{ type: 'text', text: 'second reply' }],
          tool_results: [],
        },
      ],
    })

    expect(harness.assistantAppended).toHaveLength(2)
    expect(harness.sessionMessages['session-1']).toEqual([
      expect.objectContaining({ role: 'system' }),
      expect.objectContaining({ role: 'user', content: 'next turn' }),
      expect.objectContaining({ role: 'assistant', content: 'first reply', id: 'assistant-first' }),
      expect.objectContaining({ role: 'assistant', content: 'second reply', id: 'assistant-second' }),
    ])
    expect(assistantMessageHook).toHaveBeenCalledTimes(2)
    expect(turnCompleteHook).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({ content: 'second reply' }),
        outputText: 'first reply\n\nsecond reply',
      }),
      expect.anything(),
    )
    expect(harness.assistantTurns[0]).toMatchObject({
      messageText: 'first reply\n\nsecond reply',
    })
  })

  /**
   * @example
   * A session has only user history.
   * The runtime creates a provider system message for supplemental guidance.
   */
  it('creates a system message when only a system prompt supplement is available', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    harness.sessionMessages['session-1'] = []
    harness.systemPromptSupplement.set('Plugin toolset guidance.')
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'hello' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('hello from user', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    expect(composedMessages[0]).toMatchObject({
      role: 'system',
      content: 'Plugin toolset guidance.',
    })
    expect(composedMessages[1]).toMatchObject({ role: 'user' })
  })

  it('applies the provider history boundary before composing a prompt', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    harness.sessionMessages['session-1']?.push(
      { role: 'user', content: 'old task' },
      { role: 'assistant', content: 'old desktop result', slices: [], tool_results: [] },
    )
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'new reply' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('new task', {
      model: 'gpt-test',
      chatProvider: provider,
      providerHistoryTransform: messages => [messages[0]!, messages.at(-1)!],
    })

    expect(composedMessages).toEqual([
      expect.objectContaining({ role: 'system', content: 'system prompt' }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('new task') }),
    ])
  })

  /**
   * @example
   * Runtime telemetry callbacks expose client-visible latency milestones.
   */
  it('emits telemetry milestones for a successful voice-backed message round', async () => {
    const harness = createHarness()
    harness.monotonicNow.set([100, 150, 250, 400, 460])

    await harness.runtime.ingest('hello from voice', {
      model: 'gpt-test',
      chatProvider: provider,
      input: {
        type: 'input:text',
        data: {
          text: 'hello from voice',
        },
      },
    })

    expect(harness.telemetry.messageSendStarted).toEqual([{
      source: 'voice',
      model: 'gpt-test',
    }])
    expect(harness.telemetry.llmRequestStarted).toEqual([{
      model: 'gpt-test',
      provider: 'mock-provider',
      hasVoice: true,
    }])
    expect(harness.telemetry.llmFirstToken).toEqual([{
      model: 'gpt-test',
      ttfbMs: 100,
    }])
    expect(harness.telemetry.assistantResponseRendered).toEqual([{
      model: 'gpt-test',
      latencyMs: 250,
    }])
    expect(harness.telemetry.messageRound).toEqual([{
      durationMs: 360,
      hasVoice: true,
      model: 'gpt-test',
    }])
  })

  /**
   * @example
   * Cancelling a queued send rejects only pending work that has not started.
   */
  it('rejects cancelled queued sends before they start', async () => {
    const harness = createHarness()
    let releaseFirstSend: (() => void) | undefined
    harness.stream.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstSend = resolve
      })
    })

    const firstSend = harness.runtime.ingest('hold queue', {
      model: 'gpt-test',
      chatProvider: provider,
    })
    const secondSend = harness.runtime.ingest('cancel me', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    await vi.waitFor(() => {
      expect(harness.stream).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(harness.runtime.getPendingQueuedSendCount()).toBe(1)
    })
    harness.runtime.cancelPendingSends('session-1')
    releaseFirstSend?.()

    await expect(secondSend).rejects.toThrow('Chat session was reset before send could start')
    await firstSend
  })

  /**
   * @example
   * A queued send rejects if its captured session generation becomes stale.
   */
  it('rejects stale generation sends before they start', async () => {
    const harness = createHarness()
    let releaseFirstSend: (() => void) | undefined
    harness.stream.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstSend = resolve
      })
    })

    const firstSend = harness.runtime.ingest('hold queue', {
      model: 'gpt-test',
      chatProvider: provider,
    })
    const secondSend = harness.runtime.ingest('stale request', {
      model: 'gpt-test',
      chatProvider: provider,
    })

    await vi.waitFor(() => {
      expect(harness.stream).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(harness.runtime.getPendingQueuedSendCount()).toBe(1)
    })
    harness.generation.set(2)
    releaseFirstSend?.()

    await firstSend
    await expect(secondSend).rejects.toThrow('Chat session was reset before send could start')
    expect(harness.stream).toHaveBeenCalledTimes(1)
  })

  /**
   * @example
   * Session A and session B may stream concurrently while each session keeps its own FIFO queue.
   */
  it('runs different sessions concurrently and remains sending until every active turn settles', async () => {
    const harness = createHarness()
    const releases: Array<() => void> = []
    harness.stream.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        releases.push(resolve)
      })
    })

    const firstSend = harness.runtime.ingest('session one', {
      model: 'gpt-test',
      chatProvider: provider,
    }, 'session-1')
    await vi.waitFor(() => {
      expect(harness.stream).toHaveBeenCalledTimes(1)
    })

    const secondSend = harness.runtime.ingest('session two', {
      model: 'gpt-test',
      chatProvider: provider,
    }, 'session-2')
    await vi.waitFor(() => {
      expect(harness.stream).toHaveBeenCalledTimes(2)
    })

    expect(harness.runtime.getPendingQueuedSendCount()).toBe(0)
    expect(harness.runtime.getSending()).toBe(true)

    releases[1]?.()
    await secondSend
    expect(harness.runtime.getSending()).toBe(true)

    releases[0]?.()
    await firstSend
    expect(harness.runtime.getSending()).toBe(false)
  })

  /**
   * @example
   * Two sessions sharing a tool runtime use one explicit FIFO execution lane.
   */
  it('serializes different sessions assigned to the same execution lane', async () => {
    const harness = createHarness()
    let releaseFirstSend: (() => void) | undefined
    harness.stream.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstSend = resolve
      })
    })
    const options = {
      model: 'gpt-test',
      chatProvider: provider,
      executionLane: 'shared-consciousness',
    }

    const firstSend = harness.runtime.ingest('first', options, 'session-1')
    const secondSend = harness.runtime.ingest('second', options, 'session-2')
    await vi.waitFor(() => {
      expect(harness.stream).toHaveBeenCalledTimes(1)
      expect(harness.runtime.getPendingQueuedSendCount()).toBe(1)
    })

    releaseFirstSend?.()
    await Promise.all([firstSend, secondSend])
    expect(harness.stream).toHaveBeenCalledTimes(2)
  })

  /**
   * @example
   * Concurrent turns replace the same context source without reading each other's turn-local value.
   */
  it('keeps runtime context prompt snapshots isolated across concurrent sessions', async () => {
    const harness = createHarness({
      runtimeContextProviders: [event => ({
        id: `context-${event.sessionId}`,
        source: 'turn-context',
        contextId: 'system:turn',
        strategy: ContextUpdateStrategy.ReplaceSelf,
        text: `private context for ${event.sessionId}`,
        createdAt: 1,
      })],
    })
    let hookArrivals = 0
    let releaseHooks: (() => void) | undefined
    const hooksReady = new Promise<void>((resolve) => {
      releaseHooks = resolve
    })
    harness.runtime.hooks.onBeforeMessageComposed(async () => {
      hookArrivals += 1
      if (hookArrivals === 2)
        releaseHooks?.()
      await hooksReady
    })

    const firstSend = harness.runtime.ingest('first', {
      model: 'gpt-test',
      chatProvider: provider,
    }, 'session-1')
    const secondSend = harness.runtime.ingest('second', {
      model: 'gpt-test',
      chatProvider: provider,
    }, 'session-2')
    await Promise.all([firstSend, secondSend])

    const promptBySession = new Map(harness.promptProjections.map((projection) => {
      const record = projection as { sessionId: string, contexts: Record<string, ContextMessage[]> }
      return [record.sessionId, JSON.stringify(record.contexts)]
    }))
    expect(promptBySession.get('session-1')).toContain('private context for session-1')
    expect(promptBySession.get('session-1')).not.toContain('private context for session-2')
    expect(promptBySession.get('session-2')).toContain('private context for session-2')
    expect(promptBySession.get('session-2')).not.toContain('private context for session-1')
  })

  /**
   * @example
   * runtime.setSending(true)
   * expect(runtime.getSending()).toBe(true)
   */
  it('keeps sending externally writable for UI facades', () => {
    const harness = createHarness()

    harness.runtime.setSending(true)
    expect(harness.runtime.getSending()).toBe(true)
    expect(harness.stateChanges.at(-1)).toEqual({
      sending: true,
      pendingQueuedSendCount: 0,
    })

    harness.runtime.setSending(false)
    expect(harness.runtime.getSending()).toBe(false)
    expect(harness.stateChanges.at(-1)).toEqual({
      sending: false,
      pendingQueuedSendCount: 0,
    })
  })

  /**
   * @example
   * const snapshot = runtime.getPendingQueuedSendSnapshot()
   * expect(snapshot[0].inputType).toBe('input:text')
   */
  it('returns pending queued send snapshots with public fields', async () => {
    const harness = createHarness()
    let releaseFirstSend: (() => void) | undefined
    harness.stream.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        releaseFirstSend = resolve
      })
    })

    const queuedMessage = 'queued-message-'.repeat(12)
    const firstSend = harness.runtime.ingest('hold queue', {
      model: 'gpt-test',
      chatProvider: provider,
    })
    const secondSend = harness.runtime.ingest(queuedMessage, {
      model: 'gpt-test',
      chatProvider: provider,
      attachments: [
        {
          type: 'image',
          data: 'aW1hZ2U=',
          mimeType: 'image/png',
        },
      ],
      input: {
        type: 'input:text',
        data: {
          text: 'queued input',
        },
      },
    })

    await vi.waitFor(() => {
      expect(harness.stream).toHaveBeenCalledTimes(1)
    })
    await vi.waitFor(() => {
      expect(harness.runtime.getPendingQueuedSendCount()).toBe(1)
    })

    expect(harness.runtime.getPendingQueuedSendSnapshot()).toEqual([
      {
        sessionId: 'session-1',
        generation: 1,
        cancelled: false,
        messagePreview: queuedMessage.slice(0, 120),
        hasAttachments: true,
        inputType: 'input:text',
      },
    ])

    harness.runtime.cancelPendingSends('session-1')
    releaseFirstSend?.()

    await expect(secondSend).rejects.toThrow('Chat session was reset before send could start')
    await firstSend
  })

  /**
   * @example
   * Attachments, reasoning deltas, and tool events update the assistant builder.
   */
  it('handles attachments, reasoning deltas, tool events, and assistant finalization', async () => {
    const harness = createHarness()
    let composedMessages: Message[] = []
    harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
      composedMessages = messages
      await options?.onStreamEvent?.({ type: 'reasoning-delta', text: 'thinking' })
      await options?.onStreamEvent?.({
        type: 'tool-call',
        toolCallId: 'tool-1',
        toolName: 'weather',
        args: {},
      } as StreamEvent)
      await options?.onStreamEvent?.({
        type: 'tool-result',
        toolCallId: 'tool-1',
        result: 'sunny',
      } as StreamEvent)
      await options?.onStreamEvent?.({ type: 'text-delta', text: 'visible reply' })
      await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
    })

    await harness.runtime.ingest('see image', {
      model: 'gpt-test',
      chatProvider: provider,
      attachments: [
        {
          type: 'image',
          data: 'aW1hZ2U=',
          mimeType: 'image/png',
        },
      ],
    })

    expect(composedMessages[1]?.content).toEqual([
      {
        type: 'text',
        text: '[本地时间 2026-04-25 18:47:00]\nsee image',
      },
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,aW1hZ2U=',
        },
      },
    ])
    const assistant = harness.sessionMessages['session-1']?.at(-1)
    expect(assistant).toMatchObject({
      role: 'assistant',
      content: 'visible reply',
      categorization: {
        reasoning: 'thinking',
      },
    })
    expect((assistant as StreamingAssistantMessage).slices).toEqual([
      expect.objectContaining({
        type: 'tool-call',
        toolCall: expect.objectContaining({
          toolCallId: 'tool-1',
        }),
      }),
      {
        type: 'text',
        text: 'visible reply',
      },
    ])
    expect((assistant as StreamingAssistantMessage).tool_results).toEqual([
      {
        type: 'tool-call-result',
        id: 'tool-1',
        result: 'sunny',
      },
    ])
    expect(harness.assistantAppended).toHaveLength(1)
    expect(harness.foregroundResets).toHaveLength(1)
  })
})

it('streams confirmed tool progress into the ordinary assistant message', async () => {
  const harness = createHarness()
  harness.stream.mockImplementationOnce(async (_model, _chatProvider, _messages, options) => {
    await options?.onStreamEvent?.({
      type: 'tool-call',
      toolCallId: 'computer-use-1',
      toolName: 'mcp_computer_use_desktop_focus_app',
      args: { app: 'QQ' },
    } as StreamEvent)
    await options?.onStreamEvent?.({
      type: 'tool-result',
      toolCallId: 'computer-use-1',
      result: { status: 'executed' },
    } as StreamEvent)
    await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
  })

  await harness.runtime.ingest('focus QQ', {
    model: 'gpt-test',
    chatProvider: provider,
    toolResultTextTransform: ({ toolName, isError }) => toolName === 'mcp_computer_use_desktop_focus_app' && !isError
      ? '已完成：聚焦目标应用。'
      : undefined,
  })

  expect(harness.foregroundPatches.some(message => message.content === '已完成：聚焦目标应用。')).toBe(true)
  expect(harness.sessionMessages['session-1']?.at(-1)).toMatchObject({
    role: 'assistant',
    content: '已完成：聚焦目标应用。',
  })
})

it('keeps image attachments in chat history while sending text-only provider context', async () => {
  const harness = createHarness()
  let composedMessages: Message[] = []
  harness.stream.mockImplementationOnce(async (_model, _chatProvider, messages, options) => {
    composedMessages = messages
    await options?.onStreamEvent?.({ type: 'text-delta', text: 'reply' })
    await options?.onStreamEvent?.({ type: 'finish', finishReason: 'stop' })
  })

  await harness.runtime.ingest('see image', {
    model: 'gpt-test',
    chatProvider: provider,
    attachments: [
      {
        type: 'image',
        data: 'aW1hZ2U=',
        mimeType: 'image/png',
      },
    ],
    providerUserContext: '[Current-turn image context]\nImage 1: description=a UI screenshot',
    sendAttachmentsToProvider: false,
  })

  const userMessage = harness.sessionMessages['session-1']?.find(message => message.role === 'user')
  expect(userMessage?.content).toEqual([
    {
      type: 'text',
      text: 'see image',
    },
    {
      type: 'image_url',
      image_url: {
        url: 'data:image/png;base64,aW1hZ2U=',
      },
    },
  ])
  expect(composedMessages[1]?.content).toBe('[本地时间 2026-04-25 18:47:00]\nsee image\n\n[Current-turn image context]\nImage 1: description=a UI screenshot')
})
