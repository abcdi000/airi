import type { Tool } from '@xsai/shared-chat'

import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/llm-tools'
import { useLlmToolsetPromptsStore } from '@proj-airi/stage-ui/stores/llm-toolset-prompts'
import { useMcpStore } from '@proj-airi/stage-ui/stores/mcp'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMocks = vi.hoisted(() => ({
  callMcpTool: vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  })),
  getComputerUseChatTurn: vi.fn(async (): Promise<{ sourceId: string, turnId: string } | undefined> => undefined),
  listMcpTools: vi.fn(async () => [
    {
      serverName: 'filesystem',
      name: 'filesystem::search',
      toolName: 'search',
      description: 'Search files.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      serverName: 'playwright',
      name: 'playwright::browser_snapshot',
      toolName: 'browser_snapshot',
      description: 'Snapshot browser state.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ]),
}))

vi.mock('@proj-airi/electron-vueuse', () => ({
  useElectronEventaInvoke: (event: { receiveEvent?: { id?: string } }) => {
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:mcp:list-tools-receive')
      return invokeMocks.listMcpTools
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:mcp:call-tool-receive')
      return invokeMocks.callMcpTool
    if (event?.receiveEvent?.id === 'eventa:invoke:electron:mcp:get-computer-use-chat-turn-receive')
      return invokeMocks.getComputerUseChatTurn

    throw new Error(`Unexpected eventa invoke: ${JSON.stringify(event)}`)
  },
}))

describe('useTamagotchiMcpToolsStore', async () => {
  const { useTamagotchiMcpToolsStore } = await import('./mcp-tools')

  beforeEach(() => {
    setActivePinia(createPinia())
    invokeMocks.listMcpTools.mockClear()
    invokeMocks.callMcpTool.mockClear()
    invokeMocks.getComputerUseChatTurn.mockClear()
  })

  /**
   * @example
   * await store.refresh()
   * expect(llmToolsStore.toolsByProvider.mcp).toHaveLength(2)
   */
  it('loads MCP tools, proxies execution, and clears them from the shared llm-tools store', async () => {
    const llmToolsStore = useLlmToolsStore()
    const llmToolsetPromptsStore = useLlmToolsetPromptsStore()
    const mcpStore = useMcpStore()
    const store = useTamagotchiMcpToolsStore()
    const toolOptions = {} as Parameters<Tool['execute']>[1]

    await store.refresh()

    const mcpTools = llmToolsStore.toolsByProvider.mcp
    const listTools = mcpTools?.find(tool => tool.function.name === 'builtIn_mcpListTools')
    const callTool = mcpTools?.find(tool => tool.function.name === 'builtIn_mcpCallTool')
    const directSearchTool = mcpTools?.find(tool => tool.function.name === 'mcp_filesystem_search')
    const directSnapshotTool = mcpTools?.find(tool => tool.function.name === 'mcp_playwright_browser_snapshot')

    expect(mcpTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: 'builtIn_mcpListTools' }) }),
      expect.objectContaining({ function: expect.objectContaining({ name: 'builtIn_mcpCallTool' }) }),
      expect.objectContaining({ function: expect.objectContaining({ name: 'mcp_filesystem_search' }) }),
      expect.objectContaining({ function: expect.objectContaining({ name: 'mcp_playwright_browser_snapshot' }) }),
    ]))
    expect(llmToolsetPromptsStore.activeToolsetPrompt).toContain('Playwright MCP is snapshot-first')
    expect(llmToolsetPromptsStore.activeToolsetPrompt).toContain('After any browser state change')

    const listResult = await listTools?.execute({}, toolOptions)
    const callResult = await callTool?.execute({
      name: 'filesystem::search',
      arguments: JSON.stringify({ query: 'hello', limit: 10 }),
    }, toolOptions)
    const directResult = await directSearchTool?.execute({
      query: 'direct',
      limit: 5,
    }, toolOptions)
    await directSnapshotTool?.execute({}, toolOptions)

    expect(invokeMocks.listMcpTools).toHaveBeenCalledTimes(2)
    expect(invokeMocks.callMcpTool).toHaveBeenCalledWith({
      name: 'filesystem::search',
      arguments: { query: 'hello', limit: 10 },
    })
    expect(invokeMocks.callMcpTool).toHaveBeenCalledWith({
      name: 'filesystem::search',
      arguments: { query: 'direct', limit: 5 },
    })
    expect(invokeMocks.callMcpTool).toHaveBeenCalledWith({
      name: 'playwright::browser_snapshot',
      arguments: {},
    })
    expect(listResult).toEqual([
      {
        serverName: 'filesystem',
        name: 'filesystem::search',
        toolName: 'search',
        description: 'Search files.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        serverName: 'playwright',
        name: 'playwright::browser_snapshot',
        toolName: 'browser_snapshot',
        description: 'Snapshot browser state.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ])
    expect(callResult).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })
    expect(directResult).toEqual({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    })
    expect(mcpStore.connected).toBe(true)

    store.dispose()

    expect(llmToolsStore.toolsByProvider.mcp).toBeUndefined()
    expect(llmToolsetPromptsStore.promptsByProvider.mcp).toBeUndefined()
    expect(mcpStore.connected).toBe(false)
  })

  it('only exposes the focused desktop-control toolset from Computer Use', async () => {
    invokeMocks.listMcpTools.mockResolvedValueOnce([
      {
        serverName: 'computer_use',
        name: 'computer_use::desktop_focus_app',
        toolName: 'desktop_focus_app',
        description: 'Focus an app.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        serverName: 'computer_use',
        name: 'computer_use::desktop_list_processes',
        toolName: 'desktop_list_processes',
        description: 'List running processes.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        serverName: 'computer_use',
        name: 'computer_use::terminal_exec',
        toolName: 'terminal_exec',
        description: 'Run a shell command.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        serverName: 'computer_use',
        name: 'computer_use::pty_create',
        toolName: 'pty_create',
        description: 'Create a terminal.',
        inputSchema: { type: 'object', properties: {} },
      },
    ])

    const store = useTamagotchiMcpToolsStore()
    const llmToolsStore = useLlmToolsStore()
    const llmToolsetPromptsStore = useLlmToolsetPromptsStore()
    await store.refresh()

    const names = llmToolsStore.toolsByProvider.mcp?.map(tool => tool.function.name) ?? []
    expect(names).toContain('mcp_computer_use_desktop_focus_app')
    expect(names).toContain('mcp_computer_use_desktop_list_processes')
    expect(names).not.toContain('mcp_computer_use_terminal_exec')
    expect(names).not.toContain('mcp_computer_use_pty_create')
    expect(llmToolsetPromptsStore.activeToolsetPrompt).toContain('Do not ask the user to click Allow')
    expect(llmToolsetPromptsStore.activeToolsetPrompt).toContain('status="approval_required"')
    expect(llmToolsetPromptsStore.activeToolsetPrompt).toContain('Never ask the user whether an app is running')
    store.dispose()
  })

  it('binds Computer Use model calls to the active chat turn', async () => {
    invokeMocks.listMcpTools.mockResolvedValueOnce([
      {
        serverName: 'computer_use',
        name: 'computer_use::desktop_focus_app',
        toolName: 'desktop_focus_app',
        description: 'Focus an app.',
        inputSchema: { type: 'object', properties: {} },
      },
    ])
    const { beginComputerUseTurn, endComputerUseTurn } = await import('./computer-use-turn')
    const store = useTamagotchiMcpToolsStore()
    const llmToolsStore = useLlmToolsStore()
    await store.refresh()
    const turn = beginComputerUseTurn('chat-test')

    const directTool = llmToolsStore.toolsByProvider.mcp?.find(tool => tool.function.name === 'mcp_computer_use_desktop_focus_app')
    await directTool?.execute({ app: 'QQ' }, { toolCallId: 'model-tool-call' } as Parameters<Tool['execute']>[1])

    expect(invokeMocks.callMcpTool).toHaveBeenCalledWith(expect.objectContaining({
      name: 'computer_use::desktop_focus_app',
      arguments: { app: 'QQ' },
      debug: expect.objectContaining({
        computerUseTurnId: turn.turnId,
        computerUseSourceId: 'chat-test',
      }),
    }))

    endComputerUseTurn('chat-test')
    store.dispose()
  })

  it('uses the main-process turn only when this execution window has no local turn', async () => {
    invokeMocks.listMcpTools.mockResolvedValueOnce([
      {
        serverName: 'computer_use',
        name: 'computer_use::desktop_click',
        toolName: 'desktop_click',
        description: 'Click a desktop position.',
        inputSchema: { type: 'object', properties: {} },
      },
    ])
    invokeMocks.getComputerUseChatTurn.mockResolvedValueOnce({
      sourceId: 'mini-chat',
      turnId: 'mini-chat-turn',
    })

    const store = useTamagotchiMcpToolsStore()
    const llmToolsStore = useLlmToolsStore()
    await store.refresh()

    const directTool = llmToolsStore.toolsByProvider.mcp?.find(tool => tool.function.name === 'mcp_computer_use_desktop_click')
    await directTool?.execute({ x: 120, y: 900 }, { toolCallId: 'model-tool-call' } as Parameters<Tool['execute']>[1])

    expect(invokeMocks.getComputerUseChatTurn).toHaveBeenCalledTimes(1)
    expect(invokeMocks.callMcpTool).toHaveBeenCalledWith(expect.objectContaining({
      name: 'computer_use::desktop_click',
      debug: expect.objectContaining({
        computerUseTurnId: 'mini-chat-turn',
        computerUseSourceId: 'mini-chat',
      }),
    }))

    store.dispose()
  })
})
