import type { ToolRegistry } from '../tools/registry'

/**
 * Host adapter that contributes Tool Mesh, MCP, and plugin tools.
 */
export interface AgentToolsPort {
  registerTools: (registry: ToolRegistry) => Promise<void> | void
}
