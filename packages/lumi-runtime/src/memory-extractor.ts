import type { LumiMemoryCandidate, LumiMemoryType } from './types'

const LOW_VALUE_PATTERNS = new Set([
  'hi',
  'hello',
  'hey',
  'thanks',
  'ok',
  '\u597d\u7684',
  '\u8c22\u8c22',
  '\u55ef',
  '\u65e0\u804a',
])

export interface LumiMemoryExtractionOptions {
  sourceMessageId?: string
}

export function extractLumiMemoryCandidates(
  message: string,
  options: LumiMemoryExtractionOptions = {},
): LumiMemoryCandidate[] {
  const stripped = message.trim()
  if (!stripped || LOW_VALUE_PATTERNS.has(stripped.toLowerCase()))
    return []

  return [
    ...extractUserPreferences(stripped, options.sourceMessageId),
    ...extractUserFacts(stripped, options.sourceMessageId),
    ...extractProjectContext(stripped, options.sourceMessageId),
    ...extractPromise(stripped, options.sourceMessageId),
  ]
}

function extractUserPreferences(message: string, sourceMessageId?: string): LumiMemoryCandidate[] {
  if (/[?\uff1f]$/.test(message))
    return []

  const contextualFavorites = [...message.matchAll(/\u6211\u6700\u559c\u6b22\u7684([^=\uff1d:：\u662f\u3002\uff01\uff1f]{1,20})(?:\u662f|=|\uff1d|:|：)\s*([^.\u3002\uff01\uff1f]{1,80})/g)]
    .map(match =>
      candidate(
        'user_preference',
        `The user's favorite ${normalizeFavoriteSubject(match[1].trim())} is ${match[2].trim()}.`,
        sourceMessageId,
        'stable contextual preference',
        {
          relationshipRelevance: 0.55,
          tags: ['preference', normalizeFavoriteSubject(match[1].trim())],
        },
      ),
    )

  const patterns: Array<[RegExp, string, LumiMemoryType, string[]]> = [
    [/\bI (?:really )?like ([^.\u3002\uff01\uff1f]{2,80})/gi, 'The user likes {value}.', 'user_preference', ['preference']],
    [/\bI (?:really )?(?:dislike|hate) ([^.\u3002\uff01\uff1f]{2,80})/gi, 'The user dislikes {value}.', 'user_preference', ['preference']],
    [/\u6211(?:\u5f88|\u975e\u5e38|\u771f\u7684|\u6700)?\u559c\u6b22(?!\u7684)([^.\u3002\uff01\uff1f]{2,80})/g, 'The user likes {value}.', 'user_preference', ['preference']],
    [/\u6211(?:\u4e0d\u559c\u6b22|\u8ba8\u538c)([^.\u3002\uff01\uff1f]{2,80})/g, 'The user dislikes {value}.', 'user_preference', ['preference']],
  ]

  return [
    ...contextualFavorites,
    ...patterns.flatMap(([pattern, template, type, tags]) =>
    [...message.matchAll(pattern)].map(match =>
      candidate(type, template.replace('{value}', match[1].trim()), sourceMessageId, 'stable preference', {
        relationshipRelevance: 0.5,
        tags,
      }),
    ),
    ),
  ]
}

function extractUserFacts(message: string, sourceMessageId?: string): LumiMemoryCandidate[] {
  const patterns: Array<[RegExp, string, LumiMemoryType, string[]]> = [
    [/\bmy name is ([A-Za-z][A-Za-z0-9 _-]{1,60})/gi, "The user's name is {value}.", 'user_fact', ['fact']],
    [/\bI live in ([^.\u3002\uff01\uff1f]{2,80})/gi, 'The user lives in {value}.', 'user_fact', ['fact']],
    [/\u6211\u53eb([^.\u3002\uff01\uff1f]{1,40})/g, "The user's name is {value}.", 'user_fact', ['fact']],
    [/\u6211\u4f4f\u5728([^.\u3002\uff01\uff1f]{2,80})/g, 'The user lives in {value}.', 'user_fact', ['fact']],
  ]

  return patterns.flatMap(([pattern, template, type, tags]) =>
    [...message.matchAll(pattern)].map(match =>
      candidate(type, template.replace('{value}', match[1].trim()), sourceMessageId, 'stable user fact', {
        relationshipRelevance: 0.45,
        tags,
      }),
    ),
  )
}

function extractProjectContext(message: string, sourceMessageId?: string): LumiMemoryCandidate[] {
  if (!/\b(project|repo|backend|frontend|api|sqlite|fastapi|airi|lumi)\b|\u9879\u76ee|\u540e\u7aef|\u524d\u7aef|\u63a5\u53e3|\u8fc1\u79fb/i.test(message))
    return []
  if (message.length < 18)
    return []

  return [{
    type: 'project_context',
    content: `Project context: ${message.slice(0, 220)}`,
    sourceMessageId,
    confidence: 0.78,
    importance: 0.72,
    emotionalIntensity: 0,
    relationshipRelevance: 0.35,
    decay: 0,
    tags: ['project'],
    status: 'candidate',
    reason: 'project context likely useful later',
  }]
}

function extractPromise(message: string, sourceMessageId?: string): LumiMemoryCandidate[] {
  if (!/\bremember that\b|\u8bb0\u4f4f|\u522b\u5fd8\u4e86|\u5e2e\u6211\u8bb0/i.test(message))
    return []

  return [{
    type: 'promise',
    content: `User explicitly asked to remember: ${message.slice(0, 220)}`,
    sourceMessageId,
    confidence: 0.86,
    importance: 0.82,
    emotionalIntensity: 0,
    relationshipRelevance: 0.65,
    decay: 0,
    tags: ['explicit_remember'],
    status: 'candidate',
    reason: 'explicit remember request',
  }]
}

function candidate(
  type: LumiMemoryType,
  content: string,
  sourceMessageId: string | undefined,
  reason: string,
  options: {
    emotionalIntensity?: number
    relationshipRelevance?: number
    tags?: string[]
  } = {},
): LumiMemoryCandidate {
  return {
    type,
    content,
    sourceMessageId,
    confidence: 0.88,
    importance: 0.8,
    emotionalIntensity: options.emotionalIntensity ?? 0,
    relationshipRelevance: options.relationshipRelevance ?? 0,
    decay: 0,
    tags: options.tags ?? [],
    status: 'candidate',
    reason,
  }
}

function normalizeFavoriteSubject(subject: string): string {
  if (/\u5b9e\u4f53/.test(subject))
    return 'entity'
  if (/\u5c42\u7ea7|\u5c42/.test(subject))
    return 'level'
  if (/\u89d2\u8272/.test(subject))
    return 'character'
  if (/\u7535\u5f71/.test(subject))
    return 'movie'
  return subject.replace(/\s+/g, ' ').slice(0, 40)
}
