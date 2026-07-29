import type { LumiCognitiveIdentity, LumiWorkingMemory } from '@proj-airi/lumi-runtime'

import type { ChatInteractionContext } from '../types/chat'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import { LUMI_AIRI_CARD_ID } from '../constants/lumi-card'
import { LUMI_DOGGY_USER_ID } from './lumi-identity'

export interface LumiCurrentState {
  recentTopics: string[]
  userRecentMood: string
  recentImportantDecisions: string[]
  activeProjects: string[]
  unfinishedTasks: string[]
  relationshipContext: string
  lumiViews: string[]
  lastContinuationPoint: string
  sourceMessageIds: string[]
  turnCount: number
  updatedAt: string
}

export interface LumiCurrentStatePersistenceSnapshot {
  state: LumiCurrentState | null
  dbPath?: string
}

export interface LumiCurrentStateExportSnapshot extends LumiCurrentStatePersistenceSnapshot {
  updateEveryTurns: number
  exportedAt: string
}

export interface LumiCurrentStatePersistenceBridge {
  loadCurrentStateFromDatabase: (userId?: string) => Promise<LumiCurrentStatePersistenceSnapshot>
  saveCurrentState: (snapshot: LumiCurrentStatePersistenceSnapshot, userId?: string) => Promise<LumiCurrentStatePersistenceSnapshot>
  clearCurrentState: () => Promise<void>
}

/** Host-owned read boundary for the unified cognitive Working Memory. */
export interface LumiCurrentStateCognitiveBridge {
  /** Loads only the exact actor and conversation projection requested by Renderer. */
  loadWorkingMemory: (request: { identity: LumiCognitiveIdentity }) => Promise<LumiWorkingMemory | null>
}

const DEFAULT_STATE: LumiCurrentState = {
  recentTopics: [],
  userRecentMood: '',
  recentImportantDecisions: [],
  activeProjects: [],
  unfinishedTasks: [],
  relationshipContext: '',
  lumiViews: [],
  lastContinuationPoint: '',
  sourceMessageIds: [],
  turnCount: 0,
  updatedAt: '',
}

function normalizeList(value: unknown, limit = 6) {
  if (Array.isArray(value))
    return value.map(item => String(item).trim()).filter(Boolean).slice(0, limit)
  if (typeof value === 'string' && value.trim())
    return [value.trim()].slice(0, limit)
  return []
}

function normalizeState(value: Partial<LumiCurrentState> | null | undefined): LumiCurrentState {
  const now = new Date().toISOString()
  return {
    recentTopics: normalizeList(value?.recentTopics),
    userRecentMood: typeof value?.userRecentMood === 'string' ? value.userRecentMood.trim() : '',
    recentImportantDecisions: normalizeList(value?.recentImportantDecisions),
    activeProjects: normalizeList(value?.activeProjects),
    unfinishedTasks: normalizeList(value?.unfinishedTasks),
    relationshipContext: typeof value?.relationshipContext === 'string' ? value.relationshipContext.trim() : '',
    lumiViews: normalizeList(value?.lumiViews),
    lastContinuationPoint: typeof value?.lastContinuationPoint === 'string' ? value.lastContinuationPoint.trim() : '',
    sourceMessageIds: normalizeList(value?.sourceMessageIds, 12),
    turnCount: Number.isFinite(value?.turnCount) ? Math.max(0, Math.round(value!.turnCount!)) : 0,
    updatedAt: typeof value?.updatedAt === 'string' && value.updatedAt ? value.updatedAt : now,
  }
}

function createEmptyState(): LumiCurrentState {
  return {
    ...DEFAULT_STATE,
    recentTopics: [],
    recentImportantDecisions: [],
    activeProjects: [],
    unfinishedTasks: [],
    lumiViews: [],
    sourceMessageIds: [],
  }
}

function cognitiveStateKey(actorId: string, conversationId: string) {
  return `${actorId}\u0000${conversationId}`
}

/** Projects authoritative Working Memory into the deprecated current_state display shape. */
function projectWorkingMemory(memory: LumiWorkingMemory | null): LumiCurrentState {
  if (!memory)
    return createEmptyState()

  return normalizeState({
    recentTopics: memory.activeTopics.map(item => item.value),
    userRecentMood: memory.temporaryUserStates.map(item => item.value).join('；'),
    recentImportantDecisions: memory.goals.map(item => item.value),
    activeProjects: memory.projects.map(item => item.value),
    unfinishedTasks: memory.openLoops.map(item => item.value),
    relationshipContext: memory.relationshipContext?.value ?? '',
    lumiViews: [],
    lastContinuationPoint: memory.continuationPoint ?? '',
    sourceMessageIds: memory.sourceMessageIds,
    turnCount: 0,
    updatedAt: memory.updatedAt,
  })
}

function normalizePersistenceSnapshot(snapshot: LumiCurrentStatePersistenceSnapshot): LumiCurrentStatePersistenceSnapshot {
  return {
    ...snapshot,
    state: snapshot.state ? normalizeState(snapshot.state) : null,
  }
}

export const useLumiCurrentStateStore = defineStore('lumi-current-state', () => {
  const currentState = ref<LumiCurrentState>(createEmptyState())
  const updateEveryTurns = useLocalStorageManualReset<number>('settings/lumi/current-state/update-every-turns', 4)
  const persistenceBridge = shallowRef<LumiCurrentStatePersistenceBridge | null>(null)
  const cognitiveBridge = shallowRef<LumiCurrentStateCognitiveBridge | null>(null)
  const persistenceReady = ref(false)
  const persistenceDbPath = ref('')
  const persistenceLastError = ref('')
  const activeStateUserId = ref(LUMI_DOGGY_USER_ID)
  const activeStateConversationId = ref('')
  const cognitiveStates = new Map<string, LumiCurrentState>()
  const detachedStates = new Map<string, LumiCurrentStatePersistenceSnapshot>()
  const detachedLoadPromises = new Map<string, Promise<LumiCurrentStatePersistenceSnapshot>>()
  const detachedWriteQueues = new Map<string, Promise<void>>()
  let initializePromise: Promise<void> | null = null

  const hasState = computed(() => !!currentState.value.updatedAt)
  const normalizedUpdateEveryTurns = computed(() => Math.min(20, Math.max(1, Math.round(updateEveryTurns.value || 4))))

  function setPersistenceBridge(bridge: LumiCurrentStatePersistenceBridge | null) {
    persistenceBridge.value = bridge
  }

  function setCognitiveBridge(bridge: LumiCurrentStateCognitiveBridge | null) {
    cognitiveBridge.value = bridge
    cognitiveStates.clear()
  }

  function setActiveStateUser(userId: string) {
    activeStateUserId.value = userId
  }

  function setActiveStateConversation(conversationId: string) {
    activeStateConversationId.value = conversationId
    currentState.value = cognitiveStates.get(cognitiveStateKey(activeStateUserId.value, conversationId))
      ?? createEmptyState()
  }

  /** Reloads one exact, direct-conversation Working Memory projection from its host. */
  async function refreshCognitiveProjection(interaction: ChatInteractionContext) {
    const key = cognitiveStateKey(interaction.actorId, interaction.conversationId)
    if (interaction.conversationType === 'group') {
      const empty = createEmptyState()
      cognitiveStates.set(key, empty)
      return empty
    }

    const bridge = cognitiveBridge.value
    const state = projectWorkingMemory(bridge
      ? await bridge.loadWorkingMemory({
          identity: {
            actorId: interaction.actorId,
            personaId: LUMI_AIRI_CARD_ID,
            conversationId: interaction.conversationId,
            conversationType: interaction.conversationType,
            participantUserIds: [...interaction.participantIds],
          },
        })
      : null)
    cognitiveStates.set(key, state)
    if (interaction.actorId === activeStateUserId.value && interaction.conversationId === activeStateConversationId.value)
      currentState.value = state
    return state
  }

  /** Loads one user's short-term state without changing the settings UI identity. */
  async function ensureUserStateLoaded(userId: string) {
    if (userId === activeStateUserId.value && persistenceReady.value)
      return { state: currentState.value, dbPath: persistenceDbPath.value || undefined }

    const cached = detachedStates.get(userId)
    if (cached)
      return cached

    const pending = detachedLoadPromises.get(userId)
    if (pending)
      return pending

    const bridge = persistenceBridge.value
    if (!bridge)
      return { state: null }

    const load = bridge.loadCurrentStateFromDatabase(userId)
      .then((snapshot) => {
        const normalized = normalizePersistenceSnapshot(snapshot)
        detachedStates.set(userId, normalized)
        return normalized
      })
      .finally(() => detachedLoadPromises.delete(userId))
    detachedLoadPromises.set(userId, load)
    return load
  }

  function getStateForUser(userId: string, conversationId?: string) {
    if (cognitiveBridge.value) {
      const targetConversationId = conversationId
        ?? (userId === activeStateUserId.value ? activeStateConversationId.value : '')
      if (!targetConversationId)
        return createEmptyState()
      return cognitiveStates.get(cognitiveStateKey(userId, targetConversationId)) ?? createEmptyState()
    }
    if (userId === activeStateUserId.value)
      return currentState.value
    return normalizeState(detachedStates.get(userId)?.state ?? DEFAULT_STATE)
  }

  async function initializePersistence() {
    if (initializePromise)
      return initializePromise

    initializePromise = (async () => {
      const bridge = persistenceBridge.value
      if (!bridge) {
        persistenceReady.value = true
        return
      }
      try {
        const snapshot = await bridge.loadCurrentStateFromDatabase()
        persistenceDbPath.value = snapshot.dbPath ?? ''
        if (!cognitiveBridge.value && snapshot.state)
          currentState.value = normalizeState(snapshot.state)
        persistenceReady.value = true
      }
      catch (error) {
        persistenceLastError.value = errorMessageFrom(error) ?? String(error)
        persistenceReady.value = true
      }
    })()
    return initializePromise
  }

  async function reloadForActiveUser() {
    initializePromise = null
    persistenceReady.value = false
    currentState.value = createEmptyState()
    await initializePersistence()
  }

  async function saveCurrentState(next: Partial<LumiCurrentState>, userId = activeStateUserId.value) {
    if (cognitiveBridge.value)
      throw new Error('Legacy current_state is read-only while unified cognitive working memory is active')

    if (userId !== activeStateUserId.value) {
      return enqueueDetachedWrite(userId, async () => {
        const previous = (await ensureUserStateLoaded(userId)).state
        const state = normalizeState({ ...previous, ...next })
        const bridge = persistenceBridge.value
        const snapshot = bridge
          ? normalizePersistenceSnapshot(await bridge.saveCurrentState({ state }, userId))
          : { state }
        detachedStates.set(userId, snapshot)
        return snapshot.state ? normalizeState(snapshot.state) : state
      })
    }

    currentState.value = normalizeState({ ...currentState.value, ...next })
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    try {
      const snapshot = await bridge.saveCurrentState({ state: currentState.value })
      persistenceDbPath.value = snapshot.dbPath ?? persistenceDbPath.value
      if (snapshot.state)
        currentState.value = normalizeState(snapshot.state)
    }
    catch (error) {
      persistenceLastError.value = errorMessageFrom(error) ?? String(error)
      console.warn('[lumi-current-state] Failed to save current_state:', persistenceLastError.value)
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

  async function clearCurrentState() {
    currentState.value = createEmptyState()
    const bridge = persistenceBridge.value
    if (!bridge)
      return
    try {
      await bridge.clearCurrentState()
    }
    catch (error) {
      persistenceLastError.value = errorMessageFrom(error) ?? String(error)
    }
  }

  function buildPromptContext(userId = activeStateUserId.value, conversationId?: string) {
    const state = getStateForUser(userId, conversationId)
    const sections: string[] = []
    if (state.recentTopics.length)
      sections.push(`最近话题：${state.recentTopics.join('；')}`)
    if (state.userRecentMood)
      sections.push(`用户近期状态：${state.userRecentMood}`)
    if (state.activeProjects.length)
      sections.push(`当前活跃项目：${state.activeProjects.join('；')}`)
    if (state.unfinishedTasks.length)
      sections.push(`未完成事项：${state.unfinishedTasks.join('；')}`)
    if (state.recentImportantDecisions.length)
      sections.push(`近期重要决定：${state.recentImportantDecisions.join('；')}`)
    if (state.relationshipContext)
      sections.push(`当前关系/语境认知：${state.relationshipContext}`)
    if (state.lumiViews.length)
      sections.push(`Lumi 的近期看法：${state.lumiViews.join('；')}`)
    if (state.lastContinuationPoint)
      sections.push(`上次续接点：${state.lastContinuationPoint}`)
    return sections.join('\n')
  }

  function exportSnapshot(): LumiCurrentStateExportSnapshot {
    return {
      state: hasState.value ? currentState.value : null,
      updateEveryTurns: normalizedUpdateEveryTurns.value,
      exportedAt: new Date().toISOString(),
      dbPath: persistenceDbPath.value || undefined,
    }
  }

  async function importSnapshot(snapshot: Partial<LumiCurrentStateExportSnapshot>) {
    if (typeof snapshot.updateEveryTurns === 'number' && Number.isFinite(snapshot.updateEveryTurns))
      updateEveryTurns.value = Math.min(20, Math.max(1, Math.round(snapshot.updateEveryTurns)))

    if (snapshot.state)
      await saveCurrentState(snapshot.state)
    else if (snapshot.state === null)
      await clearCurrentState()
  }

  return {
    currentState,
    updateEveryTurns,
    normalizedUpdateEveryTurns,
    persistenceReady,
    persistenceDbPath,
    persistenceLastError,
    hasState,

    setPersistenceBridge,
    setCognitiveBridge,
    setActiveStateUser,
    setActiveStateConversation,
    refreshCognitiveProjection,
    ensureUserStateLoaded,
    getStateForUser,
    initializePersistence,
    reloadForActiveUser,
    saveCurrentState,
    clearCurrentState,
    buildPromptContext,
    exportSnapshot,
    importSnapshot,
  }
})
