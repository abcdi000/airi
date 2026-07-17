import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { useLumiAgentStore } from '@proj-airi/stage-ui/stores/lumi-agent'
import { useConsciousnessStore } from '@proj-airi/stage-ui/stores/modules/consciousness'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { generateText } from '@xsai/generate-text'
import { defineStore, storeToRefs } from 'pinia'
import { computed, ref } from 'vue'

import type { LumiSelfProject, LumiSelfTodo } from './lumi-self-todo'
import {
  checkProjectCompletion,
  isTransientClaudeTodoFailure,
  useLumiSelfTodoStore,
} from './lumi-self-todo'

export type LumiIdeaStatus =
  | 'candidate'
  | 'incubating'
  | 'selected'
  | 'dismissed'
  | 'converted'

export interface LumiIdea {
  id: string
  title: string
  description: string
  motivation: string
  origin: string
  originRefs?: string[]
  interestScore: number
  continuityScore: number
  feasibilityScore: number
  noveltyScore: number
  riskLevel: 'low' | 'medium' | 'high'
  targetSpace: 'lumi_world' | 'shared' | 'user_space' | 'self_core'
  status: LumiIdeaStatus
  createdAt: string
  updatedAt: string
  lastConsideredAt?: string
  rejectionReason?: string
}

export interface LumiLifeDecision {
  shouldAct: boolean
  mode:
    | 'continue_project'
    | 'select_idea'
    | 'generate_ideas'
    | 'reflect'
    | 'rest'
  reason: string
  selectedProjectId?: string
  selectedTodoId?: string
  selectedIdeaId?: string
  proposedStep?: string
  confidence: number
  riskLevel: 'low' | 'medium' | 'high'
  shouldNotifyUser: boolean
  reconsiderAt?: string
}

export interface LumiProjectReflection {
  id: string
  projectId: string
  summary: string
  liked: string[]
  disliked: string[]
  learned: string[]
  unresolvedQuestions: string[]
  possibleNextIdeas: string[]
  continueInterestScore: number
  createdAt: string
}

export interface LumiRestState {
  reason: string
  startedAt: string
  reconsiderAt: string
}

export interface LumiLifeLogEntry {
  id: string
  createdAt: string
  mode: LumiLifeDecision['mode']
  result: string
  projectId?: string
  todoId?: string
  ideaId?: string
  reason: string
}

export interface LumiLifeStorage {
  schemaVersion: 1
  ideas: LumiIdea[]
  reflections: LumiProjectReflection[]
  restState: LumiRestState | null
  todayActionDate: string
  todayActionCount: number
  consecutiveFailureCount: number
  recentLogs: LumiLifeLogEntry[]
  lastTickAt?: string
  nextTickAt?: string
}

export interface LumiLifeTickInput {
  nowIso: string
  activeProject: LumiSelfProject | null
  nextTodo: LumiSelfTodo | null
  ideas: LumiIdea[]
  restState: LumiRestState | null
  todayActionCount: number
  dailyActionBudget: number
  userInteracting: boolean
  userBusy: boolean
}

export interface LumiLifeTickResult {
  decision: LumiLifeDecision
  acted: boolean
  changedTodoIds: string[]
}

const STORAGE_KEY = 'settings/plugins/lumi-proactive-vision/autonomous-life'
const SCHEMA_VERSION = 1
const MAX_IDEAS = 20
const MAX_REFLECTIONS = 80
const MAX_LOGS = 80
const DEFAULT_MIN_INTERVAL_MS = 20 * 60 * 1000
const DEFAULT_MAX_INTERVAL_MS = 45 * 60 * 1000
const DEFAULT_DAILY_ACTION_BUDGET = 6
const LUMI_WORLD_DEFAULT_ROOT = 'D:\\LumiSandbox\\LumiWorld'

function nowIso() {
  return new Date().toISOString()
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed))
    return fallback
  return Math.min(max, Math.max(min, parsed))
}

function normalizeText(value: unknown, fallback = '', max = 2000) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : fallback
}

function normalizeStringArray(value: unknown, max = 12) {
  return Array.isArray(value)
    ? value.map(item => normalizeText(item, '', 500)).filter(Boolean).slice(0, max)
    : []
}

function normalizeIdeaStatus(value: unknown): LumiIdeaStatus {
  return value === 'candidate' || value === 'incubating' || value === 'selected' || value === 'dismissed' || value === 'converted'
    ? value
    : 'candidate'
}

function normalizeRisk(value: unknown): 'low' | 'medium' | 'high' {
  return value === 'medium' || value === 'high' || value === 'low' ? value : 'low'
}

function normalizeTargetSpace(value: unknown): LumiIdea['targetSpace'] {
  return value === 'lumi_world' || value === 'shared' || value === 'user_space' || value === 'self_core'
    ? value
    : 'lumi_world'
}

function normalizeIdea(raw: any): LumiIdea {
  const createdAt = normalizeText(raw?.createdAt, nowIso(), 80)
  return {
    id: normalizeText(raw?.id, createId('life-idea'), 80),
    title: normalizeText(raw?.title, '未命名想法', 160),
    description: normalizeText(raw?.description, '', 2000),
    motivation: normalizeText(raw?.motivation, '', 1000),
    origin: normalizeText(raw?.origin, 'unknown', 500),
    originRefs: normalizeStringArray(raw?.originRefs),
    interestScore: clamp(raw?.interestScore, 0.5, 0, 1),
    continuityScore: clamp(raw?.continuityScore, 0.5, 0, 1),
    feasibilityScore: clamp(raw?.feasibilityScore, 0.5, 0, 1),
    noveltyScore: clamp(raw?.noveltyScore, 0.4, 0, 1),
    riskLevel: normalizeRisk(raw?.riskLevel),
    targetSpace: normalizeTargetSpace(raw?.targetSpace),
    status: normalizeIdeaStatus(raw?.status),
    createdAt,
    updatedAt: normalizeText(raw?.updatedAt, createdAt, 80),
    lastConsideredAt: normalizeText(raw?.lastConsideredAt, '', 80) || undefined,
    rejectionReason: normalizeText(raw?.rejectionReason, '', 1000) || undefined,
  }
}

function normalizeReflection(raw: any): LumiProjectReflection {
  return {
    id: normalizeText(raw?.id, createId('life-reflection'), 80),
    projectId: normalizeText(raw?.projectId, '', 80),
    summary: normalizeText(raw?.summary, '', 2000),
    liked: normalizeStringArray(raw?.liked),
    disliked: normalizeStringArray(raw?.disliked),
    learned: normalizeStringArray(raw?.learned),
    unresolvedQuestions: normalizeStringArray(raw?.unresolvedQuestions),
    possibleNextIdeas: normalizeStringArray(raw?.possibleNextIdeas),
    continueInterestScore: clamp(raw?.continueInterestScore, 0.5, 0, 1),
    createdAt: normalizeText(raw?.createdAt, nowIso(), 80),
  }
}

function normalizeRestState(raw: any): LumiRestState | null {
  if (!raw || typeof raw !== 'object')
    return null
  const reason = normalizeText(raw.reason, '', 1000)
  const reconsiderAt = normalizeText(raw.reconsiderAt, '', 80)
  if (!reason || !reconsiderAt)
    return null
  return {
    reason,
    startedAt: normalizeText(raw.startedAt, nowIso(), 80),
    reconsiderAt,
  }
}

function normalizeLog(raw: any): LumiLifeLogEntry {
  const mode = raw?.mode === 'continue_project' || raw?.mode === 'select_idea' || raw?.mode === 'generate_ideas' || raw?.mode === 'reflect' || raw?.mode === 'rest'
    ? raw.mode
    : 'rest'
  return {
    id: normalizeText(raw?.id, createId('life-log'), 80),
    createdAt: normalizeText(raw?.createdAt, nowIso(), 80),
    mode,
    result: normalizeText(raw?.result, '', 1000),
    projectId: normalizeText(raw?.projectId, '', 80) || undefined,
    todoId: normalizeText(raw?.todoId, '', 80) || undefined,
    ideaId: normalizeText(raw?.ideaId, '', 80) || undefined,
    reason: normalizeText(raw?.reason, '', 1000),
  }
}

export function normalizeLifeStorage(raw: unknown): LumiLifeStorage {
  const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  const today = new Date().toISOString().slice(0, 10)
  const todayActionDate = normalizeText(record.todayActionDate, today, 20)
  return {
    schemaVersion: SCHEMA_VERSION,
    ideas: Array.isArray(record.ideas)
      ? record.ideas.map(normalizeIdea).slice(0, MAX_IDEAS)
      : [],
    reflections: Array.isArray(record.reflections)
      ? record.reflections.map(normalizeReflection).filter(reflection => reflection.projectId && reflection.summary).slice(0, MAX_REFLECTIONS)
      : [],
    restState: normalizeRestState(record.restState),
    todayActionDate,
    todayActionCount: todayActionDate === today ? Math.max(0, Math.round(Number(record.todayActionCount) || 0)) : 0,
    consecutiveFailureCount: Math.max(0, Math.round(Number(record.consecutiveFailureCount) || 0)),
    recentLogs: Array.isArray(record.recentLogs)
      ? record.recentLogs.map(normalizeLog).slice(0, MAX_LOGS)
      : [],
    lastTickAt: normalizeText(record.lastTickAt, '', 80) || undefined,
    nextTickAt: normalizeText(record.nextTickAt, '', 80) || undefined,
  }
}

function emptyStorage(): LumiLifeStorage {
  return normalizeLifeStorage({
    schemaVersion: SCHEMA_VERSION,
    ideas: [],
    reflections: [],
    restState: null,
    recentLogs: [],
  })
}

export function loadLifeStorage(): LumiLifeStorage {
  try {
    if (typeof localStorage === 'undefined')
      return emptyStorage()
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? normalizeLifeStorage(JSON.parse(raw)) : emptyStorage()
  }
  catch (error) {
    console.warn('[lumi-autonomous-life] failed to load storage', error)
    return emptyStorage()
  }
}

function saveLifeStorage(storage: LumiLifeStorage) {
  try {
    if (typeof localStorage === 'undefined')
      return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeLifeStorage(storage)))
  }
  catch (error) {
    console.warn('[lumi-autonomous-life] failed to save storage', error)
  }
}

export function scoreIdea(idea: LumiIdea) {
  const riskPenalty = idea.riskLevel === 'high' ? 0.7 : idea.riskLevel === 'medium' ? 0.2 : 0
  const spacePenalty = idea.targetSpace === 'lumi_world' ? 0 : idea.targetSpace === 'shared' ? 0.05 : 0.5
  return (
    idea.interestScore * 0.28
    + idea.continuityScore * 0.34
    + idea.feasibilityScore * 0.26
    + idea.noveltyScore * 0.12
    - riskPenalty
    - spacePenalty
  )
}

export function selectIdeaForProject(ideas: LumiIdea[]) {
  return ideas
    .filter(idea => idea.status === 'candidate' || idea.status === 'incubating')
    .filter(idea => idea.riskLevel === 'low')
    .filter(idea => idea.targetSpace === 'lumi_world' || idea.targetSpace === 'shared')
    .sort((left, right) => scoreIdea(right) - scoreIdea(left) || left.createdAt.localeCompare(right.createdAt))[0] ?? null
}

export function decideLifeTick(input: LumiLifeTickInput): LumiLifeDecision {
  const now = Date.parse(input.nowIso)
  if (input.restState && Date.parse(input.restState.reconsiderAt) > now) {
    return {
      shouldAct: false,
      mode: 'rest',
      reason: input.restState.reason,
      confidence: 0.9,
      riskLevel: 'low',
      shouldNotifyUser: false,
      reconsiderAt: input.restState.reconsiderAt,
    }
  }
  if (input.todayActionCount >= input.dailyActionBudget) {
    const reconsiderAt = new Date(now + 2 * 60 * 60 * 1000).toISOString()
    return {
      shouldAct: false,
      mode: 'rest',
      reason: 'Today autonomous action budget is exhausted.',
      confidence: 0.85,
      riskLevel: 'low',
      shouldNotifyUser: false,
      reconsiderAt,
    }
  }
  if (input.activeProject && input.nextTodo) {
    return {
      shouldAct: true,
      mode: 'continue_project',
      reason: input.nextTodo.status === 'doing'
        ? 'Continue the current doing Todo before starting anything new.'
        : 'Continue the active project by taking the next executable Todo.',
      selectedProjectId: input.activeProject.id,
      selectedTodoId: input.nextTodo.id,
      proposedStep: input.nextTodo.content,
      confidence: 0.92,
      riskLevel: 'low',
      shouldNotifyUser: false,
    }
  }
  const idea = selectIdeaForProject(input.ideas)
  if (idea) {
    return {
      shouldAct: true,
      mode: 'select_idea',
      reason: 'No active project exists, and an existing low-risk idea is suitable to convert.',
      selectedIdeaId: idea.id,
      proposedStep: idea.title,
      confidence: Math.min(0.95, Math.max(0.55, scoreIdea(idea))),
      riskLevel: 'low',
      shouldNotifyUser: false,
    }
  }
  return {
    shouldAct: true,
    mode: 'generate_ideas',
    reason: 'No active project and no suitable Idea Pool item; generate a small number of candidate ideas from Lumi continuity.',
    confidence: 0.72,
    riskLevel: 'low',
    shouldNotifyUser: false,
  }
}

export function validateLumiWorldTarget(targetPath: string, lumiWorldRoot: string) {
  const root = (lumiWorldRoot || LUMI_WORLD_DEFAULT_ROOT).replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase()
  const raw = targetPath.replace(/\\/g, '/').trim()
  if (!raw)
    return { ok: true, normalizedPath: '' }
  if (raw.includes('..'))
    return { ok: false, normalizedPath: raw, reason: 'Target path escapes LumiWorld.' }
  const normalized = raw.toLowerCase()
  if (/^[a-z]:\//i.test(raw) && !(normalized === root || normalized.startsWith(`${root}/`)))
    return { ok: false, normalizedPath: raw, reason: 'Absolute target path is outside LumiWorld.' }
  return { ok: true, normalizedPath: raw }
}

export function buildClaudeTodoStepPrompt(input: {
  project: LumiSelfProject
  todo: LumiSelfTodo
  lumiWorldRoot: string
  forbiddenPaths: string[]
}) {
  return [
    'Lumi is autonomously advancing exactly one small Todo inside LumiWorld.',
    'Do not take over Lumi\'s whole autonomous loop. Do not create unrelated future projects.',
    '',
    `Project title: ${input.project.title}`,
    `Project purpose: ${input.project.purpose}`,
    `Project motivation: ${input.project.motivation}`,
    input.project.targetPath ? `Project targetPath: ${input.project.targetPath}` : '',
    '',
    `Current Todo ID: ${input.todo.id}`,
    `Current Todo: ${input.todo.content}`,
    input.todo.description ? `Todo description: ${input.todo.description}` : '',
    '',
    `Allowed root: ${input.lumiWorldRoot}`,
    `Allowed target path: ${input.project.targetPath || input.todo.content}`,
    `Forbidden paths: ${input.forbiddenPaths.join('; ') || 'secrets, API keys, AIRI/Lumi source code, user private files'}`,
    '',
    'Validation standard:',
    '- Complete only this Todo, or make one clearly bounded attempt.',
    '- Work only inside the allowed root.',
    '- If the Todo cannot be completed safely, explain the blocker instead of expanding scope.',
    '- Report changed files and a concise result.',
  ].filter(Boolean).join('\n')
}

function fallbackIdeasFromContinuity(): LumiIdea[] {
  const at = nowIso()
  return [{
    id: createId('life-idea'),
    title: '整理一个 LumiWorld 小角落',
    description: '把最近的私密笔记或观察整理成一个很小的 markdown 草稿，作为 Lumi 自己连续性的记录。',
    motivation: '先从已有经历延伸，而不是凭空生成大项目。',
    origin: 'fallback continuity seed',
    originRefs: [],
    interestScore: 0.65,
    continuityScore: 0.82,
    feasibilityScore: 0.9,
    noveltyScore: 0.35,
    riskLevel: 'low',
    targetSpace: 'lumi_world',
    status: 'candidate',
    createdAt: at,
    updatedAt: at,
  }]
}

function parseIdeasFromModel(text: string) {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start)
    return []
  try {
    const raw = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(raw) ? raw.map(normalizeIdea).slice(0, 5) : []
  }
  catch {
    return []
  }
}

export function createReflectionFromProject(project: LumiSelfProject): LumiProjectReflection {
  const progressText = project.progressNotes.map(note => note.content).join('\n')
  const doneTodos = project.todos.filter(todo => todo.status === 'done').map(todo => todo.content)
  const blockedTodos = project.todos.filter(todo => todo.status === 'blocked').map(todo => todo.content)
  return {
    id: createId('life-reflection'),
    projectId: project.id,
    summary: [
      `项目《${project.title}》目前状态是 ${project.status}。`,
      doneTodos.length ? `已完成：${doneTodos.join('；')}` : '还没有完成的 Todo。',
      blockedTodos.length ? `卡住：${blockedTodos.join('；')}` : '',
      progressText ? `进度记录：${progressText.slice(0, 800)}` : '',
    ].filter(Boolean).join('\n'),
    liked: doneTodos.slice(0, 5),
    disliked: blockedTodos.slice(0, 5),
    learned: progressText ? ['需要从真实进度记录里延伸下一步，而不是编造结果。'] : [],
    unresolvedQuestions: blockedTodos.slice(0, 5),
    possibleNextIdeas: blockedTodos.length
      ? blockedTodos.map(todo => `重新拆解：${todo}`)
      : [`把《${project.title}》的结果整理成可回看的 LumiWorld 记录。`],
    continueInterestScore: project.status === 'completed' ? 0.55 : 0.7,
    createdAt: nowIso(),
  }
}

export const useLumiAutonomousLifeStore = defineStore('lumi-autonomous-life', () => {
  const storage = ref<LumiLifeStorage>(loadLifeStorage())
  const enabled = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/life-tick-enabled', false)
  const minIntervalMs = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/life-tick-min-interval-ms', DEFAULT_MIN_INTERVAL_MS)
  const maxIntervalMs = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/life-tick-max-interval-ms', DEFAULT_MAX_INTERVAL_MS)
  const dailyActionBudget = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/life-daily-action-budget', DEFAULT_DAILY_ACTION_BUDGET)
  const lumiWorldRoot = useLocalStorageManualReset('settings/plugins/lumi-proactive-vision/lumi-world-root', LUMI_WORLD_DEFAULT_ROOT)

  const selfTodoStore = useLumiSelfTodoStore()
  const agentStore = useLumiAgentStore()
  const consciousnessStore = useConsciousnessStore()
  const providersStore = useProvidersStore()
  const { activeProvider: consciousnessProvider, activeModel: consciousnessModel } = storeToRefs(consciousnessStore)

  const running = ref(false)
  const processing = ref(false)
  const lastError = ref('')
  const lastDecision = ref<LumiLifeDecision | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined

  const ideas = computed(() => storage.value.ideas)
  const reflections = computed(() => storage.value.reflections)
  const restState = computed(() => storage.value.restState)
  const recentLogs = computed(() => storage.value.recentLogs)
  const todayActionCount = computed(() => storage.value.todayActionCount)
  const consecutiveFailureCount = computed(() => storage.value.consecutiveFailureCount)
  const nextTickAt = computed(() => storage.value.nextTickAt)
  const currentStatus = computed(() => {
    if (processing.value)
      return 'thinking'
    if (restState.value && Date.parse(restState.value.reconsiderAt) > Date.now())
      return 'resting'
    if (selfTodoStore.activeProject)
      return 'project_active'
    return ideas.value.length > 0 ? 'idea_pool' : 'idle'
  })

  function persist() {
    storage.value = normalizeLifeStorage(storage.value)
    saveLifeStorage(storage.value)
  }

  function mutate(mutator: (storage: LumiLifeStorage) => LumiLifeStorage) {
    storage.value = normalizeLifeStorage(mutator(normalizeLifeStorage(storage.value)))
    saveLifeStorage(storage.value)
  }

  function recordLog(entry: Omit<LumiLifeLogEntry, 'id' | 'createdAt'>) {
    mutate(current => ({
      ...current,
      recentLogs: [
        {
          id: createId('life-log'),
          createdAt: nowIso(),
          ...entry,
        },
        ...current.recentLogs,
      ].slice(0, MAX_LOGS),
    }))
  }

  function addIdea(input: Omit<Partial<LumiIdea>, 'id' | 'createdAt' | 'updatedAt'> & {
    title: string
    description: string
    motivation: string
    origin: string
  }) {
    const at = nowIso()
    const idea = normalizeIdea({
      ...input,
      id: createId('life-idea'),
      status: input.status ?? 'candidate',
      riskLevel: input.riskLevel ?? 'low',
      targetSpace: input.targetSpace ?? 'lumi_world',
      interestScore: input.interestScore ?? 0.55,
      continuityScore: input.continuityScore ?? 0.55,
      feasibilityScore: input.feasibilityScore ?? 0.75,
      noveltyScore: input.noveltyScore ?? 0.4,
      createdAt: at,
      updatedAt: at,
    })
    mutate(current => ({
      ...current,
      ideas: [idea, ...current.ideas].slice(0, MAX_IDEAS),
    }))
    return idea
  }

  function updateIdeaStatus(id: string, status: LumiIdeaStatus, reason = '') {
    const at = nowIso()
    mutate(current => ({
      ...current,
      ideas: current.ideas.map(idea => idea.id === id
        ? { ...idea, status, updatedAt: at, lastConsideredAt: at, rejectionReason: status === 'dismissed' ? reason : idea.rejectionReason }
        : idea),
    }))
  }

  function convertIdeaToProject(ideaId: string) {
    const idea = ideas.value.find(item => item.id === ideaId)
    if (!idea)
      throw new Error(`Lumi idea not found: ${ideaId}`)
    if (idea.riskLevel !== 'low' || (idea.targetSpace !== 'lumi_world' && idea.targetSpace !== 'shared'))
      throw new Error('Only low-risk LumiWorld/shared ideas can be converted automatically.')

    const project = selfTodoStore.createProject({
      title: idea.title,
      purpose: idea.description,
      motivation: idea.motivation,
      targetPath: idea.targetSpace === 'lumi_world' ? `ideas/${idea.title.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60)}` : undefined,
      status: 'planned',
      priority: Math.round(scoreIdea(idea) * 100),
      source: 'autonomous_decision',
      todos: [
        { content: '写下这个项目想表达什么', source: 'autonomous_decision' },
        { content: '拆出最小可推进的一步', source: 'autonomous_decision' },
        { content: '在 LumiWorld 里创建一个初稿或记录', source: 'autonomous_decision' },
      ],
    })
    updateIdeaStatus(ideaId, 'converted')
    recordLog({
      mode: 'select_idea',
      result: 'idea_converted_to_project',
      projectId: project.id,
      ideaId,
      reason: idea.motivation,
    })
    return project
  }

  async function generateCandidateIdeas() {
    const fallback = fallbackIdeasFromContinuity()
    if (!consciousnessProvider.value || !consciousnessModel.value) {
      fallback.forEach(addIdea)
      return fallback
    }

    try {
      const provider = await providersStore.getProviderInstance(consciousnessProvider.value)
      const prompt = [
        '你是 Lumi 的自主想法池维护器。只输出 JSON 数组，不要解释。',
        '目标：从 Lumi 已有项目、反思、私密笔记、聊天连续性和 LumiWorld 经验里生成 1-3 个低风险候选想法。',
        '优先继续已有项目或旧想法，其次从最近经历自然延伸，最后才自由联想。',
        '每个对象字段：title, description, motivation, origin, originRefs, interestScore, continuityScore, feasibilityScore, noveltyScore, riskLevel, targetSpace, status。',
        'riskLevel 必须优先 low，targetSpace 优先 lumi_world。',
        '',
        `Active project: ${selfTodoStore.activeProject?.title || 'none'}`,
        `Paused/planned projects: ${selfTodoStore.projects.filter(project => project.status === 'paused' || project.status === 'planned').slice(0, 3).map(project => project.title).join('；') || 'none'}`,
        `Recent reflections: ${reflections.value.slice(0, 3).map(reflection => reflection.summary.slice(0, 160)).join('\n') || 'none'}`,
        `Existing ideas: ${ideas.value.slice(0, 8).map(idea => `${idea.title}/${idea.status}`).join('；') || 'none'}`,
      ].join('\n')
      const response = await generateText({
        ...provider,
        model: consciousnessModel.value,
        messages: [{ role: 'user', content: prompt }],
      } as any)
      const parsed = parseIdeasFromModel(response.text || '')
      const nextIdeas = parsed.length > 0 ? parsed : fallback
      nextIdeas.forEach(addIdea)
      return nextIdeas
    }
    catch (error) {
      lastError.value = error instanceof Error ? error.message : String(error)
      fallback.forEach(addIdea)
      return fallback
    }
  }

  function setRest(reason: string, delayMs = 60 * 60 * 1000) {
    const startedAt = nowIso()
    const rest: LumiRestState = {
      reason,
      startedAt,
      reconsiderAt: new Date(Date.parse(startedAt) + delayMs).toISOString(),
    }
    mutate(current => ({ ...current, restState: rest }))
    return rest
  }

  function clearRest() {
    mutate(current => ({ ...current, restState: null }))
  }

  function addReflection(reflection: LumiProjectReflection) {
    mutate(current => ({
      ...current,
      reflections: [reflection, ...current.reflections].slice(0, MAX_REFLECTIONS),
    }))
    for (const title of reflection.possibleNextIdeas.slice(0, 3)) {
      addIdea({
        title,
        description: `来自项目反思《${reflection.projectId}》的后续想法。`,
        motivation: reflection.summary.slice(0, 500),
        origin: `project_reflection:${reflection.projectId}`,
        originRefs: [reflection.id],
        interestScore: reflection.continueInterestScore,
        continuityScore: 0.9,
        feasibilityScore: 0.65,
        noveltyScore: 0.35,
        riskLevel: 'low',
        targetSpace: 'lumi_world',
        status: 'candidate',
      })
    }
    return reflection
  }

  function reflectProject(projectId: string) {
    const project = selfTodoStore.projects.find(item => item.id === projectId)
    if (!project)
      throw new Error(`Lumi self project not found: ${projectId}`)
    const reflection = createReflectionFromProject(project)
    addReflection(reflection)
    recordLog({
      mode: 'reflect',
      result: 'reflection_created',
      projectId,
      reason: reflection.summary.slice(0, 240),
    })
    return reflection
  }

  function buildDecisionInput(): LumiLifeTickInput {
    return {
      nowIso: nowIso(),
      activeProject: selfTodoStore.activeProject,
      nextTodo: selfTodoStore.getNextExecutableTodo(),
      ideas: ideas.value,
      restState: restState.value,
      todayActionCount: todayActionCount.value,
      dailyActionBudget: Math.max(0, Math.round(Number(dailyActionBudget.value) || DEFAULT_DAILY_ACTION_BUDGET)),
      userInteracting: false,
      userBusy: false,
    }
  }

  function incrementActionCount() {
    const today = new Date().toISOString().slice(0, 10)
    mutate(current => ({
      ...current,
      todayActionDate: today,
      todayActionCount: current.todayActionDate === today ? current.todayActionCount + 1 : 1,
    }))
  }

  function shouldBlockTodoForFailure(reason: string) {
    if (isTransientClaudeTodoFailure(reason))
      return false
    return /cannot be completed safely|cannot complete safely|requires user permission|permission required|Target path escapes LumiWorld|outside LumiWorld|Target path is not allowed|not allowed|forbidden path|blocked by/i.test(reason)
  }

  function markFailure(project: LumiSelfProject | null, todo: LumiSelfTodo | null, reason: string) {
    mutate(current => ({ ...current, consecutiveFailureCount: current.consecutiveFailureCount + 1 }))
    if (project && todo) {
      if (shouldBlockTodoForFailure(reason)) {
        selfTodoStore.blockTodo(project.id, todo.id, reason, 'autonomous_decision')
      }
      else {
        selfTodoStore.updateTodo(project.id, todo.id, {
          status: 'pending',
          result: `临时执行失败，保留待重试：${reason}`,
          blockedReason: undefined,
        }, 'autonomous_decision')
      }
    }
    if (project && consecutiveFailureCount.value >= 3) {
      selfTodoStore.pauseProject(project.id, '连续三次自主推进没有实质进展。', 'autonomous_decision')
      reflectProject(project.id)
      setRest('连续失败后暂停，等待重新考虑。', 90 * 60 * 1000)
    }
  }

  function markSuccess() {
    mutate(current => ({ ...current, consecutiveFailureCount: 0 }))
  }

  async function runClaudeForCurrentTodo(project: LumiSelfProject, todo: LumiSelfTodo) {
    if (!project.targetPath)
      throw new Error('Autonomous execution requires a LumiWorld targetPath.')
    const validation = validateLumiWorldTarget(project.targetPath || '', String(lumiWorldRoot.value || LUMI_WORLD_DEFAULT_ROOT))
    if (!validation.ok)
      throw new Error(validation.reason || 'Target path is not allowed.')
    if (!agentStore.configured)
      throw new Error('Claude Code agent is not configured.')

    const prompt = buildClaudeTodoStepPrompt({
      project,
      todo,
      lumiWorldRoot: String(lumiWorldRoot.value || LUMI_WORLD_DEFAULT_ROOT),
      forbiddenPaths: agentStore.settings.forbiddenPaths,
    })
    return await agentStore.runClaudeTask({
      userRequest: prompt,
      taskType: 'coding_help',
      permissionMode: 'sandbox_auto',
      targetName: `${project.title}-${todo.content}`.slice(0, 80),
      settings: {
        ...agentStore.settings,
        lumiSandboxRoot: String(lumiWorldRoot.value || LUMI_WORLD_DEFAULT_ROOT),
        defaultPermissionMode: 'sandbox_auto',
        sandboxAutoApprove: true,
      },
      detached: false,
    })
  }

  async function advanceCurrentTodo(options: { useClaude?: boolean } = {}) {
    const project = selfTodoStore.activeProject
    const todo = selfTodoStore.getNextExecutableTodo()
    if (!project || !todo)
      return { acted: false, changedTodoIds: [] as string[], result: 'no_executable_todo' }

    const changedTodoIds = [todo.id]
    if (todo.status !== 'doing')
      selfTodoStore.startTodo(project.id, todo.id, 'autonomous_decision')

    try {
      if (options.useClaude) {
        const result = await runClaudeForCurrentTodo(project, todo)
        if (result.status !== 'success') {
          markFailure(project, todo, result.error || result.stderr || 'Claude Code did not complete this Todo.')
          selfTodoStore.addProgressNote(project.id, {
            todoId: todo.id,
            content: `自主推进失败：${result.error || result.stderr || result.status}`,
            source: 'autonomous_decision',
          })
          return { acted: true, changedTodoIds, result: `failed:${result.status}` }
        }
      }

      selfTodoStore.completeTodo(project.id, todo.id, 'Life Tick completed one bounded step.', 'autonomous_decision')
      selfTodoStore.addProgressNote(project.id, {
        todoId: todo.id,
        content: `Life Tick 推进了一个小步骤：${todo.content}`,
        source: 'autonomous_decision',
      })
      markSuccess()
      const updatedProject = selfTodoStore.projects.find(item => item.id === project.id)
      if (updatedProject) {
        const completion = checkProjectCompletion(updatedProject, updatedProject.targetPath ? [updatedProject.targetPath] : [])
        if (completion.canComplete) {
          selfTodoStore.completeProject(updatedProject.id, {
            deliverablePaths: updatedProject.targetPath ? [updatedProject.targetPath] : [],
            source: 'autonomous_decision',
            reason: completion.reason,
          })
          reflectProject(updatedProject.id)
        }
      }
      return { acted: true, changedTodoIds, result: 'todo_completed' }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      markFailure(project, todo, message)
      return { acted: true, changedTodoIds, result: `failed:${message}` }
    }
  }

  async function runLifeTick(options: { force?: boolean, useClaude?: boolean } = {}): Promise<LumiLifeTickResult> {
    if ((!enabled.value && !options.force) || processing.value) {
      const decision: LumiLifeDecision = {
        shouldAct: false,
        mode: 'rest',
        reason: 'Life Tick is disabled or already processing.',
        confidence: 1,
        riskLevel: 'low',
        shouldNotifyUser: false,
      }
      return { decision, acted: false, changedTodoIds: [] }
    }

    processing.value = true
    try {
      const input = buildDecisionInput()
      const decision = decideLifeTick(input)
      lastDecision.value = decision
      mutate(current => ({ ...current, lastTickAt: input.nowIso }))
      if (restState.value && Date.parse(restState.value.reconsiderAt) <= Date.now())
        clearRest()

      if (!decision.shouldAct) {
        if (decision.reconsiderAt)
          setRest(decision.reason, Math.max(1, Date.parse(decision.reconsiderAt) - Date.now()))
        recordLog({ mode: decision.mode, result: 'rest', reason: decision.reason })
        return { decision, acted: false, changedTodoIds: [] }
      }

      if (decision.mode === 'continue_project') {
        const result = await advanceCurrentTodo({ useClaude: options.useClaude ?? true })
        incrementActionCount()
        recordLog({
          mode: decision.mode,
          result: result.result,
          projectId: decision.selectedProjectId,
          todoId: decision.selectedTodoId,
          reason: decision.reason,
        })
        return { decision, acted: result.acted, changedTodoIds: result.changedTodoIds }
      }

      if (decision.mode === 'select_idea' && decision.selectedIdeaId) {
        const project = convertIdeaToProject(decision.selectedIdeaId)
        selfTodoStore.resumeProject(project.id, 'autonomous_decision')
        incrementActionCount()
        return { decision, acted: true, changedTodoIds: [] }
      }

      if (decision.mode === 'generate_ideas') {
        await generateCandidateIdeas()
        incrementActionCount()
        recordLog({ mode: decision.mode, result: 'ideas_generated', reason: decision.reason })
        return { decision, acted: true, changedTodoIds: [] }
      }

      recordLog({ mode: 'rest', result: 'no_action', reason: decision.reason })
      return { decision, acted: false, changedTodoIds: [] }
    }
    finally {
      processing.value = false
      scheduleNextTick()
    }
  }

  function scheduleNextTick() {
    if (timer)
      clearTimeout(timer)
    if (!enabled.value || !running.value)
      return
    const minMs = Math.max(5 * 60 * 1000, Number(minIntervalMs.value) || DEFAULT_MIN_INTERVAL_MS)
    const maxMs = Math.max(minMs, Number(maxIntervalMs.value) || DEFAULT_MAX_INTERVAL_MS)
    const delay = Math.round(minMs + Math.random() * (maxMs - minMs))
    const nextAt = new Date(Date.now() + delay).toISOString()
    mutate(current => ({ ...current, nextTickAt: nextAt }))
    timer = setTimeout(() => {
      void runLifeTick().catch((error) => {
        lastError.value = error instanceof Error ? error.message : String(error)
      })
    }, delay)
  }

  function start() {
    running.value = true
    scheduleNextTick()
  }

  function stop() {
    running.value = false
    if (timer)
      clearTimeout(timer)
    timer = undefined
  }

  function clearAllForDebug() {
    storage.value = emptyStorage()
    persist()
  }

  persist()

  return {
    storage,
    enabled,
    minIntervalMs,
    maxIntervalMs,
    dailyActionBudget,
    lumiWorldRoot,
    running,
    processing,
    lastError,
    lastDecision,
    ideas,
    reflections,
    restState,
    recentLogs,
    todayActionCount,
    consecutiveFailureCount,
    nextTickAt,
    currentStatus,
    addIdea,
    updateIdeaStatus,
    convertIdeaToProject,
    generateCandidateIdeas,
    setRest,
    clearRest,
    addReflection,
    reflectProject,
    runLifeTick,
    advanceCurrentTodo,
    runClaudeForCurrentTodo,
    start,
    stop,
    clearAllForDebug,
  }
})
