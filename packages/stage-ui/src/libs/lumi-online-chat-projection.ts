import type { LumiGenerationPushed, LumiOnlineMessage } from '@proj-airi/lumi-online'
import type { LumiOnlineProjection } from '../stores/lumi-online'
import type { ChatHistoryItem } from '../types/chat'
import type { ChatSessionMeta, ChatSessionsIndex } from '../types/chat-session'

import { LUMI_AIRI_CARD_ID } from '../constants/lumi-card'
import { useChatSessionStore } from '../stores/chat/session-store'
import { useChatStreamStore } from '../stores/chat/stream-store'

/** Projects an authorized online snapshot into the existing Lumi chat surface. */
export function projectLumiOnlineSnapshot(
  snapshot: LumiOnlineProjection,
  sessions: ReturnType<typeof useChatSessionStore>,
) {
  const metas: Record<string, ChatSessionMeta> = {}
  const messages: Record<string, ChatHistoryItem[]> = {}
  for (const conversation of snapshot.conversations) {
    metas[conversation.id] = {
      sessionId: conversation.id,
      userId: snapshot.personId,
      characterId: LUMI_AIRI_CARD_ID,
      conversationType: conversation.type,
      participantUserIds: conversation.participantPersonIds,
      title: conversation.title,
      timelineType: 'main',
      createdAt: conversation.updatedAt,
      updatedAt: conversation.updatedAt,
    }
    messages[conversation.id] = (snapshot.messages[conversation.id] ?? []).map(toChatMessage)
  }

  const activeSessionId = snapshot.conversations.some(conversation => conversation.id === sessions.activeSessionId)
    ? sessions.activeSessionId
    : snapshot.conversations.find(conversation => conversation.type === 'direct')?.id ?? snapshot.conversations[0]?.id ?? ''
  const index: ChatSessionsIndex = {
    userId: snapshot.personId,
    characters: {
      [LUMI_AIRI_CARD_ID]: { activeSessionId, sessions: metas },
    },
  }
  sessions.applyOnlineProjection({ activeSessionId, sessionMessages: messages, sessionMetas: metas, index })
}

/** Applies a live server generation only to the currently visible stream. */
export function projectLumiOnlineGeneration(
  generation: LumiGenerationPushed,
  activeSessionId: string,
  stream: ReturnType<typeof useChatStreamStore>,
) {
  if (generation.conversationId !== activeSessionId)
    return
  if (generation.state === 'started') {
    stream.beginStream()
    return
  }
  if (generation.state === 'delta' && generation.delta) {
    stream.appendStreamLiteral(generation.delta)
    return
  }
  stream.resetStream()
}

function toChatMessage(message: LumiOnlineMessage): ChatHistoryItem {
  const base = {
    id: message.id,
    content: message.content,
    createdAt: message.createdAt,
    actorId: message.actorPersonId,
    actorDisplayName: message.actorDisplayName,
  }
  if (message.role === 'assistant') {
    return {
      ...base,
      role: 'assistant',
      slices: message.content ? [{ type: 'text', text: message.content }] : [],
      tool_results: [],
    }
  }
  return { ...base, role: message.role }
}
