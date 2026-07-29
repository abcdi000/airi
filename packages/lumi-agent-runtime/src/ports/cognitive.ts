import type {
  LumiCognitiveContextBundle,
  LumiCognitiveIdentity,
} from '@proj-airi/lumi-runtime'

import type { DirectPerceptionEnvelope } from '../input'

/** One bounded dialogue turn supplied to the host cognitive service. */
export interface CognitiveDialogueTurn {
  /** Dialogue speaker. */
  role: 'user' | 'assistant'
  /** Immutable person for a user turn. */
  personId?: string
  /** Source or outbound message identifiers. */
  messageIds: readonly string[]
  /** Ordered visible text segments. */
  textSegments: readonly string[]
  /** Social-language assets actually involved in an assistant reply. */
  feedbackTargetIds?: readonly string[]
  /** Original event timestamp. */
  timestamp: number
}

/** Immutable context checkpoint supplied to the host medium-loop service. */
export interface CognitiveEpisodeConsolidationInput {
  /** Identity validated during the latest successful cognitive preparation. */
  identity: LumiCognitiveIdentity
  /** Stable dialogue checkpoint identifier. */
  episodeId: string
  /** Model-derived continuity summary. */
  summary: string
  /** Ordered source messages covered by the summary. */
  sourceMessageIds: readonly string[]
  /** ISO timestamp at which Agent Runtime accepted the checkpoint. */
  occurredAt: string
}

/**
 * Host boundary for evidence-backed working memory and automatic shallow recall.
 *
 * The implementation owns persistence, ACL filtering, retrieval, and projection.
 * The Agent Runtime invokes it once before the first Planner request of a turn.
 */
export interface CognitiveContextPort {
  /**
   * Prepares one authorized cognitive bundle without adding a model request.
   *
   * The immutable envelope actor is authoritative. Implementations must not
   * replace it with mutable desktop selection state.
   */
  prepareTurn: (input: {
    envelope: DirectPerceptionEnvelope
    recentTurns: readonly CognitiveDialogueTurn[]
    signal?: AbortSignal
  }) => Promise<LumiCognitiveContextBundle>
  /** Marks memories as used only after their context reached a Planner request. */
  recordContextUse?: (input: {
    envelope: DirectPerceptionEnvelope
    memoryIds: readonly string[]
    hypothesisIds: readonly string[]
    usedAt: string
  }) => Promise<void>
  /** Persists one successful idle compaction as derived episodic cognition. */
  consolidateEpisode?: (input: CognitiveEpisodeConsolidationInput) => Promise<void>
}
