import { ToolRegistry } from '@proj-airi/lumi-agent-runtime'
import { describe, expect, it, vi } from 'vitest'

import { createServerAgentToolsPort } from './agentTools'

describe('serverAgentTools', () => {
  it('registers existing MCP/plugin tools as deferred host-executed tools', async () => {
    const execute = vi.fn(async () => ({ value: 42 }))
    const port = createServerAgentToolsPort({
      async toolsFor(request) {
        expect(request.actorPersonId).toBe('person-1')
        expect(request.conversationId).toBe('conversation-1')
        return [{
          type: 'function',
          function: {
            name: 'mcp_example_read',
            description: 'Read one value',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
          execute,
        }]
      },
    })
    const registry = new ToolRegistry()
    await port.registerTools(registry, {
      conversationId: 'conversation-1',
      personId: 'person-1',
      participantPersonIds: ['person-1'],
    })

    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]).toMatchObject({
      name: 'mcp_example_read',
      visibility: 'deferred',
      chatScope: 'direct',
      sideEffectType: 'read',
      timeoutMs: 180_000,
    })
    const result = await registry.list()[0]!.handler({
      invocation: {
        callId: 'call-1',
        toolName: 'mcp_example_read',
        arguments: {},
        idempotencyKey: 'event:call-1',
      },
      conversationId: 'conversation-1',
      personId: 'person-1',
    })

    expect(result).toMatchObject({ success: true, output: { value: 42 } })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('keeps persistent server tools available for bounded long-running calls', async () => {
    const port = createServerAgentToolsPort({
      async toolsFor() {
        return [{
          type: 'function',
          function: {
            name: 'mcp_minecraft_follow_entity',
            description: 'This MCP server is configured as long-running. This MCP server is persistent.',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
          execute: vi.fn(async () => ({ status: 'running' })),
        }]
      },
    })
    const registry = new ToolRegistry()

    await port.registerTools(registry, {
      conversationId: 'conversation-1',
      personId: 'person-1',
      participantPersonIds: ['person-1'],
    })

    expect(registry.get('mcp_minecraft_follow_entity')).toMatchObject({
      timeoutMs: 300_000,
      sideEffectType: 'external',
    })
  })
})
