// @vitest-environment jsdom

import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildClaudeTodoStepPrompt,
  createReflectionFromProject,
  decideLifeTick,
  selectIdeaForProject,
  useLumiAutonomousLifeStore,
  validateLumiWorldTarget,
} from './lumi-autonomous-life'
import { useLumiSelfTodoStore } from './lumi-self-todo'

const chatSessionMock = vi.hoisted(() => ({
  activeSessionId: '',
  ensureSession: vi.fn(),
  getSessionMessages: vi.fn(() => []),
  setSessionMessages: vi.fn(),
}))

const agentRunMock = vi.hoisted(() => vi.fn(async (): Promise<any> => ({
  status: 'success',
  taskId: 'claude-test',
  changedFiles: ['draft.md'],
  startedAt: new Date().toISOString(),
})))

vi.mock('@proj-airi/stage-ui/stores/chat/session-store', () => ({
  useChatSessionStore: () => chatSessionMock,
}))

vi.mock('@proj-airi/stage-ui/stores/lumi-agent', () => ({
  useLumiAgentStore: () => ({
    configured: true,
    settings: {
      forbiddenPaths: ['D:/pyProject/AIRI/airi', 'C:/Users/abcdi000/.ssh'],
      lumiSandboxRoot: 'D:/LumiSandbox',
      defaultPermissionMode: 'sandbox_auto',
      sandboxAutoApprove: true,
    },
    runClaudeTask: agentRunMock,
  }),
}))

vi.mock('@proj-airi/stage-ui/stores/modules/consciousness', () => ({
  useConsciousnessStore: () => ({
    activeProvider: '',
    activeModel: '',
  }),
}))

vi.mock('@proj-airi/stage-ui/stores/providers', () => ({
  useProvidersStore: () => ({
    getProviderInstance: vi.fn(),
  }),
}))

function setupStores() {
  setActivePinia(createPinia())
  const todoStore = useLumiSelfTodoStore()
  const lifeStore = useLumiAutonomousLifeStore()
  lifeStore.enabled = true
  return { todoStore, lifeStore }
}

describe('lumi autonomous life tick', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    agentRunMock.mockClear()
  })

  it('continues an active project first', () => {
    const { todoStore, lifeStore } = setupStores()
    const project = todoStore.createProject({
      title: 'Active',
      purpose: 'Continue first.',
      motivation: 'Continuity.',
      status: 'active',
    })
    const todo = todoStore.addTodo(project.id, { content: 'Next step' })

    const decision = decideLifeTick({
      nowIso: new Date().toISOString(),
      activeProject: todoStore.activeProject,
      nextTodo: todoStore.getNextExecutableTodo(),
      ideas: lifeStore.ideas,
      restState: null,
      todayActionCount: 0,
      dailyActionBudget: 6,
      userInteracting: false,
      userBusy: false,
    })

    expect(decision.mode).toBe('continue_project')
    expect(decision.selectedTodoId).toBe(todo.id)
  })

  it('continues doing Todo before pending Todo', () => {
    const { todoStore } = setupStores()
    const project = todoStore.createProject({
      title: 'Doing priority',
      purpose: 'Continue doing.',
      motivation: 'Avoid context switching.',
      status: 'active',
    })
    const first = todoStore.addTodo(project.id, { content: 'Doing item' })
    todoStore.addTodo(project.id, { content: 'Pending item' })
    todoStore.startTodo(project.id, first.id)

    const decision = decideLifeTick({
      nowIso: new Date().toISOString(),
      activeProject: todoStore.activeProject,
      nextTodo: todoStore.getNextExecutableTodo(),
      ideas: [],
      restState: null,
      todayActionCount: 0,
      dailyActionBudget: 6,
      userInteracting: false,
      userBusy: false,
    })

    expect(decision.selectedTodoId).toBe(first.id)
    expect(decision.reason).toContain('doing')
  })

  it('checks Idea Pool when no active project exists', () => {
    const { lifeStore } = setupStores()
    const idea = lifeStore.addIdea({
      title: 'Tiny Lumi page',
      description: 'A small page in LumiWorld.',
      motivation: 'A continuity artifact.',
      origin: 'reflection',
      interestScore: 0.8,
      continuityScore: 0.9,
      feasibilityScore: 0.9,
      noveltyScore: 0.3,
    })

    const decision = decideLifeTick({
      nowIso: new Date().toISOString(),
      activeProject: null,
      nextTodo: null,
      ideas: lifeStore.ideas,
      restState: null,
      todayActionCount: 0,
      dailyActionBudget: 6,
      userInteracting: false,
      userBusy: false,
    })

    expect(decision.mode).toBe('select_idea')
    expect(decision.selectedIdeaId).toBe(idea.id)
  })

  it('generates candidate ideas when Idea Pool has no suitable idea', () => {
    const decision = decideLifeTick({
      nowIso: new Date().toISOString(),
      activeProject: null,
      nextTodo: null,
      ideas: [],
      restState: null,
      todayActionCount: 0,
      dailyActionBudget: 6,
      userInteracting: false,
      userBusy: false,
    })

    expect(decision.mode).toBe('generate_ideas')
    expect(decision.shouldAct).toBe(true)
  })

  it('can convert an Idea into a planned project and todos', () => {
    const { todoStore, lifeStore } = setupStores()
    const idea = lifeStore.addIdea({
      title: 'Lumi garden note',
      description: 'A tiny garden note.',
      motivation: 'Make a private continuity artifact.',
      origin: 'private note',
    })

    const project = lifeStore.convertIdeaToProject(idea.id)

    expect(project.status).toBe('planned')
    expect(project.todos.length).toBeGreaterThanOrEqual(2)
    expect(todoStore.projects).toHaveLength(1)
    expect(lifeStore.ideas.find(item => item.id === idea.id)?.status).toBe('converted')
  })

  it('advances at most one Todo per Tick', async () => {
    const { todoStore, lifeStore } = setupStores()
    const project = todoStore.createProject({
      title: 'One step',
      purpose: 'Only one step each tick.',
      motivation: 'Prevent full project execution.',
      targetPath: 'one-step/draft.md',
      status: 'active',
    })
    const first = todoStore.addTodo(project.id, { content: 'First' })
    const second = todoStore.addTodo(project.id, { content: 'Second' })

    const result = await lifeStore.runLifeTick({ force: true })

    expect(result.changedTodoIds).toEqual([first.id])
    expect(todoStore.projects[0].todos.find(todo => todo.id === first.id)?.status).toBe('done')
    expect(todoStore.projects[0].todos.find(todo => todo.id === second.id)?.status).toBe('pending')
  })

  it('creates a reflection after project completion', () => {
    const { todoStore, lifeStore } = setupStores()
    const project = todoStore.createProject({
      title: 'Reflectable',
      purpose: 'Produce reflection.',
      motivation: 'Learn from real notes.',
      status: 'active',
    })
    const todo = todoStore.addTodo(project.id, { content: 'Finish' })
    todoStore.completeTodo(project.id, todo.id)
    todoStore.addProgressNote(project.id, { content: 'Final summary: Lumi made one real bounded progress note for this project.' })
    todoStore.completeProject(project.id)

    const reflection = lifeStore.reflectProject(project.id)

    expect(reflection.summary).toContain('Reflectable')
    expect(lifeStore.reflections).toHaveLength(1)
  })

  it('can create new Ideas from reflection', () => {
    const { todoStore, lifeStore } = setupStores()
    const project = todoStore.createProject({
      title: 'Reflection ideas',
      purpose: 'Seed ideas.',
      motivation: 'Continuation.',
    })

    lifeStore.addReflection({
      ...createReflectionFromProject(project),
      possibleNextIdeas: ['整理这个项目的回顾页面'],
    })

    expect(lifeStore.ideas.some(idea => idea.title.includes('回顾页面'))).toBe(true)
  })

  it('stores rest state with reconsiderAt', () => {
    const { lifeStore } = setupStores()
    const rest = lifeStore.setRest('刚完成一个持续项目，需要整理。', 30 * 60 * 1000)

    expect(rest.reason).toContain('持续项目')
    expect(Date.parse(rest.reconsiderAt)).toBeGreaterThan(Date.parse(rest.startedAt))
  })

  it('does not stop merely because the user is not interacting', () => {
    const idea = {
      id: 'idea',
      title: 'Continue',
      description: 'Continue from experience.',
      motivation: 'Continuity.',
      origin: 'test',
      interestScore: 0.8,
      continuityScore: 0.8,
      feasibilityScore: 0.8,
      noveltyScore: 0.2,
      riskLevel: 'low' as const,
      targetSpace: 'lumi_world' as const,
      status: 'candidate' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const decision = decideLifeTick({
      nowIso: new Date().toISOString(),
      activeProject: null,
      nextTodo: null,
      ideas: [idea],
      restState: null,
      todayActionCount: 0,
      dailyActionBudget: 6,
      userInteracting: false,
      userBusy: false,
    })

    expect(decision.shouldAct).toBe(true)
    expect(decision.mode).toBe('select_idea')
  })

  it('continues active project even when the user is busy', () => {
    const { todoStore } = setupStores()
    const project = todoStore.createProject({
      title: 'Busy user project',
      purpose: 'Keep Lumi alive without interrupting.',
      motivation: 'Silence is not stopping.',
      status: 'active',
    })
    const todo = todoStore.addTodo(project.id, { content: 'Quietly continue one step' })

    const decision = decideLifeTick({
      nowIso: new Date().toISOString(),
      activeProject: todoStore.activeProject,
      nextTodo: todoStore.getNextExecutableTodo(),
      ideas: [],
      restState: null,
      todayActionCount: 0,
      dailyActionBudget: 6,
      userInteracting: false,
      userBusy: true,
    })

    expect(decision.mode).toBe('continue_project')
    expect(decision.selectedTodoId).toBe(todo.id)
  })

  it('leaves rest after reconsiderAt and resumes decision flow', () => {
    const { lifeStore } = setupStores()
    const oldRest = {
      reason: 'Budget used earlier.',
      startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      reconsiderAt: new Date(Date.now() - 60 * 1000).toISOString(),
    }
    lifeStore.addIdea({
      title: 'After rest idea',
      description: 'Something still worth trying.',
      motivation: 'Continue after rest.',
      origin: 'test',
      interestScore: 0.8,
      continuityScore: 0.8,
      feasibilityScore: 0.8,
      noveltyScore: 0.2,
    })

    const decision = decideLifeTick({
      nowIso: new Date().toISOString(),
      activeProject: null,
      nextTodo: null,
      ideas: lifeStore.ideas,
      restState: oldRest,
      todayActionCount: 0,
      dailyActionBudget: 6,
      userInteracting: false,
      userBusy: false,
    })

    expect(decision.mode).toBe('select_idea')
  })

  it('pauses project after three consecutive failures', async () => {
    const { todoStore, lifeStore } = setupStores()
    agentRunMock.mockResolvedValue({
      status: 'failed',
      taskId: 'fail',
      changedFiles: [],
      error: 'failed',
      startedAt: new Date().toISOString(),
    })
    const project = todoStore.createProject({
      title: 'Failure project',
      purpose: 'Pause after failure.',
      motivation: 'Avoid infinite retries.',
      status: 'active',
    })
    const first = todoStore.addTodo(project.id, { content: 'First' })
    const second = todoStore.addTodo(project.id, { content: 'Second' })
    const third = todoStore.addTodo(project.id, { content: 'Third' })

    await lifeStore.advanceCurrentTodo({ useClaude: true })
    todoStore.cancelTodo(project.id, first.id)
    await lifeStore.advanceCurrentTodo({ useClaude: true })
    todoStore.cancelTodo(project.id, second.id)
    await lifeStore.advanceCurrentTodo({ useClaude: true })

    expect(third.id).toBeTruthy()
    expect(todoStore.projects[0].status).toBe('paused')
    expect(lifeStore.restState?.reason).toContain('连续失败')
  })

  it('keeps transient Claude execution failures retryable instead of blocking todos', async () => {
    const { todoStore, lifeStore } = setupStores()
    agentRunMock.mockResolvedValue({
      status: 'failed',
      taskId: 'transient-fail',
      changedFiles: [],
      error: 'Claude Code did not complete this Todo.',
      startedAt: new Date().toISOString(),
    })
    const project = todoStore.createProject({
      title: 'Retry project',
      purpose: 'Retry after transient agent failure.',
      motivation: 'Do not poison the Todo list.',
      status: 'active',
      targetPath: 'retry-project',
    })
    const todo = todoStore.addTodo(project.id, { content: 'Retryable step' })

    const result = await lifeStore.advanceCurrentTodo({ useClaude: true })

    expect(result.result).toBe('failed:failed')
    expect(todoStore.projects[0].todos.find(item => item.id === todo.id)?.status).toBe('pending')
    expect(todoStore.projects[0].todos.find(item => item.id === todo.id)?.blockedReason).toBeUndefined()
    expect(todoStore.getNextExecutableTodo()?.id).toBe(todo.id)
  })

  it('does not create many active projects at once', async () => {
    const { todoStore, lifeStore } = setupStores()
    const first = lifeStore.addIdea({
      title: 'First idea',
      description: 'First.',
      motivation: 'First.',
      origin: 'test',
    })
    const second = lifeStore.addIdea({
      title: 'Second idea',
      description: 'Second.',
      motivation: 'Second.',
      origin: 'test',
    })

    lifeStore.convertIdeaToProject(first.id)
    lifeStore.convertIdeaToProject(second.id)
    todoStore.resumeProject(todoStore.projects[0].id)
    todoStore.resumeProject(todoStore.projects[1].id)

    expect(todoStore.projects.filter(project => project.status === 'active')).toHaveLength(1)
  })

  it('restores autonomous state after reload', () => {
    const firstPinia = createPinia()
    setActivePinia(firstPinia)
    const firstStore = useLumiAutonomousLifeStore()
    firstStore.addIdea({
      title: 'Persistent idea',
      description: 'Survives reload.',
      motivation: 'Long-lived self continuity.',
      origin: 'test',
    })

    setActivePinia(createPinia())
    const restoredStore = useLumiAutonomousLifeStore()

    expect(restoredStore.ideas[0].title).toBe('Persistent idea')
  })

  it('rejects sandbox-outside targets', () => {
    const result = validateLumiWorldTarget('D:/pyProject/AIRI/airi/src/main.ts', 'D:/LumiSandbox/LumiWorld')

    expect(result.ok).toBe(false)
  })

  it('builds a Claude prompt for only the current Todo', () => {
    const { todoStore } = setupStores()
    const project = todoStore.createProject({
      title: 'Prompt project',
      purpose: 'Check scope.',
      motivation: 'Claude should not run the loop.',
      targetPath: 'prompt-project',
      status: 'active',
    })
    const todo = todoStore.addTodo(project.id, { content: 'Write only the first draft' })
    const prompt = buildClaudeTodoStepPrompt({
      project,
      todo,
      lumiWorldRoot: 'D:/LumiSandbox/LumiWorld',
      forbiddenPaths: ['D:/pyProject/AIRI/airi'],
    })

    expect(prompt).toContain(`Current Todo ID: ${todo.id}`)
    expect(prompt).toContain('Do not take over Lumi\'s whole autonomous loop')
    expect(prompt).toContain('Complete only this Todo')
  })
})

describe('lumi autonomous life pure helpers', () => {
  it('selects the best low-risk continuity idea', () => {
    const at = new Date().toISOString()
    const selected = selectIdeaForProject([
      {
        id: 'bad-risk',
        title: 'Risky',
        description: '',
        motivation: '',
        origin: 'test',
        interestScore: 1,
        continuityScore: 1,
        feasibilityScore: 1,
        noveltyScore: 1,
        riskLevel: 'high',
        targetSpace: 'lumi_world',
        status: 'candidate',
        createdAt: at,
        updatedAt: at,
      },
      {
        id: 'good',
        title: 'Good',
        description: '',
        motivation: '',
        origin: 'test',
        interestScore: 0.7,
        continuityScore: 0.9,
        feasibilityScore: 0.9,
        noveltyScore: 0.2,
        riskLevel: 'low',
        targetSpace: 'lumi_world',
        status: 'candidate',
        createdAt: at,
        updatedAt: at,
      },
    ])

    expect(selected?.id).toBe('good')
  })
})
