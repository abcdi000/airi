import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'

import { toStructuredCloneSnapshot } from './structured-clone'

describe('structured clone snapshot', () => {
  /**
   * @example
   * Agent Runtime completion hooks can transport messages read from reactive Pinia sessions.
   */
  it('projects nested Vue proxies into a detached clone-safe data graph', () => {
    // ROOT CAUSE:
    //
    // Shared Agent Runtime hooks reused reactive session messages. The previous
    // context normalizer only unwrapped one field, so structuredClone failed
    // after the visible reply was generated but before AstrBot received it.
    //
    // Before: nested message/input proxies survived normalization.
    // After: the complete hook context is projected into plain transport data.
    const context = reactive({
      message: {
        id: 'user-1',
        role: 'user',
        content: [{ type: 'text', text: 'lumi现在可以回应了吗' }],
      },
      contexts: {
        identity: [reactive({
          id: 'identity-1',
          text: 'Doggy',
        })],
      },
      composedMessage: [],
      input: reactive({
        type: 'input:text',
        data: {
          perception: {
            eventId: 'astrbot-1',
          },
        },
      }),
    })

    const normalized = toStructuredCloneSnapshot(context)

    expect(() => structuredClone(normalized)).not.toThrow()
    expect(normalized).not.toBe(context)
    expect(normalized.message).not.toBe(context.message)
    expect(normalized.input).not.toBe(context.input)
    expect(normalized.contexts.identity[0]).not.toBe(context.contexts.identity[0])
  })
})
