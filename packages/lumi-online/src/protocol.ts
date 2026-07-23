import { defineInvokeEventa, defineOutboundEventa } from '@moeru/eventa'

export const LUMI_ONLINE_PROTOCOL_VERSION = 1

export type LumiRuntimeRole = 'offline-client' | 'online-client' | 'server-manager' | 'server-runtime'
export type LumiConversationType = 'direct' | 'group'
export type LumiOnlineRole = 'owner' | 'member'

/** Authenticated Lumi person projected to an online client. */
export interface LumiOnlinePerson {
  /** Stable Lumi person id, distinct from account and device ids. */
  id: string
  /** Name shown to other members of shared conversations. */
  displayName: string
  /** Account-level authorization role. */
  role: LumiOnlineRole
}

/** Conversation metadata visible to one authenticated member. */
export interface LumiOnlineConversation {
  /** Stable server-owned conversation id. */
  id: string
  /** Direct conversations have one human; groups have at least two. */
  type: LumiConversationType
  /** Human-readable title. */
  title: string
  /** Explicit human audience. */
  participantPersonIds: string[]
  /** Highest accepted server sequence. */
  latestSequence: number
  /** Unix timestamp of the latest mutation. */
  updatedAt: number
}

/** Canonical server message returned through live delivery or replay. */
export interface LumiOnlineMessage {
  id: string
  conversationId: string
  sequence: number
  role: 'user' | 'assistant' | 'system'
  actorPersonId?: string
  actorDisplayName?: string
  content: string
  createdAt: number
  /** Optional device-rendered expression name. */
  expression?: string
  /** Optional device-rendered motion name. */
  motion?: string
}

/** Capability projection sent after authentication. */
export interface LumiOnlineCapabilities {
  protocolVersion: number
  serverVersion: string
  voiceInput: boolean
  localTtsRequired: true
  maxTextLength: number
  maxVoiceBytes: number
}

/** One authenticated device visible only to its owning account. */
export interface LumiOnlineDevice {
  id: string
  accountId: string
  name: string
  platform: string
  lastSeenAt: number
  revokedAt?: number
  createdAt: number
}

export interface LumiOnlineHelloRequest {
  protocolVersion: number
  clientVersion: string
  deviceId: string
  deviceName: string
  /** Client platform used only for the account's device list. */
  platform?: string
}

export interface LumiOnlineHelloResponse {
  person: LumiOnlinePerson
  capabilities: LumiOnlineCapabilities
}

export interface LumiConversationListResponse {
  conversations: LumiOnlineConversation[]
}

export interface LumiConversationReplayRequest {
  conversationId: string
  afterSequence: number
}

export interface LumiConversationReplayResponse {
  conversationId: string
  afterSequence: number
  latestSequence: number
  retainedFromSequence: number
  truncated: boolean
  messages: LumiOnlineMessage[]
}

export interface LumiSendMessageRequest {
  conversationId: string
  messageId: string
  idempotencyKey: string
  content: string
  createdAt: number
}

export interface LumiSendMessageResponse {
  status: 'accepted' | 'duplicate'
  input: LumiOnlineMessage
}

export interface LumiConversationMessagesPushed {
  conversationId: string
  messages: LumiOnlineMessage[]
}

export interface LumiGenerationPushed {
  conversationId: string
  inputMessageId: string
  state: 'started' | 'delta' | 'completed' | 'failed'
  delta?: string
  message?: LumiOnlineMessage
  error?: string
}

export interface LumiPresencePushed {
  personId: string
  state: 'online' | 'offline'
  changedAt: number
}

export interface LumiAccessRevokedPushed {
  conversationId?: string
  reason: string
}

export const lumiOnlineHello = defineInvokeEventa<LumiOnlineHelloResponse, LumiOnlineHelloRequest>('lumi:online:hello')
export const lumiOnlineListConversations = defineInvokeEventa<LumiConversationListResponse, undefined>('lumi:online:conversations:list')
export const lumiOnlineReplayConversation = defineInvokeEventa<LumiConversationReplayResponse, LumiConversationReplayRequest>('lumi:online:conversation:replay')
export const lumiOnlineSendMessage = defineInvokeEventa<LumiSendMessageResponse, LumiSendMessageRequest>('lumi:online:message:send')
export const lumiOnlineMessagesPushed = defineOutboundEventa<LumiConversationMessagesPushed>('lumi:online:messages')
export const lumiOnlineGenerationPushed = defineOutboundEventa<LumiGenerationPushed>('lumi:online:generation')
export const lumiOnlinePresencePushed = defineOutboundEventa<LumiPresencePushed>('lumi:online:presence')
export const lumiOnlineAccessRevoked = defineOutboundEventa<LumiAccessRevokedPushed>('lumi:online:access-revoked')
