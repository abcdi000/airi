// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  checkProjectCompletion,
  selectNextExecutableTodo,
  useLumiSelfTodoStore,
} from './lumi-self-todo'

const chatSessionMock = vi.hoisted(() => ({
  activeSessionId: '',
  ensureSession: vi.fn(),
  getSessionMessages: vi.fn(() => []),
  setSessionMessages: vi.fn(),
}))

vi.mock('@proj-airi/stage-ui/stores/chat/session-store', () => ({
  useChatSessionStore: () => chatSessionMock,
}))

describe('lumi self todo store', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    chatSessionMock.activeSessionId = ''
    chatSessionMock.ensureSession.mockClear()
    chatSessionMock.getSessionMessages.mockClear()
    chatSessionMock.setSessionMessages.mockClear()
  })

  it('can create Lumi self projects', () => {
    const store = useLumiSelfTodoStore()
    const project = store.createProject({
      title: 'Lumi room page',
      purpose: 'Build a small room page for Lumi.',
      motivation: 'Lumi wants a stable place for her own drafts.',
      status: 'planned',
      source: 'manual',
    })

    expect(project.title).toBe('Lumi room page')
    expect(store.projects).toHaveLength(1)
    expect(store.projects[0].source).toBe('manual')
  })

  it('can add multiple todos', () => {
    const store = useLumiSelfTodoStore()
    const project = store.createProject({
      title: 'Small room',
      purpose: 'Draft room.',
      motivation: 'Practice continuity.',
    })

    store.addTodo(project.id, { content: 'Write intent' })
    store.addTodo(project.id, { content: 'Create HTML' })

    expect(store.projects[0].todos.map(todo => todo.content)).toEqual(['Write intent', 'Create HTML'])
  })

  it('returns the next executable todo for an active project', () => {
    const store = useLumiSelfTodoStore()
    const project = store.createProject({
      title: 'Active project',
      purpose: 'Move forward.',
      motivation: 'Keep a stable next step.',
      status: 'active',
    })
    const first = store.addTodo(project.id, { content: 'First' })
    store.addTodo(project.id, { content: 'Second' })

    expect(store.getNextExecutableTodo()?.id).toBe(first.id)
  })

  it('does not select a todo with unfinished dependencies', () => {
    const store = useLumiSelfTodoStore()
    const project = store.createProject({
      title: 'Dependencies',
      purpose: 'Check dependency ordering.',
      motivation: 'Avoid skipping steps.',
      status: 'active',
    })
    const first = store.addTodo(project.id, { content: 'Foundation' })
    const second = store.addTodo(project.id, { content: 'Depends on foundation', dependsOn: [first.id] })
    store.reorderTodos(project.id, [second.id, first.id])

    expect(store.getNextExecutableTodo()?.id).toBe(first.id)
  })

  it('does not select blocked todos', () => {
    const store = useLumiSelfTodoStore()
    const project = store.createProject({
      title: 'Blocked handling',
      purpose: 'Avoid blocked work.',
      motivation: 'Stable task choice.',
      status: 'active',
    })
    const blocked = store.addTodo(project.id, { content: 'Blocked first' })
    const next = store.addTodo(project.id, { content: 'Next available' })
    store.blockTodo(project.id, blocked.id, 'Needs more context.')

    expect(store.getNextExecutableTodo()?.id).toBe(next.id)
  })

  it('keeps at most one doing todo inside the same project', () => {
    const store = useLumiSelfTodoStore()
    const project = store.createProject({
      title: 'Doing guard',
      purpose: 'Only one current step.',
      motivation: 'Prevent split attention.',
      status: 'active',
    })
    const first = store.addTodo(project.id, { content: 'First' })
    const second = store.addTodo(project.id, { content: 'Second' })

    store.startTodo(project.id, first.id)
    store.startTodo(project.id, second.id)

    const current = store.projects[0].todos.filter(todo => todo.status === 'doing')
    expect(current).toHaveLength(1)
    expect(current[0].id).toBe(second.id)
    expect(store.projects[0].todos.find(todo => todo.id === first.id)?.status).toBe('pending')
  })

  it('does not complete a project when todos are done but the deliverable is missing', () => {
    const store = useLumiSelfTodoStore()
    const project = store.createProject({
      title: 'Deliverable project',
      purpose: 'Need a file.',
      motivation: 'Completion should be real.',
      status: 'active',
      targetPath: 'room/index.html',
    })
    const todo = store.addTodo(project.id, { content: 'Create file' })
    store.completeTodo(project.id, todo.id)
    store.addProgressNote(project.id, { content: 'Final summary: the room draft has been completed and checked.' })

    const result = store.completeProject(project.id)

    expect(result.completed).toBe(false)
    expect(result.check.hasDeliverable).toBe(false)
    expect(store.projects[0].status).toBe('active')
  })

  it('can mark a project completed when completion check passes', () => {
    const store = useLumiSelfTodoStore()
    const project = store.createProject({
      title: 'Completed project',
      purpose: 'Close correctly.',
      motivation: 'No fake completion.',
      status: 'active',
      targetPath: 'room/index.html',
    })
    const todo = store.addTodo(project.id, { content: 'Create file' })
    store.completeTodo(project.id, todo.id)
    store.addProgressNote(project.id, { content: 'Final summary: the deliverable exists and the project has a coherent endpoint.' })

    const result = store.completeProject(project.id, { deliverablePaths: ['D:/LumiSandbox/LumiWorld/room/index.html'] })

    expect(result.completed).toBe(true)
    expect(result.project.status).toBe('completed')
  })

  it('does not select paused projects', () => {
    const store = useLumiSelfTodoStore()
    const project = store.createProject({
      title: 'Paused project',
      purpose: 'Should wait.',
      motivation: 'No auto advance.',
      status: 'paused',
    })
    store.addTodo(project.id, { content: 'Wait' })

    expect(store.getNextExecutableTodo()).toBeNull()
  })

  it('restores projects and todos after a store reload', () => {
    const firstPinia = createPinia()
    setActivePinia(firstPinia)
    const firstStore = useLumiSelfTodoStore()
    const project = firstStore.createProject({
      title: 'Persistent project',
      purpose: 'Survive restart.',
      motivation: 'Lumi should remember what she was doing.',
      status: 'active',
    })
    const todo = firstStore.addTodo(project.id, { content: 'Persistent todo' })

    setActivePinia(createPinia())
    const restoredStore = useLumiSelfTodoStore()

    expect(restoredStore.projects[0].title).toBe('Persistent project')
    expect(restoredStore.projects[0].todos[0].id).toBe(todo.id)
  })

  it('recovers todos blocked by old transient Claude execution failures on reload', () => {
    const firstPinia = createPinia()
    setActivePinia(firstPinia)
    const firstStore = useLumiSelfTodoStore()
    const project = firstStore.createProject({
      title: 'Recovered project',
      purpose: 'Continue after transient failure.',
      motivation: 'Agent failures should not poison the project.',
      status: 'active',
    })
    const todo = firstStore.addTodo(project.id, { content: 'Retryable todo' })
    firstStore.blockTodo(project.id, todo.id, 'Claude Code did not complete this Todo.')
    firstStore.pauseProject(project.id, '连续三次自主推进没有实质进展。')

    setActivePinia(createPinia())
    const restoredStore = useLumiSelfTodoStore()

    expect(restoredStore.projects[0].status).toBe('active')
    expect(restoredStore.projects[0].todos[0].status).toBe('pending')
    expect(restoredStore.projects[0].todos[0].blockedReason).toBeUndefined()
    expect(restoredStore.getNextExecutableTodo()?.id).toBe(todo.id)
  })

  it('does not mix user tasks with Lumi self todos', () => {
    const store = useLumiSelfTodoStore()
    store.createProject({
      title: 'Lumi private draft',
      purpose: 'This belongs to Lumi.',
      motivation: 'Keep self work separate from user tasks.',
      status: 'active',
      source: 'autonomous_decision',
    })

    expect(store.storage.schemaVersion).toBe(1)
    expect(store.projects.every(project => project.source !== undefined)).toBe(true)
    expect(Object.keys(store.storage)).toEqual(['schemaVersion', 'projects'])
  })

  it('exposes enough active project and progress data for settings UI', () => {
    const store = useLumiSelfTodoStore()
    const project = store.createProject({
      title: 'Settings preview',
      purpose: 'Show progress.',
      motivation: 'Make the UI inspectable.',
      status: 'active',
    })
    const first = store.addTodo(project.id, { content: 'Done item' })
    store.addTodo(project.id, { content: 'Pending item' })
    store.completeTodo(project.id, first.id)

    const progress = store.getProjectProgress(project.id)

    expect(store.activeProject?.title).toBe('Settings preview')
    expect(store.nextExecutableTodo?.content).toBe('Pending item')
    expect(progress.total).toBe(2)
    expect(progress.done).toBe(1)
  })
})

describe('lumi self todo pure helpers', () => {
  it('selects doing todo before pending todos', () => {
    const project = {
      id: 'project',
      title: 'Pure',
      purpose: '',
      motivation: '',
      status: 'active' as const,
      priority: 50,
      createdAt: '2026-06-11T00:00:00.000Z',
      updatedAt: '2026-06-11T00:00:00.000Z',
      todos: [
        {
          id: 'pending',
          projectId: 'project',
          content: 'Pending',
          status: 'pending' as const,
          order: 0,
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
        {
          id: 'doing',
          projectId: 'project',
          content: 'Doing',
          status: 'doing' as const,
          order: 1,
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
      ],
      progressNotes: [],
    }

    expect(selectNextExecutableTodo([project])?.id).toBe('doing')
  })

  it('requires a final progress summary before project completion', () => {
    const project = {
      id: 'project',
      title: 'No summary',
      purpose: '',
      motivation: '',
      status: 'active' as const,
      priority: 50,
      createdAt: '2026-06-11T00:00:00.000Z',
      updatedAt: '2026-06-11T00:00:00.000Z',
      todos: [
        {
          id: 'todo',
          projectId: 'project',
          content: 'Done',
          status: 'done' as const,
          order: 0,
          createdAt: '2026-06-11T00:00:00.000Z',
          updatedAt: '2026-06-11T00:00:00.000Z',
        },
      ],
      progressNotes: [],
    }

    expect(checkProjectCompletion(project).canComplete).toBe(false)
    expect(checkProjectCompletion(project).reason).toContain('progress summary')
  })
})
