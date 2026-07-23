import type { LumiMemoryFragment, LumiMemorySearchRequest } from './types'

import { describe, expect, it } from 'vitest'

import { parseLumiMemoryCuratorOutput } from './memory-curator'
import { extractLumiMemoryCandidates } from './memory-extractor'
import { retrieveLumiMemories } from './memory-retrieval'
import { canAccessLumiMemory, canInspectLumiMemory, normalizeMemoryScores } from './validation'

const DOGGY = 'lumi-user-doggy'
const MOUSSY = 'lumi-user-moussy'

function memory(patch: Partial<LumiMemoryFragment>): LumiMemoryFragment {
  return normalizeMemoryScores({
    id: 'memory-fixture',
    userId: DOGGY,
    personaId: 'lumi',
    type: 'user_fact',
    content: 'fixture memory',
    confidence: 0.95,
    importance: 0.95,
    emotionalIntensity: 0.2,
    relationshipRelevance: 0.8,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    decay: 0,
    tags: ['fixture'],
    status: 'active',
    ...patch,
  })
}

function request(userId: string, patch: Partial<LumiMemorySearchRequest> = {}): LumiMemorySearchRequest {
  return {
    query: 'Lumi birthday May 13',
    userId,
    viewerUserId: userId,
    personaId: 'lumi',
    limit: 10,
    conversationType: 'direct',
    ...patch,
  }
}

describe('lumi memory access policy', () => {
  it('makes Lumi-owned global facts visible to every user', () => {
    const birthday = memory({
      id: 'lumi-birthday',
      type: 'persona_fact',
      content: 'Lumi birthday is May 13.',
      scope: 'global',
      ownerType: 'lumi',
      ownerId: 'lumi',
      visibility: 'global',
      participantUserIds: [],
      subjectUserIds: ['lumi'],
    })

    expect(canAccessLumiMemory(birthday, request(DOGGY))).toBe(true)
    expect(canAccessLumiMemory(birthday, request(MOUSSY))).toBe(true)
    expect(retrieveLumiMemories([birthday], request(MOUSSY)).rankedMemories[0]?.memory.id).toBe('lumi-birthday')
  })

  it('routes Lumi self preferences to persona memory instead of project context', () => {
    const preference = memory({
      id: 'lumi-favorite-color',
      type: 'persona_preference',
      content: 'Lumi\'s favorite color is cyan.',
      scope: 'global',
      ownerType: 'lumi',
      ownerId: 'lumi',
      visibility: 'global',
      participantUserIds: [],
      subjectUserIds: ['lumi'],
      tags: ['lumi_self', 'preference'],
    })

    const result = retrieveLumiMemories([preference], request(MOUSSY, { query: 'Lumi favorite color cyan' }))

    expect(result.route.queryIntent).toBe('memory_recall')
    expect(result.route.preferredTypes).toContain('persona_preference')
    expect(result.rankedMemories[0]?.memory.id).toBe('lumi-favorite-color')
  })

  it('keeps relationship and private memories away from other users', () => {
    const doggyRelationship = memory({ ownerId: DOGGY, participantUserIds: [DOGGY] })
    const doggyPrivate = memory({
      id: 'doggy-private',
      scope: 'private',
      visibility: 'private',
      sensitivity: 'private',
      ownerId: DOGGY,
      participantUserIds: [DOGGY],
    })

    expect(canAccessLumiMemory(doggyRelationship, request(DOGGY))).toBe(true)
    expect(canAccessLumiMemory(doggyRelationship, request(MOUSSY))).toBe(false)
    expect(canAccessLumiMemory(doggyPrivate, request(DOGGY))).toBe(true)
    expect(canAccessLumiMemory(doggyPrivate, request(MOUSSY))).toBe(false)
  })

  it('shares ordinary user-owned events while keeping private sensitivity closed', () => {
    const dailyEvent = memory({
      id: 'doggy-shareable-day',
      type: 'shared_event',
      content: 'Doggy felt happy after finishing a difficult feature.',
      scope: 'shared',
      ownerType: 'user',
      ownerId: DOGGY,
      visibility: 'shared',
      participantUserIds: [],
      sensitivity: 'normal',
    })
    const mislabeledPrivate = memory({
      ...dailyEvent,
      id: 'doggy-private-day',
      sensitivity: 'private',
    })

    expect(canAccessLumiMemory(dailyEvent, request(DOGGY))).toBe(true)
    expect(canAccessLumiMemory(dailyEvent, request(MOUSSY))).toBe(true)
    expect(canAccessLumiMemory(mislabeledPrivate, request(MOUSSY))).toBe(false)
  })

  it('allows only group participants to retrieve a group memory', () => {
    const group = memory({
      id: 'doggy-moussy-game',
      scope: 'group',
      ownerType: 'group',
      ownerId: 'conversation-doggy-moussy',
      visibility: 'participants',
      participantUserIds: [DOGGY, MOUSSY],
    })

    expect(canAccessLumiMemory(group, request(DOGGY, { conversationType: 'group', conversationId: 'conversation-doggy-moussy' }))).toBe(true)
    expect(canAccessLumiMemory(group, request(MOUSSY, { conversationType: 'group', conversationId: 'conversation-doggy-moussy' }))).toBe(true)
    expect(canAccessLumiMemory(group, request('lumi-user-stranger', { conversationType: 'group', conversationId: 'conversation-doggy-moussy' }))).toBe(false)
    expect(canAccessLumiMemory(group, request(DOGGY))).toBe(false)
    expect(canAccessLumiMemory(group, request(DOGGY, {
      conversationType: 'group',
      conversationId: 'another-conversation',
      participantUserIds: [DOGGY, MOUSSY],
    }))).toBe(false)
  })

  it('does not disclose direct relationship or private memories inside a group turn', () => {
    const doggyRelationship = memory({
      id: 'doggy-direct-relationship',
      scope: 'relationship',
      ownerId: DOGGY,
      participantUserIds: [DOGGY],
    })
    const doggyPrivate = memory({
      id: 'doggy-direct-private',
      scope: 'private',
      visibility: 'private',
      sensitivity: 'private',
      ownerId: DOGGY,
      participantUserIds: [DOGGY],
    })
    const groupRequest = request(DOGGY, {
      conversationType: 'group',
      conversationId: 'conversation-doggy-moussy',
      participantUserIds: [DOGGY, MOUSSY],
    })

    expect(canAccessLumiMemory(doggyRelationship, groupRequest)).toBe(false)
    expect(canAccessLumiMemory(doggyPrivate, groupRequest)).toBe(false)
  })

  it('keeps another user shared memory out of the raw inspector while retaining model access', () => {
    const doggyShared = memory({
      id: 'doggy-shareable-experience',
      type: 'shared_event',
      scope: 'shared',
      visibility: 'shared',
      ownerId: DOGGY,
      participantUserIds: [],
      sensitivity: 'normal',
    })

    expect(canAccessLumiMemory(doggyShared, request(MOUSSY))).toBe(true)
    expect(canInspectLumiMemory(doggyShared, MOUSSY)).toBe(false)
    expect(canInspectLumiMemory(doggyShared, DOGGY)).toBe(true)
  })

  it('extracts an explicit Lumi birthday as a global persona fact', () => {
    const [candidate] = extractLumiMemoryCandidates('Lumi 的生日是 5 月 13 日。', { sourceMessageId: 'birthday-source' })

    expect(candidate).toMatchObject({
      type: 'persona_fact',
      content: 'Lumi 的生日是5月13日。',
      scope: 'global',
      visibility: 'global',
      sensitivity: 'normal',
      tags: expect.arrayContaining(['lumi_self', 'birthday']),
    })
  })

  it('requires explicit Lumi ownership before accepting a curator memory as global', () => {
    const [unsafeCandidate] = parseLumiMemoryCuratorOutput(JSON.stringify({
      memories: [{
        should_store: true,
        type: 'persona_fact',
        scope: 'global',
        visibility: 'global',
        content: 'Doggy 的生日是5月1日。',
        confidence: 0.95,
        importance: 0.9,
        tags: ['birthday'],
      }],
    }))
    const [lumiCandidate] = parseLumiMemoryCuratorOutput(JSON.stringify({
      memories: [{
        should_store: true,
        type: 'persona_fact',
        scope: 'global',
        visibility: 'global',
        content: 'Lumi 的生日是5月13日。',
        confidence: 0.95,
        importance: 0.9,
        tags: ['lumi_self', 'birthday'],
      }],
    }))

    expect(unsafeCandidate.scope).toBe('relationship')
    expect(unsafeCandidate.visibility).toBe('participants')
    expect(lumiCandidate.scope).toBe('global')
    expect(lumiCandidate.visibility).toBe('global')
  })

  it('accepts shared scope only for non-private daily events or emotional echoes', () => {
    const parse = (type: string, sensitivity = 'normal') => parseLumiMemoryCuratorOutput(JSON.stringify({
      memories: [{
        should_store: true,
        type,
        scope: 'shared',
        visibility: 'shared',
        sensitivity,
        content: 'Doggy had a cheerful afternoon after completing the Lumi update.',
        confidence: 0.9,
        importance: 0.8,
        tags: ['daily'],
      }],
    }))[0]

    expect(parse('shared_event')).toMatchObject({ scope: 'shared', visibility: 'shared' })
    expect(parse('emotional_echo')).toMatchObject({ scope: 'shared', visibility: 'shared' })
    expect(parse('user_fact').scope).toBe('relationship')
    expect(parse('shared_event', 'private')).toMatchObject({ scope: 'relationship', visibility: 'private', sensitivity: 'private' })
  })
})
