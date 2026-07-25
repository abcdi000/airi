/**
 * Extracts the first balanced JSON object from model output.
 *
 * Before:
 * - `````json\n{"ok":true}\n`````
 *
 * After:
 * - `{"ok":true}`
 */
export function extractJsonObjectText(raw: string): string | null {
  const start = raw.indexOf('{')
  if (start < 0)
    return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"')
        inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{')
      depth += 1
    else if (char === '}')
      depth -= 1
    if (depth === 0)
      return raw.slice(start, index + 1)
  }
  return null
}

/** Parses the first model-produced JSON object without throwing. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = extractJsonObjectText(raw)
  if (!text)
    return null
  try {
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : null
  }
  catch {
    return null
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function stringValue(value: unknown, fallback = '', maximum = 4_000) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : fallback
}

export function stringArray(value: unknown, maximumItems = 32, maximumLength = 1_000) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map(item => item.trim().slice(0, maximumLength))
        .filter(Boolean)
        .slice(0, maximumItems)
    : []
}

export function clamp01(value: unknown, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback
}
