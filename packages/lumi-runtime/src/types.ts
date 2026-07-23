/**
 * Stable persona anchor migrated from Lumi.
 *
 * The anchor is long-lived identity data. Stages may read it to compose UI or
 * prompts, but user messages must not mutate it directly.
 */
export interface LumiPersonaAnchor {
  /** Stable persona id. */
  id: string
  /** Human-facing persona name. */
  name: string
  /** Migration-safe version for this anchor. */
  version: string
  /** Core identity summary, with unsafe source text removed. */
  identity: string
  /** Preferred user address and relationship framing. */
  relationshipToUser: LumiRelationshipToUser
  /** Stable traits that should survive stage/provider changes. */
  coreTraits: string[]
  /** Worldview and continuity rules. */
  worldview: string[]
  /** Speech style and emotion-dependent language hints. */
  speechStyle: LumiSpeechStyle
  /** Non-negotiable persona boundaries. */
  boundaries: string[]
  /** High-level emotion behavior map. */
  emotionalPatterns: Record<LumiEmotionTag, string>
  /** Rule for long-term growth without single-turn persona overwrite. */
  growthRule: string
}

/** User relationship framing for Lumi. */
export interface LumiRelationshipToUser {
  /** Preferred nickname Lumi uses for the user. */
  primaryAddress: string
  /** Meaning of the relationship, excluding real-world kinship or sexual framing. */
  meaning: string
  /** Attachment and boundary style. */
  attachmentStyle: string
}

/** Speech-style hints that can feed a prompt composer. */
export interface LumiSpeechStyle {
  /** Overall tone summary. */
  tone: string
  /** Preferred sentence length. */
  sentenceLength: string
  /** Markdown usage preference. */
  usesMarkdown: 'never' | 'rarely' | 'sometimes' | 'often'
  /** Emoji usage preference. */
  usesEmojis: 'never' | 'rarely' | 'sometimes' | 'often'
  /** Emotion-specific language habits. */
  languageHabits: Partial<Record<LumiEmotionTag, string[]>>
  /** Recurrent anti-patterns to avoid in casual chat. */
  avoid: string[]
}

export type LumiEmotionTag
  = | 'neutral'
    | 'warm'
    | 'happy'
    | 'curious'
    | 'sad'
    | 'anxious'
    | 'defensive'
    | 'angry'
    | 'tired'

/** Runtime mood vector used by state, prompt, and avatar expression adapters. */
export interface LumiMoodVector {
  valence: number
  arousal: number
  stress: number
  irritation: number
  fatigue: number
  warmth: number
  defensiveness: number
  curiosity: number
  sadness: number
  sensitivity: number
}

/** Relationship continuity vector migrated from Lumi's state engine. */
export interface LumiRelationshipVector {
  relationshipScore: number
  trust: number
  familiarity: number
  attachment: number
  recentConflict: boolean
  lastConflictSummary?: string
  conflictCooldownTurns: number
  unresolvedConflict: boolean
  repairRequired: boolean
  hurt: number
  resentment: number
  topicShiftResistance: number
}

/** State snapshot consumed by runtime, debug panels, and avatar adapters. */
export interface LumiStateSnapshot {
  personaId: string
  userId: string
  mood: LumiMoodVector
  relationship: LumiRelationshipVector
  dominantEmotion: LumiEmotionTag
  updatedAt: string
}

export type LumiMemoryType
  = | 'user_preference'
    | 'user_fact'
    | 'persona_fact'
    | 'relationship_event'
    | 'shared_event'
    | 'persona_preference'
    | 'conflict_event'
    | 'promise'
    | 'project_context'
    | 'temporary_context'
    | 'emotional_echo'

export type LumiMemoryStatus
  = | 'candidate'
    | 'active'
    | 'rejected'
    | 'contradicted'
    | 'archived'

export type LumiMemoryScope = 'global' | 'shared' | 'relationship' | 'group' | 'private'
export type LumiMemoryOwnerType = 'lumi' | 'user' | 'group'
export type LumiMemoryVisibility = 'global' | 'shared' | 'participants' | 'private'
export type LumiMemorySensitivity = 'normal' | 'private'
export type LumiMemorySourceConversationType = 'direct' | 'group' | 'manual' | 'import'

/** Memory fragment contract preserving Lumi's SQLite-authority semantics. */
export interface LumiMemoryFragment {
  id: string
  userId: string
  personaId: string
  conversationId?: string
  type: LumiMemoryType
  content: string
  sourceMessageId?: string
  confidence: number
  importance: number
  emotionalIntensity: number
  relationshipRelevance: number
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
  decay: number
  tags: string[]
  status: LumiMemoryStatus
  /** Access domain. Missing legacy values are normalized to `relationship`. */
  scope?: LumiMemoryScope
  /** Entity that owns the memory independently of who may read it. */
  ownerType?: LumiMemoryOwnerType
  /** Lumi persona, user, or group identifier matching {@link ownerType}. */
  ownerId?: string
  /** Disclosure policy used in prompt and channel projections. */
  visibility?: LumiMemoryVisibility
  /** Users allowed to retrieve participant/private memories. */
  participantUserIds?: string[]
  /** People or personas described by the memory. */
  subjectUserIds?: string[]
  /** Explicit privacy marker; private memories never cross relationship boundaries. */
  sensitivity?: LumiMemorySensitivity
  /** User whose trusted turn supplied the source evidence. */
  sourceActorId?: string
  /** Conversation surface from which the evidence originated. */
  sourceConversationType?: LumiMemorySourceConversationType
  /** Host policy explanation for the final ownership and access scope. */
  classificationReason?: string
  /** Human-auditable explanation of whether this memory may cross relationships. */
  disclosureReason?: string
}

/** User profile summary kept separate from persona identity. */
export interface LumiUserProfile {
  userId: string
  personaId: string
  nickname?: string
  stablePreferences: string[]
  dislikes: string[]
  relationshipToPersona?: string
  communicationStylePreference?: string
  importantProjects: string[]
  boundaries: string[]
  updatedAt?: string
}

export type LumiImageType
  = | 'photo'
    | 'screenshot'
    | 'meme'
    | 'document'
    | 'artwork'
    | 'object'
    | 'animal'
    | 'food'
    | 'game'
    | 'anime'
    | 'unknown'

export type LumiImageRole
  = | 'context'
    | 'question_target'
    | 'reaction'
    | 'reference'
    | 'main_subject'
    | 'supporting_context'
    | 'reaction_meme'
    | 'evidence'
    | 'decoration'
    | 'unknown'

/** Structured result from a vision provider before text-response generation. */
export interface LumiImageUnderstandingResult {
  imageType: LumiImageType
  imageRole: LumiImageRole
  description: string
  objects: string[]
  scene?: string
  visibleText: string[]
  emotionTone?: string
  shouldExplicitlyMentionImage: boolean
  safetyRisk?: string
  confidence: number
  answerHint?: string
  textImageDependency: boolean
  visualTask?: string
  focusTargets: string[]
  userVisualQuestion?: string
  model: string
}

/** Request shape for a future Lumi runtime orchestrator. */
export interface LumiRuntimeRequest {
  userId: string
  personaId: string
  conversationId?: string
  message: string
  state?: LumiStateSnapshot
  userProfile?: LumiUserProfile
  memories: LumiMemoryFragment[]
  images: LumiImageUnderstandingResult[]
}

/** Response shape from a future Lumi runtime orchestrator. */
export interface LumiRuntimeResponse {
  conversationId: string
  messageId: string
  text: string
  state?: LumiStateSnapshot
  candidateMemories: LumiMemoryFragment[]
  debug?: LumiRuntimeDebugPayload
}

/** Provider payload debug data with secret-bearing fields removed. */
export interface LumiRuntimeDebugPayload {
  textProvider?: SanitizedProviderPayload
  visionProvider?: SanitizedProviderPayload
  promptPreview?: string
}

/** Sanitized provider payload ready for debug panels and logs. */
export interface SanitizedProviderPayload {
  providerId: string
  model?: string
  baseUrl?: string
  headers?: Record<string, string>
  body?: unknown
}

/** Minimal MemoryDriver contract for adapters over SQLite/Chroma or future stores. */
export interface LumiMemoryDriver {
  search: (query: LumiMemorySearchRequest) => Promise<LumiMemoryFragment[]>
  remember: (fragment: LumiMemoryFragment) => Promise<LumiMemoryFragment>
  update: (memoryId: string, patch: Partial<LumiMemoryFragment>) => Promise<LumiMemoryFragment>
  forget: (memoryId: string) => Promise<LumiMemoryFragment>
  reindex: () => Promise<void>
}

/** Search request for memory retrieval. */
export interface LumiMemorySearchRequest {
  query: string
  userId: string
  personaId: string
  limit: number
  /** Immutable conversation boundary used to enforce direct/group disclosure policy. */
  conversationType: 'direct' | 'group'
  statuses?: LumiMemoryStatus[]
  types?: LumiMemoryType[]
  /** User whose access rights are evaluated; defaults to {@link userId}. */
  viewerUserId?: string
  /** Current conversation; required for group-scoped recall. */
  conversationId?: string
  /** Known participants in the current conversation. */
  participantUserIds?: string[]
}

/** Candidate memory produced before Lumi's status/contradiction gate. */
export interface LumiMemoryCandidate {
  type: LumiMemoryType
  content: string
  sourceMessageId?: string
  confidence: number
  importance: number
  emotionalIntensity: number
  relationshipRelevance: number
  decay: number
  tags: string[]
  status: Extract<LumiMemoryStatus, 'candidate'>
  reason: string
  scope?: LumiMemoryScope
  visibility?: LumiMemoryVisibility
  participantUserIds?: string[]
  subjectUserIds?: string[]
  sensitivity?: LumiMemorySensitivity
}

/** Detailed memory score matching Lumi's retrieval ranker. */
export interface LumiRankedMemory {
  memory: LumiMemoryFragment
  finalScore: number
  scoreBreakdown: {
    semanticScore: number
    vectorScore: number
    lexicalScore: number
    keywordScore: number
    importance: number
    recencyScore: number
    emotionalIntensity: number
    relationshipRelevance: number
    confidence: number
  }
}

export interface LumiMemoryRoute {
  preferredTypes: LumiMemoryType[]
  queryIntent: 'memory_recall' | 'conflict_context' | 'boundary_pressure' | 'project_context' | 'casual' | 'unknown'
  reason: string
}

export interface LumiMemoryRetrievalResult {
  route: LumiMemoryRoute
  rankedMemories: LumiRankedMemory[]
  vectorUsed: boolean
  vectorSource?: 'external' | 'deterministic' | 'disabled'
  vectorFallback?: string
  vectorScores: Record<string, number>
}
