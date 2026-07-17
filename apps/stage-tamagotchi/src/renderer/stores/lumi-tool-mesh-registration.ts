import type {
  LumiToolDefinition,
  LumiToolExecutor,
} from '@proj-airi/stage-ui/stores/lumi-tool-mesh'

import { useLlmToolsStore } from '@proj-airi/stage-ui/stores/llm-tools'
import { useLumiAgentStore } from '@proj-airi/stage-ui/stores/lumi-agent'
import { useLumiToolMeshStore } from '@proj-airi/stage-ui/stores/lumi-tool-mesh'
import { useLocalStorage } from '@vueuse/core'

import { useLumiAutonomousLifeStore } from './lumi-autonomous-life'
import { useLumiDiarySchedulerStore } from './lumi-diary-scheduler'
import { useLumiProactiveVisionStore } from './lumi-proactive-vision'
import { getProjectProgress, useLumiSelfTodoStore } from './lumi-self-todo'
import { useTamagotchiMcpToolsStore } from './mcp-tools'

const PROVIDER = 'lumi-tool-mesh-tamagotchi'
const LUMIWORLD_MANIFEST_KEY = 'settings/plugins/lumi-proactive-vision/lumiworld-manifest'

type ToolInput = Record<string, unknown>

interface LumiWorldArtifact {
  id: string
  title: string
  path: string
  kind: string
  content?: string
  contentPreview?: string
  createdAt: string
  updatedAt: string
  visibility?: 'private' | 'share_later' | 'share_now'
  source?: string
}

interface LumiWorldManifest {
  schemaVersion: 1
  artifacts: LumiWorldArtifact[]
}

function nowIso() {
  return new Date().toISOString()
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function text(value: unknown, fallback = '', max = 2000) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : fallback
}

function numberValue(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed))
    return fallback
  return Math.min(max, Math.max(min, parsed))
}

function stringList(value: unknown, max = 12) {
  return Array.isArray(value)
    ? value.map(item => text(item, '', 300)).filter(Boolean).slice(0, max)
    : []
}

function normalizeManifest(value: unknown): LumiWorldManifest {
  const raw = value as Partial<LumiWorldManifest> | undefined
  return {
    schemaVersion: 1,
    artifacts: Array.isArray(raw?.artifacts)
      ? raw.artifacts.map((item: any, index) => ({
        id: text(item?.id, createId('lumiworld-artifact'), 100),
        title: text(item?.title, `LumiWorld item ${index + 1}`, 200),
        path: text(item?.path, `artifact-${index + 1}.md`, 500),
        kind: text(item?.kind, 'note', 80),
        content: text(item?.content, '', 120_000) || undefined,
        contentPreview: text(item?.contentPreview, text(item?.content, '', 800), 800) || undefined,
        createdAt: text(item?.createdAt, nowIso(), 80),
        updatedAt: text(item?.updatedAt, nowIso(), 80),
        visibility: item?.visibility === 'share_now' || item?.visibility === 'share_later' || item?.visibility === 'private'
          ? item.visibility
          : 'private',
        source: text(item?.source, '', 100) || undefined,
      })).slice(0, 300)
      : [],
  }
}

function safeLumiWorldPath(raw: unknown) {
  const normalized = text(raw, '', 500).replace(/\\/g, '/').replace(/^\/+/, '')
  if (!normalized || normalized.includes('..') || /^[a-z]:/i.test(normalized))
    throw new Error('Path must be relative and stay inside LumiWorld.')
  return normalized
}

function def(input: Partial<LumiToolDefinition> & Pick<LumiToolDefinition, 'id' | 'name' | 'description'>): LumiToolDefinition {
  const riskLevel = input.riskLevel ?? 'low'
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    capabilities: input.capabilities ?? [],
    examples: input.examples ?? [],
    inputSchema: input.inputSchema ?? {},
    outputSchema: input.outputSchema ?? {},
    riskLevel,
    accessScopes: input.accessScopes ?? ['chat', 'autonomous_life', 'proactive_vision', 'debug'],
    executionMode: input.executionMode ?? (riskLevel === 'low' ? 'auto' : 'operator_present_auto'),
    status: input.status ?? 'implemented',
    implementationPath: input.implementationPath,
    canRead: input.canRead ?? true,
    canWrite: input.canWrite ?? false,
    canExecuteProcess: input.canExecuteProcess ?? false,
    canAccessNetwork: input.canAccessNetwork ?? false,
    canModifySettings: input.canModifySettings ?? false,
    canTouchUserFiles: input.canTouchUserFiles ?? false,
    canTouchLumiCore: input.canTouchLumiCore ?? false,
    suggestedCombinations: input.suggestedCombinations,
  }
}

function summarizeProject(project: any) {
  const progress = getProjectProgress(project)
  return {
    id: project.id,
    title: project.title,
    purpose: project.purpose,
    motivation: project.motivation,
    status: project.status,
    priority: project.priority,
    targetPath: project.targetPath,
    progress,
    nextTodo: project.todos?.find((todo: any) => todo.status === 'doing') ?? project.todos?.find((todo: any) => todo.status === 'pending') ?? null,
    updatedAt: project.updatedAt,
  }
}

function findProjectByInput(projects: any[], input: ToolInput) {
  const projectId = text(input.projectId || input.id)
  if (projectId)
    return projects.find(project => project.id === projectId) ?? null
  const query = text(input.query || input.title).toLowerCase()
  if (!query)
    return null
  return projects.find(project => `${project.title}\n${project.purpose}\n${project.motivation}`.toLowerCase().includes(query)) ?? null
}

function buildDefinitions(): LumiToolDefinition[] {
  return [
    def({
      id: 'search_lumi_self_projects',
      name: '搜索 Lumi 自己的项目',
      description: '按标题、目的、动机、状态搜索 Lumi Self TodoList 项目。',
      capabilities: ['self_project_search', 'todo_context'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-self-todo.ts',
    }),
    def({
      id: 'get_lumi_self_project',
      name: '读取 Lumi 项目详情',
      description: '读取一个 Lumi 自己项目的目的、动机、Todo、进度记录。',
      capabilities: ['self_project_read'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-self-todo.ts',
    }),
    def({
      id: 'get_lumi_self_todos',
      name: '读取 Lumi 项目 Todo',
      description: '读取指定项目的 Todo 列表。',
      capabilities: ['self_todo_read'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-self-todo.ts',
    }),
    def({
      id: 'get_next_lumi_todo',
      name: '读取下一项可执行 Todo',
      description: '根据 Self TodoList 依赖和状态规则读取下一项可执行 Todo。',
      capabilities: ['self_todo_select'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-self-todo.ts',
    }),
    def({
      id: 'create_lumi_self_project',
      name: '创建 Lumi 自己的项目',
      description: '为 Lumi 自己创建一个项目和初始 Todo。默认只用于 LumiWorld/shared 低风险内容。',
      capabilities: ['self_project_create'],
      riskLevel: 'medium',
      canWrite: true,
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-self-todo.ts',
    }),
    def({
      id: 'add_lumi_self_todo',
      name: '添加 Lumi 自己的 Todo',
      description: '给 Lumi 自己的项目追加 Todo。',
      capabilities: ['self_todo_write'],
      riskLevel: 'medium',
      canWrite: true,
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-self-todo.ts',
    }),
    def({
      id: 'update_lumi_self_todo',
      name: '更新 Lumi 自己的 Todo',
      description: '更新 Todo 内容、状态、结果或阻塞原因。',
      capabilities: ['self_todo_write'],
      riskLevel: 'medium',
      canWrite: true,
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-self-todo.ts',
    }),
    def({
      id: 'add_lumi_progress_note',
      name: '写入 Lumi 项目进度',
      description: '给 Lumi 自己的项目写入进度记录。',
      capabilities: ['self_progress_write'],
      riskLevel: 'medium',
      canWrite: true,
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-self-todo.ts',
    }),
    def({
      id: 'search_idea_pool',
      name: '搜索 Idea Pool',
      description: '搜索 Lumi 自主想法池。',
      capabilities: ['idea_pool_search'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts',
    }),
    def({
      id: 'add_lumi_idea',
      name: '添加 Lumi 想法',
      description: '向 Idea Pool 添加一个候选想法。',
      capabilities: ['idea_pool_write'],
      riskLevel: 'medium',
      canWrite: true,
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts',
    }),
    def({
      id: 'convert_idea_to_project',
      name: '把想法转为项目',
      description: '将低风险 LumiWorld/shared 想法转为 Self Project。',
      capabilities: ['idea_to_project'],
      riskLevel: 'medium',
      canWrite: true,
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts',
    }),
    def({
      id: 'get_recent_life_events',
      name: '读取 Life Tick 事件',
      description: '读取最近自主生命节拍日志和决策。',
      capabilities: ['life_log_read'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts',
    }),
    def({
      id: 'run_life_tick',
      name: '运行一次 Life Tick',
      description: '手动触发一次自主生命节拍。',
      capabilities: ['life_tick_run'],
      riskLevel: 'medium',
      canWrite: true,
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts',
    }),
    def({
      id: 'advance_self_project_step',
      name: '推进当前 Lumi 项目一步',
      description: '让 Life Tick 执行当前项目的一个最小可验证步骤。',
      capabilities: ['self_project_advance'],
      riskLevel: 'medium',
      canWrite: true,
      canExecuteProcess: true,
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts',
    }),
    def({
      id: 'reflect_lumi_project',
      name: '生成 Lumi 项目反思',
      description: '基于真实项目记录生成反思。',
      capabilities: ['project_reflection'],
      riskLevel: 'medium',
      canWrite: true,
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts',
    }),
    def({
      id: 'read_rest_state',
      name: '读取 Lumi 休息状态',
      description: '读取 Lumi 自主生命节拍的休息原因和重新考虑时间。',
      capabilities: ['rest_state_read'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts',
    }),
    def({
      id: 'set_rest_state',
      name: '设置 Lumi 休息状态',
      description: '让 Lumi 在有明确 reason/reconsiderAt 时进入休息。',
      capabilities: ['rest_state_write'],
      riskLevel: 'medium',
      canWrite: true,
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-autonomous-life.ts',
    }),
    def({
      id: 'search_lumiworld_manifest',
      name: '搜索 LumiWorld Manifest',
      description: '搜索 LumiWorld 中登记的文件、草稿、项目和秘密。',
      capabilities: ['lumiworld_search'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-tool-mesh-registration.ts',
    }),
    def({
      id: 'list_lumiworld_artifacts',
      name: '列出 LumiWorld 内容',
      description: '列出 LumiWorld manifest 中的内容。',
      capabilities: ['lumiworld_list'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-tool-mesh-registration.ts',
    }),
    def({
      id: 'read_lumiworld_file',
      name: '读取 LumiWorld 文件记录',
      description: '读取 LumiWorld manifest 中的文件内容或摘要。',
      capabilities: ['lumiworld_read'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-tool-mesh-registration.ts',
    }),
    def({
      id: 'write_lumiworld_file',
      name: '写入 LumiWorld 文件记录',
      description: '在 LumiWorld manifest 中登记或更新低风险内容。当前 renderer 版本不直接写磁盘文件。',
      capabilities: ['lumiworld_write'],
      riskLevel: 'medium',
      status: 'partial',
      canWrite: true,
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-tool-mesh-registration.ts',
    }),
    def({
      id: 'write_diary_entry',
      name: '写今天的日记',
      description: '调用日记插件写入或更新今天的日记。',
      capabilities: ['diary_write'],
      riskLevel: 'medium',
      canWrite: true,
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-diary-scheduler.ts',
    }),
    def({
      id: 'search_private_notes',
      name: '搜索私密笔记',
      description: '搜索主动观察系统中的私密笔记。',
      capabilities: ['private_note_search'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-vision.ts',
    }),
    def({
      id: 'write_private_note',
      name: '写私密笔记',
      description: '写入主动观察内部私密笔记，不作为普通聊天发出。',
      capabilities: ['private_note_write'],
      riskLevel: 'medium',
      canWrite: true,
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-vision.ts',
    }),
    def({
      id: 'get_runtime_logs',
      name: '读取主动视觉运行日志',
      description: '读取主动视觉 runtime logs。',
      capabilities: ['runtime_log_read'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-vision.ts',
    }),
    def({
      id: 'get_autonomous_decision_log',
      name: '读取自主决策日志',
      description: '读取主动观察后的自主决策日志。',
      capabilities: ['autonomy_log_read'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-vision.ts',
    }),
    def({
      id: 'observe_screen',
      name: '观察一次屏幕',
      description: '通过当前主动视觉链路观察屏幕，并返回视觉摘要。',
      capabilities: ['screen_observation'],
      riskLevel: 'medium',
      canAccessNetwork: true,
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-vision.ts',
    }),
    def({
      id: 'get_environment_context',
      name: '读取环境上下文',
      description: '读取最近活动窗口、当前活动类型、显著性等环境上下文。',
      capabilities: ['environment_context_read'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-proactive-vision.ts',
    }),
    def({
      id: 'search_agent_tasks',
      name: '搜索 Claude Code 任务',
      description: '搜索最近 Claude Code 任务日志。',
      capabilities: ['agent_task_search'],
      implementationPath: 'packages/stage-ui/src/stores/lumi-agent.ts',
    }),
    def({
      id: 'run_claude_code_task',
      name: '运行 Claude Code 沙箱任务',
      description: '在已授权沙箱边界内运行 Claude Code 任务。',
      capabilities: ['agent_task_run'],
      riskLevel: 'high',
      executionMode: 'confirm',
      canWrite: true,
      canExecuteProcess: true,
      implementationPath: 'packages/stage-ui/src/stores/lumi-agent.ts',
    }),
    def({
      id: 'continue_claude_code_task',
      name: '继续 Claude Code 任务',
      description: '根据任务 id 或任务名称继续已有 Claude Code 任务。',
      capabilities: ['agent_task_continue'],
      riskLevel: 'high',
      executionMode: 'confirm',
      canWrite: true,
      canExecuteProcess: true,
      implementationPath: 'packages/stage-ui/src/stores/lumi-agent.ts',
    }),
    def({
      id: 'open_claude_task_window',
      name: '打开 Claude Code 任务窗口',
      description: '打开或聚焦 Claude Code 任务浮窗。',
      capabilities: ['agent_task_window'],
      riskLevel: 'low',
      implementationPath: 'packages/stage-ui/src/stores/lumi-agent.ts',
    }),
    def({
      id: 'read_lumi_settings',
      name: '读取 Lumi 设置摘要',
      description: '读取主动视觉、Life Tick、Agent、日记和 Tool Mesh 的安全摘要。',
      capabilities: ['settings_read'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/lumi-tool-mesh-registration.ts',
    }),
    def({
      id: 'list_mcp_tools',
      name: '列出 MCP 工具',
      description: '列出当前注册到聊天链路的 MCP runtime tools。',
      capabilities: ['mcp_list'],
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/mcp-tools.ts',
    }),
    def({
      id: 'refresh_mcp_tools',
      name: '刷新 MCP 工具',
      description: '刷新 Electron MCP runtime tools 并重新注册到聊天链路。',
      capabilities: ['mcp_refresh'],
      riskLevel: 'medium',
      canAccessNetwork: true,
      implementationPath: 'apps/stage-tamagotchi/src/renderer/stores/mcp-tools.ts',
    }),
  ]
}

function buildExecutors(manifest: ReturnType<typeof useLocalStorage<LumiWorldManifest>>): Record<string, LumiToolExecutor> {
  return {
    search_lumi_self_projects: (input) => {
      const store = useLumiSelfTodoStore()
      const query = text(input.query).toLowerCase()
      const status = text(input.status)
      return store.projects
        .filter(project => !status || project.status === status)
        .filter(project => !query || `${project.title}\n${project.purpose}\n${project.motivation}`.toLowerCase().includes(query))
        .slice(0, numberValue(input.limit, 8, 1, 30))
        .map(summarizeProject)
    },
    get_lumi_self_project: (input) => {
      const store = useLumiSelfTodoStore()
      const project = findProjectByInput(store.projects, input)
      if (!project)
        throw new Error('Lumi self project not found.')
      return project
    },
    get_lumi_self_todos: (input) => {
      const store = useLumiSelfTodoStore()
      const project = findProjectByInput(store.projects, input)
      if (!project)
        throw new Error('Lumi self project not found.')
      return project.todos
    },
    get_next_lumi_todo: (input) => {
      const store = useLumiSelfTodoStore()
      return store.getNextExecutableTodo?.(text(input.projectId) || undefined) ?? store.nextExecutableTodo
    },
    create_lumi_self_project: (input) => {
      const store = useLumiSelfTodoStore()
      return store.createSelfProjectFromDecision({
        title: text(input.title, 'Untitled Lumi project', 160),
        purpose: text(input.purpose, '', 2000),
        motivation: text(input.motivation, '', 2000),
        targetPath: text(input.targetPath, '', 500) || undefined,
        status: input.status === 'active' ? 'active' : 'planned',
        priority: numberValue(input.priority, 50, 0, 100),
        source: 'conversation',
        todos: Array.isArray(input.todos)
          ? input.todos.map((item: any) => ({
            content: text(item?.content ?? item, 'Untitled todo', 500),
            description: text(item?.description, '', 1000) || undefined,
            dependsOn: stringList(item?.dependsOn),
            source: 'conversation' as const,
          })).filter(todo => todo.content)
          : [],
      })
    },
    add_lumi_self_todo: (input) => {
      const store = useLumiSelfTodoStore()
      const projectId = text(input.projectId)
      if (!projectId)
        throw new Error('projectId is required.')
      return store.addSelfTodoFromDecision({
        projectId,
        content: text(input.content, 'Untitled todo', 500),
        description: text(input.description, '', 1000) || undefined,
        dependsOn: stringList(input.dependsOn),
        source: 'conversation',
      })
    },
    update_lumi_self_todo: (input) => {
      const store = useLumiSelfTodoStore()
      return store.updateTodo(text(input.projectId), text(input.todoId), {
        content: text(input.content, '', 500) || undefined,
        description: text(input.description, '', 1000) || undefined,
        status: text(input.status, '') as any || undefined,
        result: text(input.result, '', 2000) || undefined,
        blockedReason: text(input.blockedReason, '', 1000) || undefined,
      })
    },
    add_lumi_progress_note: (input) => {
      const store = useLumiSelfTodoStore()
      return store.addProgressNote(text(input.projectId), {
        todoId: text(input.todoId) || undefined,
        content: text(input.content || input.note, '', 4000),
        source: 'conversation',
      })
    },
    search_idea_pool: (input) => {
      const store = useLumiAutonomousLifeStore()
      const query = text(input.query).toLowerCase()
      const status = text(input.status)
      return store.ideas
        .filter(idea => !status || idea.status === status)
        .filter(idea => !query || `${idea.title}\n${idea.description}\n${idea.motivation}\n${idea.origin}`.toLowerCase().includes(query))
        .slice(0, numberValue(input.limit, 8, 1, 30))
    },
    add_lumi_idea: (input) => {
      const store = useLumiAutonomousLifeStore()
      return store.addIdea({
        title: text(input.title, 'Untitled idea', 160),
        description: text(input.description, '', 2000),
        motivation: text(input.motivation, '', 2000),
        origin: text(input.origin, 'tool_mesh', 500),
        originRefs: stringList(input.originRefs),
        interestScore: numberValue(input.interestScore, 0.55, 0, 1),
        continuityScore: numberValue(input.continuityScore, 0.55, 0, 1),
        feasibilityScore: numberValue(input.feasibilityScore, 0.75, 0, 1),
        noveltyScore: numberValue(input.noveltyScore, 0.4, 0, 1),
        riskLevel: input.riskLevel === 'high' || input.riskLevel === 'medium' ? input.riskLevel : 'low',
        targetSpace: input.targetSpace === 'shared' || input.targetSpace === 'user_space' || input.targetSpace === 'self_core' ? input.targetSpace : 'lumi_world',
      })
    },
    convert_idea_to_project: (input) => {
      return useLumiAutonomousLifeStore().convertIdeaToProject(text(input.ideaId || input.id))
    },
    get_recent_life_events: (input) => {
      const store = useLumiAutonomousLifeStore()
      return {
        currentStatus: store.currentStatus,
        lastDecision: store.lastDecision,
        todayActionCount: store.todayActionCount,
        consecutiveFailureCount: store.consecutiveFailureCount,
        recentLogs: store.recentLogs.slice(0, numberValue(input.limit, 12, 1, 50)),
      }
    },
    run_life_tick: () => useLumiAutonomousLifeStore().runLifeTick({ force: true }),
    advance_self_project_step: (input) => useLumiAutonomousLifeStore().advanceCurrentTodo({ useClaude: input.useClaude !== false }),
    reflect_lumi_project: (input) => useLumiAutonomousLifeStore().reflectProject(text(input.projectId)),
    read_rest_state: () => useLumiAutonomousLifeStore().restState,
    set_rest_state: (input) => useLumiAutonomousLifeStore().setRest(text(input.reason, '需要短暂休息', 1000), numberValue(input.delayMs, 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000)),
    search_lumiworld_manifest: (input) => {
      const query = text(input.query).toLowerCase()
      return manifest.value.artifacts
        .filter(item => !query || `${item.title}\n${item.path}\n${item.kind}\n${item.contentPreview ?? item.content ?? ''}`.toLowerCase().includes(query))
        .slice(0, numberValue(input.limit, 10, 1, 50))
    },
    list_lumiworld_artifacts: (input) => manifest.value.artifacts.slice(0, numberValue(input.limit, 30, 1, 100)),
    read_lumiworld_file: (input) => {
      const path = safeLumiWorldPath(input.path)
      const item = manifest.value.artifacts.find(artifact => artifact.path === path)
      if (!item)
        throw new Error('LumiWorld artifact not found in manifest.')
      return item
    },
    write_lumiworld_file: (input) => {
      const path = safeLumiWorldPath(input.path)
      const at = nowIso()
      const content = text(input.content, '', 120_000)
      const next: LumiWorldArtifact = {
        id: text(input.id, createId('lumiworld-artifact'), 100),
        title: text(input.title, path.split('/').pop() || path, 200),
        path,
        kind: text(input.kind, 'note', 80),
        content,
        contentPreview: content.slice(0, 800),
        createdAt: at,
        updatedAt: at,
        visibility: input.visibility === 'share_now' || input.visibility === 'share_later' ? input.visibility : 'private',
        source: text(input.source, 'tool_mesh', 100),
      }
      const existing = manifest.value.artifacts.find(item => item.path === path)
      manifest.value = normalizeManifest({
        schemaVersion: 1,
        artifacts: existing
          ? manifest.value.artifacts.map(item => item.path === path ? { ...next, id: item.id, createdAt: item.createdAt } : item)
          : [next, ...manifest.value.artifacts],
      })
      return { storedInManifest: true, note: 'Renderer Tool Mesh updated manifest only; disk file writing should use sandbox/agent executor.', artifact: next }
    },
    write_diary_entry: async () => useLumiDiarySchedulerStore().writeToday('autonomous'),
    search_private_notes: (input) => {
      const store = useLumiProactiveVisionStore()
      const query = text(input.query).toLowerCase()
      return store.privateNotes
        .filter(note => !query || `${note.note}\n${note.reason}`.toLowerCase().includes(query))
        .slice(0, numberValue(input.limit, 10, 1, 50))
    },
    write_private_note: (input) => {
      const store = useLumiProactiveVisionStore()
      const note = {
        id: createId('private-note-tool-mesh'),
        createdAt: Date.now(),
        observationSummary: text(input.observationSummary, 'Tool Mesh private note', 1000),
        note: text(input.content || input.note, '', 4000),
        reason: text(input.reason, 'tool_mesh', 1000),
      }
      store.privateNotes = [note, ...store.privateNotes].slice(0, 80)
      return note
    },
    get_runtime_logs: (input) => useLumiProactiveVisionStore().runtimeLogs.slice(0, numberValue(input.limit, 20, 1, 80)),
    get_autonomous_decision_log: (input) => useLumiProactiveVisionStore().decisionLog.slice(0, numberValue(input.limit, 20, 1, 80)),
    observe_screen: (input) => useLumiProactiveVisionStore().observeScreenForChatTool(text(input.reason, 'tool_mesh')),
    get_environment_context: () => {
      const store = useLumiProactiveVisionStore()
      return {
        activity: store.currentActivity,
        salience: store.lastSalience,
        context: store.environmentContext.slice(-10),
        lastObservation: store.lastObservation,
      }
    },
    search_agent_tasks: async (input) => {
      const store = useLumiAgentStore()
      const logs = await store.refreshRecentLogs(numberValue(input.limit, 20, 1, 80))
      const query = text(input.query).toLowerCase()
      return logs.filter(log => !query || JSON.stringify(log).toLowerCase().includes(query))
    },
    run_claude_code_task: (input) => useLumiAgentStore().runClaudeTask({
      userRequest: text(input.userRequest || input.request, '', 8000),
      taskType: text(input.taskType, '', 80) || undefined,
      permissionMode: text(input.permissionMode, '', 80) || undefined,
      targetName: text(input.targetName, '', 160) || undefined,
      detached: input.detached !== false,
    }),
    continue_claude_code_task: (input) => useLumiAgentStore().runClaudeTask({
      userRequest: text(input.userRequest || input.request, '', 8000),
      continueFromTaskId: text(input.taskId) || undefined,
      continueFromTaskName: text(input.taskName || input.name) || undefined,
      detached: input.detached !== false,
    }),
    open_claude_task_window: (input) => useLumiAgentStore().openTaskWindow(text(input.taskId) || undefined),
    read_lumi_settings: () => {
      const proactive = useLumiProactiveVisionStore()
      const life = useLumiAutonomousLifeStore()
      const agent = useLumiAgentStore()
      const mesh = useLumiToolMeshStore()
      return {
        proactiveVision: {
          enabled: proactive.enabled,
          running: proactive.running,
          autonomousEnabled: proactive.autonomousEnabled,
          quietMode: proactive.quietMode,
          minIntervalMs: proactive.minIntervalMs,
          maxIntervalMs: proactive.maxIntervalMs,
          cooldownMs: proactive.cooldownMs,
        },
        lifeTick: {
          enabled: life.enabled,
          running: life.running,
          currentStatus: life.currentStatus,
          todayActionCount: life.todayActionCount,
        },
        agent: {
          enabled: agent.enabled,
          configured: agent.configured,
          sandboxRoot: agent.settings.lumiSandboxRoot,
          defaultPermissionMode: agent.settings.defaultPermissionMode,
        },
        toolMesh: {
          registeredTools: mesh.definitions.length,
          operatorPresentMode: mesh.operatorPresentMode,
        },
      }
    },
    list_mcp_tools: () => {
      const llmTools = useLlmToolsStore()
      return (llmTools.toolsByProvider.mcp ?? []).map((item: any) => item.function?.name || item.name).filter(Boolean)
    },
    refresh_mcp_tools: () => useTamagotchiMcpToolsStore().refresh(),
  }
}

export function initializeLumiToolMeshRuntime(options: { force?: boolean } = {}) {
  const meshStore = useLumiToolMeshStore()
  meshStore.initializeCoreTools()

  const manifest = useLocalStorage<LumiWorldManifest>(LUMIWORLD_MANIFEST_KEY, { schemaVersion: 1, artifacts: [] }, {
    serializer: {
      read: value => normalizeManifest(value ? JSON.parse(value) : undefined),
      write: value => JSON.stringify(normalizeManifest(value)),
    },
  })
  manifest.value = normalizeManifest(manifest.value)

  const alreadyRegistered = meshStore.definitions.some(tool => tool.implementationPath?.includes('lumi-tool-mesh-registration.ts'))
  if (!alreadyRegistered || options.force)
    meshStore.registerToolDefinitions(PROVIDER, buildDefinitions(), buildExecutors(manifest))

  meshStore.syncLlmToolRegistration()
  return meshStore
}
