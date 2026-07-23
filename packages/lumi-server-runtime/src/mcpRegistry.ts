import type { Tool } from '@xsai/shared-chat'

import type { LumiConsciousnessRequest } from './consciousness'
import type { LumiServerToolProvider } from './openAICompatibleModel'

import process from 'node:process'

import { isAbsolute, resolve } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { errorMessageFrom } from '@moeru/std'

import { classifyMcpResource, LumiServerResourceRegistry } from './resourceLeases'

export interface LumiMcpServerConfig {
  command?: string
  url?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  cwd?: string
  enabled?: boolean
  startupMode?: 'on_startup' | 'on_first_use' | 'manual'
  requestTimeoutMs?: number
  maxTotalTimeoutMs?: number
}

export interface LumiMcpConfig {
  mcpServers: Record<string, LumiMcpServerConfig>
}

export interface LumiMcpServerStatus {
  name: string
  state: 'stopped' | 'starting' | 'running' | 'error'
  toolCount: number
  lastError?: string
}

interface McpSession {
  client: Client
  transport: StdioClientTransport | StreamableHTTPClientTransport
}

/** Owns the single online MCP registry and its physical resource leases. */
export class LumiServerMcpRegistry implements LumiServerToolProvider {
  private readonly configs = new Map<string, LumiMcpServerConfig>()
  private readonly sessions = new Map<string, McpSession>()
  private readonly connecting = new Map<string, Promise<McpSession>>()
  private readonly statuses = new Map<string, LumiMcpServerStatus>()

  constructor(
    private readonly version: string,
    readonly resources = new LumiServerResourceRegistry(),
  ) {}

  async apply(config: LumiMcpConfig): Promise<void> {
    await this.stopAll()
    this.configs.clear()
    this.statuses.clear()
    for (const [name, value] of Object.entries(config.mcpServers)) {
      const normalized = validateServerConfig(name, value)
      this.configs.set(name, normalized)
      this.statuses.set(name, { name, state: 'stopped', toolCount: 0 })
    }
    await Promise.all([...this.configs.entries()].map(async ([name, value]) => {
      if (value.enabled !== false && (value.startupMode ?? 'on_startup') === 'on_startup')
        await this.connect(name).catch(() => undefined)
    }))
  }

  statusesSnapshot(): LumiMcpServerStatus[] {
    return [...this.statuses.values()].map(status => structuredClone(status))
  }

  listResourceLeases() {
    return this.resources.list()
  }

  terminateResourceLease(leaseId: string) {
    return this.resources.terminate(leaseId)
  }

  async toolsFor(request: LumiConsciousnessRequest): Promise<Tool[]> {
    const toolGroups = await Promise.all([...this.configs].map(async ([serverName, config]) => {
      if (config.enabled === false || config.startupMode === 'manual')
        return []
      let session: McpSession
      let listed: Awaited<ReturnType<Client['listTools']>>
      try {
        session = await this.connect(serverName)
        listed = await session.client.listTools()
        this.statuses.set(serverName, { name: serverName, state: 'running', toolCount: listed.tools.length })
      }
      catch (error) {
        this.statuses.set(serverName, {
          name: serverName,
          state: 'error',
          toolCount: 0,
          lastError: errorMessageFrom(error) ?? 'MCP tool discovery failed',
        })
        return []
      }
      const result: Tool[] = []
      for (const descriptor of listed.tools) {
        const qualifiedName = modelToolName(serverName, descriptor.name)
        result.push({
          type: 'function',
          function: {
            name: qualifiedName,
            description: descriptor.description ?? `Call ${descriptor.name} on MCP server ${serverName}.`,
            parameters: descriptor.inputSchema,
            strict: false,
          },
          execute: async (input, executeOptions) => {
            const args = record(input)
            const resource = classifyMcpResource(qualifiedName)
            const call = async (signal?: AbortSignal) => await session.client.callTool({
              name: descriptor.name,
              arguments: args,
            }, undefined, {
              signal: mergeAbortSignals(signal, executeOptions.abortSignal),
              timeout: config.requestTimeoutMs ?? 60_000,
              maxTotalTimeout: config.maxTotalTimeoutMs ?? 180_000,
              resetTimeoutOnProgress: true,
            })
            return resource
              ? await this.resources.run(resource, {
                  toolName: qualifiedName,
                  actorPersonId: request.actorPersonId,
                  conversationId: request.conversationId,
                }, call)
              : await call()
          },
        })
      }
      return result
    }))
    return toolGroups.flat()
  }

  async stopAll(): Promise<void> {
    await this.resources.shutdown()
    const sessions = [...this.sessions.entries()]
    this.sessions.clear()
    await Promise.all(sessions.map(async ([name, session]) => {
      try {
        await session.client.close()
      }
      finally {
        await session.transport.close().catch(() => {})
        this.statuses.set(name, { name, state: 'stopped', toolCount: 0 })
      }
    }))
  }

  private async connect(name: string): Promise<McpSession> {
    const existing = this.sessions.get(name)
    if (existing)
      return existing
    const pending = this.connecting.get(name)
    if (pending)
      return pending
    const config = this.configs.get(name)
    if (!config)
      throw new Error(`Unknown MCP server: ${name}`)
    this.statuses.set(name, { name, state: 'starting', toolCount: 0 })
    const connecting = this.openSession(name, config)
    this.connecting.set(name, connecting)
    try {
      const session = await connecting
      this.sessions.set(name, session)
      this.statuses.set(name, { name, state: 'running', toolCount: 0 })
      return session
    }
    catch (error) {
      this.statuses.set(name, { name, state: 'error', toolCount: 0, lastError: errorMessageFrom(error) ?? 'MCP connection failed' })
      throw error
    }
    finally {
      this.connecting.delete(name)
    }
  }

  private async openSession(name: string, config: LumiMcpServerConfig): Promise<McpSession> {
    const transport = createTransport(config)
    const client = new Client({ name: `lumi-server:${name}`, version: this.version })
    try {
      await client.connect(transport, {
        timeout: Math.min(config.requestTimeoutMs ?? 60_000, 30_000),
        maxTotalTimeout: Math.min(config.maxTotalTimeoutMs ?? 180_000, 30_000),
      })
      return { client, transport }
    }
    catch (error) {
      await transport.close().catch(() => {})
      throw error
    }
  }
}

function createTransport(config: LumiMcpServerConfig) {
  if (config.url) {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
    })
  }
  if (!config.command)
    throw new Error('MCP server must define command or url')
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  return new StdioClientTransport({
    command: resolveRuntimeCommand(expandRuntimeVariables(config.command)),
    args: (config.args ?? []).map(expandRuntimeVariables),
    env: { ...inherited, ...Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, expandRuntimeVariables(value)])) },
    cwd: config.cwd ? resolveRuntimeCwd(expandRuntimeVariables(config.cwd)) : process.cwd(),
    stderr: 'inherit',
  })
}

function resolveRuntimeCommand(command: string) {
  const executable = command.trim().toLowerCase()
  if ((executable === 'node' || executable === 'node.exe') && process.env.LUMI_EXEC_PATH)
    return process.env.LUMI_EXEC_PATH
  return command
}

function resolveRuntimeCwd(cwd: string) {
  if (isAbsolute(cwd))
    return resolve(cwd)
  return resolve(process.env.LUMI_APP_PATH ?? process.cwd(), cwd)
}

function expandRuntimeVariables(value: string) {
  return value.replace(/\$\{(LUMI_EXEC_PATH|LUMI_APP_PATH|LUMI_USER_DATA_PATH)\}/g, (token, name: string) => process.env[name] ?? token)
}

function validateServerConfig(name: string, config: LumiMcpServerConfig): LumiMcpServerConfig {
  if (!name.trim())
    throw new Error('MCP server name is required')
  if (Boolean(config.command) === Boolean(config.url))
    throw new Error(`MCP server ${name} must define exactly one of command or url`)
  if (config.url && !URL.canParse(config.url))
    throw new Error(`MCP server ${name} URL is invalid`)
  boundedTimeout(config.requestTimeoutMs, 1_000, 600_000, `${name}.requestTimeoutMs`)
  boundedTimeout(config.maxTotalTimeoutMs, 1_000, 900_000, `${name}.maxTotalTimeoutMs`)
  if (config.requestTimeoutMs && config.maxTotalTimeoutMs && config.maxTotalTimeoutMs < config.requestTimeoutMs)
    throw new Error(`${name}.maxTotalTimeoutMs must be at least requestTimeoutMs`)
  return structuredClone(config)
}

function boundedTimeout(value: number | undefined, minimum: number, maximum: number, field: string) {
  if (value !== undefined && (!Number.isInteger(value) || value < minimum || value > maximum))
    throw new Error(`${field} must be between ${minimum} and ${maximum}`)
}

/**
 * Normalizes an MCP target into an OpenAI-compatible tool name.
 *
 * Before:
 * - "Playwright Extra::browser-click"
 *
 * After:
 * - "mcp_playwright_extra_browser_click"
 */
function modelToolName(serverName: string, toolName: string) {
  return `mcp_${serverName}_${toolName}`.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').slice(0, 64)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function mergeAbortSignals(first?: AbortSignal, second?: AbortSignal) {
  const signals = [first, second].filter((signal): signal is AbortSignal => signal !== undefined)
  return signals.length ? AbortSignal.any(signals) : undefined
}
