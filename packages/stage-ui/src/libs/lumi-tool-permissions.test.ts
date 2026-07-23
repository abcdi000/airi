import type { Tool } from '@xsai/shared-chat'

import { describe, expect, it, vi } from 'vitest'

import { classifyLumiRemoteTool, createLumiRemoteToolTransform } from './lumi-tool-permissions'

function createTool(name: string, execute = vi.fn().mockResolvedValue(name)): Tool {
  return {
    type: 'function',
    function: {
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
    },
    execute,
  }
}

describe('lumi remote tool permissions', () => {
  /** @example classifyLumiRemoteTool(createTool('mcp_playwright_browser_snapshot')) */
  it('classifies only known remote tool families and leaves generic MCP proxies unclassified', () => {
    expect(classifyLumiRemoteTool(createTool('lumi_memory_search'))).toBe('lumi:tool:memory')
    expect(classifyLumiRemoteTool(createTool('mcp_playwright_browser_snapshot'))).toBe('lumi:tool:web')
    expect(classifyLumiRemoteTool(createTool('mcp_minecraft_observe_world'))).toBe('lumi:tool:minecraft')
    expect(classifyLumiRemoteTool(createTool('mcp_computer_use_desktop_click'))).toBe('lumi:tool:computer-use')
    expect(classifyLumiRemoteTool(createTool('builtIn_mcpCallTool'))).toBeUndefined()
    expect(classifyLumiRemoteTool(createTool('lumi_delegate_to_claude_code'))).toBeUndefined()
  })

  /** @example createLumiRemoteToolTransform(['lumi:tool:memory'])(tools) */
  it('defaults unknown and ungranted tools to denied', () => {
    const tools = [
      createTool('lumi_memory_search'),
      createTool('mcp_playwright_browser_snapshot'),
      createTool('builtIn_mcpCallTool'),
    ]

    expect(createLumiRemoteToolTransform(['lumi:tool:memory'])(tools).map(tool => tool.function.name)).toEqual([
      'lumi_memory_search',
    ])
    expect(createLumiRemoteToolTransform([])(tools)).toEqual([])
  })

  /** @example await guardedTool.execute({}, executeOptions) */
  it('rejects overlapping access to one shared physical resource and releases it after completion', async () => {
    let releaseFirst: (() => void) | undefined
    const execute = vi.fn(() => new Promise<string>((resolve) => {
      releaseFirst = () => resolve('done')
    }))
    const transform = createLumiRemoteToolTransform(['lumi:tool:computer-use'])
    const [guardedTool] = transform([createTool('mcp_computer_use_desktop_click', execute)])
    const executeOptions = { messages: [], toolCallId: 'call-1' }

    const first = guardedTool!.execute({}, executeOptions)
    await Promise.resolve()
    await expect(guardedTool!.execute({}, { ...executeOptions, toolCallId: 'call-2' })).rejects.toThrow('resource is busy')
    releaseFirst?.()
    await expect(first).resolves.toBe('done')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  /** @example await guardedTool.execute({}, executeOptions) */
  it('attaches content-free remote ownership metadata to exclusive MCP calls', async () => {
    const execute = vi.fn().mockResolvedValue('done')
    const [guardedTool] = createLumiRemoteToolTransform(['lumi:tool:web'], {
      actorId: 'moussy',
      conversationId: 'room-doggy-moussy',
      deviceId: 'lumi-device-1',
    })([createTool('mcp_playwright_browser_snapshot', execute)])

    await guardedTool!.execute({}, { messages: [], toolCallId: 'call-lease' })

    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[1]).toMatchObject({
      lumiResourceLease: {
        resource: 'browser',
        toolName: 'mcp_playwright_browser_snapshot',
        actorId: 'moussy',
        conversationId: 'room-doggy-moussy',
        deviceId: 'lumi-device-1',
      },
    })
  })
})
