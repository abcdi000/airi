import type { ToolRegistry } from '../tools/registry'

/** Authenticated direct-session identity available while registering host tools. */
export interface AgentToolsRegistrationContext {
  conversationId: string
  personId: string
  participantPersonIds: readonly string[]
}

/**
 * Host adapter that contributes Tool Mesh, MCP, and plugin tools.
 */
export interface AgentToolsPort {
  registerTools: (
    registry: ToolRegistry,
    context: AgentToolsRegistrationContext,
  ) => Promise<void> | void
}
