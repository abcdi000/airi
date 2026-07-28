import type { ToolSpec } from './registry'

import { describe, expect, it } from 'vitest'

import { ToolRegistry } from './registry'

function tool(inputSchema: Readonly<Record<string, unknown>>): ToolSpec {
  return {
    name: 'read_current_state',
    description: 'Read state',
    inputSchema,
    provider: 'test',
    visibility: 'visible',
    stage: 'planner',
    chatScope: 'direct',
    riskLevel: 'low',
    executionMode: 'automatic',
    sideEffectType: 'read',
    idempotencyPolicy: 'none',
    requiredScopes: [],
    async handler() {
      return { success: true }
    },
  }
}

/**
 * @example
 * describe('tool registry JSON Schema normalization', () => {})
 */
describe('tool registry JSON Schema normalization', () => {
  /**
   * @example
   * it('normalizes an empty legacy schema to a root object', () => {})
   */
  it('normalizes an empty legacy schema to a root object', () => {
    const registry = new ToolRegistry()
    registry.register(tool({}))

    expect(registry.get('read_current_state')?.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    })
  })

  /**
   * @example
   * it('converts legacy shorthand fields into JSON Schema properties', () => {})
   */
  it('converts legacy shorthand fields into JSON Schema properties', () => {
    const registry = new ToolRegistry()
    registry.register(tool({
      query: 'string',
      limit: 'number?',
      tags: 'string[]?',
    }))

    expect(registry.get('read_current_state')?.inputSchema).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['query'],
      additionalProperties: false,
    })
  })

  /**
   * @example
   * it('matches only tools explicitly requested by the current message', () => {})
   */
  it('matches only tools explicitly requested by the current message', async () => {
    const registry = new ToolRegistry()
    registry.register({
      ...tool({}),
      name: 'query_memory',
      explicitInvocationHints: ['从记忆里查', '查询记忆'],
    })
    registry.register({
      ...tool({}),
      name: 'reply',
    })
    const context = {
      conversationId: 'conversation-1',
      personId: 'person-1',
      grantedScopes: new Set<string>(),
      runtimeMode: 'maisaka' as const,
    }
    const available = await registry.listAvailable(context)

    expect(
      registry.matchExplicitRequests('你从记忆里查一查生日', available)
        .map(spec => spec.name),
    ).toEqual(['query_memory'])
    expect(
      registry.matchExplicitRequests('直接回复我', available)
        .map(spec => spec.name),
    ).toEqual([])
    expect(
      registry.matchExplicitRequests('请调用 query_memory', available)
        .map(spec => spec.name),
    ).toEqual(['query_memory'])
  })
})
