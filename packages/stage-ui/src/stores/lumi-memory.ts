import type { LumiMemoryCandidate, LumiMemoryFragment, LumiMemoryRetrievalResult, LumiMemoryScope, LumiMemorySearchRequest, LumiMemorySensitivity, LumiMemorySourceConversationType, LumiMemoryStatus, LumiMemoryVisibility } from '../../../lumi-runtime/src'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore, storeToRefs } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import {
  canInspectLumiMemory,
  classifyLumiMemoryCandidate,
  decideLumiMemoryStatus,
  extractLumiMemoryCandidates,
  migratedLumiAllMemories,
  migratedLumiContextManifest,
  normalizeMemoryScores,
  parseLumiMemoryCuratorOutput,
  retrieveLumiMemories,
} from '../../../lumi-runtime/src'
import { LUMI_DOGGY_USER_ID, useLumiIdentityStore } from './lumi-identity'

export type { LumiMemoryFragment, LumiMemoryStatus, LumiMemoryType } from '../../../lumi-runtime/src'

const LUMI_MEMORY_STORAGE_KEY = 'lumi/memory/fragments:v1'
const LUMI_MEMORY_SEED_STORAGE_KEY = 'lumi/memory/seed:v1'
const LUMI_MEMORY_EVENTS_STORAGE_KEY = 'lumi/memory/events:v1'
const MIGRATION_SEED_ID = `${migratedLumiContextManifest.generatedAt}:${migratedLumiContextManifest.memoryCount}`
const LUMI_MEMORY_EMBEDDING_MODEL = 'BAAI/bge-small-zh-v1.5'
const LUMI_MEMORY_PERSISTENCE_TIMEOUT_MS = 60_000
const LUMI_SEMANTIC_SEARCH_TIMEOUT_MS = 4500
// A cold CUDA worker takes about 12 seconds on the supported Windows bundle.
// Interactive chat must fall back to lexical retrieval before that startup can
// consume the whole reply budget; the worker continues loading for later turns.
const LUMI_SEMANTIC_COLD_SEARCH_TIMEOUT_MS = 8_000
const LUMI_SEMANTIC_PREWARM_TIMEOUT_MS = 1_800_000
const LUMI_SEMANTIC_MEMORY_LIMIT = 800
const LUMI_SEMANTIC_INTERACTIVE_MEMORY_LIMIT = 160
const LUMI_MEMORY_VECTOR_CACHE_LIMIT = 5000
const LUMI_SEMANTIC_INDEX_LIMIT = LUMI_MEMORY_VECTOR_CACHE_LIMIT

type LumiSemanticDevice = 'backend' | 'unknown'

const semanticMemoryVectors = new Map<string, { signature: string, vector: number[] }>()

export interface LumiMemoryStatusCount {
  status: LumiMemoryStatus
  count: number
}

/** A historical memory that can safely move to a wider host-authorized scope. */
export interface LumiMemoryPromotionCandidate {
  memory: LumiMemoryFragment
  fromScope: LumiMemoryScope
  toScope: Extract<LumiMemoryScope, 'global' | 'shared'>
  classificationReason: string
  disclosureReason: string
}

export interface LumiRememberCandidateOptions {
  userId?: string
  personaId?: string
  conversationId?: string
  sourceMessageId?: string
  now?: string
  scope?: LumiMemoryScope
  visibility?: LumiMemoryVisibility
  participantUserIds?: string[]
  subjectUserIds?: string[]
  sensitivity?: LumiMemorySensitivity
  conversationType?: LumiMemorySourceConversationType
}

export interface LumiMemoryEvent {
  id: string
  kind: 'search' | 'save' | 'update' | 'promote' | 'forget' | 'delete' | 'reject_duplicate' | 'merge'
  memoryId?: string
  relatedMemoryIds?: string[]
  query?: string
  route?: string
  resultCount?: number
  beforeStatus?: LumiMemoryStatus
  afterStatus?: LumiMemoryStatus
  preview?: string
  createdAt: string
}

export interface LumiMemoryDuplicateGroup {
  id: string
  primaryMemory: LumiMemoryFragment
  memories: LumiMemoryFragment[]
  score: number
  sharedTokens: string[]
}

export interface LumiMemoryTopicCacheEntry {
  sessionId: string
  sourceMessage: string
  query: string
  topicWindow: string
  topicHints: string[]
  storagePrefix?: string
  updatedAt: number
}

export interface LumiMemoryPersistenceSnapshot {
  fragments: LumiMemoryFragment[]
  events: LumiMemoryEvent[]
  seedId: string
  dbPath?: string
  /** Persisted semantic vectors included in complete archives and server migrations. */
  vectors?: LumiMemoryVectorRecord[]
}

export interface LumiMemoryVectorRecord {
  memoryId: string
  model: string
  signature: string
  vector: number[]
  device?: string
  updatedAt: string
}

export interface LumiMemoryBackendVectorStatus {
  available: boolean
  running: boolean
  model: string
  device: string
  phase?: string
  indexedCount: number
  totalCount: number
  missingCount: number
  downloadPercent?: number
  downloadedBytes?: number
  downloadTotalBytes?: number
  downloadSpeedBytesPerSecond?: number
  progress?: string
  lastError?: string
}

export interface LumiMemoryPersistenceBridge {
  getSnapshot: (payload: { userId: string }) => Promise<LumiMemoryPersistenceSnapshot>
  replaceSnapshot: (payload: { userId: string, snapshot: LumiMemoryPersistenceSnapshot }) => Promise<LumiMemoryPersistenceSnapshot>
  upsertMemory: (memory: LumiMemoryFragment) => Promise<void>
  deleteMemory: (payload: { id: string, userId: string }) => Promise<void>
  getVectors?: (payload: { model: string, userId: string }) => Promise<LumiMemoryVectorRecord[]>
  upsertVector?: (record: LumiMemoryVectorRecord) => Promise<void>
  deleteVector?: (payload: { memoryId: string, model?: string }) => Promise<void>
  vectorStatus?: (payload: { userId: string }) => Promise<LumiMemoryBackendVectorStatus>
  backfillVectors?: (payload: { userId: string, limit?: number }) => Promise<LumiMemoryBackendVectorStatus>
  searchVectors?: (payload: { userId: string, query: string, limit?: number }) => Promise<{ scores: Record<string, number>, status: LumiMemoryBackendVectorStatus }>
  syncVector?: (memory: LumiMemoryFragment) => Promise<LumiMemoryBackendVectorStatus>
  saveEvent: (payload: { userId: string, event: LumiMemoryEvent }) => Promise<void>
  setSeedId: (payload: { userId: string, seedId: string }) => Promise<void>
  clear: (payload: { userId: string }) => Promise<void>
}

export interface LumiAlayaMemoryDriver {
  search: (request: LumiMemorySearchRequest) => LumiMemoryRetrievalResult
  save: (fragment: LumiMemoryFragment) => LumiMemoryFragment
  update: (memoryId: string, patch: Partial<LumiMemoryFragment>) => boolean
  forget: (memoryId: string) => boolean
  delete: (memoryId: string) => boolean
  merge: (memoryIds: string[], patch?: Partial<LumiMemoryFragment>) => LumiMemoryFragment | null
}

export const useLumiMemoryStore = defineStore('lumi-memory', () => {
  const { activeUserId } = storeToRefs(useLumiIdentityStore())
  const fragments = useLocalStorageManualReset<LumiMemoryFragment[]>(LUMI_MEMORY_STORAGE_KEY, [])
  const seedId = useLocalStorageManualReset<string>(LUMI_MEMORY_SEED_STORAGE_KEY, '')
  const events = useLocalStorageManualReset<LumiMemoryEvent[]>(LUMI_MEMORY_EVENTS_STORAGE_KEY, [])
  const topicCache = ref<Record<string, LumiMemoryTopicCacheEntry>>({})
  const persistenceBridge = shallowRef<LumiMemoryPersistenceBridge | null>(null)
  const persistenceReady = ref(false)
  const persistenceMode = ref<'local-storage' | 'sqlite'>('local-storage')
  const persistenceDbPath = ref('')
  const persistenceLastError = ref('')
  const semanticIndexReady = ref(false)
  const semanticIndexLoading = ref(false)
  const semanticIndexStatus = ref<'idle' | 'loading' | 'ready' | 'fallback'>('idle')
  const semanticIndexError = ref('')
  const semanticIndexDevice = ref<LumiSemanticDevice>('unknown')
  const semanticIndexProgress = ref('')
  const semanticDownloadPercent = ref<number | null>(null)
  const semanticIndexedCount = ref(0)
  const semanticSearchPoolSize = ref(0)
  const detachedSnapshots = new Map<string, LumiMemoryPersistenceSnapshot>()
  const detachedLoadPromises = new Map<string, Promise<LumiMemoryPersistenceSnapshot>>()
  const detachedWriteQueues = new Map<string, Promise<void>>()
  let persistenceInitPromise: Promise<void> | null = null
  let semanticPrewarmPromise: Promise<void> | null = null
  let semanticVectorWriteQueue: Promise<void> = Promise.resolve()
  let semanticInteractiveSearches = 0
  let semanticBackendPollTimer: ReturnType<typeof globalThis.setInterval> | null = null

  function currentUserId() {
    return activeUserId.value || LUMI_DOGGY_USER_ID
  }

  function resolveRequestViewer(request: LumiMemorySearchRequest) {
    const requested = request.viewerUserId || request.userId
    return !requested || requested === 'local' ? currentUserId() : requested
  }

  /** Loads the memories visible to one actor without switching the desktop identity. */
  async function ensureUserMemoryLoaded(userId: string) {
    if (userId === currentUserId() && persistenceReady.value)
      return currentMemorySnapshot()

    const cached = detachedSnapshots.get(userId)
    if (cached)
      return cached

    const pending = detachedLoadPromises.get(userId)
    if (pending)
      return pending

    const bridge = persistenceBridge.value
    if (!bridge)
      return { fragments: [], events: [], seedId: '' }

    const load = bridge.getSnapshot({ userId })
      .then((snapshot) => {
        const normalized = normalizeMemorySnapshot(snapshot)
        detachedSnapshots.set(userId, normalized)
        return normalized
      })
      .finally(() => detachedLoadPromises.delete(userId))
    detachedLoadPromises.set(userId, load)
    return load
  }

  function currentMemorySnapshot(): LumiMemoryPersistenceSnapshot {
    return {
      fragments: fragments.value.map(fragment => normalizeMemoryScores(fragment)),
      events: [...events.value],
      seedId: seedId.value,
      dbPath: persistenceDbPath.value || undefined,
    }
  }

  function fragmentsForUser(userId: string) {
    return userId === currentUserId()
      ? fragments.value
      : detachedSnapshots.get(userId)?.fragments ?? []
  }

  const allMemories = computed(() => fragments.value)
  const inspectableMemories = computed(() => fragments.value.filter(memory => canInspectLumiMemory(memory, currentUserId())))
  const promotionCandidates = computed(() => fragments.value
    .map(memory => promotionCandidateFor(memory))
    .filter((candidate): candidate is LumiMemoryPromotionCandidate => candidate !== null))
  const activeMemories = computed(() => fragments.value.filter(fragment => fragment.status === 'active'))
  const candidateMemories = computed(() => fragments.value.filter(fragment => fragment.status === 'candidate'))
  const recentMemoryEvents = computed(() => events.value.slice(0, 80))
  const duplicateMemoryGroups = computed(() => findDuplicateMemoryGroups(fragments.value))
  const statusCounts = computed<LumiMemoryStatusCount[]>(() => {
    const counts = new Map<LumiMemoryStatus, number>()
    for (const fragment of fragments.value)
      counts.set(fragment.status, (counts.get(fragment.status) ?? 0) + 1)

    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => ({ status, count }))
  })

  function initialize() {
    if (fragments.value.length > 0)
      return

    resetToMigratedSnapshot()
  }

  function setPersistenceBridge(bridge: LumiMemoryPersistenceBridge | null) {
    persistenceBridge.value = bridge
    persistenceMode.value = bridge ? 'sqlite' : 'local-storage'
    persistenceLastError.value = ''
  }

  async function initializePersistence() {
    if (!persistenceBridge.value) {
      initialize()
      persistenceReady.value = true
      persistenceMode.value = 'local-storage'
      return
    }

    if (persistenceInitPromise)
      return persistenceInitPromise

    persistenceInitPromise = withTimeout(hydrateFromPersistence(), LUMI_MEMORY_PERSISTENCE_TIMEOUT_MS, 'Lumi memory persistence')
      .catch((error) => {
        console.warn('[lumi-memory] SQLite persistence unavailable, falling back to localStorage', error)
        persistenceLastError.value = errorMessageFrom(error) ?? String(error)
        persistenceMode.value = persistenceBridge.value ? 'sqlite' : 'local-storage'
        persistenceDbPath.value = ''
        initialize()
        persistenceReady.value = true
        persistenceInitPromise = null
      })
    return persistenceInitPromise
  }

  async function hydrateFromPersistence() {
    const bridge = persistenceBridge.value
    if (!bridge) {
      initialize()
      persistenceReady.value = true
      persistenceMode.value = 'local-storage'
      return
    }

    const snapshot = await bridge.getSnapshot({ userId: currentUserId() })
    persistenceDbPath.value = snapshot.dbPath ?? ''
    persistenceMode.value = 'sqlite'
    persistenceLastError.value = ''

    if (snapshot.fragments.length > 0 || snapshot.seedId) {
      fragments.value = snapshot.fragments.map(fragment => normalizeMemoryScores(fragment))
      events.value = snapshot.events.slice(0, 200)
      seedId.value = snapshot.seedId
      await loadPersistedSemanticVectors()
      persistenceReady.value = true
      void prewarmSemanticIndex().catch(() => {})
      return
    }

    if (fragments.value.length === 0)
      resetToMigratedSnapshot()

    const replaced = await bridge.replaceSnapshot({
      userId: currentUserId(),
      snapshot: {
        fragments: fragments.value.map(fragment => memoryForCurrentUserSnapshot(fragment)),
        events: events.value,
        seedId: seedId.value,
      },
    })
    persistenceDbPath.value = replaced.dbPath ?? persistenceDbPath.value
    persistenceLastError.value = ''
    await loadPersistedSemanticVectors()
    persistenceReady.value = true
    void prewarmSemanticIndex().catch(() => {})
  }

  /** Reloads the active user's memory without deleting another user's persisted data. */
  async function reloadForActiveUser() {
    fragments.value = []
    events.value = []
    seedId.value = ''
    topicCache.value = {}
    semanticMemoryVectors.clear()
    semanticIndexReady.value = false
    semanticIndexLoading.value = false
    semanticIndexStatus.value = 'idle'
    semanticIndexedCount.value = 0
    semanticSearchPoolSize.value = 0
    semanticPrewarmPromise = null
    persistenceInitPromise = null
    persistenceReady.value = false
    await initializePersistence()
  }

  function resetToMigratedSnapshot() {
    fragments.value = migratedLumiAllMemories.map(fragment => normalizeMemoryScores({ ...fragment, userId: currentUserId() }))
    seedId.value = MIGRATION_SEED_ID
    persistSeedId()
    persistSnapshot()
  }

  function search(request: LumiMemorySearchRequest): LumiMemoryFragment[] {
    initialize()
    return retrieve(request).rankedMemories.map(item => item.memory)
  }

  function retrieve(request: LumiMemorySearchRequest): LumiMemoryRetrievalResult {
    initialize()
    const viewerUserId = resolveRequestViewer(request)
    const scopedRequest = { ...request, userId: viewerUserId, viewerUserId }
    const result = retrieveLumiMemories(fragmentsForUser(viewerUserId), scopedRequest)
    recordMemoryEventForUser(viewerUserId, {
      kind: 'search',
      query: request.query,
      route: result.route.queryIntent,
      resultCount: result.rankedMemories.length,
      preview: result.rankedMemories[0]?.memory.content,
    })
    return result
  }

  async function retrieveSemantic(request: LumiMemorySearchRequest): Promise<LumiMemoryRetrievalResult> {
    initialize()
    const viewerUserId = resolveRequestViewer(request)
    await ensureUserMemoryLoaded(viewerUserId)

    try {
      const bridge = persistenceBridge.value
      if (bridge?.searchVectors) {
        const searchLimit = semanticIndexReady.value
          ? LUMI_SEMANTIC_MEMORY_LIMIT
          : LUMI_SEMANTIC_INTERACTIVE_MEMORY_LIMIT
        const timeoutMs = semanticIndexReady.value
          ? LUMI_SEMANTIC_SEARCH_TIMEOUT_MS
          : LUMI_SEMANTIC_COLD_SEARCH_TIMEOUT_MS
        const backendSearch = bridge.searchVectors({
          userId: viewerUserId,
          query: request.query,
          limit: searchLimit,
        })
        if (!semanticIndexReady.value) {
          void backendSearch
            .then(result => applyBackendVectorStatus(result.status))
            .catch(() => {})
        }
        const backendResult = await withTimeout(
          backendSearch,
          timeoutMs,
          'Lumi backend semantic memory search',
        )
        applyBackendVectorStatus(backendResult.status)
        const result = retrieveLumiMemories(fragmentsForUser(viewerUserId), { ...request, userId: viewerUserId, viewerUserId }, {
          externalVectorScores: backendResult.scores,
        })
        recordMemoryEventForUser(viewerUserId, {
          kind: 'search',
          query: request.query,
          route: result.route.queryIntent,
          resultCount: result.rankedMemories.length,
          preview: result.rankedMemories[0]?.memory.content,
        })
        semanticIndexError.value = backendResult.status.lastError ?? ''
        return result
      }

      semanticIndexReady.value = false
      semanticIndexStatus.value = 'fallback'
      semanticIndexDevice.value = 'unknown'
      semanticIndexError.value = '后端向量桥未连接，已停止前端 WASM 模型加载。请重启桌面端或检查 Electron 记忆桥。'
      semanticIndexProgress.value = semanticIndexError.value
      return retrieve(request)
    }
    catch (error) {
      const message = errorMessageFrom(error) ?? String(error)
      if (
        !semanticIndexReady.value
        && message === `Lumi backend semantic memory search timed out after ${LUMI_SEMANTIC_COLD_SEARCH_TIMEOUT_MS}ms`
      ) {
        semanticIndexStatus.value = 'loading'
        semanticIndexError.value = ''
        semanticIndexProgress.value = '向量模型正在后台冷启动，本轮已立即改用词法记忆'
        return retrieve(request)
      }
      semanticIndexStatus.value = 'fallback'
      semanticIndexError.value = message
      console.warn('[lumi-memory] semantic vector search unavailable, falling back to lexical retrieval', error)
      return retrieve(request)
    }
    finally {
      semanticInteractiveSearches = Math.max(0, semanticInteractiveSearches - 1)
    }
  }

  async function prewarmSemanticIndex(limit = LUMI_SEMANTIC_INDEX_LIMIT) {
    initialize()
    if (semanticPrewarmPromise)
      return semanticPrewarmPromise

    semanticIndexLoading.value = true
    semanticIndexStatus.value = 'loading'
    semanticPrewarmPromise = (async () => {
      try {
        const bridge = persistenceBridge.value
        if (bridge?.backfillVectors) {
          semanticIndexDevice.value = 'backend'
          semanticIndexProgress.value = '正在请求后端补向量'
          const status = await pollBackendVectorProgress(
            bridge.backfillVectors({ userId: currentUserId(), limit }),
            'Lumi backend semantic memory index prewarm',
          )
          applyBackendVectorStatus(status)
        }
        else {
          semanticIndexReady.value = false
          semanticIndexStatus.value = 'fallback'
          semanticIndexDevice.value = 'unknown'
          semanticIndexError.value = '后端向量桥未连接，桌面端不再使用前端 WASM 向量模型。'
          semanticIndexProgress.value = semanticIndexError.value
          return
        }
        semanticIndexReady.value = true
        semanticIndexStatus.value = 'ready'
        semanticIndexError.value = ''
      }
      catch (error) {
        semanticIndexReady.value = false
        semanticIndexStatus.value = 'fallback'
        semanticIndexError.value = errorMessageFrom(error) ?? String(error)
        console.warn('[lumi-memory] failed to prewarm semantic memory index', error)
        throw error
      }
      finally {
        semanticIndexLoading.value = false
        semanticPrewarmPromise = null
      }
    })()
    return semanticPrewarmPromise
  }

  function extractCandidates(message: string, sourceMessageId?: string) {
    return extractLumiMemoryCandidates(message, { sourceMessageId })
  }

  function parseCuratedCandidates(raw: string, sourceMessageId?: string) {
    return parseLumiMemoryCuratorOutput(raw, sourceMessageId)
  }

  function rememberCandidate(
    candidate: LumiMemoryCandidate,
    options: LumiRememberCandidateOptions = {},
  ) {
    initialize()
    if (isEchoOfExistingMemory(candidate.content, activeMemories.value)) {
      recordMemoryEvent({
        kind: 'reject_duplicate',
        preview: candidate.content,
      })
      return null
    }

    const memoryUserId = !options.userId || options.userId === 'local'
      ? currentUserId()
      : options.userId
    const memory = createMemoryFromCandidate(candidate, { ...options, userId: memoryUserId }, activeMemories.value)

    propagateMemoryToLoadedUsers(memory)
    persistMemory(memory)
    syncSemanticVectorForMemory(memory)
    recordMemoryEvent({
      kind: 'save',
      memoryId: memory.id,
      afterStatus: memory.status,
      preview: memory.content,
    })
    return memory
  }

  function rememberCandidates(
    candidates: LumiMemoryCandidate[],
    options: LumiRememberCandidateOptions = {},
  ) {
    const stored: LumiMemoryFragment[] = []
    for (const candidate of candidates) {
      const memory = rememberCandidate(candidate, options)
      if (memory && memory.status !== 'rejected')
        stored.push(memory)
    }
    return stored
  }

  /** Stores memories for an explicit actor without changing the desktop identity. */
  async function rememberCandidatesForUser(
    userId: string,
    candidates: LumiMemoryCandidate[],
    options: LumiRememberCandidateOptions = {},
  ) {
    if (userId === currentUserId())
      return rememberCandidates(candidates, { ...options, userId })

    return enqueueDetachedWrite(userId, async () => {
      const snapshot = await ensureUserMemoryLoaded(userId)
      const stored: LumiMemoryFragment[] = []
      for (const candidate of candidates) {
        const visibleActive = snapshot.fragments.filter(fragment => fragment.status === 'active')
        if (isEchoOfExistingMemory(candidate.content, visibleActive)) {
          recordMemoryEventForUser(userId, {
            kind: 'reject_duplicate',
            preview: candidate.content,
          })
          continue
        }

        const memory = createMemoryFromCandidate(candidate, {
          ...options,
          userId,
        }, visibleActive)
        propagateMemoryToLoadedUsers(memory)
        const bridge = persistenceBridge.value
        if (bridge) {
          await bridge.upsertMemory(memory)
          if (bridge.syncVector)
            void bridge.syncVector(memory).then(applyBackendVectorStatus).catch(error => console.warn('[lumi-memory] failed to sync explicit-user vector', error))
        }
        recordMemoryEventForUser(userId, {
          kind: 'save',
          memoryId: memory.id,
          afterStatus: memory.status,
          preview: memory.content,
        })
        if (memory.status !== 'rejected')
          stored.push(memory)
      }
      return stored
    })
  }

  function createMemoryFromCandidate(
    candidate: LumiMemoryCandidate,
    options: LumiRememberCandidateOptions,
    visibleActive: LumiMemoryFragment[],
  ) {
    const now = options.now ?? new Date().toISOString()
    const memoryUserId = options.userId || currentUserId()
    const decision = decideLumiMemoryStatus(candidate, visibleActive)
    const personaId = options.personaId ?? 'lumi'
    const classification = classifyLumiMemoryCandidate(candidate, {
      actorId: memoryUserId,
      personaId,
      conversationId: options.conversationId,
      conversationType: options.conversationType,
      participantUserIds: options.participantUserIds,
      requestedScope: options.scope ?? candidate.scope,
      requestedVisibility: options.visibility ?? candidate.visibility,
      requestedSensitivity: options.sensitivity ?? candidate.sensitivity,
      requestedSubjectUserIds: options.subjectUserIds ?? candidate.subjectUserIds,
    })
    return normalizeMemoryScores({
      id: createMemoryId(),
      userId: memoryUserId,
      personaId,
      conversationId: options.conversationId,
      type: candidate.type,
      content: candidate.content,
      sourceMessageId: candidate.sourceMessageId ?? options.sourceMessageId,
      confidence: candidate.confidence,
      importance: candidate.importance,
      emotionalIntensity: candidate.emotionalIntensity,
      relationshipRelevance: candidate.relationshipRelevance,
      createdAt: now,
      updatedAt: now,
      decay: candidate.decay,
      tags: [...candidate.tags, decision.status === 'candidate' ? 'needs_review' : 'auto_memory'].filter(Boolean),
      status: decision.status,
      ...classification,
    })
  }

  function propagateMemoryToLoadedUsers(memory: LumiMemoryFragment) {
    const currentWithoutMemory = fragments.value.filter(existing => existing.id !== memory.id)
    fragments.value = memoryVisibleToUser(memory, currentUserId())
      ? [memory, ...currentWithoutMemory]
      : currentWithoutMemory

    for (const [userId, snapshot] of detachedSnapshots) {
      const withoutMemory = snapshot.fragments.filter(existing => existing.id !== memory.id)
      snapshot.fragments = memoryVisibleToUser(memory, userId)
        ? [memory, ...withoutMemory]
        : withoutMemory
    }
  }

  function enqueueDetachedWrite<Result>(userId: string, operation: () => Promise<Result>) {
    const previous = detachedWriteQueues.get(userId) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(operation)
    const settled = run.then(() => {}, () => {})
    detachedWriteQueues.set(userId, settled)
    return run.finally(() => {
      if (detachedWriteQueues.get(userId) === settled)
        detachedWriteQueues.delete(userId)
    })
  }

  function updateMemoryStatus(memoryId: string, status: LumiMemoryStatus) {
    return updateMemory(memoryId, { status })
  }

  function updateMemory(memoryId: string, patch: Partial<LumiMemoryFragment>, eventKind: LumiMemoryEvent['kind'] = 'update') {
    const index = fragments.value.findIndex(fragment => fragment.id === memoryId)
    if (index < 0)
      return false

    const before = fragments.value[index]
    if (before.userId !== currentUserId())
      return false

    const next = [...fragments.value]
    next[index] = normalizeMemoryScores({
      ...next[index],
      ...patch,
      id: memoryId,
      userId: before.userId,
      updatedAt: new Date().toISOString(),
    })
    propagateMemoryToLoadedUsers(next[index])
    persistMemory(next[index])
    syncSemanticVectorForMemory(next[index])
    recordMemoryEvent({
      kind: eventKind,
      memoryId,
      beforeStatus: before.status,
      afterStatus: next[index].status,
      preview: next[index].content,
    })
    return true
  }

  function promotionCandidateFor(memory: LumiMemoryFragment): LumiMemoryPromotionCandidate | null {
    const classification = classifyPromotion(memory)
    const toScope = promotionTargetScope(memory)
    if (!classification || !toScope || classification.scope !== toScope)
      return null
    return {
      memory,
      fromScope: memory.scope ?? 'relationship',
      toScope,
      classificationReason: classification.classificationReason,
      disclosureReason: classification.disclosureReason,
    }
  }

  function classifyPromotion(memory: LumiMemoryFragment) {
    const requestedScope = promotionTargetScope(memory)
    if (!requestedScope)
      return null
    return classifyLumiMemoryCandidate(memoryCandidateFromFragment(memory, requestedScope), {
      actorId: currentUserId(),
      personaId: memory.personaId,
      conversationId: memory.conversationId,
      conversationType: memory.sourceConversationType,
      participantUserIds: memory.participantUserIds,
      requestedScope,
      requestedVisibility: requestedScope === 'global' ? 'global' : 'shared',
      requestedSensitivity: memory.sensitivity,
      requestedSubjectUserIds: memory.subjectUserIds,
    })
  }

  function promotionTargetScope(memory: LumiMemoryFragment): LumiMemoryPromotionCandidate['toScope'] | null {
    if (memory.userId !== currentUserId() || memory.status !== 'active' || memory.scope !== 'relationship')
      return null
    if (memory.sourceConversationType === 'group')
      return null
    if ((memory.type === 'persona_fact' || memory.type === 'persona_preference') && memory.tags.includes('lumi_self'))
      return 'global'
    if (memory.type === 'shared_event' || memory.type === 'emotional_echo')
      return 'shared'
    return null
  }

  /** Promotes one reviewed historical memory after re-running host policy. */
  function promoteMemoryScope(memoryId: string) {
    const memory = fragments.value.find(fragment => fragment.id === memoryId)
    const classification = memory ? classifyPromotion(memory) : null
    const requestedScope = memory ? promotionTargetScope(memory) : null
    if (!memory || !classification || !requestedScope || classification.scope !== requestedScope)
      return false
    return updateMemory(memoryId, {
      ...classification,
      tags: mergeTags(memory.tags, ['scope_reviewed', `promoted_from:${memory.scope}`]),
    }, 'promote')
  }

  /** Promotes only memories that still satisfy policy when the batch executes. */
  function promoteMemoryScopes(memoryIds: string[]) {
    return [...new Set(memoryIds)].reduce((count, memoryId) => promoteMemoryScope(memoryId) ? count + 1 : count, 0)
  }

  function remember(fragment: LumiMemoryFragment) {
    initialize()
    const normalized = normalizeMemoryScores({
      ...fragment,
      userId: currentUserId(),
      ownerId: fragment.ownerId || (fragment.scope === 'global' ? fragment.personaId : currentUserId()),
    })
    const next = fragments.value.filter(existing => existing.id !== normalized.id)
    fragments.value = [normalized, ...next]
    persistMemory(normalized)
    syncSemanticVectorForMemory(normalized)
    recordMemoryEvent({
      kind: 'save',
      memoryId: normalized.id,
      afterStatus: normalized.status,
      preview: normalized.content,
    })
    return normalized
  }

  function forget(memoryId: string) {
    const ok = updateMemoryStatus(memoryId, 'archived')
    if (ok) {
      recordMemoryEvent({
        kind: 'forget',
        memoryId,
        afterStatus: 'archived',
        preview: fragments.value.find(memory => memory.id === memoryId)?.content,
      })
    }
    return ok
  }

  function deleteMemory(memoryId: string) {
    const memory = fragments.value.find(fragment => fragment.id === memoryId)
    if (!memory || memory.userId !== currentUserId())
      return false

    fragments.value = fragments.value.filter(fragment => fragment.id !== memoryId)
    persistDeleteMemory(memoryId)
    deleteSemanticVector(memoryId)
    recordMemoryEvent({
      kind: 'delete',
      memoryId,
      beforeStatus: memory.status,
      preview: memory.content,
    })
    return true
  }

  function mergeMemories(memoryIds: string[], patch: Partial<LumiMemoryFragment> = {}) {
    initialize()
    const uniqueIds = [...new Set(memoryIds)].filter(Boolean)
    const memories = uniqueIds
      .map(id => fragments.value.find(fragment => fragment.id === id))
      .filter((memory): memory is LumiMemoryFragment => memory !== undefined && memory.userId === currentUserId())

    if (memories.length < 2)
      return null

    const now = new Date().toISOString()
    const primary = pickPrimaryMemory(memories)
    const sourceIds = memories.map(memory => memory.id)
    const merged = normalizeMemoryScores({
      ...primary,
      ...patch,
      id: createMemoryId(),
      userId: currentUserId(),
      personaId: patch.personaId ?? primary.personaId,
      type: patch.type ?? primary.type,
      content: (patch.content?.trim() || pickMergedContent(memories)),
      confidence: patch.confidence ?? Math.max(...memories.map(memory => memory.confidence)),
      importance: patch.importance ?? Math.max(...memories.map(memory => memory.importance)),
      emotionalIntensity: patch.emotionalIntensity ?? Math.max(...memories.map(memory => memory.emotionalIntensity)),
      relationshipRelevance: patch.relationshipRelevance ?? Math.max(...memories.map(memory => memory.relationshipRelevance)),
      createdAt: memories.map(memory => memory.createdAt).sort()[0] ?? primary.createdAt,
      updatedAt: now,
      decay: patch.decay ?? Math.min(...memories.map(memory => memory.decay)),
      tags: patch.tags ?? mergeMemoryTags(memories, ['merged_memory', ...sourceIds.map(id => `merged_from:${id}`)]),
      status: patch.status ?? pickMergedStatus(memories),
    })

    const archivedSources = fragments.value.map((memory) => {
      if (!sourceIds.includes(memory.id))
        return memory
      return normalizeMemoryScores({
        ...memory,
        status: 'archived',
        updatedAt: now,
        tags: mergeTags(memory.tags, ['merged_duplicate', `merged_into:${merged.id}`]),
      })
    })
    fragments.value = [merged, ...archivedSources]
    persistSnapshot()
    syncSemanticVectorForMemory(merged)
    for (const sourceId of sourceIds)
      deleteSemanticVector(sourceId)

    recordMemoryEvent({
      kind: 'merge',
      memoryId: merged.id,
      relatedMemoryIds: sourceIds,
      afterStatus: merged.status,
      resultCount: memories.length,
      preview: merged.content,
    })

    return merged
  }

  function setLatestTopic(sessionId: string, sourceMessage: string, topic: Omit<LumiMemoryTopicCacheEntry, 'sessionId' | 'sourceMessage' | 'updatedAt'>) {
    topicCache.value = {
      ...topicCache.value,
      [sessionId]: {
        sessionId,
        sourceMessage: normalizeTopicSource(sourceMessage),
        query: topic.query,
        topicWindow: topic.topicWindow,
        topicHints: topic.topicHints,
        storagePrefix: topic.storagePrefix,
        updatedAt: Date.now(),
      },
    }
  }

  function getLatestTopic(sessionId: string, sourceMessage: string) {
    const cached = topicCache.value[sessionId]
    if (!cached)
      return null
    if (cached.sourceMessage !== normalizeTopicSource(sourceMessage))
      return null
    if (Date.now() - cached.updatedAt > 120_000)
      return null
    return cached
  }

  function recordMemoryEvent(input: Omit<LumiMemoryEvent, 'id' | 'createdAt'>) {
    const event: LumiMemoryEvent = {
      id: createMemoryEventId(),
      createdAt: new Date().toISOString(),
      ...input,
      preview: input.preview ? previewText(input.preview, 160) : undefined,
    }
    events.value = [event, ...events.value].slice(0, 200)
    persistEvent(event)
  }

  function recordMemoryEventForUser(userId: string, input: Omit<LumiMemoryEvent, 'id' | 'createdAt'>) {
    if (userId === currentUserId()) {
      recordMemoryEvent(input)
      return
    }

    const event: LumiMemoryEvent = {
      id: createMemoryEventId(),
      createdAt: new Date().toISOString(),
      ...input,
      preview: input.preview ? previewText(input.preview, 160) : undefined,
    }
    const snapshot = detachedSnapshots.get(userId)
    if (snapshot)
      snapshot.events = [event, ...snapshot.events].slice(0, 200)
    void persistenceBridge.value?.saveEvent({ userId, event }).catch(error => console.warn('[lumi-memory] failed to persist explicit-user event', error))
  }

  function resetState() {
    fragments.reset()
    seedId.reset()
    events.reset()
    topicCache.value = {}
    semanticMemoryVectors.clear()
    semanticIndexReady.value = false
    semanticIndexLoading.value = false
    semanticIndexStatus.value = 'idle'
    semanticIndexError.value = ''
    semanticIndexProgress.value = ''
    semanticDownloadPercent.value = null
    semanticIndexedCount.value = 0
    semanticSearchPoolSize.value = 0
    persistenceReady.value = false
    persistenceInitPromise = null
    void persistenceBridge.value?.clear({ userId: currentUserId() }).catch(error => console.warn('[lumi-memory] failed to clear SQLite persistence', error))
  }

  async function exportSnapshot(): Promise<LumiMemoryPersistenceSnapshot> {
    await initializePersistence()
    const bridge = persistenceBridge.value
    if (bridge) {
      const snapshot = await bridge.getSnapshot({ userId: currentUserId() })
      const vectors = bridge.getVectors
        ? await bridge.getVectors({ model: LUMI_MEMORY_EMBEDDING_MODEL, userId: currentUserId() })
        : []
      return {
        fragments: snapshot.fragments.map(fragment => normalizeMemoryScores(fragment)),
        events: snapshot.events,
        seedId: snapshot.seedId,
        dbPath: snapshot.dbPath,
        vectors,
      }
    }
    return {
      fragments: fragments.value.map(fragment => normalizeMemoryScores(fragment)),
      events: events.value,
      seedId: seedId.value,
      dbPath: persistenceDbPath.value || undefined,
      vectors: [],
    }
  }

  async function importSnapshot(snapshot: LumiMemoryPersistenceSnapshot) {
    const nextSnapshot: LumiMemoryPersistenceSnapshot = {
      fragments: Array.isArray(snapshot.fragments)
        ? snapshot.fragments.map(fragment => normalizeMemoryScores(fragment)).slice(0, LUMI_SEMANTIC_MEMORY_LIMIT)
        : [],
      events: Array.isArray(snapshot.events) ? snapshot.events.slice(0, 200) : [],
      seedId: typeof snapshot.seedId === 'string' ? snapshot.seedId : '',
      dbPath: snapshot.dbPath,
      vectors: Array.isArray(snapshot.vectors) ? snapshot.vectors : [],
    }

    const bridge = persistenceBridge.value
    if (bridge) {
      try {
        const persisted = await bridge.replaceSnapshot({
          userId: currentUserId(),
          snapshot: {
            ...nextSnapshot,
            fragments: nextSnapshot.fragments.map(fragment => memoryForCurrentUserSnapshot(fragment)),
          },
        })
        fragments.value = persisted.fragments.map(fragment => normalizeMemoryScores(fragment))
        events.value = persisted.events
        seedId.value = persisted.seedId
        persistenceDbPath.value = persisted.dbPath ?? persistenceDbPath.value
      }
      catch (error) {
        persistenceLastError.value = errorMessageFrom(error) ?? String(error)
        throw error
      }
    }
    else {
      fragments.value = nextSnapshot.fragments
      events.value = nextSnapshot.events
      seedId.value = nextSnapshot.seedId
    }

    semanticMemoryVectors.clear()
    semanticIndexReady.value = false
    semanticIndexedCount.value = 0
    await loadPersistedSemanticVectors()
  }

  function persistMemory(memory: LumiMemoryFragment) {
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    void bridge.upsertMemory(memory).catch(error => console.warn('[lumi-memory] failed to persist memory', error))
  }

  function persistDeleteMemory(memoryId: string) {
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    void bridge.deleteMemory({ id: memoryId, userId: currentUserId() }).catch(error => console.warn('[lumi-memory] failed to delete persisted memory', error))
  }

  async function loadPersistedSemanticVectors() {
    const bridge = persistenceBridge.value
    if (bridge?.vectorStatus) {
      try {
        applyBackendVectorStatus(await bridge.vectorStatus({ userId: currentUserId() }))
      }
      catch (error) {
        console.warn('[lumi-memory] failed to load backend vector status', error)
        semanticIndexProgress.value = `加载后端向量状态失败: ${errorMessageFrom(error) ?? String(error)}`
      }
      return
    }

    if (!bridge?.getVectors)
      return

    try {
      const validIds = new Set(fragments.value.map(memory => memory.id))
      const records = await bridge.getVectors({ model: LUMI_MEMORY_EMBEDDING_MODEL, userId: currentUserId() })
      let loaded = 0
      for (const record of records) {
        if (!validIds.has(record.memoryId) || !isFiniteVector(record.vector))
          continue
        semanticMemoryVectors.set(record.memoryId, {
          signature: record.signature,
          vector: normalizeVector(record.vector),
        })
        loaded += 1
      }
      pruneMap(semanticMemoryVectors, LUMI_MEMORY_VECTOR_CACHE_LIMIT)
      semanticIndexedCount.value = semanticMemoryVectors.size
      semanticIndexDevice.value = 'backend'
      semanticIndexProgress.value = loaded
        ? `已加载 ${loaded} 条已保存向量`
        : '还没有已保存向量'
    }
    catch (error) {
      console.warn('[lumi-memory] failed to load persisted memory vectors', error)
      semanticIndexProgress.value = `加载已保存向量失败: ${errorMessageFrom(error) ?? String(error)}`
    }
  }

  function syncSemanticVectorForMemory(memory: LumiMemoryFragment) {
    if (memory.status === 'rejected') {
      deleteSemanticVector(memory.id)
      return
    }

    semanticVectorWriteQueue = semanticVectorWriteQueue
      .catch(() => {})
      .then(async () => {
        const current = fragments.value.find(fragment => fragment.id === memory.id)
        if (!current || current.status === 'rejected') {
          deleteSemanticVector(memory.id)
          return
        }
        const bridge = persistenceBridge.value
        if (bridge?.syncVector) {
          applyBackendVectorStatus(await bridge.syncVector(current))
          return
        }
        semanticIndexStatus.value = 'fallback'
        semanticIndexDevice.value = 'unknown'
        semanticIndexError.value = '后端向量桥未连接，跳过本次向量同步。'
        semanticIndexProgress.value = semanticIndexError.value
      })
      .catch(error => console.warn('[lumi-memory] failed to sync semantic memory vector', error))
  }
  function deleteSemanticVector(memoryId: string) {
    semanticMemoryVectors.delete(memoryId)
    const bridge = persistenceBridge.value
    if (!bridge?.deleteVector)
      return
    void bridge.deleteVector({ memoryId, model: LUMI_MEMORY_EMBEDDING_MODEL }).catch(error => console.warn('[lumi-memory] failed to delete semantic vector', error))
  }

  function applyBackendVectorStatus(status: LumiMemoryBackendVectorStatus) {
    semanticIndexDevice.value = status.device === 'unknown' ? 'backend' : 'backend'
    semanticIndexedCount.value = status.indexedCount
    semanticSearchPoolSize.value = status.totalCount
    semanticIndexProgress.value = status.progress || `后端向量 ${status.indexedCount}/${status.totalCount} · ${status.device}`
    semanticIndexError.value = status.lastError ?? ''
    semanticDownloadPercent.value = status.downloadPercent == null
      ? (status.phase === 'downloading' || status.phase === 'checking_cache' || status.phase === 'loading_model' ? 35 : null)
      : Math.max(0, Math.min(100, status.downloadPercent))
    semanticIndexReady.value = status.totalCount > 0 && status.missingCount === 0
    semanticIndexStatus.value = status.lastError
      ? 'fallback'
      : status.missingCount > 0
        ? 'loading'
        : 'ready'
  }

  async function pollBackendVectorProgress<T extends LumiMemoryBackendVectorStatus>(
    operation: Promise<T>,
    label: string,
  ): Promise<T> {
    const bridge = persistenceBridge.value
    if (semanticBackendPollTimer)
      globalThis.clearInterval(semanticBackendPollTimer)

    semanticBackendPollTimer = globalThis.setInterval(() => {
      void bridge?.vectorStatus?.({ userId: currentUserId() })
        .then(status => applyBackendVectorStatus(status))
        .catch((error) => {
          semanticIndexProgress.value = `${label}: 閻樿埖鈧礁鍩涢弬鏉裤亼鐠? ${errorMessageFrom(error) ?? String(error)}`
        })
    }, 1000)

    try {
      return await withTimeout(operation, LUMI_SEMANTIC_PREWARM_TIMEOUT_MS, label)
    }
    finally {
      if (semanticBackendPollTimer) {
        globalThis.clearInterval(semanticBackendPollTimer)
        semanticBackendPollTimer = null
      }
    }
  }
  function persistEvent(event: LumiMemoryEvent) {
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    void bridge.saveEvent({ userId: currentUserId(), event }).catch(error => console.warn('[lumi-memory] failed to persist memory event', error))
  }

  function persistSeedId() {
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    void bridge.setSeedId({ userId: currentUserId(), seedId: seedId.value }).catch(error => console.warn('[lumi-memory] failed to persist seed id', error))
  }

  function memoryForCurrentUserSnapshot(fragment: LumiMemoryFragment) {
    if (fragment.scope === 'global' || fragment.scope === 'shared' || fragment.scope === 'group')
      return fragment
    return normalizeMemoryScores({
      ...fragment,
      userId: currentUserId(),
      ownerType: 'user',
      ownerId: currentUserId(),
      participantUserIds: [currentUserId()],
      sourceActorId: currentUserId(),
    })
  }

  function persistSnapshot() {
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    void bridge.replaceSnapshot({
      userId: currentUserId(),
      snapshot: {
        fragments: fragments.value.map(fragment => memoryForCurrentUserSnapshot(fragment)),
        events: events.value,
        seedId: seedId.value,
      },
    }).catch(error => console.warn('[lumi-memory] failed to persist memory snapshot', error))
  }

  const memoryDriver: LumiAlayaMemoryDriver = {
    search: retrieve,
    save: remember,
    update: updateMemory,
    forget,
    delete: deleteMemory,
    merge: mergeMemories,
  }

  return {
    fragments,
    seedId,

    allMemories,
    inspectableMemories,
    promotionCandidates,
    activeMemories,
    candidateMemories,
    recentMemoryEvents,
    duplicateMemoryGroups,
    statusCounts,
    persistenceReady,
    persistenceMode,
    persistenceDbPath,
    persistenceLastError,
    semanticIndexReady,
    semanticIndexLoading,
    semanticIndexStatus,
    semanticIndexError,
    semanticIndexDevice,
    semanticIndexProgress,
    semanticDownloadPercent,
    semanticIndexedCount,
    semanticSearchPoolSize,

    initialize,
    initializePersistence,
    reloadForActiveUser,
    prewarmSemanticIndex,
    setPersistenceBridge,
    resetToMigratedSnapshot,
    search,
    updateMemory,
    updateMemoryStatus,
    promoteMemoryScope,
    promoteMemoryScopes,
    remember,
    rememberCandidate,
    rememberCandidates,
    rememberCandidatesForUser,
    ensureUserMemoryLoaded,
    extractCandidates,
    parseCuratedCandidates,
    retrieve,
    retrieveSemantic,
    forget,
    deleteMemory,
    mergeMemories,
    setLatestTopic,
    getLatestTopic,
    exportSnapshot,
    importSnapshot,
    memoryDriver,
    resetState,
  }
})

function normalizeMemorySnapshot(snapshot: LumiMemoryPersistenceSnapshot): LumiMemoryPersistenceSnapshot {
  return {
    ...snapshot,
    fragments: Array.isArray(snapshot.fragments)
      ? snapshot.fragments.map(fragment => normalizeMemoryScores(fragment))
      : [],
    events: Array.isArray(snapshot.events) ? snapshot.events.slice(0, 200) : [],
    seedId: typeof snapshot.seedId === 'string' ? snapshot.seedId : '',
  }
}

function memoryCandidateFromFragment(memory: LumiMemoryFragment, scope: LumiMemoryScope): LumiMemoryCandidate {
  return {
    type: memory.type,
    content: memory.content,
    sourceMessageId: memory.sourceMessageId,
    confidence: memory.confidence,
    importance: memory.importance,
    emotionalIntensity: memory.emotionalIntensity,
    relationshipRelevance: memory.relationshipRelevance,
    decay: memory.decay,
    tags: memory.tags,
    status: 'candidate',
    reason: 'Operator review of historical memory scope.',
    scope,
    visibility: memory.visibility,
    participantUserIds: memory.participantUserIds,
    subjectUserIds: memory.subjectUserIds,
    sensitivity: memory.sensitivity,
  }
}

function memoryVisibleToUser(memory: LumiMemoryFragment, userId: string) {
  if (memory.scope === 'global' || memory.scope === 'shared')
    return memory.sensitivity !== 'private'
  return memory.userId === userId
    || memory.ownerId === userId
    || memory.participantUserIds?.includes(userId) === true
}

function normalizeVector(vector: number[]) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1
  return vector.map(value => value / norm)
}

function isFiniteVector(vector: unknown): vector is number[] {
  return Array.isArray(vector) && vector.length > 0 && vector.every(value => typeof value === 'number' && Number.isFinite(value))
}

function pruneMap<TKey, TValue>(map: Map<TKey, TValue>, limit: number) {
  while (map.size > limit) {
    const firstKey = map.keys().next().value
    if (firstKey === undefined)
      return
    map.delete(firstKey)
  }
}

function normalizeTopicSource(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function createMemoryId() {
  if (globalThis.crypto?.randomUUID)
    return `mem_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  return `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function createMemoryEventId() {
  if (globalThis.crypto?.randomUUID)
    return `mem_evt_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  return `mem_evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function previewText(text: string, maxLength: number) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label = 'Lumi memory operation'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`))
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

function isEchoOfExistingMemory(content: string, memories: LumiMemoryFragment[]) {
  const candidateTokens = memoryTokens(content)
  if (candidateTokens.size < 3)
    return false

  const normalized = normalizeForEchoCheck(content)
  return memories.some((memory) => {
    const existing = normalizeForEchoCheck(memory.content)
    return normalized === existing
      || (normalized.length > 32 && existing.includes(normalized))
      || (existing.length > 32 && normalized.includes(existing))
      || memoryOverlap(candidateTokens, memoryTokens(memory.content)) >= 0.72
  })
}

function findDuplicateMemoryGroups(memories: LumiMemoryFragment[]): LumiMemoryDuplicateGroup[] {
  const candidates = memories.filter(memory => memory.status === 'active' || memory.status === 'candidate')
  const parent = new Map<string, string>()
  const scores = new Map<string, number>()
  const shared = new Map<string, Set<string>>()

  for (const memory of candidates)
    parent.set(memory.id, memory.id)

  function find(id: string): string {
    const current = parent.get(id) ?? id
    if (current === id)
      return current
    const root = find(current)
    parent.set(id, root)
    return root
  }

  function union(left: LumiMemoryFragment, right: LumiMemoryFragment, score: number, sharedTokens: string[]) {
    const leftRoot = find(left.id)
    const rightRoot = find(right.id)
    if (leftRoot === rightRoot)
      return
    const nextRoot = pickPrimaryMemory([left, right]).id === left.id ? leftRoot : rightRoot
    const oldRoot = nextRoot === leftRoot ? rightRoot : leftRoot
    parent.set(oldRoot, nextRoot)
    const key = nextRoot
    scores.set(key, Math.max(scores.get(leftRoot) ?? 0, scores.get(rightRoot) ?? 0, score))
    const nextShared = new Set<string>([
      ...(shared.get(leftRoot) ?? []),
      ...(shared.get(rightRoot) ?? []),
      ...sharedTokens,
    ])
    shared.set(key, nextShared)
  }

  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      const left = candidates[leftIndex]
      const right = candidates[rightIndex]
      if (left.personaId !== right.personaId || left.scope !== right.scope || left.ownerId !== right.ownerId)
        continue

      const { score, sharedTokens } = memoryDuplicateScore(left, right)
      if (score >= 0.7)
        union(left, right, score, sharedTokens)
    }
  }

  const grouped = new Map<string, LumiMemoryFragment[]>()
  for (const memory of candidates) {
    const root = find(memory.id)
    const group = grouped.get(root) ?? []
    group.push(memory)
    grouped.set(root, group)
  }

  return [...grouped.values()]
    .filter(group => group.length > 1)
    .map((group) => {
      const primaryMemory = pickPrimaryMemory(group)
      const root = find(primaryMemory.id)
      return {
        id: group.map(memory => memory.id).sort().join(':'),
        primaryMemory,
        memories: group.sort((left, right) => memoryPriority(right) - memoryPriority(left)),
        score: scores.get(root) ?? maxPairDuplicateScore(group),
        sharedTokens: [...(shared.get(root) ?? [])].slice(0, 12),
      }
    })
    .sort((left, right) => right.score - left.score || right.memories.length - left.memories.length)
    .slice(0, 20)
}

function memoryDuplicateScore(left: LumiMemoryFragment, right: LumiMemoryFragment) {
  const leftNormalized = normalizeForEchoCheck(left.content)
  const rightNormalized = normalizeForEchoCheck(right.content)
  const leftTokens = memoryTokens(left.content)
  const rightTokens = memoryTokens(right.content)
  const sharedTokens = [...leftTokens].filter(token => rightTokens.has(token))
  const overlap = memoryOverlap(leftTokens, rightTokens)
  const contained = (leftNormalized.length > 32 && rightNormalized.includes(leftNormalized))
    || (rightNormalized.length > 32 && leftNormalized.includes(rightNormalized))
  const sameTypeBonus = left.type === right.type ? 0.08 : -0.12
  const sameStatusBonus = left.status === right.status ? 0.03 : 0
  const containmentBonus = contained ? 0.18 : 0
  const score = Math.max(0, Math.min(1, overlap + sameTypeBonus + sameStatusBonus + containmentBonus))

  return {
    score,
    sharedTokens,
  }
}

function maxPairDuplicateScore(memories: LumiMemoryFragment[]) {
  let best = 0
  for (let leftIndex = 0; leftIndex < memories.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < memories.length; rightIndex += 1)
      best = Math.max(best, memoryDuplicateScore(memories[leftIndex], memories[rightIndex]).score)
  }
  return best
}

function pickPrimaryMemory(memories: LumiMemoryFragment[]) {
  return [...memories].sort((left, right) => memoryPriority(right) - memoryPriority(left))[0]
}

function memoryPriority(memory: LumiMemoryFragment) {
  const statusWeight: Record<LumiMemoryStatus, number> = {
    active: 5,
    candidate: 4,
    contradicted: 3,
    archived: 2,
    rejected: 1,
  }
  return statusWeight[memory.status] * 10
    + memory.importance * 4
    + memory.confidence * 3
    + memory.relationshipRelevance * 2
    + Math.min(memory.content.length / 400, 1)
}

function pickMergedStatus(memories: LumiMemoryFragment[]): LumiMemoryStatus {
  if (memories.some(memory => memory.status === 'active'))
    return 'active'
  if (memories.some(memory => memory.status === 'candidate'))
    return 'candidate'
  if (memories.some(memory => memory.status === 'contradicted'))
    return 'contradicted'
  if (memories.some(memory => memory.status === 'archived'))
    return 'archived'
  return 'rejected'
}

function pickMergedContent(memories: LumiMemoryFragment[]) {
  return [...memories]
    .sort((left, right) => right.content.length - left.content.length || memoryPriority(right) - memoryPriority(left))[0]
    .content
}

function mergeMemoryTags(memories: LumiMemoryFragment[], extraTags: string[]) {
  return mergeTags(memories.flatMap(memory => memory.tags), extraTags)
}

function mergeTags(tags: string[], extraTags: string[]) {
  return [...new Set([...tags, ...extraTags].filter(Boolean))].slice(0, 24)
}

function normalizeForEchoCheck(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function memoryTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const match of text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [])
    tokens.add(match)

  const cjk = text.match(/[\u3400-\u9FFF]/gu) ?? []
  for (let index = 0; index < cjk.length; index += 1) {
    tokens.add(cjk[index])
    if (index + 1 < cjk.length)
      tokens.add(`${cjk[index]}${cjk[index + 1]}`)
  }

  return tokens
}

function memoryOverlap(left: Set<string>, right: Set<string>) {
  if (!left.size || !right.size)
    return 0

  let overlap = 0
  for (const token of left) {
    if (right.has(token))
      overlap += 1
  }

  return overlap / Math.max(1, Math.min(left.size, right.size))
}
