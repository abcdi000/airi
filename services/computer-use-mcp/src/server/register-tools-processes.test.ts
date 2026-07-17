import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import type { ComputerUseServerRuntime } from './runtime'

import { describe, expect, it, vi } from 'vitest'

import { RunStateManager } from '../state'
import { createTestConfig } from '../test-fixtures'
import { registerComputerUseTools } from './register-tools'

function createMockServer() {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>()
  return {
    server: {
      tool(name: string, ...args: unknown[]) {
        const handler = args.findLast(value => typeof value === 'function')
        if (typeof handler === 'function')
          handlers.set(name, handler as (input: Record<string, unknown>) => Promise<unknown>)
        return { disable: vi.fn() }
      },
    } as unknown as McpServer,
    async invoke(name: string, input: Record<string, unknown>) {
      const handler = handlers.get(name)
      if (!handler)
        throw new Error(`Missing registered tool: ${name}`)
      return await handler(input)
    },
  }
}

function createRuntime(listProcesses?: ComputerUseServerRuntime['executor']['listProcesses']) {
  return {
    config: createTestConfig({ executor: 'windows-local' }),
    stateManager: new RunStateManager(),
    session: {},
    executor: {
      kind: 'windows-local',
      listProcesses,
    },
    terminalRunner: {},
    browserDomBridge: {},
    cdpBridgeManager: {},
    chromeSessionManager: {},
    desktopSessionController: {},
    taskMemory: {},
  } as unknown as ComputerUseServerRuntime
}

describe('desktop_list_processes', () => {
  it('returns filtered process state through the read-only executor capability', async () => {
    const listProcesses = vi.fn().mockResolvedValue({
      processes: [{ pid: 6464, appName: 'QQ', windowTitle: '', hasMainWindow: false, responding: true }],
      observedAt: '2026-07-11T00:00:00.000Z',
    })
    const { server, invoke } = createMockServer()
    registerComputerUseTools({
      server,
      runtime: createRuntime(listProcesses),
      executeAction: vi.fn(),
      enableTestTools: false,
    })

    const result = await invoke('desktop_list_processes', { app: 'QQ', limit: 8 }) as {
      isError?: boolean
      structuredContent: { status: string, observation: { processes: Array<{ appName: string, pid: number }> } }
    }

    expect(listProcesses).toHaveBeenCalledWith({ app: 'QQ', limit: 8 })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent.status).toBe('executed')
    expect(result.structuredContent.observation.processes).toEqual([
      expect.objectContaining({ appName: 'QQ', pid: 6464 }),
    ])
  })

  it('reports unsupported executors without pretending the process is absent', async () => {
    const { server, invoke } = createMockServer()
    registerComputerUseTools({
      server,
      runtime: createRuntime(),
      executeAction: vi.fn(),
      enableTestTools: false,
    })

    const result = await invoke('desktop_list_processes', { app: 'QQ' }) as {
      isError?: boolean
      structuredContent: { status: string }
    }

    expect(result.isError).toBe(true)
    expect(result.structuredContent.status).toBe('unavailable')
  })
})
