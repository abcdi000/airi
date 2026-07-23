import type { ChatHistoryItem } from '../types/chat'
import type { ChatSessionMeta } from '../types/chat-session'

/** Normalizes persisted conversation metadata created before participant-aware chats. */
export function normalizeChatSessionMeta(meta: ChatSessionMeta): ChatSessionMeta {
  const conversationType = meta.conversationType === 'group' ? 'group' : 'direct'
  const persistedParticipants = Array.isArray(meta.participantUserIds)
    ? meta.participantUserIds
    : []
  const participantUserIds = conversationType === 'direct'
    ? [meta.userId]
    : uniqueIds([meta.userId, ...persistedParticipants])

  if (
    meta.conversationType === conversationType
    && arraysEqual(meta.participantUserIds, participantUserIds)
  ) {
    return meta
  }

  return {
    ...meta,
    conversationType,
    participantUserIds,
  }
}

/** Adds actor provenance to legacy messages without inventing a speaker in malformed group history. */
export function normalizeChatMessageActors(messages: ChatHistoryItem[], meta: ChatSessionMeta): ChatHistoryItem[] {
  const conversation = normalizeChatSessionMeta(meta)
  return messages.map((message) => {
    if (('actorId' in message && message.actorId) || message.role === 'system' || message.role === 'tool' || message.role === 'error')
      return message
    if (message.role === 'assistant') {
      return {
        ...message,
        actorId: conversation.characterId,
      }
    }
    if (conversation.conversationType === 'direct') {
      return {
        ...message,
        actorId: conversation.participantUserIds[0],
      }
    }
    return message
  })
}

/** Returns whether one user belongs to the persisted conversation audience. */
export function canUserAccessChatSession(meta: ChatSessionMeta, userId: string) {
  if (!userId)
    return false
  const conversation = normalizeChatSessionMeta(meta)
  return conversation.conversationType === 'group'
    ? conversation.participantUserIds.includes(userId)
    : conversation.userId === userId
}

function uniqueIds(ids: string[]) {
  return [...new Set(ids.map(id => id.trim()).filter(Boolean))]
}

function arraysEqual(left: string[] | undefined, right: string[]) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index])
}
