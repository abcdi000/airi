import type { LumiMemoryCandidate, LumiMemoryType } from './types'

const LOW_VALUE_PATTERNS = new Set([
  'hi',
  'hello',
  'hey',
  'thanks',
  'ok',
  '\u597D\u7684',
  '\u8C22\u8C22',
  '\u55EF',
  '\u65E0\u804A',
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
    ...extractPersonaFacts(stripped, options.sourceMessageId),
    ...extractUserPreferences(stripped, options.sourceMessageId),
    ...extractUserFacts(stripped, options.sourceMessageId),
    ...extractProjectContext(stripped, options.sourceMessageId),
    ...extractPromise(stripped, options.sourceMessageId),
  ]
}

function extractPersonaFacts(message: string, sourceMessageId?: string): LumiMemoryCandidate[] {
  const patterns = [
    /Lumi\s*的生日(?:是|为)\s*(\d{1,2}\s*月\s*\d{1,2}\s*日)/gi,
    /你的生日(?:是|为)\s*(\d{1,2}\s*月\s*\d{1,2}\s*日)/g,
  ]
  return patterns.flatMap(pattern => [...message.matchAll(pattern)].map(match => ({
    ...candidate('persona_fact', `Lumi 的生日是${match[1].replace(/\s+/g, '')}。`, sourceMessageId, 'explicit Lumi self fact', {
      relationshipRelevance: 0.35,
      tags: ['lumi_self', 'birthday'],
    }),
    scope: 'global' as const,
    visibility: 'global' as const,
    subjectUserIds: ['lumi'],
    sensitivity: 'normal' as const,
  })))
}

function extractUserPreferences(message: string, sourceMessageId?: string): LumiMemoryCandidate[] {
  if (/[?\uFF1F]$/.test(message))
    return []

  const contextualFavorites = [...message.matchAll(/\u6211\u6700\u559C\u6B22\u7684([^=\uFF1D:：\u662F\u3002\uFF01\uFF1F]{1,20})[\u662F=\uFF1D:：]\s*([^.\u3002\uFF01\uFF1F]{1,80})/g)]
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
    [/\bI (?:really )?like ([^.\u3002\uFF01\uFF1F]{2,80})/gi, 'The user likes {value}.', 'user_preference', ['preference']],
    [/\bI (?:really )?(?:dislike|hate) ([^.\u3002\uFF01\uFF1F]{2,80})/gi, 'The user dislikes {value}.', 'user_preference', ['preference']],
    [/\u6211(?:\u5F88|\u975E\u5E38|\u771F\u7684|\u6700)?\u559C\u6B22(?!\u7684)([^.\u3002\uFF01\uFF1F]{2,80})/g, 'The user likes {value}.', 'user_preference', ['preference']],
    [/\u6211(?:\u4E0D\u559C\u6B22|\u8BA8\u538C)([^.\u3002\uFF01\uFF1F]{2,80})/g, 'The user dislikes {value}.', 'user_preference', ['preference']],
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
    [/\bmy name is ([A-Z][\w -]{1,60})/gi, 'The user\'s name is {value}.', 'user_fact', ['fact']],
    [/\bI live in ([^.\u3002\uFF01\uFF1F]{2,80})/gi, 'The user lives in {value}.', 'user_fact', ['fact']],
    [/\u6211\u53EB([^.\u3002\uFF01\uFF1F]{1,40})/g, 'The user\'s name is {value}.', 'user_fact', ['fact']],
    [/\u6211\u4F4F\u5728([^.\u3002\uFF01\uFF1F]{2,80})/g, 'The user lives in {value}.', 'user_fact', ['fact']],
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
  if (!/\b(?:project|repo|backend|frontend|api|sqlite|fastapi|airi|lumi)\b|\u9879\u76EE|\u540E\u7AEF|\u524D\u7AEF|\u63A5\u53E3|\u8FC1\u79FB/i.test(message))
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
  if (!/\bremember that\b|\u8BB0\u4F4F|\u522B\u5FD8\u4E86|\u5E2E\u6211\u8BB0/i.test(message))
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
  if (/\u5B9E\u4F53/.test(subject))
    return 'entity'
  if (/\u5C42\u7EA7|\u5C42/.test(subject))
    return 'level'
  if (/\u89D2\u8272/.test(subject))
    return 'character'
  if (/\u7535\u5F71/.test(subject))
    return 'movie'
  return subject.replace(/\s+/g, ' ').slice(0, 40)
}
