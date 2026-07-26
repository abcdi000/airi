import type { LumiAgentContextMessage } from '../context/messages'

/** Persisted wait state for a direct session. */
export interface PersistedWaitState {
  toolCallId: string
  startedAt: number
  targetSeconds: number
  deadlineAt: number
}

/** Platform-neutral state restored for one direct session. */
export interface PersistedSessionState {
  conversationId: string
  contextEpoch: number
  summaryVersion: number
  stablePrefixHash: string
  dialogueSegmentId: string
  generation: number
  history: readonly LumiAgentContextMessage[]
  waitState?: PersistedWaitState
}

/** Persistence boundary used by desktop and server adapters. */
export interface AgentPersistencePort {
  loadSession: (conversationId: string) => Promise<PersistedSessionState | undefined>
  saveSession: (state: PersistedSessionState) => Promise<void>
}
