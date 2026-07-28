import type { ChatStreamEventContext, StreamingAssistantMessage } from '@proj-airi/core-agent'

import { createChatHooks } from '@proj-airi/core-agent'
import { describe, expect, it, vi } from 'vitest'

import { replaySharedRuntimeStageHooks } from './shared-runtime-stage-hooks'

function createContext(): ChatStreamEventContext {
  return {
    message: {
      role: 'user',
      content: 'hello',
      id: 'user-1',
    },
    contexts: {},
    composedMessage: [],
  }
}

const assistantMessage: StreamingAssistantMessage = {
  role: 'assistant',
  content: 'reply',
  id: 'assistant-1',
  slices: [{ type: 'text', text: 'reply' }],
  tool_results: [],
}

/**
 * @example
 * describe('replaySharedRuntimeStageHooks', () => {
 *   it('delivers completion before fallible device hooks', () => {})
 * })
 */
describe('replaySharedRuntimeStageHooks', () => {
  /**
   * @example
   * it('delivers completion before fallible device hooks', () => {
   *   expect(order[0]).toBe('complete')
   * })
   */
  it('delivers transport completion before a fallible device hook and continues later stages', async () => {
    const hooks = createChatHooks()
    const order: string[] = []
    const onError = vi.fn()

    hooks.onChatTurnComplete(async () => {
      order.push('complete')
    })
    hooks.onBeforeMessageComposed(async () => {
      order.push('before-compose')
      throw new Error('TTS initialization failed')
    })
    hooks.onAfterMessageComposed(async () => {
      order.push('after-compose')
    })

    await replaySharedRuntimeStageHooks({
      hooks,
      sourceText: 'hello',
      messageText: 'reply',
      assistantMessage,
      createContext,
      onError,
    })

    expect(order).toEqual(['complete', 'before-compose', 'after-compose'])
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith('before-message-composed', expect.any(Error))
  })
})
