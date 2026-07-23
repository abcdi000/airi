import type {
  LumiMemoryFragment,
  LumiMemoryRetrievalResult,
  LumiMemoryRoute,
  LumiMemorySearchRequest,
  LumiMemoryType,
  LumiRankedMemory,
} from './types'

import { canAccessLumiMemory, isRecallableMemory } from './validation'

export interface LumiRetrievalOptions {
  includeMigratedUsersForLocal?: boolean
  minScore?: number
  vectorMinScore?: number
  vectorEnabled?: boolean
  externalVectorScores?: Record<string, number>
  now?: Date
}

interface VectorMatch {
  memoryId: string
  score: number
}

const MEMORY_VECTOR_CACHE_LIMIT = 5000
const QUERY_VECTOR_CACHE_LIMIT = 300
const memoryVectorCache = new Map<string, { signature: string, vector: number[] }>()
const queryVectorCache = new Map<string, number[]>()

const RELATIONSHIP_TYPES = new Set<LumiMemoryType>(['relationship_event', 'conflict_event'])
const LONG_TERM_TYPES = new Set<LumiMemoryType>([
  'user_preference',
  'user_fact',
  'persona_fact',
  'persona_preference',
  'shared_event',
  'promise',
  'project_context',
  'emotional_echo',
])
const MEMORY_STOPWORDS = new Set([
  'the',
  'user',
  'lumi',
  'doggy',
  'what',
  'which',
  'where',
  'when',
  'why',
  'how',
  'remember',
  'recall',
  '\u4EC0\u4E48',
  '\u54EA\u4E2A',
  '\u54EA\u91CC',
  '\u600E\u4E48',
  '\u4E3A\u4EC0',
  '\u8BB0\u5F97',
  '\u8FD8\u8BB0',
])
const QUERY_STOPWORDS = new Set([
  'favorite',
  '\u559C\u6B22',
  '\u6700\u559C',
  '\u6211\u6700',
  '\u6211\u559C',
  '\u4EC0\u4E48',
  '\u54EA\u4E2A',
  '\u8BB0\u5F97',
  '\u8FD8\u8BB0',
])

export function retrieveLumiMemories(
  fragments: LumiMemoryFragment[],
  request: LumiMemorySearchRequest,
  options: LumiRetrievalOptions = {},
): LumiMemoryRetrievalResult {
  const route = routeLumiMemoryQuery(request.query)
  const vectorEnabled = options.vectorEnabled ?? true
  const minScore = options.minScore ?? 0.18
  const vectorMinScore = options.vectorMinScore ?? 0.35
  const vectorScores: Record<string, number> = {}
  let vectorUsed = false
  let vectorFallback: string | undefined
  let candidates: LumiMemoryFragment[] = []

  const pool = filterSearchPool(fragments, request, {
    includeMigratedUsersForLocal: options.includeMigratedUsersForLocal,
    types: route.preferredTypes,
  })

  if (vectorEnabled) {
    const rawMatches = options.externalVectorScores
      ? searchExternalVectorScores(pool, options.externalVectorScores, 40)
      : searchVectorIndex(pool, request.query, 40)
    const matches = rawMatches.filter(match => match.score >= vectorMinScore)
    if (matches.length) {
      vectorUsed = true
      for (const match of matches)
        vectorScores[match.memoryId] = match.score

      const byId = new Map(pool.map(memory => [memory.id, memory]))
      candidates = matches.map(match => byId.get(match.memoryId)).filter(Boolean) as LumiMemoryFragment[]
      const lexicalCandidates = rankLumiMemories(pool, request.query, {}, options.now)
        .filter(item => item.scoreBreakdown.keywordScore >= 0.12 || item.scoreBreakdown.lexicalScore >= 0.12)
        .slice(0, 20)
        .map(item => item.memory)
      candidates = uniqueMemoryFragments([...candidates, ...lexicalCandidates])
    }
    else {
      vectorFallback = rawMatches.length ? 'low_vector_similarity' : 'no_vector_matches'
    }
  }

  if (!candidates.length)
    candidates = pool.slice(0, 80)

  const ranked = rankLumiMemories(candidates, request.query, vectorScores, options.now)
    .filter(item => item.finalScore >= minScore && isReliableRetrieval(
      item,
      route.queryIntent,
      request.query,
      options.externalVectorScores?.[item.memory.id],
    ))
  const limited = applyIntentLimits(ranked, route.queryIntent).slice(0, request.limit)

  return {
    route,
    rankedMemories: limited,
    vectorUsed,
    vectorSource: vectorEnabled
      ? options.externalVectorScores ? 'external' : 'deterministic'
      : 'disabled',
    vectorFallback,
    vectorScores: Object.fromEntries(limited
      .filter(item => vectorScores[item.memory.id] !== undefined)
      .map(item => [item.memory.id, vectorScores[item.memory.id]])),
  }
}

function searchExternalVectorScores(
  memories: LumiMemoryFragment[],
  scores: Record<string, number>,
  limit: number,
): VectorMatch[] {
  return memories
    .map(memory => ({
      memoryId: memory.id,
      score: scores[memory.id] ?? 0,
    }))
    .filter(match => match.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
}

export function routeLumiMemoryQuery(query: string): LumiMemoryRoute {
  const text = query.toLowerCase()

  if (/birthday|生日|出生日期|纪念日/i.test(text)) {
    return {
      preferredTypes: ['persona_fact', 'user_fact', 'shared_event', 'relationship_event'],
      queryIntent: 'memory_recall',
      reason: 'User is asking about a persona or participant date fact.',
    }
  }

  if (/\u662F\u8C01|\u8C01\u662F|\u53EB\u4EC0\u4E48|\u540D\u5B57|\u5973\u670B\u53CB|\u7537\u670B\u53CB|\u597D\u53CB|\u670B\u53CB|\u5907\u6CE8|\u6635\u79F0|\u7528\u6237\u540D|\u8D26\u53F7|\u8D26\u6237/.test(text)) {
    return {
      preferredTypes: ['persona_fact', 'user_fact', 'user_preference', 'relationship_event', 'shared_event'],
      queryIntent: 'memory_recall',
      reason: 'User is asking for a stored personal relationship or identity fact.',
    }
  }

  if (/\bfavou?rite\b|\blikes?\b|\bprefers?\b|\bdislikes?\b|\bcolou?r\b|最爱|爱好|偏好|喜欢|讨厌/.test(text)) {
    return {
      preferredTypes: ['persona_preference', 'persona_fact', 'user_preference', 'user_fact', 'shared_event'],
      queryIntent: 'memory_recall',
      reason: 'User is asking for a stored persona or participant preference.',
    }
  }

  if (/\b\d{1,2}[-/]\d{1,2}\b|\u53D1\u751F\u4E86\u4EC0\u4E48|\u90A3\u5929|\u9664\u6B64\u4E4B\u5916|\u8FD8\u6709\u5417|\u522B\u7684\u5417|\u5176\u4ED6\u5417/.test(text)) {
    return {
      preferredTypes: ['persona_fact', 'shared_event', 'relationship_event', 'emotional_echo', 'user_fact'],
      queryIntent: 'memory_recall',
      reason: 'User is asking about a dated event or follow-up to recalled events.',
    }
  }

  if (/remember|recall|\u8FD8\u8BB0\u5F97|\u8BB0\u5F97|\u559C\u6B22\u4EC0\u4E48/.test(text)) {
    return {
      preferredTypes: ['persona_fact', 'persona_preference', 'user_preference', 'user_fact', 'shared_event'],
      queryIntent: 'memory_recall',
      reason: 'User is asking for remembered personal context.',
    }
  }

  if (/again|\u53C8\u8FD9\u6837|\u6BCF\u6B21\u90FD|\u521A\u624D|\u751F\u6C14|\u54ED/.test(text)) {
    return {
      preferredTypes: ['conflict_event', 'relationship_event', 'emotional_echo'],
      queryIntent: 'conflict_context',
      reason: 'User references recurring emotional or conflict context.',
    }
  }

  if (/must obey|no boundaries|forget your boundaries|\u6539\u6389|\u5FC5\u987B\u670D\u4ECE|\u6CA1\u6709\u8FB9\u754C|\u5FD8\u6389\u4F60\u7684\u8FB9\u754C/.test(text)) {
    return {
      preferredTypes: ['persona_preference', 'relationship_event'],
      queryIntent: 'boundary_pressure',
      reason: 'User is pressing against persona core or boundaries.',
    }
  }

  if (/project|progress|repo|api|backend|migration|\u9879\u76EE|\u8FDB\u5EA6|\u540E\u7AEF|\u63A5\u53E3|airi|\u8FC1\u79FB/.test(text)) {
    return {
      preferredTypes: ['project_context', 'promise', 'shared_event'],
      queryIntent: 'project_context',
      reason: 'User is asking about ongoing project context.',
    }
  }

  return {
    preferredTypes: ['user_preference', 'shared_event', 'temporary_context'],
    queryIntent: 'casual',
    reason: 'Default casual recall path.',
  }
}

export function rankLumiMemories(
  memories: LumiMemoryFragment[],
  query: string,
  semanticScores: Record<string, number> = {},
  now = new Date(),
): LumiRankedMemory[] {
  return memories
    .map(memory => scoreLumiMemory(memory, query, semanticScores, now))
    .sort((left, right) => right.finalScore - left.finalScore)
}

export function scoreLumiMemory(
  memory: LumiMemoryFragment,
  query: string,
  semanticScores: Record<string, number> = {},
  now = new Date(),
): LumiRankedMemory {
  const lexicalScore = lexicalSemanticScore(query, memory.content, memory.tags)
  const vectorScore = semanticScores[memory.id] ?? lexicalScore
  const semanticScore = semanticScores[memory.id] === undefined
    ? lexicalScore
    : round(0.68 * vectorScore + 0.32 * lexicalScore)
  const keywordScore = keywordOverlapScore(query, memory.content, memory.tags)
  const recencyScore = memoryRecencyScore(memory, now)
  const scoreBreakdown = {
    semanticScore,
    vectorScore,
    lexicalScore,
    keywordScore,
    importance: memory.importance,
    recencyScore,
    emotionalIntensity: memory.emotionalIntensity,
    relationshipRelevance: memory.relationshipRelevance,
    confidence: memory.confidence,
  }
  const finalScore = (
    0.26 * semanticScore
    + 0.22 * keywordScore
    + 0.17 * memory.importance
    + 0.13 * recencyScore
    + 0.12 * memory.emotionalIntensity
    + 0.07 * memory.relationshipRelevance
    + 0.03 * memory.confidence
  )

  return {
    memory,
    finalScore: round(finalScore),
    scoreBreakdown: Object.fromEntries(
      Object.entries(scoreBreakdown).map(([key, value]) => [key, round(value)]),
    ) as LumiRankedMemory['scoreBreakdown'],
  }
}

function filterSearchPool(
  fragments: LumiMemoryFragment[],
  request: LumiMemorySearchRequest,
  options: { includeMigratedUsersForLocal?: boolean, types: LumiMemoryType[] },
): LumiMemoryFragment[] {
  const includeMigratedUsers = options.includeMigratedUsersForLocal && request.userId === 'local'
  const requestTypes = request.types?.length ? request.types : options.types

  return fragments
    .filter(fragment => fragment.personaId === request.personaId)
    .filter(fragment => includeMigratedUsers || canAccessLumiMemory(fragment, request))
    .filter(fragment => fragment.status === 'active' && isRecallableMemory(fragment))
    .filter(fragment => !requestTypes.length || requestTypes.includes(fragment.type))
    .sort((left, right) => (right.updatedAt || '').localeCompare(left.updatedAt || ''))
}

function searchVectorIndex(memories: LumiMemoryFragment[], query: string, limit: number): VectorMatch[] {
  const queryVector = getCachedQueryEmbedding(query)
  return memories
    .map(memory => ({
      memoryId: memory.id,
      score: cosineSimilarity(queryVector, getCachedMemoryEmbedding(memory)),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
}

function uniqueMemoryFragments(memories: LumiMemoryFragment[]): LumiMemoryFragment[] {
  const seen = new Set<string>()
  const unique: LumiMemoryFragment[] = []
  for (const memory of memories) {
    if (seen.has(memory.id))
      continue
    seen.add(memory.id)
    unique.push(memory)
  }
  return unique
}

function deterministicEmbedding(text: string, dimensions = 64): number[] {
  const vector = new Array<number>(dimensions).fill(0)
  for (const token of tokenize(text)) {
    const index = fnv1a(token) % dimensions
    vector[index] += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map(value => value / norm)
}

function getCachedQueryEmbedding(query: string): number[] {
  const key = normalizeEmbeddingText(query)
  const cached = queryVectorCache.get(key)
  if (cached)
    return cached

  const vector = deterministicEmbedding(key)
  queryVectorCache.set(key, vector)
  pruneMap(queryVectorCache, QUERY_VECTOR_CACHE_LIMIT)
  return vector
}

function getCachedMemoryEmbedding(memory: LumiMemoryFragment): number[] {
  const signature = [
    memory.updatedAt,
    memory.type,
    memory.tags.join('\u001F'),
    memory.content,
  ].join('\u001E')
  const cached = memoryVectorCache.get(memory.id)
  if (cached?.signature === signature)
    return cached.vector

  const vector = deterministicEmbedding(normalizeEmbeddingText(`${memory.type} ${memory.tags.join(' ')} ${memory.content}`))
  memoryVectorCache.set(memory.id, { signature, vector })
  pruneMap(memoryVectorCache, MEMORY_VECTOR_CACHE_LIMIT)
  return vector
}

function normalizeEmbeddingText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

function pruneMap<TKey, TValue>(map: Map<TKey, TValue>, limit: number) {
  while (map.size > limit) {
    const firstKey = map.keys().next().value
    if (firstKey === undefined)
      return
    map.delete(firstKey)
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0
  for (let index = 0; index < Math.min(left.length, right.length); index += 1)
    dot += left[index] * right[index]
  return Math.max(0, Math.min(1, dot))
}

function lexicalSemanticScore(query: string, content: string, tags: string[]): number {
  const queryTerms = meaningfulTokens(query)
  const memoryTerms = new Set([...meaningfulTokens(content), ...tags.flatMap(tag => [...meaningfulTokens(tag)])])
  if (!queryTerms.size || !memoryTerms.size)
    return 0

  let overlap = 0
  for (const term of queryTerms) {
    if (memoryTerms.has(term))
      overlap += 1
  }
  return Math.min(1, overlap / Math.max(3, queryTerms.size))
}

function keywordOverlapScore(query: string, content: string, tags: string[]): number {
  const queryTerms = specificMemoryTerms(query)
  if (!queryTerms.size)
    return lexicalSemanticScore(query, content, tags)

  const memoryTerms = new Set([...meaningfulTokens(content), ...tags.flatMap(tag => [...meaningfulTokens(tag)])])
  let overlap = 0
  for (const term of queryTerms) {
    if (memoryTerms.has(term))
      overlap += 1
  }

  return Math.min(1, overlap / Math.max(2, queryTerms.size))
}

function isReliableRetrieval(
  item: LumiRankedMemory,
  intent: LumiMemoryRoute['queryIntent'],
  query: string,
  externalVectorScore?: number,
): boolean {
  if (!matchesContextDependentEvidenceMarkers(item.memory, query))
    return false

  const specificTerms = specificMemoryTerms(query)
  if (!specificTerms.size)
    return true

  if (externalVectorScore !== undefined && externalVectorScore >= 0.48)
    return true

  if (intent === 'memory_recall' || intent === 'project_context') {
    return item.scoreBreakdown.keywordScore >= 0.12
      || item.scoreBreakdown.lexicalScore >= 0.12
  }

  return item.scoreBreakdown.keywordScore >= 0.08
    || item.scoreBreakdown.lexicalScore >= 0.08
    || item.finalScore >= 0.55
}

function matchesContextDependentEvidenceMarkers(memory: LumiMemoryFragment, query: string): boolean {
  const markers = contextDependentEvidenceMarkers(query)
  if (!markers.specific.length && !markers.topic.length)
    return true

  const haystack = `${memory.type} ${memory.tags.join(' ')} ${memory.content}`.toLowerCase()
  const matchesSpecific = !markers.specific.length
    || markers.specific.some(marker => haystack.includes(marker))
  const matchesTopic = !markers.topic.length
    || markers.topic.some(marker => haystack.includes(marker))
  return matchesSpecific && matchesTopic
}

function contextDependentEvidenceMarkers(query: string) {
  const text = query.toLowerCase()
  const specific: string[] = []
  const topic: string[] = []

  const addSpecific = (...markers: string[]) => {
    for (const marker of markers)
      specific.push(marker.toLowerCase())
  }
  const addTopic = (...markers: string[]) => {
    for (const marker of markers)
      topic.push(marker.toLowerCase())
  }

  if (/\bentities?\b|\u5B9E\u4F53/.test(text))
    addSpecific('entity', '\u5B9E\u4F53')
  if (/\blevels?\b|\u5C42\u7EA7|\u5C42/.test(text))
    addSpecific('level', '\u5C42\u7EA7', '\u5C42')
  if (/\bcharacters?\b|\u89D2\u8272/.test(text))
    addSpecific('character', '\u89D2\u8272')
  if (/\bmovies?\b|\bfilms?\b|\u7535\u5F71/.test(text))
    addSpecific('movie', 'film', '\u7535\u5F71')
  if (/\bgames?\b|\u6E38\u620F/.test(text))
    addSpecific('game', '\u6E38\u620F')
  if (/\bitems?\b|\u7269\u54C1|\u9053\u5177/.test(text))
    addSpecific('item', '\u7269\u54C1', '\u9053\u5177')
  if (/\bplaces?\b|\blocations?\b|\u5730\u65B9|\u54EA\u91CC/.test(text))
    addSpecific('place', 'location', '\u5730\u65B9')

  if (/\bbackrooms?\b|\u540E\u5BA4/.test(text))
    addTopic('backrooms', '\u540E\u5BA4')
  if (/\bscp\b/.test(text))
    addTopic('scp')
  if (/\bminecraft\b|\u6211\u7684\u4E16\u754C/.test(text))
    addTopic('minecraft', '\u6211\u7684\u4E16\u754C')

  return {
    specific: [...new Set(specific)],
    topic: [...new Set(topic)],
  }
}

function tokenize(text: string): Set<string> {
  const normalized = text.toLowerCase()
  const tokens = new Set<string>()
  for (const match of normalized.match(/[a-z0-9_]+/g) ?? []) {
    if (match.length > 1)
      tokens.add(match)
  }

  const cjkChars = normalized.match(/[\u3400-\u9FFF]/gu) ?? []
  for (let index = 0; index < cjkChars.length; index += 1) {
    tokens.add(cjkChars[index])
    if (index + 1 < cjkChars.length)
      tokens.add(`${cjkChars[index]}${cjkChars[index + 1]}`)
  }

  return tokens
}

function meaningfulTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  const normalized = text.toLowerCase()
  for (const match of normalized.match(/[a-z0-9_]{2,}/g) ?? []) {
    if (!MEMORY_STOPWORDS.has(match))
      tokens.add(match)
  }

  const cjkChars = normalized.match(/[\u3400-\u9FFF]/gu) ?? []
  for (let index = 0; index < cjkChars.length - 1; index += 1) {
    const bigram = `${cjkChars[index]}${cjkChars[index + 1]}`
    if (!MEMORY_STOPWORDS.has(bigram))
      tokens.add(bigram)
  }

  addSynonymTokens(normalized, tokens)
  return tokens
}

function specificMemoryTerms(text: string): Set<string> {
  const terms = meaningfulTokens(text)
  for (const stopword of QUERY_STOPWORDS)
    terms.delete(stopword)
  return terms
}

function addSynonymTokens(text: string, tokens: Set<string>) {
  if (/\u540E\u5BA4|\bbackrooms?\b/.test(text)) {
    tokens.add('backrooms')
    tokens.add('\u540E\u5BA4')
  }
  if (/\u5B9E\u4F53|\bentities?\b/.test(text)) {
    tokens.add('entity')
    tokens.add('\u5B9E\u4F53')
  }
  if (/\u5C42\u7EA7|\u5C42|\blevels?\b/.test(text)) {
    tokens.add('level')
    tokens.add('\u5C42\u7EA7')
  }
  if (/\u559C\u6B22|\u6700\u559C\u6B22|\bfavou?rites?\b|\blikes?\b/.test(text)) {
    tokens.add('favorite')
    tokens.add('\u559C\u6B22')
  }
  if (/\u7535\u5F71|\bmovies?\b|\bfilms?\b/.test(text)) {
    tokens.add('movie')
    tokens.add('\u7535\u5F71')
  }
  if (/\u89D2\u8272|\bcharacters?\b/.test(text)) {
    tokens.add('character')
    tokens.add('\u89D2\u8272')
  }
}

function memoryRecencyScore(memory: LumiMemoryFragment, now: Date): number {
  const anchor = Date.parse(memory.lastUsedAt || memory.updatedAt || memory.createdAt)
  if (!Number.isFinite(anchor))
    return 0.1

  const ageDays = Math.max(0, (now.getTime() - anchor) / 86_400_000)
  if (ageDays <= 1)
    return 1
  if (ageDays <= 7)
    return 0.75
  if (ageDays <= 30)
    return 0.45
  if (ageDays <= 90)
    return 0.25
  return 0.1
}

function applyIntentLimits(ranked: LumiRankedMemory[], intent: LumiMemoryRoute['queryIntent']): LumiRankedMemory[] {
  const selected: LumiRankedMemory[] = []
  const counts = { temporary: 0, relationship: 0, longTerm: 0 }
  const totalLimit = totalLimitForIntent(intent)
  const longTermLimit = longTermLimitForIntent(intent)
  const relationshipLimit = relationshipLimitForIntent(intent)

  for (const item of ranked) {
    if (selected.length >= totalLimit)
      break

    const type = item.memory.type
    if (type === 'temporary_context' && counts.temporary >= 2)
      continue
    if (RELATIONSHIP_TYPES.has(type) && counts.relationship >= relationshipLimit)
      continue
    if (LONG_TERM_TYPES.has(type) && counts.longTerm >= longTermLimit)
      continue

    selected.push(item)
    if (type === 'temporary_context')
      counts.temporary += 1
    else if (RELATIONSHIP_TYPES.has(type))
      counts.relationship += 1
    else
      counts.longTerm += 1
  }
  return selected
}

function totalLimitForIntent(intent: LumiMemoryRoute['queryIntent']): number {
  if (intent === 'casual')
    return 2
  if (intent === 'conflict_context' || intent === 'boundary_pressure')
    return 4
  if (intent === 'memory_recall' || intent === 'project_context')
    return 8
  return 3
}

function longTermLimitForIntent(intent: LumiMemoryRoute['queryIntent']): number {
  if (intent === 'casual')
    return 2
  if (intent === 'project_context' || intent === 'memory_recall')
    return 5
  return 3
}

function relationshipLimitForIntent(intent: LumiMemoryRoute['queryIntent']): number {
  if (intent === 'conflict_context')
    return 3
  if (intent === 'casual')
    return 1
  return 2
}

function fnv1a(value: string): number {
  let hash = 0x811C9DC5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
