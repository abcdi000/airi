import type {
  LanguageModelMessage,
  LanguageModelPort,
  PlannerMessage,
  PlannerModelPort,
  PlannerToolCall,
  PlannerToolDefinition,
} from '@proj-airi/lumi-agent-runtime'
import type { LumiLanguageModelMessage } from '@proj-airi/lumi-runtime'
import type { Tool } from '@xsai/shared-chat'

import type {
  LumiConsciousnessCurationResult,
  LumiConsciousnessMessage,
  LumiConsciousnessModel,
  LumiConsciousnessRequest,
} from './consciousness'
import type {
  LumiServerToolProvider,
  OpenAICompatibleConsciousnessOptions,
} from './openAICompatibleModel'
import type {
  Sub2ApiFunctionTool,
  Sub2ApiInputItem,
  Sub2ApiNormalizedResult,
  Sub2ApiResponsesRequest,
} from './sub2ApiProtocol'

import { errorMessageFrom } from '@moeru/std'
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

import {
  createOpenAICompatibleAgentModels,
  createOpenAICompatibleConsciousnessModel,
} from './openAICompatibleModel'
import {
  parseSub2ApiProviderOptions,
  Sub2ApiProtocolRouter,
  Sub2ApiProviderError,
  Sub2ApiResponsesClient,
} from './sub2ApiProtocol'

/** Model configuration accepted by the provider-aware Lumi Server factory. */
export interface LumiServerModelOptions extends OpenAICompatibleConsciousnessOptions {
  /** Secret API credential for model endpoints. */
  apiKey?: string
  /** Provider-specific non-secret options. */
  providerOptions?: Record<string, unknown>
}

/** Every model port consumed by legacy, shadow, and maisaka runtimes. */
export interface LumiServerModelBundle {
  /** Tool-capable model used by legacy consciousness and background tasks. */
  consciousnessModel: LumiConsciousnessModel
  /** Single-step Planner and tool-free language model ports. */
  agentModels: {
    plannerModel: PlannerModelPort
    languageModel: LanguageModelPort
  }
}

/**
 * Creates all Lumi Server model ports from one provider configuration.
 *
 * Use when:
 * - Starting legacy, shadow, or maisaka from `lumi-server.json`
 * - Every foreground and background model purpose must share one protocol
 *
 * Expects:
 * - Existing providers continue to use the established OpenAI-compatible factories
 * - Only `providerId: 'sub2api'` enters the native Responses adapter
 *
 * Returns:
 * - One consciousness model plus Planner and tool-free language model ports
 */
export function createLumiServerModelBundle(options: LumiServerModelOptions): LumiServerModelBundle {
  if (options.providerId !== 'sub2api') {
    return {
      consciousnessModel: createOpenAICompatibleConsciousnessModel(options),
      agentModels: createOpenAICompatibleAgentModels(options),
    }
  }

  const providerOptions = parseSub2ApiProviderOptions(options.providerOptions)
  const router = new Sub2ApiProtocolRouter(providerOptions.protocol)
  const responses = new Sub2ApiResponsesClient({
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    model: options.model,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
    reasoningEffort: providerOptions.reasoningEffort,
    fetch: options.fetch,
  })
  const chatOptions = {
    ...options,
    fetch: sub2ApiChatFetch(options.fetch, providerOptions.reasoningEffort),
  }
  const chatConsciousness = createOpenAICompatibleConsciousnessModel(chatOptions)
  const chatAgentModels = createOpenAICompatibleAgentModels(chatOptions)

  return {
    consciousnessModel: createSub2ApiConsciousnessModel({
      options,
      router,
      responses,
      chat: chatConsciousness,
    }),
    agentModels: {
      plannerModel: createSub2ApiPlannerModel(router, responses, chatAgentModels.plannerModel),
      languageModel: createSub2ApiLanguageModel(router, responses, chatAgentModels.languageModel),
    },
  }
}

function sub2ApiChatFetch(
  configuredFetch: typeof globalThis.fetch | undefined,
  reasoningEffort: ReturnType<typeof parseSub2ApiProviderOptions>['reasoningEffort'],
): typeof globalThis.fetch {
  const fetch = configuredFetch ?? globalThis.fetch
  if (reasoningEffort === 'auto')
    return fetch
  return async (input, init) => {
    if (typeof init?.body !== 'string')
      return await fetch(input, init)
    const body = JSON.parse(init.body) as Record<string, unknown>
    body.reasoning_effort = reasoningEffort
    return await fetch(input, { ...init, body: JSON.stringify(body) })
  }
}

interface Sub2ApiConsciousnessDependencies {
  options: LumiServerModelOptions
  router: Sub2ApiProtocolRouter
  responses: Sub2ApiResponsesClient
  chat: LumiConsciousnessModel
}

function createSub2ApiPlannerModel(
  router: Sub2ApiProtocolRouter,
  responses: Sub2ApiResponsesClient,
  chat: PlannerModelPort,
): PlannerModelPort {
  return {
    async generateStep(input) {
      const result = await router.run({
        responses: async () => {
          const response = await responses.request({
            ...toResponsesInput(input.messages),
            tools: input.tools.map(toResponsesPlannerTool),
            toolChoice: input.tools.length > 0 ? input.toolChoice ?? 'required' : 'none',
            signal: input.signal,
          })
          return plannerResult(response)
        },
        chatCompletions: () => chat.generateStep(input),
      })
      return result.value
    },
  }
}

function createSub2ApiLanguageModel(
  router: Sub2ApiProtocolRouter,
  responses: Sub2ApiResponsesClient,
  chat: LanguageModelPort,
): LanguageModelPort {
  return {
    async generate(messages, purpose, signal, options) {
      const result = await router.run({
        responses: async () => (await responses.request({
          ...toResponsesInput(messages),
          maxOutputTokens: options?.maxOutputTokens,
          signal,
        })).text,
        chatCompletions: () => chat.generate(messages, purpose, signal, options),
      })
      return result.value
    },
  }
}

function createSub2ApiConsciousnessModel(dependencies: Sub2ApiConsciousnessDependencies): LumiConsciousnessModel {
  const { chat, options, responses, router } = dependencies
  const maxSteps = boundedInteger(options.maxSteps ?? 8, 1, 64, 'maxSteps')

  const generateLanguage = async (messages: readonly LumiLanguageModelMessage[], purpose: Parameters<LanguageModelPort['generate']>[1]) => {
    const result = await router.run({
      responses: async () => (await responses.request(toResponsesInput(messages))).text,
      chatCompletions: () => chat.generateLanguageText([...messages], purpose),
    })
    return result.value
  }

  return {
    async generate(request, emitDelta) {
      const result = await router.run({
        responses: () => runResponsesToolLoop({
          request,
          responses,
          toolProvider: options.toolProvider,
          maxSteps,
          emitDelta,
        }),
        chatCompletions: () => chat.generate(request, emitDelta),
      })
      return result.value
    },
    generateLanguageText: (messages, purpose) => generateLanguage(messages, purpose),
    curateTurn: async (request, finalReply) => {
      if (router.resolvedProtocol() === 'chat-completions')
        return await chat.curateTurn?.(request, finalReply) ?? { candidateMemories: [] }
      return await curateResponsesTurn({
        request,
        finalReply,
        options,
        generateLanguage,
      })
    },
  }
}

async function runResponsesToolLoop(input: {
  request: LumiConsciousnessRequest
  responses: Sub2ApiResponsesClient
  toolProvider?: LumiServerToolProvider
  maxSteps: number
  emitDelta: (delta: string) => void
}): Promise<{ text: string }> {
  const tools = await input.toolProvider?.toolsFor(input.request) ?? []
  const toolsByName = new Map(tools.map(tool => [tool.function.name, tool]))
  const prompt = toResponsesInput(input.request.messages)
  const history = [...prompt.input]
  const visibleText: string[] = []

  for (let step = 0; step < input.maxSteps; step += 1) {
    let emittedByStream = false
    const response = await input.responses.request({
      instructions: prompt.instructions,
      input: history,
      tools: tools.map(toResponsesTool),
      toolChoice: tools.length > 0 ? 'auto' : 'none',
      onTextDelta(delta) {
        emittedByStream = true
        visibleText.push(delta)
        input.emitDelta(delta)
      },
    })
    if (response.text && !emittedByStream) {
      visibleText.push(response.text)
      input.emitDelta(response.text)
    }
    if (response.toolCalls.length === 0) {
      return { text: visibleText.join('') }
    }

    if (response.text)
      history.push({ type: 'message', role: 'assistant', content: response.text })

    for (const call of response.toolCalls) {
      history.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      })
      const tool = toolsByName.get(call.name)
      if (!tool) {
        throw new Sub2ApiProviderError('unknown_tool', `模型请求了未授权工具：${call.name}`, {
          protocol: 'responses',
          model: response.resolvedModel ?? response.requestedModel,
          responseId: response.responseId,
        })
      }
      const arguments_ = parsePlannerToolArguments(call.arguments)
      if (!arguments_) {
        throw new Sub2ApiProviderError('invalid_tool_arguments', `工具 ${call.name} 返回了无效 JSON 参数`, {
          protocol: 'responses',
          model: response.resolvedModel ?? response.requestedModel,
          responseId: response.responseId,
        })
      }
      history.push({
        type: 'function_call_output',
        call_id: call.id,
        output: await executeTool(tool, arguments_, call.id, input.request.messages),
      })
    }

    if (step === input.maxSteps - 1) {
      throw new Sub2ApiProviderError('tool_execution_failed', `Sub2API 工具循环超过 maxSteps=${input.maxSteps}`, {
        protocol: 'responses',
      })
    }
  }

  throw new Sub2ApiProviderError('tool_execution_failed', 'Sub2API 工具循环异常结束', {
    protocol: 'responses',
  })
}

async function executeTool(
  tool: Tool,
  arguments_: Readonly<Record<string, unknown>>,
  toolCallId: string,
  messages: readonly LumiConsciousnessMessage[],
): Promise<string> {
  try {
    const output = await tool.execute(arguments_, {
      messages: messages.map(message => ({
        role: message.role,
        content: message.content,
      })),
      toolCallId,
    })
    return serializeToolOutput(output)
  }
  catch (error) {
    return JSON.stringify({
      ok: false,
      error: (errorMessageFrom(error) ?? '工具执行失败').slice(0, 800),
    })
  }
}

function toResponsesInput(
  messages: readonly (PlannerMessage | LanguageModelMessage | LumiLanguageModelMessage | LumiConsciousnessMessage)[],
): Pick<Sub2ApiResponsesRequest, 'input' | 'instructions'> {
  const systems: string[] = []
  const input: Sub2ApiInputItem[] = []

  for (const message of messages) {
    if (message.role === 'system') {
      systems.push(message.content)
      continue
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content,
      })
      continue
    }
    if (message.role === 'assistant' && 'toolCalls' in message && message.toolCalls?.length) {
      if (message.content)
        input.push({ type: 'message', role: 'assistant', content: message.content })
      for (const call of message.toolCalls) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        })
      }
      continue
    }
    input.push({ type: 'message', role: message.role, content: message.content })
  }

  return {
    ...(systems.length > 0 ? { instructions: systems.join('\n\n') } : {}),
    input,
  }
}

function toResponsesPlannerTool(tool: PlannerToolDefinition): Sub2ApiFunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }
}

function toResponsesTool(tool: Tool): Sub2ApiFunctionTool {
  return {
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: tool.function.strict,
  }
}

function plannerResult(response: Sub2ApiNormalizedResult): Awaited<ReturnType<PlannerModelPort['generateStep']>> {
  return {
    content: response.text,
    ...(response.reasoning ? { reasoning: response.reasoning } : {}),
    toolCalls: response.toolCalls.map(parsePlannerCall),
    ...(response.usage
      ? {
          usage: {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            cacheHitTokens: response.usage.cachedInputTokens,
            ...(response.usage.inputTokens !== undefined && response.usage.cachedInputTokens !== undefined
              ? { cacheMissTokens: Math.max(0, response.usage.inputTokens - response.usage.cachedInputTokens) }
              : {}),
          },
        }
      : {}),
    modelName: response.resolvedModel ?? response.requestedModel,
  }
}

function parsePlannerCall(call: Sub2ApiNormalizedResult['toolCalls'][number]): PlannerToolCall {
  const arguments_ = parsePlannerToolArguments(call.arguments)
  if (!arguments_) {
    throw new PlannerResponseFormatError(
      `Planner tool call ${call.id} returned invalid JSON arguments`,
    )
  }
  if (!call.name.trim())
    throw new PlannerResponseFormatError(`Planner tool call ${call.id} has no function name`)
  return {
    id: call.id,
    name: call.name,
    arguments: arguments_,
  }
}

async function curateResponsesTurn(input: {
  request: LumiConsciousnessRequest
  finalReply: string
  options: LumiServerModelOptions
  generateLanguage: (
    messages: readonly LumiLanguageModelMessage[],
    purpose: Parameters<LanguageModelPort['generate']>[1],
  ) => Promise<string>
}): Promise<LumiConsciousnessCurationResult> {
  const source = input.request.messages.at(-1)?.content ?? ''
  let result: LumiConsciousnessCurationResult = { candidateMemories: [] }
  if (input.options.curateMemories !== false && source.trim()) {
    try {
      const curatorText = await input.generateLanguage([
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
              assistantResponse: input.finalReply,
              recentMessages: input.request.messages.slice(-16).map(message => ({ role: message.role, content: message.content })),
              actorId: input.request.actorPersonId,
              actorDisplayName: input.request.actorDisplayName,
              conversationId: input.request.conversationId,
              conversationType: input.request.conversationType,
              participantUserIds: input.request.participantPersonIds,
            })),
            current_person_states: Object.fromEntries(input.request.personStates.map(state => [state.kind, state.payload])),
          }, null, 2),
        },
      ], 'feedback')
      result = {
        candidateMemories: deduplicateCandidates(
          parseLumiMemoryCuratorOutput(curatorText, input.request.sourceMessageId),
        ),
        personStateUpdates: parsePersonStateUpdates(
          parseLumiMemoryCuratorDocument(curatorText),
          input.request.conversationType,
        ),
      }
    }
    catch {
      // Model curation is post-reply enrichment; failure leaves memory unchanged.
    }
  }

  if (input.request.conversationType === 'direct' && input.options.directLanguageCandidateLearningEnabled === true) {
    try {
      result.socialLanguageLearningOutput = await input.generateLanguage(
        buildSocialLanguageLearningMessages({
          evidence: {
            messageId: input.request.sourceMessageId ?? input.request.conversationId,
            text: source,
            personId: input.request.actorPersonId,
            conversationId: input.request.conversationId,
            platform: 'lumi-online',
            timestamp: Date.now(),
            source: 'human',
            sourceKind: 'chat',
            authorVerified: true,
          },
          recentContext: input.request.messages
            .filter((message): message is typeof message & { role: 'user' | 'assistant' } =>
              message.role === 'user' || message.role === 'assistant')
            .slice(-8)
            .map(message => ({ role: message.role, content: message.content })),
        }),
        'expression_learning',
      )
    }
    catch {
      // Candidate curation is optional post-reply enrichment.
    }
  }
  return result
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

function serializeToolOutput(output: unknown): string {
  if (typeof output === 'string')
    return output
  try {
    return JSON.stringify(output)
  }
  catch {
    return JSON.stringify({ ok: false, error: '工具结果无法序列化' })
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${field} must be between ${minimum} and ${maximum}`)
  return value
}
