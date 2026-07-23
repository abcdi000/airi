import type { LumiChannelToolScope } from '@proj-airi/stage-shared/server-channel-qr'
import type { Tool } from '@xsai/shared-chat'

export type LumiExclusiveToolResource = 'browser' | 'computer-use' | 'minecraft'

/** Content-free metadata forwarded to Electron for active MCP lease ownership. */
export interface LumiToolResourceLeaseMetadata {
  id: string
  resource: LumiExclusiveToolResource
  toolName: string
  actorId: string
  conversationId: string
  deviceId?: string
}

interface LumiToolLeaseOwner {
  actorId: string
  conversationId: string
  deviceId?: string
}

export interface LumiToolExecuteOptionsExtension {
  lumiResourceLease?: LumiToolResourceLeaseMetadata
}

const activeFallbackResources = new Set<LumiExclusiveToolResource>()

function toolNameFrom(tool: Tool) {
  const candidate = tool as Tool & { name?: string, function?: { name?: string } }
  return candidate.function?.name ?? candidate.name ?? ''
}

/** Classifies a model-facing tool into one explicit remote-device permission. */
export function classifyLumiRemoteTool(tool: Tool): LumiChannelToolScope | undefined {
  const name = toolNameFrom(tool).toLowerCase()
  if (name === 'lumi_memory_search')
    return 'lumi:tool:memory'
  if (/^mcp_computer[_-]use[_-]/.test(name))
    return 'lumi:tool:computer-use'
  if (/^mcp_[a-z\d_-]*minecraft[a-z\d_-]*[_-]/.test(name))
    return 'lumi:tool:minecraft'
  if (/^mcp_(?:playwright|browser|fetch|web|search)[_-]/.test(name) || /^mcp_[a-z\d_-]+[_-]browser[_-]/.test(name))
    return 'lumi:tool:web'
  return undefined
}

function resourceFor(scope: LumiChannelToolScope): LumiExclusiveToolResource | undefined {
  if (scope === 'lumi:tool:web')
    return 'browser'
  if (scope === 'lumi:tool:minecraft')
    return 'minecraft'
  if (scope === 'lumi:tool:computer-use')
    return 'computer-use'
  return undefined
}

async function withExclusiveToolResource<T>(resource: LumiExclusiveToolResource, callback: () => Promise<T>): Promise<T> {
  const lockName = `lumi:tool-resource:${resource}`
  if (typeof navigator !== 'undefined' && 'locks' in navigator && typeof navigator.locks.request === 'function') {
    const result = await navigator.locks.request(lockName, { ifAvailable: true }, async lock => lock
      ? { acquired: true as const, value: await callback() }
      : { acquired: false as const })
    if (!result.acquired)
      throw new Error(`Lumi shared ${resource} resource is busy with another conversation. Try again shortly.`)
    return result.value
  }

  if (activeFallbackResources.has(resource))
    throw new Error(`Lumi shared ${resource} resource is busy with another conversation. Try again shortly.`)
  activeFallbackResources.add(resource)
  try {
    return await callback()
  }
  finally {
    activeFallbackResources.delete(resource)
  }
}

function createLeaseId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `lumi-resource-${crypto.randomUUID()}`
    : `lumi-resource-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function withResourcePolicy(tool: Tool, scope: LumiChannelToolScope, owner?: LumiToolLeaseOwner): Tool {
  const resource = resourceFor(scope)
  if (!resource)
    return tool
  return {
    ...tool,
    execute: async (input, options) => await withExclusiveToolResource(resource, async () => {
      const extendedOptions: typeof options & LumiToolExecuteOptionsExtension = {
        ...options,
        lumiResourceLease: owner
          ? {
              id: createLeaseId(),
              resource,
              toolName: toolNameFrom(tool),
              actorId: owner.actorId,
              conversationId: owner.conversationId,
              deviceId: owner.deviceId,
            }
          : undefined,
      }
      return await tool.execute(input, extendedOptions)
    }),
  }
}

/**
 * Creates the final tool policy for one authenticated remote Lumi turn.
 *
 * Use when:
 * - A LAN device turn must expose only explicitly granted tool classes
 * - Stateful browser, Minecraft, and native computer tools share one host resource
 *
 * Expects:
 * - Trusted local turns do not call this transform
 * - Unknown tool names remain denied unless the caller has the internal `*` scope
 *
 * Returns:
 * - A transform applied after builtin and custom tools have been merged
 */
export function createLumiRemoteToolTransform(scopes: readonly string[], owner?: LumiToolLeaseOwner) {
  const granted = new Set(scopes)
  const unrestricted = granted.has('*')
  return (tools: Tool[]) => tools.flatMap((tool) => {
    const scope = classifyLumiRemoteTool(tool)
    if (!scope)
      return unrestricted ? [tool] : []
    if (!unrestricted && !granted.has(scope))
      return []
    return [withResourcePolicy(tool, scope, owner)]
  })
}
