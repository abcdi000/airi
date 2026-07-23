import type { Tool } from '@xsai/shared-chat'
import type { JsonSchema } from 'xsschema'

import type { LumiToolExecuteOptionsExtension } from '../libs/lumi-tool-permissions'

import { errorMessageFrom } from '@moeru/std'
import { rawTool, tool } from '@xsai/tool'
import { z } from 'zod'

let mcpDebugSeq = 0

export const MCP_ACTIVITY_CHANNEL_NAME = 'airi-mcp-activity-monitor'
export const MCP_ACTIVITY_STORAGE_KEY = 'airi-mcp-activity-monitor/events'

export type McpActivityStatus = 'running' | 'completed' | 'failed' | 'suppressed'

export interface McpActivityEvent {
  kind: 'mcp-activity'
  traceId: string
  status: McpActivityStatus
  target: string
  modelToolName?: string
  modelToolCallId?: string
  startedAt: number
  endedAt?: number
  durationMs?: number
  arguments?: unknown
  result?: unknown
  error?: string
  duplicateSuppressed?: boolean
}

/**
 * Describes an MCP tool that can be exposed to the shared LLM runtime.
 *
 * Use when:
 * - A runtime needs to list available MCP tools before exposing them to models
 *
 * Expects:
 * - `name` is the fully-qualified tool name used for invocation
 *
 * Returns:
 * - The MCP tool descriptor metadata reported by the runtime
 */
export interface McpToolDescriptor {
  serverName: string
  name: string
  toolName: string
  description?: string
  inputSchema: Record<string, unknown>
  serverLongRunning?: boolean
  serverPersistent?: boolean
}

/**
 * Payload for invoking an MCP tool through a runtime-specific transport.
 *
 * Use when:
 * - A runtime needs to forward a tool invocation into the MCP layer
 *
 * Expects:
 * - `name` matches a descriptor returned from `listTools`
 * - `arguments` is a JSON-compatible object when provided
 *
 * Returns:
 * - The MCP tool call input envelope
 */
export interface McpCallToolPayload {
  name: string
  arguments?: Record<string, unknown>
  debug?: Record<string, unknown>
}

/**
 * Result returned from an MCP tool invocation.
 *
 * Use when:
 * - An MCP runtime returns tool output back to the shared LLM layer
 *
 * Expects:
 * - Error responses set `isError` when the tool execution failed
 *
 * Returns:
 * - Structured and unstructured MCP tool output
 */
export interface McpCallToolResult {
  content?: Array<Record<string, unknown>>
  structuredContent?: Record<string, unknown>
  toolResult?: unknown
  isError?: boolean
}

/**
 * Runtime contract for wiring MCP tool discovery and execution into `stage-ui`.
 *
 * Use when:
 * - A concrete runtime such as Electron needs to provide MCP access without a singleton bridge
 *
 * Expects:
 * - `listTools` and `callTool` are safe to call multiple times
 *
 * Returns:
 * - An object that can back `createMcpTools`
 */
export interface McpToolRuntime {
  listTools: () => Promise<McpToolDescriptor[]>
  callTool: (payload: McpCallToolPayload) => Promise<McpCallToolResult>
}

/**
 * Creates MCP proxy tools backed by a runtime-provided transport.
 *
 * Use when:
 * - A runtime wants to register MCP tools into the shared LLM tool store
 *
 * Expects:
 * - The runtime implements the `McpToolRuntime` contract
 *
 * Returns:
 * - xsai tool definition promises for MCP listing and invocation
 */
export function createMcpTools(runtime: McpToolRuntime): Array<Promise<Tool>> {
  return [
    tool({
      name: 'builtIn_mcpListTools',
      description: 'List all available MCP tools. Call this first to discover tool names before calling builtIn_mcpCallTool.',
      execute: async () => {
        try {
          return await runtime.listTools()
        }
        catch (error) {
          console.warn('[builtIn_mcpListTools] failed to list tools:', error)
          return ''
        }
      },
      parameters: z.object({}).strict(),
    }),
    tool({
      name: 'builtIn_mcpCallTool',
      description: 'Call an MCP tool by name. Use builtIn_mcpListTools first to get available tool names.',
      execute: async ({ name, arguments: argsJson }, executeOptions) => {
        try {
          const args = argsJson ? JSON.parse(argsJson) : {}
          return await runtime.callTool({
            name,
            arguments: args,
            debug: shouldAttachMcpDebugPayload()
              ? {
                  modelToolName: 'builtIn_mcpCallTool',
                  modelToolCallId: executeOptions?.toolCallId,
                }
              : undefined,
          })
        }
        catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: errorMessageFrom(error) ?? String(error) }],
          }
        }
      },
      // NOTICE: `arguments` is z.string() (JSON) because z.unknown() produces `{}` (no `type` key)
      // and z.record() emits `propertyNames`, both rejected by OpenAI.
      parameters: z.object({
        name: z.string().describe('Tool name in "<serverName>::<toolName>" format'),
        arguments: z.string().describe('JSON object of tool arguments, e.g. {"query":"hello","limit":10}'),
      }).strict(),
    }),
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hashText(text: string) {
  let hash = 0
  for (let i = 0; i < text.length; i += 1)
    hash = Math.imul(31, hash) + text.charCodeAt(i) | 0

  return Math.abs(hash).toString(36)
}

function sanitizeToolNamePart(text: string) {
  return text
    .replace(/[^a-z0-9_-]/gi, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'tool'
}

function reserveDirectToolName(base: string, descriptor: McpToolDescriptor, usedNames: Set<string>) {
  if (base.length > 64)
    base = `${base.slice(0, 55)}_${hashText(descriptor.name)}`

  let candidate = base
  let suffix = 2
  while (usedNames.has(candidate)) {
    const suffixText = `_${suffix}`
    candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`
    suffix += 1
  }
  usedNames.add(candidate)
  return candidate
}

function createDirectToolName(descriptor: McpToolDescriptor, usedNames: Set<string>) {
  const server = sanitizeToolNamePart(descriptor.serverName)
  const toolName = sanitizeToolNamePart(descriptor.toolName)
  return reserveDirectToolName(`mcp_${server}_${toolName}`, descriptor, usedNames)
}

function createDirectToolAliasNames(descriptor: McpToolDescriptor, canonicalName: string, usedNames: Set<string>) {
  const server = sanitizeToolNamePart(descriptor.serverName)
  const toolName = sanitizeToolNamePart(descriptor.toolName)
  if (!toolName.includes('-'))
    return []

  const candidates = [
    `mcp_${server}-${toolName}`,
    `mcp_${server}_${toolName.replace(/-/g, '_')}`,
  ]

  const aliases: string[] = []
  for (const candidate of candidates) {
    if (candidate === canonicalName || usedNames.has(candidate))
      continue
    aliases.push(reserveDirectToolName(candidate, descriptor, usedNames))
  }
  return aliases
}

function pruneJsonSchema(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(item => pruneJsonSchema(item))

  if (!isRecord(value))
    return value

  const unsupportedKeys = new Set([
    '$schema',
    '$id',
    'propertyNames',
    'unevaluatedProperties',
    'dependentSchemas',
    'dependentRequired',
  ])
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (unsupportedKeys.has(key))
      continue
    out[key] = pruneJsonSchema(child)
  }
  return out
}

function normalizeInputSchema(schema: Record<string, unknown>): JsonSchema {
  const pruned = pruneJsonSchema(schema)
  if (!isRecord(pruned) || pruned.type !== 'object') {
    return {
      type: 'object',
      properties: {},
      additionalProperties: true,
    } as JsonSchema
  }

  return {
    ...pruned,
    type: 'object',
    properties: isRecord(pruned.properties) ? pruned.properties : {},
    additionalProperties: pruned.additionalProperties ?? true,
  } as JsonSchema
}

function isBrowserStateChangingTool(descriptor: McpToolDescriptor): boolean {
  const toolName = descriptor.toolName || descriptor.name.split('::').at(-1) || descriptor.name
  return /^browser_(?:navigate|click|type|press|select|hover|drag|drop|file_upload|fill_form|handle_dialog|evaluate|tabs|go_|close|resize)/i.test(toolName)
}

function isBrowserDuplicateSensitiveTool(descriptor: McpToolDescriptor): boolean {
  const toolName = descriptor.toolName || descriptor.name.split('::').at(-1) || descriptor.name
  return /^browser_(?:navigate|click|type|press|select|drag|drop|file_upload|fill_form|handle_dialog|evaluate|tabs|go_|close|resize)/i.test(toolName)
}

function isBrowserNavigationTool(descriptor: McpToolDescriptor): boolean {
  const toolName = descriptor.toolName || descriptor.name.split('::').at(-1) || descriptor.name
  return /^browser_(?:navigate|go_)/i.test(toolName)
}

function isComputerUseTool(descriptor: McpToolDescriptor | undefined, target: string): boolean {
  return descriptor?.serverName === 'computer_use' || target.startsWith('computer_use::')
}

const COMPUTER_USE_TEXT_LIMIT = 6_000
const COMPUTER_USE_ARRAY_LIMIT = 16
const COMPUTER_USE_OBJECT_LIMIT = 40

function compactComputerUseValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > COMPUTER_USE_TEXT_LIMIT
      ? `${value.slice(0, COMPUTER_USE_TEXT_LIMIT - 3)}...`
      : value
  }
  if (Array.isArray(value)) {
    const compacted = value.slice(0, COMPUTER_USE_ARRAY_LIMIT).map(item => compactComputerUseValue(item, depth + 1))
    if (value.length > COMPUTER_USE_ARRAY_LIMIT)
      compacted.push(`[${value.length - COMPUTER_USE_ARRAY_LIMIT} additional items omitted]`)
    return compacted
  }
  if (!isRecord(value))
    return value

  if (depth >= 5)
    return '[nested detail omitted]'

  const out: Record<string, unknown> = {}
  let count = 0
  for (const [key, child] of Object.entries(value)) {
    // Image bytes belong to the MCP session artifact, never the language-model
    // transcript. Paths and dimensions remain available in structured state.
    if (key === 'data' && typeof child === 'string' && child.length > 256)
      continue
    if (count >= COMPUTER_USE_OBJECT_LIMIT) {
      out._truncated = `${Object.keys(value).length - COMPUTER_USE_OBJECT_LIMIT} fields omitted`
      break
    }
    out[key] = compactComputerUseValue(child, depth + 1)
    count += 1
  }
  return out
}

function compactComputerUseResult(result: McpCallToolResult): McpCallToolResult {
  return {
    ...result,
    content: result.content?.map((item) => {
      if (item.type === 'image') {
        return {
          type: 'text',
          text: '[Desktop screenshot retained in the Computer Use session; use desktop_observe semantic targets or desktop_get_state instead of requesting raw image bytes.]',
        }
      }
      return compactComputerUseValue(item) as Record<string, unknown>
    }),
    structuredContent: result.structuredContent
      ? compactComputerUseValue(result.structuredContent) as Record<string, unknown>
      : undefined,
    toolResult: result.toolResult === undefined ? undefined : compactComputerUseValue(result.toolResult),
  }
}

function nextMcpDebugTraceId(prefix = 'mcp-renderer') {
  mcpDebugSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${mcpDebugSeq}`
}

function previewDebugValue(value: unknown, maxLength = 1200): unknown {
  if (typeof value === 'string')
    return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value
  if (Array.isArray(value))
    return value.map(item => previewDebugValue(item, Math.floor(maxLength / Math.max(1, value.length))))
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value))
      out[key] = previewDebugValue(child, maxLength)
    return out
  }
  return value
}

function summarizeMcpResultForDebug(result: McpCallToolResult | undefined) {
  if (!result)
    return undefined

  return {
    isError: result.isError,
    structuredContent: previewDebugValue(result.structuredContent, 500),
    content: previewDebugValue(result.content?.map((item) => {
      if (typeof item.text === 'string')
        return { ...item, text: previewDebugValue(item.text, 500) }
      return item
    }), 800),
  }
}

function logMcpBrowserDebug(event: Record<string, unknown>) {
  console.info('[MCP_BROWSER_DEBUG]', event)
}

function logMcpRendererDebug(event: Record<string, unknown>) {
  console.info('[MCP_RENDERER_DEBUG]', event)
}

function isMcpActivityEventRecord(value: unknown): value is McpActivityEvent {
  return isRecord(value)
    && value.kind === 'mcp-activity'
    && typeof value.traceId === 'string'
    && typeof value.status === 'string'
    && typeof value.target === 'string'
    && typeof value.startedAt === 'number'
}

function publishMcpActivityEvent(event: McpActivityEvent) {
  if (typeof window === 'undefined')
    return

  try {
    const storage = window.localStorage
    const current = JSON.parse(storage.getItem(MCP_ACTIVITY_STORAGE_KEY) || '[]')
    const events: McpActivityEvent[] = Array.isArray(current) ? current.filter(isMcpActivityEventRecord) : []
    const existingIndex = events.findIndex(item => item.traceId === event.traceId)
    if (existingIndex >= 0)
      events.splice(existingIndex, 1, event)
    else
      events.unshift(event)
    storage.setItem(MCP_ACTIVITY_STORAGE_KEY, JSON.stringify(events.slice(0, 40)))
  }
  catch {
    // Best-effort debug UI only. MCP execution must never depend on storage.
  }

  if (typeof BroadcastChannel === 'undefined')
    return

  try {
    const channel = new BroadcastChannel(MCP_ACTIVITY_CHANNEL_NAME)
    channel.postMessage(event)
    channel.close()
  }
  catch {
    // Best-effort debug UI only. MCP execution must never depend on the monitor.
  }
}

function shouldAttachMcpDebugPayload() {
  return typeof window !== 'undefined'
}

function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(item => stableJson(item)).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function collapseAdjacentRepeatedText(text: string): string {
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

function sanitizeBrowserMutationArguments(descriptor: McpToolDescriptor, args: Record<string, unknown>): Record<string, unknown> {
  const toolName = descriptor.toolName || descriptor.name.split('::').at(-1) || descriptor.name
  if (/^browser_fill_form$/i.test(toolName)) {
    const fields = args.fields
    if (!Array.isArray(fields))
      return args

    let changed = false
    const normalizedFields = fields.map((field) => {
      if (!isRecord(field))
        return field

      let next = { ...field }
      if (typeof next.value === 'string') {
        const collapsed = collapseAdjacentRepeatedText(next.value)
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
      ? { ...args, fields: normalizedFields }
      : args
  }

  if (!/^browser_type$/i.test(toolName))
    return args

  let next = { ...args }
  let changed = false

  if (typeof next.text === 'string') {
    const collapsed = collapseAdjacentRepeatedText(next.text)
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

  return changed ? next : args
}

function createDuplicateBrowserMutationResult(descriptor: McpToolDescriptor, args: Record<string, unknown>): McpCallToolResult {
  return {
    structuredContent: {
      status: 'duplicate_browser_mutation_suppressed',
      target: descriptor.name,
      arguments: args,
    },
    content: [{
      type: 'text',
      text: [
        `Duplicate browser state-changing MCP call suppressed: ${descriptor.name}.`,
        'AIRI already received the same tool name with the same arguments very recently, so it was not executed again.',
        'Read the current snapshot/result before deciding whether another different browser action is needed.',
      ].join(' '),
    }],
  }
}

function createBrowserMutationDedupe(descriptors: McpToolDescriptor[], ttlMs = 15_000) {
  const descriptorsByName = new Map(descriptors.map(descriptor => [descriptor.name, descriptor]))
  const recent = new Map<string, { status: 'pending' | 'executed', at: number }>()

  function cleanup(now: number) {
    for (const [key, entry] of recent) {
      if (now - entry.at > ttlMs)
        recent.delete(key)
    }
  }

  function begin(name: string, args: Record<string, unknown>) {
    const descriptor = descriptorsByName.get(name)
    if (!descriptor || !isBrowserDuplicateSensitiveTool(descriptor))
      return { descriptor, args, key: '', normalizedChanged: false, suppressed: null }

    const now = Date.now()
    cleanup(now)

    const normalizedArgs = sanitizeBrowserMutationArguments(descriptor, args)
    const normalizedChanged = stableJson(args) !== stableJson(normalizedArgs)
    const key = `${descriptor.name}:${stableJson(normalizedArgs)}`
    if (recent.has(key)) {
      return {
        descriptor,
        args: normalizedArgs,
        key,
        normalizedChanged,
        suppressed: createDuplicateBrowserMutationResult(descriptor, normalizedArgs),
      }
    }

    recent.set(key, { status: 'pending', at: now })
    return { descriptor, args: normalizedArgs, key, normalizedChanged, suppressed: null }
  }

  function finish(key: string, result: McpCallToolResult) {
    if (!key)
      return
    if (result.isError) {
      recent.delete(key)
      return
    }
    recent.set(key, { status: 'executed', at: Date.now() })
  }

  function fail(key: string) {
    if (key)
      recent.delete(key)
  }

  return { begin, finish, fail }
}

function resultText(value: unknown): string {
  if (typeof value === 'string')
    return value
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}

function isRecoverableBrowserNavigationError(result: McpCallToolResult) {
  if (!result.isError)
    return false

  const text = resultText(result)
  return /ERR_ABORTED|navigation.+interrupted|net::ERR_|timeout/i.test(text)
}

function findBrowserSnapshotDescriptor(descriptor: McpToolDescriptor, descriptors: McpToolDescriptor[]) {
  return descriptors.find(candidate =>
    candidate.serverName === descriptor.serverName
    && (candidate.toolName === 'browser_snapshot' || candidate.name.endsWith('::browser_snapshot')),
  )
}

function findBrowserWaitDescriptor(descriptor: McpToolDescriptor, descriptors: McpToolDescriptor[]) {
  return descriptors.find(candidate =>
    candidate.serverName === descriptor.serverName
    && (candidate.toolName === 'browser_wait' || candidate.name.endsWith('::browser_wait')),
  )
}

function getInputSchemaProperties(descriptor: McpToolDescriptor) {
  const properties = descriptor.inputSchema.properties
  return isRecord(properties) ? properties : {}
}

function buildBrowserWaitArguments(descriptor: McpToolDescriptor) {
  const properties = getInputSchemaProperties(descriptor)
  if ('time' in properties)
    return { time: 2 }
  if ('seconds' in properties)
    return { seconds: 2 }
  if ('duration' in properties)
    return { duration: 2 }
  if ('durationMs' in properties)
    return { durationMs: 2_000 }
  if ('timeoutMs' in properties)
    return { timeoutMs: 2_000 }
  return {}
}

async function waitBeforeBrowserSnapshot(
  runtime: McpToolRuntime,
  descriptor: McpToolDescriptor,
  descriptors: McpToolDescriptor[],
) {
  const waitDescriptor = findBrowserWaitDescriptor(descriptor, descriptors)
  if (!waitDescriptor)
    return

  try {
    await runtime.callTool({
      name: waitDescriptor.name,
      arguments: buildBrowserWaitArguments(waitDescriptor),
    })
  }
  catch {
    // Best-effort only: the snapshot still gives the model fresh evidence when
    // the underlying MCP server lacks a compatible browser_wait schema.
  }
}

async function callBrowserSnapshotAfterStateChange(
  runtime: McpToolRuntime,
  descriptor: McpToolDescriptor,
  descriptors: McpToolDescriptor[],
  result: McpCallToolResult,
) {
  const shouldRecoverFromNavigationError = isBrowserNavigationTool(descriptor) && isRecoverableBrowserNavigationError(result)
  if (!isBrowserStateChangingTool(descriptor) || (result.isError && !shouldRecoverFromNavigationError))
    return result

  const snapshotDescriptor = findBrowserSnapshotDescriptor(descriptor, descriptors)
  if (!snapshotDescriptor)
    return result

  try {
    await waitBeforeBrowserSnapshot(runtime, descriptor, descriptors)

    const snapshot = await runtime.callTool({
      name: snapshotDescriptor.name,
      arguments: {},
    })

    return {
      toolResult: result,
      followUpSnapshot: {
        target: snapshotDescriptor.name,
        result: snapshot,
      },
      guidance: shouldRecoverFromNavigationError
        ? 'The browser navigation reported a recoverable network/navigation error, then AIRI waited briefly and captured browser_snapshot. Use followUpSnapshot, not the navigation error alone, as the current page evidence before deciding whether the page is accessible.'
        : 'A browser state-changing tool was followed by a brief wait and an automatic browser_snapshot. Use followUpSnapshot as the current page evidence before answering.',
    }
  }
  catch (error) {
    return {
      toolResult: result,
      followUpSnapshot: {
        target: snapshotDescriptor.name,
        isError: true,
        content: [{ type: 'text', text: errorMessageFrom(error) ?? String(error) }],
      },
      guidance: 'A browser state-changing tool succeeded, but the automatic browser_snapshot failed. Do not claim page contents unless another snapshot or page-reading tool succeeds.',
    }
  }
}

/**
 * Creates direct model-facing tools for every discovered MCP tool.
 *
 * Use when:
 * - A runtime has live MCP descriptors and wants the model to call them without
 *   first serializing `builtIn_mcpCallTool.arguments` as a JSON string
 *
 * Expects:
 * - `runtime.listTools()` returns fully-qualified descriptor names
 *
 * Returns:
 * - Proxy tools plus one direct `mcp_<server>_<tool>` tool per MCP descriptor
 */
export async function createMcpRuntimeTools(runtime: McpToolRuntime): Promise<Tool[]> {
  const descriptors = await runtime.listTools().catch((error) => {
    console.warn('[createMcpRuntimeTools] failed to list direct MCP tools:', error)
    return [] as McpToolDescriptor[]
  })
  const browserMutationDedupe = createBrowserMutationDedupe(descriptors)
  const guardedRuntime: McpToolRuntime = {
    listTools: runtime.listTools,
    callTool: async (payload) => {
      const args = payload.arguments ?? {}
      const guard = browserMutationDedupe.begin(payload.name, args)
      const shouldDebug = !!guard.descriptor && isBrowserStateChangingTool(guard.descriptor)
      const traceId = nextMcpDebugTraceId(shouldDebug ? 'mcp-browser' : 'mcp-renderer')
      const startedAt = Date.now()
      const modelToolName = typeof payload.debug?.modelToolName === 'string'
        ? payload.debug.modelToolName
        : undefined
      const modelToolCallId = typeof payload.debug?.modelToolCallId === 'string'
        ? payload.debug.modelToolCallId
        : undefined
      logMcpRendererDebug({
        traceId,
        phase: 'renderer_guard_begin',
        target: payload.name,
        rawArguments: previewDebugValue(args),
        normalizedArguments: previewDebugValue(guard.args),
        normalizedChanged: guard.normalizedChanged,
        duplicateSuppressed: !!guard.suppressed,
        payloadDebug: previewDebugValue(payload.debug),
      })
      if (shouldDebug) {
        logMcpBrowserDebug({
          traceId,
          phase: 'renderer_guard_begin',
          target: payload.name,
          rawArguments: previewDebugValue(args),
          normalizedArguments: previewDebugValue(guard.args),
          normalizedChanged: guard.normalizedChanged,
          duplicateSuppressed: !!guard.suppressed,
        })
      }
      publishMcpActivityEvent({
        kind: 'mcp-activity',
        traceId,
        status: 'running',
        target: payload.name,
        modelToolName,
        modelToolCallId,
        startedAt,
        arguments: previewDebugValue(guard.args),
        duplicateSuppressed: !!guard.suppressed,
      })
      if (guard.suppressed) {
        const endedAt = Date.now()
        publishMcpActivityEvent({
          kind: 'mcp-activity',
          traceId,
          status: 'suppressed',
          target: payload.name,
          modelToolName,
          modelToolCallId,
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
          arguments: previewDebugValue(guard.args),
          result: summarizeMcpResultForDebug(guard.suppressed),
          duplicateSuppressed: true,
        })
        return guard.suppressed
      }

      try {
        const debugPayload = shouldAttachMcpDebugPayload()
          ? {
              ...(payload.debug ?? {}),
              traceId,
              phase: 'renderer_to_main',
              target: payload.name,
              rawArguments: previewDebugValue(args),
              normalizedArguments: previewDebugValue(guard.args),
              normalizedChanged: guard.normalizedChanged,
              duplicateSuppressed: false,
            }
          : undefined
        const rawResult = await runtime.callTool({
          ...payload,
          arguments: guard.args,
          debug: debugPayload,
        })
        const result = isComputerUseTool(guard.descriptor, payload.name)
          ? compactComputerUseResult(rawResult)
          : rawResult
        logMcpRendererDebug({
          traceId,
          phase: 'renderer_runtime_result',
          target: payload.name,
          executedArguments: previewDebugValue(guard.args),
          result: summarizeMcpResultForDebug(result),
          payloadDebug: previewDebugValue(payload.debug),
        })
        if (shouldDebug) {
          logMcpBrowserDebug({
            traceId,
            phase: 'renderer_runtime_result',
            target: payload.name,
            executedArguments: previewDebugValue(guard.args),
            result: summarizeMcpResultForDebug(result),
          })
        }
        browserMutationDedupe.finish(guard.key, result)
        const endedAt = Date.now()
        publishMcpActivityEvent({
          kind: 'mcp-activity',
          traceId,
          status: result.isError ? 'failed' : 'completed',
          target: payload.name,
          modelToolName,
          modelToolCallId,
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
          arguments: previewDebugValue(guard.args),
          result: summarizeMcpResultForDebug(result),
          duplicateSuppressed: false,
        })
        return result
      }
      catch (error) {
        browserMutationDedupe.fail(guard.key)
        logMcpRendererDebug({
          traceId,
          phase: 'renderer_runtime_error',
          target: payload.name,
          executedArguments: previewDebugValue(guard.args),
          error: errorMessageFrom(error) ?? String(error),
          payloadDebug: previewDebugValue(payload.debug),
        })
        if (shouldDebug) {
          logMcpBrowserDebug({
            traceId,
            phase: 'renderer_runtime_error',
            target: payload.name,
            executedArguments: previewDebugValue(guard.args),
            error: errorMessageFrom(error) ?? String(error),
          })
        }
        const endedAt = Date.now()
        publishMcpActivityEvent({
          kind: 'mcp-activity',
          traceId,
          status: 'failed',
          target: payload.name,
          modelToolName,
          modelToolCallId,
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
          arguments: previewDebugValue(guard.args),
          error: errorMessageFrom(error) ?? String(error),
          duplicateSuppressed: false,
        })
        throw error
      }
    },
  }
  const proxyTools = await Promise.all(createMcpTools(guardedRuntime))
  const usedNames = new Set(proxyTools.map(entry => entry.function.name))

  const directTools = descriptors.flatMap((descriptor) => {
    const canonicalName = createDirectToolName(descriptor, usedNames)
    const names = [
      canonicalName,
      ...createDirectToolAliasNames(descriptor, canonicalName, usedNames),
    ]
    const description = [
      descriptor.description || `Call MCP tool ${descriptor.name}.`,
      `MCP target: ${descriptor.name}`,
      descriptor.serverLongRunning
        ? 'This MCP server is configured as long-running. A single call may take longer than normal; continue with incremental tool calls until the goal, a real blocker, or a permission boundary is reached.'
        : '',
      descriptor.serverPersistent
        ? 'This MCP server is persistent. Treat it as an external stateful world/session; preserve continuity and do not assume state resets between calls.'
        : '',
      isBrowserDuplicateSensitiveTool(descriptor)
        ? 'This browser tool changes external state. Do not call it again with the same arguments to verify success; inspect followUpSnapshot/browser_snapshot instead.'
        : '',
    ].join('\n')

    return names.map(name => rawTool({
      name,
      description: name === canonicalName
        ? description
        : [
            description,
            `Alias for ${canonicalName}. Use this only when a previous tool call name used this spelling.`,
          ].join('\n'),
      parameters: normalizeInputSchema(descriptor.inputSchema),
      strict: false,
      execute: async (args, executeOptions) => {
        try {
          const result = await guardedRuntime.callTool({
            name: descriptor.name,
            arguments: isRecord(args) ? args : {},
            debug: shouldAttachMcpDebugPayload()
              ? {
                  modelToolName: name,
                  modelToolCallId: executeOptions?.toolCallId,
                  mcpTarget: descriptor.name,
                  lumiResourceLease: (executeOptions as typeof executeOptions & LumiToolExecuteOptionsExtension)?.lumiResourceLease,
                }
              : undefined,
          })
          return await callBrowserSnapshotAfterStateChange(guardedRuntime, descriptor, descriptors, result)
        }
        catch (error) {
          return {
            isError: true,
            content: [{ type: 'text', text: errorMessageFrom(error) ?? String(error) }],
          }
        }
      },
    }))
  })

  return [...proxyTools, ...directTools]
}

function createUnavailableMcpToolRuntime(): McpToolRuntime {
  return {
    async listTools() {
      throw new Error('MCP tools are not available in this runtime.')
    },
    async callTool() {
      throw new Error('MCP tools are not available in this runtime.')
    },
  }
}

/**
 * Builds the default stage-ui MCP tool set without depending on runtime singletons.
 *
 * Use when:
 * - Shared code needs the MCP tool schema before a concrete runtime registers live implementations
 *
 * Expects:
 * - Runtime-specific callers override these tools through `useLlmToolsStore`
 *
 * Returns:
 * - MCP tool definitions with an unavailable-runtime fallback
 */
export async function mcp(): Promise<Tool[]> {
  return await Promise.all(createMcpTools(createUnavailableMcpToolRuntime()))
}
