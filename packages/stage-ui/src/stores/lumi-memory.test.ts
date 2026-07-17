import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { migratedLumiAllMemories, migratedLumiContextManifest, migratedLumiMemories } from '../../../lumi-runtime/src'
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
    })

    expect(before.some(memory => memory.id === candidate.id)).toBe(false)

    store.updateMemoryStatus(candidate.id, 'active')

    const after = store.search({
      query: candidate.content,
      userId: 'local',
      personaId: 'lumi',
      limit: 20,
    })

    expect(after.some(memory => memory.id === candidate.id)).toBe(true)
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
