import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const LUMI_EXEC_PATH = '$' + '{LUMI_EXEC_PATH}'
const LUMI_APP_PATH = '$' + '{LUMI_APP_PATH}'

const appMock = vi.hoisted(() => ({
  getAppPath: vi.fn(),
  getPath: vi.fn(),
  getVersion: vi.fn(),
}))

const shellMock = vi.hoisted(() => ({
  showItemInFolder: vi.fn(),
}))

const clientMocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  listTools: vi.fn(),
}))

const transportMocks = vi.hoisted(() => ({
  stdioServers: [] as unknown[],
}))

vi.mock('electron', () => ({
  app: appMock,
  shell: shellMock,
}))

vi.mock('@guiiai/logg', () => ({
  useLogg: vi.fn(() => ({
    useGlobalConfig: () => ({
      debug: vi.fn(),
      warn: vi.fn(),
      withError: vi.fn(() => ({ warn: vi.fn() })),
      withFields: vi.fn(() => ({ debug: vi.fn(), warn: vi.fn() })),
    }),
  })),
}))

vi.mock('../../../libs/bootkit/lifecycle', () => ({
  onAppBeforeQuit: vi.fn(),
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    callTool = clientMocks.callTool
    close = clientMocks.close
    connect = clientMocks.connect
    listTools = clientMocks.listTools
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', async () => {
  const { PassThrough } = await import('node:stream')

  return {
    StdioClientTransport: class {
      stderr = new PassThrough()

      constructor(readonly server: unknown) {
        transportMocks.stdioServers.push(server)
      }

      close = vi.fn(async () => undefined)
    },
  }
})

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    close = vi.fn(async () => undefined)

    constructor(readonly url: URL, readonly opts?: unknown) {}
  },
}))

describe('createMcpStdioManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transportMocks.stdioServers = []
    appMock.getAppPath.mockReturnValue('C:\\Program Files\\Lumi\\resources\\app.asar')
    appMock.getPath.mockReturnValue(join(tmpdir(), `airi-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`))
    appMock.getVersion.mockReturnValue('0.10.0')
    clientMocks.connect.mockResolvedValue(undefined)
    clientMocks.close.mockResolvedValue(undefined)
    clientMocks.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] })
    clientMocks.listTools.mockResolvedValue({ tools: [] })
  })

  it('includes stderr captured during connect failures in MCP server test results', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()

    clientMocks.connect.mockImplementationOnce(async (transport: { stderr: NodeJS.WritableStream }) => {
      transport.stderr.write('Missing required environment variable: API_KEY\n')
      throw new Error('connect failed')
    })

    const result = await manager.testServer({
      name: 'broken-server',
      config: {
        command: 'broken-mcp-server',
      },
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('connect failed')
    expect(result.error).toContain('Missing required environment variable: API_KEY')
  })

  it('tests Streamable HTTP MCP server configs', async () => {
    const { createMcpStdioManager } = await import('./index')
    const manager = createMcpStdioManager()

    clientMocks.connect.mockResolvedValueOnce(undefined)
    clientMocks.listTools.mockResolvedValueOnce({ tools: [{ name: 'browser_snapshot' }] })

    const result = await manager.testServer({
      name: 'playwright',
      config: {
        url: 'http://localhost:8931/mcp',
      },
    })

    expect(result.ok).toBe(true)
    expect(result.tools).toEqual(['browser_snapshot'])
    expect(clientMocks.connect).toHaveBeenCalledTimes(1)
  })

  it('only accepts Computer Use mutations from the current active chat turn', async () => {
    const { createMcpStdioManager } = await import('./index')
    const userData = appMock.getPath()
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        computer_use: {
          command: 'computer-use-mcp',
          startupMode: 'on_startup',
        },
      },
    })}\n`)
    const manager = createMcpStdioManager()
    await manager.applyAndRestart()

    await expect(manager.callTool({
      name: 'computer_use::desktop_click',
      arguments: { x: 20, y: 20 },
    })).rejects.toThrow('current active Lumi chat turn')
    expect(clientMocks.callTool).not.toHaveBeenCalled()

    await manager.callTool({
      name: 'computer_use::desktop_list_processes',
      arguments: { app: 'QQ', limit: 8 },
    })
    expect(clientMocks.callTool).toHaveBeenCalledWith({
      name: 'desktop_list_processes',
      arguments: { app: 'QQ', limit: 8 },
    }, undefined, expect.any(Object))
    clientMocks.callTool.mockClear()

    await expect(manager.callTool({
      name: 'computer_use::desktop_click',
      arguments: { x: 20, y: 20 },
      debug: { modelToolCallId: 'model-call-without-turn' },
    })).rejects.toThrow('current active Lumi chat turn')

    await manager.setComputerUseChatActive({
      sourceId: 'chat-test',
      active: true,
      turnId: 'turn-current',
    })

    await expect(manager.callTool({
      name: 'computer_use::desktop_click',
      arguments: { x: 30, y: 30 },
      debug: { modelToolCallId: 'model-call-stale', computerUseTurnId: 'turn-old' },
    })).rejects.toThrow('current active Lumi chat turn')

    await manager.callTool({
      name: 'computer_use::desktop_click',
      arguments: { x: 20, y: 20 },
      debug: { modelToolCallId: 'model-call-1', computerUseTurnId: 'turn-current' },
    })
    expect(clientMocks.callTool).toHaveBeenCalledWith({
      name: 'desktop_click',
      arguments: { x: 20, y: 20 },
    }, undefined, expect.any(Object))

    await manager.setComputerUseChatActive({ sourceId: 'chat-test', active: false })
    expect(clientMocks.close).toHaveBeenCalled()
  })

  it('defers on_first_use MCP servers until tools are listed', async () => {
    const { createMcpStdioManager } = await import('./index')
    const userData = appMock.getPath()
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        anilist: {
          command: 'npx',
          args: ['-y', 'anilist-mcp'],
          startupMode: 'on_first_use',
        },
      },
    })}\n`)

    const manager = createMcpStdioManager()
    clientMocks.listTools.mockResolvedValueOnce({
      tools: [{ name: 'anime_search', inputSchema: {} }],
    })

    const applyResult = await manager.applyAndRestart()

    expect(applyResult.started).toEqual([])
    expect(applyResult.skipped).toEqual([{ name: 'anilist', reason: 'on_first_use' }])
    expect(clientMocks.connect).not.toHaveBeenCalled()
    expect(manager.getRuntimeStatus().servers[0]).toMatchObject({
      name: 'anilist',
      state: 'stopped',
      startupMode: 'on_first_use',
    })

    const tools = await manager.listTools()

    expect(clientMocks.connect).toHaveBeenCalledTimes(1)
    expect(tools[0]).toMatchObject({
      serverName: 'anilist',
      name: 'anilist::anime_search',
      toolName: 'anime_search',
    })
  })

  it('uses long-running MCP timeouts and exposes persistent metadata', async () => {
    const { createMcpStdioManager } = await import('./index')
    const userData = appMock.getPath()
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        minecraft: {
          command: 'npx',
          args: ['-y', 'github:yuniko-software/minecraft-mcp-server'],
          startupMode: 'on_first_use',
          longRunning: true,
          persistent: true,
          requestTimeoutMs: 60000,
          maxTotalTimeoutMs: 180000,
        },
      },
    })}\n`)

    const manager = createMcpStdioManager()
    clientMocks.listTools.mockResolvedValueOnce({
      tools: [{ name: 'moveTo', inputSchema: {} }],
    })

    await manager.applyAndRestart()
    const tools = await manager.listTools()

    expect(clientMocks.listTools).toHaveBeenCalledWith(
      undefined,
      { timeout: 60000, maxTotalTimeout: 180000 },
    )
    expect(tools[0]).toMatchObject({
      serverName: 'minecraft',
      name: 'minecraft::moveTo',
      toolName: 'moveTo',
      serverLongRunning: true,
      serverPersistent: true,
    })
    expect(manager.getRuntimeStatus().servers[0]).toMatchObject({
      name: 'minecraft',
      longRunning: true,
      persistent: true,
      requestTimeoutMs: 60000,
      maxTotalTimeoutMs: 180000,
    })
  })

  it('expands Lumi runtime placeholders before creating stdio transports', async () => {
    const { createMcpStdioManager } = await import('./index')
    const userData = appMock.getPath()
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        computer_use: {
          command: LUMI_EXEC_PATH,
          args: [`${LUMI_APP_PATH}/node_modules/@proj-airi/computer-use-mcp/dist/bin/run.mjs`],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            COMPUTER_USE_EXECUTOR: 'windows-local',
          },
          cwd: LUMI_APP_PATH,
          startupMode: 'on_startup',
          longRunning: true,
          persistent: true,
        },
      },
    })}\n`)

    const manager = createMcpStdioManager()
    await manager.applyAndRestart()

    expect(transportMocks.stdioServers[0]).toMatchObject({
      command: process.execPath,
      args: ['C:\\Program Files\\Lumi\\resources\\app.asar/node_modules/@proj-airi/computer-use-mcp/dist/bin/run.mjs'],
      env: expect.objectContaining({
        ELECTRON_RUN_AS_NODE: '1',
        COMPUTER_USE_EXECUTOR: 'windows-local',
      }),
      cwd: 'C:\\Program Files\\Lumi\\resources\\app.asar',
      stderr: 'pipe',
    })
  })

  it('sanitizes repeated browser_type text before calling the MCP client', async () => {
    const { createMcpStdioManager } = await import('./index')
    const userData = appMock.getPath()
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['-y', '@playwright/mcp'],
          startupMode: 'on_first_use',
        },
      },
    })}\n`)

    const manager = createMcpStdioManager()
    await manager.applyAndRestart()
    await manager.callTool({
      name: 'playwright::browser_type',
      arguments: {
        ref: 'textbox-1',
        text: '不是不想狗吗 管狗走哪不是不想狗吗 管狗走哪',
      },
    })

    expect(clientMocks.callTool).toHaveBeenCalledWith(
      {
        name: 'browser_type',
        arguments: {
          ref: 'textbox-1',
          text: '不是不想狗吗 管狗走哪',
        },
      },
      undefined,
      expect.any(Object),
    )
  })

  it('normalizes browser_type target refs before calling the MCP client', async () => {
    const { createMcpStdioManager } = await import('./index')
    const userData = appMock.getPath()
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['-y', '@playwright/mcp'],
          startupMode: 'on_first_use',
        },
      },
    })}\n`)

    const manager = createMcpStdioManager()
    await manager.applyAndRestart()
    await manager.callTool({
      name: 'playwright::browser_type',
      arguments: {
        target: 'textbox "message" [ref=e18]',
        text: 'please wait',
      },
    })

    expect(clientMocks.callTool).toHaveBeenCalledWith(
      {
        name: 'browser_type',
        arguments: {
          element: 'textbox "message"',
          ref: 'e18',
          text: 'please wait',
        },
      },
      undefined,
      expect.any(Object),
    )
  })

  it('normalizes bare browser_type target refs before calling the MCP client', async () => {
    const { createMcpStdioManager } = await import('./index')
    const userData = appMock.getPath()
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['-y', '@playwright/mcp'],
          startupMode: 'on_first_use',
        },
      },
    })}\n`)

    const manager = createMcpStdioManager()
    await manager.applyAndRestart()
    await manager.callTool({
      name: 'playwright::browser_type',
      arguments: {
        target: 'ref=e18',
        text: 'good night',
      },
    })

    expect(clientMocks.callTool).toHaveBeenCalledWith(
      {
        name: 'browser_type',
        arguments: {
          element: 'e18',
          ref: 'e18',
          text: 'good night',
        },
      },
      undefined,
      expect.any(Object),
    )
  })

  it('sanitizes repeated browser_fill_form values and target refs before calling the MCP client', async () => {
    const { createMcpStdioManager } = await import('./index')
    const userData = appMock.getPath()
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['-y', '@playwright/mcp'],
          startupMode: 'on_first_use',
        },
      },
    })}\n`)

    const manager = createMcpStdioManager()
    await manager.applyAndRestart()
    await manager.callTool({
      name: 'playwright::browser_fill_form',
      arguments: {
        fields: [{
          target: 'textbox "message" [ref=e18]',
          name: 'message',
          type: 'textbox',
          value: 'come homecome home',
        }],
      },
    })

    expect(clientMocks.callTool).toHaveBeenCalledWith(
      {
        name: 'browser_fill_form',
        arguments: {
          fields: [{
            name: 'message',
            type: 'textbox',
            ref: 'e18',
            value: 'come home',
          }],
        },
      },
      undefined,
      expect.any(Object),
    )
  })

  it('suppresses duplicate browser mutations in the main MCP manager', async () => {
    const { createMcpStdioManager } = await import('./index')
    const userData = appMock.getPath()
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        playwright: {
          command: 'npx',
          args: ['-y', '@playwright/mcp'],
          startupMode: 'on_first_use',
        },
      },
    })}\n`)

    clientMocks.callTool.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return { content: [{ type: 'text', text: 'ok' }] }
    })

    const manager = createMcpStdioManager()
    await manager.applyAndRestart()
    const payload = {
      name: 'playwright::browser_type',
      arguments: {
        ref: 'e18',
        text: 'single input',
      },
      debug: {
        traceId: 'same-renderer-trace',
      },
    }

    const [first, second] = await Promise.all([
      manager.callTool(payload),
      manager.callTool(payload),
    ])

    expect(first.content?.[0]).toMatchObject({ type: 'text', text: 'ok' })
    expect(second.structuredContent).toMatchObject({
      status: 'duplicate_browser_mutation_suppressed_in_main',
      target: 'playwright::browser_type',
    })
    expect(clientMocks.callTool).toHaveBeenCalledTimes(1)
  })

  it('suppresses duplicate Minecraft state-changing calls in the main MCP manager', async () => {
    const { createMcpStdioManager } = await import('./index')
    const userData = appMock.getPath()
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        minecraft: {
          command: 'node',
          args: ['minecraft-mcp-server.js'],
          startupMode: 'on_first_use',
          longRunning: true,
          persistent: true,
        },
      },
    })}\n`)

    clientMocks.callTool.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return { content: [{ type: 'text', text: 'moving' }] }
    })

    const manager = createMcpStdioManager()
    await manager.applyAndRestart()
    const payload = {
      name: 'minecraft::move-to-position',
      arguments: { x: 12, y: 64, z: -5 },
      debug: {
        traceId: 'same-minecraft-renderer-trace',
      },
    }

    const [first, second] = await Promise.all([
      manager.callTool(payload),
      manager.callTool(payload),
    ])

    expect(first.content?.[0]).toMatchObject({ type: 'text', text: 'moving' })
    expect(second.structuredContent).toMatchObject({
      status: 'duplicate_mcp_mutation_suppressed_in_main',
      target: 'minecraft::move-to-position',
    })
    expect(second.isError).toBeUndefined()
    expect(clientMocks.callTool).toHaveBeenCalledTimes(1)
  })

  it('does not suppress read-only Minecraft observation calls', async () => {
    const { createMcpStdioManager } = await import('./index')
    const userData = appMock.getPath()
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        minecraft: {
          command: 'node',
          args: ['minecraft-mcp-server.js'],
          startupMode: 'on_first_use',
          persistent: true,
        },
      },
    })}\n`)

    const manager = createMcpStdioManager()
    await manager.applyAndRestart()
    const payload = {
      name: 'minecraft::observe-world',
      arguments: { radius: 16 },
    }

    await manager.callTool(payload)
    await manager.callTool(payload)

    expect(clientMocks.callTool).toHaveBeenCalledTimes(2)
    expect(clientMocks.callTool).toHaveBeenNthCalledWith(
      1,
      { name: 'observe-world', arguments: { radius: 16 } },
      undefined,
      expect.any(Object),
    )
  })

  it('joins duplicate MCP invocations with the same model tool call id', async () => {
    const { createMcpStdioManager } = await import('./index')
    const userData = appMock.getPath()
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        minecraft: {
          command: 'node',
          args: ['minecraft-mcp-server.js'],
          startupMode: 'on_first_use',
          persistent: true,
        },
      },
    })}\n`)

    clientMocks.callTool.mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      return { content: [{ type: 'text', text: 'observed once' }] }
    })

    const manager = createMcpStdioManager()
    await manager.applyAndRestart()
    const payload = {
      name: 'minecraft::observe-world',
      arguments: { radius: 16 },
      debug: {
        traceId: 'same-renderer-trace',
        modelToolCallId: 'same-model-tool-call',
      },
    }

    const [first, second] = await Promise.all([
      manager.callTool(payload),
      manager.callTool(payload),
    ])

    expect(first.content?.[0]).toMatchObject({ type: 'text', text: 'observed once' })
    expect(second.content?.[0]).toMatchObject({ type: 'text', text: 'observed once' })
    expect(clientMocks.callTool).toHaveBeenCalledTimes(1)
  })

  it('clears Minecraft duplicate protection after real call failures', async () => {
    const { createMcpStdioManager } = await import('./index')
    const userData = appMock.getPath()
    await mkdir(userData, { recursive: true })
    await writeFile(join(userData, 'mcp.json'), `${JSON.stringify({
      mcpServers: {
        minecraft: {
          command: 'node',
          args: ['minecraft-mcp-server.js'],
          startupMode: 'on_first_use',
          persistent: true,
        },
      },
    })}\n`)

    clientMocks.callTool
      .mockRejectedValueOnce(new Error('temporary connection drop'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok after retry' }] })

    const manager = createMcpStdioManager()
    await manager.applyAndRestart()
    const payload = {
      name: 'minecraft::combat-engage',
      arguments: { target: 'zombie' },
    }

    await expect(manager.callTool(payload)).rejects.toThrow('temporary connection drop')
    const result = await manager.callTool(payload)

    expect(result.content?.[0]).toMatchObject({ type: 'text', text: 'ok after retry' })
    expect(clientMocks.callTool).toHaveBeenCalledTimes(2)
  })
})
