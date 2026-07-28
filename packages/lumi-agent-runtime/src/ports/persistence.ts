import type { LumiAgentContextMessage } from '../context/messages'
import type { DirectPerceptionEnvelope } from '../input'
import type { DirectTurnResult } from '../runtime/session-runtime'

/** Continuation required to resume the exact Planner turn after restart. */
export interface PersistedWaitContinuation {
  turnId: string
  generation: number
  plannerRound: number
  envelope: DirectPerceptionEnvelope
  replied: boolean
  sentMessageIds: readonly string[]
}

/** Persisted wait state for a direct session. */
export interface PersistedWaitState {
  toolCallId: string
  startedAt: number
  targetSeconds: number
  deadlineAt: number
  /** Present for waits created by the resumable shared runtime. */
  continuation?: PersistedWaitContinuation
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
  /** Bounded platform-event ledger used to reject duplicate delivery. */
  completedEvents: readonly PersistedDirectEventResult[]
}

/** One completed direct event and its stable public result. */
export interface PersistedDirectEventResult {
  eventId: string
  sourceMessageId: string
  completedAt: number
  result: DirectTurnResult
}

/** Persistence boundary used by desktop and server adapters. */
export interface AgentPersistencePort {
  loadSession: (conversationId: string) => Promise<PersistedSessionState | undefined>
  saveSession: (state: PersistedSessionState) => Promise<void>
  /** Lists only sessions with a pending wait, allowing startup recovery. */
  listWaitingSessionIds?: () => Promise<readonly string[]>
}
