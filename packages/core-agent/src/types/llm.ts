import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { CommonContentPart, CompletionToolCall, CompletionToolResult, Message, Tool, ToolChoice, Usage } from '@xsai/shared-chat'

/** Provider usage returned for one completed model step. */
export interface StreamUsage extends Usage {
  /** DeepSeek input tokens served from context cache. */
  prompt_cache_hit_tokens?: number
  /** DeepSeek input tokens computed without context cache. */
  prompt_cache_miss_tokens?: number
}

export type StreamEvent
  = | { type: 'text-delta', text: string }
    | { type: 'reasoning-delta', text: string }
    | { type: 'tool-call-streaming-start', toolCallId: string, toolName: string }
    | { type: 'tool-call-delta', argsTextDelta: string, toolCallId: string, toolName: string }
    | ({ type: 'finish' } & any)
    | ({ type: 'tool-call' } & CompletionToolCall)
    | (CompletionToolResult & { type: 'tool-error' })
    | { type: 'tool-result', toolCallId: string, result?: string | CommonContentPart[] }
    | { type: 'error', error: any }

export const providerChatTransport = Symbol('provider-chat-transport')

/** One provider-native model step before client-owned tool execution. */
export interface ProviderChatRoundResult {
  text: string
  reasoning?: string
  toolCalls: CompletionToolCall[]
  usage?: StreamUsage
  finishReason: string
  model?: string
}

/** Input supplied to a provider-native transport for one model step. */
export interface ProviderChatRoundInput {
  model: string
  messages: Message[]
  tools?: Tool[]
  toolChoice?: ToolChoice
  maxOutputTokens?: number
  abortSignal?: AbortSignal
  stepNumber: number
  onEvent?: (event: StreamEvent) => void
}

/**
 * Browser-safe provider transport used when an API is not Chat Completions.
 *
 * The transport performs model I/O only. Returning `undefined` delegates the
 * complete turn to the provider's normal `chat()` configuration; core-agent
 * continues to own tool authorization, execution, results, and step limits.
 */
export interface ProviderChatTransport {
  streamRound: (input: ProviderChatRoundInput) => Promise<ProviderChatRoundResult | undefined>
}

export type TransportChatProvider = ChatProvider & {
  [providerChatTransport]: ProviderChatTransport
}

export function getProviderChatTransport(provider: ChatProvider): ProviderChatTransport | undefined {
  return (provider as Partial<TransportChatProvider>)[providerChatTransport]
}

export interface StreamOptions {
  abortSignal?: AbortSignal
  headers?: Record<string, string>
  /** Hard provider output ceiling for this stream. */
  maxOutputTokens?: number
  onStreamEvent?: (event: StreamEvent) => void | Promise<void>
  /** Observes provider-reported usage for every completed model/tool step. */
  onUsage?: (usage: StreamUsage) => void | Promise<void>
  toolsCompatibility?: Map<string, boolean>
  supportsTools?: boolean
  waitForTools?: boolean
  maxSteps?: number
  captureToolErrors?: boolean
  tools?: Tool[] | (() => Promise<Tool[] | undefined>)
  /** Applies a final per-turn policy after builtin and caller tools are merged and deduplicated. */
  toolTransform?: (tools: Tool[]) => Promise<Tool[]> | Tool[]
  /**
   * Per-model runtime cache of whether the provider accepts content-part arrays
   * (e.g. `[{type:'text',...},{type:'image_url',...}]`) for `messages[].content`.
   *
   * Some OpenAI-compatible providers (notably Rust/serde-strict gateways) only
   * deserialize `content` as a plain string and reject arrays with HTTP 400
   * `Failed to deserialize the JSON body into the target type: messages[N]:
   * invalid type: sequence, expected a string`. When a stream surfaces such an
   * error we set the entry to `false` for the model key and force-flatten on
   * the next attempt.
   *
   * Mirrors {@link toolsCompatibility} for the tool-calling capability.
   *
   * See: https://github.com/moeru-ai/airi/issues/1500
   */
  contentArrayCompatibility?: Map<string, boolean>
  supportsContentArray?: boolean
}

export type BuiltinToolsResolver = (model: string, chatProvider: ChatProvider) => Promise<Tool[]>

export interface StreamFromOptions {
  model: string
  chatProvider: ChatProvider
  messages: Message[]
  options?: StreamOptions
  builtinToolsResolver?: BuiltinToolsResolver
}
