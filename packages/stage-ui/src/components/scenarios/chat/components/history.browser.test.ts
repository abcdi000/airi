import type { ChatHistoryItem } from '../../../../types/chat'

import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-vue'
import { defineComponent, shallowRef } from 'vue'
import { createI18n } from 'vue-i18n'

import ChatHistory from './history.vue'

vi.mock('../composables/use-chat-history-scroll', () => ({
  useChatHistoryScroll: () => undefined,
}))

vi.mock('../../../markdown', () => ({
  MarkdownRenderer: defineComponent({
    name: 'MarkdownRendererStub',
    props: {
      content: {
        type: String,
        default: '',
      },
    },
    template: '<div>{{ content }}</div>',
  }),
}))

function createTestI18n() {
  return createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        stage: {
          chat: {
            actions: {
              retry: 'Retry',
            },
            message: {
              'character-name': {
                'airi': 'AIRI',
                'core-system': 'System',
                'you': 'You',
              },
            },
          },
        },
      },
    },
  })
}

function createHarness(messages: ChatHistoryItem[]) {
  return defineComponent({
    name: 'ChatHistoryRetryHarness',
    components: {
      ChatHistory,
    },
    setup() {
      const lastRetryIndex = shallowRef('none')

      function handleRetryMessage(payload: { index: number }) {
        lastRetryIndex.value = String(payload.index)
      }

      return {
        handleRetryMessage,
        lastRetryIndex,
        messages,
      }
    },
    template: `
      <div>
        <ChatHistory
          :messages="messages"
          @retry-message="handleRetryMessage"
        />
        <output aria-label="retry-index">{{ lastRetryIndex }}</output>
      </div>
    `,
  })
}

/**
 * @example
 * describe('ChatHistory retry actions', () => {
 *   it('emits retry-message when the retry button is clicked for an error after a user message', async () => {})
 * })
 */
describe('chatHistory retry actions', () => {
  /**
   * @example
   * it('emits retry-message when the retry button is clicked for an error after a user message', async () => {
   *   const screen = await render(createHarness(messages), { global: { plugins: [createTestI18n()] } })
   *   await screen.getByRole('button', { name: 'Retry' }).click()
   *   await expect.element(screen.getByLabelText('retry-index')).toHaveTextContent('1')
   * })
   */
  it('emits retry-message when the retry button is clicked for an error after a user message', async () => {
    const messages: ChatHistoryItem[] = [
      { role: 'user', content: 'hello' },
      { role: 'error', content: 'Remote sent 400 response' },
    ]

    const screen = await render(createHarness(messages), {
      global: {
        plugins: [createTestI18n()],
      },
    })

    await screen.getByRole('button', { name: 'Retry' }).click()

    await expect.element(screen.getByLabelText('retry-index')).toHaveTextContent('1')
  })

  /**
   * @example
   * it('does not render the retry button when the error is not preceded by a user message', async () => {
   *   const screen = await render(createHarness(messages), { global: { plugins: [createTestI18n()] } })
   *   expect(document.body.textContent).not.toContain('Retry')
   * })
   */
  it('does not render the retry button when the error is not preceded by a user message', async () => {
    const messages: ChatHistoryItem[] = [
      { role: 'assistant', content: 'hello', slices: [], tool_results: [] },
      { role: 'error', content: 'Remote sent 400 response' },
    ]

    await render(createHarness(messages), {
      global: {
        plugins: [createTestI18n()],
      },
    })

    expect(document.body.textContent).not.toContain('Retry')
  })

  it('renders only the latest page and preserves original message indexes', async () => {
    const messages: ChatHistoryItem[] = Array.from({ length: 200 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index}`,
      id: `m-${index}`,
      ...(index % 2 === 0 ? {} : { slices: [], tool_results: [] }),
    } as ChatHistoryItem))

    const Harness = defineComponent({
      components: { ChatHistory },
      setup() {
        return { messages }
      },
      template: `
        <ChatHistory
          :messages="messages"
          :initial-render-limit="50"
        />
      `,
    })

    await render(Harness, {
      global: {
        plugins: [createTestI18n()],
      },
    })

    const nodes = Array.from(document.querySelectorAll('[data-chat-message-index]'))
    expect(nodes).toHaveLength(50)
    expect(nodes[0].getAttribute('data-chat-message-index')).toBe('150')
    expect(nodes.at(-1)?.getAttribute('data-chat-message-index')).toBe('199')
  })

  /**
   * @example
   * it('renders internal runtime notices as green assistant diagnostics', async () => {
   *   expect(document.body.textContent).toContain('status: started')
   * })
   */
  it('renders internal runtime notices as green assistant diagnostics', async () => {
    const messages: ChatHistoryItem[] = [
      {
        id: 'notice-1',
        role: 'system',
        content: '[system_notice]\ntitle: 工具调用\nstatus: started\nactivity: 打开浏览器',
        createdAt: 1,
      },
    ]

    const screen = await render(createHarness(messages), {
      global: {
        plugins: [createTestI18n()],
      },
    })

    await expect.element(screen.getByText('status: started', { exact: false })).toBeVisible()
    expect(document.querySelector('[data-chat-message-role="assistant"]')).not.toBeNull()
  })

  it('renders short assistant lines as separate visual bubbles with custom assistant label', async () => {
    const messages: ChatHistoryItem[] = [
      {
        role: 'assistant',
        content: '第一句短回复。\n第二句补充。',
        slices: [{ type: 'text', text: '第一句短回复。\n第二句补充。' }],
        tool_results: [],
      },
    ]

    const Harness = defineComponent({
      components: { ChatHistory },
      setup() {
        return { messages }
      },
      template: `
        <ChatHistory
          :messages="messages"
          assistant-label="Lumi"
          split-assistant-text-bubbles
        />
      `,
    })

    await render(Harness, {
      global: {
        plugins: [createTestI18n()],
      },
    })

    const bubbles = Array.from(document.querySelectorAll('[data-chat-assistant-bubble="split"]'))
    expect(bubbles).toHaveLength(2)
    expect(document.body.textContent).toContain('Lumi')
    expect(document.body.textContent).toContain('第一句短回复。')
    expect(document.body.textContent).toContain('第二句补充。')
  })
})
