import type { ChatHistoryItem } from '@proj-airi/stage-ui/types/chat'

import { useChatSessionStore } from '@proj-airi/stage-ui/stores/chat/session-store'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

export type LumiSelfProjectStatus =
  | 'planned'
  | 'active'
  | 'paused'
  | 'completed'
  | 'abandoned'

export type LumiSelfTodoStatus =
  | 'pending'
  | 'doing'
  | 'done'
  | 'blocked'
  | 'cancelled'

export type LumiSelfTodoSource =
  | 'manual'
  | 'autonomous_decision'
  | 'reflection'
  | 'conversation'

export interface LumiSelfProject {
  id: string
  title: string
  purpose: string
  motivation: string
  targetPath?: string
  status: LumiSelfProjectStatus
  priority: number
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  pausedReason?: string
  abandonedReason?: string
  source?: LumiSelfTodoSource
  todos: LumiSelfTodo[]
  progressNotes: LumiSelfProgressNote[]
}

export interface LumiSelfTodo {
  id: string
  projectId: string
  content: string
  description?: string
  status: LumiSelfTodoStatus
  order: number
  dependsOn?: string[]
  result?: string
  blockedReason?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  source?: LumiSelfTodoSource
}

export interface LumiSelfProgressNote {
  id: string
  projectId: string
  todoId?: string
  content: string
  createdAt: string
  source?: LumiSelfTodoSource
}

export interface ProjectCompletionCheck {
  todoCompletionRate: number
  hasDeliverable: boolean
  deliverablePaths: string[]
  hasProgressSummary: boolean
  canComplete: boolean
  reason: string
}

export interface LumiSelfTodoStorage {
  schemaVersion: 1
  projects: LumiSelfProject[]
}

export interface CreateProjectInput {
  title: string
  purpose: string
  motivation: string
  targetPath?: string
  status?: LumiSelfProjectStatus
  priority?: number
  source?: LumiSelfTodoSource
  todos?: Array<{
    content: string
    description?: string
    dependsOn?: string[]
    source?: LumiSelfTodoSource
  }>
}

export interface UpdateProjectInput {
  title?: string
  purpose?: string
  motivation?: string
  targetPath?: string
  status?: LumiSelfProjectStatus
  priority?: number
  pausedReason?: string
  abandonedReason?: string
}

export interface AddTodoInput {
  content: string
  description?: string
  dependsOn?: string[]
  order?: number
  source?: LumiSelfTodoSource
}

export interface UpdateTodoInput {
  content?: string
  description?: string
  status?: LumiSelfTodoStatus
  order?: number
  dependsOn?: string[]
  result?: string
  blockedReason?: string
  startedAt?: string
  completedAt?: string
}

const STORAGE_KEY = 'settings/plugins/lumi-proactive-vision/self-todo'
const SCHEMA_VERSION = 1
const MAX_PROJECTS = 80
const MAX_PROGRESS_NOTES_PER_PROJECT = 120

const PROJECT_STATUSES: LumiSelfProjectStatus[] = ['planned', 'active', 'paused', 'completed', 'abandoned']
const TODO_STATUSES: LumiSelfTodoStatus[] = ['pending', 'doing', 'done', 'blocked', 'cancelled']

function nowIso() {
  return new Date().toISOString()
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeText(value: unknown, fallback = '', max = 2000) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : fallback
}

export function isTransientClaudeTodoFailure(reason: unknown) {
  if (typeof reason !== 'string')
    return false
  return /Claude Code did not complete this Todo|Claude Code agent is not configured|spawn .*ENOENT|timed? out|timeout|Timed out waiting|ERR_ABORTED|no stdin data received|WebSocket|connection closed/i.test(reason)
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed))
    return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

function normalizeSource(value: unknown): LumiSelfTodoSource {
  return value === 'autonomous_decision' || value === 'reflection' || value === 'conversation' || value === 'manual'
    ? value
    : 'manual'
}

function normalizeProjectStatus(value: unknown): LumiSelfProjectStatus {
  return PROJECT_STATUSES.includes(value as LumiSelfProjectStatus)
    ? value as LumiSelfProjectStatus
    : 'planned'
}

function normalizeTodoStatus(value: unknown): LumiSelfTodoStatus {
  return TODO_STATUSES.includes(value as LumiSelfTodoStatus)
    ? value as LumiSelfTodoStatus
    : 'pending'
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map(item => normalizeText(item, '', 160)).filter(Boolean)
    : []
}

function normalizeTodo(raw: any, projectId: string, index: number): LumiSelfTodo {
  const createdAt = normalizeText(raw?.createdAt, nowIso(), 80)
  return {
    id: normalizeText(raw?.id, createId('self-todo'), 80),
    projectId,
    content: normalizeText(raw?.content, 'Untitled todo', 500),
    description: normalizeText(raw?.description, '', 2000) || undefined,
    status: normalizeTodoStatus(raw?.status),
    order: normalizeNumber(raw?.order, index, 0, 10_000),
    dependsOn: normalizeStringArray(raw?.dependsOn),
    result: normalizeText(raw?.result, '', 2000) || undefined,
    blockedReason: normalizeText(raw?.blockedReason, '', 1000) || undefined,
    createdAt,
    updatedAt: normalizeText(raw?.updatedAt, createdAt, 80),
    startedAt: normalizeText(raw?.startedAt, '', 80) || undefined,
    completedAt: normalizeText(raw?.completedAt, '', 80) || undefined,
    source: normalizeSource(raw?.source),
  }
}

function normalizeProgressNote(raw: any, projectId: string): LumiSelfProgressNote {
  return {
    id: normalizeText(raw?.id, createId('self-progress'), 80),
    projectId,
    todoId: normalizeText(raw?.todoId, '', 80) || undefined,
    content: normalizeText(raw?.content, '', 4000),
    createdAt: normalizeText(raw?.createdAt, nowIso(), 80),
    source: normalizeSource(raw?.source),
  }
}

function normalizeProject(raw: any, index: number): LumiSelfProject {
  const createdAt = normalizeText(raw?.createdAt, nowIso(), 80)
  const id = normalizeText(raw?.id, createId('self-project'), 80)
  const todos = Array.isArray(raw?.todos)
    ? raw.todos.map((todo: any, todoIndex: number) => normalizeTodo(todo, id, todoIndex))
    : []
  const progressNotes = Array.isArray(raw?.progressNotes)
    ? raw.progressNotes.map((note: any) => normalizeProgressNote(note, id)).filter((note: LumiSelfProgressNote) => note.content)
    : []

  return {
    id,
    title: normalizeText(raw?.title, `Lumi self project ${index + 1}`, 160),
    purpose: normalizeText(raw?.purpose, '', 1000),
    motivation: normalizeText(raw?.motivation, '', 1000),
    targetPath: normalizeText(raw?.targetPath, '', 500) || undefined,
    status: normalizeProjectStatus(raw?.status),
    priority: normalizeNumber(raw?.priority, 50, 0, 100),
    createdAt,
    updatedAt: normalizeText(raw?.updatedAt, createdAt, 80),
    startedAt: normalizeText(raw?.startedAt, '', 80) || undefined,
    completedAt: normalizeText(raw?.completedAt, '', 80) || undefined,
    pausedReason: normalizeText(raw?.pausedReason, '', 1000) || undefined,
    abandonedReason: normalizeText(raw?.abandonedReason, '', 1000) || undefined,
    source: normalizeSource(raw?.source),
    todos,
    progressNotes: progressNotes.slice(-MAX_PROGRESS_NOTES_PER_PROJECT),
  }
}

export function normalizeSelfTodoStorage(raw: unknown): LumiSelfTodoStorage {
  const record = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  const projects = Array.isArray(record.projects)
    ? record.projects.map((project, index) => normalizeProject(project, index)).slice(0, MAX_PROJECTS)
    : []

  let activeSeen = false
  const normalizedProjects = projects.map((project) => {
    if (project.status !== 'active')
      return project
    if (!activeSeen) {
      activeSeen = true
      return project
    }
    return {
      ...project,
      status: 'paused' as const,
      pausedReason: project.pausedReason || 'Paused automatically because Lumi can only have one active self project.',
      updatedAt: nowIso(),
    }
  })

  return {
    schemaVersion: SCHEMA_VERSION,
    projects: normalizedProjects,
  }
}

function emptyStorage(): LumiSelfTodoStorage {
  return {
    schemaVersion: SCHEMA_VERSION,
    projects: [],
  }
}

export function loadSelfTodoStorage(): LumiSelfTodoStorage {
  try {
    if (typeof localStorage === 'undefined')
      return emptyStorage()
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw)
      return emptyStorage()
    return normalizeSelfTodoStorage(JSON.parse(raw))
  }
  catch (error) {
    console.warn('[lumi-self-todo] failed to load persisted todo data, falling back to empty storage', error)
    return emptyStorage()
  }
}

function saveSelfTodoStorage(data: LumiSelfTodoStorage) {
  try {
    if (typeof localStorage === 'undefined')
      return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSelfTodoStorage(data)))
  }
  catch (error) {
    console.warn('[lumi-self-todo] failed to persist todo data', error)
  }
}

export function getProjectProgress(project: LumiSelfProject) {
  const total = project.todos.length
  const done = project.todos.filter(todo => todo.status === 'done').length
  const cancelled = project.todos.filter(todo => todo.status === 'cancelled').length
  const blocked = project.todos.filter(todo => todo.status === 'blocked').length
  return {
    total,
    done,
    cancelled,
    blocked,
    active: project.todos.filter(todo => todo.status === 'doing').length,
    completionRate: total > 0 ? done / total : 0,
    closedRate: total > 0 ? (done + cancelled) / total : 0,
  }
}

function dependenciesCompleted(project: LumiSelfProject, todo: LumiSelfTodo) {
  const deps = todo.dependsOn ?? []
  if (deps.length === 0)
    return true
  const todoMap = new Map(project.todos.map(item => [item.id, item]))
  return deps.every(depId => todoMap.get(depId)?.status === 'done')
}

export function selectNextExecutableTodo(projects: LumiSelfProject[], projectId?: string): LumiSelfTodo | null {
  const activeProjects = projects
    .filter(project => project.status === 'active')
    .filter(project => !projectId || project.id === projectId)
    .sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt))
  const project = activeProjects[0]
  if (!project)
    return null

  const doing = project.todos
    .filter(todo => todo.status === 'doing')
    .sort((left, right) => left.order - right.order)[0]
  if (doing)
    return doing

  return project.todos
    .filter(todo => todo.status === 'pending')
    .filter(todo => dependenciesCompleted(project, todo))
    .sort((left, right) => left.order - right.order || left.createdAt.localeCompare(right.createdAt))[0] ?? null
}

export function checkProjectCompletion(project: LumiSelfProject, deliverablePaths: string[] = []): ProjectCompletionCheck {
  const todos = project.todos
  const doneOrCancelled = todos.filter(todo => todo.status === 'done' || todo.status === 'cancelled').length
  const blocked = todos.filter(todo => todo.status === 'blocked')
  const todoCompletionRate = todos.length > 0 ? doneOrCancelled / todos.length : 0
  const normalizedDeliverables = deliverablePaths.map(path => path.replace(/\\/g, '/').toLowerCase())
  const targetPath = project.targetPath?.replace(/\\/g, '/').toLowerCase()
  const hasDeliverable = !targetPath || normalizedDeliverables.some(path => path === targetPath || path.endsWith(`/${targetPath}`))
  const hasProgressSummary = project.progressNotes.some(note => note.content.trim().length >= 20)
  const allTodosClosed = todos.length > 0 && doneOrCancelled === todos.length

  if (!allTodosClosed) {
    return {
      todoCompletionRate,
      hasDeliverable,
      deliverablePaths,
      hasProgressSummary,
      canComplete: false,
      reason: 'There are still pending or doing todos.',
    }
  }
  if (blocked.length > 0) {
    return {
      todoCompletionRate,
      hasDeliverable,
      deliverablePaths,
      hasProgressSummary,
      canComplete: false,
      reason: 'There are blocked todos that must be resolved or cancelled first.',
    }
  }
  if (!hasDeliverable) {
    return {
      todoCompletionRate,
      hasDeliverable,
      deliverablePaths,
      hasProgressSummary,
      canComplete: false,
      reason: 'The declared targetPath has not been provided as a deliverable.',
    }
  }
  if (!hasProgressSummary) {
    return {
      todoCompletionRate,
      hasDeliverable,
      deliverablePaths,
      hasProgressSummary,
      canComplete: false,
      reason: 'A final progress summary is required before completion.',
    }
  }

  return {
    todoCompletionRate,
    hasDeliverable,
    deliverablePaths,
    hasProgressSummary,
    canComplete: true,
    reason: 'All todos are closed, deliverables are present, and a progress summary exists.',
  }
}

export const useLumiSelfTodoStore = defineStore('lumi-self-todo', () => {
  const storage = ref<LumiSelfTodoStorage>(loadSelfTodoStorage())

  const projects = computed(() => storage.value.projects)
  const activeProjects = computed(() => projects.value.filter(project => project.status === 'active'))
  const activeProject = computed(() => activeProjects.value[0] ?? null)
  const nextExecutableTodo = computed(() => selectNextExecutableTodo(projects.value))

  function repairStorage() {
    storage.value = normalizeSelfTodoStorage(storage.value)
    storage.value = {
      ...storage.value,
      projects: storage.value.projects.map((project) => {
        let recoveredTransientTodo = false
        const todos = project.todos.map((todo) => {
          if (todo.status !== 'blocked' || !isTransientClaudeTodoFailure(todo.blockedReason))
            return todo
          recoveredTransientTodo = true
          return {
            ...todo,
            status: 'pending' as LumiSelfTodoStatus,
            result: `Recovered from transient Claude execution failure: ${todo.blockedReason}`,
            blockedReason: undefined,
            updatedAt: nowIso(),
          }
        })
        const shouldResumePoisonedProject = recoveredTransientTodo
          && project.status === 'paused'
          && /连续三次自主推进没有实质进展/.test(project.pausedReason || '')
        return {
          ...project,
          status: shouldResumePoisonedProject ? 'active' : project.status,
          pausedReason: shouldResumePoisonedProject ? undefined : project.pausedReason,
          todos,
          updatedAt: recoveredTransientTodo ? nowIso() : project.updatedAt,
        }
      }),
    }
    saveSelfTodoStorage(storage.value)
  }

  function mutate(mutator: (projects: LumiSelfProject[]) => LumiSelfProject[]) {
    const current = normalizeSelfTodoStorage(storage.value).projects
    storage.value = {
      schemaVersion: SCHEMA_VERSION,
      projects: mutator(current),
    }
    saveSelfTodoStorage(storage.value)
  }

  function findProject(projectId: string) {
    const project = projects.value.find(item => item.id === projectId)
    if (!project)
      throw new Error(`Lumi self project not found: ${projectId}`)
    return project
  }

  function appendSystemNotice(lines: string[]) {
    try {
      const chatSession = useChatSessionStore()
      const sessionId = chatSession.activeSessionId
      if (!sessionId)
        return
      chatSession.ensureSession?.(sessionId)
      const content = [
        '[system_notice]',
        'title: Lumi Self Todo',
        ...lines,
      ].join('\n')
      const message: ChatHistoryItem = {
        id: createId('lumi-self-todo-notice'),
        role: 'assistant',
        content,
        slices: [{ type: 'text', text: content }],
        tool_results: [],
        createdAt: Date.now(),
      }
      chatSession.setSessionMessages(sessionId, [
        ...chatSession.getSessionMessages(sessionId),
        message,
      ])
    }
    catch (error) {
      console.warn('[lumi-self-todo] failed to append system notice', error)
    }
  }

  function notifyTodoStatusChange(input: {
    projectId: string
    todoId?: string
    oldStatus: string
    newStatus: string
    source: LumiSelfTodoSource
    reason: string
  }) {
    appendSystemNotice([
      'status: updated',
      `projectId: ${input.projectId}`,
      input.todoId ? `todoId: ${input.todoId}` : 'todoId: project',
      `oldStatus: ${input.oldStatus}`,
      `newStatus: ${input.newStatus}`,
      `source: ${input.source}`,
      `reason: ${input.reason}`,
    ])
  }

  function enforceSingleActiveProject(projectList: LumiSelfProject[], activeProjectId: string) {
    const at = nowIso()
    return projectList.map((project) => {
      if (project.id === activeProjectId || project.status !== 'active')
        return project
      return {
        ...project,
        status: 'paused' as const,
        pausedReason: project.pausedReason || 'Paused because Lumi started another self project.',
        updatedAt: at,
      }
    })
  }

  function createProject(input: CreateProjectInput) {
    const at = nowIso()
    const project: LumiSelfProject = {
      id: createId('self-project'),
      title: normalizeText(input.title, 'Untitled Lumi project', 160),
      purpose: normalizeText(input.purpose, '', 1000),
      motivation: normalizeText(input.motivation, '', 1000),
      targetPath: normalizeText(input.targetPath, '', 500) || undefined,
      status: input.status ?? 'planned',
      priority: normalizeNumber(input.priority, 50, 0, 100),
      createdAt: at,
      updatedAt: at,
      startedAt: input.status === 'active' ? at : undefined,
      source: input.source ?? 'manual',
      todos: [],
      progressNotes: [],
    }
    project.todos = (input.todos ?? []).map((todo, index) => ({
      id: createId('self-todo'),
      projectId: project.id,
      content: normalizeText(todo.content, 'Untitled todo', 500),
      description: normalizeText(todo.description, '', 2000) || undefined,
      status: 'pending',
      order: index,
      dependsOn: todo.dependsOn ?? [],
      createdAt: at,
      updatedAt: at,
      source: todo.source ?? input.source ?? 'manual',
    }))

    mutate((projectList) => {
      const next = [project, ...projectList]
      return project.status === 'active' ? enforceSingleActiveProject(next, project.id) : next
    })
    notifyTodoStatusChange({
      projectId: project.id,
      oldStatus: 'none',
      newStatus: project.status,
      source: input.source ?? 'manual',
      reason: 'Project created.',
    })
    return project
  }

  function updateProject(projectId: string, patch: UpdateProjectInput, source: LumiSelfTodoSource = 'manual') {
    let updated: LumiSelfProject | null = null
    mutate((projectList) => {
      let next = projectList.map((project) => {
        if (project.id !== projectId)
          return project
        const oldStatus = project.status
        updated = {
          ...project,
          ...patch,
          title: patch.title !== undefined ? normalizeText(patch.title, project.title, 160) : project.title,
          purpose: patch.purpose !== undefined ? normalizeText(patch.purpose, project.purpose, 1000) : project.purpose,
          motivation: patch.motivation !== undefined ? normalizeText(patch.motivation, project.motivation, 1000) : project.motivation,
          targetPath: patch.targetPath !== undefined ? normalizeText(patch.targetPath, '', 500) || undefined : project.targetPath,
          status: patch.status ?? project.status,
          priority: patch.priority !== undefined ? normalizeNumber(patch.priority, project.priority, 0, 100) : project.priority,
          updatedAt: nowIso(),
          startedAt: (patch.status === 'active' && !project.startedAt) ? nowIso() : project.startedAt,
        }
        if (oldStatus !== updated.status) {
          notifyTodoStatusChange({
            projectId,
            oldStatus,
            newStatus: updated.status,
            source,
            reason: 'Project status updated.',
          })
        }
        return updated
      })
      if (updated?.status === 'active')
        next = enforceSingleActiveProject(next, projectId)
      return next
    })
    return updated ?? findProject(projectId)
  }

  function pauseProject(projectId: string, reason = '', source: LumiSelfTodoSource = 'manual') {
    return updateProject(projectId, { status: 'paused', pausedReason: reason || 'Paused manually.' }, source)
  }

  function resumeProject(projectId: string, source: LumiSelfTodoSource = 'manual') {
    return updateProject(projectId, { status: 'active', pausedReason: undefined }, source)
  }

  function abandonProject(projectId: string, reason = '', source: LumiSelfTodoSource = 'manual') {
    return updateProject(projectId, { status: 'abandoned', abandonedReason: reason || 'Abandoned manually.' }, source)
  }

  function deleteProject(projectId: string, source: LumiSelfTodoSource = 'manual') {
    const project = findProject(projectId)
    mutate(projectList => projectList.filter(item => item.id !== projectId))
    notifyTodoStatusChange({
      projectId,
      oldStatus: project.status,
      newStatus: 'deleted',
      source,
      reason: 'Project deleted.',
    })
  }

  function addTodo(projectId: string, input: AddTodoInput) {
    const at = nowIso()
    const project = findProject(projectId)
    const todo: LumiSelfTodo = {
      id: createId('self-todo'),
      projectId,
      content: normalizeText(input.content, 'Untitled todo', 500),
      description: normalizeText(input.description, '', 2000) || undefined,
      status: 'pending',
      order: input.order ?? project.todos.length,
      dependsOn: input.dependsOn ?? [],
      createdAt: at,
      updatedAt: at,
      source: input.source ?? 'manual',
    }
    mutate(projectList => projectList.map(item => item.id === projectId
      ? { ...item, todos: [...item.todos, todo].sort((left, right) => left.order - right.order), updatedAt: at }
      : item))
    notifyTodoStatusChange({
      projectId,
      todoId: todo.id,
      oldStatus: 'none',
      newStatus: 'pending',
      source: input.source ?? 'manual',
      reason: 'Todo added.',
    })
    return todo
  }

  function updateTodo(projectId: string, todoId: string, patch: UpdateTodoInput, source: LumiSelfTodoSource = 'manual') {
    let updated: LumiSelfTodo | null = null
    mutate(projectList => projectList.map((project) => {
      if (project.id !== projectId)
        return project
      const todos = project.todos.map((todo) => {
        if (todo.id !== todoId)
          return todo
        const oldStatus = todo.status
        updated = {
          ...todo,
          ...patch,
          content: patch.content !== undefined ? normalizeText(patch.content, todo.content, 500) : todo.content,
          description: patch.description !== undefined ? normalizeText(patch.description, '', 2000) || undefined : todo.description,
          dependsOn: patch.dependsOn ?? todo.dependsOn,
          status: patch.status ?? todo.status,
          updatedAt: nowIso(),
        }
        if (oldStatus !== updated.status) {
          notifyTodoStatusChange({
            projectId,
            todoId,
            oldStatus,
            newStatus: updated.status,
            source,
            reason: 'Todo status updated.',
          })
        }
        return updated
      })
      return { ...project, todos: todos.sort((left, right) => left.order - right.order), updatedAt: nowIso() }
    }))
    if (!updated)
      throw new Error(`Lumi self todo not found: ${todoId}`)
    return updated
  }

  function startTodo(projectId: string, todoId: string, source: LumiSelfTodoSource = 'manual') {
    const project = findProject(projectId)
    if (project.status !== 'active')
      throw new Error('Only active Lumi self projects can start todos.')
    const target = project.todos.find(todo => todo.id === todoId)
    if (!target)
      throw new Error(`Lumi self todo not found: ${todoId}`)
    if (target.status === 'blocked' || target.status === 'cancelled' || target.status === 'done')
      throw new Error(`Todo cannot be started from status ${target.status}.`)
    if (!dependenciesCompleted(project, target))
      throw new Error('Todo dependencies are not completed.')

    const at = nowIso()
    mutate(projectList => projectList.map((item) => {
      if (item.id !== projectId)
        return item
      return {
        ...item,
        todos: item.todos.map(todo => ({
          ...todo,
          status: todo.id === todoId ? 'doing' : todo.status === 'doing' ? 'pending' : todo.status,
          startedAt: todo.id === todoId ? todo.startedAt || at : todo.startedAt,
          updatedAt: todo.id === todoId || todo.status === 'doing' ? at : todo.updatedAt,
        })),
        updatedAt: at,
      }
    }))
    notifyTodoStatusChange({
      projectId,
      todoId,
      oldStatus: target.status,
      newStatus: 'doing',
      source,
      reason: 'Todo started; other doing todos in this project were returned to pending.',
    })
    return findProject(projectId).todos.find(todo => todo.id === todoId)!
  }

  function completeTodo(projectId: string, todoId: string, result = '', source: LumiSelfTodoSource = 'manual') {
    const oldStatus = findProject(projectId).todos.find(todo => todo.id === todoId)?.status ?? 'unknown'
    return updateTodo(projectId, todoId, {
      status: 'done',
      result: result || undefined,
      completedAt: nowIso(),
    }, source)
      ?? notifyTodoStatusChange({ projectId, todoId, oldStatus, newStatus: 'done', source, reason: 'Todo completed.' })
  }

  function blockTodo(projectId: string, todoId: string, blockedReason: string, source: LumiSelfTodoSource = 'manual') {
    return updateTodo(projectId, todoId, {
      status: 'blocked',
      blockedReason: blockedReason || 'Blocked.',
    }, source)
  }

  function recoverTransientClaudeBlockedTodos(source: LumiSelfTodoSource = 'autonomous_decision') {
    const recovered: Array<{ projectId: string, todoId: string }> = []
    for (const project of projects.value) {
      for (const todo of project.todos) {
        if (todo.status !== 'blocked' || !isTransientClaudeTodoFailure(todo.blockedReason))
          continue
        updateTodo(project.id, todo.id, {
          status: 'pending',
          blockedReason: undefined,
          result: `Recovered from transient Claude execution failure: ${todo.blockedReason}`,
        }, source)
        addProgressNote(project.id, {
          todoId: todo.id,
          content: `已恢复临时执行失败造成的 blocked：${todo.blockedReason}`,
          source,
        })
        recovered.push({ projectId: project.id, todoId: todo.id })
      }
    }
    return recovered
  }

  function cancelTodo(projectId: string, todoId: string, reason = '', source: LumiSelfTodoSource = 'manual') {
    return updateTodo(projectId, todoId, {
      status: 'cancelled',
      result: reason || undefined,
      completedAt: nowIso(),
    }, source)
  }

  function reorderTodos(projectId: string, todoIds: string[]) {
    const orderMap = new Map(todoIds.map((id, index) => [id, index]))
    mutate(projectList => projectList.map((project) => {
      if (project.id !== projectId)
        return project
      return {
        ...project,
        todos: project.todos
          .map(todo => ({ ...todo, order: orderMap.get(todo.id) ?? todo.order }))
          .sort((left, right) => left.order - right.order),
        updatedAt: nowIso(),
      }
    }))
  }

  function addProgressNote(projectId: string, input: { todoId?: string, content: string, source?: LumiSelfTodoSource }) {
    const note: LumiSelfProgressNote = {
      id: createId('self-progress'),
      projectId,
      todoId: input.todoId,
      content: normalizeText(input.content, '', 4000),
      createdAt: nowIso(),
      source: input.source ?? 'manual',
    }
    if (!note.content)
      throw new Error('Progress note cannot be empty.')
    mutate(projectList => projectList.map(project => project.id === projectId
      ? { ...project, progressNotes: [...project.progressNotes, note].slice(-MAX_PROGRESS_NOTES_PER_PROJECT), updatedAt: nowIso() }
      : project))
    return note
  }

  function completeProject(projectId: string, input: { reason?: string, deliverablePaths?: string[], source?: LumiSelfTodoSource } = {}) {
    const project = findProject(projectId)
    const check = checkProjectCompletion(project, input.deliverablePaths ?? [])
    if (!check.canComplete)
      return { completed: false, check, project }

    const at = nowIso()
    mutate(projectList => projectList.map(item => item.id === projectId
      ? { ...item, status: 'completed', completedAt: at, updatedAt: at }
      : item))
    notifyTodoStatusChange({
      projectId,
      oldStatus: project.status,
      newStatus: 'completed',
      source: input.source ?? 'manual',
      reason: input.reason || check.reason,
    })
    return { completed: true, check, project: findProject(projectId) }
  }

  function getActiveProjects() {
    return projects.value.filter(project => project.status === 'active')
  }

  function getNextExecutableTodo(projectId?: string) {
    return selectNextExecutableTodo(projects.value, projectId)
  }

  function getProjectProgressById(projectId: string) {
    return getProjectProgress(findProject(projectId))
  }

  function createSelfProjectFromDecision(input: CreateProjectInput & { source: LumiSelfTodoSource }) {
    return createProject(input)
  }

  function addSelfTodoFromDecision(input: { projectId: string } & AddTodoInput & { source: LumiSelfTodoSource }) {
    return addTodo(input.projectId, input)
  }

  function clearAllForDebug() {
    storage.value = { schemaVersion: SCHEMA_VERSION, projects: [] }
    saveSelfTodoStorage(storage.value)
  }

  repairStorage()

  return {
    schemaVersion: SCHEMA_VERSION,
    storage,
    projects,
    activeProjects,
    activeProject,
    nextExecutableTodo,
    repairStorage,
    createProject,
    updateProject,
    pauseProject,
    resumeProject,
    completeProject,
    abandonProject,
    deleteProject,
    addTodo,
    updateTodo,
    startTodo,
    completeTodo,
    blockTodo,
    recoverTransientClaudeBlockedTodos,
    cancelTodo,
    reorderTodos,
    addProgressNote,
    getActiveProjects,
    getNextExecutableTodo,
    getProjectProgress: getProjectProgressById,
    createSelfProjectFromDecision,
    addSelfTodoFromDecision,
    clearAllForDebug,
  }
})
