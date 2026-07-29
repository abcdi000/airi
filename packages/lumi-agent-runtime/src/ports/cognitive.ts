import type { LumiCognitiveContextBundle } from '@proj-airi/lumi-runtime'

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
  /** Original event timestamp. */
  timestamp: number
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
}
