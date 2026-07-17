import type {
  LumiMemoryDriver,
  LumiMemoryFragment,
  LumiMemorySearchRequest,
  LumiMemoryStatus,
} from './types'

import { isRecallableMemory, normalizeMemoryScores } from './validation'

export interface StaticLumiMemoryDriverOptions {
  /**
   * Allows migrated local AIRI chats to read memories that were created under
   * Lumi's older test/user ids.
   */
  includeMigratedUsersForLocal?: boolean
}

const defaultStatuses: LumiMemoryStatus[] = ['active']

export function createStaticLumiMemoryDriver(
  fragments: LumiMemoryFragment[],
  options: StaticLumiMemoryDriverOptions = {},
): LumiMemoryDriver {
  const memories = new Map<string, LumiMemoryFragment>(
    fragments.map(fragment => [fragment.id, normalizeMemoryScores(fragment)]),
  )

  return {
    async search(request) {
      return searchStaticLumiMemories([...memories.values()], request, options)
    },
    async remember(fragment) {
      const normalized = normalizeMemoryScores(fragment)
      memories.set(normalized.id, normalized)
      return normalized
    },
    async update(memoryId, patch) {
      const existing = memories.get(memoryId)
      if (!existing)
        throw new Error(`Lumi memory not found: ${memoryId}`)

      const updated = normalizeMemoryScores({ ...existing, ...patch, id: memoryId })
      memories.set(memoryId, updated)
      return updated
    },
    async forget(memoryId) {
      const existing = memories.get(memoryId)
      if (!existing)
        throw new Error(`Lumi memory not found: ${memoryId}`)

      const updated = { ...existing, status: 'archived' as const }
      memories.set(memoryId, updated)
      return updated
    },
    async reindex() {},
  }
}

export function searchStaticLumiMemories(
  fragments: LumiMemoryFragment[],
  request: LumiMemorySearchRequest,
  options: StaticLumiMemoryDriverOptions = {},
): LumiMemoryFragment[] {
  const statuses = request.statuses?.length ? request.statuses : defaultStatuses
  const queryTerms = tokenize(request.query)
  const includeMigratedUsers = options.includeMigratedUsersForLocal && request.userId === 'local'
  const seenContents = new Set<string>()

  return fragments
    .filter(fragment => fragment.personaId === request.personaId)
    .filter(fragment => includeMigratedUsers || fragment.userId === request.userId)
    .filter(fragment => statuses.includes(fragment.status))
    .filter(fragment => !request.types?.length || request.types.includes(fragment.type))
    .filter(fragment => fragment.status === 'active' ? isRecallableMemory(fragment) : fragment.content.trim().length > 0)
    .map(fragment => ({
      fragment,
      score: scoreMemory(fragment, queryTerms, request.userId),
    }))
    .sort((left, right) => right.score - left.score)
    .map(({ fragment }) => fragment)
    .filter((fragment) => {
      const key = fragment.content.trim().toLowerCase()
      if (seenContents.has(key))
        return false
      seenContents.add(key)
      return true
    })
    .slice(0, Math.max(0, request.limit))
}

function scoreMemory(fragment: LumiMemoryFragment, queryTerms: Set<string>, requestedUserId: string): number {
  const contentTerms = tokenize(`${fragment.type} ${fragment.tags.join(' ')} ${fragment.content}`)
  let overlap = 0
  for (const term of queryTerms) {
    if (contentTerms.has(term))
      overlap += 1
  }

  const lexicalScore = queryTerms.size > 0 ? overlap / queryTerms.size : 0
  const userScore = fragment.userId === requestedUserId ? 0.2 : 0
  const recencyScore = fragment.lastUsedAt ? 0.05 : 0

  return (
    lexicalScore * 0.45
    + fragment.importance * 0.25
    + fragment.relationshipRelevance * 0.15
    + fragment.confidence * 0.1
    + recencyScore
    + userScore
  )
}

function tokenize(value: string): Set<string> {
  const matches = value.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
  return new Set(matches.filter(term => term.length > 1))
}
