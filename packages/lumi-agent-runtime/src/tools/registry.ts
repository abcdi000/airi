import type { PlannerToolDefinition } from '../ports/model'

/** Tool visibility in one Planner request. */
export type ToolVisibility = 'visible' | 'deferred' | 'hidden'

/** Runtime stage in which a tool may be used. */
export type ToolStage = 'planner' | 'reply' | 'learning' | 'background'

/** Conversation scopes supported by a tool. */
export type ToolChatScope = 'direct' | 'group_observation' | 'both'

/** User-facing risk level retained from Tool Mesh. */
export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'critical'

/** How the host executes a tool. */
export type ToolExecutionMode = 'automatic' | 'confirm' | 'manual'

/** Side-effect category used for idempotency and shadow-mode policy. */
export type ToolSideEffectType = 'none' | 'read' | 'write' | 'external'

/** Idempotency requirement for a tool invocation. */
export type ToolIdempotencyPolicy = 'none' | 'optional' | 'required'

/** Planner-independent availability context. */
export interface ToolAvailabilityContext {
  conversationId: string
  personId: string
  grantedScopes: ReadonlySet<string>
  runtimeMode: 'legacy' | 'shadow' | 'maisaka'
}

/** One validated tool invocation. */
export interface ToolInvocation {
  callId: string
  toolName: string
  arguments: Readonly<Record<string, unknown>>
  idempotencyKey?: string
}

/** Structured result returned to the Planner ledger. */
export interface ToolExecutionResult {
  success: boolean
  output?: unknown
  errorCode?: string
  errorMessage?: string
  metadata?: Readonly<Record<string, unknown>>
}

/** Context available to a ToolSpec handler. */
export interface ToolHandlerContext {
  invocation: ToolInvocation
  conversationId: string
  personId: string
  signal?: AbortSignal
}

/**
 * Unified tool contract for builtin, Tool Mesh, MCP, and plugin tools.
 */
export interface ToolSpec {
  name: string
  description: string
  inputSchema: Readonly<Record<string, unknown>>
  outputSchema?: Readonly<Record<string, unknown>>
  /**
   * Exact user-language fragments that make this tool mandatory before reply.
   *
   * Use only for explicit commands such as "从记忆里查"; ordinary intent
   * inference remains the Planner's responsibility.
   */
  explicitInvocationHints?: readonly string[]
  /**
   * Tool-specific execution timeout in milliseconds.
   *
   * Use only when a tool owns a bounded multi-stage workflow whose legitimate
   * duration is longer than the runtime-wide default.
   */
  timeoutMs?: number
  provider: string
  visibility: ToolVisibility
  stage: ToolStage
  chatScope: ToolChatScope
  riskLevel: ToolRiskLevel
  executionMode: ToolExecutionMode
  sideEffectType: ToolSideEffectType
  idempotencyPolicy: ToolIdempotencyPolicy
  requiredScopes: readonly string[]
  availability?: (context: ToolAvailabilityContext) => boolean | Promise<boolean>
  handler: (context: ToolHandlerContext) => Promise<ToolExecutionResult>
}

/** Error raised for duplicate or invalid registry operations. */
export class ToolRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolRegistryError'
  }
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalizes host and legacy Tool Mesh schemas into provider-safe JSON Schema.
 *
 * Before:
 * - `{}`
 * - `{ query: "string?", limit: "number?" }`
 *
 * After:
 * - `{ type: "object", properties: {}, additionalProperties: false }`
 * - A root object schema with typed `query` and `limit` properties
 */
function normalizeInputSchema(schema: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (schema.type === 'object') {
    return {
      ...schema,
      type: 'object',
      properties: isRecord(schema.properties) ? schema.properties : {},
      additionalProperties: schema.additionalProperties ?? false,
    }
  }

  const entries = Object.entries(schema)
  const isLegacyShape = entries.every(([, descriptor]) => typeof descriptor === 'string')
  if (!isLegacyShape) {
    return {
      type: 'object',
      properties: {},
      additionalProperties: false,
    }
  }

  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, rawDescriptor] of entries) {
    const descriptor = String(rawDescriptor)
    const optional = descriptor.endsWith('?')
    const typeName = optional ? descriptor.slice(0, -1) : descriptor
    properties[name] = legacyPropertySchema(typeName)
    if (!optional)
      required.push(name)
  }

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

function legacyPropertySchema(descriptor: string): Readonly<Record<string, unknown>> {
  if (descriptor.endsWith('[]')) {
    return {
      type: 'array',
      items: legacyPropertySchema(descriptor.slice(0, -2)),
    }
  }
  if (descriptor === 'string')
    return { type: 'string' }
  if (descriptor === 'number')
    return { type: 'number' }
  if (descriptor === 'integer')
    return { type: 'integer' }
  if (descriptor === 'boolean')
    return { type: 'boolean' }
  return { type: 'object', additionalProperties: true }
}

/**
 * Stores canonical ToolSpecs and resolves stage-specific availability.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, ToolSpec>()

  register(spec: ToolSpec): void {
    const name = spec.name.trim()
    if (!name)
      throw new ToolRegistryError('Tool name must be non-empty')
    if (this.#tools.has(name))
      throw new ToolRegistryError(`Tool already registered: ${name}`)
    if (spec.chatScope === 'group_observation' && spec.sideEffectType !== 'none' && spec.sideEffectType !== 'read')
      throw new ToolRegistryError(`Group observation tool cannot have outbound side effects: ${name}`)
    this.#tools.set(name, Object.freeze({
      ...spec,
      name,
      inputSchema: normalizeInputSchema(spec.inputSchema),
    }))
  }

  get(name: string): ToolSpec | undefined {
    return this.#tools.get(name)
  }

  list(): readonly ToolSpec[] {
    return [...this.#tools.values()]
  }

  /**
   * Revalidates execution policy independently from Planner tool visibility.
   *
   * Use when:
   * - A model-emitted tool call is about to execute
   * - A caller must not trust that the tool name came from the advertised list
   *
   * Expects:
   * - Direct-chat availability context from the owning session
   *
   * Returns:
   * - Whether scope, shadow-mode, and host availability policy allow execution
   */
  async canExecute(name: string, context: ToolAvailabilityContext): Promise<boolean> {
    const spec = this.#tools.get(name)
    if (!spec)
      return false
    if (spec.chatScope !== 'both' && spec.chatScope !== 'direct')
      return false
    if (spec.requiredScopes.some(scope => !context.grantedScopes.has(scope)))
      return false
    if (context.runtimeMode === 'shadow' && spec.sideEffectType !== 'none' && spec.sideEffectType !== 'read')
      return false
    return !spec.availability || await spec.availability(context)
  }

  async listAvailable(
    context: ToolAvailabilityContext,
    options: {
      stage?: ToolStage
      visibility?: ToolVisibility
      discoveredToolNames?: ReadonlySet<string>
    } = {},
  ): Promise<readonly ToolSpec[]> {
    const available: ToolSpec[] = []
    for (const spec of this.#tools.values()) {
      if (options.stage && spec.stage !== options.stage)
        continue
      if (spec.chatScope !== 'both' && spec.chatScope !== 'direct')
        continue
      const effectivelyVisible = spec.visibility !== 'deferred'
        || options.discoveredToolNames?.has(spec.name)
      if (options.visibility && spec.visibility !== options.visibility)
        continue
      if (!effectivelyVisible && options.visibility !== 'deferred')
        continue
      if (!await this.canExecute(spec.name, context))
        continue
      available.push(spec)
    }
    return available
  }

  searchDeferred(query: string, limit = 5): readonly ToolSpec[] {
    const normalizedQuery = normalizeSearchText(query)
    if (!normalizedQuery)
      return []
    const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)))
    return [...this.#tools.values()]
      .filter(spec => spec.visibility === 'deferred')
      .map((spec) => {
        const name = normalizeSearchText(spec.name)
        const description = normalizeSearchText(spec.description)
        const score = name === normalizedQuery
          ? 3
          : name.includes(normalizedQuery)
            ? 2
            : description.includes(normalizedQuery)
              ? 1
              : 0
        return { spec, score }
      })
      .filter(item => item.score > 0)
      .sort((left, right) => right.score - left.score || left.spec.name.localeCompare(right.spec.name))
      .slice(0, boundedLimit)
      .map(item => item.spec)
  }

  /**
   * Finds tools explicitly requested in the current user message.
   *
   * Use when:
   * - A user names a capability and the runtime must prevent a fake execution
   *
   * Expects:
   * - Only the current user message, never accumulated conversation history
   *
   * Returns:
   * - Available tools whose declared command fragments occur in the message
   */
  matchExplicitRequests(text: string, available: readonly ToolSpec[]): readonly ToolSpec[] {
    const normalizedText = normalizeSearchText(text)
    if (!normalizedText)
      return []
    return available.filter((spec) => {
      const normalizedName = normalizeSearchText(spec.name)
      return normalizedText.includes(normalizedName)
        || spec.explicitInvocationHints?.some(hint =>
          normalizedText.includes(normalizeSearchText(hint)),
        )
    })
  }

  toPlannerDefinitions(specs: readonly ToolSpec[]): readonly PlannerToolDefinition[] {
    return specs.map(spec => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
    }))
  }
}
