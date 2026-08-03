import type { ProviderChatRoundInput, ProviderChatRoundResult, StreamUsage, TransportChatProvider } from '@proj-airi/core-agent'
import type {
  Sub2ApiChatContentPart,
  Sub2ApiChatMessage,
  Sub2ApiClientAccountStatus,
  Sub2ApiClientTransport,
  Sub2ApiFunctionTool,
  Sub2ApiInputContentPart,
  Sub2ApiInputItem,
  Sub2ApiProtocol,
} from '@proj-airi/lumi-runtime/providers/sub2api'
import type { Message, Tool, ToolChoice } from '@xsai/shared-chat'

import { providerChatTransport } from '@proj-airi/core-agent'
import {
  createDirectSub2ApiClientTransport,
  deriveAccountApiRoot,
  normalizeAccountApiRoot,
  normalizeModelApiRoot,
} from '@proj-airi/lumi-runtime/providers/sub2api'
import { z } from 'zod'

import { defineProvider } from '../registry'

const sub2ApiConfigSchema = z.object({
  apiKey: z.string().optional().default(''),
  baseUrl: z.string().optional().default('http://127.0.0.1:8080/v1/'),
  preferredModel: z.string().optional().default(''),
  protocol: z.enum(['auto', 'responses', 'chat-completions']).optional().default('auto'),
  reasoningEffort: z.enum(['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']).optional().default('auto'),
  maxToolSteps: z.number().int().min(1).max(200).optional().default(64),
  multimodalEnabled: z.boolean().optional().default(false),
  accountApiBaseUrl: z.string().optional().default(''),
  accountAccessToken: z.string().optional().default(''),
  apiTestPassed: z.boolean().optional().default(false),
})

export type Sub2ApiClientConfig = z.output<typeof sub2ApiConfigSchema>

export interface Sub2ApiClientDiagnostics {
  protocol: 'responses' | 'chat-completions'
  fallbackUsed: boolean
  requestedModel?: string
  resolvedModel?: string
  requestId?: string
  responseId?: string
}

export type { Sub2ApiClientAccountStatus, Sub2ApiClientTransport }

export type Sub2ApiClientProvider = TransportChatProvider & {
  diagnostics: () => Sub2ApiClientDiagnostics
}

const webDirectTransport = createDirectSub2ApiClientTransport({ browserMode: true })
let clientTransport: Sub2ApiClientTransport = webDirectTransport

/** Installs the platform network boundary before Sub2API provider instances are created. */
export function setSub2ApiClientTransport(transport: Sub2ApiClientTransport): void {
  clientTransport = transport
}

/** Returns the current Web-direct or Electron-injected Sub2API transport. */
export function getSub2ApiClientTransport(): Sub2ApiClientTransport {
  return clientTransport
}

/** Returns diagnostics from a Sub2API client provider without exposing credentials. */
export function getSub2ApiClientDiagnostics(provider: unknown): Sub2ApiClientDiagnostics | undefined {
  if (!provider || typeof provider !== 'object' || !('diagnostics' in provider))
    return undefined
  const diagnostics = (provider as { diagnostics?: unknown }).diagnostics
  return typeof diagnostics === 'function'
    ? (diagnostics as () => Sub2ApiClientDiagnostics)()
    : undefined
}

function normalizeReasoningUsage(input: {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  totalTokens?: number
} | undefined): StreamUsage | undefined {
  if (!input)
    return undefined
  return {
    prompt_tokens: input.inputTokens ?? 0,
    completion_tokens: input.outputTokens ?? 0,
    total_tokens: input.totalTokens ?? ((input.inputTokens ?? 0) + (input.outputTokens ?? 0)),
    ...(input.cachedInputTokens !== undefined
      ? {
          prompt_cache_hit_tokens: input.cachedInputTokens,
          prompt_cache_miss_tokens: Math.max(0, (input.inputTokens ?? input.cachedInputTokens) - input.cachedInputTokens),
        }
      : {}),
  }
}

function textContent(content: Message['content']): string {
  if (typeof content === 'string')
    return content
  if (!Array.isArray(content))
    return ''
  return content.flatMap((part) => {
    if (part.type === 'text')
      return [part.text]
    return []
  }).join('')
}

function userContent(content: Message['content'], multimodalEnabled: boolean): string | Sub2ApiInputContentPart[] {
  if (typeof content === 'string')
    return content
  if (!Array.isArray(content))
    return ''

  const parts = content.flatMap((part): Sub2ApiInputContentPart[] => {
    if (part.type === 'text')
      return [{ type: 'input_text', text: part.text }]
    if (part.type === 'image_url' && multimodalEnabled) {
      return [{
        type: 'input_image',
        image_url: part.image_url.url,
        ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
      }]
    }
    return []
  })
  return parts.length ? parts : ''
}

/** Converts local chat history into stateless Responses input without replaying reasoning items. */
export function toSub2ApiResponsesInput(
  messages: readonly Message[],
  multimodalEnabled: boolean,
): { instructions?: string, input: Sub2ApiInputItem[] } {
  const instructions: string[] = []
  const input: Sub2ApiInputItem[] = []

  for (const message of messages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = textContent(message.content)
      if (text)
        instructions.push(text)
      continue
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: textContent(message.content),
      })
      continue
    }
    if (message.role === 'assistant') {
      const content = textContent(message.content)
      if (content)
        input.push({ type: 'message', role: 'assistant', content })
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.function.name ?? '',
          arguments: call.function.arguments ?? '',
        })
      }
      continue
    }
    input.push({
      type: 'message',
      role: 'user',
      content: userContent(message.content, multimodalEnabled),
    })
  }

  return {
    ...(instructions.length ? { instructions: instructions.join('\n\n') } : {}),
    input,
  }
}

function chatUserContent(content: Message['content'], multimodalEnabled: boolean): string | Sub2ApiChatContentPart[] {
  if (typeof content === 'string')
    return content
  if (!Array.isArray(content))
    return ''
  const parts = content.flatMap((part): Sub2ApiChatContentPart[] => {
    if (part.type === 'text')
      return [{ type: 'text', text: part.text }]
    if (part.type === 'image_url' && multimodalEnabled) {
      return [{
        type: 'image_url',
        image_url: {
          url: part.image_url.url,
          ...(part.image_url.detail ? { detail: part.image_url.detail } : {}),
        },
      }]
    }
    return []
  })
  return parts.length ? parts : ''
}

/** Converts sanitized client history into a structured-clone-safe Chat Completions payload. */
export function toSub2ApiChatMessages(
  messages: readonly Message[],
  multimodalEnabled: boolean,
): Sub2ApiChatMessage[] {
  return messages.map((message): Sub2ApiChatMessage => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.tool_call_id,
        content: textContent(message.content),
      }
    }
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: textContent(message.content),
        ...(message.tool_calls?.length
          ? {
              tool_calls: message.tool_calls.map(call => ({
                id: call.id,
                type: 'function' as const,
                function: {
                  name: call.function.name ?? '',
                  arguments: call.function.arguments ?? '',
                },
              })),
            }
          : {}),
      }
    }
    return {
      role: message.role,
      content: message.role === 'user'
        ? chatUserContent(message.content, multimodalEnabled)
        : textContent(message.content),
    }
  })
}

function responsesTool(tool: Tool): Sub2ApiFunctionTool {
  return {
    type: 'function' as const,
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: tool.function.strict,
  }
}

function responsesToolChoice(choice: ToolChoice | undefined): 'auto' | 'required' | 'none' {
  return choice === 'none' || choice === 'required' ? choice : 'auto'
}

function createSub2ApiClientProvider(config: Sub2ApiClientConfig): Sub2ApiClientProvider {
  const baseURL = normalizeModelApiRoot(config.baseUrl)
  const apiKey = config.apiKey.trim()
  const transport = getSub2ApiClientTransport()
  let resolvedProtocol: Sub2ApiProtocol = config.protocol
  let fallbackUsed = false
  let diagnostics: Sub2ApiClientDiagnostics = {
    protocol: config.protocol === 'chat-completions' ? 'chat-completions' : 'responses',
    fallbackUsed: false,
  }

  const streamRound = async (input: ProviderChatRoundInput): Promise<ProviderChatRoundResult> => {
    let emittedText = false
    let emittedReasoning = false
    const round = await transport.runRound({
      config: {
        modelApiBaseUrl: baseURL,
        apiKey,
        protocol: resolvedProtocol,
        reasoningEffort: config.reasoningEffort,
      },
      model: input.model,
      responses: toSub2ApiResponsesInput(input.messages, config.multimodalEnabled),
      chatMessages: toSub2ApiChatMessages(input.messages, config.multimodalEnabled),
      tools: input.tools?.map(responsesTool),
      toolChoice: responsesToolChoice(input.toolChoice),
      maxOutputTokens: input.maxOutputTokens,
    }, {
      signal: input.abortSignal,
      onEvent(event) {
        if (event.type === 'text-delta') {
          emittedText = true
          input.onEvent?.(event)
          return
        }
        if (event.type === 'reasoning-delta') {
          emittedReasoning = true
          input.onEvent?.(event)
          return
        }
        if (event.type === 'tool-call-streaming-start' || event.type === 'tool-call-delta')
          input.onEvent?.(event)
      },
    })
    resolvedProtocol = round.protocol
    fallbackUsed ||= round.fallbackUsed
    const result = round.value
    if (result.text && !emittedText)
      input.onEvent?.({ type: 'text-delta', text: result.text })
    if (result.reasoning && !emittedReasoning)
      input.onEvent?.({ type: 'reasoning-delta', text: result.reasoning })
    diagnostics = {
      protocol: round.protocol,
      fallbackUsed,
      requestedModel: result.requestedModel,
      resolvedModel: result.resolvedModel,
      requestId: result.requestId,
      responseId: result.responseId,
    }
    return {
      text: result.text,
      reasoning: result.reasoning,
      toolCalls: result.toolCalls.map(call => ({
        args: call.arguments,
        toolCallId: call.id,
        toolCallType: 'function',
        toolName: call.name,
      })),
      usage: normalizeReasoningUsage(result.usage),
      finishReason: result.finishReason ?? (result.toolCalls.length ? 'tool_calls' : 'stop'),
      model: result.resolvedModel ?? result.requestedModel,
    }
  }

  return {
    chat: model => ({
      apiKey,
      baseURL,
      model,
    }),
    [providerChatTransport]: { streamRound },
    diagnostics: () => ({ ...diagnostics }),
  }
}

/** Queries optional Sub2API account data without making it a chat prerequisite. */
export async function fetchSub2ApiClientAccountStatus(
  config: Sub2ApiClientConfig,
  signal?: AbortSignal,
): Promise<Sub2ApiClientAccountStatus> {
  return await getSub2ApiClientTransport().getAccountStatus({
    modelApiBaseUrl: config.baseUrl,
    modelApiKey: config.apiKey,
    accountApiBaseUrl: config.accountApiBaseUrl,
    accountAccessToken: config.accountAccessToken,
  }, signal)
}

export const providerSub2Api = defineProvider<Sub2ApiClientConfig>({
  id: 'sub2api',
  order: 5,
  name: 'Sub2API',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.sub2api.title'),
  description: 'Sub2API Responses and Chat Completions for the offline Lumi client.',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.sub2api.description'),
  tasks: ['chat'],
  icon: 'i-solar:server-square-cloud-bold-duotone',
  createProviderConfig: ({ t }) => sub2ApiConfigSchema.extend({
    apiKey: sub2ApiConfigSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      type: 'password',
    }),
    baseUrl: sub2ApiConfigSchema.shape.baseUrl.meta({
      labelLocalized: '模型 API Base URL',
      placeholderLocalized: 'http://127.0.0.1:8080/v1/',
    }),
  }),
  createProvider: createSub2ApiClientProvider,
  extraMethods: {
    async listModels(config, _provider, options) {
      return (await getSub2ApiClientTransport().listModels({
        modelApiBaseUrl: config.baseUrl,
        apiKey: config.apiKey,
      }, options?.signal)).map(model => ({
        id: model.id,
        name: model.displayName ?? model.id,
        provider: 'sub2api',
        description: model.ownedBy ? `owned by ${model.ownedBy}` : undefined,
      }))
    },
  },
  validationRequiredWhen: config => Boolean(config.baseUrl.trim()),
})

/** Resolves the optional account API root without mixing model and account credentials. */
export function sub2ApiAccountRoot(config: Sub2ApiClientConfig): string {
  return config.accountApiBaseUrl.trim()
    ? normalizeAccountApiRoot(config.accountApiBaseUrl)
    : deriveAccountApiRoot(config.baseUrl)
}
