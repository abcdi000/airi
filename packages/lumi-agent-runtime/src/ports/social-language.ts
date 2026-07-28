import type { LumiReplyIntent, LumiVisibleReply } from '@proj-airi/lumi-runtime'

import type { DirectPerceptionEnvelope } from '../input'

/** One authorized language reference selected for the current turn. */
export interface AgentLanguageReference {
  id: string
  kind: 'expression' | 'behavior' | 'jargon'
  content: string
  confidence?: number
}

/** Replyer-safe social-language projection. */
export interface ReplyLanguageReferences {
  expressions: readonly AgentLanguageReference[]
  behaviors: readonly AgentLanguageReference[]
  jargon: readonly AgentLanguageReference[]
}

/**
 * Adapts Lumi's existing social-language store to the shared Agent Runtime.
 *
 * Direct feedback may only update existing group-learned candidates. This port
 * must not create expression, jargon, behavior, or sticker candidates from a
 * private message.
 */
export interface SocialLanguagePort {
  plannerReferences: (input: {
    envelope: DirectPerceptionEnvelope
    limit: number
  }) => Promise<readonly AgentLanguageReference[]>
  replyReferences: (input: {
    envelope: DirectPerceptionEnvelope
    intent: LumiReplyIntent
    limit: number
    /** Whether the adapter may invoke a model-backed precise selector. */
    expressionSelectorEnabled: boolean
  }) => Promise<ReplyLanguageReferences>
  observeDirectFeedback: (input: {
    envelope: DirectPerceptionEnvelope
    recentAssistantMessageIds: readonly string[]
    recentAssistantTexts: readonly string[]
  }) => Promise<void>
  recordSentReply: (input: {
    envelope: DirectPerceptionEnvelope
    intent: LumiReplyIntent
    reply: LumiVisibleReply
    sentMessageIds: readonly string[]
    selectedReferenceIds: readonly string[]
    /** Exact redacted Replyer request retained only for local prompt inspection. */
    replyerPromptSnapshot?: ReadonlyArray<{ role: string, content: string }>
  }) => Promise<void>
}
