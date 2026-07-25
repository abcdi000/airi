import type { LumiEmotionTag, LumiStateSnapshot } from '../types'

/**
 * Configuration for Lumi's social-language learning and final reply pipeline.
 *
 * Every field has a normalized default in {@link DEFAULT_LANGUAGE_LEARNING_CONFIG}.
 */
export interface LanguageLearningConfig {
  /** Enables the Planner -> Replyer boundary and social-language pipeline. @default true */
  enabled: boolean
  /** Learns concrete expressions and abstract speech patterns from trusted messages. @default true */
  expressionLearningEnabled: boolean
  /** Learns social participation and reply-shape behavior. @default true */
  behaviorLearningEnabled: boolean
  /** Learns pragmatic meanings of slang independently from factual memory. @default true */
  jargonLearningEnabled: boolean
  /** Allows successful Lumi-origin expressions to become candidates. @default true */
  selfExpressionLearningEnabled: boolean
  /** Allows proven local expressions to diffuse beyond their source scope. @default true */
  globalDiffusionEnabled: boolean
  /** Maximum expression references injected into one Replyer turn. @default 3 */
  maxSelectedExpressions: number
  /** Maximum candidates retained after broad retrieval. @default 24 */
  vectorCandidateLimit: number
  /** Enables consciousness-model selection after broad candidate retrieval. @default true */
  preciseSelectorEnabled: boolean
  /** Updates affinity, ownership, and lifecycle from later interaction signals. @default true */
  feedbackLearningEnabled: boolean
  /** Persists prompt snapshots in decision logs. Keep disabled for privacy. @default false */
  promptLoggingEnabled: boolean
  /** Allows a reply to contain a bounded sequence of visible messages. @default true */
  multiMessageReplyEnabled: boolean
}

export type LumiReplyAct
  = | 'answer'
    | 'explain'
    | 'clarify'
    | 'ask'
    | 'comfort'
    | 'tease'
    | 'complain'
    | 'disagree'
    | 'refuse'
    | 'defend'
    | 'set_boundary'
    | 'acknowledge'
    | 'react'
    | 'change_topic'
    | 'stay_silent'
    | (string & {})

export type LumiHelpWillingness = 'eager' | 'normal' | 'reluctant' | 'unwilling' | 'refuse'
export type LumiReplyLength = 'tiny' | 'short' | 'medium' | 'long'

/**
 * Immutable semantic decision produced before Lumi's final wording is generated.
 *
 * The Replyer may change wording and rhythm, but must not alter the stance,
 * refusal, privacy boundary, factual points, or willingness represented here.
 */
export interface LumiReplyIntent {
  /** Whether a visible reply should be emitted. */
  shouldReply: boolean
  /** Optional message being answered in a busy or group timeline. */
  targetMessageId?: string
  /** Social act performed by the reply. */
  replyAct: LumiReplyAct
  /** Compact semantic objective, without chain-of-thought. */
  semanticGoal: string
  /** Facts and conclusions that the final reply must preserve. */
  keyPoints: string[]
  /** Already-authorized references available to the Replyer. */
  referenceInfo: string[]
  /** Relationship stance and current willingness. */
  attitude: {
    towardTarget?: string
    stance?: string
    willingnessToHelp: LumiHelpWillingness
  }
  /** Emotion that must remain visible in wording and reply shape. */
  emotion: {
    primary: string
    intensity: number
    secondary?: string[]
  }
  /** Active defense and refusal policy for this turn. */
  defenseState: {
    active: boolean
    level?: number
    reason?: string
    refusalRequired?: boolean
    prohibitedHelpTypes?: string[]
  }
  /** Desired scene, tone, length, and conversational acts. */
  expressionIntent: {
    focus: string
    scene: string
    tone: string
    desiredLength: LumiReplyLength
    preferredActs: string[]
    avoid: string[]
  }
  /** Constraints the Replyer and any retry must preserve verbatim in meaning. */
  immutableConstraints: string[]
}

export type LearnedExpressionPatternType
  = | 'exact_phrase'
    | 'sentence_pattern'
    | 'rhythm'
    | 'punctuation'
    | 'message_length'
    | 'multi_message_sequence'
    | 'reaction'
    | 'jargon'
    | 'swear'
    | 'exaggeration'
    | (string & {})

export type LearnedExpressionStatus
  = | 'observed'
    | 'understood'
    | 'trial'
    | 'adopted'
    | 'habit'
    | 'declining'
    | 'forgotten'

/** Probabilistic affinity. It influences selection but never grants memory access. */
export interface SocialLanguageAffinity {
  global: number
  byPerson: Record<string, number>
  byConversation: Record<string, number>
  byPlatform: Record<string, number>
}

/**
 * A concrete phrase or reusable speech pattern observed in trusted social input.
 *
 * Origin fields are evidence and selection features. They are not authorization
 * shortcuts and must never be used to reveal the source conversation.
 */
export interface LearnedExpression {
  id: string
  phrase?: string
  situation: string
  pragmaticFunction: string
  emotionalMeaning?: string
  tone?: string
  patternType: LearnedExpressionPatternType
  origin: {
    personId?: string
    conversationId?: string
    platform?: string
    messageIds: string[]
    source: 'human' | 'lumi'
  }
  affinity: SocialLanguageAffinity
  familiarity: number
  ownership: number
  confidence: number
  observationCount: number
  useCount: number
  successfulUseCount: number
  awkwardUseCount: number
  explicitRejectionCount: number
  firstSeenAt: number
  lastSeenAt: number
  lastUsedAt?: number
  embedding?: number[]
  status: LearnedExpressionStatus
}

/** One contextual meaning of a slang or community term. */
export interface JargonMeaning {
  meaning: string
  context: string
  confidence: number
  evidenceMessageIds: string[]
}

/**
 * Pragmatic language knowledge stored separately from factual memory.
 */
export interface JargonKnowledge {
  id: string
  term: string
  meanings: JargonMeaning[]
  literalMeaning?: string
  pragmaticFunctions: string[]
  emotionalTone?: string
  communities?: string[]
  lastSeenAt: number
}

/**
 * Learned social participation behavior, such as staying brief or not joining.
 */
export interface LearnedSocialBehavior {
  id: string
  situation: string
  action: string
  expectedEffect?: string
  originEvidenceIds: string[]
  confidence: number
  affinity: SocialLanguageAffinity
  successCount: number
  failureCount: number
  lastAppliedAt?: number
}

/** A selected expression and the auditable reasons behind its score. */
export interface SelectedExpression {
  expression: LearnedExpression
  score: number
  reasons: string[]
}

/** A selected behavior and the auditable reasons behind its score. */
export interface SelectedSocialBehavior {
  behavior: LearnedSocialBehavior
  score: number
  reasons: string[]
}

/** One visible chat bubble generated by the Replyer. */
export interface LumiVisibleReplyMessage {
  text: string
  delayMs?: number
  quoteMessageId?: string
}

/** Final structured reply emitted by a Lumi host. */
export interface LumiVisibleReply {
  messages: LumiVisibleReplyMessage[]
  /**
   * Expression IDs the Replyer consciousness reports actually applying.
   * This metadata is never rendered as chat content.
   */
  appliedExpressionIds?: string[]
}

/** Later interaction signals used to update expression and behavior weights. */
export interface LumiLanguageFeedback {
  explicitPraise?: boolean
  explicitRejection?: boolean
  phraseEcho?: boolean
  playfulContinuation?: boolean
  normalContinuation?: boolean
  misunderstanding?: boolean
  aiStyleComplaint?: boolean
  correctedMeaning?: string
}

/**
 * Auditable record of one final-language decision.
 */
export interface LanguageDecisionLog {
  id: string
  timestamp: number
  personId?: string
  conversationId: string
  platform: string
  plannerIntent: LumiReplyIntent
  retrievedExpressions: string[]
  /** Candidates injected into Replyer as optional references. */
  selectedExpressions: string[]
  /** Candidates the Replyer reports actually realizing in the sent wording. */
  realizedExpressions?: string[]
  selectedExpressionReasons: Record<string, string[]>
  selectedBehaviors: string[]
  replyerPromptSnapshot?: unknown
  /** Stage-specific projection used for the final wording request. */
  contextProjection?: {
    replyerHistoryTokens: number
    retainedHistoryMessages: number
    omittedHistoryMessages: number
    continuitySummaryIncluded: boolean
  }
  generatedReply: LumiVisibleReply
  actuallySentReply: LumiVisibleReply
  emotionState: unknown
  defenseState: unknown
  relationshipSnapshot?: unknown
  validator: {
    passed: boolean
    attempts: number
    issues: string[]
    fallbackUsed: boolean
  }
  laterFeedback?: LumiLanguageFeedback
}

/** Complete host-persisted state of the social-language subsystem. */
export interface SocialLanguageSnapshot {
  version: 1 | 2 | 3 | 4
  expressions: LearnedExpression[]
  jargon: JargonKnowledge[]
  behaviors: LearnedSocialBehavior[]
  decisions: LanguageDecisionLog[]
  /** Bounded, unprocessed read-only group observations. */
  observationBuffer: SocialLanguageGroupObservation[]
  /** Bounded local monitor history. It never enters chat or memory context. */
  observationHistory: SocialLanguageGroupObservation[]
  /** Bounded audit history; raw message text is deliberately omitted. */
  observationBatches: SocialLanguageObservationBatch[]
  updatedAt: number
  /** Last time inactive expression candidates received lifecycle maintenance. */
  lastMaintenanceAt?: number
}

/** Native chat message passed to the Planner or Replyer. */
export interface LumiLanguageModelMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  name?: string
}

/** Context used by broad expression and behavior retrieval. */
export interface SocialLanguageTurnContext {
  now: number
  personId?: string
  conversationId: string
  platform: string
  conversationType: 'direct' | 'group'
  currentUserText: string
  /** Optional query vector produced by the host's existing embedding service. */
  queryEmbedding?: number[]
  replyIntent: LumiReplyIntent
  emotionTag?: LumiEmotionTag | string
  emotionIntensity?: number
  relationshipCloseness?: number
  defenseActive?: boolean
  /** A relationship or safety gate requires an explicit refusal this turn. */
  refusalRequired?: boolean
  recentAssistantTexts: string[]
}

/** Trusted source metadata for one expression-learning observation. */
export interface SocialLanguageEvidence {
  messageId: string
  text: string
  personId?: string
  conversationId?: string
  platform?: string
  timestamp: number
  source: 'human' | 'lumi'
  sourceKind:
    | 'chat'
    | 'group_chat'
    | 'qq_space'
    | 'system'
    | 'tool'
    | 'planner'
    | 'memory_summary'
    | 'web'
    | 'subtitle'
    | 'forwarded'
    | 'code'
    | 'roleplay'
    | 'unknown'
  authorVerified: boolean
}

/** Runtime policy for AstrBot-backed social-language observation. */
export type SocialLanguageLearningMode = 'normal' | 'observe_only'

/** One group explicitly allowed to provide read-only language observations. */
export interface SocialLanguageGroupSource {
  /** Stable source key, normally `<platform-instance>:<group-id>`. */
  id: string
  platformInstanceId: string
  groupId: string
  displayName: string
  enabled: boolean
  /** Retrieval affinity only; it never bypasses safety or adoption thresholds. */
  priority: 'normal' | 'high'
}

/** A text-only group observation that can never become a chat turn. */
export interface SocialLanguageGroupObservation {
  eventId: string
  messageId: string
  sourceId: string
  platform: string
  platformInstanceId: string
  groupId: string
  senderId: string
  senderName: string
  text: string
  timestamp: number
}

/** Auditable summary of one consumed observation batch. */
export interface SocialLanguageObservationBatch {
  id: string
  sourceId: string
  messageIds: string[]
  messageCount: number
  processedAt: number
  curator: 'model' | 'pending'
  /** Expressions created or updated while consuming this batch. */
  expressionIds: string[]
  /** Jargon entries created or updated while consuming this batch. */
  jargonIds: string[]
  /** Social behaviors created or updated while consuming this batch. */
  behaviorIds: string[]
  /** Safe operational warning, such as model curation falling back. */
  warning?: string
  /** Timestamp at which a later recovery batch successfully covered this batch. */
  recoveredAt?: number
  /** Audit ID of the later recovery batch. */
  recoveryBatchId?: string
}

/** Runtime character data projected from Lumi's existing state, not duplicated. */
export interface LumiReplyCharacterState {
  corePersonality: string
  baseReplyStyle: string
  state?: LumiStateSnapshot | Record<string, unknown>
  emotionSummary: string
  relationshipSummary: string
  defenseSummary: string
}

/** One candidate proposed by a model-backed expression learner. */
export interface LearnedExpressionProposal {
  phrase?: string
  situation: string
  pragmaticFunction: string
  emotionalMeaning?: string
  tone?: string
  patternType: LearnedExpressionPatternType
  confidence: number
}

/** One candidate proposed by a model-backed behavior learner. */
export interface LearnedBehaviorProposal {
  situation: string
  action: string
  expectedEffect?: string
  confidence: number
}

/** One candidate proposed by a model-backed jargon learner. */
export interface JargonKnowledgeProposal {
  term: string
  meaning: string
  context: string
  literalMeaning?: string
  pragmaticFunctions: string[]
  emotionalTone?: string
  communities?: string[]
  confidence: number
}
