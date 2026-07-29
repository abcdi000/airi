import type {
  LumiMemoryFragment,
  LumiMemoryScope,
  LumiMemorySensitivity,
} from '../types'

/** Describes where an evidence record originated and whether it is primary. */
export type LumiCognitiveEvidenceOrigin = 'primary' | 'derived' | 'legacy_import'

/** Host-classified evidence categories shared by Lumi's cognitive domains. */
export type LumiCognitiveEvidenceKind
  = | 'user_statement'
    | 'user_correction'
    | 'observed_behavior'
    | 'tool_result'
    | 'screen_observation'
    | 'lumi_action'
    | 'user_feedback'
    | 'relationship_event'
    | 'conversation_episode'
    | 'legacy_import'

/** Conversation boundary carried by every cognitive record. */
export type LumiCognitiveConversationType = 'direct' | 'group' | 'internal'

/**
 * Auditable evidence shared by working memory, beliefs, long-term memory, and learning assets.
 */
export interface LumiCognitiveEvidence {
  /** Stable evidence identifier. */
  id: string
  /** Immutable actor that produced or authorized the source event. */
  actorId: string
  /** People or Lumi identities described by the evidence. */
  subjectUserIds: string[]
  /** Source conversation when one exists. */
  conversationId?: string
  /** Privacy boundary of the source event. */
  conversationType: LumiCognitiveConversationType
  /** Host-classified source semantics. */
  kind: LumiCognitiveEvidenceKind
  /** Whether this is primary evidence, a derivation, or a legacy import. */
  origin: LumiCognitiveEvidenceOrigin
  /** Evidence content; logs should use a redacted preview rather than this field. */
  content: string
  /** Original message, tool call, or event identifier. */
  sourceId?: string
  /** Original message identifier when the source was a chat message. */
  sourceMessageId?: string
  /** ISO timestamp of the real event. */
  occurredAt: string
  /** Host-normalized trust in the source, from zero to one. */
  trust: number
  /** True only when the ingress adapter verified the author. */
  authorVerified: boolean
  /** Memory access domain assigned by host policy. */
  scope: LumiMemoryScope
  /** Explicit privacy classification. */
  sensitivity: LumiMemorySensitivity
  /** Authorized participants for relationship, group, or private evidence. */
  participantUserIds: string[]
  /** Parent evidence records when this record is derived. */
  derivedFromEvidenceIds: string[]
  /** Optional model or host explanation for a derived conclusion. */
  derivationReason?: string
  /** Schema version used for import and migration. */
  schemaVersion: 1
}

/** A high-certainty entity or pronoun binding retained across nearby turns. */
export interface LumiWorkingEntityBinding {
  /** Entity key used in Planner context. */
  key: string
  /** Canonical or most recent surface form. */
  value: string
  /** Message that established the binding. */
  sourceMessageId: string
  /** ISO timestamp of the latest confirmation. */
  updatedAt: string
  /** ISO expiry time. */
  expiresAt: string
}

/** A short-lived topic, goal, project, state, or open loop. */
export interface LumiWorkingMemoryItem {
  /** Stable item identifier within the conversation. */
  id: string
  /** Human-readable, host-validated content. */
  value: string
  /** Evidence backing this item. */
  evidenceIds: string[]
  /** Messages backing this item. */
  sourceMessageIds: string[]
  /** ISO timestamp of the latest update. */
  updatedAt: string
  /** ISO expiry time. */
  expiresAt: string
}

/** Recall query and results that low-information continuation turns may reuse. */
export interface LumiRecallState {
  /** Contextual query used for the previous automatic recall. */
  query: string
  /** Memory records returned by the previous recall. */
  memoryIds: string[]
  /** Active topics at query time. */
  activeTopics: string[]
  /** Messages used to construct the query. */
  sourceMessageIds: string[]
  /** ISO timestamp of the previous recall. */
  updatedAt: string
  /** ISO expiry time. */
  expiresAt: string
  /** Number of consecutive low-information reuses. */
  reuseCount: number
}

/**
 * Privacy-isolated working-memory projection for one person and conversation.
 */
export interface LumiWorkingMemory {
  /** Schema version used for migration. */
  version: 1
  /** Immutable person for this working state. */
  personId: string
  /** Lumi persona owning the continuous self. */
  personaId: string
  /** Conversation owning the state. */
  conversationId: string
  /** Direct, group, or internal boundary. */
  conversationType: LumiCognitiveConversationType
  /** Most recent topic first. */
  activeTopics: LumiWorkingMemoryItem[]
  /** Older active topics retained for explicit continuation. */
  topicStack: LumiWorkingMemoryItem[]
  /** Entity and pronoun bindings available to the next turn. */
  entityBindings: LumiWorkingEntityBinding[]
  /** Current host-validated goals. */
  goals: LumiWorkingMemoryItem[]
  /** Questions or tasks that remain unresolved. */
  openLoops: LumiWorkingMemoryItem[]
  /** Active projects in the current conversation. */
  projects: LumiWorkingMemoryItem[]
  /** Temporary user states that must not be treated as stable traits. */
  temporaryUserStates: LumiWorkingMemoryItem[]
  /** Current relationship situation, not a stable relationship fact. */
  relationshipContext?: LumiWorkingMemoryItem
  /** Exact semantic continuation point from recent dialogue. */
  continuationPoint?: string
  /** Previous automatic recall state. */
  recallState?: LumiRecallState
  /** Recent source messages retained as provenance. */
  sourceMessageIds: string[]
  /** ISO timestamp of the latest update. */
  updatedAt: string
  /** ISO expiry time for the whole projection. */
  expiresAt: string
}

/** Lifecycle shared by beliefs and learned language or behavior assets. */
export interface LumiCognitiveLifecycle {
  /** Total supporting evidence count. */
  evidenceCount: number
  /** Count of evidence from independent source/time buckets. */
  independentEvidenceCount: number
  /** Current confidence, from zero to one. */
  confidence: number
  /** Familiarity through observation, from zero to one. */
  familiarity: number
  /** Stability across time and correction, from zero to one. */
  stability: number
  /** Learned ownership, from zero to one; never grants access. */
  ownership: number
  /** Explicit positive feedback count. */
  positiveFeedback: number
  /** Explicit negative feedback count. */
  negativeFeedback: number
  /** Explicit rejection count. */
  rejectionCount: number
  /** ISO first observation time. */
  firstSeenAt: string
  /** ISO latest observation time. */
  lastSeenAt: string
  /** ISO latest real use time. */
  lastUsedAt?: string
  /** Natural decay, from zero to one. */
  decay: number
}

/** Status of a temporary or consolidating cognitive hypothesis. */
export type LumiBeliefHypothesisStatus
  = | 'tentative'
    | 'supported'
    | 'stable'
    | 'contradicted'
    | 'expired'

/**
 * Tentative cognition that remains explicitly distinct from stable facts.
 */
export interface LumiBeliefHypothesis extends LumiCognitiveLifecycle {
  /** Stable hypothesis identifier. */
  id: string
  /** Person or Lumi identity described by the hypothesis. */
  subjectId: string
  /** Stable semantic predicate used for conflict and projection. */
  predicate: string
  /** Host-validated JSON-compatible value. */
  value: unknown
  /** Supporting evidence records. */
  evidenceIds: string[]
  /** Evidence contradicting the current value. */
  counterEvidenceIds: string[]
  /** ISO first observation time. */
  firstObservedAt: string
  /** ISO latest observation time. */
  lastObservedAt: string
  /** ISO expiry time when the hypothesis is temporary. */
  expiresAt?: string
  /** Current cognitive status. */
  status: LumiBeliefHypothesisStatus
  /** Access scope inherited from evidence. */
  scope: LumiMemoryScope
  /** Sensitivity inherited from evidence. */
  sensitivity: LumiMemorySensitivity
  /** Conversation source for group-bound hypotheses. */
  conversationId?: string
  /** Authorized participants. */
  participantUserIds: string[]
}

/** Feedback categories emitted by trusted host signals or explicit text. */
export type LumiFeedbackKind
  = | 'explicit_praise'
    | 'explicit_rejection'
    | 'fact_correction'
    | 'expression_natural'
    | 'expression_ai_like'
    | 'expression_repeated'
    | 'topic_continued'
    | 'topic_switched'
    | 'tool_succeeded'
    | 'tool_failed'
    | 'decision_confirmed'
    | 'decision_revoked'

/** One feedback event distributed to domain-specific reducers. */
export interface LumiFeedbackEvent {
  /** Stable feedback identifier. */
  id: string
  /** Immutable actor responsible for this feedback. */
  actorId: string
  /** Conversation in which feedback occurred. */
  conversationId: string
  /** Privacy boundary. */
  conversationType: LumiCognitiveConversationType
  /** Host-classified feedback semantics. */
  kind: LumiFeedbackKind
  /** Source message, tool call, or decision identifier. */
  sourceId: string
  /** Evidence created for the feedback. */
  evidenceId: string
  /** Assets or cognitions that may consume the event. */
  targetIds: string[]
  /** Host-normalized strength, from zero to one. */
  strength: number
  /** ISO event time. */
  occurredAt: string
  /** True only for verified user authors or trusted host tool signals. */
  authorVerified: boolean
  /** Scope that reducers must preserve. */
  scope: LumiMemoryScope
  /** Sensitivity that reducers must preserve. */
  sensitivity: LumiMemorySensitivity
}

/** Profile layer derived from evidence-backed cognition. */
export type LumiCognitiveProfileLayer = 'daily' | 'dynamic' | 'core'

/** Materialized profile projection with complete cognitive lineage. */
export interface LumiCognitiveProfileProjection {
  /** Stable projection identifier. */
  id: string
  /** Person described by the projection. */
  subjectId: string
  /** Profile layer selected by promotion policy. */
  layer: LumiCognitiveProfileLayer
  /** Semantic profile key. */
  key: string
  /** Human-readable projected value. */
  value: string
  /** Source hypothesis identifiers. */
  beliefIds: string[]
  /** Transitive evidence identifiers. */
  evidenceIds: string[]
  /** Current confidence, from zero to one. */
  confidence: number
  /** Current stability, from zero to one. */
  stability: number
  /** ISO expiry time for Daily or Dynamic projections. */
  expiresAt?: string
  /** Whether host or human review is required before activation. */
  status: 'active' | 'pending'
  /** Access scope inherited from cognition. */
  scope: LumiMemoryScope
  /** Sensitivity inherited from cognition. */
  sensitivity: LumiMemorySensitivity
  /** ISO projection update time. */
  updatedAt: string
}

/** Immutable identity and privacy boundary for one cognitive assembly. */
export interface LumiCognitiveIdentity {
  /** Person whose turn is being processed. */
  actorId: string
  /** Lumi persona serving the turn. */
  personaId: string
  /** Current conversation. */
  conversationId: string
  /** Direct, group, or internal boundary. */
  conversationType: LumiCognitiveConversationType
  /** Verified participants in the current conversation. */
  participantUserIds: string[]
}

/** Observable trace for one automatic shallow recall. */
export interface LumiRecallTrace {
  /** Whether shallow recall ran for this turn. */
  ran: boolean
  /** Redacted query fingerprint or debug query when prompt logging is enabled. */
  query?: string
  /** Why the query was built or reused. */
  queryReason?: string
  /** Whether the previous RecallState was reused. */
  reusedPreviousState: boolean
  /** Candidate count before ACL filtering. */
  aclInputCount: number
  /** Candidate count after ACL filtering. */
  aclOutputCount: number
  /** Lexical/FTS candidate count. */
  lexicalCandidateCount: number
  /** ANN candidate count. */
  annCandidateCount: number
  /** Unique candidate count after merging. */
  mergedCandidateCount: number
  /** Candidate count after intent-aware ranking. */
  rerankedCandidateCount: number
  /** Number removed below confidence or relevance thresholds. */
  thresholdRejectedCount: number
  /** Number removed because they were contradicted or superseded. */
  conflictRejectedCount: number
  /** Number injected into Planner context. */
  injectedCount: number
  /** Total recall time. */
  durationMs: number
  /** Query embedding time. */
  embeddingDurationMs?: number
  /** ANN backend health summary. */
  vectorIndexStatus?: string
  /** Safe fallback reason when semantic retrieval failed. */
  fallbackReason?: string
}

/**
 * Single deduplicated cognitive projection consumed by Planner and Replyer.
 */
export interface LumiCognitiveContextBundle {
  /** Immutable identity used for every ACL decision. */
  identity: LumiCognitiveIdentity
  /** Conversation-scoped working state. */
  workingMemory: LumiWorkingMemory
  /** Stable semantic memories authorized for this turn. */
  stableFacts: LumiMemoryFragment[]
  /** Explicitly uncertain, non-expired hypotheses. */
  tentativeImpressions: LumiBeliefHypothesis[]
  /** Relevant episodic memories authorized for this turn. */
  relevantEpisodes: LumiMemoryFragment[]
  /** Materialized profile projection, omitted in group conversations. */
  userProfileProjection: {
    communicationPreferences: LumiCognitiveProfileProjection[]
    stableGoals: LumiCognitiveProfileProjection[]
    relevantTraits: LumiCognitiveProfileProjection[]
    currentState: LumiCognitiveProfileProjection[]
  }
  /** Relationship state for direct conversations only. */
  relationshipState?: unknown
  /** Current Lumi emotion projection. */
  currentEmotion?: unknown
  /** Evidence-backed interaction strategies. */
  interactionStrategies: string[]
  /** Selected expression assets available only to Replyer wording. */
  expressionAssets: string[]
  /** Contradiction notices Planner must resolve rather than flatten. */
  contradictions: string[]
  /** Automatic recall observability. */
  recallTrace: LumiRecallTrace
  /** Explicit feedback persisted this turn, routed by stable asset IDs. */
  feedbackEvents: LumiFeedbackEvent[]
}
