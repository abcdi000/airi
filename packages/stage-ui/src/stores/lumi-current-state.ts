import type { ChatHistoryItem } from '../types/chat'
import type { LumiUserProfileCandidate } from './lumi-user-profile'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import { extractMessageText } from '../libs/chat-sync'

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

export interface LumiCurrentStatePersistenceBridge {
  loadCurrentStateFromDatabase: () => Promise<LumiCurrentStatePersistenceSnapshot>
  saveCurrentState: (snapshot: LumiCurrentStatePersistenceSnapshot) => Promise<LumiCurrentStatePersistenceSnapshot>
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

function parseJsonObject(text: string): Record<string, any> {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fenced?.[1]?.trim() ?? trimmed
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
}) {
  const recent = params.recentMessages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .slice(-16)
    .map((message) => {
      const who = message.role === 'user' ? 'Doggy' : 'Lumi'
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
  let initializePromise: Promise<void> | null = null

  const hasState = computed(() => !!currentState.value.updatedAt)
  const normalizedUpdateEveryTurns = computed(() => Math.min(20, Math.max(1, Math.round(updateEveryTurns.value || 4))))

  function setPersistenceBridge(bridge: LumiCurrentStatePersistenceBridge | null) {
    persistenceBridge.value = bridge
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
        persistenceLastError.value = error instanceof Error ? error.message : String(error)
        persistenceReady.value = true
      }
    })()
    return initializePromise
  }

  async function saveCurrentState(next: Partial<LumiCurrentState>) {
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
      persistenceLastError.value = error instanceof Error ? error.message : String(error)
      console.warn('[lumi-current-state] Failed to save current_state:', persistenceLastError.value)
    }
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
      persistenceLastError.value = error instanceof Error ? error.message : String(error)
    }
  }

  function buildPromptContext() {
    const state = currentState.value
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

  function buildProfileCandidatesFromState(): LumiUserProfileCandidate[] {
    const state = currentState.value
    const candidates: LumiUserProfileCandidate[] = []
    const evidence = `current_state ${state.updatedAt || new Date().toISOString()}`
    if (state.recentTopics[0]) {
      candidates.push({
        layer: 'dynamic',
        key: 'current_focus',
        value: state.recentTopics.slice(0, 3).join('；'),
        confidence: 0.68,
        sourceKind: 'current_state',
        evidence,
      })
    }
    if (state.activeProjects[0]) {
      candidates.push({
        layer: 'dynamic',
        key: 'active_project',
        value: state.activeProjects.slice(0, 3).join('；'),
        confidence: 0.7,
        sourceKind: 'current_state',
        evidence,
      })
    }
    if (state.unfinishedTasks[0]) {
      candidates.push({
        layer: 'dynamic',
        key: 'unresolved_problem',
        value: state.unfinishedTasks.slice(0, 4).join('；'),
        confidence: 0.64,
        sourceKind: 'current_state',
        evidence,
      })
    }
    if (state.userRecentMood) {
      candidates.push({
        layer: 'daily',
        key: 'mood',
        value: state.userRecentMood,
        confidence: 0.6,
        sourceKind: 'current_state',
        evidence,
      })
    }
    return candidates
  }

  function exportSnapshot() {
    return {
      state: currentState.value,
      exportedAt: new Date().toISOString(),
    }
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
    initializePersistence,
    saveCurrentState,
    clearCurrentState,
    buildPromptContext,
    buildProfileCandidatesFromState,
    exportSnapshot,
  }
})
