import type { LanguageModelMessage, PlannerMessage } from '../ports/model'

/** Prompt templates that may be replaced by a host-owned configuration directory. */
export type LumiPromptTemplateId
  = | 'planner'
    | 'replyer'
    | 'expression_selector'
    | 'expression_learning'
    | 'jargon_learning'
    | 'behavior_learning'
    | 'public_group_knowledge_learning'
    | 'context_summary'

/** Stable identity attached to every model request that uses a Lumi prompt. */
export interface LumiPromptTemplateMetadata {
  id: LumiPromptTemplateId
  version: string
  hash: string
}

/** Host-resolved prompt content and its trace metadata. */
export interface LumiPromptTemplate extends LumiPromptTemplateMetadata {
  content: string
}

/** Default versions change only when the corresponding prompt contract changes. */
export const DEFAULT_LUMI_PROMPT_VERSIONS: Readonly<Record<LumiPromptTemplateId, string>> = Object.freeze({
  planner: 'lumi-planner:v3',
  replyer: 'lumi-replyer:v3',
  expression_selector: 'lumi-expression-selector:v2',
  expression_learning: 'lumi-expression-learning:v2',
  jargon_learning: 'lumi-jargon-learning:v2',
  behavior_learning: 'lumi-behavior-learning:v2',
  public_group_knowledge_learning: 'lumi-public-group-knowledge-learning:v2',
  context_summary: 'lumi-context-summary:v2',
})

/**
 * Creates immutable prompt metadata from resolved content.
 *
 * Use when:
 * - A default prompt or host override is about to enter a model request
 *
 * Expects:
 * - A non-empty version and prompt body
 *
 * Returns:
 * - Stable FNV-1a metadata that works in browser and Node runtimes
 */
export function createLumiPromptTemplate(
  id: LumiPromptTemplateId,
  content: string,
  version = DEFAULT_LUMI_PROMPT_VERSIONS[id],
): LumiPromptTemplate {
  const normalizedContent = content.trim()
  const normalizedVersion = version.trim()
  if (!normalizedContent)
    throw new TypeError(`Prompt template ${id} must not be empty`)
  if (!normalizedVersion)
    throw new TypeError(`Prompt template ${id} version must not be empty`)
  return Object.freeze({
    id,
    version: normalizedVersion,
    hash: stablePromptHash(normalizedContent),
    content: normalizedContent,
  })
}

/** Removes prompt content before metadata enters the default trace path. */
export function lumiPromptTemplateMetadata(
  template: LumiPromptTemplate,
): LumiPromptTemplateMetadata {
  return {
    id: template.id,
    version: template.version,
    hash: template.hash,
  }
}

/**
 * Redacts a private prompt snapshot before a host persists it.
 *
 * Before:
 * - `{"apiKey":"secret","query":"hello"}`
 *
 * After:
 * - `{"apiKey":"[REDACTED]","query":"hello"}`
 */
export function redactPromptMessages(
  messages: readonly (PlannerMessage | LanguageModelMessage)[],
): Array<{ role: string, content: string }> {
  return messages.map(message => ({
    role: message.role,
    content: redactPromptContent(message.content),
  }))
}

/** Stable browser-safe hash used for prompt identity, not cryptographic verification. */
export function stablePromptHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

const SENSITIVE_KEYS = /authorization|token|secret|password|credential|api[_-]?key/i

function redactPromptContent(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content)
    return JSON.stringify(redactValue(parsed))
  }
  catch {
    return content
      .replace(
        /((?:authorization|token|secret|password|credential|api[_-]?key)\s*[:=]\s*)([^\s,;]+)/gi,
        '$1[REDACTED]',
      )
      .replace(/\bBearer\s+[\w.~+/-]+=*/gi, 'Bearer [REDACTED]')
  }
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(redactValue)
  if (!value || typeof value !== 'object')
    return value
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_KEYS.test(key) ? '[REDACTED]' : redactValue(nested),
    ]),
  )
}
