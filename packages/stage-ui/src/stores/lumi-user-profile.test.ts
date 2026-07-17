import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { LumiUserProfilePersistenceBridge, LumiUserProfilePersistenceSnapshot } from './lumi-user-profile'

import { LUMI_BOOTSTRAP_PROFILE_VERSION, useLumiUserProfileStore } from './lumi-user-profile'

describe('lumi-user-profile store', () => {
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

  it('isolates one-off negative emotion into Daily State instead of Core Profile', () => {
    const store = useLumiUserProfileStore()
    const candidates = store.extractDeterministicCandidates('我废了，今天真的有点崩溃。')

    const results = store.applyCandidates(candidates, {
      sourceKind: 'chat',
      sourceMessageId: 'msg-1',
      now: '2026-06-05T12:00:00.000Z',
    })

    expect(results.some(result => result.status === 'stored')).toBe(true)
    expect(store.dailyEntries).toEqual([
      expect.objectContaining({
        layer: 'daily',
        key: 'mood',
        value: '低落或受挫',
      }),
    ])
    expect(store.coreEntries).toHaveLength(0)
  })

  it('routes high-impact core updates into pending confirmation', () => {
    const store = useLumiUserProfileStore()

    const [result] = store.applyCandidates([{
      layer: 'core',
      key: 'long_term_goals',
      value: '用户决定放弃原本的长期目标',
      confidence: 0.81,
      evidence: '我不想要以前那个长期目标了',
      reason: 'major_goal_change',
      impact: 'high',
    }], {
      sourceKind: 'chat',
      sourceMessageId: 'msg-2',
    })

    expect(result?.status).toBe('pending')
    expect(store.coreEntries).toHaveLength(0)
    expect(store.pendingActiveUpdates[0]).toMatchObject({
      key: 'long_term_goals',
      value: '用户决定放弃原本的长期目标',
      status: 'pending',
    })
  })

  it('updates dynamic profile with evidence and rollback history', () => {
    const store = useLumiUserProfileStore()

    const first = store.applyCandidate({
      layer: 'dynamic',
      key: 'current_focus',
      value: 'AIRI 插件系统',
      confidence: 0.82,
      evidence: '我现在主要在做 AIRI 插件系统',
    }, { sourceKind: 'chat', now: '2026-06-04T12:00:00.000Z' })
    expect(first.status).toBe('stored')

    const second = store.applyCandidate({
      layer: 'dynamic',
      key: 'current_focus',
      value: 'Lumi 用户画像系统',
      confidence: 0.86,
      evidence: '我们应该实现用户画像系统',
    }, { sourceKind: 'chat', now: '2026-06-04T13:00:00.000Z' })
    expect(second.status).toBe('stored')

    const entry = store.dynamicEntries[0]
    expect(entry?.value).toBe('Lumi 用户画像系统')
    expect(entry?.history[0]).toMatchObject({
      previousValue: 'AIRI 插件系统',
      nextValue: 'Lumi 用户画像系统',
    })

    store.rollbackEntry(entry!.id)
    expect(store.dynamicEntries[0]?.value).toBe('AIRI 插件系统')
  })

  it('injects only relevant profile context plus stable core anchors', () => {
    const store = useLumiUserProfileStore()
    store.createManualEntry({
      layer: 'core',
      key: 'communication_preference',
      value: '用户喜欢直接、少废话、可调试的说明。',
    })
    store.createManualEntry({
      layer: 'dynamic',
      key: 'active_project',
      value: 'AIRI 与 Lumi 迁移项目。',
    })
    store.createManualEntry({
      layer: 'dynamic',
      key: 'recent_interests',
      value: '无关的烘焙食谱。',
    })

    const context = store.buildRelevantContext({
      messageText: '我们继续修 AIRI 的用户画像系统。',
      limit: 2,
    })

    expect(context).toContain('沟通偏好')
    expect(context).toContain('AIRI 与 Lumi 迁移项目')
    expect(context).not.toContain('无关的烘焙食谱')
    expect(context).toContain('Daily State as Core Profile')
  })

  it('imports Bootstrap Profile into empty Core Profile with protected bootstrap sources', () => {
    const store = useLumiUserProfileStore()

    const result = store.importBootstrapProfile()

    expect(result.imported).toBeGreaterThan(0)
    expect(store.bootstrapStatus.currentVersion).toBe(LUMI_BOOTSTRAP_PROFILE_VERSION)
    expect(store.coreEntries.length).toBeGreaterThan(0)
    expect(store.coreEntries.every(entry => entry.layer === 'core')).toBe(true)
    expect(store.bootstrapEntries.length).toBe(result.imported)
    expect(store.protectedEntries.length).toBe(result.imported)
    expect(store.coreEntries[0]?.source.some(source => source.kind === 'bootstrap_profile')).toBe(true)
    expect(store.coreEntries[0]?.protected).toBe(true)
  })

  it('keeps Bootstrap long-term goals protected from a single negative chat update', () => {
    const store = useLumiUserProfileStore()
    store.importBootstrapProfile()
    const goal = store.coreEntries.find(entry => entry.key === 'long_term_goals')
    expect(goal).toBeTruthy()

    const [result] = store.applyCandidates([{
      layer: 'core',
      key: 'long_term_goals',
      value: '用户已经彻底放弃考研',
      confidence: 0.93,
      evidence: '我废了，不考了',
      reason: 'single_negative_turn',
      impact: 'high',
    }], { sourceKind: 'chat' })

    expect(result?.status).toBe('pending')
    expect(store.coreEntries.find(entry => entry.id === goal!.id)?.value).toBe(goal!.value)
  })

  it('allows explicit pending approval to modify a protected Bootstrap entry', () => {
    const store = useLumiUserProfileStore()
    store.importBootstrapProfile()
    const goal = store.coreEntries.find(entry => entry.key === 'long_term_goals')!

    store.applyCandidate({
      layer: 'core',
      key: 'long_term_goals',
      value: '考研目标调整为计算机方向上岸',
      confidence: 0.95,
      evidence: '我确认修改长期目标',
      reason: 'explicit_user_confirmation',
      impact: 'high',
    }, { sourceKind: 'chat' })

    const pending = store.pendingActiveUpdates[0]
    expect(pending?.targetEntryId).toBe(goal.id)
    const updated = store.approvePending(pending!.id)
    expect(updated?.id).toBe(goal.id)
    expect(store.coreEntries.find(entry => entry.id === goal.id)?.value).toBe('考研目标调整为计算机方向上岸')
    expect(store.coreEntries.find(entry => entry.id === goal.id)?.history.length).toBeGreaterThan(0)
  })

  it('routes conflicting Bootstrap re-imports into Pending Updates', () => {
    const store = useLumiUserProfileStore()
    store.importBootstrapProfile()
    const original = store.coreEntries.find(entry =>
      entry.source.some(source => source.id === 'bootstrap:long_term_goals:0'),
    )!

    const result = store.importBootstrapProfile({
      version: '2026-06-04-v2',
      candidates: [{
        layer: 'core',
        key: 'long_term_goals',
        value: '新版目标：先完成一个完全可运行的人格系统',
        confidence: 0.9,
        evidence: 'Bootstrap Profile 2026-06-04-v2',
        sourceKind: 'bootstrap_profile',
        reason: 'bootstrap_profile_initial_anchor',
        impact: 'high',
        protected: true,
        bootstrapVersion: '2026-06-04-v2',
        bootstrapId: 'bootstrap:long_term_goals:0',
      }],
    })

    expect(result.pending).toBe(1)
    expect(store.coreEntries.find(entry => entry.id === original.id)?.value).toBe(original.value)
    expect(store.pendingActiveUpdates[0]).toMatchObject({
      key: 'long_term_goals',
      value: '新版目标：先完成一个完全可运行的人格系统',
      targetEntryId: original.id,
    })
  })

  it('does not inject the full Bootstrap Profile every turn', () => {
    const store = useLumiUserProfileStore()
    store.importBootstrapProfile()

    const context = store.buildRelevantContext({
      messageText: '我们继续修 AIRI 的用户画像系统。',
      limit: 6,
    })

    expect(context).toContain('AIRI')
    expect(context).toContain('沟通偏好')
    expect(context).not.toContain('考研上岸')
    expect(context).not.toContain('Doggy 真正在意的不是功能数量')
  })

  it('uses emotional patterns as reply strategy instead of blunt user labels', () => {
    const store = useLumiUserProfileStore()
    store.importBootstrapProfile()

    const context = store.buildRelevantContext({
      messageText: 'AIRI 和 Neuro-sama 这种项目太强了，我感觉自己不行。',
      limit: 8,
    })

    expect(context).toContain('回复策略参考')
    expect(context).toContain('先承认对方项目确实强')
    expect(context).not.toContain('容易因为顶级项目产生挫败感')
    expect(context).not.toContain('经常将自己与行业最优秀项目比较')
  })

  it('initializes from an empty SQLite profile database without migrating blank local state', async () => {
    const store = useLumiUserProfileStore()
    const bridge = createProfilePersistenceBridge(emptyProfileSnapshot())

    store.setPersistenceBridge(bridge)
    await store.initializePersistence()

    expect(store.persistenceMode).toBe('sqlite')
    expect(store.persistenceReady).toBe(true)
    expect(bridge.loadProfileFromDatabase).toHaveBeenCalledTimes(1)
    expect(bridge.replaceSnapshot).not.toHaveBeenCalled()
    expect(store.entries).toHaveLength(0)
  })

  it('migrates an existing local profile snapshot into SQLite when the database is empty', async () => {
    const store = useLumiUserProfileStore()
    store.createManualEntry({
      layer: 'dynamic',
      key: 'active_project',
      value: 'Lumi user profile SQLite bridge',
    })
    const bridge = createProfilePersistenceBridge(emptyProfileSnapshot())

    store.setPersistenceBridge(bridge)
    await store.initializePersistence()

    expect(bridge.replaceSnapshot).toHaveBeenCalledTimes(1)
    expect(bridge.replaceSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      entries: expect.arrayContaining([
        expect.objectContaining({ key: 'active_project', value: 'Lumi user profile SQLite bridge' }),
      ]),
    }))
    expect(store.persistenceDbPath).toBe('mock-profile.sqlite3')
  })

  it('persists Bootstrap Profile entries into SQLite with protected bootstrap metadata', async () => {
    const store = useLumiUserProfileStore()
    const bridge = createProfilePersistenceBridge(emptyProfileSnapshot())
    store.setPersistenceBridge(bridge)
    await store.initializePersistence()

    store.importBootstrapProfile()

    await vi.waitFor(() => {
      expect(bridge.saveProfileEntry).toHaveBeenCalled()
    })
    expect(bridge.saveProfileEntry).toHaveBeenCalledWith(expect.objectContaining({
      layer: 'core',
      protected: true,
      bootstrapVersion: LUMI_BOOTSTRAP_PROFILE_VERSION,
      source: expect.arrayContaining([expect.objectContaining({ kind: 'bootstrap_profile' })]),
    }))
    expect(bridge.setMeta).toHaveBeenCalledWith({
      key: 'bootstrap_version',
      value: LUMI_BOOTSTRAP_PROFILE_VERSION,
    })
  })

  it('hydrates protected entries from SQLite as protected after restart', async () => {
    const store = useLumiUserProfileStore()
    const snapshot = emptyProfileSnapshot({
      entries: [profileEntryFixture({
        id: 'profile-core-1',
        layer: 'core',
        key: 'communication_preference',
        value: '不喜欢客服式回复',
        protected: true,
        bootstrapVersion: LUMI_BOOTSTRAP_PROFILE_VERSION,
        source: [{ kind: 'bootstrap_profile', quote: 'bootstrap', createdAt: '2026-06-04T00:00:00.000Z' }],
      })],
      bootstrapVersion: LUMI_BOOTSTRAP_PROFILE_VERSION,
    })

    store.setPersistenceBridge(createProfilePersistenceBridge(snapshot))
    await store.initializePersistence()

    expect(store.protectedEntries).toHaveLength(1)
    expect(store.protectedEntries[0]).toMatchObject({
      key: 'communication_preference',
      protected: true,
      bootstrapVersion: LUMI_BOOTSTRAP_PROFILE_VERSION,
    })
  })

  it('keeps pending updates after reloading from SQLite', async () => {
    const store = useLumiUserProfileStore()
    const snapshot = emptyProfileSnapshot({
      pendingUpdates: [{
        id: 'pending-1',
        targetLayer: 'core',
        key: 'long_term_goals',
        value: '用户确认调整长期目标',
        confidence: 0.9,
        impact: 'high',
        reason: 'requires_confirmation',
        source: [{ kind: 'chat', quote: '我确认修改目标', createdAt: '2026-06-04T00:00:00.000Z' }],
        createdAt: '2026-06-04T00:00:00.000Z',
        status: 'pending',
      }],
    })

    store.setPersistenceBridge(createProfilePersistenceBridge(snapshot))
    await store.initializePersistence()

    expect(store.pendingActiveUpdates).toEqual([
      expect.objectContaining({ id: 'pending-1', key: 'long_term_goals', status: 'pending' }),
    ])
  })

  it('persists audit history for create, update, approve, reject, and rollback actions', async () => {
    const store = useLumiUserProfileStore()
    const bridge = createProfilePersistenceBridge(emptyProfileSnapshot())
    store.setPersistenceBridge(bridge)
    await store.initializePersistence()

    const created = store.createManualEntry({
      layer: 'dynamic',
      key: 'current_focus',
      value: 'AIRI plugins',
    })
    const entry = created.status === 'stored' ? created.entry : undefined
    expect(entry).toBeTruthy()
    store.updateEntry(entry!.id, { value: 'User Profile System' })
    store.rollbackEntry(entry!.id)
    store.applyCandidate({
      layer: 'core',
      key: 'long_term_goals',
      value: '确认修改长期目标',
      confidence: 0.91,
      evidence: '我确认修改长期目标',
      impact: 'high',
    }, { sourceKind: 'chat' })
    store.approvePending(store.pendingActiveUpdates[0]!.id)
    store.applyCandidate({
      layer: 'core',
      key: 'identity',
      value: '临时身份判断',
      confidence: 0.8,
      evidence: '单轮推断',
      impact: 'high',
    }, { sourceKind: 'chat' })
    store.rejectPending(store.pendingActiveUpdates[0]!.id)

    await vi.waitFor(() => {
      expect(bridge.saveHistory).toHaveBeenCalledWith(expect.objectContaining({
        event: expect.objectContaining({ kind: 'reject' }),
      }))
    })
    expect(bridge.saveHistory).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({ kind: 'create' }),
    }))
    expect(bridge.saveHistory).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({ kind: 'update' }),
    }))
    expect(bridge.saveHistory).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({ kind: 'approve' }),
    }))
  })

  it('builds prompt context from a profile reloaded from SQLite', async () => {
    const store = useLumiUserProfileStore()
    store.setPersistenceBridge(createProfilePersistenceBridge(emptyProfileSnapshot({
      entries: [profileEntryFixture({
        id: 'profile-project-1',
        layer: 'dynamic',
        key: 'active_project',
        value: 'AIRI Lumi user profile SQLite bridge',
      })],
    })))
    await store.initializePersistence()

    const context = store.buildRelevantContext({
      messageText: '继续做 AIRI 的用户画像数据库持久化',
    })

    expect(context).toContain('AIRI Lumi user profile SQLite bridge')
    expect(context).toContain('Daily State as Core Profile')
  })

  it('does not block profile updates when SQLite writes fail', async () => {
    const store = useLumiUserProfileStore()
    const bridge = createProfilePersistenceBridge(emptyProfileSnapshot())
    bridge.saveProfileEntry = vi.fn().mockRejectedValue(new Error('sqlite is busy'))
    store.setPersistenceBridge(bridge)
    await store.initializePersistence()

    const result = store.createManualEntry({
      layer: 'dynamic',
      key: 'current_focus',
      value: 'runtime profile survives failed writes',
    })

    expect(result.status).toBe('stored')
    expect(store.dynamicEntries[0]?.value).toBe('runtime profile survives failed writes')
    await vi.waitFor(() => {
      expect(store.persistenceLastError).toContain('sqlite is busy')
    })
  })
  it('accumulates repeated high-impact impressions into one pending update before auto review', () => {
    const store = useLumiUserProfileStore()

    for (let index = 0; index < 3; index += 1) {
      store.applyCandidate({
        layer: 'core',
        key: 'long_term_goals',
        value: '持续开发具有人格连续性的 Lumi',
        confidence: 0.86,
        evidence: `第 ${index + 1} 次提到 Lumi 长期人格项目`,
        impact: 'high',
      }, {
        sourceKind: 'chat',
        sourceMessageId: `msg-${index}`,
      })
    }

    expect(store.pendingActiveUpdates).toHaveLength(1)
    expect(store.pendingActiveUpdates[0]?.source).toHaveLength(3)
    expect(store.autoReviewPendingUpdates[0]).toMatchObject({
      key: 'long_term_goals',
      value: '持续开发具有人格连续性的 Lumi',
    })
  })

  it('can auto-approve a mature pending update with a consciousness-model review decision', () => {
    const store = useLumiUserProfileStore()

    for (let index = 0; index < 3; index += 1) {
      store.applyCandidate({
        layer: 'core',
        key: 'communication_preference',
        value: '喜欢直接、自然、能一起分析问题的交流方式',
        confidence: 0.88,
        evidence: `稳定偏好证据 ${index + 1}`,
        impact: 'high',
      }, {
        sourceKind: 'chat',
        sourceMessageId: `pref-${index}`,
      })
    }

    const pending = store.autoReviewPendingUpdates[0]
    const entry = store.approvePendingAutomatically(pending!.id, {
      decision: 'approve',
      value: '喜欢直接、自然、能一起分析问题的交流方式',
      confidence: 0.91,
      summary: '三条证据稳定指向同一沟通偏好，可以自动写入。',
    })

    expect(entry).toMatchObject({
      layer: 'core',
      key: 'communication_preference',
      value: '喜欢直接、自然、能一起分析问题的交流方式',
    })
    expect(store.pendingActiveUpdates).toHaveLength(0)
    expect(store.recentEvents.some(event => event.kind === 'auto_review')).toBe(true)
  })

  it('prioritizes mature pending updates with more evidence for consciousness-model auto review', () => {
    const store = useLumiUserProfileStore()

    for (let index = 0; index < 3; index += 1) {
      store.applyCandidate({
        layer: 'core',
        key: 'communication_preference',
        value: '喜欢自然直接的交流',
        confidence: 0.86,
        evidence: `沟通偏好证据 ${index}`,
        impact: 'high',
      }, { sourceKind: 'chat', sourceMessageId: `comm-${index}` })
    }

    for (let index = 0; index < 12; index += 1) {
      store.applyCandidate({
        layer: 'core',
        key: 'long_term_goals',
        value: '备考 2026 考研数学',
        confidence: 0.92,
        evidence: `考研数学证据 ${index}`,
        impact: 'high',
      }, { sourceKind: 'chat', sourceMessageId: `goal-${index}` })
    }

    expect(store.autoReviewPendingUpdates[0]).toMatchObject({
      key: 'long_term_goals',
      value: expect.stringContaining('2026'),
    })
    expect(store.autoReviewPendingUpdates[0]?.source).toHaveLength(12)
  })

  it('caps same-impression evidence at 20 items', () => {
    const store = useLumiUserProfileStore()

    for (let index = 0; index < 25; index += 1) {
      store.applyCandidate({
        layer: 'core',
        key: 'long_term_goals',
        value: '长期开发 Lumi',
        confidence: 0.82,
        evidence: `长期开发证据 ${index}`,
        impact: 'high',
      }, { sourceKind: 'chat', sourceMessageId: `lumi-goal-${index}` })
    }

    expect(store.pendingActiveUpdates).toHaveLength(1)
    expect(store.pendingActiveUpdates[0]?.source).toHaveLength(20)
  })

  it('preserves all pending evidence when approving a new profile entry', () => {
    const store = useLumiUserProfileStore()

    for (let index = 0; index < 12; index += 1) {
      store.applyCandidate({
        layer: 'core',
        key: 'long_term_goals',
        value: '备考 2026 考研数学',
        confidence: 0.92,
        evidence: `考研数学证据 ${index}`,
        impact: 'high',
      }, { sourceKind: 'chat', sourceMessageId: `approved-goal-${index}` })
    }

    const pending = store.pendingActiveUpdates[0]
    expect(pending?.source).toHaveLength(12)

    const entry = store.approvePending(pending!.id)
    expect(entry?.source).toHaveLength(12)
    expect(store.coreEntries.find(item => item.id === entry?.id)?.source).toHaveLength(12)
  })

  it('uses reviewed summary value while preserving all pending evidence', () => {
    const store = useLumiUserProfileStore()

    for (let index = 0; index < 12; index += 1) {
      store.applyCandidate({
        layer: 'core',
        key: 'long_term_goals',
        value: `备考 2026 考研数学；第 ${index} 条具体说法`,
        confidence: 0.9,
        evidence: `考研数学证据 ${index}`,
        impact: 'high',
      }, { sourceKind: 'chat', sourceMessageId: `summary-goal-${index}` })
    }

    const pending = store.pendingActiveUpdates[0]
    const entry = store.approvePendingAutomatically(pending!.id, {
      decision: 'approve',
      value: '备考 2026 考研数学',
      confidence: 0.94,
      summary: '多条证据指向同一长期目标，压缩为稳定画像短句。',
    })

    expect(entry?.value).toBe('备考 2026 考研数学')
    expect(entry?.source).toHaveLength(12)
  })

  it('uses combined evidence and confidence maturity for auto-review priority', () => {
    const store = useLumiUserProfileStore()

    for (let index = 0; index < 2; index += 1) {
      store.applyCandidate({
        layer: 'core',
        key: 'communication_preference',
        value: '喜欢直接反馈',
        confidence: 0.95,
        evidence: `直接反馈证据 ${index}`,
        impact: 'high',
      }, { sourceKind: 'chat', sourceMessageId: `direct-${index}` })
    }

    for (let index = 0; index < 10; index += 1) {
      store.applyCandidate({
        layer: 'core',
        key: 'project_context',
        value: '持续关注 Lumi 用户画像系统',
        confidence: 0.78,
        evidence: `画像系统证据 ${index}`,
        impact: 'high',
      }, { sourceKind: 'chat', sourceMessageId: `profile-${index}` })
    }

    expect(store.autoReviewPendingUpdates[0]).toMatchObject({
      key: 'project_context',
      value: '持续关注 Lumi 用户画像系统',
    })
    expect(store.autoReviewPendingUpdates[0]?.source).toHaveLength(10)
  })
})

function emptyProfileSnapshot(patch: Partial<LumiUserProfilePersistenceSnapshot> = {}): LumiUserProfilePersistenceSnapshot {
  return {
    entries: [],
    pendingUpdates: [],
    events: [],
    autoUpdateEnabled: true,
    bootstrapVersion: '',
    dbPath: 'mock-profile.sqlite3',
    ...patch,
  }
}

function profileEntryFixture(patch: Partial<LumiUserProfilePersistenceSnapshot['entries'][number]> = {}): LumiUserProfilePersistenceSnapshot['entries'][number] {
  return {
    id: 'profile-fixture',
    layer: 'dynamic',
    key: 'current_focus',
    value: 'fixture',
    confidence: 0.9,
    weight: 0.8,
    source: [{ kind: 'manual', quote: 'manual', createdAt: '2026-06-04T00:00:00.000Z' }],
    createdAt: '2026-06-04T00:00:00.000Z',
    updatedAt: '2026-06-04T00:00:00.000Z',
    lastSeenAt: '2026-06-04T00:00:00.000Z',
    status: 'active',
    history: [],
    ...patch,
  }
}

function createProfilePersistenceBridge(snapshot: LumiUserProfilePersistenceSnapshot): LumiUserProfilePersistenceBridge {
  let current = snapshot
  return {
    loadProfileFromDatabase: vi.fn(async () => current),
    replaceSnapshot: vi.fn(async (next) => {
      current = { ...next, dbPath: 'mock-profile.sqlite3' }
      return current
    }),
    saveProfileEntry: vi.fn(async (entry) => {
      current = {
        ...current,
        entries: [entry, ...current.entries.filter(item => item.id !== entry.id)],
      }
    }),
    updateProfileEntry: vi.fn(async (entry) => {
      current = {
        ...current,
        entries: [entry, ...current.entries.filter(item => item.id !== entry.id)],
      }
    }),
    archiveProfileEntry: vi.fn(async ({ id }) => {
      current = {
        ...current,
        entries: current.entries.map(entry => entry.id === id ? { ...entry, status: 'archived' } : entry),
      }
    }),
    deleteProfileEntry: vi.fn(async ({ id }) => {
      current = {
        ...current,
        entries: current.entries.filter(entry => entry.id !== id),
      }
    }),
    saveEvidence: vi.fn(async () => {}),
    saveHistory: vi.fn(async () => {}),
    loadPendingUpdates: vi.fn(async () => current.pendingUpdates),
    savePendingUpdate: vi.fn(async (pending) => {
      current = {
        ...current,
        pendingUpdates: [pending, ...current.pendingUpdates.filter(item => item.id !== pending.id)],
      }
    }),
    approvePendingUpdate: vi.fn(async ({ id, entry }) => {
      current = {
        ...current,
        entries: entry ? [entry, ...current.entries.filter(item => item.id !== entry.id)] : current.entries,
        pendingUpdates: current.pendingUpdates.map(item => item.id === id ? { ...item, status: 'approved' } : item),
      }
    }),
    rejectPendingUpdate: vi.fn(async ({ id }) => {
      current = {
        ...current,
        pendingUpdates: current.pendingUpdates.map(item => item.id === id ? { ...item, status: 'rejected' } : item),
      }
    }),
    setMeta: vi.fn(async ({ key, value }) => {
      current = {
        ...current,
        meta: { ...(current.meta ?? {}), [key]: value },
        bootstrapVersion: key === 'bootstrap_version' && typeof value === 'string' ? value : current.bootstrapVersion,
        autoUpdateEnabled: key === 'auto_update_enabled' && typeof value === 'boolean' ? value : current.autoUpdateEnabled,
      }
    }),
    clear: vi.fn(async () => {
      current = emptyProfileSnapshot()
    }),
  }
}
