import type {
  AgentToolsRegistrationContext,
  ToolRegistry,
  ToolSideEffectType,
} from '@proj-airi/lumi-agent-runtime'
import type { Tool } from '@xsai/shared-chat'

import { errorMessageFrom } from '@moeru/std'

/**
 * Registers live xsai MCP and plugin tools in Lumi's canonical Tool Registry.
 *
 * Use when:
 * - The desktop Agent Runtime needs the same tools as the legacy chat runtime
 * - MCP and plugin registrations have already been resolved by their host stores
 *
 * Expects:
 * - Provider keys identify the owning runtime, such as `mcp` or `plugin-tools`
 * - Tool names are stable for the duration of one Agent turn
 *
 * Returns:
 * - The number of newly registered tools
 */
export function registerRuntimeTools(
  registry: ToolRegistry,
  toolsByProvider: Readonly<Record<string, readonly Tool[]>>,
  registration: AgentToolsRegistrationContext,
): number {
  let registered = 0
  for (const [provider, tools] of Object.entries(toolsByProvider)) {
    // Tool Mesh definitions are registered through their richer native policy
    // adapter. Re-registering its xsai wrappers would duplicate the same tools.
    if (provider === 'lumi-tool-mesh')
      continue

    for (const tool of tools) {
      const name = tool.function.name.trim()
      if (!name || registry.get(name))
        continue
      const sideEffectType = classifySideEffect(name)
      registry.register({
        name,
        description: tool.function.description ?? `调用 ${provider} 工具 ${name}。`,
        inputSchema: tool.function.parameters,
        explicitInvocationHints: runtimeToolInvocationHints(provider, name),
        timeoutMs: executionTimeoutMs(provider, tool.function.description),
        provider: `desktop:${provider}`,
        visibility: runtimeToolVisibility(provider, name),
        stage: 'planner',
        chatScope: 'direct',
        riskLevel: sideEffectType === 'read' ? 'low' : 'high',
        executionMode: 'automatic',
        sideEffectType,
        idempotencyPolicy: sideEffectType === 'read' ? 'optional' : 'required',
        requiredScopes: [],
        availability: context =>
          context.conversationId === registration.conversationId
          && context.personId === registration.personId,
        async handler({ invocation, signal }) {
          try {
            const output = await tool.execute(invocation.arguments, {
              abortSignal: signal,
              messages: [],
              toolCallId: invocation.callId,
            })
            if (isErrorOutput(output)) {
              return {
                success: false,
                output,
                errorCode: 'HOST_TOOL_FAILED',
                errorMessage: outputMessage(output) ?? `${name} 执行失败`,
                metadata: { provider },
              }
            }
            return {
              success: true,
              output,
              metadata: { provider },
            }
          }
          catch (error) {
            return {
              success: false,
              errorCode: 'HOST_TOOL_FAILED',
              errorMessage: errorMessageFrom(error) ?? `${name} 执行失败`,
              metadata: { provider },
            }
          }
        },
      })
      registered += 1
    }
  }
  return registered
}

function runtimeToolInvocationHints(provider: string, name: string): readonly string[] | undefined {
  if (provider !== 'mcp' || !/(?:^|_)playwright_browser_navigate$/i.test(name))
    return undefined

  return [
    '打开浏览器',
    '用浏览器',
    '浏览器搜索',
    '用必应搜索',
    '用百度搜索',
    '用谷歌搜索',
    '上网搜索',
    '网页搜索',
  ]
}

function runtimeToolVisibility(provider: string, name: string): 'visible' | 'deferred' {
  if (provider !== 'mcp')
    return 'deferred'

  if (name === 'builtIn_mcpListTools' || name === 'builtIn_mcpCallTool')
    return 'visible'

  return /(?:^|_)playwright_browser_(?:navigate|snapshot|tabs|click|type|fill_form|press_key|wait_for)$/i.test(name)
    ? 'visible'
    : 'deferred'
}

function executionTimeoutMs(provider: string, description?: string): number {
  if (provider === 'mcp') {
    const persistent = description?.includes('configured as long-running')
      || description?.includes('server is persistent')
    return persistent ? 300_000 : 180_000
  }
  if (provider === 'plugin-tools')
    return 120_000
  return 60_000
}

function classifySideEffect(name: string): ToolSideEffectType {
  return /get|list|read|query|search|observe|status|inspect|fetch|snapshot|screenshot/i.test(name)
    ? 'read'
    : 'external'
}

function isErrorOutput(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && 'isError' in value
    && value.isError === true
}

function outputMessage(value: Record<string, unknown>): string | undefined {
  if (typeof value.message === 'string')
    return value.message
  if (!Array.isArray(value.content))
    return undefined
  return value.content
    .flatMap((part) => {
      if (
        typeof part === 'object'
        && part !== null
        && 'text' in part
        && typeof part.text === 'string'
      ) {
        return [part.text]
      }
      return []
    })
    .join('\n') || undefined
}
