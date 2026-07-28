import type {
  ChatHookRegistry,
  ChatStreamEventContext,
  StreamingAssistantMessage,
} from '@proj-airi/core-agent'

type SharedRuntimeStageHookRegistry = Pick<
  ChatHookRegistry,
  | 'emitBeforeMessageComposedHooks'
  | 'emitAfterMessageComposedHooks'
  | 'emitBeforeSendHooks'
  | 'emitTokenLiteralHooks'
  | 'emitStreamEndHooks'
  | 'emitAssistantResponseEndHooks'
  | 'emitAfterSendHooks'
  | 'emitAssistantMessageHooks'
  | 'emitChatTurnCompleteHooks'
>

/** Inputs required to replay a committed shared-runtime reply through Stage integrations. */
export interface SharedRuntimeStageHookInput {
  /** Existing Stage hook registry used by TTS, animation, and transport bridges. */
  hooks: SharedRuntimeStageHookRegistry
  /** Original visible user text associated with the completed turn. */
  sourceText: string
  /** Final sanitized Lumi reply delivered by the shared runtime. */
  messageText: string
  /** Final assistant message already committed to the local session. */
  assistantMessage: StreamingAssistantMessage
  /** Creates a detached context so transport completion cannot be polluted by UI hooks. */
  createContext: () => ChatStreamEventContext
  /** Receives isolated hook failures without aborting the remaining delivery stages. */
  onError: (stage: string, error: unknown) => void
}

/**
 * Replays a committed shared-runtime reply through legacy Stage hooks.
 *
 * Use when:
 * - The platform-neutral runtime has already persisted and displayed a reply
 * - Stage still owns TTS, Live2D, renderer broadcasts, and external completion
 *
 * Expects:
 * - `assistantMessage` and `messageText` describe the same committed reply
 * - `createContext` returns a transport-safe detached value
 *
 * Returns:
 * - Resolves after every hook stage has run or reported an isolated failure
 */
export async function replaySharedRuntimeStageHooks(input: SharedRuntimeStageHookInput): Promise<void> {
  async function run(stage: string, callback: () => Promise<void>): Promise<void> {
    try {
      await callback()
    }
    catch (error) {
      input.onError(stage, error)
    }
  }

  // Remote callers must receive the authoritative completion before local
  // speech synthesis, motion, or renderer work can block or fail.
  await run('chat-turn-complete', async () =>
    await input.hooks.emitChatTurnCompleteHooks({
      output: input.assistantMessage,
      outputText: input.messageText,
      toolCalls: [],
    }, input.createContext()))

  const context = input.createContext()
  await run('before-message-composed', async () =>
    await input.hooks.emitBeforeMessageComposedHooks(input.sourceText, context))
  await run('after-message-composed', async () =>
    await input.hooks.emitAfterMessageComposedHooks(input.sourceText, context))
  await run('before-send', async () =>
    await input.hooks.emitBeforeSendHooks(input.sourceText, context))
  await run('token-literal', async () =>
    await input.hooks.emitTokenLiteralHooks(input.messageText, context))
  await run('stream-end', async () =>
    await input.hooks.emitStreamEndHooks(context))
  await run('assistant-response-end', async () =>
    await input.hooks.emitAssistantResponseEndHooks(input.messageText, context))
  await run('after-send', async () =>
    await input.hooks.emitAfterSendHooks(input.sourceText, context))
  await run('assistant-message', async () =>
    await input.hooks.emitAssistantMessageHooks(
      input.assistantMessage,
      input.messageText,
      context,
    ))
}
