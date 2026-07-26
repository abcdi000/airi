/** Authorized person projection available to a direct Planner turn. */
export interface AgentPersonProfile {
  personId: string
  displayName: string
  facts: readonly string[]
  relationshipState?: string
  shortTermState?: string
  emotionState?: string
}

/**
 * Resolves an already authenticated Lumi person into an authorized projection.
 */
export interface IdentityPort {
  getPersonProfile: (input: {
    personId: string
    conversationId: string
    viewerPersonId: string
  }) => Promise<AgentPersonProfile | undefined>
}
