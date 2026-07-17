import type { createContext } from '@moeru/eventa/adapters/electron/main'

import type {
  ElectronMcpCallToolPayload,
  ElectronMcpCallToolResult,
  ElectronMcpComputerUseChatTurn,
  ElectronMcpStdioApplyResult,
  ElectronMcpStdioConfigFile,
  ElectronMcpStdioConfigText,
  ElectronMcpStdioRuntimeStatus,
  ElectronMcpStdioServerConfig,
  ElectronMcpStdioServerRuntimeStatus,
  ElectronMcpStdioTestPayload,
  ElectronMcpStdioTestResult,
  ElectronMcpToolDescriptor,
} from '../../../../shared/eventa'

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { env } from 'node:process'

import { useLogg } from '@guiiai/logg'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { defineInvokeHandler } from '@moeru/eventa'
import { app, dialog, shell } from 'electron'

import {
  electronMcpApplyAndRestart,
  electronMcpCallTool,
  electronMcpGetComputerUseChatTurn,
  electronMcpGetRuntimeStatus,
  electronMcpInterruptComputerUse,
  electronMcpSetComputerUseChatActive,
  electronMcpListTools,
  electronMcpOpenConfigFile,
  electronMcpReadConfigText,
  electronMcpTestServer,
  electronMcpWriteConfigText,
} from '../../../../shared/eventa'
import { parseElectronMcpConfigText } from '../../../../shared/mcp-config'
import { onAppBeforeQuit } from '../../../libs/bootkit/lifecycle'

interface McpServerSession {
  client: Client
  transport: McpClientTransport
  config: ElectronMcpStdioServerConfig
}

type McpClientTransport = StdioClientTransport | StreamableHTTPClientTransport

export interface McpStdioManager {
  ensureConfigFile: () => Promise<{ path: string }>
  openConfigFile: () => Promise<{ path: string }>
  applyAndRestart: () => Promise<ElectronMcpStdioApplyResult>
  listTools: () => Promise<ElectronMcpToolDescriptor[]>
  callTool: (payload: ElectronMcpCallToolPayload) => Promise<ElectronMcpCallToolResult>
  interruptComputerUse: () => Promise<{ interrupted: boolean }>
  setComputerUseChatActive: (payload: { sourceId: string, active: boolean, reset?: boolean, turnId?: string }) => Promise<void>
  getComputerUseChatTurn: () => ElectronMcpComputerUseChatTurn | undefined
  stopAll: () => Promise<void>
  getRuntimeStatus: () => ElectronMcpStdioRuntimeStatus
  readConfigText: () => Promise<ElectronMcpStdioConfigText>
  writeConfigText: (text: string) => Promise<ElectronMcpStdioConfigText>
  testServer: (payload: ElectronMcpStdioTestPayload) => Promise<ElectronMcpStdioTestResult>
}

const defaultMcpConfig: ElectronMcpStdioConfigFile = {
  mcpServers: {},
}
const toolNameSeparator = '::'
const mcpRequestTimeoutMsec = 10_000
const mcpRequestMaxTotalTimeoutMsec = 15_000
const mcpLongRunningRequestTimeoutMsec = 60_000
const mcpLongRunningMaxTotalTimeoutMsec = 180_000
const mcpTestStderrMaxChars = 16_000
const mcpMutationDedupeTtlMsec = 15_000
const mcpCallIdempotencyTtlMsec = 120_000
const defaultStartupMode: NonNullable<ElectronMcpStdioServerConfig['startupMode']> = 'on_startup'
const computerUseServerName = 'computer_use'
const computerUseApprovalToolNames = new Set([
  'desktop_list_pending_actions',
  'desktop_approve_pending_action',
  'desktop_reject_pending_action',
])
const computerUseReadOnlyToolNames = new Set([
  'desktop_get_capabilities',
  'desktop_get_session_trace',
  'desktop_get_state',
  'desktop_list_processes',
  'desktop_observe',
  'desktop_observe_windows',
  'desktop_screenshot',
  'desktop_wait',
  'accessibility_snapshot',
  'accessibility_find_element',
])

function isComputerUseApprovalTool(serverName: string, toolName: string) {
  return serverName === computerUseServerName && computerUseApprovalToolNames.has(toolName)
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

const minecraftReadOnlyToolNames = new Set([
  'detect-gamemode',
  'find-blocks',
  'find-entity',
  'find-item',
  'get-action-status',
  'get-block-info',
  'get-position',
  'get-server-status',
  'list-entities',
  'list-inventory',
  'observe-world',
  'read-chat',
])

function isBrowserMcpToolName(name: string) {
  return /(?:^|::)browser_(?:navigate|click|type|press|select|hover|drag|drop|file_upload|fill_form|handle_dialog|evaluate|tabs|go_|close|resize)/i.test(name)
}

function isMinecraftMcpToolName(name: string) {
  return /(?:^|::)minecraft::/i.test(name) || /^minecraft::/i.test(name)
}

function getUnqualifiedMcpToolName(name: string) {
  const separatorIndex = name.lastIndexOf(toolNameSeparator)
  return separatorIndex >= 0 ? name.slice(separatorIndex + toolNameSeparator.length) : name
}

function isDuplicateSensitiveMcpToolName(name: string) {
  const { serverName, toolName } = parseQualifiedToolName(name)
  if (serverName === computerUseServerName)
    return !computerUseReadOnlyToolNames.has(toolName) && !computerUseApprovalToolNames.has(toolName)

  if (isBrowserMcpToolName(name))
    return true

  if (!isMinecraftMcpToolName(name))
    return false

  return !minecraftReadOnlyToolNames.has(getUnqualifiedMcpToolName(name).toLowerCase())
}

function isBrowserTypeMcpToolName(name: string) {
  return /(?:^|::)browser_type$/i.test(name)
}

function isBrowserFillFormMcpToolName(name: string) {
  return /(?:^|::)browser_fill_form$/i.test(name)
}

function collapseAdjacentRepeatedMcpText(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length < 12)
    return text

  for (const repeatCount of [4, 3, 2]) {
    if (trimmed.length % repeatCount !== 0)
      continue

    const unitLength = trimmed.length / repeatCount
    if (unitLength < 6)
      continue

    const unit = trimmed.slice(0, unitLength)
    if (unit.repeat(repeatCount) === trimmed)
      return unit
  }

  return text
}

function stableMcpJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(item => stableMcpJson(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableMcpJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function extractPlaywrightRefFromTarget(target: unknown): { element?: string, ref?: string } | null {
  if (typeof target !== 'string')
    return null

  const trimmed = target.trim()
  const match = trimmed.match(/\[ref=([^\]\s]+)\]/) ?? trimmed.match(/\bref=([^\]\s]+)/)
  if (!match?.[1])
    return null

  const element = trimmed
    .replace(/\s*\[ref=[^\]]+\]\s*$/, '')
    .replace(/\s*\bref=[^\s]+\s*$/, '')
    .trim()
  return {
    element: element || undefined,
    ref: match[1],
  }
}

function normalizeBrowserTypeArguments(args: Record<string, unknown>) {
  let next = { ...args }
  let changed = false

  if (typeof next.text === 'string') {
    const collapsed = collapseAdjacentRepeatedMcpText(next.text)
    if (collapsed !== next.text) {
      next.text = collapsed
      changed = true
    }
  }

  const refInfo = extractPlaywrightRefFromTarget(next.target)
  if (refInfo) {
    next = {
      ...next,
      element: typeof next.element === 'string' ? next.element : refInfo.element ?? refInfo.ref,
      ref: typeof next.ref === 'string' ? next.ref : refInfo.ref,
    }
    delete next.target
    changed = true
  }

  return { args: next, changed }
}

function normalizeBrowserFillFormArguments(args: Record<string, unknown>) {
  const fields = args.fields
  if (!Array.isArray(fields))
    return { args, changed: false }

  let changed = false
  const normalizedFields = fields.map((field) => {
    if (!field || typeof field !== 'object' || Array.isArray(field))
      return field

    let next = { ...(field as Record<string, unknown>) }
    if (typeof next.value === 'string') {
      const collapsed = collapseAdjacentRepeatedMcpText(next.value)
      if (collapsed !== next.value) {
        next.value = collapsed
        changed = true
      }
    }

    const refInfo = extractPlaywrightRefFromTarget(next.target)
    if (refInfo) {
      next = {
        ...next,
        ref: typeof next.ref === 'string' ? next.ref : refInfo.ref,
      }
      delete next.target
      changed = true
    }

    return next
  })

  return changed
    ? { args: { ...args, fields: normalizedFields }, changed }
    : { args, changed: false }
}

function sanitizeBrowserMcpPayload(payload: ElectronMcpCallToolPayload): ElectronMcpCallToolPayload {
  if (!payload.arguments)
    return payload

  const normalized = isBrowserTypeMcpToolName(payload.name)
    ? normalizeBrowserTypeArguments(payload.arguments)
    : isBrowserFillFormMcpToolName(payload.name)
      ? normalizeBrowserFillFormArguments(payload.arguments)
      : { args: payload.arguments, changed: false }

  if (!normalized.changed)
    return payload

  return {
    ...payload,
    arguments: normalized.args,
    debug: {
      ...(payload.debug ?? {}),
      mainSanitizedBrowserPayload: true,
      mainOriginalArguments: previewMcpDebugValue(payload.arguments),
      mainSanitizedArguments: previewMcpDebugValue(normalized.args),
    },
  }
}

function createDuplicateMcpMutationResult(payload: ElectronMcpCallToolPayload): ElectronMcpCallToolResult {
  const browser = isBrowserMcpToolName(payload.name)
  const status = browser ? 'duplicate_browser_mutation_suppressed_in_main' : 'duplicate_mcp_mutation_suppressed_in_main'
  return {
    structuredContent: {
      status,
      target: payload.name,
      arguments: payload.arguments ?? {},
    },
    content: [{
      type: 'text',
      text: browser
        ? [
            `Duplicate browser state-changing MCP call suppressed in Electron main: ${payload.name}.`,
            'The same browser tool and arguments are already running or just ran.',
            'Use the existing result/snapshot instead of repeating the same browser mutation.',
          ].join(' ')
        : [
            `Duplicate state-changing MCP call suppressed in Electron main: ${payload.name}.`,
            'The same tool and arguments are already running or just ran.',
            'This is not a task failure; observe current state before issuing a different next command.',
          ].join(' '),
    }],
  }
}

function previewMcpDebugValue(value: unknown, maxLength = 1200): unknown {
  if (typeof value === 'string')
    return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value
  if (Array.isArray(value))
    return value.map(item => previewMcpDebugValue(item, Math.floor(maxLength / Math.max(1, value.length))))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'data' && typeof child === 'string' && child.length > 256) {
        out[key] = `[${child.length} bytes omitted from debug output]`
        continue
      }
      out[key] = previewMcpDebugValue(child, maxLength)
    }
    return out
  }
  return value
}

function summarizeMcpDebugResult(result: ElectronMcpCallToolResult | undefined) {
  if (!result)
    return undefined

  return {
    isError: result.isError,
    structuredContent: previewMcpDebugValue(result.structuredContent, 500),
    content: previewMcpDebugValue(result.content?.map((item) => {
      if (typeof item.text === 'string')
        return { ...item, text: previewMcpDebugValue(item.text, 500) }
      return item
    }), 800),
  }
}

function stringifyError(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function getConfigPath() {
  return join(app.getPath('userData'), 'mcp.json')
}

function parseQualifiedToolName(name: string) {
  const separatorIndex = name.indexOf(toolNameSeparator)
  if (separatorIndex <= 0 || separatorIndex === name.length - toolNameSeparator.length) {
    throw new Error(`invalid qualified tool name: ${name}`)
  }

  return {
    serverName: name.slice(0, separatorIndex),
    toolName: name.slice(separatorIndex + toolNameSeparator.length),
  }
}

function resolveFallbackToolName(toolName: string): string | undefined {
  const normalizedTransportPrefix = toolName
    .replace(/^\.(?:stdio|stdo)::/, '')
    .replace(/^(?:stdio|stdo)::/, '')
  if (normalizedTransportPrefix !== toolName) {
    return normalizedTransportPrefix
  }

  const lastSeparatorIndex = toolName.lastIndexOf(toolNameSeparator)
  if (lastSeparatorIndex <= 0 || lastSeparatorIndex === toolName.length - toolNameSeparator.length) {
    return undefined
  }

  return toolName.slice(lastSeparatorIndex + toolNameSeparator.length)
}

function describeServerCommand(config: ElectronMcpStdioServerConfig) {
  return config.url ?? config.command ?? ''
}

function getRequestTimeout(config: ElectronMcpStdioServerConfig) {
  return config.requestTimeoutMs
    ?? (config.longRunning ? mcpLongRunningRequestTimeoutMsec : mcpRequestTimeoutMsec)
}

function getMaxTotalTimeout(config: ElectronMcpStdioServerConfig) {
  return config.maxTotalTimeoutMs
    ?? (config.longRunning ? mcpLongRunningMaxTotalTimeoutMsec : mcpRequestMaxTotalTimeoutMsec)
}

function getStartupMode(config: ElectronMcpStdioServerConfig) {
  return config.startupMode ?? defaultStartupMode
}

function getTransportPid(transport: McpClientTransport) {
  const maybePid = (transport as { pid?: unknown }).pid
  return typeof maybePid === 'number' ? maybePid : null
}

function getTransportStderr(transport: McpClientTransport) {
  const maybeStderr = (transport as { stderr?: NodeJS.ReadableStream }).stderr
  return maybeStderr
}

function resolveMcpWorkingDirectory(cwd: string | undefined) {
  if (!cwd)
    return undefined

  if (isAbsolute(cwd))
    return cwd

  const appPath = app.getAppPath()
  const candidates = [
    resolve(process.cwd(), cwd),
    resolve(appPath, cwd),
    resolve(appPath, '..', cwd),
    resolve(appPath, '..', '..', cwd),
    resolve(appPath, '..', '..', '..', cwd),
  ]

  return candidates.find(candidate => existsSync(candidate)) ?? resolve(process.cwd(), cwd)
}

function extendMcpEnvironment(overrides: Record<string, string>) {
  const inherited = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  return { ...inherited, ...overrides }
}

function createTransport(config: ElectronMcpStdioServerConfig): McpClientTransport {
  if (config.url) {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers
        ? { headers: config.headers }
        : undefined,
    })
  }

  if (!config.command)
    throw new Error('MCP server must define either command or url')

  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    // MCP-specific variables extend the desktop environment so stdio commands
    // still retain PATH and can resolve node/pnpm exactly like existing entries.
    env: config.env ? extendMcpEnvironment(config.env) : undefined,
    cwd: resolveMcpWorkingDirectory(config.cwd),
    stderr: 'pipe',
  })
}

async function closeSession(session: McpServerSession) {
  try {
    await session.client.close()
  }
  catch {
    // Closing the transport below is still required for a partially-open
    // client, especially when interrupting a long-running stdio request.
  }
  finally {
    await session.transport.close()
  }
}

export function createMcpStdioManager(): McpStdioManager {
  const log = useLogg('main/mcp-stdio').useGlobalConfig()
  const callLog = useLogg('main/mcp-call').useGlobalConfig()
  const sessions = new Map<string, McpServerSession>()
  const serverConfigs = new Map<string, ElectronMcpStdioServerConfig>()
  const runtimeStatuses = new Map<string, ElectronMcpStdioServerRuntimeStatus>()
  const recentMcpMutations = new Map<string, { at: number, pending: boolean }>()
  const recentMcpCallsByModelToolCallId = new Map<string, { at: number, promise: Promise<ElectronMcpCallToolResult> }>()
  const computerUseChatSources = new Map<string, string>()
  let updatedAt = Date.now()
  let mcpCallSequence = 0

  const setRuntimeStatus = (status: ElectronMcpStdioServerRuntimeStatus) => {
    runtimeStatuses.set(status.name, status)
    updatedAt = Date.now()
  }

  const ensureConfigFile = async () => {
    const path = getConfigPath()
    await mkdir(app.getPath('userData'), { recursive: true })

    try {
      await readFile(path, 'utf-8')
    }
    catch {
      await writeFile(path, `${JSON.stringify(defaultMcpConfig, null, 2)}\n`)
    }

    return { path }
  }

  const openConfigFile = async () => {
    const { path } = await ensureConfigFile()
    shell.showItemInFolder(path)
    return { path }
  }

  const readConfigFile = async (path: string): Promise<ElectronMcpStdioConfigFile> => {
    const raw = await readFile(path, 'utf-8')
    return parseElectronMcpConfigText(raw)
  }

  const stopAll = async () => {
    const entries = [...sessions.entries()]
    for (const [name, session] of entries) {
      await closeSession(session)
      setRuntimeStatus({
        name,
        state: 'stopped',
        command: describeServerCommand(session.config),
        args: session.config.args ?? [],
        pid: null,
        startupMode: getStartupMode(session.config),
        longRunning: session.config.longRunning,
        persistent: session.config.persistent,
        requestTimeoutMs: getRequestTimeout(session.config),
        maxTotalTimeoutMs: getMaxTotalTimeout(session.config),
      })
      sessions.delete(name)
    }
  }

  const startServer = async (name: string, config: ElectronMcpStdioServerConfig) => {
    const transport = createTransport(config)
    const client = new Client({
      name: `proj-airi:stage-tamagotchi:mcp:${name}`,
      version: app.getVersion(),
    })

    try {
      await client.connect(transport)
      getTransportStderr(transport)?.on('data', (data) => {
        const text = data.toString('utf-8').trim()
        if (text) {
          log.withFields({ serverName: name }).warn(text)
        }
      })
      sessions.set(name, { client, transport, config })
      setRuntimeStatus({
        name,
        state: 'running',
        command: describeServerCommand(config),
        args: config.args ?? [],
        pid: getTransportPid(transport),
        startupMode: getStartupMode(config),
        longRunning: config.longRunning,
        persistent: config.persistent,
        requestTimeoutMs: getRequestTimeout(config),
        maxTotalTimeoutMs: getMaxTotalTimeout(config),
      })
    }
    catch (error) {
      await transport.close().catch(() => {})
      throw error
    }
  }

  const applyAndRestart = async (): Promise<ElectronMcpStdioApplyResult> => {
    const { path } = await ensureConfigFile()
    const config = await readConfigFile(path)

    await stopAll()
    runtimeStatuses.clear()
    serverConfigs.clear()

    const result: ElectronMcpStdioApplyResult = {
      path,
      started: [],
      failed: [],
      skipped: [],
    }

    for (const [name, server] of Object.entries(config.mcpServers)) {
      serverConfigs.set(name, server)
      if (server.enabled === false) {
        result.skipped.push({ name, reason: 'disabled' })
        setRuntimeStatus({
          name,
          state: 'stopped',
          command: describeServerCommand(server),
          args: server.args ?? [],
          pid: null,
          startupMode: getStartupMode(server),
          longRunning: server.longRunning,
          persistent: server.persistent,
          requestTimeoutMs: getRequestTimeout(server),
          maxTotalTimeoutMs: getMaxTotalTimeout(server),
        })
        continue
      }

      const startupMode = getStartupMode(server)
      if (startupMode !== 'on_startup') {
        result.skipped.push({ name, reason: startupMode })
        setRuntimeStatus({
          name,
          state: 'stopped',
          command: describeServerCommand(server),
          args: server.args ?? [],
          pid: null,
          startupMode,
          longRunning: server.longRunning,
          persistent: server.persistent,
          requestTimeoutMs: getRequestTimeout(server),
          maxTotalTimeoutMs: getMaxTotalTimeout(server),
        })
        continue
      }

      try {
        await startServer(name, server)
        result.started.push({ name })
      }
      catch (error) {
        const message = stringifyError(error)
        result.failed.push({ name, error: message })
        setRuntimeStatus({
          name,
          state: 'error',
          command: describeServerCommand(server),
          args: server.args ?? [],
          pid: null,
          lastError: message,
          startupMode,
          longRunning: server.longRunning,
          persistent: server.persistent,
          requestTimeoutMs: getRequestTimeout(server),
          maxTotalTimeoutMs: getMaxTotalTimeout(server),
        })
      }
    }

    updatedAt = Date.now()

    return result
  }

  const ensureServerRunning = async (serverName: string) => {
    const existing = sessions.get(serverName)
    if (existing)
      return existing

    const config = serverConfigs.get(serverName)
    if (!config)
      return undefined

    const startupMode = getStartupMode(config)
    if (config.enabled === false || startupMode === 'manual')
      return undefined

    if (startupMode !== 'on_first_use')
      return undefined

    try {
      await startServer(serverName, config)
      return sessions.get(serverName)
    }
    catch (error) {
      const message = stringifyError(error)
      setRuntimeStatus({
        name: serverName,
        state: 'error',
        command: describeServerCommand(config),
        args: config.args ?? [],
        pid: null,
        lastError: message,
        startupMode,
        longRunning: config.longRunning,
        persistent: config.persistent,
        requestTimeoutMs: getRequestTimeout(config),
        maxTotalTimeoutMs: getMaxTotalTimeout(config),
      })
      throw error
    }
  }

  const listTools = async (): Promise<ElectronMcpToolDescriptor[]> => {
    for (const [serverName, config] of serverConfigs.entries()) {
      if (config.enabled !== false && getStartupMode(config) === 'on_first_use') {
        try {
          await ensureServerRunning(serverName)
        }
        catch (error) {
          log.withFields({ serverName }).withError(error).warn('failed to lazily start mcp server')
        }
      }
    }

    const entries = [...sessions.entries()].sort(([left], [right]) => left.localeCompare(right))
    const listResult = await Promise.all(entries.map(async ([serverName, session]) => {
      try {
        const response = await session.client.listTools(undefined, {
          timeout: getRequestTimeout(session.config),
          maxTotalTimeout: getMaxTotalTimeout(session.config),
        })
        return response.tools
          // Approval controls are owned by Electron's native dialog, never the model.
          .filter(item => !isComputerUseApprovalTool(serverName, item.name))
          .map<ElectronMcpToolDescriptor>(item => ({
          serverName,
          name: `${serverName}${toolNameSeparator}${item.name}`,
          toolName: item.name,
          description: item.description,
          inputSchema: item.inputSchema,
          serverLongRunning: session.config.longRunning,
          serverPersistent: session.config.persistent,
          }))
      }
      catch (error) {
        log.withFields({ serverName }).withError(error).warn('failed to list tools from mcp server')
        return []
      }
    }))

    return listResult.flat()
  }

  function beginMcpMutation(payload: ElectronMcpCallToolPayload): { duplicate: boolean, key: string, duplicateSensitive: boolean } {
    if (!isDuplicateSensitiveMcpToolName(payload.name))
      return { duplicate: false, key: '', duplicateSensitive: false }

    const now = Date.now()
    for (const [key, entry] of recentMcpMutations) {
      if (now - entry.at > mcpMutationDedupeTtlMsec)
        recentMcpMutations.delete(key)
    }

    const key = `${payload.name}:${stableMcpJson(payload.arguments ?? {})}`
    if (recentMcpMutations.has(key))
      return { duplicate: true, key, duplicateSensitive: true }

    recentMcpMutations.set(key, { at: now, pending: true })
    return { duplicate: false, key, duplicateSensitive: true }
  }

  function finishMcpMutation(key: string, result: ElectronMcpCallToolResult) {
    if (!key)
      return

    if (result.isError) {
      recentMcpMutations.delete(key)
      return
    }

    recentMcpMutations.set(key, { at: Date.now(), pending: false })
  }

  function failMcpMutation(key: string) {
    if (key)
      recentMcpMutations.delete(key)
  }

  function getMcpModelToolCallIdempotencyKey(payload: ElectronMcpCallToolPayload) {
    const modelToolCallId = payload.debug?.modelToolCallId
    if (typeof modelToolCallId !== 'string' || !modelToolCallId)
      return undefined

    return `${modelToolCallId}:${payload.name}:${stableMcpJson(payload.arguments ?? {})}`
  }

  function cleanupRecentMcpCallIds(now: number) {
    for (const [key, entry] of recentMcpCallsByModelToolCallId) {
      if (now - entry.at > mcpCallIdempotencyTtlMsec)
        recentMcpCallsByModelToolCallId.delete(key)
    }
  }

  async function resolveComputerUseApproval(params: {
    serverName: string
    toolName: string
    session: McpServerSession
    result: ElectronMcpCallToolResult
  }): Promise<ElectronMcpCallToolResult> {
    if (params.serverName !== computerUseServerName)
      return params.result

    const structured = recordFrom(params.result.structuredContent)
    if (structured?.status !== 'approval_required')
      return params.result

    const pending = await params.session.client.callTool({
      name: 'desktop_list_pending_actions',
      arguments: {},
    }, undefined, {
      timeout: getRequestTimeout(params.session.config),
      maxTotalTimeout: getMaxTotalTimeout(params.session.config),
    })
    const pendingStructured = recordFrom('structuredContent' in pending ? pending.structuredContent : undefined)
    const pendingActions = Array.isArray(pendingStructured?.pendingActions)
      ? pendingStructured.pendingActions.map(recordFrom).filter((value): value is Record<string, unknown> => Boolean(value))
      : []
    const action = pendingActions.find(candidate => candidate.toolName === params.toolName)
    const actionId = typeof action?.id === 'string' ? action.id : undefined
    if (!actionId) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `Computer Use requested approval for ${params.toolName}, but AIRI could not locate its pending action.`,
        }],
      }
    }

    const actionSummary = JSON.stringify(action?.action ?? {}, null, 2).slice(0, 2000)
    const response = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Approve', 'Reject'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Lumi Computer Use',
      message: `Lumi wants to run ${params.toolName}.`,
      detail: `${actionSummary}\n\nThis action will run on your local Windows desktop.`,
    })
    const approvalTool = response.response === 0
      ? 'desktop_approve_pending_action'
      : 'desktop_reject_pending_action'
    const approved = await params.session.client.callTool({
      name: approvalTool,
      arguments: { id: actionId },
    }, undefined, {
      timeout: getRequestTimeout(params.session.config),
      maxTotalTimeout: getMaxTotalTimeout(params.session.config),
    })
    const normalized: ElectronMcpCallToolResult = {}
    if ('content' in approved && Array.isArray(approved.content))
      normalized.content = approved.content as Array<Record<string, unknown>>
    if ('structuredContent' in approved && recordFrom(approved.structuredContent))
      normalized.structuredContent = approved.structuredContent as Record<string, unknown>
    if ('isError' in approved && typeof approved.isError === 'boolean')
      normalized.isError = approved.isError
    return normalized
  }

  const callToolOnce = async (
    payload: ElectronMcpCallToolPayload,
    traceId: string,
    startedAt: number,
  ): Promise<ElectronMcpCallToolResult> => {
    const rendererTraceId = typeof payload.debug?.traceId === 'string' ? payload.debug.traceId : undefined
    const modelToolCallId = typeof payload.debug?.modelToolCallId === 'string' ? payload.debug.modelToolCallId : undefined
    const mutation = beginMcpMutation(payload)

    callLog.withFields({
      traceId,
      rendererTraceId,
      modelToolCallId,
      phase: 'manager_call_begin',
      toolName: payload.name,
      arguments: previewMcpDebugValue(payload.arguments ?? {}),
      rendererDebug: previewMcpDebugValue(payload.debug ?? {}),
      duplicateSensitive: mutation.duplicateSensitive,
    }).warn('[MCP_CALL_DEBUG]')

    if (mutation.duplicate) {
      callLog.withFields({
        traceId,
        rendererTraceId,
        modelToolCallId,
        phase: 'manager_duplicate_suppressed',
        toolName: payload.name,
        arguments: previewMcpDebugValue(payload.arguments ?? {}),
        rendererDebug: previewMcpDebugValue(payload.debug ?? {}),
        durationMs: Date.now() - startedAt,
      }).warn('[MCP_CALL_DEBUG]')
      return createDuplicateMcpMutationResult(payload)
    }

    const { serverName, toolName } = parseQualifiedToolName(payload.name)
    const isModelToolCall = typeof modelToolCallId === 'string' && modelToolCallId.length > 0
    const computerUseTurnId = typeof payload.debug?.computerUseTurnId === 'string'
      ? payload.debug.computerUseTurnId
      : undefined
    if (serverName === computerUseServerName
      && !computerUseReadOnlyToolNames.has(toolName)
      && (!isModelToolCall || !computerUseTurnId || ![...computerUseChatSources.values()].includes(computerUseTurnId))) {
      failMcpMutation(mutation.key)
      const error = new Error('Computer Use mutations require the current active Lumi chat turn.')
      callLog.withFields({
        traceId,
        rendererTraceId,
        modelToolCallId,
        phase: 'manager_computer_use_turn_rejected',
        serverName,
        toolName,
        hasModelToolCallId: isModelToolCall,
        hasComputerUseTurnId: !!computerUseTurnId,
        activeTurnCount: computerUseChatSources.size,
        error: error.message,
        durationMs: Date.now() - startedAt,
      }).warn('[MCP_CALL_DEBUG]')
      throw error
    }
    if (isComputerUseApprovalTool(serverName, toolName)) {
      throw new Error('Computer Use approval controls are reserved for AIRI native confirmation dialogs.')
    }
    const session = sessions.get(serverName) ?? await ensureServerRunning(serverName)
    if (!session) {
      failMcpMutation(mutation.key)
      const error = new Error(`mcp server is not running: ${serverName}`)
      callLog.withFields({
        traceId,
        rendererTraceId,
        modelToolCallId,
        phase: 'manager_no_session',
        serverName,
        toolName,
        error: error.message,
        durationMs: Date.now() - startedAt,
      }).warn('[MCP_CALL_DEBUG]')
      throw error
    }

    let result
    try {
      callLog.withFields({
        traceId,
        rendererTraceId,
        modelToolCallId,
        phase: 'client_call_begin',
        serverName,
        toolName,
        timeout: getRequestTimeout(session.config),
        maxTotalTimeout: getMaxTotalTimeout(session.config),
      }).warn('[MCP_CALL_DEBUG]')
      result = await session.client.callTool({
        name: toolName,
        arguments: payload.arguments ?? {},
      }, undefined, {
        timeout: getRequestTimeout(session.config),
        maxTotalTimeout: getMaxTotalTimeout(session.config),
      })
      callLog.withFields({
        traceId,
        rendererTraceId,
        modelToolCallId,
        phase: 'client_call_result',
        serverName,
        toolName,
        rawResult: previewMcpDebugValue(result, 1200),
        durationMs: Date.now() - startedAt,
      }).warn('[MCP_CALL_DEBUG]')
    }
    catch (error) {
      callLog.withFields({
        traceId,
        rendererTraceId,
        modelToolCallId,
        phase: 'client_call_error',
        serverName,
        toolName,
        error: stringifyError(error),
        durationMs: Date.now() - startedAt,
      }).warn('[MCP_CALL_DEBUG]')
      const fallbackToolName = resolveFallbackToolName(toolName)
      if (!fallbackToolName || fallbackToolName === toolName) {
        failMcpMutation(mutation.key)
        throw error
      }

      callLog.withFields({
        traceId,
        rendererTraceId,
        modelToolCallId,
        phase: 'client_fallback_begin',
        serverName,
        requestedToolName: toolName,
        fallbackToolName,
      }).warn('[MCP_CALL_DEBUG]')

      try {
        result = await session.client.callTool({
          name: fallbackToolName,
          arguments: payload.arguments ?? {},
        }, undefined, {
          timeout: getRequestTimeout(session.config),
          maxTotalTimeout: getMaxTotalTimeout(session.config),
        })
        callLog.withFields({
          traceId,
          rendererTraceId,
          modelToolCallId,
          phase: 'client_fallback_result',
          serverName,
          requestedToolName: toolName,
          fallbackToolName,
          rawResult: previewMcpDebugValue(result, 1200),
          durationMs: Date.now() - startedAt,
        }).warn('[MCP_CALL_DEBUG]')
      }
      catch (fallbackError) {
        failMcpMutation(mutation.key)
        callLog.withFields({
          traceId,
          rendererTraceId,
          modelToolCallId,
          phase: 'client_fallback_error',
          serverName,
          requestedToolName: toolName,
          fallbackToolName,
          error: stringifyError(fallbackError),
          durationMs: Date.now() - startedAt,
        }).warn('[MCP_CALL_DEBUG]')
        throw fallbackError
      }
    }

    const normalized: ElectronMcpCallToolResult = {}
    if ('content' in result && Array.isArray(result.content)) {
      normalized.content = result.content as Array<Record<string, unknown>>
    }
    if ('structuredContent' in result && result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)) {
      normalized.structuredContent = result.structuredContent as Record<string, unknown>
    }
    if ('isError' in result && typeof result.isError === 'boolean') {
      normalized.isError = result.isError
    }
    if ('toolResult' in result) {
      normalized.toolResult = result.toolResult
    }

    const resolved = await resolveComputerUseApproval({
      serverName,
      toolName,
      session,
      result: normalized,
    })
    finishMcpMutation(mutation.key, resolved)
    callLog.withFields({
      traceId,
      rendererTraceId,
      modelToolCallId,
      phase: 'manager_call_result',
      serverName,
      toolName,
      result: summarizeMcpDebugResult(resolved),
      durationMs: Date.now() - startedAt,
    }).warn('[MCP_CALL_DEBUG]')
    return resolved
  }

  const callTool = async (rawPayload: ElectronMcpCallToolPayload): Promise<ElectronMcpCallToolResult> => {
    const payload = sanitizeBrowserMcpPayload(rawPayload)
    const traceId = `mcp-main-${Date.now().toString(36)}-${++mcpCallSequence}`
    const startedAt = Date.now()
    const rendererTraceId = typeof payload.debug?.traceId === 'string' ? payload.debug.traceId : undefined
    const modelToolCallId = typeof payload.debug?.modelToolCallId === 'string' ? payload.debug.modelToolCallId : undefined
    const idempotencyKey = getMcpModelToolCallIdempotencyKey(payload)
    cleanupRecentMcpCallIds(startedAt)

    if (idempotencyKey) {
      const existing = recentMcpCallsByModelToolCallId.get(idempotencyKey)
      if (existing) {
        callLog.withFields({
          traceId,
          rendererTraceId,
          modelToolCallId,
          phase: 'manager_model_tool_call_id_duplicate_joined',
          toolName: payload.name,
          arguments: previewMcpDebugValue(payload.arguments ?? {}),
          rendererDebug: previewMcpDebugValue(payload.debug ?? {}),
          durationMs: Date.now() - startedAt,
        }).warn('[MCP_CALL_DEBUG]')
        return existing.promise
      }
    }

    const promise = callToolOnce(payload, traceId, startedAt)
    if (idempotencyKey) {
      recentMcpCallsByModelToolCallId.set(idempotencyKey, { at: startedAt, promise })
      promise.catch(() => {
        recentMcpCallsByModelToolCallId.delete(idempotencyKey)
      })
    }
    return promise
  }

  const interruptComputerUse = async () => {
    const session = sessions.get(computerUseServerName)
    if (!session)
      return { interrupted: false }

    // Closing the stdio session terminates the in-flight MCP request and its
    // child process. The normal on-first-use lifecycle recreates it on the
    // next intentional Computer Use call.
    sessions.delete(computerUseServerName)
    await closeSession(session)
    updatedAt = Date.now()
    runtimeStatuses.set(computerUseServerName, {
      name: computerUseServerName,
      state: 'stopped',
      command: session.config.command ?? session.config.url ?? '',
      args: session.config.args ?? [],
      pid: 0,
    })
    return { interrupted: true }
  }

  const setComputerUseChatActive = async (payload: { sourceId: string, active: boolean, reset?: boolean, turnId?: string }) => {
    if (payload.active && payload.reset)
      await interruptComputerUse()

    if (payload.active) {
      if (!payload.turnId)
        throw new Error('Computer Use chat activation requires a turn id.')
      computerUseChatSources.delete(payload.sourceId)
      computerUseChatSources.set(payload.sourceId, payload.turnId)
    }
    else {
      computerUseChatSources.delete(payload.sourceId)
    }

    if (computerUseChatSources.size === 0)
      await interruptComputerUse()
  }

  const getComputerUseChatTurn = (): ElectronMcpComputerUseChatTurn | undefined => {
    const active = [...computerUseChatSources.entries()].at(-1)
    return active
      ? { sourceId: active[0], turnId: active[1] }
      : undefined
  }

  const getRuntimeStatus = (): ElectronMcpStdioRuntimeStatus => {
    return {
      path: getConfigPath(),
      servers: [...runtimeStatuses.values()].sort((left, right) => left.name.localeCompare(right.name)),
      updatedAt,
    }
  }

  const readConfigText = async (): Promise<ElectronMcpStdioConfigText> => {
    const { path } = await ensureConfigFile()
    const text = await readFile(path, 'utf-8')
    return { path, text }
  }

  const writeConfigText = async (text: string): Promise<ElectronMcpStdioConfigText> => {
    const { path } = await ensureConfigFile()
    const validated = parseElectronMcpConfigText(text)
    const normalized = `${JSON.stringify(validated, null, 2)}\n`
    await writeFile(path, normalized)
    return { path, text: normalized }
  }

  const testServer = async (payload: ElectronMcpStdioTestPayload): Promise<ElectronMcpStdioTestResult> => {
    const startedAt = Date.now()
    let transport: McpClientTransport | null = null
    let client: Client | null = null
    const stderrChunks: string[] = []

    const withDeadline = <V>(promise: Promise<V>, ms: number, label: string): Promise<V> => {
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      })
      return Promise.race([promise, timeout]).finally(() => {
        if (timer)
          clearTimeout(timer)
      })
    }

    try {
      transport = createTransport(payload.config)
      client = new Client({
        name: `proj-airi:stage-tamagotchi:mcp:test:${payload.name}`,
        version: app.getVersion(),
      })

      getTransportStderr(transport)?.on('data', (data) => {
        const text = data.toString('utf-8')
        if (text)
          stderrChunks.push(text)
      })

      await withDeadline(client.connect(transport), getMaxTotalTimeout(payload.config), 'connect')

      const response = await client.listTools(undefined, {
        timeout: getRequestTimeout(payload.config),
        maxTotalTimeout: getMaxTotalTimeout(payload.config),
      })

      if (stderrChunks.length > 0) {
        log.withFields({ serverName: payload.name }).debug(stderrChunks.join('').trim())
      }

      return {
        ok: true,
        tools: response.tools.map(tool => tool.name),
        durationMs: Date.now() - startedAt,
      }
    }
    catch (error) {
      const message = stringifyError(error)
      // Keep only the tail so a noisy failed server cannot flood the settings UI.
      const stderr = stderrChunks.join('').trim().slice(-mcpTestStderrMaxChars)
      return {
        ok: false,
        error: stderr ? `${message}\n\n${stderr}` : message,
        durationMs: Date.now() - startedAt,
      }
    }
    finally {
      if (client) {
        await client.close().catch(() => {})
      }
      if (transport) {
        await transport.close().catch(() => {})
      }
    }
  }

  return {
    ensureConfigFile,
    openConfigFile,
    applyAndRestart,
    listTools,
    callTool,
    interruptComputerUse,
    setComputerUseChatActive,
    getComputerUseChatTurn,
    stopAll,
    getRuntimeStatus,
    readConfigText,
    writeConfigText,
    testServer,
  }
}

export async function setupMcpStdioManager() {
  const log = useLogg('main/mcp-stdio').useGlobalConfig()
  const manager = createMcpStdioManager()

  onAppBeforeQuit(async () => {
    await manager.stopAll()
  })

  await manager.ensureConfigFile()

  try {
    await manager.applyAndRestart()
  }
  catch (error) {
    log.withError(error).warn('failed to apply mcp stdio config during startup')
  }

  return manager
}

export function createMcpServersService(params: { context: ReturnType<typeof createContext>['context'], manager: McpStdioManager }) {
  const browserDebugLog = useLogg('main/mcp-browser-debug').useGlobalConfig()

  defineInvokeHandler(params.context, electronMcpOpenConfigFile, async () => {
    return params.manager.openConfigFile()
  })

  defineInvokeHandler(params.context, electronMcpApplyAndRestart, async () => {
    return params.manager.applyAndRestart()
  })

  defineInvokeHandler(params.context, electronMcpGetRuntimeStatus, async () => {
    return params.manager.getRuntimeStatus()
  })

  defineInvokeHandler(params.context, electronMcpListTools, async () => {
    return params.manager.listTools()
  })

  defineInvokeHandler(params.context, electronMcpCallTool, async (payload) => {
    const sanitizedPayload = sanitizeBrowserMcpPayload(payload)
    if (!isBrowserMcpToolName(sanitizedPayload.name))
      return params.manager.callTool(sanitizedPayload)

    const traceId = `mcp-main-${Date.now().toString(36)}`
    browserDebugLog.withFields({
      traceId,
      phase: 'main_handler_begin',
      target: sanitizedPayload.name,
      arguments: previewMcpDebugValue(sanitizedPayload.arguments),
      originalArguments: previewMcpDebugValue(payload.arguments),
      rendererDebug: previewMcpDebugValue(sanitizedPayload.debug),
    }).warn('[MCP_BROWSER_MAIN_DEBUG]')

    try {
      const result = await params.manager.callTool(sanitizedPayload)
      browserDebugLog.withFields({
        traceId,
        phase: 'main_handler_result',
        target: sanitizedPayload.name,
        result: summarizeMcpDebugResult(result),
        rendererDebug: previewMcpDebugValue(sanitizedPayload.debug),
      }).warn('[MCP_BROWSER_MAIN_DEBUG]')
      return result
    }
    catch (error) {
      browserDebugLog.withFields({
        traceId,
        phase: 'main_handler_error',
        target: sanitizedPayload.name,
        error: stringifyError(error),
        rendererDebug: previewMcpDebugValue(sanitizedPayload.debug),
      }).warn('[MCP_BROWSER_MAIN_DEBUG]')
      throw error
    }
  })

  defineInvokeHandler(params.context, electronMcpInterruptComputerUse, async () => {
    return params.manager.interruptComputerUse()
  })

  defineInvokeHandler(params.context, electronMcpSetComputerUseChatActive, async (payload) => {
    await params.manager.setComputerUseChatActive(payload)
  })

  defineInvokeHandler(params.context, electronMcpGetComputerUseChatTurn, () => {
    return params.manager.getComputerUseChatTurn()
  })

  defineInvokeHandler(params.context, electronMcpReadConfigText, async () => {
    return params.manager.readConfigText()
  })

  defineInvokeHandler(params.context, electronMcpWriteConfigText, async (payload) => {
    return params.manager.writeConfigText(payload.text)
  })

  defineInvokeHandler(params.context, electronMcpTestServer, async (payload) => {
    return params.manager.testServer(payload)
  })
}
