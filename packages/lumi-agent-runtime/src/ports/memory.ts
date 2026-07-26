/** Memory scopes understood by the shared Lumi Agent Runtime. */
export type AgentMemoryScope = 'private_person' | 'direct_shared' | 'lumi_self' | 'group_public' | 'global'

/** Lifecycle states returned by the authoritative memory store. */
export type AgentMemoryStatus = 'candidate' | 'active' | 'rejected' | 'contradicted' | 'archived'

/** One authorized memory projection returned to the Planner. */
export interface AgentMemoryReference {
  id: string
  content: string
  scope: AgentMemoryScope
  status: AgentMemoryStatus
  confidence: number
  provenance: Readonly<Record<string, unknown>>
  authorizationReason: string
}

/**
 * Adapts the existing Lumi memory system without exposing a concrete database.
 */
export interface MemoryPort {
  query: (input: {
    query: string
    personId: string
    conversationId: string
    participantPersonIds: readonly string[]
    scopes?: readonly AgentMemoryScope[]
    limit: number
    signal?: AbortSignal
  }) => Promise<readonly AgentMemoryReference[]>
}
