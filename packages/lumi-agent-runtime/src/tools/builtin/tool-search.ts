import type { ToolRegistry, ToolSpec } from '../registry'

/**
 * Creates a discovery-only tool for deferred MCP, Tool Mesh, and plugin tools.
 */
export function createToolSearchTool(options: {
  registry: ToolRegistry
  discoveredToolNames: Set<string>
}): ToolSpec {
  return {
    name: 'tool_search',
    description: '按能力查找延迟加载的工具。此工具只返回可用工具信息，不会执行它们。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 12 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    provider: 'lumi-agent-runtime',
    visibility: 'visible',
    stage: 'planner',
    chatScope: 'direct',
    riskLevel: 'low',
    executionMode: 'automatic',
    sideEffectType: 'none',
    idempotencyPolicy: 'none',
    requiredScopes: [],
    async handler({ invocation }) {
      const query = typeof invocation.arguments.query === 'string'
        ? invocation.arguments.query.trim()
        : ''
      if (!query) {
        return {
          success: false,
          errorCode: 'INVALID_TOOL_SEARCH',
          errorMessage: 'tool_search.query must be a non-empty string.',
        }
      }
      const requestedLimit = typeof invocation.arguments.limit === 'number'
        ? Math.floor(invocation.arguments.limit)
        : 5
      const found = options.registry.searchDeferred(query, Math.max(1, Math.min(12, requestedLimit)))
      found.forEach(tool => options.discoveredToolNames.add(tool.name))
      return {
        success: true,
        output: found.map(tool => ({
          name: tool.name,
          description: tool.description,
          provider: tool.provider,
          riskLevel: tool.riskLevel,
          executionMode: tool.executionMode,
        })),
      }
    },
  }
}
