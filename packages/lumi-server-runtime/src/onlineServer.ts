import type {
  LumiGenerationPushed,
  LumiOnlineCapabilities,
  LumiOnlineConversation,
  LumiOnlineHelloRequest,
  LumiOnlineHelloResponse,
  LumiOnlineMessage,
  LumiSendMessageRequest,
  LumiSendMessageResponse,
} from '@proj-airi/lumi-online'

import type { LumiAuthenticatedSession } from './auth'
import type { LumiServerDatabase } from './database'

import { errorMessageFrom } from '@moeru/std'
import { LUMI_ONLINE_PROTOCOL_VERSION } from '@proj-airi/lumi-online'

import { LumiConversationScheduler } from './scheduler'

export interface LumiReply {
  content: string
  expression?: string
  motion?: string
}

export interface LumiReplyContext {
  conversation: LumiOnlineConversation
  history: LumiOnlineMessage[]
  input: LumiOnlineMessage
}

export interface LumiReplyGenerator {
  /**
   * Generates one authoritative Lumi turn and optionally emits text deltas.
   *
   * Use when:
   * - A server consciousness runtime responds to a committed user message
   *
   * Expects:
   * - History is already filtered to the authenticated conversation scope
   * - Tool and memory access run only in the server process
   *
   * Returns:
   * - Final text and device-rendered expression or motion hints
   */
  generate: (context: LumiReplyContext, emitDelta: (delta: string) => void) => Promise<LumiReply>
}

export interface LumiOnlineServerOptions {
  database: LumiServerDatabase
  replyGenerator: LumiReplyGenerator
  serverVersion: string
  /** @default 2 */
  maxConcurrentConversations?: number
  /** @default false */
  voiceInput?: boolean
  /** @default 100000 */
  maxTextLength?: number
  /** @default 26214400 */
  maxVoiceBytes?: number
  /** Reports generation failures to the host process after the client has been notified. */
  onGenerationError?: (error: Error, context: LumiReplyContext) => void
}

export type LumiOnlineDelivery
  = | { type: 'messages', personIds: string[], conversationId: string, messages: LumiOnlineMessage[] }
    | { type: 'generation', personIds: string[], event: LumiGenerationPushed }

/**
 * Owns authenticated online chat policy independently of any network transport.
 *
 * Use when:
 * - Serving Electron, Pocket, or future QQ adapters from one authority
 * - Enforcing membership before history reads and message writes
 *
 * Expects:
 * - Sessions were resolved by {@link createLumiAuthentication}
 * - The database is the only online writer
 *
 * Returns:
 * - Reliable conversation operations and scoped delivery events
 */
export class LumiOnlineServer {
  private readonly scheduler: LumiConversationScheduler
  private readonly deliveryListeners = new Set<(delivery: LumiOnlineDelivery) => void>()
  private readonly capabilities: LumiOnlineCapabilities
  private acceptingMessages = true

  constructor(private readonly options: LumiOnlineServerOptions) {
    this.scheduler = new LumiConversationScheduler(options.maxConcurrentConversations ?? 2)
    this.capabilities = {
      protocolVersion: LUMI_ONLINE_PROTOCOL_VERSION,
      serverVersion: options.serverVersion,
      voiceInput: options.voiceInput ?? false,
      localTtsRequired: true,
      maxTextLength: options.maxTextLength ?? 100_000,
      maxVoiceBytes: options.maxVoiceBytes ?? 25 * 1024 * 1024,
    }
  }

  hello(session: LumiAuthenticatedSession, request: LumiOnlineHelloRequest): LumiOnlineHelloResponse {
    if (request.protocolVersion !== LUMI_ONLINE_PROTOCOL_VERSION)
      throw new Error(`Unsupported Lumi protocol version ${request.protocolVersion}`)
    requiredText(request.clientVersion, 'clientVersion', 80)
    requiredText(request.deviceId, 'deviceId', 160)
    requiredText(request.deviceName, 'deviceName', 160)
    if (request.platform)
      requiredText(request.platform, 'platform', 80)
    return { person: session.person, capabilities: this.capabilities }
  }

  listConversations(session: LumiAuthenticatedSession) {
    return { conversations: this.options.database.listConversations(session.person.id) }
  }

  replayConversation(session: LumiAuthenticatedSession, request: { conversationId: string, afterSequence: number }) {
    return this.options.database.replay(request.conversationId, session.person.id, request.afterSequence)
  }

  sendMessage(session: LumiAuthenticatedSession, request: LumiSendMessageRequest): LumiSendMessageResponse {
    if (!this.acceptingMessages)
      throw new Error('Lumi Server is shutting down')
    if (request.content.length > this.capabilities.maxTextLength)
      throw new Error(`Message exceeds the ${this.capabilities.maxTextLength}-character limit`)

    const result = this.options.database.acceptUserMessage({
      ...request,
      actorPersonId: session.person.id,
    })
    if (result.status === 'accepted') {
      const conversation = this.authorizedConversation(session, request.conversationId)
      this.deliver({
        type: 'messages',
        personIds: conversation.participantPersonIds,
        conversationId: conversation.id,
        messages: [result.message],
      })
      void this.generateReply(conversation, result.message)
    }
    return { status: result.status, input: result.message }
  }

  onDelivery(listener: (delivery: LumiOnlineDelivery) => void) {
    this.deliveryListeners.add(listener)
    return () => this.deliveryListeners.delete(listener)
  }

  /** Stops new turns and waits for every accepted generation to settle. */
  async shutdown(): Promise<void> {
    this.acceptingMessages = false
    await this.scheduler.drain()
  }

  private authorizedConversation(session: LumiAuthenticatedSession, conversationId: string) {
    const conversation = this.options.database
      .listConversations(session.person.id)
      .find(candidate => candidate.id === conversationId)
    if (!conversation)
      throw new Error('Authenticated person is not a member of this conversation')
    return conversation
  }

  private async generateReply(conversation: LumiOnlineConversation, input: LumiOnlineMessage) {
    await this.scheduler.run(conversation.id, async () => {
      this.deliverGeneration(conversation, input, { state: 'started' })
      let context: LumiReplyContext = { conversation, history: [], input }
      try {
        const history = this.options.database.replay(conversation.id, conversation.participantPersonIds[0], 0, 500).messages
        context = { conversation, history, input }
        const reply = await this.options.replyGenerator.generate(
          context,
          delta => this.deliverGeneration(conversation, input, { state: 'delta', delta }),
        )
        const message = this.options.database.appendAssistantMessage({
          conversationId: conversation.id,
          content: reply.content,
          expression: reply.expression,
          motion: reply.motion,
        })
        this.deliver({
          type: 'messages',
          personIds: conversation.participantPersonIds,
          conversationId: conversation.id,
          messages: [message],
        })
        this.deliverGeneration(conversation, input, { state: 'completed', message })
      }
      catch (error) {
        const generationError = error instanceof Error
          ? error
          : new Error(errorMessageFrom(error) ?? 'Lumi generation failed')
        this.deliverGeneration(conversation, input, {
          state: 'failed',
          error: generationError.message,
        })
        this.options.onGenerationError?.(generationError, context)
      }
    })
  }

  private deliverGeneration(
    conversation: LumiOnlineConversation,
    input: LumiOnlineMessage,
    event: Omit<LumiGenerationPushed, 'conversationId' | 'inputMessageId'>,
  ) {
    this.deliver({
      type: 'generation',
      personIds: conversation.participantPersonIds,
      event: {
        conversationId: conversation.id,
        inputMessageId: input.id,
        ...event,
      },
    })
  }

  private deliver(delivery: LumiOnlineDelivery) {
    for (const listener of this.deliveryListeners)
      listener(delivery)
  }
}

function requiredText(value: string, name: string, maxLength: number) {
  const normalized = value.trim()
  if (!normalized)
    throw new Error(`${name} is required`)
  if (normalized.length > maxLength)
    throw new Error(`${name} exceeds ${maxLength} characters`)
  return normalized
}
