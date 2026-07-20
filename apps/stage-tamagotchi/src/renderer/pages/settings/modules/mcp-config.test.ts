import { errorMessageFrom } from '@moeru/std'
import { describe, expect, it } from 'vitest'

import { parseElectronMcpConfigText } from '../../../../shared/mcp-config'
import {
  buildConfigFile,
  buildServerConfig,
  createMinecraftMcpServerForm,
  createPlaywrightMcpServerForm,
  createWindowsComputerUseMcpServerForm,
  findServerIdentifierByRowId,
  loadServerForms,
  MCP_SERVER_PRESETS,
  syncJsonDraftFromServers,
} from './mcp-config'

const LUMI_EXEC_PATH = '$' + '{LUMI_EXEC_PATH}'
const LUMI_APP_PATH = '$' + '{LUMI_APP_PATH}'
const LUMI_USER_DATA_PATH = '$' + '{LUMI_USER_DATA_PATH}'

function translateMessage(key: string, params?: Record<string, unknown>) {
  if (params?.name)
    return `${key}:${String(params.name)}`

  if (params?.index)
    return `${key}:${String(params.index)}`

  return key
}

describe('mcp-config helpers', () => {
  it('preserves the selected server identity when rows are reloaded', () => {
    const config = {
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
      },
    }

    const initialLoad = loadServerForms(config)
    const selectedRowId = initialLoad.servers[1]!.rowId
    const selectedIdentifier = findServerIdentifierByRowId(initialLoad.servers, selectedRowId)
    const reloaded = loadServerForms(config, { selectedIdentifier })

    expect(selectedIdentifier).toBe('github')
    expect(reloaded.selectedRowId).not.toBe(selectedRowId)
    expect(reloaded.servers.find(server => server.rowId === reloaded.selectedRowId)?.identifier).toBe('github')
  })

  it('keeps cwd when converting form rows into MCP config', () => {
    const server = {
      rowId: 'mcp-static',
      identifier: 'filesystem',
      command: ' npx ',
      url: '',
      headersEntries: [],
      argsText: '-y\n@modelcontextprotocol/server-filesystem',
      envEntries: [{ key: ' ROOT ', value: '/tmp' }],
      cwd: ' /Users/doji/dojiwork/airi ',
      enabled: true,
      startupMode: 'on_startup' as const,
      longRunning: false,
      persistent: false,
      requestTimeoutMs: '',
      maxTotalTimeoutMs: '',
    }

    expect(buildServerConfig(server)).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      env: { ROOT: '/tmp' },
      cwd: '/Users/doji/dojiwork/airi',
    })

    expect(buildConfigFile([server], translateMessage)).toEqual({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem'],
          env: { ROOT: '/tmp' },
          cwd: '/Users/doji/dojiwork/airi',
        },
      },
    })
  })

  it('keeps the existing JSON draft when form rows are incomplete', () => {
    const previousDraft = '{\n  "mcpServers": {\n    "saved": { "command": "npx" }\n  }\n}\n'

    const result = syncJsonDraftFromServers(
      [{
        rowId: 'pending',
        identifier: '',
        command: '',
        url: '',
        headersEntries: [],
        argsText: '',
        envEntries: [],
        cwd: '',
        enabled: true,
        startupMode: 'on_startup',
        longRunning: false,
        persistent: false,
        requestTimeoutMs: '',
        maxTotalTimeoutMs: '',
      }],
      previousDraft,
      translateMessage,
      error => errorMessageFrom(error) ?? 'Unknown error',
    )

    expect(result.draft).toBe(previousDraft)
    expect(result.error).toBe('errors.empty-identifier:1')
  })

  it('rejects JSON drafts that violate the shared MCP schema', () => {
    expect(() => parseElectronMcpConfigText(JSON.stringify({
      mcpServers: {
        filesystem: {
          command: 'npx',
          env: [],
        },
      },
    }))).toThrow('mcpServers.filesystem.env: Invalid input: expected record, received array')
  })

  it('supports Streamable HTTP MCP server configs', () => {
    const server = {
      rowId: 'mcp-http',
      identifier: 'playwright',
      command: '',
      url: ' http://localhost:8931/mcp ',
      headersEntries: [{ key: ' Authorization ', value: 'Bearer test' }],
      argsText: '',
      envEntries: [],
      cwd: '',
      enabled: true,
      startupMode: 'on_first_use' as const,
      longRunning: true,
      persistent: true,
      requestTimeoutMs: '60000',
      maxTotalTimeoutMs: '180000',
    }

    expect(buildServerConfig(server)).toEqual({
      url: 'http://localhost:8931/mcp',
      headers: { Authorization: 'Bearer test' },
      startupMode: 'on_first_use',
      longRunning: true,
      persistent: true,
      requestTimeoutMs: 60000,
      maxTotalTimeoutMs: 180000,
    })

    expect(parseElectronMcpConfigText(JSON.stringify({
      mcpServers: {
        playwright: {
          url: 'http://localhost:8931/mcp',
        },
      },
    }))).toEqual({
      mcpServers: {
        playwright: {
          url: 'http://localhost:8931/mcp',
        },
      },
    })
  })

  it('rejects unknown keys that the main process would reject too', () => {
    expect(() => parseElectronMcpConfigText(JSON.stringify({
      mcpServers: {
        filesystem: {
          command: 'npx',
          extraField: true,
        },
      },
    }))).toThrow('mcpServers.filesystem: Unrecognized key: "extraField"')
  })

  it('preserves MCP startup mode in form conversion and JSON validation', () => {
    const parsed = parseElectronMcpConfigText(JSON.stringify({
      mcpServers: {
        anilist: {
          command: 'npx',
          args: ['-y', 'anilist-mcp'],
          startupMode: 'on_first_use',
        },
      },
    }))

    const loaded = loadServerForms(parsed)

    expect(loaded.servers[0]?.startupMode).toBe('on_first_use')
    expect(buildServerConfig(loaded.servers[0]!)).toEqual({
      command: 'npx',
      args: ['-y', 'anilist-mcp'],
      startupMode: 'on_first_use',
    })
  })

  it('creates a persistent Minecraft MCP preset', () => {
    const server = createMinecraftMcpServerForm()

    expect(buildServerConfig(server)).toEqual({
      command: 'node',
      args: [
        'dist/main.js',
        '--host',
        'localhost',
        '--port',
        '25565',
        '--username',
        'LumiBot',
        '--version',
        '1.20.1',
        '--auth',
        'offline',
      ],
      cwd: 'external-mcp/minecraft-mcp-server',
      startupMode: 'on_first_use',
      longRunning: true,
      persistent: true,
      requestTimeoutMs: 60000,
      maxTotalTimeoutMs: 180000,
    })
  })

  it('creates the Windows Computer Use preset through the standard MCP config shape', () => {
    const server = createWindowsComputerUseMcpServerForm()

    expect(buildServerConfig(server)).toEqual({
      command: LUMI_EXEC_PATH,
      args: [`${LUMI_APP_PATH}/node_modules/@proj-airi/computer-use-mcp/dist/bin/run.mjs`],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        COMPUTER_USE_EXECUTOR: 'windows-local',
        COMPUTER_USE_APPROVAL_MODE: 'never',
        COMPUTER_USE_MAX_OPERATIONS: '16',
        COMPUTER_USE_MAX_OPERATION_UNITS: '96',
        COMPUTER_USE_INTERRUPT_SHORTCUT: 'End',
        COMPUTER_USE_BROWSER_DOM_BRIDGE_ENABLED: 'false',
      },
      cwd: LUMI_USER_DATA_PATH,
      startupMode: 'on_first_use',
      longRunning: true,
      persistent: true,
      requestTimeoutMs: 60000,
      maxTotalTimeoutMs: 180000,
    })
  })

  it('creates the bundled Playwright MCP preset through the standard MCP config shape', () => {
    const server = createPlaywrightMcpServerForm()

    expect(buildServerConfig(server)).toEqual({
      command: LUMI_EXEC_PATH,
      args: [`${LUMI_APP_PATH}/node_modules/@proj-airi/playwright-extra-mcp/dist/bin/run.mjs`],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        LUMI_PLAYWRIGHT_USER_DATA_DIR: `${LUMI_USER_DATA_PATH}/playwright-profile`,
      },
      cwd: LUMI_USER_DATA_PATH,
      startupMode: 'on_first_use',
      longRunning: true,
      persistent: true,
      requestTimeoutMs: 60000,
      maxTotalTimeoutMs: 180000,
    })
  })

  it('exposes all bundled MCP presets in the settings registry', () => {
    expect(MCP_SERVER_PRESETS.map(preset => preset.id)).toEqual([
      'minecraft',
      'computer_use',
      'playwright',
    ])
  })

  it('rejects MCP total timeouts shorter than request timeouts', () => {
    expect(() => parseElectronMcpConfigText(JSON.stringify({
      mcpServers: {
        minecraft: {
          command: 'npx',
          requestTimeoutMs: 60000,
          maxTotalTimeoutMs: 1000,
        },
      },
    }))).toThrow('maxTotalTimeoutMs must be greater than or equal to requestTimeoutMs')
  })
})
