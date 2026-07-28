import type {
  AgentToolsPort,
  AgentToolsRegistrationContext,
  ToolRegistry,
  ToolSideEffectType,
} from '@proj-airi/lumi-agent-runtime'
import type { Tool } from '@xsai/shared-chat'

import type { LumiConsciousnessRequest } from './consciousness'
import type { LumiServerToolProvider } from './openAICompatibleModel'

import { errorMessageFrom } from '@moeru/std'

/**
 * Adapts existing server MCP and plugin tools into the shared Tool Registry.
 *
 * Use when:
 * - The server-owned Agent Runtime must reuse the current MCP/plugin registry
 * - Tool discovery and execution remain scoped to one authenticated direct session
 *
 * Expects:
 * - Providers return already-normalized OpenAI-compatible function tools
 *
 * Returns:
 * - Deferred ToolSpecs whose execution remains inside the server process
 */
export function createServerAgentToolsPort(
  provider: LumiServerToolProvider,
): AgentToolsPort {
  return {
    async registerTools(registry, context) {
      const tools = await provider.toolsFor(toolRequest(context))
      const registered = new Set<string>()
      for (const tool of tools) {
        const name = tool.function.name.trim()
        if (!name || registered.has(name) || !tool.execute)
          continue
        registered.add(name)
        registry.register(serverToolSpec(tool, context))
      }
    },
  }
}

function serverToolSpec(
  tool: Tool,
  registration: AgentToolsRegistrationContext,
): Parameters<ToolRegistry['register']>[0] {
  const execute = tool.execute
  if (!execute)
    throw new Error(`Server tool ${tool.function.name} has no executor`)
  return {
    name: tool.function.name,
    description: tool.function.description ?? `Use server tool ${tool.function.name}.`,
    inputSchema: tool.function.parameters ?? {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    timeoutMs: executionTimeoutMs(tool.function.description),
    provider: 'lumi-server',
    visibility: 'deferred',
    stage: 'planner',
    chatScope: 'direct',
    riskLevel: 'high',
    executionMode: 'automatic',
    sideEffectType: classifySideEffect(tool.function.name),
    idempotencyPolicy: 'required',
    requiredScopes: [],
    availability: context =>
      context.conversationId === registration.conversationId
      && context.personId === registration.personId,
    async handler({ invocation, signal }) {
      try {
        const output = await execute(invocation.arguments, {
          abortSignal: signal,
          messages: [],
          toolCallId: invocation.callId,
        })
        if (isErrorOutput(output)) {
          return {
            success: false,
            output,
            errorCode: 'SERVER_TOOL_FAILED',
            errorMessage: outputMessage(output) ?? `${tool.function.name} failed`,
            metadata: { provider: 'lumi-server' },
          }
        }
        return {
          success: true,
          output,
          metadata: { provider: 'lumi-server' },
        }
      }
      catch (error) {
        return {
          success: false,
          errorCode: 'SERVER_TOOL_FAILED',
          errorMessage: errorMessageFrom(error) ?? `${tool.function.name} failed`,
          metadata: { provider: 'lumi-server' },
        }
      }
    },
  }
}

function toolRequest(context: AgentToolsRegistrationContext): LumiConsciousnessRequest {
  return {
    conversationId: context.conversationId,
    conversationType: 'direct',
    actorPersonId: context.personId,
    actorDisplayName: context.personId,
    participantPersonIds: [...context.participantPersonIds],
    messages: [],
    memories: [],
    personStates: [],
  }
}

function classifySideEffect(name: string): ToolSideEffectType {
  return /get|list|read|query|search|observe|status|inspect|fetch|snapshot|screenshot/i.test(name)
    ? 'read'
    : 'external'
}

function executionTimeoutMs(description?: string): number {
  const persistent = description?.includes('configured as long-running')
    || description?.includes('server is persistent')
  return persistent ? 300_000 : 180_000
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
