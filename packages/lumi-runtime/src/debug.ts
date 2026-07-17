import type { SanitizedProviderPayload } from './types'

const secretKeyPattern = /authorization|api[-_]?key|token|secret|password|credential/i
const redacted = '[redacted]'

/**
 * Redacts provider payload secrets for debug panels.
 *
 * Use when:
 * - A provider adapter exposes request metadata to an IO trace panel.
 * - Tests need to prove API keys cannot leak through runtime debug payloads.
 *
 * Expects:
 * - Plain JSON-compatible payload objects.
 *
 * Returns:
 * - A deep-cloned payload with secret-like keys replaced by `[redacted]`.
 */
export function sanitizeProviderPayload(payload: SanitizedProviderPayload): SanitizedProviderPayload {
  return redactValue(payload) as SanitizedProviderPayload
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(item => redactValue(item))

  if (!value || typeof value !== 'object')
    return value

  const result: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    result[key] = secretKeyPattern.test(key) ? redacted : redactValue(child)
  }
  return result
}

