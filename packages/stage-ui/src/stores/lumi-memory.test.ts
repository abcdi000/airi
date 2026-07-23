import type { LumiMemoryPersistenceSnapshot } from './lumi-memory'

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { migratedLumiAllMemories, migratedLumiContextManifest, migratedLumiMemories } from '../../../lumi-runtime/src'
import { LUMI_DOGGY_USER_ID, LUMI_MOUSSY_USER_ID, useLumiIdentityStore } from './lumi-identity'
import { useLumiMemoryStore } from './lumi-memory'

describe('lumi-memory store', () => {
  beforeEach(() => {
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
  })

  it('seeds the available migrated Lumi memories into local storage state', () => {
    const store = useLumiMemoryStore()

    store.initialize()

    expect(store.allMemories).toHaveLength(migratedLumiAllMemories.length)
    expect(store.activeMemories).toHaveLength(migratedLumiMemories.length)
    expect(store.seedId).toBe(`${migratedLumiContextManifest.generatedAt}:${migratedLumiContextManifest.memoryCount}`)
  })

  it('searches only recallable active memories by default', () => {
    const store = useLumiMemoryStore()
    store.initialize()

    const candidate = store.remember({
      id: 'candidate-unique-memory',
      userId: 'local',
      personaId: 'lumi',
      type: 'project_context',
      content: 'Unique candidate memory about a sapphire dashboard migration.',
      confidence: 0.9,
      importance: 0.9,
      emotionalIntensity: 0,
      relationshipRelevance: 0.4,
      createdAt: '2026-06-03T00:00:00.000Z',
      updatedAt: '2026-06-03T00:00:00.000Z',
      decay: 0,
      tags: ['test'],
      status: 'candidate',
    })

    const before = store.search({
      query: candidate.content,
      userId: 'local',
      personaId: 'lumi',
      limit: 20,
      conversationType: 'direct',
    })

    expect(before.some(memory => memory.id === candidate.id)).toBe(false)

    store.updateMemoryStatus(candidate.id, 'active')

    const after = store.search({
      query: candidate.content,
      userId: 'local',
      personaId: 'lumi',
      limit: 20,
      conversationType: 'direct',
    })

    expect(after.some(memory => memory.id === candidate.id)).toBe(true)
  })

  it('forces direct memory writes into the active identity scope', () => {
    const store = useLumiMemoryStore()

    const memory = store.remember({
      id: 'legacy-local-owner-test',
      userId: 'local',
      personaId: 'lumi',
      type: 'project_context',
      content: 'A legacy caller must not create an unscoped local memory.',
      confidence: 0.9,
      importance: 0.8,
      emotionalIntensity: 0,
      relationshipRelevance: 0.4,
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      decay: 0,
      tags: ['test'],
      status: 'active',
    })

    expect(memory.userId).toBe(LUMI_DOGGY_USER_ID)
    expect(memory.scope).toBe('relationship')
    expect(memory.ownerId).toBe(LUMI_DOGGY_USER_ID)
  })

  it('includes persisted semantic vectors in complete memory snapshots', async () => {
    const store = useLumiMemoryStore()
    const snapshot: LumiMemoryPersistenceSnapshot = {
      fragments: [],
      events: [],
      seedId: 'vector-export',
      dbPath: 'mock-memory.sqlite3',
    }
    const vectors = [{
      memoryId: 'memory-vector-export',
      model: 'BAAI/bge-small-zh-v1.5',
      signature: 'verified-signature',
      vector: [0.6, 0.8],
      device: 'cuda',
      updatedAt: '2026-07-22T00:00:00.000Z',
    }]
    const getVectors = vi.fn(async () => vectors)
    store.setPersistenceBridge({
      getSnapshot: vi.fn(async () => snapshot),
      replaceSnapshot: vi.fn(async ({ snapshot: value }) => value),
      upsertMemory: vi.fn(),
      deleteMemory: vi.fn(),
      getVectors,
      saveEvent: vi.fn(),
      setSeedId: vi.fn(),
      clear: vi.fn(),
    })

    const exported = await store.exportSnapshot()

    expect(getVectors).toHaveBeenCalledWith({
      model: 'BAAI/bge-small-zh-v1.5',
      userId: LUMI_DOGGY_USER_ID,
    })
    expect(exported.vectors).toEqual(vectors)
  })

  it('keeps Lumi global facts loaded after switching to Moussy', () => {
    const identityStore = useLumiIdentityStore()
    const store = useLumiMemoryStore()
    const globalMemory = store.remember({
      id: 'lumi-global-birthday',
      userId: LUMI_DOGGY_USER_ID,
      personaId: 'lumi',
      type: 'persona_fact',
      content: 'Lumi 的生日是5月13日。',
      confidence: 0.95,
      importance: 0.95,
      emotionalIntensity: 0.3,
      relationshipRelevance: 0.5,
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:00:00.000Z',
      decay: 0,
      tags: ['lumi_self', 'birthday'],
      status: 'active',
      scope: 'global',
      ownerType: 'lumi',
      ownerId: 'lumi',
      visibility: 'global',
      participantUserIds: [],
      subjectUserIds: ['lumi'],
      sensitivity: 'normal',
    })
    identityStore.activeUserId = LUMI_MOUSSY_USER_ID

    const found = store.search({ query: 'Lumi 生日 5月13日', userId: LUMI_MOUSSY_USER_ID, personaId: 'lumi', limit: 5, conversationType: 'direct' })

    expect(found.some(memory => memory.id === globalMemory.id)).toBe(true)
  })

  it('preserves shared ownership while importing relationship memories for Moussy', async () => {
    const identityStore = useLumiIdentityStore()
    const store = useLumiMemoryStore()
    const replaceSnapshot = vi.fn(async ({ snapshot }: { snapshot: LumiMemoryPersistenceSnapshot }) => snapshot)
    store.setPersistenceBridge({
      getSnapshot: vi.fn(),
      replaceSnapshot,
      upsertMemory: vi.fn(),
      deleteMemory: vi.fn(),
      saveEvent: vi.fn(),
      setSeedId: vi.fn(),
      clear: vi.fn(),
    })
    identityStore.activeUserId = LUMI_MOUSSY_USER_ID

    await store.importSnapshot({
      fragments: [
        {
          id: 'global-import',
          userId: LUMI_DOGGY_USER_ID,
          personaId: 'lumi',
          type: 'persona_fact',
          content: 'Lumi 的生日是5月13日。',
          confidence: 0.95,
          importance: 0.95,
          emotionalIntensity: 0.2,
          relationshipRelevance: 0.4,
          createdAt: '2026-07-21T00:00:00.000Z',
          updatedAt: '2026-07-21T00:00:00.000Z',
          decay: 0,
          tags: ['lumi_self', 'birthday'],
          status: 'active',
          scope: 'global',
          ownerType: 'lumi',
          ownerId: 'lumi',
          visibility: 'global',
          participantUserIds: [],
          subjectUserIds: ['lumi'],
          sensitivity: 'normal',
          sourceActorId: LUMI_DOGGY_USER_ID,
          sourceConversationType: 'direct',
          classificationReason: 'Explicit Lumi self fact accepted as global.',
          disclosureReason: 'Lumi self fact is available in every authorized conversation.',
        },
        {
          id: 'relationship-import',
          userId: LUMI_DOGGY_USER_ID,
          personaId: 'lumi',
          type: 'user_fact',
          content: 'Moussy 喜欢一起玩游戏。',
          confidence: 0.9,
          importance: 0.8,
          emotionalIntensity: 0.2,
          relationshipRelevance: 0.8,
          createdAt: '2026-07-21T00:00:00.000Z',
          updatedAt: '2026-07-21T00:00:00.000Z',
          decay: 0,
          tags: ['user_fact'],
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
          classificationReason: 'User fact retained in its source relationship.',
          disclosureReason: 'Relationship memory is visible only in direct conversation with its owner.',
        },
      ],
      events: [],
      seedId: 'scope-import',
    })

    const persisted = replaceSnapshot.mock.calls[0]?.[0].snapshot.fragments
    expect(persisted?.find(memory => memory.id === 'global-import')?.userId).toBe(LUMI_DOGGY_USER_ID)
    expect(persisted?.find(memory => memory.id === 'global-import')?.classificationReason).toBe('Explicit Lumi self fact accepted as global.')
    expect(persisted?.find(memory => memory.id === 'global-import')?.disclosureReason).toBe('Lumi self fact is available in every authorized conversation.')
    expect(persisted?.find(memory => memory.id === 'relationship-import')?.userId).toBe(LUMI_MOUSSY_USER_ID)
    expect(persisted?.find(memory => memory.id === 'relationship-import')?.ownerId).toBe(LUMI_MOUSSY_USER_ID)
    expect(persisted?.find(memory => memory.id === 'relationship-import')?.sourceActorId).toBe(LUMI_MOUSSY_USER_ID)
    expect(persisted?.find(memory => memory.id === 'relationship-import')?.classificationReason).toBe('User fact retained in its source relationship.')
  })

  it('stores extracted Lumi memory candidates through the activation gate', () => {
    const store = useLumiMemoryStore()
    const candidates = store.extractCandidates('记住：AIRI 迁移项目要保留 Lumi 的自动记忆。', 'msg-remember')

    const stored = store.rememberCandidates(candidates, {
      userId: 'local',
      personaId: 'lumi',
      conversationId: 'session-1',
    })

    expect(candidates.some(memory => memory.type === 'promise')).toBe(true)
    expect(stored.every(memory => memory.status === 'active')).toBe(true)

    const found = store.search({
      query: 'AIRI 迁移 自动记忆',
      userId: 'local',
      personaId: 'lumi',
      limit: 5,
      conversationType: 'direct',
    })

    expect(found.length).toBeGreaterThan(0)
  })

  it('rejects near-duplicate echoes of active retrieved memories', () => {
    const store = useLumiMemoryStore()
    store.initialize()
    store.remember({
      id: 'echo-source-memory',
      userId: 'local',
      personaId: 'lumi',
      type: 'shared_event',
      content: 'The user watched a film with Lumi and later discussed the hallway scene.',
      confidence: 0.9,
      importance: 0.9,
      emotionalIntensity: 0.2,
      relationshipRelevance: 0.7,
      createdAt: '2026-06-03T00:00:00.000Z',
      updatedAt: '2026-06-03T00:00:00.000Z',
      decay: 0,
      tags: ['shared_event'],
      status: 'active',
    })

    const stored = store.rememberCandidate({
      type: 'shared_event',
      content: 'The user watched a film with Lumi and discussed that hallway scene afterward.',
      confidence: 0.88,
      importance: 0.82,
      emotionalIntensity: 0.2,
      relationshipRelevance: 0.7,
      decay: 0,
      tags: ['shared_event'],
      status: 'candidate',
      reason: 'assistant echoed retrieved memory',
    })

    expect(stored).toBeNull()
  })

  it('detects and merges near-duplicate memory groups', () => {
    const store = useLumiMemoryStore()
    store.resetState()
    store.remember({
      id: 'favorite-entity-primary',
      userId: 'local',
      personaId: 'lumi',
      type: 'user_preference',
      content: 'In the Backrooms context, the user favorite entity is the Skin-Stealer.',
      confidence: 0.86,
      importance: 0.82,
      emotionalIntensity: 0.1,
      relationshipRelevance: 0.5,
      createdAt: '2026-06-03T00:00:00.000Z',
      updatedAt: '2026-06-03T00:00:00.000Z',
      decay: 0,
      tags: ['backrooms', 'preference'],
      status: 'active',
    })
    store.remember({
      id: 'favorite-entity-duplicate',
      userId: 'local',
      personaId: 'lumi',
      type: 'user_preference',
      content: 'The user favorite Backrooms entity is Skin-Stealer.',
      confidence: 0.74,
      importance: 0.7,
      emotionalIntensity: 0.1,
      relationshipRelevance: 0.4,
      createdAt: '2026-06-03T00:01:00.000Z',
      updatedAt: '2026-06-03T00:01:00.000Z',
      decay: 0,
      tags: ['backrooms'],
      status: 'candidate',
    })

    const group = store.duplicateMemoryGroups.find(item =>
      item.memories.some(memory => memory.id === 'favorite-entity-primary')
      && item.memories.some(memory => memory.id === 'favorite-entity-duplicate'),
    )

    expect(group).toBeDefined()
    const merged = store.mergeMemories(['favorite-entity-primary', 'favorite-entity-duplicate'])

    expect(merged?.id).not.toBe('favorite-entity-primary')
    expect(merged?.tags).toContain('merged_memory')
    expect(store.allMemories.find(memory => memory.id === 'favorite-entity-primary')?.status).toBe('archived')
    expect(store.allMemories.find(memory => memory.id === 'favorite-entity-duplicate')?.status).toBe('archived')
    expect(store.recentMemoryEvents.some(event =>
      event.kind === 'merge'
      && event.memoryId === merged?.id
      && event.relatedMemoryIds?.includes('favorite-entity-primary')
      && event.relatedMemoryIds?.includes('favorite-entity-duplicate'),
    )).toBe(true)
  })

  it('exposes a unified Alaya-style memory driver', () => {
    const store = useLumiMemoryStore()
    store.initialize()
    const saved = store.memoryDriver.save({
      id: 'alaya-driver-memory',
      userId: 'local',
      personaId: 'lumi',
      type: 'user_preference',
      content: 'The user likes violet interface accents.',
      confidence: 0.9,
      importance: 0.9,
      emotionalIntensity: 0,
      relationshipRelevance: 0.4,
      createdAt: '2026-06-03T00:00:00.000Z',
      updatedAt: '2026-06-03T00:00:00.000Z',
      decay: 0,
      tags: ['preference', 'ui'],
      status: 'active',
    })

    const found = store.memoryDriver.search({
      query: 'violet interface accents',
      userId: 'local',
      personaId: 'lumi',
      limit: 5,
      conversationType: 'direct',
    })

    expect(saved.id).toBe('alaya-driver-memory')
    expect(found.rankedMemories.some(item => item.memory.id === saved.id)).toBe(true)
    expect(store.memoryDriver.update(saved.id, { status: 'candidate' })).toBe(true)
    expect(store.memoryDriver.forget(saved.id)).toBe(true)
    expect(store.allMemories.find(memory => memory.id === saved.id)?.status).toBe('archived')
    const mergeSource = store.memoryDriver.save({
      id: 'alaya-driver-memory-copy',
      userId: 'local',
      personaId: 'lumi',
      type: 'user_preference',
      content: 'The user likes violet interface accents very much.',
      confidence: 0.82,
      importance: 0.8,
      emotionalIntensity: 0,
      relationshipRelevance: 0.4,
      createdAt: '2026-06-03T00:00:00.000Z',
      updatedAt: '2026-06-03T00:00:00.000Z',
      decay: 0,
      tags: ['preference', 'ui'],
      status: 'active',
    })
    const merged = store.memoryDriver.merge([saved.id, mergeSource.id])
    expect(merged?.id).not.toBe(saved.id)
    expect(merged?.id).not.toBe(mergeSource.id)
    expect(store.memoryDriver.delete(saved.id)).toBe(true)
    expect(store.allMemories.find(memory => memory.id === saved.id)).toBeUndefined()
    expect(store.recentMemoryEvents.some(event => event.kind === 'search')).toBe(true)
    expect(store.recentMemoryEvents.some(event => event.kind === 'save')).toBe(true)
    expect(store.recentMemoryEvents.some(event => event.kind === 'update')).toBe(true)
    expect(store.recentMemoryEvents.some(event => event.kind === 'forget')).toBe(true)
    expect(store.recentMemoryEvents.some(event => event.kind === 'merge')).toBe(true)
    expect(store.recentMemoryEvents.some(event => event.kind === 'delete')).toBe(true)
  })
})
