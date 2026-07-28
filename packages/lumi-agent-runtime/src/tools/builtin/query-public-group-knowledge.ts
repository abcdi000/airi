import type { DirectPerceptionEnvelope } from '../../input'
import type { MemoryPort } from '../../ports/memory'
import type { ToolSpec } from '../registry'

/**
 * Creates the explicit public-group-knowledge query tool.
 */
export function createQueryPublicGroupKnowledgeTool(options: {
  memory: MemoryPort
  envelope: () => DirectPerceptionEnvelope
}): ToolSpec {
  return {
    name: 'query_public_group_knowledge',
    description: '查询从已授权群聊中学到的公开知识，不暴露群聊原文。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 8 },
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
          errorCode: 'INVALID_PUBLIC_KNOWLEDGE_QUERY',
          errorMessage: 'query_public_group_knowledge.query must be a non-empty string.',
        }
      }
      const envelope = options.envelope()
      const requestedLimit = typeof invocation.arguments.limit === 'number'
        ? Math.floor(invocation.arguments.limit)
        : 4
      const references = await options.memory.query({
        query,
        personId: envelope.personId,
        conversationId: envelope.conversationId,
        participantPersonIds: envelope.participantPersonIds,
        scopes: ['group_public'],
        limit: Math.max(1, Math.min(8, requestedLimit)),
        signal,
      })
      return {
        success: true,
        output: references
          .filter(reference => reference.scope === 'group_public' && reference.status === 'active')
          .map(reference => ({
            id: reference.id,
            content: reference.content,
            confidence: reference.confidence,
            provenance: reference.provenance,
            authorizationReason: reference.authorizationReason,
          })),
      }
    },
  }
}
