import { describe, expect, it } from 'vitest'

import { LumiServerMcpRegistry } from './mcpRegistry'

describe('lumiServerMcpRegistry', () => {
  it('keeps consciousness available when one optional MCP executable is missing', async () => {
    const registry = new LumiServerMcpRegistry('test')
    try {
      await registry.apply({
        mcpServers: {
          broken: {
            command: 'lumi-command-that-does-not-exist',
            enabled: true,
            startupMode: 'on_first_use',
          },
        },
      })

      const tools = await registry.toolsFor({
        conversationId: 'conversation',
        conversationType: 'direct',
        actorPersonId: 'doggy',
        actorDisplayName: 'Doggy',
        participantPersonIds: ['doggy'],
        messages: [],
        memories: [],
        personStates: [],
      })

      expect(tools).toEqual([])
      expect(registry.statusesSnapshot()[0]?.state).toBe('error')
      expect(registry.statusesSnapshot()[0]?.lastError).toBeTruthy()
    }
    finally {
      await registry.stopAll()
    }
  })
})
