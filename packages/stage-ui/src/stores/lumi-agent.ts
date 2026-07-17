import type { ChatHistoryItem } from '../types/chat'
import type { Tool } from '@xsai/shared-chat'

import type {
  AgentSettings,
  AgentTaskLog,
  AgentTaskRoute,
  ClaudeCodeResult,
} from '../libs/lumi-agent'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { tool } from '@xsai/tool'
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { z } from 'zod'

import {
  AGENT_PERMISSION_MODES,
  AGENT_TASK_TYPES,
  DEFAULT_AGENT_SETTINGS,
  routeAgentTask,
} from '../libs/lumi-agent'
import { useChatSessionStore } from './chat/session-store'
import { useLlmToolsStore } from './llm-tools'
import { useLlmToolsetPromptsStore } from './llm-toolset-prompts'
import { useLumiMemoryStore } from './lumi-memory'

const LUMI_AGENT_TOOLS_PROVIDER = 'lumi-agent'

function rememberClaudeTaskRecord(input: { taskId?: string, task?: any, log?: AgentTaskLog, status?: string, changedFiles?: string[], error?: string }) {
  const taskId = input.taskId || input.log?.taskId || input.task?.id
  if (!taskId)
    return
  const task = input.log || input.task || {}
  const now = new Date().toISOString()
  const displayName = task.displayName || `Claude Code 任务 ${taskId}`
  const cwd = task.cwd || ''
  const status = input.log?.status || input.status || task.status || 'running'
  const changedFiles = input.log?.changedFiles || input.changedFiles || []
  const content = [
    `Claude Code 任务：${displayName}`,
    `任务ID：${taskId}`,
    cwd ? `工作目录：${cwd}` : '',
    `当前状态：${status}`,
    task.initialUserRequest || task.userRequest ? `原始需求：${task.initialUserRequest || task.userRequest}` : '',
    task.latestUserRequest && task.latestUserRequest !== task.userRequest ? `最近续写：${task.latestUserRequest}` : '',
    changedFiles.length > 0 ? `变更文件：${changedFiles.slice(0, 12).join(', ')}` : '',
    input.error || task.error ? `最近错误：${input.error || task.error}` : '',
    '用途：当 Doggy 说任务名称、项目名称或大概内容时，用这条记忆找到对应任务并继续同一个任务窗口。',
  ].filter(Boolean).join('\n')

  useLumiMemoryStore().remember({
    id: `claude-task:${taskId}`,
    userId: 'local',
    personaId: 'lumi',
    type: 'project_context',
    content,
    sourceMessageId: taskId,
    confidence: 0.9,
    importance: 0.78,
    emotionalIntensity: 0.1,
    relationshipRelevance: 0.62,
    createdAt: task.createdAt || now,
    updatedAt: now,
    decay: 0.08,
    tags: ['claude_code_task', `task_id:${taskId}`, displayName, ...(task.keywords || [])].filter(Boolean),
    status: 'active',
  })
}

export interface LumiAgentRunPayload {
  userRequest: string
  taskType?: string
  permissionMode?: string
  targetName?: string
  condaEnv?: string
  settings?: AgentSettings
  continueFromTaskId?: string
  continueFromTaskName?: string
  detached?: boolean
}

export interface LumiAgentBridge {
  runClaudeTask: (payload: LumiAgentRunPayload) => Promise<ClaudeCodeResult & { task?: any, log?: AgentTaskLog }>
  cancelClaudeTask: (taskId: string) => Promise<void>
  listClaudeTasks: (limit?: number) => Promise<AgentTaskLog[]>
  getClaudeTaskLog: (taskId: string) => Promise<AgentTaskLog | undefined>
  openClaudeTaskWindow?: (taskId?: string, settings?: AgentSettings) => Promise<void>
  pickClaudeCommand?: () => Promise<{ path?: string }>
  searchClaudeCommand?: (command?: string) => Promise<{ path?: string, candidates: string[], error?: string }>
}

function createId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeList(text: string) {
  return text
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean)
}

function listToText(list: string[]) {
  return list.join('\n')
}

function appendSystemNotice(lines: string[]) {
  const sessionStore = useChatSessionStore()
  const sessionId = sessionStore.activeSessionId
  if (!sessionId)
    return

  sessionStore.ensureSession(sessionId)
  const content = [
    '[system_notice]',
    'title: Claude Code 任务',
    ...lines,
  ].join('\n')
  const message: ChatHistoryItem = {
    id: createId('lumi-agent-notice'),
    role: 'assistant',
    content,
    slices: [{ type: 'text', text: content }],
    tool_results: [],
    createdAt: Date.now(),
  }
  sessionStore.setSessionMessages(sessionId, [
    ...sessionStore.getSessionMessages(sessionId),
    message,
  ])
}

export const useLumiAgentStore = defineStore('lumi-agent', () => {
  const enabled = useLocalStorageManualReset('settings/lumi/agent/enabled', DEFAULT_AGENT_SETTINGS.enabled)
  const claudeCommand = useLocalStorageManualReset('settings/lumi/agent/claude-command', DEFAULT_AGENT_SETTINGS.claudeCommand)
  const lumiSandboxRoot = useLocalStorageManualReset('settings/lumi/agent/sandbox-root', DEFAULT_AGENT_SETTINGS.lumiSandboxRoot)
  const trustedProjectsText = useLocalStorageManualReset('settings/lumi/agent/trusted-projects', listToText(DEFAULT_AGENT_SETTINGS.trustedProjects))
  const selfProjectRootsText = useLocalStorageManualReset('settings/lumi/agent/self-project-roots', listToText(DEFAULT_AGENT_SETTINGS.selfProjectRoots))
  const forbiddenPathsText = useLocalStorageManualReset('settings/lumi/agent/forbidden-paths', listToText(DEFAULT_AGENT_SETTINGS.forbiddenPaths))
  const defaultPermissionMode = useLocalStorageManualReset<AgentSettings['defaultPermissionMode']>('settings/lumi/agent/default-permission-mode', DEFAULT_AGENT_SETTINGS.defaultPermissionMode)
  const sandboxAutoApprove = useLocalStorageManualReset('settings/lumi/agent/sandbox-auto-approve', DEFAULT_AGENT_SETTINGS.sandboxAutoApprove)
  const maxTaskTimeoutMs = useLocalStorageManualReset('settings/lumi/agent/max-task-timeout-ms', DEFAULT_AGENT_SETTINGS.maxTaskTimeoutMs)
  const allowedCondaEnvsText = useLocalStorageManualReset('settings/lumi/agent/allowed-conda-envs', listToText(DEFAULT_AGENT_SETTINGS.allowedCondaEnvs))
  const defaultCondaEnv = useLocalStorageManualReset('settings/lumi/agent/default-conda-env', DEFAULT_AGENT_SETTINGS.defaultCondaEnv ?? '')
  const recentLogs = ref<AgentTaskLog[]>([])
  const commandCandidates = ref<string[]>([])
  const watchedTaskIds = new Set<string>()
  const lastRoute = ref<AgentTaskRoute | null>(null)
  const lastError = ref('')
  const registered = ref(false)
  const bridge = shallowRef<LumiAgentBridge | null>(null)

  const settings = computed<AgentSettings>(() => ({
    enabled: Boolean(enabled.value),
    claudeCommand: String(claudeCommand.value || 'claude').trim() || 'claude',
    lumiSandboxRoot: String(lumiSandboxRoot.value || '').trim(),
    trustedProjects: normalizeList(trustedProjectsText.value),
    selfProjectRoots: normalizeList(selfProjectRootsText.value),
    forbiddenPaths: normalizeList(forbiddenPathsText.value),
    defaultPermissionMode: AGENT_PERMISSION_MODES.includes(defaultPermissionMode.value)
      ? defaultPermissionMode.value
      : 'read_only',
    sandboxAutoApprove: Boolean(sandboxAutoApprove.value),
    maxTaskTimeoutMs: Math.min(30 * 60 * 1000, Math.max(10_000, Number(maxTaskTimeoutMs.value) || DEFAULT_AGENT_SETTINGS.maxTaskTimeoutMs)),
    allowedCondaEnvs: normalizeList(allowedCondaEnvsText.value).filter(env => env !== 'base'),
    defaultCondaEnv: defaultCondaEnv.value.trim() || undefined,
  }))

  const configured = computed(() => Boolean(settings.value.enabled && settings.value.lumiSandboxRoot))
  const loaded = computed(() => registered.value)

  function setBridge(nextBridge: LumiAgentBridge | null) {
    bridge.value = nextBridge
  }

  async function refreshRecentLogs(limit = 10) {
    if (!bridge.value)
      return []
    recentLogs.value = await bridge.value.listClaudeTasks(limit)
    return recentLogs.value
  }

  async function openTaskWindow(taskId?: string) {
    await bridge.value?.openClaudeTaskWindow?.(taskId, settings.value)
  }

  async function pickClaudeCommand() {
    if (!bridge.value?.pickClaudeCommand)
      throw new Error('当前运行环境不支持选择 Claude Code 命令文件。')
    const result = await bridge.value.pickClaudeCommand()
    if (result.path)
      claudeCommand.value = result.path
    return result
  }

  async function searchClaudeCommand() {
    if (!bridge.value?.searchClaudeCommand)
      throw new Error('当前运行环境不支持自动搜索 Claude Code 命令。')
    const result = await bridge.value.searchClaudeCommand(settings.value.claudeCommand || 'claude')
    commandCandidates.value = result.candidates
    if (result.path)
      claudeCommand.value = result.path
    if (result.error)
      lastError.value = result.error
    return result
  }

  async function runClaudeTask(payload: LumiAgentRunPayload) {
    if (!bridge.value)
      throw new Error('Claude Code bridge is not available in this runtime.')

    const taskSettings = payload.settings ?? settings.value
    const route = routeAgentTask(payload.userRequest, taskSettings)
    lastRoute.value = route
    appendSystemNotice([
      `status: routed`,
      `taskType: ${payload.taskType || route.taskType}`,
      `permissionMode: ${payload.permissionMode || route.permissionMode}`,
      'executor: claude_code',
      `reason: ${route.reason}`,
    ])

    const result = await bridge.value.runClaudeTask({
      userRequest: payload.userRequest,
      taskType: payload.taskType,
      permissionMode: payload.permissionMode,
      targetName: payload.targetName,
      condaEnv: payload.condaEnv,
      continueFromTaskId: payload.continueFromTaskId,
      continueFromTaskName: payload.continueFromTaskName,
      settings: taskSettings,
      detached: payload.detached ?? true,
    })
    appendSystemNotice([
      `status: ${result.status}`,
      `taskId: ${result.taskId}`,
      result.task?.displayName ? `name: ${result.task.displayName}` : '',
      `changedFiles: ${result.changedFiles.length}`,
      result.error ? `error: ${result.error}` : '',
      result.stderr ? `stderr: ${result.stderr.slice(0, 500)}` : '',
    ].filter(Boolean))
    rememberClaudeTaskRecord(result)
    if (result.status === 'running')
      watchTaskCompletion(result.taskId, result.startedAt)
    await refreshRecentLogs().catch(() => {})
    return result
  }

  function watchTaskCompletion(taskId: string, expectedStartedAt?: string) {
    const watchKey = expectedStartedAt ? `${taskId}:${expectedStartedAt}` : taskId
    if (!bridge.value || watchedTaskIds.has(watchKey))
      return
    watchedTaskIds.add(watchKey)
    let attempts = 0
    const timer = globalThis.setInterval(() => {
      attempts += 1
      if (!bridge.value || attempts > 1800) {
        globalThis.clearInterval(timer)
        watchedTaskIds.delete(watchKey)
        return
      }
      bridge.value.getClaudeTaskLog(taskId)
        .then((log) => {
          if (!log)
            return
          if (expectedStartedAt) {
            const logStarted = Date.parse(log.startedAt || log.endedAt || '')
            const expected = Date.parse(expectedStartedAt)
            if (Number.isFinite(logStarted) && Number.isFinite(expected) && logStarted + 500 < expected)
              return
          }
          globalThis.clearInterval(timer)
          watchedTaskIds.delete(watchKey)
          rememberClaudeTaskRecord({ taskId, log })
          appendSystemNotice([
            `status: ${log.status}`,
            `taskId: ${taskId}`,
            log.displayName ? `name: ${log.displayName}` : '',
            `changedFiles: ${log.changedFiles.length}`,
            log.changedFiles.length > 0 ? `files: ${log.changedFiles.slice(0, 8).join(', ')}` : '',
            log.error ? `error: ${log.error}` : '',
          ].filter(Boolean))
          void refreshRecentLogs().catch(() => {})
        })
        .catch(() => {})
    }, 2000)
  }

  function createClaudeCodeTool(): Promise<Tool> {
    return tool({
      name: 'lumi_delegate_to_claude_code',
      description: 'Delegate an external file/code/document task to Claude Code CLI. Use only for explicit external artifact creation, file editing, document work, note review, file analysis, or sandbox coding tasks. Do not use for ordinary chat, emotional support, or simple advice.',
      parameters: z.object({
        userRequest: z.string().min(1).max(4000).describe('The user task to delegate. Preserve concrete requirements and target file/project names.'),
        taskType: z.enum(AGENT_TASK_TYPES).optional().describe('Optional task type override. If omitted, Lumi Agent Task Router decides.'),
        permissionMode: z.enum(AGENT_PERMISSION_MODES).optional().describe('Optional permission override. Self project write is not allowed unless the app has explicit authorization.'),
        targetName: z.string().min(1).max(120).optional().describe('Optional safe, human-readable project/output folder name inside LumiSandbox. Use stable names like pomodoro or lumi-diary, not random ids.'),
        condaEnv: z.string().min(1).max(80).optional().describe('Optional conda env. Must be listed in allowedCondaEnvs; base is forbidden.'),
        continueFromTaskName: z.string().min(1).max(120).optional().describe('If the user asks to continue/fix/modify a previous task by name or approximate content, pass that name/content here. Claude Code must reuse the existing task window and working directory.'),
        continueFromTaskId: z.string().min(1).max(120).optional().describe('If a previous task id is known, pass it here to continue in the same working directory.'),
      }).strict(),
      execute: async (payload) => {
        if (!enabled.value) {
          return JSON.stringify({
            status: 'disabled',
            instruction: 'Tell the user Claude Code delegation is disabled and can be enabled in Settings > Modules > Actions.',
          })
        }
        if (!settings.value.lumiSandboxRoot) {
          return JSON.stringify({
            status: 'sandbox_not_configured',
            instruction: 'Tell the user to configure LumiSandbox root before Claude Code can run automatically.',
          })
        }
        try {
          lastError.value = ''
          const result = await runClaudeTask(payload)
          return JSON.stringify({
          status: result.status,
          taskId: result.taskId,
          displayName: result.task?.displayName,
          summary: result.task?.summary || result.log?.summary,
          instructionForFutureContinuation: 'Store the task name/id mentally. If the user later asks to continue this task by name or approximate content, call this tool with continueFromTaskName or continueFromTaskId instead of creating a new task.',
            changedFiles: result.changedFiles,
            createdFiles: result.createdFiles,
            modifiedFiles: result.modifiedFiles,
            deletedFiles: result.deletedFiles,
            stdoutPreview: result.stdout.slice(0, 1200),
            stderrPreview: result.stderr.slice(0, 1200),
            error: result.error,
            instruction: result.status === 'running'
              ? 'Tell the user the Claude Code task has started in a separate task window. Do not wait for completion; they can keep chatting normally. Do not invent the final result.'
              : result.status === 'success'
              ? 'Summarize honestly what Claude Code created or changed and how the user can view it.'
              : 'Do not pretend success. Explain the failure and the next safe step.',
          })
        }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          lastError.value = message
          appendSystemNotice([
            'status: failed',
            `error: ${message}`,
          ])
          return JSON.stringify({
            status: 'failed',
            error: message,
            instruction: 'Tell the user Claude Code delegation failed and include the concrete error.',
          })
        }
      },
    })
  }

  async function registerTool() {
    if (registered.value)
      return

    await useLlmToolsStore().registerTools(LUMI_AGENT_TOOLS_PROVIDER, Promise.all([
      createClaudeCodeTool(),
    ]))
    useLlmToolsetPromptsStore().registerToolsetPrompts(LUMI_AGENT_TOOLS_PROVIDER, [
      {
        id: 'lumi-agent-claude-code-guidance',
        title: 'Lumi Claude Code Delegation',
        content: [
          'When the active persona is Lumi, `lumi_delegate_to_claude_code` can delegate explicit external tasks to Claude Code CLI.',
          'Use it only when the user clearly asks to create or modify external files, generate a small web/project artifact, edit Markdown/document content, review notes, analyze a file, or perform sandbox coding work.',
          'If the user asks to continue, fix, polish, or modify a previous task, always pass continueFromTaskName with the user-facing task name or approximate content; use continueFromTaskId when visible. Do not start a separate fresh project when the user clearly means the old task.',
          'Every started task has a displayName and taskId. Remember them as project context, and use those names when talking to Doggy so he does not need backend ids.',
          'Do not use it for ordinary conversation, emotional companionship, simple explanations, or answers Lumi can provide directly.',
          'Self-project improvement requests must stay proposal-only. Never request direct writes to Lumi/AIRI source unless the user has granted an explicit one-time permission outside this tool.',
          'If the tool returns disabled, sandbox_not_configured, blocked, failed, or timeout, explain that honestly and do not claim the task succeeded.',
        ].join('\n'),
      },
    ])
    registered.value = true
  }

  function clearTool() {
    useLlmToolsStore().clearTools(LUMI_AGENT_TOOLS_PROVIDER)
    useLlmToolsetPromptsStore().clearToolsetPrompts(LUMI_AGENT_TOOLS_PROVIDER)
    registered.value = false
  }

  function initializeToolRegistration() {
    void registerTool().catch((error) => {
      lastError.value = error instanceof Error ? error.message : String(error)
      console.warn('[lumi-agent] Failed to register tool:', error)
    })
  }

  function resetSettings() {
    enabled.reset()
    claudeCommand.reset()
    lumiSandboxRoot.reset()
    trustedProjectsText.reset()
    selfProjectRootsText.reset()
    forbiddenPathsText.reset()
    defaultPermissionMode.reset()
    sandboxAutoApprove.reset()
    maxTaskTimeoutMs.reset()
    allowedCondaEnvsText.reset()
    defaultCondaEnv.reset()
  }

  return {
    enabled,
    claudeCommand,
    lumiSandboxRoot,
    trustedProjectsText,
    selfProjectRootsText,
    forbiddenPathsText,
    defaultPermissionMode,
    sandboxAutoApprove,
    maxTaskTimeoutMs,
    allowedCondaEnvsText,
    defaultCondaEnv,
    recentLogs,
    commandCandidates,
    lastRoute,
    lastError,
    registered,
    loaded,
    configured,
    settings,
    setBridge,
    refreshRecentLogs,
    pickClaudeCommand,
    searchClaudeCommand,
    runClaudeTask,
    openTaskWindow,
    registerTool,
    clearTool,
    initializeToolRegistration,
    resetSettings,
  }
})
