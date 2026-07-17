import type { JsonSchema } from 'xsschema'

import { describe, expect, it, vi } from 'vitest'

import { createMcpRuntimeTools, mcp } from './mcp'

describe('tools mcp schema', () => {
  it('emits strict parameter objects', async () => {
    const tools = await mcp()
    for (const name of ['builtIn_mcpListTools', 'builtIn_mcpCallTool']) {
      const t = tools.find(entry => entry.function.name === name)
      expect(t, `missing tool: ${name}`).toBeDefined()
      expect(t?.function.parameters.additionalProperties).toBe(false)
    }
  })

  it('builtIn_mcpCallTool uses flat name+arguments schema', async () => {
    const tools = await mcp()
    const callTool = tools.find(entry => entry.function.name === 'builtIn_mcpCallTool')
    expect(callTool).toBeDefined()

    const props = (callTool!.function.parameters as JsonSchema).properties!
    expect((props.name as JsonSchema).type).toBe('string')
    expect((props.arguments as JsonSchema).type).toBe('string')
  })

  it('registers MCP direct tool aliases for common separator mistakes', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'listed entities' }],
    }))
    const tools = await createMcpRuntimeTools({
      listTools: async () => [
        {
          serverName: 'minecraft',
          name: 'minecraft::list-entities',
          toolName: 'list-entities',
          description: 'List nearby entities.',
          inputSchema: {
            type: 'object',
            properties: {
              type: { type: 'string' },
            },
          },
        },
      ],
      callTool,
    })

    expect(tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining([
      'mcp_minecraft_list-entities',
      'mcp_minecraft-list-entities',
      'mcp_minecraft_list_entities',
    ]))

    const aliasTool = tools.find(tool => tool.function.name === 'mcp_minecraft-list-entities')
    const result = await aliasTool?.execute({ type: 'player' }, {
      messages: [],
      toolCallId: 'call-1',
    })

    expect(callTool).toHaveBeenCalledOnce()
    expect(callTool).toHaveBeenCalledWith({
      name: 'minecraft::list-entities',
      arguments: { type: 'player' },
    })
    expect(result).toEqual({
      content: [{ type: 'text', text: 'listed entities' }],
    })
  })

  it('keeps Computer Use results bounded before they re-enter model context', async () => {
    const tools = await createMcpRuntimeTools({
      listTools: async () => [{
        serverName: 'computer_use',
        name: 'computer_use::desktop_observe',
        toolName: 'desktop_observe',
        inputSchema: { type: 'object', properties: {} },
      }],
      callTool: async () => ({
        content: [
          { type: 'image', data: 'x'.repeat(100_000), mimeType: 'image/png' },
          { type: 'text', text: 'candidate '.repeat(2_000) },
        ],
        structuredContent: { candidates: Array.from({ length: 32 }, (_, index) => ({ index, label: 'target' })) },
      }),
    })

    const observe = tools.find(tool => tool.function.name === 'mcp_computer_use_desktop_observe')
    const result = await observe?.execute({}, { messages: [], toolCallId: 'call-computer-use' }) as any

    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('screenshot retained')
    expect(result.content[1].text.length).toBeLessThanOrEqual(6_000)
    expect(result.structuredContent.candidates).toHaveLength(17)
  })

  it('automatically snapshots browser state after browser navigation tools', async () => {
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'playwright::browser_navigate') {
        return {
          content: [{ type: 'text', text: 'navigated' }],
        }
      }
      if (name === 'playwright::browser_wait') {
        return {
          content: [{ type: 'text', text: 'waited' }],
        }
      }
      if (name === 'playwright::browser_snapshot') {
        return {
          content: [{ type: 'text', text: 'Page title: Wikipedia' }],
        }
      }
      throw new Error(`Unexpected MCP tool: ${name}`)
    })
    const tools = await createMcpRuntimeTools({
      listTools: async () => [
        {
          serverName: 'playwright',
          name: 'playwright::browser_navigate',
          toolName: 'browser_navigate',
          description: 'Navigate browser.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string' },
            },
          },
        },
        {
          serverName: 'playwright',
          name: 'playwright::browser_wait',
          toolName: 'browser_wait',
          description: 'Wait for a specified time.',
          inputSchema: {
            type: 'object',
            properties: {
              time: { type: 'number' },
            },
          },
        },
        {
          serverName: 'playwright',
          name: 'playwright::browser_snapshot',
          toolName: 'browser_snapshot',
          description: 'Snapshot browser.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
      callTool,
    })

    const navigateTool = tools.find(tool => tool.function.name === 'mcp_playwright_browser_navigate')
    const result = await navigateTool?.execute({ url: 'https://wikipedia.org' }, {
      messages: [],
      toolCallId: 'call-1',
    })

    expect(callTool).toHaveBeenNthCalledWith(1, {
      name: 'playwright::browser_navigate',
      arguments: { url: 'https://wikipedia.org' },
    })
    expect(callTool).toHaveBeenNthCalledWith(2, {
      name: 'playwright::browser_wait',
      arguments: { time: 2 },
    })
    expect(callTool).toHaveBeenNthCalledWith(3, {
      name: 'playwright::browser_snapshot',
      arguments: {},
    })
    expect(result).toEqual(expect.objectContaining({
      toolResult: {
        content: [{ type: 'text', text: 'navigated' }],
      },
      followUpSnapshot: {
        target: 'playwright::browser_snapshot',
        result: {
          content: [{ type: 'text', text: 'Page title: Wikipedia' }],
        },
      },
    }))
  })

  it('automatically snapshots after non-navigation browser state changes', async () => {
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'playwright::browser_tabs') {
        return {
          content: [{ type: 'text', text: 'selected tab' }],
        }
      }
      if (name === 'playwright::browser_wait') {
        return {
          content: [{ type: 'text', text: 'waited' }],
        }
      }
      if (name === 'playwright::browser_snapshot') {
        return {
          content: [{ type: 'text', text: 'Snapshot after tab switch' }],
        }
      }
      throw new Error(`Unexpected MCP tool: ${name}`)
    })
    const tools = await createMcpRuntimeTools({
      listTools: async () => [
        {
          serverName: 'playwright',
          name: 'playwright::browser_tabs',
          toolName: 'browser_tabs',
          description: 'List, create, close, or select browser tabs.',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              index: { type: 'number' },
            },
          },
        },
        {
          serverName: 'playwright',
          name: 'playwright::browser_wait',
          toolName: 'browser_wait',
          description: 'Wait for a specified time.',
          inputSchema: {
            type: 'object',
            properties: {
              time: { type: 'number' },
            },
          },
        },
        {
          serverName: 'playwright',
          name: 'playwright::browser_snapshot',
          toolName: 'browser_snapshot',
          description: 'Snapshot browser.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
      callTool,
    })

    const tabsTool = tools.find(tool => tool.function.name === 'mcp_playwright_browser_tabs')
    const result = await tabsTool?.execute({ action: 'select', index: 1 }, {
      messages: [],
      toolCallId: 'call-1',
    })

    expect(callTool).toHaveBeenNthCalledWith(1, {
      name: 'playwright::browser_tabs',
      arguments: { action: 'select', index: 1 },
    })
    expect(callTool).toHaveBeenNthCalledWith(2, {
      name: 'playwright::browser_wait',
      arguments: { time: 2 },
    })
    expect(callTool).toHaveBeenNthCalledWith(3, {
      name: 'playwright::browser_snapshot',
      arguments: {},
    })
    expect(result).toEqual(expect.objectContaining({
      followUpSnapshot: {
        target: 'playwright::browser_snapshot',
        result: {
          content: [{ type: 'text', text: 'Snapshot after tab switch' }],
        },
      },
    }))
  })

  it('suppresses duplicate browser mutations with the same arguments', async () => {
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'playwright::browser_type') {
        return {
          content: [{ type: 'text', text: 'typed' }],
        }
      }
      if (name === 'playwright::browser_wait') {
        return {
          content: [{ type: 'text', text: 'waited' }],
        }
      }
      if (name === 'playwright::browser_snapshot') {
        return {
          content: [{ type: 'text', text: 'Snapshot after type' }],
        }
      }
      throw new Error(`Unexpected MCP tool: ${name}`)
    })
    const tools = await createMcpRuntimeTools({
      listTools: async () => [
        {
          serverName: 'playwright',
          name: 'playwright::browser_type',
          toolName: 'browser_type',
          description: 'Type text into browser.',
          inputSchema: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              text: { type: 'string' },
            },
          },
        },
        {
          serverName: 'playwright',
          name: 'playwright::browser_wait',
          toolName: 'browser_wait',
          description: 'Wait for a specified time.',
          inputSchema: {
            type: 'object',
            properties: {
              time: { type: 'number' },
            },
          },
        },
        {
          serverName: 'playwright',
          name: 'playwright::browser_snapshot',
          toolName: 'browser_snapshot',
          description: 'Snapshot browser.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
      callTool,
    })

    const typeTool = tools.find(tool => tool.function.name === 'mcp_playwright_browser_type')
    const args = { ref: 'textbox-1', text: '今天是不是不开心' }
    const first = await typeTool?.execute(args, {
      messages: [],
      toolCallId: 'call-1',
    })
    const second = await typeTool?.execute({ text: '今天是不是不开心', ref: 'textbox-1' }, {
      messages: [],
      toolCallId: 'call-2',
    })

    expect(callTool.mock.calls.filter(call => call[0].name === 'playwright::browser_type')).toHaveLength(1)
    expect(callTool).toHaveBeenNthCalledWith(1, {
      name: 'playwright::browser_type',
      arguments: args,
    })
    expect(first).toEqual(expect.objectContaining({
      toolResult: {
        content: [{ type: 'text', text: 'typed' }],
      },
    }))
    expect(second).toEqual(expect.objectContaining({
      toolResult: expect.objectContaining({
        structuredContent: expect.objectContaining({
          status: 'duplicate_browser_mutation_suppressed',
          target: 'playwright::browser_type',
        }),
      }),
      followUpSnapshot: {
        target: 'playwright::browser_snapshot',
        result: {
          content: [{ type: 'text', text: 'Snapshot after type' }],
        },
      },
    }))
  })

  it('collapses adjacent repeated text inside a single browser_type call', async () => {
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'playwright::browser_type') {
        return {
          content: [{ type: 'text', text: 'typed' }],
        }
      }
      if (name === 'playwright::browser_wait') {
        return {
          content: [{ type: 'text', text: 'waited' }],
        }
      }
      if (name === 'playwright::browser_snapshot') {
        return {
          content: [{ type: 'text', text: 'Snapshot after type' }],
        }
      }
      throw new Error(`Unexpected MCP tool: ${name}`)
    })
    const tools = await createMcpRuntimeTools({
      listTools: async () => [
        {
          serverName: 'playwright',
          name: 'playwright::browser_type',
          toolName: 'browser_type',
          description: 'Type text into browser.',
          inputSchema: {
            type: 'object',
            properties: {
              ref: { type: 'string' },
              text: { type: 'string' },
            },
          },
        },
        {
          serverName: 'playwright',
          name: 'playwright::browser_wait',
          toolName: 'browser_wait',
          description: 'Wait for a specified time.',
          inputSchema: {
            type: 'object',
            properties: {
              time: { type: 'number' },
            },
          },
        },
        {
          serverName: 'playwright',
          name: 'playwright::browser_snapshot',
          toolName: 'browser_snapshot',
          description: 'Snapshot browser.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
      callTool,
    })

    const typeTool = tools.find(tool => tool.function.name === 'mcp_playwright_browser_type')
    await typeTool?.execute({
      ref: 'textbox-1',
      text: '学什么学 过来抱抱学什么学 过来抱抱',
    }, {
      messages: [],
      toolCallId: 'call-1',
    })

    expect(callTool).toHaveBeenNthCalledWith(1, {
      name: 'playwright::browser_type',
      arguments: {
        ref: 'textbox-1',
        text: '学什么学 过来抱抱',
      },
    })
  })

  it('normalizes bare browser_type target refs before calling the MCP runtime', async () => {
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'playwright::browser_type') {
        return {
          content: [{ type: 'text', text: 'typed' }],
        }
      }
      if (name === 'playwright::browser_wait') {
        return {
          content: [{ type: 'text', text: 'waited' }],
        }
      }
      if (name === 'playwright::browser_snapshot') {
        return {
          content: [{ type: 'text', text: 'Snapshot after type' }],
        }
      }
      throw new Error(`Unexpected MCP tool: ${name}`)
    })
    const tools = await createMcpRuntimeTools({
      listTools: async () => [
        {
          serverName: 'playwright',
          name: 'playwright::browser_type',
          toolName: 'browser_type',
          description: 'Type text into browser.',
          inputSchema: {
            type: 'object',
            properties: {
              target: { type: 'string' },
              ref: { type: 'string' },
              element: { type: 'string' },
              text: { type: 'string' },
            },
          },
        },
        {
          serverName: 'playwright',
          name: 'playwright::browser_wait',
          toolName: 'browser_wait',
          description: 'Wait for a specified time.',
          inputSchema: {
            type: 'object',
            properties: {
              time: { type: 'number' },
            },
          },
        },
        {
          serverName: 'playwright',
          name: 'playwright::browser_snapshot',
          toolName: 'browser_snapshot',
          description: 'Snapshot browser.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
      callTool,
    })

    const typeTool = tools.find(tool => tool.function.name === 'mcp_playwright_browser_type')
    await typeTool?.execute({
      target: 'ref=e18',
      text: 'good night',
    }, {
      messages: [],
      toolCallId: 'call-1',
    })

    expect(callTool).toHaveBeenNthCalledWith(1, {
      name: 'playwright::browser_type',
      arguments: {
        element: 'e18',
        ref: 'e18',
        text: 'good night',
      },
    })
  })

  it('suppresses duplicate browser mutations through the generic MCP proxy', async () => {
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'playwright::browser_tabs') {
        return {
          content: [{ type: 'text', text: 'opened tab' }],
        }
      }
      throw new Error(`Unexpected MCP tool: ${name}`)
    })
    const tools = await createMcpRuntimeTools({
      listTools: async () => [
        {
          serverName: 'playwright',
          name: 'playwright::browser_tabs',
          toolName: 'browser_tabs',
          description: 'List, create, close, or select browser tabs.',
          inputSchema: {
            type: 'object',
            properties: {
              action: { type: 'string' },
              url: { type: 'string' },
            },
          },
        },
      ],
      callTool,
    })

    const proxyTool = tools.find(tool => tool.function.name === 'builtIn_mcpCallTool')
    const payload = {
      name: 'playwright::browser_tabs',
      arguments: JSON.stringify({ action: 'new', url: 'https://example.com' }),
    }
    await proxyTool?.execute(payload, {
      messages: [],
      toolCallId: 'call-1',
    })
    const second = await proxyTool?.execute(payload, {
      messages: [],
      toolCallId: 'call-2',
    })

    expect(callTool).toHaveBeenCalledOnce()
    expect(second).toEqual(expect.objectContaining({
      structuredContent: expect.objectContaining({
        status: 'duplicate_browser_mutation_suppressed',
        target: 'playwright::browser_tabs',
      }),
    }))
  })

  it('recovers browser snapshots after interrupted navigation errors', async () => {
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'playwright::browser_navigate') {
        return {
          isError: true,
          content: [{ type: 'text', text: 'page.goto: net::ERR_ABORTED' }],
        }
      }
      if (name === 'playwright::browser_wait') {
        return {
          content: [{ type: 'text', text: 'waited' }],
        }
      }
      if (name === 'playwright::browser_snapshot') {
        return {
          content: [{ type: 'text', text: 'Page title: Visible Page' }],
        }
      }
      throw new Error(`Unexpected MCP tool: ${name}`)
    })
    const tools = await createMcpRuntimeTools({
      listTools: async () => [
        {
          serverName: 'playwright',
          name: 'playwright::browser_navigate',
          toolName: 'browser_navigate',
          description: 'Navigate browser.',
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string' },
            },
          },
        },
        {
          serverName: 'playwright',
          name: 'playwright::browser_wait',
          toolName: 'browser_wait',
          description: 'Wait for a specified time.',
          inputSchema: {
            type: 'object',
            properties: {
              time: { type: 'number' },
            },
          },
        },
        {
          serverName: 'playwright',
          name: 'playwright::browser_snapshot',
          toolName: 'browser_snapshot',
          description: 'Snapshot browser.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
      callTool,
    })

    const navigateTool = tools.find(tool => tool.function.name === 'mcp_playwright_browser_navigate')
    const result = await navigateTool?.execute({ url: 'https://example.com' }, {
      messages: [],
      toolCallId: 'call-1',
    })

    expect(callTool).toHaveBeenNthCalledWith(1, {
      name: 'playwright::browser_navigate',
      arguments: { url: 'https://example.com' },
    })
    expect(callTool).toHaveBeenNthCalledWith(2, {
      name: 'playwright::browser_wait',
      arguments: { time: 2 },
    })
    expect(callTool).toHaveBeenNthCalledWith(3, {
      name: 'playwright::browser_snapshot',
      arguments: {},
    })
    expect(result).toEqual(expect.objectContaining({
      toolResult: {
        isError: true,
        content: [{ type: 'text', text: 'page.goto: net::ERR_ABORTED' }],
      },
      followUpSnapshot: {
        target: 'playwright::browser_snapshot',
        result: {
          content: [{ type: 'text', text: 'Page title: Visible Page' }],
        },
      },
    }))
    expect(result).toEqual(expect.objectContaining({
      guidance: expect.stringContaining('Use followUpSnapshot'),
    }))
  })

  it('does not automatically snapshot browser_wait itself', async () => {
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === 'playwright::browser_wait') {
        return {
          content: [{ type: 'text', text: 'waited' }],
        }
      }
      if (name === 'playwright::browser_snapshot') {
        return {
          content: [{ type: 'text', text: 'unexpected snapshot' }],
        }
      }
      throw new Error(`Unexpected MCP tool: ${name}`)
    })
    const tools = await createMcpRuntimeTools({
      listTools: async () => [
        {
          serverName: 'playwright',
          name: 'playwright::browser_wait',
          toolName: 'browser_wait',
          description: 'Wait for a specified time.',
          inputSchema: {
            type: 'object',
            properties: {
              time: { type: 'number' },
            },
          },
        },
        {
          serverName: 'playwright',
          name: 'playwright::browser_snapshot',
          toolName: 'browser_snapshot',
          description: 'Snapshot browser.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
      callTool,
    })

    const waitTool = tools.find(tool => tool.function.name === 'mcp_playwright_browser_wait')
    const result = await waitTool?.execute({ time: 2 }, {
      messages: [],
      toolCallId: 'call-1',
    })

    expect(callTool).toHaveBeenCalledOnce()
    expect(callTool).toHaveBeenCalledWith({
      name: 'playwright::browser_wait',
      arguments: { time: 2 },
    })
    expect(result).toEqual({
      content: [{ type: 'text', text: 'waited' }],
    })
  })
})
