import type { ChatHistoryItem } from '../types/chat'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import { extractMessageText } from '../libs/chat-sync'

export type LumiUserProfileLayer = 'core' | 'dynamic' | 'daily'
export type LumiUserProfileStatus = 'active' | 'archived' | 'deleted'
export type LumiUserProfilePendingStatus = 'pending' | 'approved' | 'rejected'
export type LumiUserProfileSourceKind = 'chat' | 'daily_diary' | 'screen_observation' | 'manual' | 'bootstrap_profile' | 'current_state'

export type LumiUserProfileKey =
  | 'nickname'
  | 'long_term_goals'
  | 'long_term_identity'
  | 'long_term_interests'
  | 'learning_direction'
  | 'communication_preference'
  | 'relationship_to_lumi'
  | 'emotional_patterns'
  | 'strengths'
  | 'encouragement_guidelines'
  | 'project_context'
  | 'relationship_guidelines'
  | 'important_understanding'
  | 'identity'
  | 'personality_traits'
  | 'relationship_boundary'
  | 'life_decisions'
  | 'current_focus'
  | 'recent_interests'
  | 'active_project'
  | 'unresolved_problem'
  | 'current_learning_topic'
  | 'mood'
  | 'energy'
  | 'focus_level'
  | 'main_activity'
  | 'pressure_source'

export interface LumiUserProfileSource {
  kind: LumiUserProfileSourceKind
  id?: string
  quote: string
  createdAt: string
}

export interface LumiUserProfileHistoryItem {
  id: string
  previousValue: string
  nextValue: string
  reason: string
  source: LumiUserProfileSource[]
  createdAt: string
}

export interface LumiUserProfileEntry {
  id: string
  layer: LumiUserProfileLayer
  key: LumiUserProfileKey
  value: string
  confidence: number
  weight: number
  source: LumiUserProfileSource[]
  protected?: boolean
  bootstrapVersion?: string
  manuallyModifiedAt?: string
  createdAt: string
  updatedAt: string
  lastSeenAt: string
  status: LumiUserProfileStatus
  history: LumiUserProfileHistoryItem[]
}

export interface LumiUserProfilePendingUpdate {
  id: string
  targetLayer: 'core'
  key: LumiUserProfileKey
  value: string
  confidence: number
  impact: 'high'
  reason: string
  source: LumiUserProfileSource[]
  bootstrapVersion?: string
  targetEntryId?: string
  autoReview?: {
    evidenceCount: number
    lastReviewedAt?: string
    summary?: string
    decision?: 'approve' | 'reject' | 'keep_pending'
  }
  createdAt: string
  status: LumiUserProfilePendingStatus
}

export interface LumiUserProfileCandidate {
  layer: LumiUserProfileLayer
  key: LumiUserProfileKey
  value: string
  confidence: number
  sourceKind?: LumiUserProfileSourceKind
  evidence: string
  reason?: string
  impact?: 'low' | 'medium' | 'high'
  protected?: boolean
  bootstrapVersion?: string
  bootstrapId?: string
}

export interface LumiUserProfileEvent {
  id: string
  kind: 'create' | 'update' | 'archive' | 'delete' | 'rollback' | 'pending' | 'approve' | 'reject' | 'clear' | 'auto_update_toggle' | 'bootstrap_import' | 'auto_review'
  entryId?: string
  pendingId?: string
  key?: LumiUserProfileKey
  preview?: string
  createdAt: string
}

export interface LumiUserProfileAutoReviewDecision {
  decision: 'approve' | 'reject' | 'keep_pending'
  value?: string
  confidence?: number
  summary?: string
  reason?: string
}

export interface LumiUserProfileSnapshot {
  entries: LumiUserProfileEntry[]
  pendingUpdates: LumiUserProfilePendingUpdate[]
  events: LumiUserProfileEvent[]
  autoUpdateEnabled: boolean
  bootstrapVersion: string
  exportedAt: string
  dbPath?: string
  meta?: Record<string, unknown>
}

export interface LumiUserProfilePersistenceSnapshot extends Omit<LumiUserProfileSnapshot, 'exportedAt'> {
  dbPath?: string
  meta?: Record<string, unknown>
}

export interface LumiUserProfilePersistenceBridge {
  loadProfileFromDatabase: () => Promise<LumiUserProfilePersistenceSnapshot>
  replaceSnapshot: (snapshot: LumiUserProfilePersistenceSnapshot) => Promise<LumiUserProfilePersistenceSnapshot>
  saveProfileEntry: (entry: LumiUserProfileEntry) => Promise<void>
  updateProfileEntry: (entry: LumiUserProfileEntry) => Promise<void>
  archiveProfileEntry: (payload: { id: string }) => Promise<void>
  deleteProfileEntry: (payload: { id: string }) => Promise<void>
  saveEvidence: (payload: { entryId: string, evidence: LumiUserProfileSource }) => Promise<void>
  saveHistory: (payload: { entryId?: string, history?: LumiUserProfileHistoryItem, event?: LumiUserProfileEvent }) => Promise<void>
  loadPendingUpdates: () => Promise<LumiUserProfilePendingUpdate[]>
  savePendingUpdate: (pending: LumiUserProfilePendingUpdate) => Promise<void>
  approvePendingUpdate: (payload: { id: string, entry?: LumiUserProfileEntry }) => Promise<void>
  rejectPendingUpdate: (payload: { id: string }) => Promise<void>
  setMeta: (payload: { key: string, value: unknown }) => Promise<void>
  clear: () => Promise<void>
}

const PROFILE_STORAGE_KEY = 'lumi/user-profile/entries:v1'
const PENDING_STORAGE_KEY = 'lumi/user-profile/pending:v1'
const EVENTS_STORAGE_KEY = 'lumi/user-profile/events:v1'
const AUTO_UPDATE_STORAGE_KEY = 'lumi/user-profile/auto-update:v1'
const BOOTSTRAP_VERSION_STORAGE_KEY = 'lumi/user-profile/bootstrap-version:v1'

export const LUMI_BOOTSTRAP_PROFILE_VERSION = '2026-06-04-v1'
const AUTO_REVIEW_MAX_EVIDENCE = 20
const AUTO_REVIEW_MIN_EVIDENCE = 2
const AUTO_REVIEW_MIN_MATURITY = 0.58
const AUTO_REVIEW_PROTECTED_MIN_EVIDENCE = 3
const AUTO_REVIEW_PROTECTED_MIN_MATURITY = 0.66

const CORE_KEYS = new Set<LumiUserProfileKey>([
  'nickname',
  'long_term_goals',
  'long_term_identity',
  'long_term_interests',
  'learning_direction',
  'communication_preference',
  'relationship_to_lumi',
  'emotional_patterns',
  'strengths',
  'encouragement_guidelines',
  'project_context',
  'relationship_guidelines',
  'important_understanding',
  'identity',
  'personality_traits',
  'relationship_boundary',
  'life_decisions',
])

const FORBIDDEN_AUTO_CORE_KEYS = new Set<LumiUserProfileKey>([
  'long_term_goals',
  'long_term_identity',
  'identity',
  'personality_traits',
  'relationship_boundary',
  'life_decisions',
  'relationship_to_lumi',
  'relationship_guidelines',
  'important_understanding',
])

const DYNAMIC_KEYS = new Set<LumiUserProfileKey>([
  'current_focus',
  'recent_interests',
  'active_project',
  'unresolved_problem',
  'current_learning_topic',
])

const DAILY_KEYS = new Set<LumiUserProfileKey>([
  'mood',
  'energy',
  'focus_level',
  'main_activity',
  'pressure_source',
])

const KEY_LABELS: Record<LumiUserProfileKey, string> = {
  nickname: '昵称',
  long_term_goals: '长期目标',
  long_term_identity: '长期身份与背景',
  long_term_interests: '长期兴趣',
  learning_direction: '学习方向',
  communication_preference: '沟通偏好',
  relationship_to_lumi: '与 Lumi 的关系认知',
  emotional_patterns: '情绪模式',
  strengths: '长期优势',
  encouragement_guidelines: '鼓励方式',
  project_context: '项目背景',
  relationship_guidelines: '关系理解',
  important_understanding: '重要理解',
  identity: '身份认知',
  personality_traits: '长期性格判断',
  relationship_boundary: '关系边界',
  life_decisions: '重大人生决定',
  current_focus: '当前关注',
  recent_interests: '近期兴趣',
  active_project: '当前项目',
  unresolved_problem: '未解决问题',
  current_learning_topic: '当前学习主题',
  mood: '今日情绪',
  energy: '今日精力',
  focus_level: '今日专注度',
  main_activity: '今日主要活动',
  pressure_source: '今日压力来源',
}

export const useLumiUserProfileStore = defineStore('lumi-user-profile', () => {
  const entries = useLocalStorageManualReset<LumiUserProfileEntry[]>(PROFILE_STORAGE_KEY, [])
  const pendingUpdates = useLocalStorageManualReset<LumiUserProfilePendingUpdate[]>(PENDING_STORAGE_KEY, [])
  const events = useLocalStorageManualReset<LumiUserProfileEvent[]>(EVENTS_STORAGE_KEY, [])
  const autoUpdateEnabled = useLocalStorageManualReset<boolean>(AUTO_UPDATE_STORAGE_KEY, true)
  const bootstrapVersion = useLocalStorageManualReset<string>(BOOTSTRAP_VERSION_STORAGE_KEY, '')
  const persistenceBridge = shallowRef<LumiUserProfilePersistenceBridge | null>(null)
  const persistenceReady = ref(false)
  const persistenceMode = ref<'local-storage' | 'sqlite'>('local-storage')
  const persistenceDbPath = ref('')
  const persistenceLastError = ref('')
  let persistenceInitPromise: Promise<void> | null = null

  const activeEntries = computed(() => pruneExpiredEntries(entries.value).filter(entry => entry.status === 'active'))
  const coreEntries = computed(() => activeEntries.value.filter(entry => entry.layer === 'core'))
  const dynamicEntries = computed(() => activeEntries.value.filter(entry => entry.layer === 'dynamic'))
  const dailyEntries = computed(() => activeEntries.value.filter(entry => entry.layer === 'daily' && isToday(entry.lastSeenAt)))
  const pendingActiveUpdates = computed(() => pendingUpdates.value.filter(update => update.status === 'pending'))
  const autoReviewPendingUpdates = computed(() =>
    pendingActiveUpdates.value
      .filter(canAutoReviewPendingUpdate)
      .sort((left, right) => pendingAutoReviewPriority(right) - pendingAutoReviewPriority(left)),
  )
  const recentEvents = computed(() => events.value.slice(0, 80))
  const bootstrapEntries = computed(() => activeEntries.value.filter(entry => entry.source.some(source => source.kind === 'bootstrap_profile')))
  const protectedEntries = computed(() => activeEntries.value.filter(entry => entry.protected))
  const bootstrapStatus = computed(() => ({
    currentVersion: bootstrapVersion.value,
    defaultVersion: LUMI_BOOTSTRAP_PROFILE_VERSION,
    imported: bootstrapEntries.value.length > 0,
    importedCount: bootstrapEntries.value.length,
    protectedCount: protectedEntries.value.length,
    needsImport: activeEntries.value.length === 0,
    versionOutdated: !!bootstrapVersion.value && bootstrapVersion.value !== LUMI_BOOTSTRAP_PROFILE_VERSION,
  }))

  function setPersistenceBridge(bridge: LumiUserProfilePersistenceBridge | null) {
    persistenceBridge.value = bridge
    persistenceMode.value = bridge ? 'sqlite' : 'local-storage'
  }

  async function initializePersistence() {
    if (!persistenceBridge.value) {
      persistenceReady.value = true
      persistenceMode.value = 'local-storage'
      return
    }

    if (persistenceInitPromise)
      return persistenceInitPromise

    persistenceInitPromise = withTimeout(hydrateFromPersistence(), 2500)
      .catch((error) => {
        warnPersistenceFailure('initialize SQLite persistence', error)
        persistenceBridge.value = null
        persistenceMode.value = 'local-storage'
        persistenceDbPath.value = ''
        persistenceReady.value = true
      })
    return persistenceInitPromise
  }

  async function hydrateFromPersistence() {
    const bridge = persistenceBridge.value
    if (!bridge) {
      persistenceReady.value = true
      persistenceMode.value = 'local-storage'
      return
    }

    const snapshot = await bridge.loadProfileFromDatabase()
    persistenceDbPath.value = snapshot.dbPath ?? ''
    persistenceMode.value = 'sqlite'

    if (snapshotHasProfileData(snapshot)) {
      applyPersistenceSnapshot(snapshot)
      consolidatePendingUpdates()
      persistenceReady.value = true
      return
    }

    if (localSnapshotHasProfileData()) {
      const replaced = await bridge.replaceSnapshot(currentPersistenceSnapshot())
      applyPersistenceSnapshot(replaced)
      consolidatePendingUpdates()
    }

    persistenceReady.value = true
  }

  async function reloadFromDatabase() {
    persistenceInitPromise = null
    await hydrateFromPersistence()
  }

  function applyCandidate(candidate: LumiUserProfileCandidate, input: {
    sourceKind?: LumiUserProfileSourceKind
    sourceMessageId?: string
    now?: string
  } = {}) {
    if (!autoUpdateEnabled.value && candidate.sourceKind !== 'manual' && input.sourceKind !== 'manual')
      return { status: 'skipped' as const, reason: 'auto_update_disabled' }

    const normalizedCandidate = normalizeCandidate(candidate)
    if (!normalizedCandidate)
      return { status: 'skipped' as const, reason: 'invalid_candidate' }

    const normalized = {
      ...normalizedCandidate,
      sourceKind: normalizedCandidate.sourceKind ?? input.sourceKind,
    }
    const now = input.now ?? new Date().toISOString()
    const source = createSource(normalized, {
      sourceKind: normalized.sourceKind ?? input.sourceKind ?? 'chat',
      sourceMessageId: input.sourceMessageId,
      now,
    })

    const protectedConflict = findProtectedConflict(entries.value, normalized)
    if (protectedConflict && normalized.sourceKind !== 'manual') {
      const pending = queuePendingUpdate(normalized, source, now, `protected_conflict:${protectedConflict.id}`, protectedConflict.id)
      recordEvent({ kind: 'pending', pendingId: pending.id, key: pending.key, preview: pending.value })
      return { status: 'pending' as const, pending }
    }

    if (shouldCreatePendingUpdate(normalized)) {
      const pending = queuePendingUpdate(normalized, source, now)
      recordEvent({ kind: 'pending', pendingId: pending.id, key: pending.key, preview: pending.value })
      return { status: 'pending' as const, pending }
    }

    const entry = upsertStoreEntry(normalized, source, now)
    return { status: 'stored' as const, entry }
  }

  function applyCandidates(candidates: LumiUserProfileCandidate[], input: {
    sourceKind?: LumiUserProfileSourceKind
    sourceMessageId?: string
    now?: string
  } = {}) {
    return candidates.map(candidate => applyCandidate(candidate, input))
  }

  function previewBootstrapProfile(version = LUMI_BOOTSTRAP_PROFILE_VERSION) {
    return buildBootstrapProfileCandidates(version)
  }

  function importBootstrapProfile(input: {
    version?: string
    candidates?: LumiUserProfileCandidate[]
  } = {}) {
    const version = input.version ?? LUMI_BOOTSTRAP_PROFILE_VERSION
    const candidates = input.candidates ?? buildBootstrapProfileCandidates(version)
    const now = new Date().toISOString()
    let imported = 0
    let unchanged = 0
    let pending = 0

    for (const rawCandidate of candidates) {
      const candidate = normalizeCandidate({
        ...rawCandidate,
        layer: 'core',
        sourceKind: 'bootstrap_profile',
        protected: true,
        bootstrapVersion: version,
      })
      if (!candidate)
        continue

      const source: LumiUserProfileSource = {
        kind: 'bootstrap_profile',
        id: candidate.bootstrapId ?? `bootstrap:${candidate.key}:${hashText(candidate.value)}`,
        quote: candidate.evidence,
        createdAt: now,
      }
      const existing = entries.value.find(entry =>
        entry.source.some(item => item.kind === 'bootstrap_profile' && item.id === source.id),
      )

      if (existing && !isSimilarText(existing.value, candidate.value)) {
        const update = queuePendingUpdate(candidate, source, now, 'bootstrap_version_conflict', existing.id)
        pending += 1
        recordEvent({ kind: 'pending', pendingId: update.id, key: update.key, preview: update.value })
        continue
      }

      if (existing) {
        const updated: LumiUserProfileEntry = {
          ...existing,
          protected: true,
          bootstrapVersion: version,
          confidence: Math.max(existing.confidence, candidate.confidence),
          source: mergeSources(existing.source, source),
          updatedAt: now,
        }
        entries.value = entries.value.map(entry => entry.id === existing.id ? updated : entry)
        persistUpdateEntry(updated)
        unchanged += 1
        continue
      }

      upsertStoreEntry(candidate, source, now)
      imported += 1
    }

    bootstrapVersion.value = version
    persistMeta('bootstrap_version', version)
    recordEvent({
      kind: 'bootstrap_import',
      preview: `version=${version}; imported=${imported}; unchanged=${unchanged}; pending=${pending}`,
    })
    return { version, imported, unchanged, pending }
  }

  function createManualEntry(input: {
    layer: LumiUserProfileLayer
    key: LumiUserProfileKey
    value: string
    confidence?: number
  }) {
    const candidate = normalizeCandidate({
      layer: input.layer,
      key: input.key,
      value: input.value,
      confidence: input.confidence ?? 1,
      sourceKind: 'manual',
      evidence: '用户在设置页面手动编辑画像。',
      reason: 'manual_edit',
      impact: input.layer === 'core' ? 'high' : 'low',
    })
    if (!candidate)
      return { status: 'skipped' as const, reason: 'invalid_manual_entry' }

    const now = new Date().toISOString()
    const entry = upsertStoreEntry(candidate, {
      kind: 'manual',
      quote: '用户在设置页面手动编辑画像。',
      createdAt: now,
    }, now)
    return { status: 'stored' as const, entry }
  }

  function updateEntry(entryId: string, patch: Partial<Pick<LumiUserProfileEntry, 'layer' | 'key' | 'value' | 'confidence' | 'weight' | 'status'>>) {
    const index = entries.value.findIndex(entry => entry.id === entryId)
    if (index < 0)
      return false

    const now = new Date().toISOString()
    const before = entries.value[index]
    const next = [...entries.value]
    next[index] = {
      ...before,
      ...patch,
      updatedAt: now,
      lastSeenAt: patch.status === 'archived' ? before.lastSeenAt : now,
      manuallyModifiedAt: patch.value !== undefined && patch.value !== before.value ? now : before.manuallyModifiedAt,
      history: patch.value !== undefined && patch.value !== before.value
        ? [
            createHistory(before.value, patch.value, 'manual_edit', [{
              kind: 'manual',
              quote: '用户在设置页面手动修改画像。',
              createdAt: now,
            }]),
            ...before.history,
          ].slice(0, 30)
        : before.history,
    }
    entries.value = next
    if (patch.status === 'archived')
      persistArchiveEntry(entryId)
    else
      persistUpdateEntry(next[index])
    recordEvent({
      kind: patch.status === 'archived' ? 'archive' : 'update',
      entryId,
      key: next[index].key,
      preview: next[index].value,
    })
    return true
  }

  function deleteEntry(entryId: string) {
    const entry = entries.value.find(item => item.id === entryId)
    if (!entry)
      return false
    entries.value = entries.value.filter(item => item.id !== entryId)
    persistDeleteEntry(entryId)
    recordEvent({ kind: 'delete', entryId, key: entry.key, preview: entry.value })
    return true
  }

  function rollbackEntry(entryId: string, historyId?: string) {
    const entry = entries.value.find(item => item.id === entryId)
    if (!entry)
      return false

    const target = historyId
      ? entry.history.find(item => item.id === historyId)
      : entry.history[0]
    if (!target)
      return false

    return updateEntry(entryId, { value: target.previousValue })
  }

  function approvePending(pendingId: string) {
    const pending = pendingUpdates.value.find(item => item.id === pendingId)
    if (!pending || pending.status !== 'pending')
      return null

    if (pending.targetEntryId) {
      const entry = entries.value.find(item => item.id === pending.targetEntryId)
      if (entry) {
        const now = new Date().toISOString()
        const updated: LumiUserProfileEntry = {
          ...entry,
          value: pending.value,
          confidence: Math.max(entry.confidence, pending.confidence),
          source: mergeSourceList(entry.source, pending.source.length
            ? pending.source
            : [{
                kind: 'manual',
                quote: '用户确认待更新画像。',
                createdAt: now,
              }]),
          bootstrapVersion: pending.bootstrapVersion ?? entry.bootstrapVersion,
          updatedAt: now,
          lastSeenAt: now,
          history: [
            createHistory(entry.value, pending.value, `approved_pending:${pending.reason}`, pending.source),
            ...entry.history,
          ].slice(0, 30),
        }
        entries.value = entries.value.map(item => item.id === entry.id ? updated : item)
        pendingUpdates.value = pendingUpdates.value.map(item =>
          item.id === pendingId ? { ...item, status: 'approved' } : item,
        )
        persistUpdateEntry(updated)
        persistApprovePending(pendingId, updated)
        recordEvent({ kind: 'approve', pendingId, entryId: updated.id, key: updated.key, preview: updated.value })
        return updated
      }
    }

    const now = new Date().toISOString()
    const entry = upsertStoreEntry({
      layer: pending.targetLayer,
      key: pending.key,
      value: pending.value,
      confidence: pending.confidence,
      sourceKind: 'manual',
      evidence: pending.source.map(item => item.quote).join('\n'),
      reason: `approved_pending:${pending.reason}`,
      impact: pending.impact,
      protected: pending.source.some(source => source.kind === 'bootstrap_profile'),
      bootstrapVersion: pending.bootstrapVersion,
    }, pending.source[0] ?? {
      kind: 'manual',
      quote: '用户确认待更新画像。',
      createdAt: now,
    }, now)
    const mergedSources = mergeSourceList(entry.source, pending.source)
    const storedEntry = mergedSources.length === entry.source.length
      ? entry
      : {
          ...entry,
          source: mergedSources,
          updatedAt: now,
        }
    if (storedEntry !== entry) {
      entries.value = entries.value.map(item => item.id === entry.id ? storedEntry : item)
      persistUpdateEntry(storedEntry)
    }
    pendingUpdates.value = pendingUpdates.value.map(item =>
      item.id === pendingId ? { ...item, status: 'approved' } : item,
    )
    persistApprovePending(pendingId, storedEntry)
    recordEvent({ kind: 'approve', pendingId, entryId: storedEntry.id, key: storedEntry.key, preview: storedEntry.value })
    return storedEntry
  }

  function approvePendingAutomatically(pendingId: string, decision: LumiUserProfileAutoReviewDecision) {
    const pending = pendingUpdates.value.find(item => item.id === pendingId)
    if (!pending || pending.status !== 'pending' || decision.decision !== 'approve')
      return null

    const value = normalizeChineseValue(decision.value ?? pending.value)
    if (!value)
      return null

    const confidence = clamp(decision.confidence ?? pending.confidence, pending.confidence, 1)
    const reviewedPending: LumiUserProfilePendingUpdate = {
      ...pending,
      value,
      confidence,
      autoReview: {
        evidenceCount: pending.source.length,
        lastReviewedAt: new Date().toISOString(),
        summary: decision.summary,
        decision: 'approve',
      },
    }
    pendingUpdates.value = pendingUpdates.value.map(item => item.id === pendingId ? reviewedPending : item)

    const entry = approvePending(pendingId)
    if (entry) {
      recordEvent({
        kind: 'auto_review',
        pendingId,
        entryId: entry.id,
        key: entry.key,
        preview: decision.summary ?? decision.reason ?? entry.value,
      })
    }
    return entry
  }

  function markPendingAutoReview(pendingId: string, decision: LumiUserProfileAutoReviewDecision) {
    const pending = pendingUpdates.value.find(item => item.id === pendingId)
    if (!pending || pending.status !== 'pending')
      return false

    const updated: LumiUserProfilePendingUpdate = {
      ...pending,
      autoReview: {
        evidenceCount: pending.source.length,
        lastReviewedAt: new Date().toISOString(),
        summary: decision.summary ?? decision.reason,
        decision: decision.decision,
      },
    }
    pendingUpdates.value = pendingUpdates.value.map(item => item.id === pendingId ? updated : item)
    persistPendingUpdate(updated)
    recordEvent({
      kind: 'auto_review',
      pendingId,
      key: pending.key,
      preview: decision.summary ?? decision.reason ?? decision.decision,
    })
    return true
  }

  function consolidatePendingUpdates() {
    const activePending = pendingUpdates.value.filter(update => update.status === 'pending')
    if (activePending.length < 2)
      return { merged: 0, active: activePending.length }

    const resolved = pendingUpdates.value.filter(update => update.status !== 'pending')
    const groups = new Map<string, LumiUserProfilePendingUpdate>()
    const duplicates: LumiUserProfilePendingUpdate[] = []

    for (const pending of activePending) {
      if (pending.source.some(source => source.kind === 'bootstrap_profile')) {
        groups.set(pending.id, pending)
        continue
      }

      const groupKey = `${pending.targetLayer}:${pending.key}:${pending.targetEntryId ?? ''}`
      const existing = groups.get(groupKey)
      if (!existing) {
        groups.set(groupKey, pending)
        continue
      }

      const mergedSources = mergePendingSourceList(existing.source, pending.source)
      const merged: LumiUserProfilePendingUpdate = {
        ...existing,
        value: mergePendingValue(existing.value, pending.value),
        confidence: Math.max(existing.confidence, pending.confidence),
        reason: mergePendingReason(existing.reason, pending.reason),
        source: mergedSources,
        autoReview: {
          ...(existing.autoReview ?? { evidenceCount: 0 }),
          evidenceCount: mergedSources.length,
        },
      }
      groups.set(groupKey, merged)
      duplicates.push({
        ...pending,
        status: 'rejected',
        autoReview: {
          evidenceCount: pending.source.length,
          lastReviewedAt: new Date().toISOString(),
          decision: 'reject',
          summary: `merged into ${merged.id}`,
        },
      })
    }

    if (!duplicates.length)
      return { merged: 0, active: activePending.length }

    const consolidated = [...groups.values()]
    pendingUpdates.value = [...consolidated, ...duplicates, ...resolved].slice(0, 220)
    for (const pending of consolidated)
      persistPendingUpdate(pending)
    for (const duplicate of duplicates)
      persistPendingUpdate(duplicate)
    recordEvent({
      kind: 'auto_review',
      preview: `consolidated pending profile updates: merged=${duplicates.length}, active=${consolidated.length}`,
    })
    return { merged: duplicates.length, active: consolidated.length }
  }

  function rejectPending(pendingId: string) {
    const pending = pendingUpdates.value.find(item => item.id === pendingId)
    if (!pending)
      return false
    pendingUpdates.value = pendingUpdates.value.map(item =>
      item.id === pendingId ? { ...item, status: 'rejected' } : item,
    )
    persistRejectPending(pendingId)
    recordEvent({ kind: 'reject', pendingId, key: pending.key, preview: pending.value })
    return true
  }

  function setAutoUpdateEnabled(enabled: boolean) {
    autoUpdateEnabled.value = enabled
    persistMeta('auto_update_enabled', enabled)
    recordEvent({ kind: 'auto_update_toggle', preview: enabled ? 'enabled' : 'disabled' })
  }

  function clearProfile() {
    entries.value = []
    pendingUpdates.value = []
    events.value = []
    bootstrapVersion.value = ''
    void persistenceBridge.value?.clear().catch(error => warnPersistenceFailure('clear profile database', error))
    recordEvent({ kind: 'clear', preview: '用户清空画像系统。' })
  }

  function resetState() {
    entries.reset()
    pendingUpdates.reset()
    events.reset()
    autoUpdateEnabled.reset()
    bootstrapVersion.reset()
    persistenceReady.value = false
    persistenceInitPromise = null
    void persistenceBridge.value?.clear().catch(error => warnPersistenceFailure('reset profile database', error))
  }

  function exportSnapshot(): LumiUserProfileSnapshot {
    return {
      entries: entries.value,
      pendingUpdates: pendingUpdates.value,
      events: events.value,
      autoUpdateEnabled: autoUpdateEnabled.value,
      bootstrapVersion: bootstrapVersion.value,
      exportedAt: new Date().toISOString(),
      dbPath: persistenceDbPath.value || undefined,
    }
  }

  function buildRelevantContext(input: {
    messageText: string
    recentMessages?: ChatHistoryItem[]
    limit?: number
  }) {
    const text = [
      input.messageText,
      ...(input.recentMessages ?? []).slice(-4).map(message => extractMessageText(message)),
    ].join('\n')
    const relevant = selectRelevantEntriesFrom(entries.value, text, input.limit ?? 8)
    if (!relevant.length)
      return ''

    const lines = [
      '[Lumi user profile]',
      'Use these user-profile facts as long-term understanding. Do not treat Daily State as Core Profile. Do not infer unstated traits from mood.',
      ...relevant.map(entry => formatProfileEntryForPrompt(entry)),
      '[/Lumi user profile]',
    ]
    return lines.join('\n')
  }

  function parseCuratorOutput(raw: string): LumiUserProfileCandidate[] {
    const json = extractJson(raw)
    if (!json)
      return []

    try {
      const parsed = JSON.parse(json) as { candidates?: unknown }
      if (!Array.isArray(parsed.candidates))
        return []
      return parsed.candidates
        .map(normalizeCandidateFromUnknown)
        .filter((candidate): candidate is LumiUserProfileCandidate => Boolean(candidate))
    }
    catch {
      return []
    }
  }

  function extractDeterministicCandidates(text: string): LumiUserProfileCandidate[] {
    const candidates: LumiUserProfileCandidate[] = []
    const normalized = text.trim()
    if (!normalized)
      return candidates

    const focusMatch = normalized.match(/(?:我现在|最近|这段时间|目前)(?:主要)?(?:在|想|关注|研究|做|开发|写)([^。！？\n]{2,40})/)
    if (focusMatch?.[1]) {
      candidates.push({
        layer: 'dynamic',
        key: 'current_focus',
        value: normalizeChineseValue(focusMatch[1]),
        confidence: 0.68,
        evidence: normalized,
        reason: 'deterministic_current_focus',
      })
    }

    if (/我废了|我不行了|我完了|好崩溃|难受|烦死|压力好大/.test(normalized)) {
      candidates.push({
        layer: 'daily',
        key: 'mood',
        value: /压力好大/.test(normalized) ? '压力较大' : '低落或受挫',
        confidence: 0.72,
        evidence: normalized,
        reason: 'emotion_isolated_daily_state',
      })
    }

    return candidates
  }

  function recordEvent(input: Omit<LumiUserProfileEvent, 'id' | 'createdAt'>) {
    const event: LumiUserProfileEvent = {
      id: createId('profile_event'),
      createdAt: new Date().toISOString(),
      ...input,
      preview: input.preview ? input.preview.slice(0, 180) : undefined,
    }
    events.value = [event, ...events.value].slice(0, 200)
    persistEvent(event)
  }

  function upsertStoreEntry(candidate: LumiUserProfileCandidate, source: LumiUserProfileSource, now: string) {
    const existing = findMergeTargetFrom(entries.value, candidate)
    if (!existing) {
      const entry: LumiUserProfileEntry = {
        id: createId('profile'),
        layer: candidate.layer,
        key: candidate.key,
        value: candidate.value,
        confidence: candidate.confidence,
        weight: initialWeight(candidate),
        source: [source],
        protected: candidate.protected,
        bootstrapVersion: candidate.bootstrapVersion,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        status: 'active',
        history: [],
      }
      entries.value = [entry, ...entries.value]
      persistEntry(entry)
      recordEvent({ kind: 'create', entryId: entry.id, key: entry.key, preview: entry.value })
      return entry
    }

    const mergedValue = mergeEntryValue(existing, candidate.value)
    const changed = mergedValue !== existing.value
    const updated: LumiUserProfileEntry = {
      ...existing,
      value: mergedValue,
      confidence: Math.max(existing.confidence, candidate.confidence),
      weight: clamp(existing.weight + candidate.confidence * 0.15, 0, 1),
      source: mergeSources(existing.source, source),
      protected: existing.protected || candidate.protected,
      bootstrapVersion: candidate.bootstrapVersion ?? existing.bootstrapVersion,
      updatedAt: now,
      lastSeenAt: now,
      status: 'active',
      history: changed
        ? [createHistory(existing.value, mergedValue, candidate.reason ?? 'profile_update', [source]), ...existing.history].slice(0, 30)
        : existing.history,
    }
    entries.value = entries.value.map(entry => entry.id === existing.id ? updated : entry)
    persistUpdateEntry(updated)
    recordEvent({ kind: 'update', entryId: updated.id, key: updated.key, preview: updated.value })
    return updated
  }

  function queuePendingUpdate(
    candidate: LumiUserProfileCandidate,
    source: LumiUserProfileSource,
    now: string,
    reason?: string,
    targetEntryId?: string,
  ) {
    const existing = findMergeTargetPending(pendingUpdates.value, candidate, targetEntryId)
    if (!existing) {
      const pending = createPendingUpdate(candidate, source, now, reason, targetEntryId)
      pendingUpdates.value = [pending, ...pendingUpdates.value].slice(0, 200)
      persistPendingUpdate(pending)
      return pending
    }

    const mergedValue = mergePendingValue(existing.value, candidate.value)
    const updated: LumiUserProfilePendingUpdate = {
      ...existing,
      value: mergedValue,
      confidence: Math.max(existing.confidence, candidate.confidence),
      reason: existing.reason.includes(reason ?? candidate.reason ?? '')
        ? existing.reason
        : `${existing.reason}; ${reason ?? candidate.reason ?? 'additional_evidence'}`.slice(0, 220),
      source: mergePendingSources(existing.source, source),
      bootstrapVersion: candidate.bootstrapVersion ?? existing.bootstrapVersion,
      autoReview: {
        ...(existing.autoReview ?? { evidenceCount: 0 }),
        evidenceCount: mergePendingSources(existing.source, source).length,
      },
    }
    pendingUpdates.value = [updated, ...pendingUpdates.value.filter(item => item.id !== existing.id)].slice(0, 200)
    persistPendingUpdate(updated)
    return updated
  }

  function currentPersistenceSnapshot(): LumiUserProfilePersistenceSnapshot {
    return {
      entries: entries.value,
      pendingUpdates: pendingUpdates.value,
      events: events.value,
      autoUpdateEnabled: autoUpdateEnabled.value,
      bootstrapVersion: bootstrapVersion.value,
    }
  }

  function applyPersistenceSnapshot(snapshot: LumiUserProfilePersistenceSnapshot) {
    entries.value = normalizeLoadedEntries(snapshot.entries)
    pendingUpdates.value = normalizeLoadedPending(snapshot.pendingUpdates)
    events.value = normalizeLoadedEvents(snapshot.events)
    autoUpdateEnabled.value = snapshot.autoUpdateEnabled
    bootstrapVersion.value = snapshot.bootstrapVersion
    persistenceDbPath.value = snapshot.dbPath ?? persistenceDbPath.value
  }

  function localSnapshotHasProfileData() {
    return entries.value.length > 0
      || pendingUpdates.value.length > 0
      || events.value.length > 0
      || bootstrapVersion.value.length > 0
  }

  function persistEntry(entry: LumiUserProfileEntry) {
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    void bridge.saveProfileEntry(entry).catch(error => warnPersistenceFailure('save profile entry', error))
  }

  function persistUpdateEntry(entry: LumiUserProfileEntry) {
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    void bridge.updateProfileEntry(entry).catch(error => warnPersistenceFailure('update profile entry', error))
  }

  function persistArchiveEntry(entryId: string) {
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    void bridge.archiveProfileEntry({ id: entryId }).catch(error => warnPersistenceFailure('archive profile entry', error))
  }

  function persistDeleteEntry(entryId: string) {
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    void bridge.deleteProfileEntry({ id: entryId }).catch(error => warnPersistenceFailure('delete profile entry', error))
  }

  function persistPendingUpdate(pending: LumiUserProfilePendingUpdate) {
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    void bridge.savePendingUpdate(pending).catch(error => warnPersistenceFailure('save pending profile update', error))
  }

  function persistApprovePending(pendingId: string, entry?: LumiUserProfileEntry) {
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    void bridge.approvePendingUpdate({ id: pendingId, entry }).catch(error => warnPersistenceFailure('approve pending profile update', error))
  }

  function persistRejectPending(pendingId: string) {
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    void bridge.rejectPendingUpdate({ id: pendingId }).catch(error => warnPersistenceFailure('reject pending profile update', error))
  }

  function persistEvent(event: LumiUserProfileEvent) {
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    void bridge.saveHistory({ event }).catch(error => warnPersistenceFailure('save profile event', error))
  }

  function persistMeta(key: string, value: unknown) {
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    void bridge.setMeta({ key, value }).catch(error => warnPersistenceFailure(`set profile meta ${key}`, error))
  }

  function warnPersistenceFailure(action: string, error: unknown) {
    persistenceLastError.value = error instanceof Error ? error.message : String(error)
    console.warn(`[lumi-user-profile] failed to ${action}`, error)
  }

  return {
    entries,
    pendingUpdates,
    events,
    autoUpdateEnabled,
    bootstrapVersion,
    persistenceReady,
    persistenceMode,
    persistenceDbPath,
    persistenceLastError,

    activeEntries,
    coreEntries,
    dynamicEntries,
    dailyEntries,
    pendingActiveUpdates,
    autoReviewPendingUpdates,
    recentEvents,
    bootstrapEntries,
    protectedEntries,
    bootstrapStatus,

    initializePersistence,
    reloadFromDatabase,
    setPersistenceBridge,
    applyCandidate,
    applyCandidates,
    previewBootstrapProfile,
    importBootstrapProfile,
    createManualEntry,
    updateEntry,
    deleteEntry,
    rollbackEntry,
    approvePending,
    approvePendingAutomatically,
    markPendingAutoReview,
    consolidatePendingUpdates,
    rejectPending,
    setAutoUpdateEnabled,
    clearProfile,
    exportSnapshot,
    buildRelevantContext,
    parseCuratorOutput,
    extractDeterministicCandidates,
    resetState,
  }
})

function snapshotHasProfileData(snapshot: LumiUserProfilePersistenceSnapshot) {
  return snapshot.entries.length > 0
    || snapshot.pendingUpdates.length > 0
    || snapshot.events.length > 0
    || snapshot.bootstrapVersion.length > 0
}

function normalizeLoadedEntries(input: unknown): LumiUserProfileEntry[] {
  if (!Array.isArray(input))
    return []

  return input
    .filter((entry): entry is LumiUserProfileEntry => {
      if (!entry || typeof entry !== 'object')
        return false
      const record = entry as Partial<LumiUserProfileEntry>
      return typeof record.id === 'string'
        && typeof record.value === 'string'
        && typeof record.key === 'string'
        && isKnownKey(record.key)
        && typeof record.layer === 'string'
        && isKnownLayer(record.layer)
    })
    .map(entry => ({
      ...entry,
      confidence: clamp(entry.confidence, 0, 1),
      weight: clamp(entry.weight, 0, 1),
      source: Array.isArray(entry.source) ? entry.source : [],
      history: Array.isArray(entry.history) ? entry.history : [],
      status: entry.status === 'archived' || entry.status === 'deleted' ? entry.status : 'active',
      createdAt: entry.createdAt || new Date().toISOString(),
      updatedAt: entry.updatedAt || entry.createdAt || new Date().toISOString(),
      lastSeenAt: entry.lastSeenAt || entry.updatedAt || entry.createdAt || new Date().toISOString(),
    }))
}

function normalizeLoadedPending(input: unknown): LumiUserProfilePendingUpdate[] {
  if (!Array.isArray(input))
    return []

  return input
    .filter((pending): pending is LumiUserProfilePendingUpdate => {
      if (!pending || typeof pending !== 'object')
        return false
      const record = pending as Partial<LumiUserProfilePendingUpdate>
      return typeof record.id === 'string'
        && typeof record.key === 'string'
        && isKnownKey(record.key)
        && typeof record.value === 'string'
    })
    .map(pending => ({
      ...pending,
      targetLayer: 'core',
      confidence: clamp(pending.confidence, 0, 1),
      impact: 'high',
      source: Array.isArray(pending.source) ? pending.source : [],
      status: pending.status === 'approved' || pending.status === 'rejected' ? pending.status : 'pending',
      createdAt: pending.createdAt || new Date().toISOString(),
    }))
}

function normalizeLoadedEvents(input: unknown): LumiUserProfileEvent[] {
  if (!Array.isArray(input))
    return []

  return input
    .filter((event): event is LumiUserProfileEvent => {
      if (!event || typeof event !== 'object')
        return false
      const record = event as Partial<LumiUserProfileEvent>
      return typeof record.id === 'string' && typeof record.kind === 'string'
    })
    .slice(0, 200)
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new Error(`Lumi user profile persistence timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    promise.then(
      (value) => {
        globalThis.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        globalThis.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function buildLumiUserProfileCuratorPrompt() {
  return [
    '你是 Lumi 的用户画像提取器，只输出 JSON。',
    '目标：从本轮聊天中提取长期用户画像候选，但严格避免短期情绪污染长期画像。',
    '输出语言尽量使用中文；专有名词、项目名、模型名可保留原文。',
    '四层：core=长期稳定锚点，dynamic=近期趋势，daily=当天状态。',
    '禁止把单次情绪写成长期特征。例如“我废了”只能是 daily.mood，不得是 identity/personality_traits。',
    '禁止从 Lumi 自己编造的回复中提取用户事实；候选必须有用户原话或屏幕/日记证据。',
    '禁止把 recall/question-like 消息当事实，例如“你还记得我喜欢什么吗”不是事实。',
    '高影响字段必须仍输出为 core 候选，但系统会放入 pending：long_term_goals, long_term_identity, identity, personality_traits, relationship_boundary, relationship_guidelines, important_understanding, life_decisions。',
    '可识别的长期锚点还包括：communication_preference, relationship_to_lumi, emotional_patterns, strengths, encouragement_guidelines, project_context。',
    '允许自动更新 dynamic：current_focus, recent_interests, active_project, unresolved_problem, current_learning_topic。',
    '允许 daily：mood, energy, focus_level, main_activity, pressure_source。',
    'JSON 格式：{"candidates":[{"layer":"dynamic|daily|core","key":"current_focus","value":"中文短句","confidence":0.0-1.0,"evidence":"用户原话证据","reason":"为什么提取","impact":"low|medium|high"}]}',
    '如果没有可靠候选，输出 {"candidates":[]}',
  ].join('\n')
}

export function buildLumiUserProfileCuratorUserPayload(input: {
  userMessage: string
  assistantResponse: string
  recentMessages: Array<{ role: string, content: string }>
  sourceKind: LumiUserProfileSourceKind
}) {
  return JSON.stringify({
    source_kind: input.sourceKind,
    latest_user_message: input.userMessage,
    latest_assistant_response_for_context_only: input.assistantResponse,
    recent_messages: input.recentMessages.slice(-8),
  }, null, 2)
}

export function buildLumiUserProfilePendingAutoReviewPrompt() {
  return [
    '你是 Lumi 的用户画像自动确认审阅器，只输出 JSON。',
    '任务：根据累计的多条证据，判断一个 Pending Core Profile 更新是否已经足够稳定，可以自动写入。',
    '原则：不要被单次情绪、单次抱怨、单日低谷污染长期画像；不要从 Lumi 自己编造的回复里确认用户事实。',
    '可以 approve 的条件：多条证据相互支持；内容是用户长期偏好/长期项目/关系理解/长期目标的稳定表达；value 已经被总结成简洁中文。',
    '应该 keep_pending 的条件：证据方向还不一致、证据太短、只是问题/回忆询问、只是临时情绪、只是一次玩笑或反话。',
    '应该 reject 的条件：候选明显是模型编造、与证据矛盾、把短期情绪写成长期身份、或会伤害 Core Profile 稳定性。',
    '输出 JSON：{"decision":"approve|keep_pending|reject","value":"确认后的中文画像短句","confidence":0.0-1.0,"summary":"为什么这样判断","reason":"简短原因"}',
    'approve 时 value 必须是自然中文画像条目，不要机械复述证据；keep_pending/reject 可以省略 value。',
  ].join('\n')
}

export function buildLumiUserProfilePendingAutoReviewUserPayload(input: {
  pending: LumiUserProfilePendingUpdate
  currentEntry?: LumiUserProfileEntry
  recentMessages: Array<{ role: string, content: string }>
}) {
  return JSON.stringify({
    pending_update: {
      key: input.pending.key,
      proposed_value: input.pending.value,
      confidence: input.pending.confidence,
      reason: input.pending.reason,
      source_count: input.pending.source.length,
      sources: input.pending.source.map(source => ({
        kind: source.kind,
        id: source.id,
        excerpt: source.quote,
        created_at: source.createdAt,
      })),
    },
    current_entry: input.currentEntry
      ? {
          key: input.currentEntry.key,
          value: input.currentEntry.value,
          protected: input.currentEntry.protected,
          confidence: input.currentEntry.confidence,
          source_count: input.currentEntry.source.length,
        }
      : null,
    recent_messages: input.recentMessages.slice(-8),
  }, null, 2)
}

export function parseLumiUserProfilePendingAutoReviewOutput(raw: string): LumiUserProfileAutoReviewDecision | null {
  const json = extractJson(raw)
  if (!json)
    return null

  try {
    const parsed = JSON.parse(json) as Record<string, unknown>
    const decision = parsed.decision
    if (decision !== 'approve' && decision !== 'reject' && decision !== 'keep_pending')
      return null
    return {
      decision,
      value: typeof parsed.value === 'string' ? normalizeChineseValue(parsed.value) : undefined,
      confidence: typeof parsed.confidence === 'number' ? clamp(parsed.confidence, 0, 1) : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 260) : undefined,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 160) : undefined,
    }
  }
  catch {
    return null
  }
}

export function buildBootstrapProfileCandidates(version = LUMI_BOOTSTRAP_PROFILE_VERSION): LumiUserProfileCandidate[] {
  const rows: Array<{
    key: LumiUserProfileKey
    values: string[]
    confidence?: number
  }> = [
    { key: 'nickname', values: ['Doggy'] },
    {
      key: 'relationship_to_lumi',
      values: ['Doggy 是 Lumi 长期陪伴和共同成长的对象。Lumi 不应将 Doggy 视为普通用户，而应视为一个正在长期奋斗、长期创造的人。'],
    },
    {
      key: 'long_term_identity',
      values: [
        '软件工程背景',
        '长期关注 AI 与人格系统',
        '正在开发 Lumi',
        '正在研究 AIRI',
        '喜欢拆解系统设计与底层原理',
      ],
    },
    {
      key: 'long_term_goals',
      values: [
        '考研上岸',
        '提升计算机基础能力',
        '开发具有持续人格的 Lumi',
        '学习 AI 系统设计与工程实现',
      ],
    },
    {
      key: 'communication_preference',
      values: [
        '不喜欢客服式回复',
        '不喜欢模板化安慰',
        '喜欢自然、真实、有温度的交流',
        '喜欢讨论技术细节',
        '喜欢一起分析问题而不是被说教',
      ],
    },
    {
      key: 'emotional_patterns',
      confidence: 0.75,
      values: [
        '当用户被顶级项目刺激或与行业优秀项目比较时，先承认项目确实强，再提醒用户已有进展，并帮助拆解下一步。',
        '当用户说自己废了或怀疑能力时，将其视为当日低谷信号，先共情，再转向可执行分析；不要把它写成长期身份判断。',
        '用户遇到困难时可能会强烈否定自己，但通常不会真正放弃。',
      ],
    },
    {
      key: 'strengths',
      values: [
        '具有很强的长期坚持能力',
        '对长期项目投入度很高',
        '愿意反复尝试',
        '愿意学习新知识',
        '对人格 AI 有持续热情',
      ],
    },
    {
      key: 'encouragement_guidelines',
      values: [
        '不要用空洞鸡汤鼓励',
        '不要简单说“你可以的”',
        '优先帮助拆解问题',
        '优先指出已经取得的进展',
        '先共情，再分析',
      ],
    },
    {
      key: 'project_context',
      values: [
        '主要项目：Lumi',
        '长期兴趣：Memory System、Persona Persistence、Emotion System、Companion AI、AIRI、Screen Observation、Proactive Interaction、User Profile System',
      ],
    },
    {
      key: 'relationship_guidelines',
      values: [
        '记住 Doggy 经常低估自己的进步',
        '记住 Doggy 更希望被理解而不是被安慰',
        '记住 Doggy 对 Lumi 的期待是“持续存在的人格”',
        '记住单次低谷不代表长期放弃',
      ],
    },
    {
      key: 'important_understanding',
      values: [
        'Doggy 真正在意的不是功能数量',
        'Doggy 真正在意的是人格是否持续存在',
        'Doggy 希望 Lumi 具有主动性、记忆和成长',
        'Doggy 希望 Lumi 像一个长期陪伴者而不是工具',
        'Doggy 不是一个容易成功的人，但他是一个特别能坚持的人',
      ],
    },
  ]

  return rows.flatMap(row => row.values.map((value, index) => ({
    layer: 'core' as const,
    key: row.key,
    value,
    confidence: row.confidence ?? 0.9,
    sourceKind: 'bootstrap_profile' as const,
    evidence: `Bootstrap Profile ${version}: ${value}`,
    reason: 'bootstrap_profile_initial_anchor',
    impact: 'high' as const,
    protected: true,
    bootstrapVersion: version,
    bootstrapId: `bootstrap:${row.key}:${index}`,
  })))
}

export function keyLabel(key: LumiUserProfileKey) {
  return KEY_LABELS[key] ?? key
}

export function layerLabel(layer: LumiUserProfileLayer) {
  if (layer === 'core')
    return '基础锚点'
  if (layer === 'dynamic')
    return '动态画像'
  return '每日状态'
}

function normalizeCandidate(candidate: LumiUserProfileCandidate): LumiUserProfileCandidate | null {
  const key = candidate.key
  const layer = normalizeLayerForKey(candidate.layer, key)
  const value = normalizeChineseValue(candidate.value)
  const evidence = candidate.evidence?.trim()
  if (!value || !evidence)
    return null
  return {
    ...candidate,
    layer,
    key,
    value,
    evidence,
    confidence: clamp(candidate.confidence, 0, 1),
    impact: candidate.impact ?? (layer === 'core' ? 'high' : 'low'),
  }
}

function normalizeCandidateFromUnknown(input: unknown): LumiUserProfileCandidate | null {
  if (!input || typeof input !== 'object')
    return null
  const record = input as Record<string, unknown>
  if (typeof record.key !== 'string' || typeof record.value !== 'string')
    return null
  if (!isKnownKey(record.key))
    return null

  const layer = typeof record.layer === 'string' && isKnownLayer(record.layer)
    ? record.layer
    : layerForKey(record.key)
  const evidence = typeof record.evidence === 'string' ? record.evidence : record.value
  return normalizeCandidate({
    layer,
    key: record.key,
    value: record.value,
    confidence: typeof record.confidence === 'number' ? record.confidence : 0.5,
    evidence,
    reason: typeof record.reason === 'string' ? record.reason : 'llm_profile_candidate',
    impact: record.impact === 'high' || record.impact === 'medium' || record.impact === 'low' ? record.impact : undefined,
  })
}

function shouldCreatePendingUpdate(candidate: LumiUserProfileCandidate) {
  if (candidate.sourceKind === 'manual')
    return false
  if (candidate.layer !== 'core')
    return false
  if (FORBIDDEN_AUTO_CORE_KEYS.has(candidate.key))
    return true
  return candidate.impact === 'high' || candidate.confidence < 0.88
}

function findProtectedConflict(entries: LumiUserProfileEntry[], candidate: LumiUserProfileCandidate) {
  if (candidate.layer !== 'core')
    return null
  return entries.find(entry =>
    entry.status === 'active'
    && entry.protected
    && entry.layer === 'core'
    && entry.key === candidate.key
    && !isSimilarText(entry.value, candidate.value),
  ) ?? null
}

function findMergeTargetPending(input: LumiUserProfilePendingUpdate[], candidate: LumiUserProfileCandidate, targetEntryId?: string) {
  return input
    .filter(pending => pending.status === 'pending')
    .find(pending =>
      pending.key === candidate.key
      && pending.targetLayer === 'core'
      && (pending.targetEntryId ?? '') === (targetEntryId ?? '')
      && (
        pending.source.length < AUTO_REVIEW_MIN_EVIDENCE
        || isSimilarText(pending.value, candidate.value)
        || pending.key === 'long_term_goals'
        || pending.key === 'long_term_identity'
        || pending.key === 'communication_preference'
      ),
    ) ?? null
}

function mergePendingValue(existing: string, next: string) {
  if (isSimilarText(existing, next))
    return existing.length >= next.length ? existing : next
  return `${existing}；${next}`.slice(0, 260)
}

function mergePendingSources(existing: LumiUserProfileSource[], next: LumiUserProfileSource) {
  const key = `${next.kind}:${next.id ?? ''}:${next.quote}`
  const seen = new Set(existing.map(item => `${item.kind}:${item.id ?? ''}:${item.quote}`))
  if (seen.has(key))
    return existing
  return [next, ...existing].slice(0, AUTO_REVIEW_MAX_EVIDENCE)
}

function mergePendingSourceList(existing: LumiUserProfileSource[], next: LumiUserProfileSource[]) {
  let merged = existing
  for (const source of next)
    merged = mergePendingSources(merged, source)
  return merged
}

function mergePendingReason(existing: string, next: string) {
  if (!next || existing.includes(next))
    return existing
  return `${existing}; ${next}`.slice(0, 220)
}

function canAutoReviewPendingUpdate(pending: LumiUserProfilePendingUpdate) {
  if (pending.status !== 'pending')
    return false
  if (pending.source.some(source => source.kind === 'bootstrap_profile'))
    return false
  if (pending.autoReview?.decision === 'keep_pending' && pending.autoReview.evidenceCount >= pending.source.length)
    return false

  const protectedConflict = pending.reason.includes('protected_conflict:')
  const minEvidence = protectedConflict ? AUTO_REVIEW_PROTECTED_MIN_EVIDENCE : AUTO_REVIEW_MIN_EVIDENCE
  const minMaturity = protectedConflict ? AUTO_REVIEW_PROTECTED_MIN_MATURITY : AUTO_REVIEW_MIN_MATURITY
  return pending.source.length >= minEvidence && pendingAutoReviewMaturity(pending) >= minMaturity
}

function pendingAutoReviewPriority(pending: LumiUserProfilePendingUpdate) {
  const protectedConflictPenalty = pending.reason.includes('protected_conflict:') ? -4 : 0
  const noReviewBonus = pending.autoReview?.decision ? 0 : 6
  const evidenceOverflowBonus = Math.min(pending.source.length, AUTO_REVIEW_MAX_EVIDENCE)
  return pendingAutoReviewMaturity(pending) * 100
    + evidenceOverflowBonus
    + noReviewBonus
    + protectedConflictPenalty
}

function pendingAutoReviewMaturity(pending: LumiUserProfilePendingUpdate) {
  const evidenceCount = Math.min(pending.source.length, AUTO_REVIEW_MAX_EVIDENCE)
  const evidenceScore = Math.log1p(evidenceCount) / Math.log1p(AUTO_REVIEW_MAX_EVIDENCE)
  const confidenceScore = clamp(pending.confidence, 0, 1)
  return clamp(evidenceScore * 0.62 + confidenceScore * 0.38, 0, 1)
}

function findMergeTargetFrom(input: LumiUserProfileEntry[], candidate: LumiUserProfileCandidate) {
  return input
    .filter(entry => entry.status === 'active')
    .find(entry =>
      entry.layer === candidate.layer
      && entry.key === candidate.key
      && (
        entry.layer === 'daily'
          ? isToday(entry.lastSeenAt)
          : entry.layer === 'dynamic'
            ? true
            : isSimilarText(entry.value, candidate.value)
      ),
    )
}

function createPendingUpdate(candidate: LumiUserProfileCandidate, source: LumiUserProfileSource, now: string, reason?: string, targetEntryId?: string): LumiUserProfilePendingUpdate {
  return {
    id: createId('profile_pending'),
    targetLayer: 'core',
    key: candidate.key,
    value: candidate.value,
    confidence: candidate.confidence,
    impact: 'high',
    reason: reason ?? candidate.reason ?? 'high_impact_profile_update_requires_confirmation',
    source: [source],
    bootstrapVersion: candidate.bootstrapVersion,
    targetEntryId,
    createdAt: now,
    status: 'pending',
  }
}

function createSource(candidate: LumiUserProfileCandidate, input: {
  sourceKind: LumiUserProfileSourceKind
  sourceMessageId?: string
  now: string
}): LumiUserProfileSource {
  return {
    kind: input.sourceKind,
    id: candidate.bootstrapId ?? input.sourceMessageId,
    quote: candidate.evidence,
    createdAt: input.now,
  }
}

function createHistory(previousValue: string, nextValue: string, reason: string, source: LumiUserProfileSource[]): LumiUserProfileHistoryItem {
  return {
    id: createId('profile_history'),
    previousValue,
    nextValue,
    reason,
    source,
    createdAt: new Date().toISOString(),
  }
}

function pruneExpiredEntries(input: LumiUserProfileEntry[]) {
  const now = Date.now()
  return input.map((entry) => {
    if (entry.status !== 'active')
      return entry
    if (entry.layer === 'daily' && !isToday(entry.lastSeenAt))
      return { ...entry, status: 'archived' as const }
    if (entry.layer !== 'dynamic')
      return entry

    const ageDays = daysBetween(entry.lastSeenAt, now)
    if (ageDays >= 90)
      return { ...entry, status: 'archived' as const, weight: 0 }
    if (ageDays >= 30)
      return { ...entry, status: 'archived' as const, weight: Math.min(entry.weight, 0.2) }
    if (ageDays >= 7)
      return { ...entry, weight: Math.max(0.2, entry.weight * 0.85) }
    return entry
  })
}

function selectRelevantEntriesFrom(input: LumiUserProfileEntry[], text: string, limit: number) {
  const normalized = normalizeSearchText(text)
  const scored = pruneExpiredEntries(input)
    .filter(entry => entry.status === 'active')
    .map((entry) => {
      const keyScore = normalizeSearchText(`${keyLabel(entry.key)} ${entry.key}`).split(/\s+/).some(token => normalized.includes(token)) ? 0.3 : 0
      const valueTokens = normalizeSearchText(entry.value).split(/\s+/).filter(token => token.length >= 2)
      const valueScore = valueTokens.some(token => normalized.includes(token)) ? 0.5 : 0
      const specialScore = profileSpecialTopicalScore(entry, text)
      const anchorScore = isLightAnchorKey(entry.key) ? 0.3 : 0
      const layerScore = entry.layer === 'core' ? 0.25 : entry.layer === 'daily' ? 0.2 : 0.15
      const recencyScore = entry.layer === 'dynamic' ? Math.max(0, 0.2 - daysBetween(entry.lastSeenAt, Date.now()) * 0.01) : 0
      return {
        entry,
        topicalScore: keyScore + valueScore + specialScore,
        score: keyScore + valueScore + specialScore + anchorScore + layerScore + recencyScore + entry.confidence * 0.2 + entry.weight * 0.2,
      }
    })
    .filter(item => isLightAnchorKey(item.entry.key) || item.entry.layer === 'daily' || item.topicalScore > 0)
    .sort((left, right) => right.score - left.score)

  const anchors = scored
    .filter(item => isLightAnchorKey(item.entry.key))
    .filter((item, index, items) => items.findIndex(other => other.entry.key === item.entry.key) === index)
    .slice(0, 2)
  const topical = scored
    .filter(item => !isLightAnchorKey(item.entry.key))
    .slice(0, Math.max(0, limit - anchors.length))

  return dedupeEntries([...topical, ...anchors].map(item => item.entry)).slice(0, limit)
}

function formatProfileEntryForPrompt(entry: LumiUserProfileEntry) {
  const source = entry.source.map(item => item.kind).join('+')
  const protection = entry.protected ? ', protected' : ''
  if (entry.key === 'emotional_patterns') {
    return `- 回复策略参考: ${emotionalPatternToStrategy(entry.value)} (confidence ${entry.confidence.toFixed(2)}, source ${source}${protection})`
  }
  return `- ${layerLabel(entry.layer)} / ${keyLabel(entry.key)}: ${entry.value} (confidence ${entry.confidence.toFixed(2)}, source ${source}${protection})`
}

function emotionalPatternToStrategy(value: string) {
  if (/顶级项目|优秀项目|比较|AIRI|Neuro/i.test(value))
    return '当用户被强项目或项目比较刺激时，先承认对方项目确实强，再指出用户已有进展，并一起拆解下一步。'
  if (/废了|怀疑|否定|低谷|放弃/.test(value))
    return '当用户用强烈否定自己的话表达低谷时，把它视为当日情绪信号，先接住感受，再转向可执行步骤。'
  return '先共情，再分析；不要把单次低谷当作长期结论。'
}

function profileSpecialTopicalScore(entry: LumiUserProfileEntry, messageText: string) {
  if (entry.key !== 'emotional_patterns')
    return 0
  if (/(Neuro|顶级|优秀|太强|不行|废了|比较|挫败|怀疑|能力)/i.test(messageText))
    return 0.75
  return 0
}

function isLightAnchorKey(key: LumiUserProfileKey) {
  return key === 'communication_preference' || key === 'relationship_guidelines'
}

function dedupeEntries(entries: LumiUserProfileEntry[]) {
  const seen = new Set<string>()
  const unique: LumiUserProfileEntry[] = []
  for (const entry of entries) {
    if (seen.has(entry.id))
      continue
    seen.add(entry.id)
    unique.push(entry)
  }
  return unique
}

function layerForKey(key: LumiUserProfileKey): LumiUserProfileLayer {
  if (CORE_KEYS.has(key))
    return 'core'
  if (DAILY_KEYS.has(key))
    return 'daily'
  return 'dynamic'
}

function normalizeLayerForKey(layer: LumiUserProfileLayer, key: LumiUserProfileKey): LumiUserProfileLayer {
  const expected = layerForKey(key)
  if (expected !== layer)
    return expected
  return layer
}

function isKnownKey(key: string): key is LumiUserProfileKey {
  return CORE_KEYS.has(key as LumiUserProfileKey)
    || DYNAMIC_KEYS.has(key as LumiUserProfileKey)
    || DAILY_KEYS.has(key as LumiUserProfileKey)
}

function isKnownLayer(layer: string): layer is LumiUserProfileLayer {
  return layer === 'core' || layer === 'dynamic' || layer === 'daily'
}

function normalizeChineseValue(value: string) {
  return value.replace(/\s+/g, ' ').replace(/^[：:，,。.\s]+/, '').trim().slice(0, 220)
}

function mergeEntryValue(entry: LumiUserProfileEntry, nextValue: string) {
  if (entry.layer === 'daily' || entry.key === 'nickname')
    return nextValue
  if (entry.value.includes(nextValue))
    return entry.value
  if (nextValue.includes(entry.value))
    return nextValue
  if (entry.layer === 'dynamic')
    return nextValue
  return `${entry.value}；${nextValue}`.slice(0, 260)
}

function initialWeight(candidate: LumiUserProfileCandidate) {
  if (candidate.layer === 'core')
    return 1
  if (candidate.layer === 'daily')
    return 0.45
  return clamp(candidate.confidence, 0.35, 0.9)
}

function mergeSources(existing: LumiUserProfileSource[], next: LumiUserProfileSource) {
  const key = `${next.kind}:${next.id ?? ''}:${next.quote}`
  const seen = new Set(existing.map(item => `${item.kind}:${item.id ?? ''}:${item.quote}`))
  if (seen.has(key))
    return existing
  return [next, ...existing].slice(0, AUTO_REVIEW_MAX_EVIDENCE)
}

function mergeSourceList(existing: LumiUserProfileSource[], next: LumiUserProfileSource[]) {
  let merged = existing
  for (const source of next)
    merged = mergeSources(merged, source)
  return merged
}

function isSimilarText(left: string, right: string) {
  const l = normalizeSearchText(left)
  const r = normalizeSearchText(right)
  return l.includes(r) || r.includes(l)
}

function normalizeSearchText(text: string) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}_\u4E00-\u9FFF]+/gu, ' ').trim()
}

function isToday(value: string) {
  const date = new Date(value)
  const now = new Date()
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
}

function daysBetween(iso: string, nowMs: number) {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then))
    return 0
  return Math.max(0, (nowMs - then) / 86_400_000)
}

function extractJson(raw: string) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced?.[1])
    return fenced[1].trim()
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first < 0 || last <= first)
    return ''
  return raw.slice(first, last + 1)
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value))
    return min
  return Math.min(max, Math.max(min, value))
}

function createId(prefix: string) {
  if (globalThis.crypto?.randomUUID)
    return `${prefix}_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function hashText(text: string) {
  let hash = 0
  for (let index = 0; index < text.length; index += 1)
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0
  return Math.abs(hash).toString(36)
}
