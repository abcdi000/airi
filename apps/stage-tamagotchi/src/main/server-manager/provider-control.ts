import type {
  Sub2ApiNormalizedUsage,
  Sub2ApiProtocol,
} from '@proj-airi/lumi-server-runtime'

import { errorMessageFrom } from '@moeru/std'
import {
  deriveAccountApiRoot,
  normalizeAccountApiRoot,
  normalizeModelApiRoot,
  parseSub2ApiModelList,
  parseSub2ApiProviderOptions,
  resolveProviderEndpoint,
  Sub2ApiProtocolRouter,
  Sub2ApiResponsesClient,
} from '@proj-airi/lumi-server-runtime'

export interface ProviderProbeInput {
  baseURL: string
  apiKey?: string
  accountAccessToken?: string
  model?: string
  providerId?: string
  providerOptions?: Record<string, unknown>
  defaultModels?: string[]
  modelList?: 'api' | 'static'
  signal?: AbortSignal
}

export interface ProviderModel {
  id: string
  displayName?: string
  ownedBy?: string
  source?: 'openai-list' | 'codex-manifest' | 'static'
}

export interface ProviderBalance {
  available: boolean
  balances: Array<{
    currency: string
    total: string
    granted: string
    toppedUp: string
  }>
}

export interface ProviderTestResult {
  ok: boolean
  protocol: Exclude<Sub2ApiProtocol, 'auto'>
  endpoint: string
  requestedModel: string
  resolvedModel?: string
  text: string
  firstTokenMs?: number
  durationMs: number
  requestId?: string
  responseId?: string
  usage?: Sub2ApiNormalizedUsage
  fallbackUsed?: boolean
}

export interface ProviderAdvancedTestResult {
  ok: boolean
  kind: 'multi-turn' | 'planner-tool'
  protocol: Exclude<Sub2ApiProtocol, 'auto'>
  durationMs: number
  rounds: number
  text: string
  callId?: string
  fallbackUsed: boolean
}

export interface Sub2ApiPlatformQuota {
  platform: 'anthropic' | 'openai' | 'gemini' | 'antigravity' | 'grok' | string
  dailyLimitUsd?: number | null
  weeklyLimitUsd?: number | null
  monthlyLimitUsd?: number | null
  dailyUsageUsd: number
  weeklyUsageUsd: number
  monthlyUsageUsd: number
  dailyWindowResetsAt?: string | null
  weeklyWindowResetsAt?: string | null
  monthlyWindowResetsAt?: string | null
}

export interface ProviderAccountStatus {
  providerId: 'sub2api'
  fetchedAt: string
  accountTokenConfigured: boolean
  wallet?: {
    balance: number
    frozenBalance?: number
    status?: string
  }
  limits?: {
    concurrency?: number
    rpmLimit?: number
  }
  platformQuotas?: Sub2ApiPlatformQuota[]
  billingRate?: {
    groupRateMultiplier?: number
    userRateMultiplier?: number
    resolvedRateMultiplier?: number
    peakRateEnabled?: boolean
    peakStart?: string
    peakEnd?: string
    peakRateMultiplier?: number
    appliedPeakMultiplier?: number
    effectiveRateMultiplier?: number
    observedAt?: string
    timezone?: string
  }
  partialErrors: Array<{
    source: 'profile' | 'platform-quotas' | 'billing-rate'
    status?: number
    message: string
  }>
}

class ProviderHttpError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ProviderHttpError'
    this.status = status
  }
}

/** Lists models exposed by an existing provider or Sub2API manifest. */
export async function listProviderModels(input: ProviderProbeInput): Promise<ProviderModel[]> {
  if (input.modelList === 'static') {
    return (input.defaultModels ?? []).map(id => ({
      id,
      source: 'static',
    }))
  }
  const response = await providerFetch(input, 'models')
  const payload: unknown = await parseJsonResponse(response, '服务商返回了无法识别的模型列表')
  const root = record(payload)
  if (!root)
    throw new Error('服务商返回了无法识别的模型列表')

  return parseSub2ApiModelList(root)
}

/** Performs a real low-cost text generation against the selected model. */
export async function testProviderConnection(input: ProviderProbeInput): Promise<ProviderTestResult> {
  const startedAt = performance.now()
  const model = input.model?.trim()
  if (!model)
    throw new Error('请先选择一个模型')

  if (input.providerId === 'sub2api')
    return await testSub2ApiConnection(input, model, startedAt)

  const completion = await chatCompletion(input, model, [
    { role: 'user', content: 'Reply with OK.' },
  ], 8)
  return {
    ok: true,
    protocol: 'chat-completions',
    endpoint: '/chat/completions',
    requestedModel: model,
    resolvedModel: completion.model,
    text: completion.text,
    durationMs: Math.round(performance.now() - startedAt),
    usage: completion.usage,
  }
}

/** Verifies provider authentication without spending a chat completion. */
export async function testProviderAccess(input: ProviderProbeInput) {
  const startedAt = performance.now()
  await providerFetch(input, 'models')
  return { ok: true, durationMs: Math.round(performance.now() - startedAt) }
}

/** Queries DeepSeek's provider-specific account balance endpoint. */
export async function getDeepSeekBalance(input: ProviderProbeInput): Promise<ProviderBalance> {
  if (input.providerId !== 'deepseek')
    throw new Error('当前服务商不支持余额查询')
  const response = await providerFetch(input, 'user/balance')
  const payload: unknown = await parseJsonResponse(response, 'DeepSeek 返回了无法识别的余额信息')
  const root = record(payload)
  if (!root)
    throw new Error('DeepSeek 返回了无法识别的余额信息')
  const infos = Array.isArray(root.balance_infos) ? root.balance_infos : []
  return {
    available: root.is_available === true,
    balances: infos.flatMap((item) => {
      const balance = record(item)
      return balance
        ? [{
            currency: text(balance.currency),
            total: text(balance.total_balance),
            granted: text(balance.granted_balance),
            toppedUp: text(balance.topped_up_balance),
          }]
        : []
    }),
  }
}

/** Queries Sub2API wallet, platform quota, and API-key billing independently. */
export async function getSub2ApiAccountStatus(input: ProviderProbeInput): Promise<ProviderAccountStatus> {
  if (input.providerId !== 'sub2api')
    throw new Error('当前服务商不支持 Sub2API 账户查询')

  const accountToken = input.accountAccessToken?.trim()
  const providerOptions = parseSub2ApiProviderOptions(input.providerOptions)
  const modelRoot = normalizeModelApiRoot(input.baseURL)
  const accountRoot = providerOptions.accountApiBaseURL
    ? normalizeAccountApiRoot(providerOptions.accountApiBaseURL)
    : deriveAccountApiRoot(modelRoot)
  const status: ProviderAccountStatus = {
    providerId: 'sub2api',
    fetchedAt: new Date().toISOString(),
    accountTokenConfigured: Boolean(accountToken),
    partialErrors: [],
  }

  const billing = settleAccountRequest('billing-rate', async () => {
    const response = await authenticatedFetch(
      resolveProviderEndpoint(modelRoot, 'sub2api/billing'),
      input.apiKey,
      input.signal,
    )
    return parseBilling(await parseJsonResponse(response, 'Sub2API 返回了无法识别的计费倍率'))
  })
  const profile = accountToken
    ? settleAccountRequest('profile', async () => {
        const response = await authenticatedFetch(
          resolveProviderEndpoint(accountRoot, 'user/profile'),
          accountToken,
          input.signal,
        )
        return parseProfile(await parseJsonResponse(response, 'Sub2API 返回了无法识别的账户信息'))
      })
    : Promise.resolve(undefined)
  const quotas = accountToken
    ? settleAccountRequest('platform-quotas', async () => {
        const response = await authenticatedFetch(
          resolveProviderEndpoint(accountRoot, 'user/platform-quotas'),
          accountToken,
          input.signal,
        )
        return parsePlatformQuotas(await parseJsonResponse(response, 'Sub2API 返回了无法识别的平台配额'))
      })
    : Promise.resolve(undefined)

  const [billingResult, profileResult, quotaResult] = await Promise.all([billing, profile, quotas])
  collectAccountResult(status, billingResult, value => status.billingRate = value)
  collectAccountResult(status, profileResult, (value) => {
    status.wallet = value.wallet
    status.limits = value.limits
  })
  collectAccountResult(status, quotaResult, value => status.platformQuotas = value)
  return status
}

/** Runs a side-effect-free multi-turn or Planner-tool Sub2API diagnostic. */
export async function testSub2ApiAdvanced(
  input: ProviderProbeInput,
  kind: ProviderAdvancedTestResult['kind'],
): Promise<ProviderAdvancedTestResult> {
  if (input.providerId !== 'sub2api')
    throw new Error('高级测试仅适用于 Sub2API')
  const model = input.model?.trim()
  if (!model)
    throw new Error('请先选择一个模型')
  const startedAt = performance.now()
  const options = parseSub2ApiProviderOptions(input.providerOptions)
  const router = new Sub2ApiProtocolRouter(options.protocol)
  const responses = new Sub2ApiResponsesClient({
    baseURL: input.baseURL,
    apiKey: input.apiKey,
    model,
    reasoningEffort: options.reasoningEffort,
  })

  if (kind === 'multi-turn') {
    const system = '这是无副作用的多轮连接测试。严格按用户要求简短回答。'
    const firstUser = '请记住测试代号 LUMI_MULTI_4281，只回复“已记住”。'
    const first = await router.run({
      responses: () => responses.request({
        instructions: system,
        input: [{ type: 'message', role: 'user', content: firstUser }],
        maxOutputTokens: 64,
        signal: input.signal,
      }),
      chatCompletions: () => sub2ApiChatRequest(input, model, [
        { role: 'system', content: system },
        { role: 'user', content: firstUser },
      ], { maxTokens: 64 }),
    })
    const second = await router.run({
      responses: () => responses.request({
        instructions: system,
        input: [
          { type: 'message', role: 'user', content: firstUser },
          { type: 'message', role: 'assistant', content: first.value.text },
          { type: 'message', role: 'user', content: '刚才的测试代号是什么？' },
        ],
        maxOutputTokens: 64,
        signal: input.signal,
      }),
      chatCompletions: () => sub2ApiChatRequest(input, model, [
        { role: 'system', content: system },
        { role: 'user', content: firstUser },
        { role: 'assistant', content: first.value.text },
        { role: 'user', content: '刚才的测试代号是什么？' },
      ], { maxTokens: 64 }),
    })
    if (!second.value.text.includes('LUMI_MULTI_4281'))
      throw new Error('多轮测试失败：第二轮未返回测试代号 LUMI_MULTI_4281')
    return {
      ok: true,
      kind,
      protocol: second.protocol,
      durationMs: Math.round(performance.now() - startedAt),
      rounds: 2,
      text: second.value.text,
      fallbackUsed: first.fallbackUsed || second.fallbackUsed,
    }
  }

  const system = '这是无副作用的 Planner 工具测试。必须先调用 echo_test，再根据工具结果输出最终文本。'
  const user = '请调用 echo_test，参数 value 必须是 LUMI_TOOL_OK。'
  const tool = {
    type: 'function' as const,
    name: 'echo_test',
    description: '返回传入的 value，仅用于连接测试。',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  }
  const first = await router.run({
    responses: () => responses.request({
      instructions: system,
      input: [{ type: 'message', role: 'user', content: user }],
      tools: [tool],
      toolChoice: 'required',
      maxOutputTokens: 128,
      signal: input.signal,
    }),
    chatCompletions: () => sub2ApiChatRequest(input, model, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { tools: [tool], toolChoice: 'required', maxTokens: 128 }),
  })
  const call = first.value.toolCalls[0]
  if (!call || call.name !== 'echo_test')
    throw new Error('Planner 工具测试失败：模型没有生成 echo_test 调用')
  const arguments_ = parseStrictObject(call.arguments)
  if (arguments_.value !== 'LUMI_TOOL_OK')
    throw new Error('Planner 工具测试失败：echo_test 参数不正确')
  const toolOutput = JSON.stringify({ value: 'LUMI_TOOL_OK' })
  const second = await router.run({
    responses: () => responses.request({
      instructions: system,
      input: [
        { type: 'message', role: 'user', content: user },
        { type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments },
        { type: 'function_call_output', call_id: call.id, output: toolOutput },
      ],
      maxOutputTokens: 128,
      signal: input.signal,
    }),
    chatCompletions: () => sub2ApiChatRequest(input, model, [
      { role: 'system', content: system },
      { role: 'user', content: user },
      {
        role: 'assistant',
        content: first.value.text,
        tool_calls: [{
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }],
      },
      { role: 'tool', tool_call_id: call.id, content: toolOutput },
    ], { maxTokens: 128 }),
  })
  if (!second.value.text.trim())
    throw new Error('Planner 工具测试失败：工具结果回传后模型没有生成最终文本')
  return {
    ok: true,
    kind,
    protocol: second.protocol,
    durationMs: Math.round(performance.now() - startedAt),
    rounds: 2,
    text: second.value.text,
    callId: call.id,
    fallbackUsed: first.fallbackUsed || second.fallbackUsed,
  }
}

async function testSub2ApiConnection(
  input: ProviderProbeInput,
  model: string,
  startedAt: number,
): Promise<ProviderTestResult> {
  const options = parseSub2ApiProviderOptions(input.providerOptions)
  const router = new Sub2ApiProtocolRouter(options.protocol)
  let firstTokenMs: number | undefined
  const result = await router.run({
    responses: async () => await new Sub2ApiResponsesClient({
      baseURL: input.baseURL,
      apiKey: input.apiKey,
      model,
      reasoningEffort: options.reasoningEffort,
    }).request({
      instructions: '这是 Lumi Server Manager 的连接测试。只输出指定文本，不要解释。',
      input: [{ type: 'message', role: 'user', content: '只回复 LUMI_SUB2API_OK' }],
      maxOutputTokens: 32,
      signal: input.signal,
      onTextDelta() {
        firstTokenMs ??= Math.round(performance.now() - startedAt)
      },
    }),
    chatCompletions: async () => {
      const completion = await sub2ApiChatRequest(input, model, [
        { role: 'system', content: '这是 Lumi Server Manager 的连接测试。只输出指定文本，不要解释。' },
        { role: 'user', content: '只回复 LUMI_SUB2API_OK' },
      ], { maxTokens: 32 })
      return completion
    },
  })
  const value = result.value
  const text = value.text.trim()
  if (!text)
    throw new Error('Sub2API 已连接，但模型没有生成文本')
  return {
    ok: true,
    protocol: result.protocol,
    endpoint: result.protocol === 'responses' ? '/responses' : '/chat/completions',
    requestedModel: model,
    resolvedModel: value.resolvedModel,
    text,
    firstTokenMs,
    durationMs: Math.round(performance.now() - startedAt),
    requestId: 'requestId' in value ? value.requestId : undefined,
    responseId: 'responseId' in value ? value.responseId : undefined,
    usage: value.usage,
    fallbackUsed: result.fallbackUsed,
  }
}

interface ChatCompletionResult {
  text: string
  model?: string
  usage?: Sub2ApiNormalizedUsage
}

async function sub2ApiChatRequest(
  input: ProviderProbeInput,
  model: string,
  messages: Array<Record<string, unknown>>,
  options: {
    maxTokens: number
    tools?: Array<{ type: 'function', name: string, description?: string, parameters: Readonly<Record<string, unknown>> }>
    toolChoice?: 'auto' | 'required' | 'none'
  },
) {
  const providerOptions = parseSub2ApiProviderOptions(input.providerOptions)
  const response = await providerFetch(input, 'chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: options.maxTokens,
      stream: false,
      ...(options.tools?.length
        ? {
            tools: options.tools.map(tool => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            tool_choice: options.toolChoice ?? 'auto',
          }
        : {}),
      ...(providerOptions.reasoningEffort !== 'auto'
        ? { reasoning_effort: providerOptions.reasoningEffort }
        : {}),
    }),
  })
  const payload = await parseJsonResponse(response, 'Sub2API Chat Completions 返回无效 JSON')
  const root = record(payload)
  const choice = record(Array.isArray(root?.choices) ? root.choices[0] : undefined)
  const message = record(choice?.message)
  if (!root || !message)
    throw new Error('Sub2API Chat Completions 没有返回消息')
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.flatMap((item) => {
        const call = record(item)
        const function_ = record(call?.function)
        const id = text(call?.id)
        const name = text(function_?.name)
        if (!id || !name)
          return []
        return [{ id, name, arguments: text(function_?.arguments) || '{}' }]
      })
    : []
  return {
    text: typeof message.content === 'string' ? message.content : '',
    toolCalls,
    requestedModel: model,
    resolvedModel: typeof root.model === 'string' ? root.model : undefined,
    usage: chatUsage(root.usage),
  }
}

async function chatCompletion(
  input: ProviderProbeInput,
  model: string,
  messages: Array<{ role: 'system' | 'user' | 'assistant', content: string }>,
  maxTokens: number,
): Promise<ChatCompletionResult> {
  const response = await providerFetch(input, 'chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      stream: false,
      ...(input.providerId === 'deepseek'
        ? { thinking: { type: 'disabled' } }
        : {}),
    }),
  })
  const payload: unknown = await parseJsonResponse(response, '服务商已连接，但没有返回有效的对话结果')
  const root = record(payload)
  const choices = Array.isArray(root?.choices) ? root.choices : []
  const choice = record(choices[0])
  const message = record(choice?.message)
  const content = message?.content
  const textValue = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.flatMap((part) => {
          const item = record(part)
          return item?.type === 'text' && typeof item.text === 'string' ? [item.text] : []
        }).join('')
      : ''
  if (!root || !message)
    throw new Error('服务商已连接，但没有返回有效的对话结果')
  return {
    text: textValue,
    model: typeof root.model === 'string' ? root.model : undefined,
    usage: chatUsage(root.usage),
  }
}

function chatUsage(value: unknown): Sub2ApiNormalizedUsage | undefined {
  const usage = record(value)
  const inputTokens = number(usage?.prompt_tokens)
  const cachedInputTokens = number(usage?.prompt_cache_hit_tokens)
  const outputTokens = number(usage?.completion_tokens)
  const totalTokens = number(usage?.total_tokens)
  return [inputTokens, cachedInputTokens, outputTokens, totalTokens].some(value => value !== undefined)
    ? { inputTokens, cachedInputTokens, outputTokens, totalTokens }
    : undefined
}

function parseStrictObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    const object = record(parsed)
    if (!object)
      throw new Error('not an object')
    return object
  }
  catch (error) {
    throw new Error('Planner 工具测试失败：模型返回了无效 JSON 参数', { cause: error })
  }
}

function parseProfile(payload: unknown): {
  wallet: NonNullable<ProviderAccountStatus['wallet']>
  limits?: ProviderAccountStatus['limits']
} {
  const data = envelopeData(payload)
  const balance = number(data.balance)
  if (balance === undefined)
    throw new Error('Sub2API 账户信息缺少 balance')
  const frozenBalance = number(data.frozen_balance)
  const concurrency = number(data.concurrency)
  const rpmLimit = number(data.rpm_limit)
  return {
    wallet: {
      balance,
      ...(frozenBalance !== undefined ? { frozenBalance } : {}),
      ...(typeof data.status === 'string' ? { status: data.status } : {}),
    },
    ...([concurrency, rpmLimit].some(value => value !== undefined)
      ? { limits: { concurrency, rpmLimit } }
      : {}),
  }
}

function parsePlatformQuotas(payload: unknown): Sub2ApiPlatformQuota[] {
  const data = envelopeData(payload)
  if (!Array.isArray(data.platform_quotas))
    throw new Error('Sub2API 平台配额缺少 platform_quotas')
  return data.platform_quotas.flatMap((item) => {
    const quota = record(item)
    const platform = text(quota?.platform)
    const dailyUsageUsd = number(quota?.daily_usage_usd)
    const weeklyUsageUsd = number(quota?.weekly_usage_usd)
    const monthlyUsageUsd = number(quota?.monthly_usage_usd)
    if (!quota || !platform || dailyUsageUsd === undefined || weeklyUsageUsd === undefined || monthlyUsageUsd === undefined)
      return []
    return [{
      platform,
      dailyLimitUsd: nullableNumber(quota.daily_limit_usd),
      weeklyLimitUsd: nullableNumber(quota.weekly_limit_usd),
      monthlyLimitUsd: nullableNumber(quota.monthly_limit_usd),
      dailyUsageUsd,
      weeklyUsageUsd,
      monthlyUsageUsd,
      dailyWindowResetsAt: nullableText(quota.daily_window_resets_at),
      weeklyWindowResetsAt: nullableText(quota.weekly_window_resets_at),
      monthlyWindowResetsAt: nullableText(quota.monthly_window_resets_at),
    }]
  })
}

function parseBilling(payload: unknown): NonNullable<ProviderAccountStatus['billingRate']> {
  const root = record(payload)
  if (!root)
    throw new Error('Sub2API 返回了无法识别的计费倍率')
  return {
    groupRateMultiplier: number(root.group_rate_multiplier),
    userRateMultiplier: number(root.user_rate_multiplier),
    resolvedRateMultiplier: number(root.resolved_rate_multiplier),
    peakRateEnabled: typeof root.peak_rate_enabled === 'boolean' ? root.peak_rate_enabled : undefined,
    peakStart: optionalText(root.peak_start),
    peakEnd: optionalText(root.peak_end),
    peakRateMultiplier: number(root.peak_rate_multiplier),
    appliedPeakMultiplier: number(root.applied_peak_multiplier),
    effectiveRateMultiplier: number(root.effective_rate_multiplier),
    observedAt: optionalText(root.observed_at),
    timezone: optionalText(root.timezone),
  }
}

async function providerFetch(input: ProviderProbeInput, path: string, init: RequestInit = {}): Promise<Response> {
  const root = input.providerId === 'sub2api'
    ? normalizeModelApiRoot(input.baseURL)
    : normalizedBaseURL(input.baseURL).href
  return await authenticatedFetch(
    resolveProviderEndpoint(root, path),
    input.apiKey,
    input.signal,
    init,
    input.providerId,
  )
}

async function authenticatedFetch(
  url: URL,
  token: string | undefined,
  signal?: AbortSignal,
  init: RequestInit = {},
  providerId?: string,
): Promise<Response> {
  const requestSignal = timedSignal(signal, 30_000)
  try {
    const headers = new Headers(init.headers)
    headers.set('accept', 'application/json')
    if (token?.trim())
      headers.set('authorization', `Bearer ${token.trim()}`)
    if (providerId === 'openrouter-ai') {
      headers.set('HTTP-Referer', 'https://github.com/moeru-ai/airi')
      headers.set('X-OpenRouter-Title', 'Lumi')
    }
    if (providerId === 'anthropic')
      headers.set('anthropic-dangerous-direct-browser-access', 'true')
    const response = await fetch(url, {
      ...init,
      headers,
      signal: requestSignal.signal,
    })
    if (!response.ok)
      throw await httpError(response)
    return response
  }
  catch (error) {
    if (requestSignal.timedOut())
      throw new Error('服务商请求超时，请检查地址、网络或代理设置')
    if (requestSignal.aborted())
      throw new Error('服务商请求已取消')
    if (error instanceof ProviderHttpError)
      throw error
    throw new Error(redact(errorMessageFrom(error) ?? '服务商请求失败'))
  }
  finally {
    requestSignal.dispose()
  }
}

function timedSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  let timeoutReached = false
  const abortFromParent = () => controller.abort(parent?.reason)
  if (parent?.aborted)
    abortFromParent()
  else
    parent?.addEventListener('abort', abortFromParent, { once: true })
  const timeout = setTimeout(() => {
    timeoutReached = true
    controller.abort()
  }, timeoutMs)
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    aborted: () => controller.signal.aborted && !timeoutReached,
    dispose() {
      clearTimeout(timeout)
      parent?.removeEventListener('abort', abortFromParent)
    },
  }
}

async function httpError(response: Response): Promise<ProviderHttpError> {
  const detail = await response.text().catch(() => '')
  const suffix = detail ? `: ${redact(detail).slice(0, 300)}` : ''
  return new ProviderHttpError(response.status, `服务商请求失败 (${response.status})${suffix}`)
}

async function parseJsonResponse(response: Response, message: string): Promise<unknown> {
  try {
    return await response.json()
  }
  catch (error) {
    throw new Error(message, { cause: error })
  }
}

type AccountSource = ProviderAccountStatus['partialErrors'][number]['source']
interface AccountResult<T> { source: AccountSource, value?: T, error?: { status?: number, message: string } }

async function settleAccountRequest<T>(source: AccountSource, request: () => Promise<T>): Promise<AccountResult<T>> {
  try {
    return { source, value: await request() }
  }
  catch (error) {
    const status = error instanceof ProviderHttpError ? error.status : undefined
    return {
      source,
      error: {
        status,
        message: status === 401 && source !== 'billing-rate'
          ? '用户令牌已过期或无效 (401)'
          : redact(errorMessageFrom(error) ?? '账户状态查询失败'),
      },
    }
  }
}

function collectAccountResult<T>(
  status: ProviderAccountStatus,
  result: AccountResult<T> | undefined,
  apply: (value: T) => void,
): void {
  if (!result)
    return
  if (result.value !== undefined) {
    apply(result.value)
    return
  }
  if (result.error)
    status.partialErrors.push({ source: result.source, ...result.error })
}

function envelopeData(payload: unknown): Record<string, unknown> {
  const root = record(payload)
  const data = record(root?.data)
  if (!root || !data || (typeof root.code === 'number' && root.code !== 0))
    throw new Error(text(root?.message) || 'Sub2API 账户接口返回失败')
  return data
}

/**
 * Normalizes an OpenAI-compatible API root.
 *
 * Before:
 * - "https://api.deepseek.com"
 *
 * After:
 * - "https://api.deepseek.com/"
 */
function normalizedBaseURL(value: string): URL {
  const url = new URL(value.trim())
  if (!url.pathname.endsWith('/'))
    url.pathname += '/'
  return url
}

function redact(value: string): string {
  return value
    .replace(/authorization\s*[:=]\s*bearer\s+[^\s,;]+/gi, 'Authorization: Bearer [redacted]')
    .replace(/bearer\s+[\w.~+/-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[\w-]{8,}\b/gi, '[redacted-api-key]')
    .replace(/([?&](?:token|key|api_key|access_token)=)[^&\s]+/gi, '$1[redacted]')
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function nullableText(value: unknown): string | null | undefined {
  return value === null ? null : optionalText(value)
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nullableNumber(value: unknown): number | null | undefined {
  return value === null ? null : number(value)
}
