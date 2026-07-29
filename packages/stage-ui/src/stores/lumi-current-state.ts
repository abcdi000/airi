import type { ChatHistoryItem } from '../types/chat'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import { extractMessageText } from '../libs/chat-sync'
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

function normalizePersistenceSnapshot(snapshot: LumiCurrentStatePersistenceSnapshot): LumiCurrentStatePersistenceSnapshot {
  return {
    ...snapshot,
    state: snapshot.state ? normalizeState(snapshot.state) : null,
  }
}

function parseJsonObject(text: string): Record<string, any> {
  const trimmed = text.trim()
  let raw = trimmed
  if (trimmed.startsWith('```')) {
    const contentStart = trimmed.indexOf('\n')
    const contentEnd = trimmed.lastIndexOf('```')
    if (contentStart >= 0 && contentEnd > contentStart)
      raw = trimmed.slice(contentStart + 1, contentEnd).trim()
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start)
    throw new Error('Current state response did not contain a JSON object')
  return JSON.parse(raw.slice(start, end + 1))
}

export function buildLumiCurrentStateUpdatePrompt() {
  return [
    '你是 Lumi 的短期意识状态整理器。请只输出 JSON，不要输出解释。',
    '任务：根据最近对话、已有用户画像锚点和旧 current_state，更新 Lumi 当前短期意识状态。',
    '规则：',
    '- current_state 只表示近期语境，不得改写长期用户画像或 Lumi 核心人格。',
    '- 单次情绪只写入 userRecentMood，不要把它上升为长期性格判断。',
    '- 不要编造用户没有说过的经历、喜好、决定。',
    '- 如果信息不足，对应字段保留旧值或留空。',
    '- 输出字段必须为：recentTopics, userRecentMood, recentImportantDecisions, activeProjects, unfinishedTasks, relationshipContext, lumiViews, lastContinuationPoint。',
  ].join('\n')
}

export function buildLumiCurrentStateUpdateUserPayload(params: {
  previousState: LumiCurrentState
  profileContext: string
  recentMessages: ChatHistoryItem[]
  userDisplayName?: string
}) {
  const userDisplayName = params.userDisplayName?.trim() || 'Doggy'
  const recent = params.recentMessages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .slice(-16)
    .map((message) => {
      const who = message.role === 'user' ? userDisplayName : 'Lumi'
      return `${who}: ${extractMessageText(message).slice(0, 800)}`
    })
    .join('\n')

  return [
    '旧 current_state:',
    JSON.stringify(params.previousState, null, 2),
    '',
    '相关用户画像锚点:',
    params.profileContext || '(无相关画像)',
    '',
    '最近主线消息:',
    recent || '(无最近消息)',
    '',
    '请输出新的 current_state JSON。',
  ].join('\n')
}

export function parseLumiCurrentStateUpdateOutput(text: string, previousState: LumiCurrentState, sourceMessageIds: string[]) {
  const parsed = parseJsonObject(text)
  return normalizeState({
    ...previousState,
    ...parsed,
    sourceMessageIds,
    turnCount: previousState.turnCount + 1,
    updatedAt: new Date().toISOString(),
  })
}

export const useLumiCurrentStateStore = defineStore('lumi-current-state', () => {
  const currentState = ref<LumiCurrentState>(normalizeState(DEFAULT_STATE))
  const updateEveryTurns = useLocalStorageManualReset<number>('settings/lumi/current-state/update-every-turns', 4)
  const persistenceBridge = shallowRef<LumiCurrentStatePersistenceBridge | null>(null)
  const persistenceReady = ref(false)
  const persistenceDbPath = ref('')
  const persistenceLastError = ref('')
  const activeStateUserId = ref(LUMI_DOGGY_USER_ID)
  const detachedStates = new Map<string, LumiCurrentStatePersistenceSnapshot>()
  const detachedLoadPromises = new Map<string, Promise<LumiCurrentStatePersistenceSnapshot>>()
  const detachedWriteQueues = new Map<string, Promise<void>>()
  let initializePromise: Promise<void> | null = null

  const hasState = computed(() => !!currentState.value.updatedAt)
  const normalizedUpdateEveryTurns = computed(() => Math.min(20, Math.max(1, Math.round(updateEveryTurns.value || 4))))

  function setPersistenceBridge(bridge: LumiCurrentStatePersistenceBridge | null) {
    persistenceBridge.value = bridge
  }

  function setActiveStateUser(userId: string) {
    activeStateUserId.value = userId
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

  function getStateForUser(userId: string) {
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
        if (snapshot.state)
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
    currentState.value = normalizeState(DEFAULT_STATE)
    await initializePersistence()
  }

  async function saveCurrentState(next: Partial<LumiCurrentState>, userId = activeStateUserId.value) {
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
    currentState.value = normalizeState(DEFAULT_STATE)
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

  function buildPromptContext(userId = activeStateUserId.value) {
    const state = getStateForUser(userId)
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
    setActiveStateUser,
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
