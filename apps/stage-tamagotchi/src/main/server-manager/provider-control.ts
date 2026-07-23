import { errorMessageFrom } from '@moeru/std'

export interface ProviderProbeInput {
  baseURL: string
  apiKey?: string
  model?: string
  providerId?: string
  defaultModels?: string[]
  modelList?: 'api' | 'static'
}

export interface ProviderModel {
  id: string
  ownedBy?: string
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

/** Lists models exposed by an OpenAI-compatible provider. */
export async function listProviderModels(input: ProviderProbeInput): Promise<ProviderModel[]> {
  if (input.modelList === 'static')
    return (input.defaultModels ?? []).map(id => ({ id }))
  const response = await providerFetch(input, 'models')
  const payload: unknown = await response.json()
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as Record<string, unknown>).data))
    throw new Error('服务商返回了无法识别的模型列表')

  return (payload as { data: unknown[] }).data.flatMap((item) => {
    if (!item || typeof item !== 'object')
      return []
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || !record.id.trim())
      return []
    return [{ id: record.id, ownedBy: typeof record.owned_by === 'string' ? record.owned_by : undefined }]
  })
}

/** Performs a minimal non-streaming chat request against the selected model. */
export async function testProviderConnection(input: ProviderProbeInput) {
  const startedAt = performance.now()
  const model = input.model?.trim()
  if (!model)
    throw new Error('请先选择一个模型')

  const response = await providerFetch(input, 'chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 8,
      stream: false,
      ...(input.providerId === 'deepseek'
        ? { thinking: { type: 'disabled' } }
        : {}),
    }),
  })
  const payload: unknown = await response.json()
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const choices = Array.isArray(record.choices) ? record.choices : []
  if (choices.length === 0)
    throw new Error('服务商已连接，但没有返回有效的对话结果')
  return {
    ok: true,
    durationMs: Math.round(performance.now() - startedAt),
    model,
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
  const payload: unknown = await response.json()
  if (!payload || typeof payload !== 'object')
    throw new Error('DeepSeek 返回了无法识别的余额信息')
  const record = payload as Record<string, unknown>
  const infos = Array.isArray(record.balance_infos) ? record.balance_infos : []
  return {
    available: record.is_available === true,
    balances: infos.flatMap((item) => {
      if (!item || typeof item !== 'object')
        return []
      const balance = item as Record<string, unknown>
      return [{
        currency: text(balance.currency),
        total: text(balance.total_balance),
        granted: text(balance.granted_balance),
        toppedUp: text(balance.topped_up_balance),
      }]
    }),
  }
}

async function providerFetch(input: ProviderProbeInput, path: string, init: RequestInit = {}) {
  const baseURL = normalizedBaseURL(input.baseURL)
  const apiKey = input.apiKey?.trim()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(new URL(path, baseURL), {
      ...init,
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(input.providerId === 'openrouter-ai'
          ? { 'HTTP-Referer': 'https://github.com/moeru-ai/airi', 'X-OpenRouter-Title': 'Lumi' }
          : {}),
        ...(input.providerId === 'anthropic'
          ? { 'anthropic-dangerous-direct-browser-access': 'true' }
          : {}),
        ...init.headers,
      },
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`服务商请求失败 (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`)
    }
    return response
  }
  catch (error) {
    if (controller.signal.aborted)
      throw new Error('服务商请求超时，请检查地址、网络或代理设置')
    throw new Error(errorMessageFrom(error) ?? '服务商请求失败')
  }
  finally {
    clearTimeout(timeout)
  }
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
function normalizedBaseURL(value: string) {
  const url = new URL(value.trim())
  if (!url.pathname.endsWith('/'))
    url.pathname += '/'
  return url
}

function text(value: unknown) {
  return typeof value === 'string' ? value : ''
}
