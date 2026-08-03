import type {
  Sub2ApiChatMessage,
  Sub2ApiFunctionTool,
  Sub2ApiInputItem,
  Sub2ApiModelInfo,
  Sub2ApiNormalizedResult,
  Sub2ApiNormalizedUsage,
  Sub2ApiProtocol,
  Sub2ApiProviderErrorKind,
  Sub2ApiReasoningEffort,
} from './protocol'

import {
  deriveAccountApiRoot,
  normalizeAccountApiRoot,
  normalizeModelApiRoot,
  parseSub2ApiModelList,
  resolveProviderEndpoint,
  Sub2ApiChatCompletionsClient,
  Sub2ApiProtocolRouter,
  Sub2ApiProviderError,
  Sub2ApiResponsesClient,
} from './protocol'

/** Credentials and protocol policy required for one Sub2API model operation. */
export interface Sub2ApiClientTransportConfig {
  modelApiBaseUrl: string
  apiKey: string
  protocol: Sub2ApiProtocol
  reasoningEffort: Sub2ApiReasoningEffort
}

/** Optional account endpoints and credentials, kept separate from model credentials. */
export interface Sub2ApiAccountTransportConfig {
  modelApiBaseUrl: string
  modelApiKey: string
  accountApiBaseUrl?: string
  accountAccessToken?: string
}

/** One provider model round. Tools are executed by the caller after this returns. */
export interface Sub2ApiClientRoundRequest {
  config: Sub2ApiClientTransportConfig
  model: string
  responses: {
    instructions?: string
    input: Sub2ApiInputItem[]
  }
  chatMessages: Sub2ApiChatMessage[]
  tools?: Sub2ApiFunctionTool[]
  toolChoice?: 'auto' | 'required' | 'none'
  maxOutputTokens?: number
}

/** Incremental provider output safe to send over Electron structured clone. */
export type Sub2ApiClientRoundEvent
  = | { type: 'text-delta', text: string }
    | { type: 'reasoning-delta', text: string }
    | { type: 'tool-call-streaming-start', toolCallId: string, toolName: string }
    | { type: 'tool-call-delta', toolCallId: string, toolName: string, argsTextDelta: string }
    | { type: 'usage', usage: Sub2ApiNormalizedUsage }
    | { type: 'diagnostics', protocol: Exclude<Sub2ApiProtocol, 'auto'>, fallbackUsed: boolean, requestId?: string, responseId?: string }

export interface Sub2ApiClientRoundResult {
  protocol: Exclude<Sub2ApiProtocol, 'auto'>
  fallbackUsed: boolean
  value: Sub2ApiNormalizedResult
}

/** Standardized optional account status shown by the offline client. */
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

export interface Sub2ApiSerializedError {
  kind: Sub2ApiProviderErrorKind
  message: string
  status?: number
  requestId?: string
  responseId?: string
  retryAfter?: string
}

/** Network boundary used by Stage Web directly and injected by Electron Renderer. */
export interface Sub2ApiClientTransport {
  listModels: (config: Pick<Sub2ApiClientTransportConfig, 'modelApiBaseUrl' | 'apiKey'>, signal?: AbortSignal) => Promise<Sub2ApiModelInfo[]>
  runRound: (
    request: Sub2ApiClientRoundRequest,
    hooks?: { signal?: AbortSignal, onEvent?: (event: Sub2ApiClientRoundEvent) => void },
  ) => Promise<Sub2ApiClientRoundResult>
  getAccountStatus: (config: Sub2ApiAccountTransportConfig, signal?: AbortSignal) => Promise<Sub2ApiClientAccountStatus>
}

/** Creates the direct HTTP transport used by Stage Web and Electron Main. */
export function createDirectSub2ApiClientTransport(options: {
  fetch?: typeof globalThis.fetch
  browserMode?: boolean
} = {}): Sub2ApiClientTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch

  return {
    async listModels(config, signal) {
      try {
        const response = await fetchImpl(
          resolveProviderEndpoint(normalizeModelApiRoot(config.modelApiBaseUrl), 'models'),
          {
            headers: {
              accept: 'application/json',
              ...(config.apiKey.trim() ? { authorization: `Bearer ${config.apiKey.trim()}` } : {}),
            },
            signal,
          },
        )
        if (!response.ok)
          throw await httpError(response, '/models')
        let payload: unknown
        try {
          payload = await response.json()
        }
        catch (error) {
          throw new Sub2ApiProviderError('invalid_response', 'Sub2API 模型列表返回了无效 JSON', {}, { cause: error })
        }
        return parseSub2ApiModelList(payload)
      }
      catch (error) {
        throw directTransportError(error, options.browserMode, signal)
      }
    },

    async runRound(request, hooks = {}) {
      const streamedCalls = new Set<string>()
      const callbacks = {
        onTextDelta(delta: string) {
          hooks.onEvent?.({ type: 'text-delta', text: delta })
        },
        onReasoningDelta(delta: string) {
          hooks.onEvent?.({ type: 'reasoning-delta', text: delta })
        },
        onToolCallDelta(delta: { callId: string, name: string, argumentsDelta: string }) {
          if (!streamedCalls.has(delta.callId)) {
            streamedCalls.add(delta.callId)
            hooks.onEvent?.({
              type: 'tool-call-streaming-start',
              toolCallId: delta.callId,
              toolName: delta.name,
            })
          }
          hooks.onEvent?.({
            type: 'tool-call-delta',
            toolCallId: delta.callId,
            toolName: delta.name,
            argsTextDelta: delta.argumentsDelta,
          })
        },
      }

      try {
        const router = new Sub2ApiProtocolRouter(request.config.protocol)
        const result = await router.run({
          responses: async () => await new Sub2ApiResponsesClient({
            baseURL: request.config.modelApiBaseUrl,
            apiKey: request.config.apiKey,
            model: request.model,
            reasoningEffort: request.config.reasoningEffort,
            fetch: fetchImpl,
          }).request({
            ...request.responses,
            tools: request.tools,
            toolChoice: request.toolChoice,
            maxOutputTokens: request.maxOutputTokens,
            signal: hooks.signal,
            ...callbacks,
          }),
          chatCompletions: async () => await new Sub2ApiChatCompletionsClient({
            baseURL: request.config.modelApiBaseUrl,
            apiKey: request.config.apiKey,
            model: request.model,
            reasoningEffort: request.config.reasoningEffort,
            fetch: fetchImpl,
          }).request({
            messages: request.chatMessages,
            tools: request.tools,
            toolChoice: request.toolChoice,
            maxOutputTokens: request.maxOutputTokens,
            signal: hooks.signal,
            ...callbacks,
          }),
        })
        if (result.value.usage)
          hooks.onEvent?.({ type: 'usage', usage: result.value.usage })
        hooks.onEvent?.({
          type: 'diagnostics',
          protocol: result.protocol,
          fallbackUsed: result.fallbackUsed,
          requestId: result.value.requestId,
          responseId: result.value.responseId,
        })
        return result
      }
      catch (error) {
        throw directTransportError(error, options.browserMode, hooks.signal)
      }
    },

    async getAccountStatus(config, signal) {
      const accountToken = config.accountAccessToken?.trim() ?? ''
      const status: Sub2ApiClientAccountStatus = {
        fetchedAt: new Date().toISOString(),
        accountTokenConfigured: Boolean(accountToken),
        platformQuotas: [],
        errors: [],
      }
      const tasks = [
        accountJson(
          fetchImpl,
          resolveProviderEndpoint(normalizeModelApiRoot(config.modelApiBaseUrl), 'sub2api/billing'),
          config.modelApiKey.trim(),
          signal,
        ).then((billing) => {
          status.effectiveRateMultiplier = finiteNumber(billing.effective_rate_multiplier)
        }),
      ]
      if (accountToken) {
        const accountRoot = config.accountApiBaseUrl?.trim()
          ? normalizeAccountApiRoot(config.accountApiBaseUrl)
          : deriveAccountApiRoot(config.modelApiBaseUrl)
        tasks.push(
          accountJson(fetchImpl, resolveProviderEndpoint(accountRoot, 'user/profile'), accountToken, signal).then((payload) => {
            const data = object(payload.data)
            status.balance = finiteNumber(data?.balance)
            status.frozenBalance = finiteNumber(data?.frozen_balance)
            status.concurrency = finiteNumber(data?.concurrency)
            status.rpmLimit = finiteNumber(data?.rpm_limit)
          }),
          accountJson(fetchImpl, resolveProviderEndpoint(accountRoot, 'user/platform-quotas'), accountToken, signal).then((payload) => {
            const data = object(payload.data)
            status.platformQuotas = Array.isArray(data?.platform_quotas)
              ? data.platform_quotas.flatMap((entry) => {
                  const quota = object(entry)
                  return typeof quota?.platform === 'string'
                    ? [{
                        platform: quota.platform,
                        dailyUsageUsd: finiteNumber(quota.daily_usage_usd),
                        dailyLimitUsd: quota.daily_limit_usd === null ? null : finiteNumber(quota.daily_limit_usd),
                      }]
                    : []
                })
              : []
          }),
        )
      }
      const settled = await Promise.allSettled(tasks)
      if (signal?.aborted)
        throw new Sub2ApiProviderError('cancelled', 'Sub2API 请求已取消')
      status.errors = settled.flatMap(result => result.status === 'rejected'
        ? [serializeSub2ApiError(result.reason, [config.modelApiKey, accountToken]).message]
        : [])
      return status
    },
  }
}

/** Converts an arbitrary provider failure into a credential-safe cloneable object. */
export function serializeSub2ApiError(
  error: unknown,
  sensitiveValues: readonly string[] = [],
): Sub2ApiSerializedError {
  if (error instanceof Sub2ApiProviderError) {
    return {
      kind: error.kind,
      message: redactText(error.message, sensitiveValues),
      status: error.details.status,
      requestId: error.details.requestId,
      responseId: error.details.responseId,
      retryAfter: error.details.retryAfter,
    }
  }
  const message = error !== null
    && typeof error === 'object'
    && 'message' in error
    && typeof error.message === 'string'
    ? error.message
    : String(error)
  return { kind: 'unknown', message: redactText(message, sensitiveValues) }
}

/** Restores a clone-safe IPC failure as the standard Sub2API provider error. */
export function deserializeSub2ApiError(error: Sub2ApiSerializedError): Sub2ApiProviderError {
  return new Sub2ApiProviderError(error.kind, error.message, {
    status: error.status,
    requestId: error.requestId,
    responseId: error.responseId,
    retryAfter: error.retryAfter,
  })
}

async function accountJson(
  fetchImpl: typeof globalThis.fetch,
  url: URL,
  token: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal,
    })
  }
  catch (error) {
    if (signal?.aborted)
      throw new Sub2ApiProviderError('cancelled', 'Sub2API 请求已取消', {}, { cause: error })
    throw error
  }
  if (!response.ok)
    throw await httpError(response, url.pathname)
  const payload: unknown = await response.json()
  const root = object(payload)
  if (!root)
    throw new Sub2ApiProviderError('invalid_response', 'Sub2API 账户接口返回了无效 JSON')
  return root
}

async function httpError(response: Response, endpoint: string): Promise<Sub2ApiProviderError> {
  const raw = await response.text().catch(() => '')
  const message = raw || response.statusText || `HTTP ${response.status}`
  const kind: Sub2ApiProviderErrorKind = response.status === 401
    ? 'unauthorized'
    : response.status === 403
      ? 'forbidden'
      : response.status === 429
        ? 'rate_limited'
        : response.status === 502 || response.status === 503 || response.status === 504
          ? 'upstream_unavailable'
          : 'unknown'
  return new Sub2ApiProviderError(kind, `${response.status}: ${message}`, {
    status: response.status,
    endpoint,
    retryAfter: response.headers.get('retry-after') ?? undefined,
  })
}

function directTransportError(error: unknown, browserMode = false, signal?: AbortSignal): Sub2ApiProviderError {
  if (error instanceof Sub2ApiProviderError)
    return error
  if (signal?.aborted)
    return new Sub2ApiProviderError('cancelled', 'Sub2API 请求已取消', {}, { cause: error })
  if (browserMode) {
    return new Sub2ApiProviderError(
      'upstream_unavailable',
      '浏览器无法跨域访问该 Sub2API。桌面版可通过 Electron Main 连接；浏览器版需要服务端允许当前 Origin。',
      {},
      { cause: error },
    )
  }
  return new Sub2ApiProviderError('upstream_unavailable', '无法连接 Sub2API', {}, { cause: error })
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function redactText(value: string, sensitiveValues: readonly string[]): string {
  const redacted = sensitiveValues
    .map(secret => secret.trim())
    .filter(secret => secret.length > 0)
    .reduce((message, secret) => message.replaceAll(secret, '[redacted-secret]'), value)
  return redacted
    .replace(/authorization\s*[:=]\s*bearer\s+[^\s,;]+/gi, 'Authorization: Bearer [redacted]')
    .replace(/bearer\s+[\w.~+/-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[\w-]{8,}\b/gi, '[redacted-api-key]')
    .replace(/([?&](?:token|key|api_key|access_token)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 800)
}
