/**
 * JSON-schema-shaped model tool definition.
 */
export interface PlannerToolDefinition {
  name: string
  description: string
  inputSchema: Readonly<Record<string, unknown>>
}

/** One tool call emitted by a single Planner model step. */
export interface PlannerToolCall {
  id: string
  name: string
  arguments: Readonly<Record<string, unknown>>
  /** Optional dependency call IDs declared by a host-aware model adapter. */
  dependsOn?: readonly string[]
}

/** Provider token and cache telemetry for one completed model step. */
export interface ModelUsage {
  inputTokens?: number
  outputTokens?: number
  cacheHitTokens?: number
  cacheMissTokens?: number
}

/** Identifies a provider response that cannot safely enter the Planner ledger. */
export class PlannerResponseFormatError extends Error {
  readonly code = 'PLANNER_RESPONSE_FORMAT_ERROR'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'PlannerResponseFormatError'
  }
}

/**
 * Normalizes model-emitted tool arguments without changing their data model.
 *
 * Before:
 * - `"{\"query\":\"Lumi\"}"`
 * - `` ```json\n{"query":"Lumi",}\n``` ``
 * - `{query: 'Lumi'}`
 *
 * After:
 * - `{ query: "Lumi" }`
 *
 * The returned value must still pass the receiving tool's own validation and
 * authorization checks before execution.
 */
export function parsePlannerToolArguments(raw: string): Readonly<Record<string, unknown>> | undefined {
  const candidates = toolArgumentCandidates(raw)
  for (const candidate of candidates) {
    const parsed = parseToolArgumentCandidate(candidate)
    if (isRecord(parsed))
      return parsed
  }
  return undefined
}

/** Provider-neutral Planner message. */
export type PlannerMessage
  = | { role: 'system', content: string }
    | { role: 'user', content: string }
    | { role: 'assistant', content: string, reasoning?: string, toolCalls?: readonly PlannerToolCall[] }
    | { role: 'tool', content: string, toolCallId: string, toolName: string }

/**
 * Runs exactly one Planner model step.
 *
 * Implementations must not execute tools or automatically continue to another
 * model step.
 */
export interface PlannerModelPort {
  generateStep: (input: {
    messages: readonly PlannerMessage[]
    tools: readonly PlannerToolDefinition[]
    /**
     * Controls whether the provider may return plain assistant text.
     *
     * @default 'required'
     */
    toolChoice?: 'auto' | 'required'
    signal?: AbortSignal
  }) => Promise<{
    content: string
    reasoning?: string
    toolCalls: readonly PlannerToolCall[]
    usage?: ModelUsage
    modelName?: string
  }>
}

/** Purpose labels used for tool-free language model requests. */
export type LanguageModelPurpose
  = | 'replyer'
    | 'replyer_retry'
    | 'expression_selector'
    | 'expression_learning'
    | 'jargon_learning'
    | 'behavior_learning'
    | 'public_knowledge_learning'
    | 'feedback'
    | 'context_summary'
    | 'sticker_classifier'
    | 'sticker_selector'

/** A provider-neutral no-tool language message. */
export interface LanguageModelMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Generates text for a named, tool-free language task.
 */
export interface LanguageModelPort {
  generate: (
    messages: readonly LanguageModelMessage[],
    purpose: LanguageModelPurpose,
    signal?: AbortSignal,
    options?: {
      /** Hard output ceiling for bounded background tasks such as context summaries. */
      maxOutputTokens?: number
    },
  ) => Promise<string>
}

function toolArgumentCandidates(raw: string): string[] {
  const trimmed = raw.trim() || '{}'
  const unwrappedFence = trimmed
    .replace(/^```(?:json|json5|javascript|js)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  const extractedObject = extractFirstObject(unwrappedFence)
  return [...new Set([
    trimmed,
    unwrappedFence,
    extractedObject,
    repairJsonSyntax(unwrappedFence),
    repairJsonSyntax(extractedObject),
  ].filter((value): value is string => Boolean(value)))]
}

function parseToolArgumentCandidate(candidate: string): unknown {
  try {
    const first: unknown = JSON.parse(candidate)
    if (typeof first !== 'string')
      return first
    const nestedCandidates = toolArgumentCandidates(first)
    for (const nested of nestedCandidates) {
      try {
        return JSON.parse(nested)
      }
      catch {
        // Try the next bounded normalization of the same nested document.
      }
    }
  }
  catch {
    return undefined
  }
  return undefined
}

function extractFirstObject(value: string): string | undefined {
  const start = value.indexOf('{')
  if (start < 0)
    return undefined
  let quote: '"' | '\'' | undefined
  let escaped = false
  let depth = 0
  for (let index = start; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        continue
      }
      if (character === quote)
        quote = undefined
      continue
    }
    if (character === '"' || character === '\'') {
      quote = character
      continue
    }
    if (character === '{')
      depth += 1
    if (character === '}') {
      depth -= 1
      if (depth === 0)
        return value.slice(start, index + 1)
    }
  }
  return undefined
}

function repairJsonSyntax(value: string | undefined): string | undefined {
  if (!value)
    return undefined
  let repaired = ''
  let quote: '"' | '\'' | undefined
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === undefined)
      continue
    if (!quote) {
      if (character === '"' || character === '\'') {
        quote = character
        repaired += '"'
      }
      else {
        repaired += character
      }
      continue
    }
    if (escaped) {
      escaped = false
      if (quote === '\'' && character === '\'')
        repaired += '\''
      else if (quote === '\'' && character === '"')
        repaired += '\\"'
      else
        repaired += `\\${character}`
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === quote) {
      quote = undefined
      repaired += '"'
      continue
    }
    if (quote === '\'' && character === '"')
      repaired += '\\"'
    else if (character === '\n')
      repaired += '\\n'
    else if (character === '\r')
      repaired += '\\r'
    else if (character === '\t')
      repaired += '\\t'
    else
      repaired += character
  }
  if (escaped)
    repaired += '\\\\'
  if (quote)
    return undefined
  return repairObjectStructure(repaired)
}

function repairObjectStructure(value: string): string {
  let repaired = ''
  let inString = false
  let escaped = false
  let previousSignificant = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === undefined)
      continue
    if (inString) {
      repaired += character
      if (escaped)
        escaped = false
      else if (character === '\\')
        escaped = true
      else if (character === '"')
        inString = false
      continue
    }
    if (character === '"') {
      inString = true
      repaired += character
      previousSignificant = character
      continue
    }
    if (character === ',') {
      const nextSignificant = value.slice(index + 1).match(/\S/)?.[0]
      if (nextSignificant === '}' || nextSignificant === ']')
        continue
    }
    if (
      (previousSignificant === '{' || previousSignificant === ',')
      && /[a-z_$]/i.test(character)
    ) {
      const remaining = value.slice(index)
      const keyMatch = remaining.match(/^([a-z_$][\w$-]*)(\s*:)/i)
      if (keyMatch) {
        repaired += `"${keyMatch[1]}"${keyMatch[2]}`
        index += keyMatch[0].length - 1
        previousSignificant = ':'
        continue
      }
    }
    repaired += character
    if (!/\s/.test(character))
      previousSignificant = character
  }
  return repaired
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
