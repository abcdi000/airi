import type { ProviderChatRoundInput, ProviderChatRoundResult, StreamUsage, TransportChatProvider } from '@proj-airi/core-agent'
import type { Sub2ApiInputContentPart, Sub2ApiInputItem } from '@proj-airi/lumi-runtime/providers/sub2api'
import type { Message, Tool, ToolChoice } from '@xsai/shared-chat'

import { errorMessageFrom } from '@moeru/std'
import { providerChatTransport } from '@proj-airi/core-agent'
import {
  canFallbackFromSub2ApiResponses,
  deriveAccountApiRoot,
  normalizeAccountApiRoot,
  normalizeModelApiRoot,
  parseSub2ApiModelList,
  resolveProviderEndpoint,
  Sub2ApiProviderError,
  Sub2ApiResponsesClient,
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

export interface Sub2ApiClientAccountStatus {
  fetchedAt: string
  accountTokenConfigured: boolean
  balance?: number
  frozenBalance?: number
  concurrency?: number
  rpmLimit?: number
  effectiveRateMultiplier?: number
  platformQuotas: Array<{
    platform: string
    dailyUsageUsd?: number
    dailyLimitUsd?: number | null
  }>
  errors: string[]
}

export type Sub2ApiClientProvider = TransportChatProvider & {
  diagnostics: () => Sub2ApiClientDiagnostics
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

function responsesTool(tool: Tool) {
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

function createChatFetch(
  reasoningEffort: Sub2ApiClientConfig['reasoningEffort'],
): typeof globalThis.fetch {
  return async (request, init) => {
    if (reasoningEffort === 'auto' || typeof init?.body !== 'string')
      return await globalThis.fetch(request, init)
    const body = JSON.parse(init.body) as Record<string, unknown>
    body.reasoning_effort = reasoningEffort
    return await globalThis.fetch(request, { ...init, body: JSON.stringify(body) })
  }
}

function createSub2ApiClientProvider(config: Sub2ApiClientConfig): Sub2ApiClientProvider {
  const baseURL = normalizeModelApiRoot(config.baseUrl)
  const apiKey = config.apiKey.trim()
  let resolvedProtocol = config.protocol === 'auto' ? undefined : config.protocol
  let fallbackUsed = false
  let diagnostics: Sub2ApiClientDiagnostics = {
    protocol: resolvedProtocol === 'chat-completions' ? 'chat-completions' : 'responses',
    fallbackUsed: false,
  }

  const streamRound = async (input: ProviderChatRoundInput): Promise<ProviderChatRoundResult | undefined> => {
    if (resolvedProtocol === 'chat-completions') {
      diagnostics = { ...diagnostics, protocol: 'chat-completions', fallbackUsed }
      return undefined
    }

    let emittedText = false
    let emittedReasoning = false
    const streamedCalls = new Set<string>()
    try {
      const result = await new Sub2ApiResponsesClient({
        baseURL,
        apiKey,
        model: input.model,
        reasoningEffort: config.reasoningEffort,
      }).request({
        ...toSub2ApiResponsesInput(input.messages, config.multimodalEnabled),
        tools: input.tools?.map(responsesTool),
        toolChoice: responsesToolChoice(input.toolChoice),
        maxOutputTokens: input.maxOutputTokens,
        signal: input.abortSignal,
        onTextDelta(delta) {
          emittedText = true
          input.onEvent?.({ type: 'text-delta', text: delta })
        },
        onReasoningDelta(delta) {
          emittedReasoning = true
          input.onEvent?.({ type: 'reasoning-delta', text: delta })
        },
        onToolCallDelta(delta) {
          if (!streamedCalls.has(delta.callId)) {
            streamedCalls.add(delta.callId)
            input.onEvent?.({
              type: 'tool-call-streaming-start',
              toolCallId: delta.callId,
              toolName: delta.name,
            })
          }
          input.onEvent?.({
            type: 'tool-call-delta',
            toolCallId: delta.callId,
            toolName: delta.name,
            argsTextDelta: delta.argumentsDelta,
          })
        },
      })
      resolvedProtocol = 'responses'
      if (result.text && !emittedText)
        input.onEvent?.({ type: 'text-delta', text: result.text })
      if (result.reasoning && !emittedReasoning)
        input.onEvent?.({ type: 'reasoning-delta', text: result.reasoning })
      diagnostics = {
        protocol: 'responses',
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
        finishReason: result.toolCalls.length ? 'tool_calls' : 'stop',
        model: result.resolvedModel ?? result.requestedModel,
      }
    }
    catch (error) {
      if (config.protocol === 'auto' && input.stepNumber === 0 && canFallbackFromSub2ApiResponses(error)) {
        resolvedProtocol = 'chat-completions'
        fallbackUsed = true
        diagnostics = {
          protocol: 'chat-completions',
          fallbackUsed: true,
          requestedModel: input.model,
        }
        return undefined
      }
      throw error
    }
  }

  return {
    chat: model => ({
      apiKey,
      baseURL,
      model,
      fetch: createChatFetch(config.reasoningEffort),
    }),
    [providerChatTransport]: { streamRound },
    diagnostics: () => ({ ...diagnostics }),
  }
}

async function fetchSub2ApiModels(config: Sub2ApiClientConfig, signal?: AbortSignal) {
  const response = await globalThis.fetch(resolveProviderEndpoint(normalizeModelApiRoot(config.baseUrl), 'models'), {
    headers: {
      accept: 'application/json',
      ...(config.apiKey.trim() ? { authorization: `Bearer ${config.apiKey.trim()}` } : {}),
    },
    signal,
  })
  if (!response.ok) {
    throw new Sub2ApiProviderError(
      response.status === 401 ? 'unauthorized' : 'unknown',
      `Sub2API model list failed (${response.status}): ${await response.text().catch(() => response.statusText)}`,
      { status: response.status, endpoint: '/models' },
    )
  }
  return parseSub2ApiModelList(await response.json())
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

async function accountJson(url: URL, token: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await globalThis.fetch(url, {
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal,
  })
  if (!response.ok) {
    throw new Sub2ApiProviderError(
      response.status === 401 ? 'account_token_expired' : 'account_endpoint_unavailable',
      `Sub2API account request failed (${response.status}): ${await response.text().catch(() => response.statusText)}`,
      { status: response.status, endpoint: url.pathname },
    )
  }
  const payload: unknown = await response.json()
  const root = object(payload)
  if (!root)
    throw new Sub2ApiProviderError('invalid_response', 'Sub2API account endpoint returned invalid JSON')
  return root
}

/** Queries optional Sub2API account data without making it a chat prerequisite. */
export async function fetchSub2ApiClientAccountStatus(
  config: Sub2ApiClientConfig,
  signal?: AbortSignal,
): Promise<Sub2ApiClientAccountStatus> {
  const accountToken = config.accountAccessToken.trim()
  const status: Sub2ApiClientAccountStatus = {
    fetchedAt: new Date().toISOString(),
    accountTokenConfigured: Boolean(accountToken),
    platformQuotas: [],
    errors: [],
  }

  const tasks = [
    accountJson(
      resolveProviderEndpoint(normalizeModelApiRoot(config.baseUrl), 'sub2api/billing'),
      config.apiKey.trim(),
      signal,
    ).then((billing) => {
      status.effectiveRateMultiplier = finiteNumber(billing.effective_rate_multiplier)
    }),
  ]
  if (accountToken) {
    const accountRoot = sub2ApiAccountRoot(config)
    tasks.push(
      accountJson(resolveProviderEndpoint(accountRoot, 'user/profile'), accountToken, signal).then((payload) => {
        const data = object(payload.data)
        status.balance = finiteNumber(data?.balance)
        status.frozenBalance = finiteNumber(data?.frozen_balance)
        status.concurrency = finiteNumber(data?.concurrency)
        status.rpmLimit = finiteNumber(data?.rpm_limit)
      }),
      accountJson(resolveProviderEndpoint(accountRoot, 'user/platform-quotas'), accountToken, signal).then((payload) => {
        const data = object(payload.data)
        status.platformQuotas = Array.isArray(data?.platform_quotas)
          ? data.platform_quotas.flatMap((entry) => {
              const quota = object(entry)
              return typeof quota?.platform === 'string'
                ? [{
                    platform: quota.platform,
                    dailyUsageUsd: finiteNumber(quota.daily_usage_usd),
                    dailyLimitUsd: quota.daily_limit_usd === null
                      ? null
                      : finiteNumber(quota.daily_limit_usd),
                  }]
                : []
            })
          : []
      }),
    )
  }

  const settled = await Promise.allSettled(tasks)
  status.errors = settled.flatMap(result => result.status === 'rejected'
    ? [errorMessageFrom(result.reason) ?? 'Sub2API account request failed']
    : [])
  return status
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
      return (await fetchSub2ApiModels(config, options?.signal)).map(model => ({
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
