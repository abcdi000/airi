import type { Tool } from '@xsai/shared-chat'

import { ToolRegistry } from '@proj-airi/lumi-agent-runtime'
import { describe, expect, it, vi } from 'vitest'

import { registerRuntimeTools } from './runtimeToolAdapter'

function runtimeTool(
  name: string,
  description: string,
  execute: Tool['execute'],
): Tool {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    execute,
  }
}

describe('runtimeToolAdapter', () => {
  it('registers persistent MCP tools with a five-minute Agent execution budget', async () => {
    const execute = vi.fn(async () => ({ status: 'running' }))
    const registry = new ToolRegistry()
    const count = registerRuntimeTools(registry, {
      mcp: [runtimeTool(
        'mcp_minecraft_follow_entity',
        'This MCP server is configured as long-running. This MCP server is persistent.',
        execute,
      )],
    }, {
      conversationId: 'conversation-1',
      personId: 'doggy',
      participantPersonIds: ['doggy'],
    })

    expect(count).toBe(1)
    expect(registry.get('mcp_minecraft_follow_entity')).toMatchObject({
      provider: 'desktop:mcp',
      timeoutMs: 300_000,
      visibility: 'deferred',
      sideEffectType: 'external',
      idempotencyPolicy: 'required',
    })
    const result = await registry.get('mcp_minecraft_follow_entity')!.handler({
      invocation: {
        callId: 'call-1',
        toolName: 'mcp_minecraft_follow_entity',
        arguments: {},
        idempotencyKey: 'turn:call-1',
      },
      conversationId: 'conversation-1',
      personId: 'doggy',
    })

    expect(result).toMatchObject({
      success: true,
      output: { status: 'running' },
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('preserves structured MCP failures instead of reporting a successful tool call', async () => {
    const registry = new ToolRegistry()
    registerRuntimeTools(registry, {
      mcp: [runtimeTool(
        'mcp_browser_click',
        'Click an element',
        async () => ({
          isError: true,
          content: [{ type: 'text', text: 'target is unavailable' }],
        }),
      )],
    }, {
      conversationId: 'conversation-1',
      personId: 'doggy',
      participantPersonIds: ['doggy'],
    })

    const result = await registry.get('mcp_browser_click')!.handler({
      invocation: {
        callId: 'call-1',
        toolName: 'mcp_browser_click',
        arguments: {},
        idempotencyKey: 'turn:call-1',
      },
      conversationId: 'conversation-1',
      personId: 'doggy',
    })

    expect(result).toMatchObject({
      success: false,
      errorCode: 'HOST_TOOL_FAILED',
      errorMessage: 'target is unavailable',
    })
  })

  it('keeps browser primitives and the MCP directory visible to the Planner', async () => {
    const registry = new ToolRegistry()
    registerRuntimeTools(registry, {
      mcp: [
        runtimeTool('builtIn_mcpListTools', 'List MCP tools', async () => []),
        runtimeTool('mcp_playwright_browser_navigate', 'Navigate browser', async () => ({})),
        runtimeTool('mcp_playwright_browser_snapshot', 'Read browser page', async () => ({})),
        runtimeTool('mcp_playwright_browser_take_screenshot', 'Take screenshot', async () => ({})),
        runtimeTool('mcp_steam_get_owned_games', 'Read Steam games', async () => ({})),
      ],
    }, {
      conversationId: 'conversation-1',
      personId: 'doggy',
      participantPersonIds: ['doggy'],
    })

    expect(registry.get('builtIn_mcpListTools')?.visibility).toBe('visible')
    expect(registry.get('mcp_playwright_browser_navigate')?.visibility).toBe('visible')
    expect(registry.get('mcp_playwright_browser_navigate')?.explicitInvocationHints).toContain('打开浏览器')
    expect(registry.get('mcp_playwright_browser_snapshot')?.visibility).toBe('visible')
    expect(registry.get('mcp_playwright_browser_take_screenshot')?.visibility).toBe('deferred')
    expect(registry.matchExplicitRequests(
      '打开浏览器，用必应搜索 Lumi',
      await registry.listAvailable({
        conversationId: 'conversation-1',
        personId: 'doggy',
        grantedScopes: new Set(),
        runtimeMode: 'maisaka',
      }, { stage: 'planner' }),
    ).map(tool => tool.name)).toEqual(['mcp_playwright_browser_navigate'])
    expect(registry.get('mcp_steam_get_owned_games')?.visibility).toBe('deferred')
  })
})
