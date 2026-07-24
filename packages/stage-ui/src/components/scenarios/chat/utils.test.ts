import type { ChatHistoryItem } from '../../../types/chat'

import { describe, expect, it } from 'vitest'

import { getChatHistoryItemCopyText, getChatHistoryItemKey, getUserMessageDisplayText, getUserMessageImageUrls } from './utils'

describe('user message media projection', () => {
  it('renders an image-only message without exposing its base64 JSON', () => {
    const imageUrl = 'data:image/png;base64,iVBORw0KGgo='
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: '' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    } as ChatHistoryItem

    expect(getUserMessageDisplayText(message)).toBe('')
    expect(getUserMessageImageUrls(message)).toEqual([imageUrl])
    expect(getChatHistoryItemCopyText(message)).toBe('')
  })

  it('keeps text and image order projections separate for mixed input', () => {
    const imageUrl = 'data:image/jpeg;base64,/9j/'
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: '看看这张图' },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    } as ChatHistoryItem

    expect(getUserMessageDisplayText(message)).toBe('看看这张图')
    expect(getUserMessageImageUrls(message)).toEqual([imageUrl])
    expect(getChatHistoryItemCopyText(message)).toBe('看看这张图')
  })
})

describe('getChatHistoryItemKey', () => {
  it('prefers stable message ids when available', () => {
    const createdAt = 1700000000000

    const userMessage: ChatHistoryItem = { role: 'user', content: 'hi', createdAt, id: 'user-1' }
    const assistantMessage: ChatHistoryItem = { role: 'assistant', content: 'hello', createdAt, id: 'assistant-1', slices: [], tool_results: [] }

    expect(getChatHistoryItemKey(userMessage, 0)).toBe('user-1')
    expect(getChatHistoryItemKey(assistantMessage, 1)).toBe('assistant-1')
  })

  it('falls back to a role + timestamp + index composite when ids are missing', () => {
    const createdAt = 1700000000000

    const userMessage: ChatHistoryItem = { role: 'user', content: 'hi', createdAt }
    const assistantMessage: ChatHistoryItem = { role: 'assistant', content: 'hello', createdAt, slices: [], tool_results: [] }

    expect(getChatHistoryItemKey(userMessage, 0)).toBe('user:1700000000000:0')
    expect(getChatHistoryItemKey(assistantMessage, 1)).toBe('assistant:1700000000000:1')
  })

  it('falls back to index when message is missing', () => {
    expect(getChatHistoryItemKey(undefined, 0)).toBe(0)
    expect(getChatHistoryItemKey(undefined, 1)).toBe(1)
  })

  it('falls back to a role + index composite when ids and timestamps are missing', () => {
    const userMessage: ChatHistoryItem = { role: 'user', content: 'hi' }
    const assistantMessage: ChatHistoryItem = { role: 'assistant', content: 'hello', slices: [], tool_results: [] }

    expect(getChatHistoryItemKey(userMessage, 0)).toBe('user:0')
    expect(getChatHistoryItemKey(assistantMessage, 1)).toBe('assistant:1')
  })
})
