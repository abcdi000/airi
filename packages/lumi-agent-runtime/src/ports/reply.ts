import type { LumiReplyIntent } from '@proj-airi/lumi-runtime'

import type { DirectPerceptionEnvelope } from '../input'
import type { AgentPersonProfile } from './identity'

/** Planner-authored semantic request accepted by the explicit reply tool. */
export interface ReplyIntentProposal {
  targetMessageId: string
  quote?: boolean
  replyAct: string
  semanticGoal: string
  keyPoints: readonly string[]
  referenceInfo: readonly string[]
  expressionIntent?: {
    focus?: string
    scene?: string
    tone?: string
    desiredLength?: 'tiny' | 'short' | 'medium' | 'long'
    preferredActs?: readonly string[]
    avoid?: readonly string[]
  }
  stickerIntent?: {
    enabled: boolean
    emotionOrScene?: string
  }
}

/**
 * Applies authoritative character, relationship, defense, and privacy policy.
 *
 * The Planner proposal is untrusted. Implementations must derive protected
 * fields from host-owned state and may strengthen, but never weaken, refusal
 * and privacy constraints.
 */
export interface ReplyPolicyPort {
  resolveIntent: (input: {
    proposal: ReplyIntentProposal
    envelope: DirectPerceptionEnvelope
    profile?: AgentPersonProfile
  }) => Promise<LumiReplyIntent>
  forbiddenPrivacyTokens?: (input: {
    envelope: DirectPerceptionEnvelope
    intent: LumiReplyIntent
  }) => Promise<readonly string[]>
}
