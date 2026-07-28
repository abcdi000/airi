/**
 * Projects a strict Replyer JSON document into user-visible message text while
 * the document is still arriving.
 *
 * Use when:
 * - A no-tool Replyer streams `{"messages":[{"text":"..."}]}`.
 * - The UI needs live text without exposing protocol fields or planner data.
 *
 * Expects:
 * - Strict JSON in the current Replyer format, or legacy plain text.
 *
 * Returns:
 * - Only decoded `messages[*].text` values. Incomplete JSON escape sequences
 *   are held back until enough bytes arrive to decode them safely.
 */
export function projectReplyStream(raw: string): string {
  const normalized = raw.trimStart()
  if (!normalized)
    return ''
  if (!normalized.startsWith('{'))
    return normalized

  const texts: string[] = []
  let cursor = 0
  while (cursor < normalized.length) {
    const quoteIndex = normalized.indexOf('"', cursor)
    if (quoteIndex < 0)
      break

    const key = readJsonString(normalized, quoteIndex)
    if (!key.closed) {
      break
    }

    let separatorIndex = skipWhitespace(normalized, key.endIndex)
    if (normalized[separatorIndex] !== ':') {
      cursor = key.endIndex
      continue
    }
    separatorIndex = skipWhitespace(normalized, separatorIndex + 1)
    if (key.value !== 'text' || normalized[separatorIndex] !== '"') {
      cursor = key.endIndex
      continue
    }

    const value = readJsonString(normalized, separatorIndex)
    if (value.value)
      texts.push(value.value)
    cursor = value.endIndex
    if (!value.closed)
      break
  }

  return texts.join('\n\n')
}

function readJsonString(source: string, openingQuoteIndex: number): {
  closed: boolean
  endIndex: number
  value: string
} {
  let value = ''
  let cursor = openingQuoteIndex + 1
  while (cursor < source.length) {
    const character = source[cursor]
    if (character === '"') {
      return {
        closed: true,
        endIndex: cursor + 1,
        value,
      }
    }
    if (character !== '\\') {
      value += character
      cursor += 1
      continue
    }

    const escape = source[cursor + 1]
    if (escape === undefined)
      break
    if (escape === 'u') {
      const code = source.slice(cursor + 2, cursor + 6)
      if (!/^[\da-f]{4}$/i.test(code))
        break
      value += String.fromCharCode(Number.parseInt(code, 16))
      cursor += 6
      continue
    }

    const decoded = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      'b': '\b',
      'f': '\f',
      'n': '\n',
      'r': '\r',
      't': '\t',
    }[escape]
    if (decoded === undefined)
      break
    value += decoded
    cursor += 2
  }

  return {
    closed: false,
    endIndex: source.length,
    value,
  }
}

function skipWhitespace(source: string, startIndex: number): number {
  let cursor = startIndex
  while (cursor < source.length && /\s/.test(source[cursor] ?? ''))
    cursor += 1
  return cursor
}
