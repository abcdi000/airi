import type { Tool } from '@xsai/shared-chat'

import type {
  LumiConsciousnessModel,
  LumiConsciousnessRequest,
} from './consciousness'

import {
  buildLumiMemoryCuratorPrompt,
  buildLumiMemoryCuratorUserPayload,
  extractLumiMemoryCandidates,
  parseLumiMemoryCuratorDocument,
  parseLumiMemoryCuratorOutput,
} from '@proj-airi/lumi-runtime'
import { streamText } from '@xsai/stream-text'

export interface LumiServerToolProvider {
  /** Resolves server-owned tools for one already-authorized turn. */
  toolsFor: (request: LumiConsciousnessRequest) => Promise<Tool[]>
}

export interface OpenAICompatibleConsciousnessOptions {
  apiKey?: string
  baseURL: string
  model: string
  temperature?: number
  maxOutputTokens?: number
  providerId?: string
  thinkingMode?: 'auto' | 'enabled' | 'disabled'
  reasoningEffort?: 'auto' | 'high' | 'max'
  providerOptions?: Record<string, unknown>
  toolProvider?: LumiServerToolProvider
  /** @default 8 */
  maxSteps?: number
  /** Testable Fetch boundary; defaults to global fetch. */
  fetch?: typeof globalThis.fetch
  /** Runs Lumi's existing JSON memory curator after each successful reply. @default true */
  curateMemories?: boolean
}

/**
 * Creates the OpenAI-compatible model used by standalone Lumi Server.
 *
 * Use when:
 * - Connecting DeepSeek, OpenAI-compatible gateways, or local compatible APIs
 * - Streaming server-generated speech while executing server-owned tools
 *
 * Expects:
 * - The base URL points to the API root, normally ending in `/v1/`
 * - Tool execution is already guarded by server capability and resource policy
 *
 * Returns:
 * - A Node-compatible consciousness model with incremental text delivery
 */
export function createOpenAICompatibleConsciousnessModel(
  options: OpenAICompatibleConsciousnessOptions,
): LumiConsciousnessModel {
  const baseURL = normalizeBaseURL(options.baseURL)
  const model = requiredText(options.model, 'model', 240)
  const maxSteps = boundedInteger(options.maxSteps ?? 8, 1, 64, 'maxSteps')
  if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2))
    throw new Error('temperature must be between 0 and 2')
  if (options.maxOutputTokens !== undefined)
    boundedInteger(options.maxOutputTokens, 1, 1_000_000, 'maxOutputTokens')

  return {
    async generate(request, emitDelta) {
      const tools = await options.toolProvider?.toolsFor(request)
      const response = streamText({
        apiKey: options.apiKey?.trim() || undefined,
        baseURL,
        model,
        messages: request.messages.map(message => ({
          role: message.role,
          content: message.content,
        })),
        temperature: options.temperature,
        maxTokens: options.maxOutputTokens,
        tools: tools?.length ? tools : undefined,
        maxSteps,
        fetch: providerFetch(options),
      })
      const text = await consumeTextResponse(response, emitDelta)
      const source = request.messages.at(-1)?.content ?? ''
      const deterministic = extractLumiMemoryCandidates(source, { sourceMessageId: request.sourceMessageId })
      let curated = deterministic
      if (options.curateMemories !== false && source.trim()) {
        try {
          const curator = streamText({
            apiKey: options.apiKey?.trim() || undefined,
            baseURL,
            model,
            messages: [
              {
                role: 'system',
                content: [
                  buildLumiMemoryCuratorPrompt(),
                  'For a direct conversation, the same JSON object may include state_updates with profile, short-term, emotion, and relationship objects.',
                  'Each state update must be a concise projection grounded in the current actor evidence. Omit a state when there is no reliable change.',
                  'For a group conversation, omit state_updates entirely. Never place another participant direct-chat or private data in these projections.',
                ].join('\n'),
              },
              {
                role: 'user',
                content: JSON.stringify({
                  turn: JSON.parse(buildLumiMemoryCuratorUserPayload({
                    userMessage: source,
                    assistantResponse: text,
                    recentMessages: request.messages.slice(-16).map(message => ({ role: message.role, content: message.content })),
                    actorId: request.actorPersonId,
                    actorDisplayName: request.actorDisplayName,
                    conversationId: request.conversationId,
                    conversationType: request.conversationType,
                    participantUserIds: request.participantPersonIds,
                  })),
                  current_person_states: Object.fromEntries(request.personStates.map(state => [state.kind, state.payload])),
                }, null, 2),
              },
            ],
            temperature: 0,
            maxTokens: 2_000,
            fetch: providerFetch(options),
          })
          const curatorText = await consumeTextResponse(curator)
          curated = deduplicateCandidates([
            ...parseLumiMemoryCuratorOutput(curatorText, request.sourceMessageId),
            ...deterministic,
          ])
          return {
            text,
            candidateMemories: curated,
            personStateUpdates: parsePersonStateUpdates(parseLumiMemoryCuratorDocument(curatorText), request.conversationType),
          }
        }
        catch {
          // Memory curation is post-reply enrichment; deterministic extraction remains available.
        }
      }
      return { text, candidateMemories: curated }
    },
  }
}

function providerFetch(options: OpenAICompatibleConsciousnessOptions) {
  const fetcher = options.fetch ?? globalThis.fetch
  if (!['deepseek', 'openrouter-ai', 'anthropic'].includes(options.providerId ?? ''))
    return fetcher
  return async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (options.providerId === 'openrouter-ai') {
      headers.set('HTTP-Referer', 'https://github.com/moeru-ai/airi')
      headers.set('X-OpenRouter-Title', 'Lumi')
    }
    if (options.providerId === 'anthropic')
      headers.set('anthropic-dangerous-direct-browser-access', 'true')
    if (options.providerId !== 'deepseek' || typeof init?.body !== 'string')
      return await fetcher(input, { ...init, headers })
    const body = JSON.parse(init.body) as Record<string, unknown>
    const thinkingMode = options.thinkingMode ?? 'auto'
    const reasoningEffort = options.reasoningEffort ?? 'auto'
    if (thinkingMode !== 'auto')
      body.thinking = { type: thinkingMode }
    if (reasoningEffort !== 'auto')
      body.reasoning_effort = reasoningEffort
    return await fetcher(input, { ...init, headers, body: JSON.stringify(body) })
  }
}

async function consumeTextResponse(
  response: {
    textStream: AsyncIterable<string>
    steps: Promise<unknown>
    messages: Promise<unknown>
    usage: Promise<unknown>
    totalUsage: Promise<unknown>
  },
  emitDelta: (delta: string) => void = () => {},
) {
  const consumeText = (async () => {
    const chunks: string[] = []
    for await (const delta of response.textStream) {
      chunks.push(delta)
      emitDelta(delta)
    }
    return chunks.join('')
  })()
  // xsAI resolves four delayed result promises from the same stream task.
  // Attach rejection handlers to every promise immediately so an HTTP/stream
  // error cannot terminate the standalone server as an unhandled rejection.
  const [text] = await Promise.all([
    consumeText,
    response.steps,
    response.messages,
    response.usage,
    response.totalUsage,
  ])
  return text
}

function parsePersonStateUpdates(
  document: unknown,
  conversationType: LumiConsciousnessRequest['conversationType'],
) {
  if (conversationType !== 'direct' || !document || typeof document !== 'object' || Array.isArray(document))
    return undefined
  const updates = (document as Record<string, unknown>).state_updates
  if (!updates || typeof updates !== 'object' || Array.isArray(updates))
    return undefined
  const allowed = ['profile', 'short-term', 'emotion', 'relationship'] as const
  return Object.fromEntries(allowed.flatMap((kind) => {
    const value = (updates as Record<string, unknown>)[kind]
    return value && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(value).length <= 50_000
      ? [[kind, value]]
      : []
  }))
}

function deduplicateCandidates<T extends { type: string, content: string }>(candidates: T[]): T[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = `${candidate.type}:${candidate.content.trim().toLowerCase()}`
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

/**
 * Normalizes an OpenAI-compatible API base URL.
 *
 * Before:
 * - "https://api.deepseek.com/v1"
 *
 * After:
 * - "https://api.deepseek.com/v1/"
 */
function normalizeBaseURL(value: string) {
  const normalized = requiredText(value, 'baseURL', 2_048)
  const url = new URL(normalized)
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('baseURL must use HTTP or HTTPS')
  return url.href.endsWith('/') ? url.href : `${url.href}/`
}

function requiredText(value: string, field: string, maxLength: number) {
  const normalized = value.trim()
  if (!normalized)
    throw new Error(`${field} is required`)
  if (normalized.length > maxLength)
    throw new Error(`${field} is too long`)
  return normalized
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${field} must be between ${minimum} and ${maximum}`)
  return value
}
