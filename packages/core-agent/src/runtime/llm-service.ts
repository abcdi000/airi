import type { ChatProvider } from '@xsai-ext/providers/utils'
import type { Message, Tool } from '@xsai/shared-chat'

import type { StreamFromOptions, StreamOptions } from '../types/llm'

import { errorMessageFrom } from '@moeru/std'
import { stepCountAtLeast } from '@xsai/shared-chat'
import { streamText } from '@xsai/stream-text'

const DEFAULT_MAX_STREAM_STEPS = 64
const MIN_STREAM_STEPS = 1
const MAX_STREAM_STEPS = 200

let lumiStreamDebugSequence = 0

/**
 * Normalize chat messages so they match the wire format the active provider
 * actually accepts, flattening content-part arrays back to plain strings when
 * the provider can't deserialize arrays.
 *
 * Use when:
 * - Composing the final message list right before handing it to the OpenAI-
 *   compatible chat SDK.
 *
 * Expects:
 * - `role: 'error'` entries (AIRI-internal markers from the chat UI). They are
 *   rewritten as user-role narrations so the provider doesn't reject them.
 * - `content` may be a string, a content-part array, or undefined.
 *
 * Returns:
 * - A new array of `Message` values; original objects are not mutated.
 *
 * @param messages - Raw messages from the chat session, may include AIRI's
 *   `error` role.
 * @param supportsContentArray - When `false`, force-flatten every array
 *   content (including text + `image_url` mixes) to a text-only string and
 *   drop non-text parts. Drives the runtime auto-degrade for strict providers.
 *   Defaults to `true` to preserve vision/multimodal payloads on capable
 *   providers.
 */
export function sanitizeMessages(messages: unknown[], supportsContentArray: boolean = true): Message[] {
  return messages.map((message: any) => {
    if (message && message.role === 'error') {
      return {
        role: 'user',
        content: `User encountered error: ${String(message.content ?? '')}`,
      } as Message
    }

    // NOTICE:
    // Flatten array content for providers (e.g. DeepSeek and other Rust/serde-
    // strict OpenAI-compatible gateways) that only accept `messages[].content`
    // as a plain string and reject arrays with `Failed to deserialize the JSON
    // body into the target type: messages[N]: invalid type: sequence, expected
    // a string`.
    // Root cause: OpenAI's chat API permits `content` as either `string` or an
    // array of content parts; some compatible servers only implement the
    // string variant.
    // Source/context: https://github.com/moeru-ai/airi/issues/1500
    // Removal condition: when every supported provider accepts content-part
    // arrays uniformly (no longer realistic for the OpenAI-compatible
    // ecosystem, so this is effectively load-bearing).
    if (message && Array.isArray(message.content)) {
      const contentParts = message.content as { type?: string, text?: string }[]
      const hasNonTextPart = contentParts.some(part => part?.type && part.type !== 'text')
      // When the provider supports arrays, only flatten pure-text arrays so we
      // never silently drop image / audio / file parts on a vision-capable
      // model. When it doesn't, flatten unconditionally; non-text parts are
      // dropped because the provider can't carry them anyway.
      if (!supportsContentArray || !hasNonTextPart) {
        return { ...message, content: contentParts.map(part => part?.text ?? '').join('') } as Message
      }
    }

    return message as Message
  })
}

export function modelKey(model: string, chatProvider: ChatProvider): string {
  return `${chatProvider.chat(model).baseURL}-${model}`
}

export function streamOptionsToolsCompatibilityOk(model: string, chatProvider: ChatProvider, options?: StreamOptions): boolean {
  if (options?.supportsTools !== undefined)
    return options.supportsTools
  const key = modelKey(model, chatProvider)
  return options?.toolsCompatibility?.get(key) !== false
}

/**
 * Resolve whether the active model+provider currently supports content-part
 * arrays. Defaults to `true` so first-time calls keep multimodal payloads;
 * flips to `false` once {@link isContentArrayRelatedError} has fired on this
 * model key and the caller has cached the degrade in
 * {@link StreamOptions.contentArrayCompatibility}.
 */
export function streamOptionsContentArrayCompatibilityOk(model: string, chatProvider: ChatProvider, options?: StreamOptions): boolean {
  if (options?.supportsContentArray !== undefined)
    return options.supportsContentArray
  const key = modelKey(model, chatProvider)
  return options?.contentArrayCompatibility?.get(key) !== false
}

async function resolveTools(options?: StreamOptions) {
  const tools = typeof options?.tools === 'function'
    ? await options.tools()
    : options?.tools
  return tools ?? []
}

function toolNameFrom(tool: Tool): string | undefined {
  const candidate = tool as Tool & { name?: string, function?: { name?: string } }
  return candidate.function?.name ?? candidate.name
}

export function dedupeToolsByName(tools: Tool[]): Tool[] {
  const anonymous: Tool[] = []
  const named = new Map<string, Tool>()

  for (const tool of tools) {
    const name = toolNameFrom(tool)
    if (!name) {
      anonymous.push(tool)
      continue
    }

    // Later entries win so caller-provided runtime tools can override the
    // built-in fallback tools without producing duplicate provider payloads.
    named.set(name, tool)
  }

  return [...anonymous, ...named.values()]
}

function resolveMaxStreamSteps(options?: StreamOptions): number {
  const candidate = Math.round(Number(options?.maxSteps ?? DEFAULT_MAX_STREAM_STEPS))
  if (!Number.isFinite(candidate))
    return DEFAULT_MAX_STREAM_STEPS
  return Math.max(MIN_STREAM_STEPS, Math.min(MAX_STREAM_STEPS, candidate))
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'AbortError'
}

function createCapturedToolErrorResult(toolName: string, error: unknown): string {
  return `Tool call error for "${toolName}": ${errorMessageFrom(error) ?? String(error)}`
}

function withCapturedToolErrors(
  tools: Tool[],
  capturedToolErrorByCallId: Map<string, string>,
): Tool[] {
  return tools.map(tool => ({
    ...tool,
    execute: async (input, executeOptions) => {
      try {
        return await tool.execute(input, executeOptions)
      }
      catch (error) {
        if (isAbortError(error))
          throw error

        const result = createCapturedToolErrorResult(tool.function.name, error)
        capturedToolErrorByCallId.set(executeOptions.toolCallId, result)
        return result
      }
    },
  }))
}

function resolveCapturedToolErrorEvent(
  event: unknown,
  capturedToolErrorByCallId: Map<string, string>,
) {
  if (
    typeof event !== 'object'
    || event === null
    || (event as { type?: unknown }).type !== 'tool-result'
    || typeof (event as { toolCallId?: unknown }).toolCallId !== 'string'
  ) {
    return event
  }

  const toolCallId = (event as { toolCallId: string }).toolCallId
  const result = capturedToolErrorByCallId.get(toolCallId)
  if (result == null)
    return event

  capturedToolErrorByCallId.delete(toolCallId)
  return {
    ...event,
    type: 'tool-error',
    isError: true,
    result,
  }
}

function previewStreamDebugValue(value: unknown, maxLength = 1200): unknown {
  if (typeof value === 'string')
    return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value
  if (Array.isArray(value))
    return value.map(item => previewStreamDebugValue(item, Math.floor(maxLength / Math.max(1, value.length))))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
      out[key] = previewStreamDebugValue(child, maxLength)
    return out
  }
  return value
}

function summarizeLumiStreamEventForDebug(event: unknown) {
  if (!event || typeof event !== 'object')
    return { type: typeof event }

  const record = event as Record<string, unknown>
  const type = record.type
  if (type === 'text-delta' || type === 'reasoning-delta') {
    return {
      type,
      textLength: typeof record.text === 'string' ? record.text.length : undefined,
    }
  }

  if (type === 'tool-call') {
    return {
      type,
      toolCallId: record.toolCallId,
      toolName: record.toolName ?? record.name,
      args: previewStreamDebugValue(record.args ?? record.arguments, 1200),
    }
  }

  if (type === 'tool-result' || type === 'tool-error') {
    return {
      type,
      toolCallId: record.toolCallId,
      isError: record.isError,
      result: previewStreamDebugValue(record.result, 1200),
    }
  }

  if (type === 'finish') {
    return {
      type,
      finishReason: record.finishReason,
      usage: previewStreamDebugValue(record.usage, 500),
    }
  }

  if (type === 'error') {
    return {
      type,
      error: errorMessageFrom(record.error) ?? String(record.error),
    }
  }

  return previewStreamDebugValue(record, 1200)
}

export async function streamFrom({
  model,
  chatProvider,
  messages,
  options,
  builtinToolsResolver,
}: StreamFromOptions) {
  const chatConfig = chatProvider.chat(model)
  const supportsContentArray = streamOptionsContentArrayCompatibilityOk(model, chatProvider, options)
  const sanitized = sanitizeMessages(messages as unknown[], supportsContentArray)

  const supportedTools = streamOptionsToolsCompatibilityOk(model, chatProvider, options)
  const builtinTools = supportedTools
    ? await (builtinToolsResolver?.(model, chatProvider) ?? Promise.resolve([]))
    : []
  const customTools = supportedTools ? await resolveTools(options) : []
  const mergedTools = supportedTools ? dedupeToolsByName([...builtinTools, ...customTools]) : []
  const transformedTools = options?.toolTransform
    ? await options.toolTransform(mergedTools)
    : mergedTools
  const tools = transformedTools.length > 0 ? transformedTools : undefined
  const capturedToolErrorByCallId = new Map<string, string>()
  const streamTools = options?.captureToolErrors && tools != null
    ? withCapturedToolErrors(tools, capturedToolErrorByCallId)
    : tools
  const maxSteps = resolveMaxStreamSteps(options)
  const streamTraceId = `lumi-stream-${Date.now().toString(36)}-${++lumiStreamDebugSequence}`
  let streamEventSequence = 0

  console.info('[LUMI_STREAM_DEBUG]', {
    traceId: streamTraceId,
    phase: 'stream_begin',
    model,
    baseURL: chatConfig.baseURL,
    messageCount: sanitized.length,
    toolCount: streamTools?.length ?? 0,
    waitForTools: options?.waitForTools,
    captureToolErrors: options?.captureToolErrors,
    maxSteps,
  })

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const resolveOnce = () => {
      if (settled)
        return
      settled = true
      resolve()
    }
    const rejectOnce = (error: unknown) => {
      if (settled)
        return
      settled = true
      reject(error)
    }

    const onEvent = async (event: unknown) => {
      try {
        const streamEvent = resolveCapturedToolErrorEvent(event, capturedToolErrorByCallId)
        if (
          streamEvent
          && typeof streamEvent === 'object'
          && ['tool-call', 'tool-result', 'tool-error', 'finish', 'error'].includes(String((streamEvent as { type?: unknown }).type))
        ) {
          console.info('[LUMI_STREAM_DEBUG]', {
            traceId: streamTraceId,
            seq: ++streamEventSequence,
            phase: 'stream_event',
            event: summarizeLumiStreamEventForDebug(streamEvent),
          })
        }
        await options?.onStreamEvent?.(streamEvent as any)
        if (event && (event as any).type === 'finish') {
          const finishReason = (event as any).finishReason
          const waitingForToolRound = finishReason === 'tool_calls' || finishReason === 'tool-calls'
          if (!waitingForToolRound || !options?.waitForTools)
            resolveOnce()
        }
        else if (event && (event as any).type === 'error') {
          rejectOnce((event as any).error ?? new Error('Stream error'))
        }
      }
      catch (error) {
        rejectOnce(error)
      }
    }

    try {
      const streamResult = streamText({
        ...chatConfig,
        abortSignal: options?.abortSignal,
        messages: sanitized,
        headers: options?.headers,
        stopWhen: stepCountAtLeast(maxSteps),
        // NOTICE:
        // Do not pass xsAI's `captureToolErrors` option here. In the installed
        // @xsai/stream-text version, stream options are spread into the provider
        // chat body, so unknown runtime-only fields can be rejected upstream.
        // AIRI captures tool failures by wrapping local tool executors instead.
        tools: streamTools,
        onEvent,
      })

      // NOTICE: Consume underlying promises to prevent unhandled rejections from
      // @xsai/stream-text's SSE parser surfacing as faulted app state.
      // NOTICE:
      // `streamText(...).steps` is the authoritative completion signal for the
      // full streamed interaction, including tool-call rounds.
      // Resolving only from `onEvent({ type: 'finish' })` is incorrect when
      // `options?.waitForTools === true`, because providers can emit
      // `finishReason: 'tool_calls'` or `finishReason: 'tool-calls'` before the
      // tool round has fully settled.
      // That misuse leaves the outer promise pending, which makes provider-backed
      // eval tasks look like they stop mid-run and prevents later scheduled evals
      // from starting.
      // Keep `steps.then(resolveOnce)` so evaluation runners observe the real end
      // of the stream lifecycle instead of an intermediate tool boundary.
      void streamResult.steps.then(async (steps) => {
        if (options?.onUsage) {
          for (const step of steps) {
            if (!step.usage)
              continue
            try {
              await options.onUsage(step.usage)
            }
            catch (error) {
              console.error('Stream usage observer error:', error)
            }
          }
        }
        resolveOnce()
      }).catch((error) => {
        rejectOnce(error)
        console.error('Stream steps error:', error)
      })
      void streamResult.messages.catch(error => console.error('Stream messages error:', error))
      void streamResult.usage.catch(error => console.error('Stream usage error:', error))
      void streamResult.totalUsage.catch(error => console.error('Stream totalUsage error:', error))
    }
    catch (error) {
      rejectOnce(error)
    }
  })
}

// Runtime auto-degrade: patterns that indicate the model/provider does not support tool calling.
const TOOLS_RELATED_ERROR_PATTERNS: RegExp[] = [
  /does not support tools/i, // Ollama
  /no endpoints found that support tool use/i, // OpenRouter
  /invalid schema for function/i, // OpenAI-compatible
  /invalid.?function.?parameters/i, // OpenAI-compatible
  /functions are not supported/i, // Azure AI Foundry
  /unrecognized request argument.+tools/i, // Azure AI Foundry
  /tool use with function calling is unsupported/i, // Google Generative AI
  /tool_use_failed/i, // Groq
  /does not support function.?calling/i, // Anthropic
  /tools?\s+(is|are)\s+not\s+supported/i, // Cloudflare Workers AI
]

export function isToolRelatedError(error: unknown): boolean {
  const message = String(error)
  return TOOLS_RELATED_ERROR_PATTERNS.some(pattern => pattern.test(message))
}

// Runtime auto-degrade: patterns that indicate the provider rejected
// content-part arrays and only accepts a plain string for `messages[].content`.
//
// The first pattern matches the Rust/serde wire-level error format used by
// many strict OpenAI-compatible gateways (e.g. DeepSeek-style servers):
//   "Failed to deserialize the JSON body into the target type:
//    messages[7]: invalid type: sequence, expected a string at line 1 column …"
// The second Rust/serde pattern covers providers that accept content arrays
// but only implement the text part variant, e.g.
//   "messages[35]: unknown variant image_url, expected text ..."
// The final pattern covers Python/Pydantic-style errors like
//   "messages.0.content: Input should be a valid string"
// and other variants that surface the same root cause.
//
// See: https://github.com/moeru-ai/airi/issues/1500
const CONTENT_ARRAY_RELATED_ERROR_PATTERNS: RegExp[] = [
  /messages\[\d+\][^"]*invalid type:\s*sequence,\s*expected\s+a\s+string/i,
  /messages\[\d+\][^"]*unknown variant\s+[`'"]?image_url[`'"]?,\s*expected\s+[`'"]?text[`'"]?/i,
  /messages\.\d+\.content[^"]*(?:expected|should be).*string/i,
]

/**
 * Whether the given error indicates the provider rejected content-part arrays
 * and the caller should auto-degrade to string-only `content` for this model.
 *
 * Use when:
 * - Catching errors thrown by {@link streamFrom} so the chat store can flip
 *   `contentArrayCompatibility` for the failing model key.
 *
 * Expects:
 * - `error` may be an Error instance, a thrown SDK response object, a string,
 *   or anything else; we coerce via `String(error)` and pattern-match.
 *
 * Returns:
 * - `true` when the message matches a known "content array unsupported" wire
 *   format from an OpenAI-compatible gateway, otherwise `false`.
 */
export function isContentArrayRelatedError(error: unknown): boolean {
  const message = String(error)
  return CONTENT_ARRAY_RELATED_ERROR_PATTERNS.some(pattern => pattern.test(message))
}
