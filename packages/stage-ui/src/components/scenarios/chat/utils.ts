import type { ChatHistoryItem } from '../../../types/chat'

function isTextPart(part: unknown): part is { type: 'text', text?: string } {
  return typeof part === 'object'
    && part !== null
    && 'type' in part
    && part.type === 'text'
    && 'text' in part
}

function getTextFromContentParts(parts: unknown[]): string {
  return parts.reduce<string[]>((texts, part) => {
    if (!isTextPart(part))
      return texts

    const text = part.text?.trim()
    if (text)
      texts.push(text)

    return texts
  }, []).join('\n\n')
}

/**
 * Returns only user-visible text from a user chat message.
 *
 * Use when:
 * - Rendering or copying a user message that may contain image content parts
 *
 * Expects:
 * - Image-only messages may have an empty text content part
 *
 * Returns:
 * - Plain text without serializing image data or base64 payloads
 */
export function getUserMessageDisplayText(message: ChatHistoryItem): string {
  if (message.role !== 'user')
    return ''
  if (typeof message.content === 'string')
    return message.content
  if (Array.isArray(message.content))
    return getTextFromContentParts(message.content)
  return ''
}

/**
 * Returns image URLs embedded in a user chat message.
 *
 * Use when:
 * - Rendering image attachments stored as provider-compatible content parts
 *
 * Expects:
 * - URLs may be HTTP resources or data URLs
 *
 * Returns:
 * - Image URLs in their original message order
 */
export function getUserMessageImageUrls(message: ChatHistoryItem): string[] {
  if (message.role !== 'user' || !Array.isArray(message.content))
    return []

  return message.content
    .filter(part => 'type' in part && part.type === 'image_url')
    .map((part) => {
      const imageUrl = (part as { image_url?: { url?: string } }).image_url
      return imageUrl?.url
    })
    .filter((url): url is string => Boolean(url))
}

export function getChatHistoryItemCopyText(message: ChatHistoryItem): string {
  if (message.role === 'error')
    return message.content

  if (message.role === 'assistant') {
    if (message.slices?.length) {
      const text = message.slices
        .filter(slice => slice.type === 'text')
        .map(slice => slice.text.trim())
        .filter(Boolean)
        .join('\n\n')

      if (text)
        return text
    }

    if (typeof message.content === 'string')
      return message.content

    if (Array.isArray(message.content)) {
      const text = getTextFromContentParts(message.content)

      if (text)
        return text

      return message.content.map(entry => JSON.stringify(entry)).join('\n')
    }

    return ''
  }

  if (typeof message.content === 'string')
    return message.content

  if (Array.isArray(message.content))
    return getTextFromContentParts(message.content)

  return ''
}

export function getChatHistoryItemKey(message: ChatHistoryItem | undefined, index: number): string | number {
  if (!message)
    return index

  if (message.id)
    return message.id

  if (message.createdAt != null)
    return `${message.role}:${message.createdAt}:${index}`

  return `${message.role}:${index}`
}
