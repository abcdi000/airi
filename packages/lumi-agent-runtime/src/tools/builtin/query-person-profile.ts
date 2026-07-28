import type { DirectPerceptionEnvelope } from '../../input'
import type { IdentityPort } from '../../ports/identity'
import type { ToolSpec } from '../registry'

/**
 * Creates the authorized current-person profile query tool.
 */
export function createQueryPersonProfileTool(options: {
  identity: IdentityPort
  envelope: () => DirectPerceptionEnvelope
}): ToolSpec {
  return {
    name: 'query_person_profile',
    description: '读取当前私聊对象已经授权的人物印象与关系状态。',
    inputSchema: {
      type: 'object',
      properties: {},
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
    async handler() {
      const envelope = options.envelope()
      const profile = await options.identity.getPersonProfile({
        personId: envelope.personId,
        conversationId: envelope.conversationId,
        viewerPersonId: envelope.personId,
      })
      return {
        success: true,
        output: profile ?? null,
      }
    },
  }
}
