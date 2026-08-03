export type Sub2ApiProtocol = 'auto' | 'responses' | 'chat-completions'

export type Sub2ApiReasoningEffort
  = | 'auto'
    | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'

/** Non-secret Sub2API settings persisted in `model.providerOptions`. */
export interface Sub2ApiProviderOptions {
  /** Protocol used by every model port in one Server process. @default 'auto' */
  protocol: Sub2ApiProtocol
  /** Optional account API root used only by Server Manager account queries. */
  accountApiBaseURL?: string
  /** Responses/Chat Completions reasoning effort. @default 'auto' */
  reasoningEffort: Sub2ApiReasoningEffort
}

export type Sub2ApiProviderErrorKind
  = | 'invalid_base_url'
    | 'unauthorized'
    | 'forbidden'
    | 'model_not_found'
    | 'endpoint_not_supported'
    | 'rate_limited'
    | 'quota_exhausted'
    | 'upstream_unavailable'
    | 'timeout'
    | 'cancelled'
    | 'stream_interrupted'
    | 'invalid_response'
    | 'invalid_sse'
    | 'invalid_tool_arguments'
    | 'unknown_tool'
    | 'tool_execution_failed'
    | 'account_token_required'
    | 'account_token_expired'
    | 'account_endpoint_unavailable'
    | 'unknown'

/** Safe provider error metadata that never stores credentials or request prompts. */
export interface Sub2ApiProviderErrorDetails {
  status?: number
  code?: string
  requestId?: string
  responseId?: string
  retryAfter?: string
  protocol?: Exclude<Sub2ApiProtocol, 'auto'>
  model?: string
  endpoint?: string
  fallbackUsed?: boolean
  partialOutput?: boolean
}

/** A classified, redacted Sub2API failure suitable for logs and manager UI. */
export class Sub2ApiProviderError extends Error {
  readonly kind: Sub2ApiProviderErrorKind
  readonly details: Sub2ApiProviderErrorDetails

  constructor(
    kind: Sub2ApiProviderErrorKind,
    message: string,
    details: Sub2ApiProviderErrorDetails = {},
    options?: ErrorOptions,
  ) {
    super(redactProviderText(message), options)
    this.name = 'Sub2ApiProviderError'
    this.kind = kind
    this.details = details
  }
}

export interface Sub2ApiFunctionTool {
  type: 'function'
  name: string
  description?: string
  parameters: Readonly<Record<string, unknown>>
  strict?: boolean
}

export interface Sub2ApiNormalizedToolCall {
  id: string
  name: string
  arguments: string
}

export interface Sub2ApiNormalizedUsage {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface Sub2ApiNormalizedResult {
  text: string
  reasoning?: string
  toolCalls: Sub2ApiNormalizedToolCall[]
  usage?: Sub2ApiNormalizedUsage
  requestedModel: string
  resolvedModel?: string
  responseId?: string
  requestId?: string
}

export type Sub2ApiInputItem
  = | {
    type: 'message'
    role: 'user' | 'assistant'
    content: string
  }
  | {
    type: 'function_call'
    call_id: string
    name: string
    arguments: string
  }
  | {
    type: 'function_call_output'
    call_id: string
    output: string
  }

export interface Sub2ApiResponsesRequest {
  instructions?: string
  input: readonly Sub2ApiInputItem[]
  tools?: readonly Sub2ApiFunctionTool[]
  toolChoice?: 'auto' | 'required' | 'none'
  maxOutputTokens?: number
  signal?: AbortSignal
  onTextDelta?: (delta: string) => void
}

export interface Sub2ApiResponsesClientOptions {
  baseURL: string
  apiKey?: string
  model: string
  temperature?: number
  maxOutputTokens?: number
  reasoningEffort?: Sub2ApiReasoningEffort
  /** @default 300000 */
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

export interface Sub2ApiProtocolRunResult<T> {
  value: T
  protocol: Exclude<Sub2ApiProtocol, 'auto'>
  fallbackUsed: boolean
}

/**
 * Normalizes a model API root and appends `/v1/` only when it is absent.
 *
 * Before:
 * - `"https://example.com"`
 * - `"https://example.com/custom-prefix/v1"`
 *
 * After:
 * - `"https://example.com/v1/"`
 * - `"https://example.com/custom-prefix/v1/"`
 */
export function normalizeModelApiRoot(value: string): string {
  const url = parseHttpUrl(value, '模型 API Base URL')
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.at(-1)?.toLowerCase() !== 'v1')
    segments.push('v1')
  url.pathname = `/${segments.join('/')}/`
  return url.href
}

/**
 * Derives Sub2API's account API root from the model API origin.
 *
 * Before:
 * - `"https://example.com/custom-prefix/v1/"`
 *
 * After:
 * - `"https://example.com/api/v1/"`
 */
export function deriveAccountApiRoot(modelApiRoot: string): string {
  const modelURL = new URL(normalizeModelApiRoot(modelApiRoot))
  modelURL.pathname = '/api/v1/'
  return modelURL.href
}

/**
 * Normalizes an explicitly configured account API root.
 *
 * Before:
 * - `"https://example.com/api/v1"`
 *
 * After:
 * - `"https://example.com/api/v1/"`
 */
export function normalizeAccountApiRoot(value: string): string {
  const url = parseHttpUrl(value, '账户 API Base URL')
  if (!url.pathname.endsWith('/'))
    url.pathname += '/'
  return url.href
}

/** Resolves one relative endpoint without duplicating the API version path. */
export function resolveProviderEndpoint(root: string, endpoint: string): URL {
  const path = endpoint.replace(/^\/+/, '')
  return new URL(path, root.endsWith('/') ? root : `${root}/`)
}

/** Reads and validates the non-secret Sub2API provider options. */
export function parseSub2ApiProviderOptions(value: Readonly<Record<string, unknown>> | undefined): Sub2ApiProviderOptions {
  const protocol = value?.protocol
  const reasoningEffort = value?.reasoningEffort
  return {
    protocol: protocol === 'responses' || protocol === 'chat-completions' ? protocol : 'auto',
    ...(typeof value?.accountApiBaseURL === 'string' && value.accountApiBaseURL.trim()
      ? { accountApiBaseURL: normalizeAccountApiRoot(value.accountApiBaseURL) }
      : {}),
    reasoningEffort: isReasoningEffort(reasoningEffort) ? reasoningEffort : 'auto',
  }
}

/**
 * Coordinates one protocol choice across consciousness, Planner, and Replyer.
 *
 * Auto mode always tries Responses first. It permanently selects Chat
 * Completions only after a strict endpoint-not-supported failure before any
 * text was emitted; transient/model/auth failures never change capability.
 */
export class Sub2ApiProtocolRouter {
  #resolved?: Exclude<Sub2ApiProtocol, 'auto'>

  constructor(protocol: Sub2ApiProtocol) {
    if (protocol !== 'auto')
      this.#resolved = protocol
  }

  resolvedProtocol(): Exclude<Sub2ApiProtocol, 'auto'> | undefined {
    return this.#resolved
  }

  async run<T>(handlers: {
    responses: () => Promise<T>
    chatCompletions: () => Promise<T>
  }): Promise<Sub2ApiProtocolRunResult<T>> {
    if (this.#resolved === 'chat-completions') {
      return {
        value: await handlers.chatCompletions(),
        protocol: 'chat-completions',
        fallbackUsed: false,
      }
    }
    if (this.#resolved === 'responses') {
      return {
        value: await handlers.responses(),
        protocol: 'responses',
        fallbackUsed: false,
      }
    }

    try {
      const value = await handlers.responses()
      this.#resolved = 'responses'
      return { value, protocol: 'responses', fallbackUsed: false }
    }
    catch (error) {
      if (!canFallbackFromResponses(error))
        throw error
      this.#resolved = 'chat-completions'
      return {
        value: await handlers.chatCompletions(),
        protocol: 'chat-completions',
        fallbackUsed: true,
      }
    }
  }
}

/** Native `/v1/responses` client used by all Sub2API model ports. */
export class Sub2ApiResponsesClient {
  readonly #apiKey?: string
  readonly #baseURL: string
  readonly #fetch: typeof globalThis.fetch
  readonly #maxOutputTokens?: number
  readonly #model: string
  readonly #reasoningEffort: Sub2ApiReasoningEffort
  readonly #temperature?: number
  readonly #timeoutMs: number

  constructor(options: Sub2ApiResponsesClientOptions) {
    this.#baseURL = normalizeModelApiRoot(options.baseURL)
    this.#apiKey = options.apiKey?.trim() || undefined
    this.#model = requiredText(options.model, 'model', 240)
    this.#temperature = options.temperature
    this.#maxOutputTokens = options.maxOutputTokens
    this.#reasoningEffort = options.reasoningEffort ?? 'auto'
    this.#timeoutMs = boundedInteger(options.timeoutMs ?? 300_000, 1_000, 600_000, 'timeoutMs')
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  async request(input: Sub2ApiResponsesRequest): Promise<Sub2ApiNormalizedResult> {
    const endpoint = resolveProviderEndpoint(this.#baseURL, 'responses')
    const signal = createRequestSignal(input.signal, this.#timeoutMs)
    const body = {
      model: this.#model,
      ...(input.instructions ? { instructions: input.instructions } : {}),
      input: input.input,
      ...(input.tools?.length ? { tools: input.tools } : {}),
      ...(input.tools?.length ? { tool_choice: input.toolChoice ?? 'auto' } : {}),
      store: false,
      stream: true,
      ...(this.#temperature !== undefined ? { temperature: this.#temperature } : {}),
      ...(boundedOutputTokens(this.#maxOutputTokens, input.maxOutputTokens) !== undefined
        ? { max_output_tokens: boundedOutputTokens(this.#maxOutputTokens, input.maxOutputTokens) }
        : {}),
      ...(this.#reasoningEffort !== 'auto'
        ? { reasoning: { effort: this.#reasoningEffort } }
        : {}),
    }

    try {
      let response: Response
      try {
        response = await this.#fetch(endpoint, {
          method: 'POST',
          headers: {
            'accept': 'text/event-stream, application/json',
            'content-type': 'application/json',
            ...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: signal.signal,
        })
      }
      catch (error) {
        throw requestTransportError(error, signal, {
          protocol: 'responses',
          model: this.#model,
          endpoint: endpoint.pathname,
        })
      }

      const requestId = providerRequestId(response.headers)
      if (!response.ok)
        throw await responseError(response, 'responses', this.#model, endpoint.pathname, requestId)

      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (contentType.includes('text/event-stream') && response.body) {
        return await parseSub2ApiResponsesStream(response.body, {
          requestedModel: this.#model,
          requestId,
          onTextDelta: input.onTextDelta,
        })
      }

      const text = await response.text()
      if (/^\s*(?:event:|data:)/.test(text)) {
        return await parseSub2ApiResponsesStream(streamFromText(text), {
          requestedModel: this.#model,
          requestId,
          onTextDelta: input.onTextDelta,
        })
      }
      return normalizeResponsesDocument(parseJson(text, 'invalid_response'), this.#model, requestId)
    }
    catch (error) {
      if (signal.timedOut() && (!(error instanceof Sub2ApiProviderError) || error.kind !== 'timeout')) {
        throw new Sub2ApiProviderError('timeout', 'Sub2API 请求超时', {
          protocol: 'responses',
          model: this.#model,
          endpoint: endpoint.pathname,
        }, { cause: error })
      }
      if (signal.aborted() && (!(error instanceof Sub2ApiProviderError) || error.kind !== 'cancelled')) {
        throw new Sub2ApiProviderError('cancelled', 'Sub2API 请求已取消', {
          protocol: 'responses',
          model: this.#model,
          endpoint: endpoint.pathname,
        }, { cause: error })
      }
      throw error
    }
    finally {
      signal.dispose()
    }
  }
}

interface ParseStreamOptions {
  requestedModel: string
  requestId?: string
  onTextDelta?: (delta: string) => void
}

interface MutableToolCall {
  id: string
  name: string
  arguments: string
}

/** Parses arbitrarily chunked Responses SSE into Lumi's provider-neutral result. */
export async function parseSub2ApiResponsesStream(
  stream: ReadableStream<Uint8Array>,
  options: ParseStreamOptions,
): Promise<Sub2ApiNormalizedResult> {
  const state = {
    text: '',
    reasoning: '',
    toolCalls: new Map<string, MutableToolCall>(),
    completed: false,
    responseId: undefined as string | undefined,
    resolvedModel: undefined as string | undefined,
    usage: undefined as Sub2ApiNormalizedUsage | undefined,
  }

  try {
    for await (const payload of parseSseData(stream)) {
      if (payload === '[DONE]')
        continue
      const event = parseJson(payload, 'invalid_sse')
      applyResponsesEvent(event, state, options.onTextDelta)
    }
  }
  catch (error) {
    if (error instanceof Sub2ApiProviderError) {
      throw new Sub2ApiProviderError(error.kind, error.message, {
        ...error.details,
        protocol: 'responses',
        model: options.requestedModel,
        requestId: options.requestId,
        partialOutput: state.text.length > 0,
      }, { cause: error })
    }
    throw new Sub2ApiProviderError('stream_interrupted', 'Sub2API Responses 流读取失败', {
      protocol: 'responses',
      model: options.requestedModel,
      requestId: options.requestId,
      partialOutput: state.text.length > 0,
    }, { cause: error })
  }

  if (!state.completed) {
    throw new Sub2ApiProviderError('stream_interrupted', 'Sub2API Responses 流在 completed 事件前结束', {
      protocol: 'responses',
      model: options.requestedModel,
      requestId: options.requestId,
      responseId: state.responseId,
      partialOutput: state.text.length > 0,
    })
  }

  return {
    text: state.text,
    ...(state.reasoning ? { reasoning: state.reasoning } : {}),
    toolCalls: [...state.toolCalls.values()],
    ...(state.usage ? { usage: state.usage } : {}),
    requestedModel: options.requestedModel,
    ...(state.resolvedModel ? { resolvedModel: state.resolvedModel } : {}),
    ...(state.responseId ? { responseId: state.responseId } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
  }
}

async function* parseSseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []

  const emitLine = (line: string) => {
    if (line === '') {
      const data = dataLines.join('\n')
      dataLines = []
      return data || undefined
    }
    if (line.startsWith(':'))
      return undefined
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' '))
      value = value.slice(1)
    if (field === 'data')
      dataLines.push(value)
    return undefined
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      let lineEnd = nextLineEnd(buffer)
      while (lineEnd) {
        const line = buffer.slice(0, lineEnd.index)
        buffer = buffer.slice(lineEnd.index + lineEnd.length)
        const data = emitLine(line)
        if (data !== undefined)
          yield data
        lineEnd = nextLineEnd(buffer)
      }
      if (done)
        break
    }
    if (buffer) {
      const data = emitLine(buffer)
      if (data !== undefined)
        yield data
    }
    if (dataLines.length > 0)
      yield dataLines.join('\n')
  }
  finally {
    reader.releaseLock()
  }
}

function nextLineEnd(value: string): { index: number, length: number } | undefined {
  const lf = value.indexOf('\n')
  const cr = value.indexOf('\r')
  if (lf < 0 && cr < 0)
    return undefined
  if (cr >= 0 && (lf < 0 || cr < lf))
    return { index: cr, length: value[cr + 1] === '\n' ? 2 : 1 }
  return { index: lf, length: 1 }
}

function applyResponsesEvent(
  event: Record<string, unknown>,
  state: {
    text: string
    reasoning: string
    toolCalls: Map<string, MutableToolCall>
    completed: boolean
    responseId?: string
    resolvedModel?: string
    usage?: Sub2ApiNormalizedUsage
  },
  onTextDelta?: (delta: string) => void,
): void {
  const type = text(event.type)
  if (type === 'response.output_text.delta') {
    const delta = text(event.delta)
    state.text += delta
    if (delta)
      onTextDelta?.(delta)
    return
  }
  if (type === 'response.reasoning_summary_text.delta') {
    state.reasoning += text(event.delta)
    return
  }
  if (type === 'response.output_item.added' || type === 'response.output_item.done') {
    const item = record(event.item)
    if (item)
      mergeOutputItem(item, state.toolCalls)
    return
  }
  if (type === 'response.function_call_arguments.delta') {
    const key = toolCallKey(event)
    const current = state.toolCalls.get(key) ?? {
      id: text(event.call_id) || key,
      name: text(event.name),
      arguments: '',
    }
    current.arguments += text(event.delta)
    state.toolCalls.set(key, current)
    return
  }
  if (type === 'response.function_call_arguments.done') {
    const key = toolCallKey(event)
    const current = state.toolCalls.get(key) ?? {
      id: text(event.call_id) || key,
      name: text(event.name),
      arguments: '',
    }
    current.id = text(event.call_id) || current.id
    current.name = text(event.name) || current.name
    current.arguments = text(event.arguments) || current.arguments
    state.toolCalls.set(key, current)
    return
  }
  if (type === 'response.failed' || type === 'error') {
    const response = record(event.response)
    const error = record(event.error) ?? record(response?.error)
    throw eventFailure(error, response)
  }
  if (type !== 'response.completed')
    return

  const response = record(event.response)
  if (!response)
    throw new Sub2ApiProviderError('invalid_sse', 'Responses completed 事件缺少 response 对象')
  const normalized = normalizeResponsesDocument(response, '')
  if (!state.text && normalized.text) {
    state.text = normalized.text
    onTextDelta?.(normalized.text)
  }
  if (!state.reasoning && normalized.reasoning)
    state.reasoning = normalized.reasoning
  for (const call of normalized.toolCalls)
    mergeToolCall(state.toolCalls, call)
  state.completed = true
  state.responseId = normalized.responseId
  state.resolvedModel = normalized.resolvedModel
  state.usage = normalized.usage
}

function normalizeResponsesDocument(
  document: Record<string, unknown>,
  requestedModel: string,
  requestId?: string,
): Sub2ApiNormalizedResult {
  const status = text(document.status)
  if (status === 'failed' || record(document.error))
    throw eventFailure(record(document.error), document)

  const textParts: string[] = []
  const reasoningParts: string[] = []
  const toolCalls = new Map<string, MutableToolCall>()
  for (const item of array(document.output)) {
    const output = record(item)
    if (!output)
      continue
    if (text(output.id).startsWith('rs_') || output.type === 'reasoning') {
      for (const summary of array(output.summary)) {
        const part = record(summary)
        if (part && typeof part.text === 'string')
          reasoningParts.push(part.text)
      }
      continue
    }
    if (output.type === 'message') {
      for (const content of array(output.content)) {
        const part = record(content)
        if (part?.type === 'output_text' && typeof part.text === 'string')
          textParts.push(part.text)
      }
      continue
    }
    mergeOutputItem(output, toolCalls)
  }
  if (textParts.length === 0 && typeof document.output_text === 'string')
    textParts.push(document.output_text)

  const usage = normalizeUsage(document.usage)
  return {
    text: textParts.join(''),
    ...(reasoningParts.length ? { reasoning: reasoningParts.join('\n') } : {}),
    toolCalls: [...toolCalls.values()],
    ...(usage ? { usage } : {}),
    requestedModel,
    ...(typeof document.model === 'string' ? { resolvedModel: document.model } : {}),
    ...(typeof document.id === 'string' ? { responseId: document.id } : {}),
    ...(requestId ? { requestId } : {}),
  }
}

function mergeOutputItem(item: Record<string, unknown>, calls: Map<string, MutableToolCall>): void {
  if (item.type !== 'function_call')
    return
  const key = text(item.call_id) || text(item.id)
  if (!key)
    throw new Sub2ApiProviderError('invalid_response', 'Responses function_call 缺少 id/call_id')
  const current = calls.get(key)
  mergeToolCall(calls, {
    id: text(item.call_id) || current?.id || key,
    name: text(item.name) || current?.name || '',
    arguments: typeof item.arguments === 'string' ? item.arguments : current?.arguments ?? '',
  })
}

function toolCallKey(event: Record<string, unknown>): string {
  return text(event.call_id)
    || text(event.item_id)
    || (typeof event.output_index === 'number' ? `output:${event.output_index}` : '')
    || 'output:unknown'
}

function mergeToolCall(calls: Map<string, MutableToolCall>, incoming: MutableToolCall): void {
  const aliases = [...calls.entries()].filter(([, call]) => call.id === incoming.id)
  const existing = calls.get(incoming.id) ?? aliases[0]?.[1]
  for (const [key] of aliases)
    calls.delete(key)
  calls.set(incoming.id, {
    id: incoming.id,
    name: incoming.name || existing?.name || '',
    arguments: incoming.arguments || existing?.arguments || '',
  })
}

function normalizeUsage(value: unknown): Sub2ApiNormalizedUsage | undefined {
  const usage = record(value)
  if (!usage)
    return undefined
  const inputDetails = record(usage.input_tokens_details)
  return compactUsage({
    inputTokens: number(usage.input_tokens),
    cachedInputTokens: number(inputDetails?.cached_tokens),
    outputTokens: number(usage.output_tokens),
    totalTokens: number(usage.total_tokens),
  })
}

function compactUsage(usage: Sub2ApiNormalizedUsage): Sub2ApiNormalizedUsage | undefined {
  return Object.values(usage).some(value => value !== undefined) ? usage : undefined
}

function eventFailure(error: Record<string, unknown> | undefined, response?: Record<string, unknown>): Sub2ApiProviderError {
  const code = text(error?.code) || text(error?.type)
  return new Sub2ApiProviderError('invalid_response', text(error?.message) || 'Sub2API Responses 返回失败状态', {
    code: code || undefined,
    responseId: text(response?.id) || undefined,
  })
}

async function responseError(
  response: Response,
  protocol: Exclude<Sub2ApiProtocol, 'auto'>,
  model: string,
  endpoint: string,
  requestId?: string,
): Promise<Sub2ApiProviderError> {
  const raw = await response.text().catch(() => '')
  const payload = tryParseJson(raw)
  const root = record(payload)
  const error = record(root?.error) ?? root
  const code = text(error?.code) || text(error?.type) || text(root?.code)
  const message = text(error?.message) || text(root?.message) || response.statusText || `HTTP ${response.status}`
  const kind = classifyHttpError(response.status, code, message, endpoint)
  return new Sub2ApiProviderError(kind, `${response.status}: ${message}`, {
    status: response.status,
    code: code || undefined,
    requestId,
    retryAfter: response.headers.get('retry-after') ?? undefined,
    protocol,
    model,
    endpoint,
  })
}

function classifyHttpError(
  status: number,
  code: string,
  message: string,
  endpoint: string,
): Sub2ApiProviderErrorKind {
  const detail = `${code} ${message}`.toLowerCase()
  if (status === 401)
    return 'unauthorized'
  if (status === 403)
    return 'forbidden'
  if (status === 408)
    return 'timeout'
  if (status === 429)
    return detail.includes('quota') || detail.includes('balance') ? 'quota_exhausted' : 'rate_limited'
  if (status === 502 || status === 503 || status === 504)
    return 'upstream_unavailable'
  if (detail.includes('quota') || detail.includes('insufficient balance'))
    return 'quota_exhausted'
  if (status === 405 || status === 501)
    return 'endpoint_not_supported'
  if (/endpoint|protocol|route|method|not[_ -]?implemented|unsupported/.test(detail))
    return 'endpoint_not_supported'
  if (status === 404 && /model/.test(detail) && /not[_ -]?found|does not exist|unknown/.test(detail))
    return 'model_not_found'
  if (status === 404 && detail.includes(endpoint.toLowerCase()))
    return 'endpoint_not_supported'
  return 'unknown'
}

function requestTransportError(
  error: unknown,
  signal: ReturnType<typeof createRequestSignal>,
  details: Sub2ApiProviderErrorDetails,
): Sub2ApiProviderError {
  if (signal.timedOut())
    return new Sub2ApiProviderError('timeout', 'Sub2API 请求超时', details, { cause: error })
  if (signal.aborted())
    return new Sub2ApiProviderError('cancelled', 'Sub2API 请求已取消', details, { cause: error })
  return new Sub2ApiProviderError('upstream_unavailable', '无法连接 Sub2API 模型端点', details, { cause: error })
}

function createRequestSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController()
  let didTimeout = false
  const abortFromParent = () => controller.abort(parent?.reason)
  if (parent?.aborted)
    abortFromParent()
  else
    parent?.addEventListener('abort', abortFromParent, { once: true })
  const timeout = setTimeout(() => {
    didTimeout = true
    controller.abort(new DOMException('Request timed out', 'TimeoutError'))
  }, timeoutMs)
  return {
    signal: controller.signal,
    aborted: () => controller.signal.aborted && !didTimeout,
    timedOut: () => didTimeout,
    dispose: () => {
      clearTimeout(timeout)
      parent?.removeEventListener('abort', abortFromParent)
    },
  }
}

function canFallbackFromResponses(error: unknown): boolean {
  return error instanceof Sub2ApiProviderError
    && error.kind === 'endpoint_not_supported'
    && error.details.partialOutput !== true
}

function parseHttpUrl(value: string, field: string): URL {
  try {
    const url = new URL(requiredText(value, field, 2_048))
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error('unsupported protocol')
    if (url.username || url.password)
      throw new Error('embedded credentials are not allowed')
    if (url.search || url.hash)
      throw new Error('query and fragment are not allowed')
    return url
  }
  catch (error) {
    throw new Sub2ApiProviderError('invalid_base_url', `${field} 必须是有效的 HTTP/HTTPS 地址`, {}, { cause: error })
  }
}

function isReasoningEffort(value: unknown): value is Sub2ApiReasoningEffort {
  return value === 'auto'
    || value === 'none'
    || value === 'minimal'
    || value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh'
}

function providerRequestId(headers: Headers): string | undefined {
  return headers.get('x-request-id')
    ?? headers.get('request-id')
    ?? headers.get('cf-ray')
    ?? undefined
}

function redactProviderText(value: string): string {
  return value
    .replace(/authorization\s*[:=]\s*bearer\s+[^\s,;]+/gi, 'Authorization: Bearer [redacted]')
    .replace(/bearer\s+[\w.~+/-]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[\w-]{8,}\b/gi, '[redacted-api-key]')
    .replace(/([?&](?:token|key|api_key|access_token)=)[^&\s]+/gi, '$1[redacted]')
    .slice(0, 800)
}

function parseJson(value: string, kind: 'invalid_response' | 'invalid_sse'): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value)
    const document = record(parsed)
    if (!document)
      throw new Error('JSON root is not an object')
    return document
  }
  catch (error) {
    throw new Sub2ApiProviderError(kind, kind === 'invalid_sse' ? 'Sub2API SSE 包含无效 JSON' : 'Sub2API 返回了无效 JSON', {}, { cause: error })
  }
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  }
  catch {
    return undefined
  }
}

function streamFromText(value: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(value)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded)
      controller.close()
    },
  })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function requiredText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim()
  if (!normalized)
    throw new Error(`${field} is required`)
  if (normalized.length > maxLength)
    throw new Error(`${field} is too long`)
  return normalized
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${field} must be between ${minimum} and ${maximum}`)
  return value
}

function boundedOutputTokens(configured: number | undefined, requested: number | undefined): number | undefined {
  if (configured === undefined)
    return requested
  if (requested === undefined)
    return configured
  return Math.min(configured, requested)
}
