import type { DirectPerceptionEnvelope } from '../../input'
import type { MemoryPort } from '../../ports/memory'
import type { ToolSpec } from '../registry'

/**
 * Creates an authorized memory query tool for one direct session.
 */
export function createQueryMemoryTool(options: {
  memory: MemoryPort
  envelope: () => DirectPerceptionEnvelope
}): ToolSpec {
  return {
    name: 'query_memory',
    description: '查询与当前私聊相关且已经授权的 Lumi 有效记忆。',
    explicitInvocationHints: [
      '从记忆里查',
      '从记忆中查',
      '查一查记忆',
      '查询记忆',
      '检索记忆',
    ],
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
    sideEffectType: 'read',
    idempotencyPolicy: 'none',
    requiredScopes: [],
    async handler({ invocation, signal }) {
      const query = typeof invocation.arguments.query === 'string'
        ? invocation.arguments.query.trim()
        : ''
      if (!query) {
        return {
          success: false,
          errorCode: 'INVALID_MEMORY_QUERY',
          errorMessage: 'query_memory.query must be a non-empty string.',
        }
      }
      const envelope = options.envelope()
      const requestedLimit = typeof invocation.arguments.limit === 'number'
        ? Math.floor(invocation.arguments.limit)
        : 6
      const memories = await options.memory.query({
        query,
        personId: envelope.personId,
        conversationId: envelope.conversationId,
        participantPersonIds: envelope.participantPersonIds,
        limit: Math.max(1, Math.min(12, requestedLimit)),
        signal,
      })
      return {
        success: true,
        output: memories
          .filter(memory => memory.status === 'active')
          .map(memory => ({
            id: memory.id,
            content: memory.content,
            scope: memory.scope,
            confidence: memory.confidence,
            provenance: memory.provenance,
            authorizationReason: memory.authorizationReason,
          })),
      }
    },
  }
}
