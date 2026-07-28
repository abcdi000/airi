import type {
  LanguageModelPort,
  PlannerMessage,
  PlannerModelPort,
  PlannerToolCall,
  PlannerToolDefinition,
} from '@proj-airi/lumi-agent-runtime'
import type { GenerateTextResponse } from '@xsai/generate-text'
import type { AssistantMessage, Message, Tool } from '@xsai/shared-chat'

import type {
  LumiConsciousnessCurationResult,
  LumiConsciousnessModel,
  LumiConsciousnessRequest,
} from './consciousness'

import {
  parsePlannerToolArguments,
  PlannerResponseFormatError,
} from '@proj-airi/lumi-agent-runtime'
import {
  buildLumiMemoryCuratorPrompt,
  buildLumiMemoryCuratorUserPayload,
  buildSocialLanguageLearningMessages,
  parseLumiMemoryCuratorDocument,
  parseLumiMemoryCuratorOutput,
} from '@proj-airi/lumi-runtime'
import { generateText } from '@xsai/generate-text'
import { chat } from '@xsai/shared-chat'
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
  /**
   * Allows private turns to request new social-language candidates.
   *
   * Group candidate learning uses the separate observation runtime.
   * @default false
   */
  directLanguageCandidateLearningEnabled?: boolean
}

/** Configuration for the host-managed Lumi Agent Runtime model adapters. */
export type OpenAICompatibleAgentModelOptions = Omit<
  OpenAICompatibleConsciousnessOptions,
  | 'curateMemories'
  | 'directLanguageCandidateLearningEnabled'
  | 'maxSteps'
  | 'toolProvider'
>

/** Model ports consumed by the shared host-managed Lumi Agent Runtime. */
export interface OpenAICompatibleAgentModels {
  /** Exactly one Planner request. The adapter never executes returned tools. */
  plannerModel: PlannerModelPort
  /** Tool-free requests used by Replyer, learning, and context compaction. */
  languageModel: LanguageModelPort
}

interface OpenAICompatiblePlannerResponse extends GenerateTextResponse {
  usage: GenerateTextResponse['usage'] & {
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }
}

/**
 * Creates single-step model ports for the host-managed Lumi Agent Runtime.
 *
 * Use when:
 * - Lumi Agent Runtime, rather than xsAI, owns tool execution and continuation
 * - Planner tool calls must be audited before any side effect
 *
 * Expects:
 * - Planner messages and tools have already passed runtime authorization
 *
 * Returns:
 * - A one-request Planner adapter and a tool-free language adapter
 */
export function createOpenAICompatibleAgentModels(
  options: OpenAICompatibleAgentModelOptions,
): OpenAICompatibleAgentModels {
  const baseURL = normalizeBaseURL(options.baseURL)
  const model = requiredText(options.model, 'model', 240)
  validateSamplingOptions(options)
  const fetch = providerFetch(options)

  return {
    plannerModel: {
      async generateStep(input) {
        // NOTICE:
        // `generateText()` executes every returned tool before evaluating its
        // stop condition in xsAI 0.5.0-beta.2. Lumi must authorize and execute
        // tools itself, so this boundary deliberately uses xsAI's public raw
        // `chat()` call and parses exactly one response.
        // Source/context: `@xsai/generate-text/dist/index.js`, tool execution
        // before `shouldStop(...)`.
        // Removal condition: xsAI exposes a first-class no-execute single-step
        // API that returns parsed tool calls.
        const response = await chat({
          abortSignal: input.signal,
          apiKey: options.apiKey?.trim() || undefined,
          baseURL,
          model,
          messages: input.messages.map(message => toXsaiMessage(
            message,
            options.providerId === 'deepseek' && options.thinkingMode !== 'disabled',
          )),
          temperature: options.temperature,
          maxTokens: options.maxOutputTokens,
          tools: input.tools.length > 0
            ? input.tools.map(toXsaiTool)
            : undefined,
          toolChoice: input.tools.length > 0
            ? (input.toolChoice ?? 'required')
            : undefined,
          fetch,
        })
        const document = await response.json() as OpenAICompatiblePlannerResponse
        const choice = document.choices?.[0]
        if (!choice?.message)
          throw new Error('Planner model returned no message choice')
        return {
          content: assistantText(choice.message),
          reasoning: choice.message.reasoning ?? choice.message.reasoning_content,
          toolCalls: parsePlannerToolCalls(choice.message),
          usage: {
            inputTokens: document.usage?.prompt_tokens,
            outputTokens: document.usage?.completion_tokens,
            cacheHitTokens: document.usage?.prompt_cache_hit_tokens,
            cacheMissTokens: document.usage?.prompt_cache_miss_tokens,
          },
          modelName: document.model || model,
        }
      },
    },
    languageModel: {
      async generate(messages, _purpose, signal, requestOptions) {
        const result = await generateText({
          abortSignal: signal,
          apiKey: options.apiKey?.trim() || undefined,
          baseURL,
          model,
          messages: messages.map(message => ({
            role: message.role,
            content: message.content,
          })),
          temperature: options.temperature,
          maxTokens: boundedOutputTokens(options.maxOutputTokens, requestOptions?.maxOutputTokens),
          fetch,
        })
        return result.text ?? ''
      },
    },
  }
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
  validateSamplingOptions(options)

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
      return { text }
    },
    async generateLanguageText(messages) {
      const response = streamText({
        apiKey: options.apiKey?.trim() || undefined,
        baseURL,
        model,
        messages: messages.map(message => ({
          role: message.role,
          content: message.content,
        })),
        temperature: options.temperature,
        maxTokens: options.maxOutputTokens,
        maxSteps: 1,
        fetch: providerFetch(options),
      })
      return await consumeTextResponse(response)
    },
    async curateTurn(request, text): Promise<LumiConsciousnessCurationResult> {
      const source = request.messages.at(-1)?.content ?? ''
      let result: LumiConsciousnessCurationResult = { candidateMemories: [] }
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
          result = {
            candidateMemories: deduplicateCandidates(
              parseLumiMemoryCuratorOutput(curatorText, request.sourceMessageId),
            ),
            personStateUpdates: parsePersonStateUpdates(parseLumiMemoryCuratorDocument(curatorText), request.conversationType),
          }
        }
        catch {
          // Model curation is post-reply enrichment; failure leaves memory unchanged.
        }
      }
      if (request.conversationType === 'direct' && options.directLanguageCandidateLearningEnabled === true) {
        try {
          const learning = streamText({
            apiKey: options.apiKey?.trim() || undefined,
            baseURL,
            model,
            messages: buildSocialLanguageLearningMessages({
              evidence: {
                messageId: request.sourceMessageId ?? request.conversationId,
                text: source,
                personId: request.actorPersonId,
                conversationId: request.conversationId,
                platform: 'lumi-online',
                timestamp: Date.now(),
                source: 'human',
                sourceKind: 'chat',
                authorVerified: true,
              },
              recentContext: request.messages
                .filter((message): message is typeof message & { role: 'user' | 'assistant' } =>
                  message.role === 'user' || message.role === 'assistant')
                .slice(-8)
                .map(message => ({ role: message.role, content: message.content })),
            }),
            temperature: 0,
            maxTokens: 1_500,
            maxSteps: 1,
            fetch: providerFetch(options),
          })
          result.socialLanguageLearningOutput = await consumeTextResponse(learning)
        }
        catch {
          // Candidate curation is optional post-reply enrichment.
        }
      }
      return result
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
    // NOTICE:
    // DeepSeek V4 thinking supports tools but rejects `tool_choice`. Keep the
    // tools themselves and let V4 select them; an explicitly disabled thinking
    // mode retains the provider-neutral Planner requirement.
    // Source/context: `https://api-docs.deepseek.com/zh-cn/guides/thinking_mode`
    // and `https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/oh_my_pi`.
    // Removal condition: DeepSeek documents and accepts `tool_choice` in V4
    // thinking requests.
    if (thinkingMode !== 'disabled')
      delete body.tool_choice
    if (thinkingMode !== 'auto')
      body.thinking = { type: thinkingMode }
    if (reasoningEffort !== 'auto')
      body.reasoning_effort = reasoningEffort
    if (body.stream === true) {
      body.stream_options = {
        ...(body.stream_options && typeof body.stream_options === 'object' && !Array.isArray(body.stream_options)
          ? body.stream_options as Record<string, unknown>
          : {}),
        // DeepSeek V4 reports exact prompt cache hit/miss accounting only in
        // the final streamed usage chunk when this option is enabled.
        include_usage: true,
      }
    }
    return await fetcher(input, { ...init, headers, body: JSON.stringify(body) })
  }
}

function toXsaiMessage(
  message: PlannerMessage,
  deepSeekThinkingProtocol = false,
): Message {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.toolCallId,
    }
  }
  if (message.role !== 'assistant') {
    return {
      role: message.role,
      content: message.content,
    }
  }
  const toolCalls = message.toolCalls?.map(call => ({
    id: call.id,
    type: 'function' as const,
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    },
  }))
  const reasoning = message.reasoning
    ? deepSeekThinkingProtocol && toolCalls?.length
      ? { reasoning_content: message.reasoning }
      : { reasoning: message.reasoning }
    : {}
  return {
    role: 'assistant',
    content: message.content,
    ...reasoning,
    ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
  }
}

function boundedOutputTokens(
  configured: number | undefined,
  requested: number | undefined,
): number | undefined {
  if (configured === undefined)
    return requested
  if (requested === undefined)
    return configured
  return Math.min(configured, requested)
}

function toXsaiTool(definition: PlannerToolDefinition): Tool {
  return {
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description,
      parameters: { ...definition.inputSchema },
    },
    execute: () => {
      throw new Error('Planner tools must be executed by Lumi Agent Runtime')
    },
  }
}

function assistantText(message: AssistantMessage): string {
  if (typeof message.content === 'string')
    return message.content
  return message.content
    ?.flatMap(part => part.type === 'text' ? [part.text] : [])
    .join('\n') ?? ''
}

function parsePlannerToolCalls(message: AssistantMessage): PlannerToolCall[] {
  return (message.tool_calls ?? []).map((call) => {
    const name = call.function.name?.trim()
    if (!name)
      throw new Error(`Planner tool call ${call.id} has no function name`)
    const rawArguments = call.function.arguments?.trim() || '{}'
    const parsed = parsePlannerToolArguments(rawArguments)
    if (!parsed) {
      throw new PlannerResponseFormatError(
        `Planner tool call ${call.id} returned invalid JSON arguments`,
      )
    }
    return {
      id: call.id,
      name,
      arguments: parsed,
    }
  })
}

function validateSamplingOptions(options: Pick<
  OpenAICompatibleConsciousnessOptions,
  'maxOutputTokens' | 'temperature'
>): void {
  if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2))
    throw new Error('temperature must be between 0 and 2')
  if (options.maxOutputTokens !== undefined)
    boundedInteger(options.maxOutputTokens, 1, 1_000_000, 'maxOutputTokens')
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
