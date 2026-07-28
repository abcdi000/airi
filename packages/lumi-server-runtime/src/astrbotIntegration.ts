import type { LumiOnlineMessage } from '@proj-airi/lumi-online'
import type { LumiImageUnderstandingResult } from '@proj-airi/lumi-runtime'

import type { LumiAuthenticatedSession } from './auth'
import type { LumiServerDatabase } from './database'
import type { LumiOnlineServer } from './onlineServer'
import type { LumiStickerLibrary } from './stickerLibrary'
import type { LumiVoiceTranscriber } from './transcription'

import { Buffer } from 'node:buffer'

export interface LumiAstrBotIdentityBinding {
  platformInstanceId: string
  externalUserId: string
  personId: string
}

export interface LumiAstrBotTextSegment {
  type: 'text'
  text: string
  metadata?: Record<string, unknown>
}

export interface LumiAstrBotImageSegment {
  type: 'image'
  mime_type?: string
  size_bytes?: number
  data_base64?: string
  metadata?: Record<string, unknown>
}

export interface LumiAstrBotAudioSegment {
  type: 'audio'
  mime_type?: string
  size_bytes?: number
  duration_ms?: number
  data_base64?: string
  metadata?: Record<string, unknown>
}

export type LumiAstrBotPerceptionSegment
  = | LumiAstrBotTextSegment
    | LumiAstrBotImageSegment
    | LumiAstrBotAudioSegment

export interface LumiAstrBotPerceptionEvent {
  event_id: string
  platform: string
  platform_instance_id: string
  unified_session_id: string
  conversation_id: string
  sender_id: string
  sender_name: string
  group_id?: string | null
  message_id: string
  timestamp: number
  is_private: boolean
  is_group: boolean
  is_mention: boolean
  segments: LumiAstrBotPerceptionSegment[]
  metadata?: Record<string, unknown>
}

export interface LumiVisionAnalyzer {
  analyze: (input: {
    image: Uint8Array
    mimeType: string
    userText: string
    eventId: string
    segmentIndex: number
  }) => Promise<LumiImageUnderstandingResult>
}

export interface LumiAstrBotIntegrationOptions {
  database: LumiServerDatabase
  onlineServer: LumiOnlineServer
  identityBindings: LumiAstrBotIdentityBinding[]
  visionAnalyzer?: LumiVisionAnalyzer
  voiceTranscriber?: LumiVoiceTranscriber
  /** @default 10485760 */
  maxImageBytes?: number
  /** @default 26214400 */
  maxAudioBytes?: number
  /** @default 300000 */
  responseTimeoutMs?: number
  stickerLibrary?: LumiStickerLibrary
}

export class LumiAstrBotIntegrationError extends Error {
  constructor(
    readonly code: 'identity_unbound' | 'invalid_event' | 'vision_unavailable' | 'hearing_unavailable' | 'media_too_large' | 'generation_failed' | 'generation_timeout',
    message: string,
  ) {
    super(message)
  }
}

/**
 * Converts ordered AstrBot media into one authoritative Lumi consciousness turn.
 *
 * Use when:
 * - A trusted AstrBot installation submits QQ, KOOK, or another platform event
 *
 * Expects:
 * - External identities are pre-bound by the server owner
 * - AstrBot has resolved platform media but has not interpreted it
 *
 * Returns:
 * - One final Lumi response after server-side visual and auditory perception
 */
export class LumiAstrBotIntegration {
  constructor(private readonly options: LumiAstrBotIntegrationOptions) {
    for (const binding of options.identityBindings) {
      options.database.bindExternalIdentity({
        provider: 'astrbot',
        providerInstanceId: binding.platformInstanceId,
        externalUserId: binding.externalUserId,
        personId: binding.personId,
      })
    }
  }

  health(serverVersion: string) {
    return {
      status: 'ok',
      server_version: serverVersion,
      vision: Boolean(this.options.visionAnalyzer),
      hearing: Boolean(this.options.voiceTranscriber),
    }
  }

  async perceiveAndRespond(event: unknown) {
    const normalized = validateEvent(event)
    if (!normalized.is_private || normalized.is_group || normalized.group_id)
      throw new LumiAstrBotIntegrationError('invalid_event', 'AstrBot group events are disabled')
    const person = this.options.database.personForExternalIdentity({
      provider: 'astrbot',
      providerInstanceId: normalized.platform_instance_id,
      externalUserId: normalized.sender_id,
    })
    if (!person)
      throw new LumiAstrBotIntegrationError('identity_unbound', 'AstrBot identity is not bound to a Lumi person')
    const conversation = this.options.database.ensureExternalConversation({
      personId: person.id,
      provider: 'astrbot',
      providerInstanceId: normalized.platform_instance_id,
      externalConversationId: normalized.conversation_id,
      groupId: normalized.group_id || undefined,
    })
    const text = normalized.segments
      .filter((segment): segment is LumiAstrBotTextSegment => segment.type === 'text')
      .map(segment => segment.text)
      .join('\n')
    const perceivedSegments: Array<Record<string, unknown>> = []
    for (const [segmentIndex, segment] of normalized.segments.entries()) {
      if (segment.type === 'text') {
        perceivedSegments.push({
          type: 'text',
          text: requiredSegmentText(segment.text, 'text segment', 100_000),
          metadata: safeMetadata(segment.metadata),
        })
        continue
      }
      if (segment.type === 'image') {
        if (!this.options.visionAnalyzer)
          throw new LumiAstrBotIntegrationError('vision_unavailable', 'Lumi server vision is not configured')
        const image = decodeMedia(segment.data_base64, segment.size_bytes, this.options.maxImageBytes ?? 10 * 1024 * 1024, 'image')
        const mimeType = requiredMediaType(segment.mime_type, 'image/')
        const perception = await this.options.visionAnalyzer.analyze({
          image,
          mimeType,
          userText: text,
          eventId: normalized.event_id,
          segmentIndex,
        })
        perceivedSegments.push({
          type: 'visual_perception',
          perception,
          metadata: safeMetadata(segment.metadata),
        })
        continue
      }
      if (!this.options.voiceTranscriber)
        throw new LumiAstrBotIntegrationError('hearing_unavailable', 'Lumi server hearing is not configured')
      const audio = decodeMedia(segment.data_base64, segment.size_bytes, this.options.maxAudioBytes ?? 25 * 1024 * 1024, 'audio')
      const mimeType = requiredAudioType(segment.mime_type)
      const transcript = await this.options.voiceTranscriber.transcribe({
        audio,
        mimeType,
        fileName: `astrbot-${segmentIndex}.${audioExtension(mimeType)}`,
      })
      perceivedSegments.push({
        type: 'auditory_perception',
        transcript: requiredText(transcript, 'Lumi hearing transcript', 100_000),
        duration_ms: finiteOptionalInteger(segment.duration_ms),
        metadata: safeMetadata(segment.metadata),
      })
    }
    if (!perceivedSegments.length)
      throw new LumiAstrBotIntegrationError('invalid_event', 'Perception event has no supported segments')

    const content = [
      '[Lumi trusted ordered perception]',
      JSON.stringify(perceivedSegments),
      '[/Lumi trusted ordered perception]',
    ].join('\n')
    const session: LumiAuthenticatedSession = {
      accountId: `astrbot:${person.id}`,
      sessionId: normalized.event_id,
      expiresAt: new Date(Date.now() + 60_000),
      person,
    }
    const messageId = `astrbot:${normalized.platform_instance_id}:${normalized.message_id}`
    const responseMessages = await this.sendAndWait(session, {
      conversationId: conversation.id,
      messageId,
      idempotencyKey: normalized.event_id,
      content,
      createdAt: normalized.timestamp > 0 ? normalized.timestamp * 1000 : Date.now(),
    })
    const responseText = responseMessages.map(message => message.content).join('\n')
    const lastResponse = responseMessages.at(-1)
    const sticker = responseText
      ? await this.options.stickerLibrary?.selectForReply({
          eventId: normalized.event_id,
          inputText: text,
          replyText: responseText,
        })
      : undefined
    return {
      response_id: lastResponse?.id ?? normalized.event_id,
      text: responseText || null,
      segments: [
        ...responseMessages.map(message => ({
          type: 'text',
          text: message.content,
          metadata: {
            message_id: message.id,
            sequence: message.sequence,
            expression: message.expression,
            motion: message.motion,
          },
        })),
        ...(sticker
          ? [{
              type: 'image',
              data_base64: sticker.dataBase64,
              mime_type: sticker.mimeType,
              metadata: { sticker_id: sticker.id, tags: sticker.tags },
            }]
          : []),
      ],
      metadata: {
        conversation_id: conversation.id,
        actor_person_id: person.id,
        expression: lastResponse?.expression,
        motion: lastResponse?.motion,
        message_count: responseMessages.length,
      },
    }
  }

  private async sendAndWait(
    session: LumiAuthenticatedSession,
    request: Parameters<LumiOnlineServer['sendMessage']>[1],
  ): Promise<readonly LumiOnlineMessage[]> {
    let unsubscribe = () => {}
    const deliveredMessages: LumiOnlineMessage[] = []
    const completion = new Promise<readonly LumiOnlineMessage[]>((resolve, reject) => {
      unsubscribe = this.options.onlineServer.onDelivery((delivery) => {
        if (delivery.type === 'messages') {
          if (delivery.conversationId !== request.conversationId)
            return
          deliveredMessages.push(...delivery.messages.filter(message => message.role === 'assistant'))
          return
        }
        if (delivery.event.inputMessageId !== request.messageId)
          return
        if (delivery.event.state === 'completed') {
          if (
            delivery.event.message
            && !deliveredMessages.some(message => message.id === delivery.event.message!.id)
          ) {
            deliveredMessages.push(delivery.event.message)
          }
          resolve([...deliveredMessages].sort((left, right) => left.sequence - right.sequence))
        }
        if (delivery.event.state === 'failed')
          reject(new LumiAstrBotIntegrationError('generation_failed', delivery.event.error || 'Lumi generation failed'))
      })
    })
    try {
      const accepted = this.options.onlineServer.sendMessage(session, request)
      if (accepted.status === 'duplicate') {
        const replay = this.options.database.replay(request.conversationId, session.person.id, accepted.input.sequence)
        return assistantTurnAfter(replay.messages)
      }
      return await withTimeout(completion, this.options.responseTimeoutMs ?? 300_000)
    }
    finally {
      unsubscribe()
    }
  }
}

function assistantTurnAfter(messages: readonly LumiOnlineMessage[]): readonly LumiOnlineMessage[] {
  const turn: LumiOnlineMessage[] = []
  for (const message of messages) {
    if (message.role === 'assistant') {
      turn.push(message)
      continue
    }
    if (turn.length > 0)
      break
  }
  return turn
}

function validateEvent(event: unknown): LumiAstrBotPerceptionEvent {
  if (!event || typeof event !== 'object')
    throw new LumiAstrBotIntegrationError('invalid_event', 'Invalid AstrBot perception event')
  const candidate = event as Partial<LumiAstrBotPerceptionEvent>
  if (!Array.isArray(candidate.segments))
    throw new LumiAstrBotIntegrationError('invalid_event', 'Invalid AstrBot perception event')
  if (candidate.is_private === candidate.is_group)
    throw new LumiAstrBotIntegrationError('invalid_event', 'Event must be private or group')
  requiredText(candidate.event_id, 'event id', 500)
  requiredText(candidate.platform, 'platform', 80)
  requiredText(candidate.platform_instance_id, 'platform instance id', 160)
  requiredText(candidate.conversation_id, 'conversation id', 500)
  requiredText(candidate.sender_id, 'sender id', 240)
  requiredText(candidate.message_id, 'message id', 240)
  if (!Array.isArray(candidate.segments) || candidate.segments.length > 32)
    throw new LumiAstrBotIntegrationError('invalid_event', 'Too many perception segments')
  if (!candidate.segments.every(segment => segment && typeof segment === 'object' && ['text', 'image', 'audio'].includes(segment.type)))
    throw new LumiAstrBotIntegrationError('invalid_event', 'Unsupported perception segment')
  return candidate as LumiAstrBotPerceptionEvent
}

function decodeMedia(encoded: string | undefined, declaredSize: number | undefined, maximum: number, kind: string) {
  if (!encoded || !/^(?:[A-Z0-9+/]{4})*(?:[A-Z0-9+/]{2}==|[A-Z0-9+/]{3}=)?$/i.test(encoded))
    throw new LumiAstrBotIntegrationError('invalid_event', `${kind} data is required`)
  const data = Buffer.from(encoded, 'base64')
  if (!data.byteLength || data.byteLength > maximum || (declaredSize !== undefined && declaredSize !== data.byteLength))
    throw new LumiAstrBotIntegrationError('media_too_large', `${kind} size is invalid`)
  return new Uint8Array(data)
}

function requiredMediaType(value: string | undefined, prefix: string) {
  const normalized = requiredText(value, 'media type', 120).toLowerCase()
  if (!normalized.startsWith(prefix))
    throw new LumiAstrBotIntegrationError('invalid_event', `Expected ${prefix} media`)
  return normalized
}

function requiredAudioType(value: string | undefined) {
  const normalized = requiredText(value, 'audio media type', 120).toLowerCase()
  if (!normalized.startsWith('audio/') && !['video/webm', 'video/mp4', 'application/ogg'].includes(normalized))
    throw new LumiAstrBotIntegrationError('invalid_event', 'Unsupported audio media type')
  return normalized
}

function audioExtension(mimeType: string) {
  return ({
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'video/webm': 'webm',
    'audio/ogg': 'ogg',
    'application/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'video/mp4': 'm4a',
  } as Record<string, string>)[mimeType] ?? 'audio'
}

function safeMetadata(value: Record<string, unknown> | undefined) {
  if (!value)
    return {}
  const serialized = JSON.stringify(value)
  return serialized.length <= 8_192 ? value : {}
}

function finiteOptionalInteger(value: number | undefined) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
}

function requiredText(value: unknown, field: string, maximum: number) {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > maximum)
    throw new LumiAstrBotIntegrationError('invalid_event', `${field} is invalid`)
  return normalized
}

function requiredSegmentText(value: unknown, field: string, maximum: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new LumiAstrBotIntegrationError('invalid_event', `${field} is invalid`)
  return value
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new LumiAstrBotIntegrationError('generation_timeout', 'Lumi generation timed out')),
          timeoutMs,
        )
      }),
    ])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
}
