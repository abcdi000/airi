import type { LumiMemoryCandidate, LumiMemoryFragment, LumiMemoryType } from '../../../lumi-runtime/src'
import type { LumiMemoryPersistenceBridge, LumiMemoryPersistenceSnapshot } from './lumi-memory'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LUMI_DOGGY_USER_ID, LUMI_MOUSSY_USER_ID, useLumiIdentityStore } from './lumi-identity'
import { useLumiMemoryStore } from './lumi-memory'

describe('lumi-memory multi-user visibility', () => {
  beforeEach(async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size
      },
    })
    setActivePinia(createPinia())
    const now = '2026-07-21T00:00:00.000Z'
    const identity = useLumiIdentityStore()
    const snapshot = {
      users: [
        { id: LUMI_DOGGY_USER_ID, displayName: 'Doggy', preferredAddress: 'Doggy', role: 'owner' as const, status: 'active' as const, createdAt: now, updatedAt: now },
        { id: LUMI_MOUSSY_USER_ID, displayName: 'Moussy', preferredAddress: 'Moussy', role: 'member' as const, status: 'active' as const, createdAt: now, updatedAt: now },
      ],
      externalIdentities: [],
      activeUserId: LUMI_DOGGY_USER_ID,
      migrationVersion: 'multi-user-v1',
    }
    identity.setBridge({
      getSnapshot: async () => snapshot,
      createUser: async () => snapshot,
      updateUser: async () => snapshot,
      setActiveUser: async () => snapshot,
      linkExternalIdentity: async () => snapshot,
      replaceSnapshot: async value => value,
    })
    await identity.initialize()
  })

  it('shares global Lumi facts while isolating relationship memories in both directions', async () => {
    const snapshots = new Map<string, LumiMemoryPersistenceSnapshot>([
      [LUMI_DOGGY_USER_ID, emptySnapshot()],
      [LUMI_MOUSSY_USER_ID, emptySnapshot()],
    ])
    const bridge = createBridge(snapshots)
    const store = useLumiMemoryStore()
    store.setPersistenceBridge(bridge)
    await store.initializePersistence()
    await store.ensureUserMemoryLoaded(LUMI_MOUSSY_USER_ID)

    store.rememberCandidates([candidate('Lumi birthday is July 21', 'global')], {
      userId: LUMI_DOGGY_USER_ID,
      personaId: 'lumi',
      scope: 'global',
    })
    store.rememberCandidates([candidate('Doggy private project codename is Aurora', 'relationship')], {
      userId: LUMI_DOGGY_USER_ID,
      participantUserIds: [LUMI_DOGGY_USER_ID],
    })
    store.rememberCandidates([candidate('Doggy felt proud after completing the Lumi update', 'shared')], {
      userId: LUMI_DOGGY_USER_ID,
      scope: 'shared',
    })
    await store.rememberCandidatesForUser(
      LUMI_MOUSSY_USER_ID,
      [candidate('Moussy private surprise plan is Moonlight', 'relationship')],
      { participantUserIds: [LUMI_MOUSSY_USER_ID] },
    )

    expect(memoryTexts(store.retrieve(request('Lumi birthday July 21', LUMI_MOUSSY_USER_ID)))).toContain('Lumi birthday is July 21')
    expect(memoryTexts(store.retrieve(request('Doggy proud Lumi update', LUMI_MOUSSY_USER_ID)))).toContain('Doggy felt proud after completing the Lumi update')
    expect(memoryTexts(store.retrieve(request('Aurora project codename', LUMI_MOUSSY_USER_ID)))).not.toContain('Doggy private project codename is Aurora')
    expect(memoryTexts(store.retrieve(request('Moonlight surprise plan', LUMI_DOGGY_USER_ID)))).not.toContain('Moussy private surprise plan is Moonlight')

    const moussyGlobal = await store.rememberCandidatesForUser(
      LUMI_MOUSSY_USER_ID,
      [candidate('Lumi\'s favorite shared festival is Star Night', 'global')],
      { personaId: 'lumi', scope: 'global' },
    )
    expect(moussyGlobal).toEqual([
      expect.objectContaining({
        content: 'Lumi\'s favorite shared festival is Star Night',
        scope: 'global',
        sourceActorId: LUMI_MOUSSY_USER_ID,
        sourceConversationType: 'manual',
        classificationReason: expect.stringContaining('Lumi self fact'),
        disclosureReason: expect.stringContaining('every authorized conversation'),
      }),
    ])
    expect(memoryTexts(store.retrieve(request('Lumi birthday festival Star Night', LUMI_DOGGY_USER_ID)))).toContain('Lumi\'s favorite shared festival is Star Night')

    const moussyShared = await store.rememberCandidatesForUser(
      LUMI_MOUSSY_USER_ID,
      [candidate('Moussy felt cheerful after playing a game together', 'shared')],
      { scope: 'shared' },
    )
    expect(moussyShared).toEqual([
      expect.objectContaining({
        content: 'Moussy felt cheerful after playing a game together',
        scope: 'shared',
        ownerId: LUMI_MOUSSY_USER_ID,
        participantUserIds: [],
      }),
    ])
    expect(memoryTexts(store.retrieve(request('Moussy cheerful game together', LUMI_DOGGY_USER_ID)))).toContain('Moussy felt cheerful after playing a game together')
    expect(store.inspectableMemories.map(memory => memory.id)).not.toContain(moussyShared[0].id)
    expect(store.updateMemory(moussyShared[0].id, { content: 'Doggy must not overwrite this' })).toBe(false)
    expect(store.deleteMemory(moussyShared[0].id)).toBe(false)
  })

  it('promotes only reviewed legacy self facts and shareable events across loaded users', async () => {
    const snapshots = new Map<string, LumiMemoryPersistenceSnapshot>([
      [LUMI_DOGGY_USER_ID, emptySnapshot()],
      [LUMI_MOUSSY_USER_ID, emptySnapshot()],
    ])
    const store = useLumiMemoryStore()
    store.setPersistenceBridge(createBridge(snapshots))
    await store.initializePersistence()
    await store.ensureUserMemoryLoaded(LUMI_MOUSSY_USER_ID)

    store.remember(historicalMemory('legacy-lumi-name', 'persona_preference', 'Lumi\'s favorite color is cyan.', ['lumi_self']))
    store.remember(historicalMemory('legacy-daily-event', 'shared_event', 'Doggy felt relieved after finishing the release.', ['daily_event']))
    store.remember(historicalMemory('legacy-user-fact', 'user_fact', 'Doggy uses Windows.', ['user_fact']))
    store.remember({
      ...historicalMemory('legacy-private-event', 'shared_event', 'Doggy asked Lumi to keep this event secret.', ['private']),
      scope: 'private',
      visibility: 'private',
      sensitivity: 'private',
    })
    store.remember({
      ...historicalMemory('legacy-group-event', 'shared_event', 'A group-only game result.', ['group_event']),
      conversationId: 'doggy-moussy-room',
      sourceConversationType: 'group',
      participantUserIds: [LUMI_DOGGY_USER_ID, LUMI_MOUSSY_USER_ID],
    })

    expect(store.promotionCandidates.map(candidate => candidate.memory.id)).toEqual([
      'legacy-daily-event',
      'legacy-lumi-name',
    ])
    expect(store.promoteMemoryScopes(store.promotionCandidates.map(candidate => candidate.memory.id))).toBe(2)
    expect(store.allMemories.find(memory => memory.id === 'legacy-lumi-name')?.scope).toBe('global')
    expect(store.allMemories.find(memory => memory.id === 'legacy-daily-event')?.scope).toBe('shared')
    expect(store.allMemories.find(memory => memory.id === 'legacy-user-fact')?.scope).toBe('relationship')
    expect(store.recentMemoryEvents.filter(event => event.kind === 'promote')).toHaveLength(2)
    expect((await store.ensureUserMemoryLoaded(LUMI_MOUSSY_USER_ID)).fragments.map(memory => memory.id)).toEqual(expect.arrayContaining([
      'legacy-lumi-name',
      'legacy-daily-event',
    ]))
    expect(memoryTexts(store.retrieve(request('Lumi favorite color cyan', LUMI_MOUSSY_USER_ID)))).toContain('Lumi\'s favorite color is cyan.')
    expect(memoryTexts(store.retrieve(request('Doggy release relief', LUMI_MOUSSY_USER_ID)))).toContain('Doggy felt relieved after finishing the release.')
  })
})

function historicalMemory(id: string, type: LumiMemoryType, content: string, tags: string[]): LumiMemoryFragment {
  return {
    id,
    userId: LUMI_DOGGY_USER_ID,
    personaId: 'lumi',
    type,
    content,
    confidence: 0.95,
    importance: 0.9,
    emotionalIntensity: 0.4,
    relationshipRelevance: 0.8,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    decay: 0,
    tags,
    status: 'active',
    scope: 'relationship',
    ownerType: 'user',
    ownerId: LUMI_DOGGY_USER_ID,
    visibility: 'participants',
    participantUserIds: [LUMI_DOGGY_USER_ID],
    subjectUserIds: [LUMI_DOGGY_USER_ID],
    sensitivity: 'normal',
    sourceActorId: LUMI_DOGGY_USER_ID,
    sourceConversationType: 'direct',
  }
}

function candidate(content: string, scope: 'global' | 'shared' | 'relationship'): LumiMemoryCandidate {
  return {
    type: scope === 'global' ? 'persona_fact' : scope === 'shared' ? 'shared_event' : 'user_fact',
    content,
    confidence: 0.98,
    importance: 0.96,
    emotionalIntensity: 0.5,
    relationshipRelevance: 0.9,
    decay: 0,
    tags: scope === 'global' ? ['multi-user-test', 'lumi_self'] : ['multi-user-test'],
    status: 'candidate',
    reason: 'multi-user visibility regression',
    scope,
  }
}

function request(query: string, userId: string) {
  return { query, userId, viewerUserId: userId, personaId: 'lumi', limit: 20, conversationType: 'direct' as const }
}

function emptySnapshot(): LumiMemoryPersistenceSnapshot {
  return { fragments: [], events: [], seedId: '', dbPath: 'mock-memory.sqlite3' }
}

function createBridge(snapshots: Map<string, LumiMemoryPersistenceSnapshot>): LumiMemoryPersistenceBridge {
  return {
    getSnapshot: vi.fn(async ({ userId }) => snapshots.get(userId) ?? emptySnapshot()),
    replaceSnapshot: vi.fn(async ({ userId, snapshot }) => {
      snapshots.set(userId, snapshot)
      return snapshot
    }),
    upsertMemory: vi.fn(async (memory) => {
      for (const [userId, snapshot] of snapshots) {
        const visible = memory.scope === 'global'
          || (memory.scope === 'shared' && memory.sensitivity !== 'private')
          || memory.userId === userId
          || memory.participantUserIds?.includes(userId)
        if (visible)
          snapshot.fragments = [memory, ...snapshot.fragments.filter(item => item.id !== memory.id)]
      }
    }),
    deleteMemory: vi.fn(async () => {}),
    saveEvent: vi.fn(async ({ userId, event }) => {
      const snapshot = snapshots.get(userId)
      if (snapshot)
        snapshot.events = [event, ...snapshot.events]
    }),
    setSeedId: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  }
}

function memoryTexts(result: ReturnType<ReturnType<typeof useLumiMemoryStore>['retrieve']>) {
  return result.rankedMemories.map(item => item.memory.content)
}
