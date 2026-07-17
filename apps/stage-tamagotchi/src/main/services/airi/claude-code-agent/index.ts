import type { createContext } from '@moeru/eventa/adapters/electron/main'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import type {
  AgentPermissionMode,
  AgentSettings,
  AgentTaskLog,
  AgentTaskRoute,
  AgentTaskType,
  ClaudeCodeResult,
  ClaudeCodeTask,
} from '@proj-airi/stage-ui/libs/lumi-agent'

import { defineInvokeHandler } from '@moeru/eventa'
import { createContext as createElectronEventaContext } from '@moeru/eventa/adapters/electron/main'
import {
  AGENT_PERMISSION_MODES,
  AGENT_TASK_TYPES,
  buildClaudeCodePrompt,
  DEFAULT_AGENT_SETTINGS,
  routeAgentTask,
} from '@proj-airi/stage-ui/libs/lumi-agent'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'

import {
  electronClaudeCodeAgentCancelTask,
  electronClaudeCodeAgentGetLog,
  electronClaudeCodeAgentListLogs,
  electronClaudeCodeAgentGetTaskSnapshot,
  electronClaudeCodeAgentOpenTaskWindow,
  electronClaudeCodeAgentApproveTaskPermission,
  electronClaudeCodeAgentPickCommand,
  electronClaudeCodeAgentRejectTaskPermission,
  electronClaudeCodeAgentRunTask,
  electronClaudeCodeAgentSearchCommand,
  type ElectronClaudeCodeAgentRunPayload,
  type ElectronClaudeCodeAgentResult,
  type ElectronClaudeCodeAgentTaskEvent,
} from '../../../../shared/eventa'

type PathClass = 'sandbox' | 'trusted' | 'self' | 'forbidden' | 'unknown'

interface FileSnapshotEntry {
  rel: string
  size: number
  mtimeMs: number
}

interface ResolvedCommand {
  command: string
  shell: boolean
}

const runningTasks = new Map<string, ChildProcessWithoutNullStreams>()
const pendingPermissionTasks = new Map<string, { settings: AgentSettings, task: ClaudeCodeTask }>()
const taskEvents = new Map<string, ElectronClaudeCodeAgentTaskEvent[]>()
const taskLogs = new Map<string, AgentTaskLog>()
let latestTaskId = ''
let taskWindow: BrowserWindow | undefined
let lastKnownSettings: AgentSettings | undefined

const SECRET_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /id_rsa/i,
  /id_ed25519/i,
  /private[_-]?key/i,
  /token/i,
  /secret/i,
  /credential/i,
]

function normalizeSettings(input: Record<string, any> | undefined): AgentSettings {
  const settings = { ...DEFAULT_AGENT_SETTINGS, ...(input ?? {}) }
  return {
    enabled: Boolean(settings.enabled),
    claudeCommand: String(settings.claudeCommand || 'claude').trim() || 'claude',
    lumiSandboxRoot: String(settings.lumiSandboxRoot || '').trim(),
    trustedProjects: normalizeStringList(settings.trustedProjects),
    selfProjectRoots: normalizeStringList(settings.selfProjectRoots),
    forbiddenPaths: normalizeStringList(settings.forbiddenPaths),
    defaultPermissionMode: AGENT_PERMISSION_MODES.includes(settings.defaultPermissionMode)
      ? settings.defaultPermissionMode
      : 'read_only',
    sandboxAutoApprove: Boolean(settings.sandboxAutoApprove),
    maxTaskTimeoutMs: Math.min(30 * 60 * 1000, Math.max(10_000, Number(settings.maxTaskTimeoutMs) || 300000)),
    allowedCondaEnvs: normalizeStringList(settings.allowedCondaEnvs).filter(env => env !== 'base'),
    defaultCondaEnv: typeof settings.defaultCondaEnv === 'string' && settings.defaultCondaEnv.trim()
      ? settings.defaultCondaEnv.trim()
      : undefined,
  }
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value))
    return []
  return value.map(item => String(item).trim()).filter(Boolean)
}

function sanitizeTargetName(value: string | undefined, fallback: string) {
  const base = (value || fallback)
    .trim()
    .replace(/[^\w\u4E00-\u9FFF.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return base || fallback
}

const TASK_TYPE_LABELS: Record<AgentTaskType, string> = {
  web_project: 'Web project',
  markdown_edit: 'Markdown edit',
  document_generation: 'Document generation',
  document_edit: 'Document edit',
  note_review: 'Note review',
  file_analysis: 'File analysis',
  coding_help: 'Coding task',
  self_project_improvement: 'AIRI improvement',
  unknown: 'Claude Code task',
}

function stripTaskFiller(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/^(please|help me|continue|fix|modify|polish)\s+/i, '')
    .replace(/[\\/:*?"<>|#{}[\]]+/g, ' ')
    .trim()
}

function deriveReadableTaskName(userRequest: string, taskType: AgentTaskType, targetName?: string) {
  const target = stripTaskFiller(targetName || '')
  if (target)
    return target.slice(0, 36)

  const text = stripTaskFiller(userRequest)
  if (/pomodoro|番茄钟|番茄/.test(text))
    return 'Lumi Pomodoro'
  if (/日记/.test(text))
    return 'Lumi 日记'
  if (/浮窗|悬浮窗|小窗/.test(text))
    return 'Lumi 聊天浮窗'

  const firstLine = text
    .split(/[\r\n。！？!?]/)
    .map(item => item.trim())
    .find(Boolean)
  if (firstLine)
    return firstLine.slice(0, 36)

  return `${TASK_TYPE_LABELS[taskType]} ${new Date().toLocaleString('zh-CN', { hour12: false })}`
}

function deriveTargetSlug(userRequest: string, taskType: AgentTaskType, targetName?: string) {
  const readable = deriveReadableTaskName(userRequest, taskType, targetName)
  if (/pomodoro|番茄/i.test(readable))
    return 'pomodoro'
  return sanitizeTargetName(readable, taskType)
}

function tokenizeTaskQuery(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\w\u4E00-\u9FFF]+/g, ' ')
    .split(/\s+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2)
}

function createTaskSummary(task: Pick<ClaudeCodeTask, 'displayName' | 'userRequest' | 'taskType' | 'cwd'>, result?: Partial<ClaudeCodeResult>) {
  const changed = result?.changedFiles?.slice(0, 8) ?? []
  return [
    task.displayName ? `任务名：${task.displayName}` : '',
    `类型：${TASK_TYPE_LABELS[task.taskType] || task.taskType}`,
    `目录：${task.cwd}`,
    `需求：${task.userRequest}`,
    changed.length > 0 ? `变更：${changed.join(', ')}` : '',
  ].filter(Boolean).join('\n')
}

function createTaskKeywords(task: Pick<ClaudeCodeTask, 'displayName' | 'userRequest' | 'taskType' | 'cwd'>) {
  return [...new Set([
    ...(task.displayName ? tokenizeTaskQuery(task.displayName) : []),
    ...tokenizeTaskQuery(task.userRequest),
    task.taskType,
    basename(task.cwd).toLowerCase(),
  ])].slice(0, 30)
}

async function createUniqueTargetName(sandboxRoot: string, targetSubdir: string, baseName: string) {
  const base = sanitizeTargetName(baseName, 'task')
  for (let i = 1; i <= 40; i += 1) {
    const candidate = i === 1 ? base : `${base}-${i}`
    if (!await fileExists(resolve(sandboxRoot, join(targetSubdir, candidate))))
      return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

function normalizeLegacyDisplayName(log: AgentTaskLog) {
  const displayName = log.displayName || ''
  const uglyGenerated = /^(?:web_project|coding_help|document_generation|document_edit|markdown_edit|note_review|file_analysis|unknown)-[a-z0-9]+$/i.test(displayName)
  const childSuffix = /续作$/.test(displayName)
  if (!displayName || uglyGenerated || childSuffix)
    return deriveReadableTaskName(log.initialUserRequest || log.userRequest || displayName, log.taskType)
  return displayName
}

function normalizeAgentLog(log: AgentTaskLog): AgentTaskLog {
  const displayName = normalizeLegacyDisplayName(log)
  return {
    ...log,
    displayName,
    initialUserRequest: log.initialUserRequest || log.userRequest,
    latestUserRequest: log.latestUserRequest || log.userRequest,
    summary: log.summary || createTaskSummary({ ...log, displayName }, log),
    keywords: log.keywords?.length ? log.keywords : createTaskKeywords({ ...log, displayName }),
  }
}

function createTaskDisplayName(payload: ElectronClaudeCodeAgentRunPayload, taskType: AgentTaskType, parent?: AgentTaskLog) {
  if (parent?.displayName)
    return parent.displayName
  return deriveReadableTaskName(payload.userRequest, taskType, payload.targetName)
}

function resolveTaskSettings(input: Record<string, any> | undefined) {
  const settings = input ? normalizeSettings(input) : (lastKnownSettings ?? normalizeSettings(undefined))
  if (settings.enabled && settings.lumiSandboxRoot)
    lastKnownSettings = settings
  return settings
}

async function fileExists(path: string) {
  try {
    await access(path, constants.F_OK)
    return true
  }
  catch {
    return false
  }
}

function commandLooksLikePath(command: string) {
  return isAbsolute(command) || /[\\/]/.test(command)
}

function commandCandidateNames(command: string) {
  if (process.platform !== 'win32' || extname(command))
    return [command]
  return [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command]
}

function commandSearchDirs() {
  const pathDirs = (process.env.PATH || process.env.Path || '')
    .split(delimiter)
    .map(item => item.trim())
    .filter(Boolean)
  const extraDirs = [
    process.env.APPDATA ? join(process.env.APPDATA, 'npm') : '',
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'pnpm') : '',
    process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Roaming', 'npm') : '',
    process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Local', 'pnpm') : '',
  ].filter(Boolean)
  return [...new Set([...pathDirs, ...extraDirs])]
}

async function resolveExecutableCommand(command: string): Promise<ResolvedCommand> {
  const trimmed = command.trim()
  if (!trimmed)
    throw new Error('Claude command is empty.')

  const candidates = await findExecutableCommandCandidates(trimmed)
  for (const candidate of candidates) {
    return {
      command: candidate,
      shell: process.platform === 'win32' && (!extname(candidate) || /\.(?:cmd|bat)$/i.test(candidate)),
    }
  }

  throw new Error([
    `Claude Code CLI was not found: ${trimmed}`,
    'Set "Claude 鍛戒护" to the full claude executable path, for example C:\\Users\\<you>\\AppData\\Roaming\\npm\\claude.cmd, or restart AIRI from a terminal whose PATH can find claude.',
  ].join('\n'))
}

async function findExecutableCommandCandidates(command: string): Promise<string[]> {
  const trimmed = command.trim()
  if (!trimmed)
    return []

  const candidates: string[] = []
  if (commandLooksLikePath(trimmed)) {
    const dir = dirname(trimmed)
    const base = basename(trimmed)
    candidates.push(...commandCandidateNames(base).map(name => resolve(dir, name)))
  }
  else {
    for (const dir of commandSearchDirs())
      candidates.push(...commandCandidateNames(trimmed).map(name => join(dir, name)))
  }

  const existing: string[] = []
  for (const candidate of [...new Set(candidates)]) {
    if (await fileExists(candidate))
      existing.push(candidate)
  }
  return existing
}

async function ensureRealDirectory(path: string) {
  await mkdir(path, { recursive: true })
  return realpath(path)
}

async function resolveExistingOrParent(path: string): Promise<string> {
  try {
    return await realpath(path)
  }
  catch {
    const parent = await resolveExistingOrParent(dirname(path))
    return resolve(parent, basename(path))
  }
}

export async function resolveSafePath(root: string, target: string): Promise<string> {
  if (!root.trim())
    throw new Error('Root path is empty.')
  const realRoot = await ensureRealDirectory(resolve(root))
  const candidate = isAbsolute(target) ? normalize(target) : normalize(resolve(realRoot, target))
  const resolved = await resolveExistingOrParent(candidate)
  if (!isInsideResolvedRoot(realRoot, resolved))
    throw new Error(`Path escapes allowed root: ${target}`)
  return resolved
}

export function isInsideResolvedRoot(root: string, target: string) {
  const rel = relative(normalize(root), normalize(target))
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

async function isInsideRoot(root: string, target: string) {
  if (!root.trim())
    return false
  try {
    const realRoot = await ensureRealDirectory(resolve(root))
    const realTarget = await resolveExistingOrParent(target)
    return isInsideResolvedRoot(realRoot, realTarget)
  }
  catch {
    return false
  }
}

async function isInsideAnyRoot(roots: string[], target: string) {
  for (const root of roots) {
    if (await isInsideRoot(root, target))
      return true
  }
  return false
}

async function classifyPath(settings: AgentSettings, target: string): Promise<PathClass> {
  if (isSecretLikePath(target))
    return 'forbidden'
  if (await isInsideAnyRoot(settings.forbiddenPaths, target))
    return 'forbidden'
  if (settings.lumiSandboxRoot && await isInsideRoot(settings.lumiSandboxRoot, target))
    return 'sandbox'
  if (await isInsideAnyRoot(settings.selfProjectRoots, target))
    return 'self'
  if (await isInsideAnyRoot(settings.trustedProjects, target))
    return 'trusted'
  return 'unknown'
}

function isSecretLikePath(target: string) {
  const name = basename(target)
  return SECRET_FILE_PATTERNS.some(pattern => pattern.test(name))
}

async function assertInsideSandbox(settings: AgentSettings, target: string) {
  const pathClass = await classifyPath(settings, target)
  if (pathClass !== 'sandbox')
    throw new Error(`Claude Code sandbox_auto can only write inside LumiSandbox. Path class: ${pathClass}`)
}

function createTaskId() {
  return `claude-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
}

function appendTaskEvent(taskId: string, type: ElectronClaudeCodeAgentTaskEvent['type'], message: string, data?: Record<string, any>) {
  latestTaskId = taskId
  const event: ElectronClaudeCodeAgentTaskEvent = {
    id: `${taskId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    taskId,
    type,
    message,
    createdAt: new Date().toISOString(),
    data,
  }
  const events = taskEvents.get(taskId) ?? []
  events.push(event)
  taskEvents.set(taskId, events.slice(-500))
}

function requiresManualPermission(permissionMode: AgentPermissionMode) {
  return permissionMode === 'trusted_project_assisted'
    || permissionMode === 'self_project_write_once'
    || permissionMode === 'blocked'
}

async function openClaudeTaskWindow(taskId = '') {
  if (process.env.VITEST)
    return

  try {
    const { baseUrl, getElectronMainDirname, load, withHashRoute } = await import('../../../libs/electron/location')
    const { createWindowService } = await import('../../../services/electron/window')
    if (!taskWindow || taskWindow.isDestroyed()) {
      taskWindow = new BrowserWindow({
        title: 'Lumi Claude Code Task',
        width: 560,
        height: 680,
        minWidth: 420,
        minHeight: 420,
        show: false,
        alwaysOnTop: true,
        resizable: true,
        webPreferences: {
          preload: join(getElectronMainDirname(), '../preload/index.mjs'),
          sandbox: false,
        },
        frame: false,
        transparent: true,
        hasShadow: false,
      })

      taskWindow.on('ready-to-show', () => taskWindow?.show())
      taskWindow.on('closed', () => {
        taskWindow = undefined
      })
      taskWindow.webContents.setWindowOpenHandler((details) => {
        shell.openExternal(details.url)
        return { action: 'deny' }
      })

      const context = createElectronEventaContext(ipcMain, taskWindow).context
      createClaudeCodeAgentService({ context })
      createWindowService({ context, window: taskWindow })
    }

    const rendererBase = baseUrl(resolve(getElectronMainDirname(), '..', 'renderer'))
    const route = taskId ? `/claude-task?taskId=${encodeURIComponent(taskId)}` : '/claude-task'
    await load(taskWindow, withHashRoute(rendererBase, route))
    taskWindow.show()
    taskWindow.focus()
  }
  catch (error) {
    appendTaskEvent(taskId, 'error', `打开任务窗口失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function coerceTaskType(value: unknown, fallback: AgentTaskType): AgentTaskType {
  return AGENT_TASK_TYPES.includes(value as AgentTaskType) ? value as AgentTaskType : fallback
}

function coercePermissionMode(value: unknown, fallback: AgentPermissionMode): AgentPermissionMode {
  return AGENT_PERMISSION_MODES.includes(value as AgentPermissionMode) ? value as AgentPermissionMode : fallback
}

async function createClaudeTask(payload: ElectronClaudeCodeAgentRunPayload): Promise<ClaudeCodeTask> {
  const settings = resolveTaskSettings(payload.settings)
  if (!settings.enabled)
    throw new Error('Claude Code delegation is disabled.')
  if (!settings.lumiSandboxRoot)
    throw new Error('LumiSandbox root is not configured.')

  const parentLog = await resolveParentTaskLog(settings, payload)
  if ((payload.continueFromTaskId || payload.continueFromTaskName) && !parentLog) {
    const target = payload.continueFromTaskId || payload.continueFromTaskName
    throw new Error(`没有找到可继续的 Claude Code 任务：${target}`)
  }

  const detectedRoute = routeAgentTask(payload.userRequest, settings)
  const explicitTaskType = AGENT_TASK_TYPES.includes(payload.taskType as AgentTaskType)
    ? payload.taskType as AgentTaskType
    : undefined
  const route: AgentTaskRoute = parentLog
    ? {
        shouldDelegate: true,
        taskType: parentLog.taskType,
        executor: 'claude_code',
        permissionMode: 'sandbox_auto',
        targetSubdir: parentLog.taskType === 'web_project' || parentLog.taskType === 'coding_help' ? 'projects' : 'exports',
        reason: 'continue_previous_task',
      }
    : detectedRoute.shouldDelegate || !explicitTaskType
    ? detectedRoute
    : {
        shouldDelegate: true,
        taskType: explicitTaskType,
        executor: 'claude_code',
        permissionMode: explicitTaskType === 'self_project_improvement' ? 'self_project_proposal' : 'sandbox_auto',
        targetSubdir: explicitTaskType === 'self_project_improvement'
          ? 'exports'
          : (explicitTaskType === 'web_project' || explicitTaskType === 'coding_help' ? 'projects' : 'exports'),
        reason: 'explicit_task_type',
      }
  if (!route.shouldDelegate)
    throw new Error('This looks like ordinary chat. Claude Code delegation was not started.')

  const taskType = parentLog ? parentLog.taskType : coerceTaskType(payload.taskType, route.taskType)
  let permissionMode = coercePermissionMode(payload.permissionMode, route.permissionMode)
  const sandboxRoot = await ensureRealDirectory(settings.lumiSandboxRoot)
  const targetSubdir = route.targetSubdir || (taskType === 'self_project_improvement' ? 'exports' : 'projects')
  const targetName = parentLog?.cwd
    ? basename(parentLog.cwd)
    : await createUniqueTargetName(sandboxRoot, targetSubdir, deriveTargetSlug(payload.userRequest, taskType, payload.targetName))
  const cwd = parentLog?.cwd && await isInsideRoot(sandboxRoot, parentLog.cwd)
    ? parentLog.cwd
    : await resolveSafePath(sandboxRoot, join(targetSubdir, targetName))

  if (
    taskType !== 'self_project_improvement'
    && permissionMode !== 'blocked'
    && permissionMode !== 'self_project_write_once'
    && await isInsideRoot(sandboxRoot, cwd)
  ) {
    permissionMode = 'sandbox_auto'
  }

  if (permissionMode === 'sandbox_auto')
    await assertInsideSandbox(settings, cwd)
  if (permissionMode === 'self_project_proposal' && !await isInsideRoot(sandboxRoot, cwd))
    throw new Error('Self project proposal output must still be written inside LumiSandbox.')

  const condaEnv = payload.condaEnv || settings.defaultCondaEnv
  if (condaEnv) {
    if (condaEnv === 'base')
      throw new Error('Using conda base is forbidden for delegated tasks.')
    if (!settings.allowedCondaEnvs.includes(condaEnv))
      throw new Error(`Conda env "${condaEnv}" is not in allowedCondaEnvs.`)
  }

  await mkdir(cwd, { recursive: true })
  const allowedPaths = [cwd]
  const deniedPaths = [
    ...settings.forbiddenPaths,
    ...settings.selfProjectRoots,
    '.env',
    'SSH keys',
    'tokens',
    'browser profiles',
    'system config',
  ]
  const requestForPrompt = parentLog
    ? buildContinuationRequest(payload.userRequest, parentLog)
    : payload.userRequest
  const generatedPrompt = buildClaudeCodePrompt({
    userRequest: requestForPrompt,
    taskType,
    cwd,
    permissionMode,
    allowedPaths,
    deniedPaths,
  })
  return {
    id: parentLog?.taskId || createTaskId(),
    displayName: createTaskDisplayName(payload, taskType, parentLog),
    parentTaskId: parentLog?.parentTaskId,
    initialUserRequest: parentLog?.initialUserRequest || parentLog?.userRequest || payload.userRequest,
    latestUserRequest: payload.userRequest,
    userRequest: payload.userRequest,
    generatedPrompt,
    taskType,
    cwd,
    permissionMode,
    allowedPaths,
    deniedPaths,
    condaEnv,
    timeoutMs: settings.maxTaskTimeoutMs,
    createdAt: parentLog?.createdAt || new Date().toISOString(),
  }
}

async function scanFiles(root: string): Promise<Map<string, FileSnapshotEntry>> {
  const out = new Map<string, FileSnapshotEntry>()
  async function visit(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules')
        continue
      const full = join(dir, entry.name)
      if (isSecretLikePath(full))
        continue
      if (entry.isSymbolicLink())
        continue
      if (entry.isDirectory()) {
        await visit(full)
        continue
      }
      if (!entry.isFile())
        continue
      const info = await stat(full).catch(() => undefined)
      if (!info)
        continue
      const rel = relative(root, full).replace(/\\/g, '/')
      out.set(rel, { rel, size: info.size, mtimeMs: info.mtimeMs })
    }
  }
  await visit(root)
  return out
}

function diffSnapshots(before: Map<string, FileSnapshotEntry>, after: Map<string, FileSnapshotEntry>) {
  const createdFiles: string[] = []
  const modifiedFiles: string[] = []
  const deletedFiles: string[] = []

  for (const [rel, next] of after.entries()) {
    const prev = before.get(rel)
    if (!prev) {
      createdFiles.push(rel)
      continue
    }
    if (prev.size !== next.size || Math.round(prev.mtimeMs) !== Math.round(next.mtimeMs))
      modifiedFiles.push(rel)
  }

  for (const rel of before.keys()) {
    if (!after.has(rel))
      deletedFiles.push(rel)
  }

  return {
    createdFiles,
    modifiedFiles,
    deletedFiles,
    changedFiles: [...new Set([...createdFiles, ...modifiedFiles, ...deletedFiles])],
  }
}

function logsRoot(settings: AgentSettings) {
  if (settings.lumiSandboxRoot)
    return join(settings.lumiSandboxRoot, 'agent-logs')
  return join(app.getPath('userData'), 'lumi-agent-logs')
}

function tailText(text: string, max = 4000) {
  return text.length > max ? text.slice(-max) : text
}

function classifyClaudeFailure(input: { status?: string, error?: string, stderr?: string, exitCode?: number }) {
  const text = `${input.status || ''}\n${input.error || ''}\n${input.stderr || ''}`.toLowerCase()
  if (input.status === 'timeout' || /timed? out|timeout/.test(text))
    return 'timeout'
  if (/enoent|not found|cannot find|不是内部或外部命令/.test(text))
    return 'command_not_found'
  if (/permission|denied|unauthorized|not trusted|trust/.test(text))
    return 'permission_or_trust'
  if (/no stdin data|stdin/.test(text))
    return 'stdin_or_prompt_delivery'
  if (/abort|err_aborted|connection closed|websocket/.test(text))
    return 'process_or_connection_aborted'
  if (typeof input.exitCode === 'number' && input.exitCode !== 0)
    return 'non_zero_exit'
  return input.status === 'success' ? 'none' : 'unknown_failure'
}

async function writeAgentLog(settings: AgentSettings, task: ClaudeCodeTask, result: ClaudeCodeResult): Promise<AgentTaskLog> {
  const root = await ensureRealDirectory(logsRoot(settings))
  const previous = taskLogs.get(task.id) ?? await readAgentLog(settings, task.id).catch(() => undefined)
  const previousRuns = previous?.runs ?? []
  const diagnostics = {
    failureKind: classifyClaudeFailure(result),
    cwd: task.cwd,
    permissionMode: task.permissionMode,
    timeoutMs: task.timeoutMs,
    command: (result as any).diagnostics?.command,
    args: (result as any).diagnostics?.args,
    shell: (result as any).diagnostics?.shell,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    durationMs: Date.parse(result.endedAt || '') - Date.parse(result.startedAt || ''),
    stdoutTail: tailText(result.stdout || '', 4000),
    stderrTail: tailText(result.stderr || '', 4000),
    error: result.error,
    exitCode: result.exitCode,
    changedFilesCount: result.changedFiles.length,
    createdFilesCount: result.createdFiles.length,
    modifiedFilesCount: result.modifiedFiles.length,
    deletedFilesCount: result.deletedFiles.length,
  }
  const currentRun = {
    runId: `${task.id}-${Date.now().toString(36)}`,
    userRequest: task.userRequest,
    generatedPrompt: task.generatedPrompt,
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    changedFiles: result.changedFiles,
    createdFiles: result.createdFiles,
    modifiedFiles: result.modifiedFiles,
    deletedFiles: result.deletedFiles,
    exitCode: result.exitCode,
    error: result.error,
    diagnostics,
  }
  const displayName = previous?.displayName || task.displayName || deriveReadableTaskName(task.userRequest, task.taskType)
  const mergedChangedFiles = [...new Set([...(previous?.changedFiles ?? []), ...result.changedFiles])]
  const log = normalizeAgentLog({
    ...task,
    ...result,
    taskId: task.id,
    displayName,
    createdAt: previous?.createdAt || task.createdAt,
    initialUserRequest: previous?.initialUserRequest || task.initialUserRequest || previous?.userRequest || task.userRequest,
    latestUserRequest: task.userRequest,
    userRequest: previous?.userRequest || task.initialUserRequest || task.userRequest,
    generatedPrompt: task.generatedPrompt,
    changedFiles: mergedChangedFiles,
    createdFiles: [...new Set([...(previous?.createdFiles ?? []), ...result.createdFiles])],
    modifiedFiles: [...new Set([...(previous?.modifiedFiles ?? []), ...result.modifiedFiles])],
    deletedFiles: [...new Set([...(previous?.deletedFiles ?? []), ...result.deletedFiles])],
    summary: createTaskSummary({ ...task, displayName }, { ...result, changedFiles: mergedChangedFiles }),
    keywords: createTaskKeywords({ ...task, displayName }),
    runs: [...previousRuns, currentRun],
    diagnostics,
  } as AgentTaskLog)
  await writeFile(join(root, `${task.id}.json`), JSON.stringify(log, null, 2), 'utf8')
  return log
}

async function readAgentLog(settings: AgentSettings, taskId: string): Promise<AgentTaskLog | undefined> {
  const root = await ensureRealDirectory(logsRoot(settings))
  const file = join(root, `${taskId}.json`)
  try {
    await access(file, constants.R_OK)
    return normalizeAgentLog(JSON.parse(await readFile(file, 'utf8')) as AgentTaskLog)
  }
  catch {
    return undefined
  }
}

async function listAgentLogs(settings: AgentSettings, limit = 20): Promise<AgentTaskLog[]> {
  const root = await ensureRealDirectory(logsRoot(settings))
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const files = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => join(root, entry.name))
  const stats = await Promise.all(files.map(async file => ({ file, stat: await stat(file).catch(() => undefined) })))
  const sorted = stats
    .filter(item => item.stat)
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
    .slice(0, Math.max(1, Math.min(100, limit)))

  const logs: AgentTaskLog[] = []
  for (const item of sorted) {
    try {
      logs.push(normalizeAgentLog(JSON.parse(await readFile(item.file, 'utf8')) as AgentTaskLog))
    }
    catch {}
  }
  const ids = new Set(logs.map(log => log.taskId))
  return logs.filter(log => !log.parentTaskId || !ids.has(log.parentTaskId))
}

async function resolveParentTaskLog(settings: AgentSettings, payload: ElectronClaudeCodeAgentRunPayload): Promise<AgentTaskLog | undefined> {
  if (payload.continueFromTaskId) {
    const cached = taskLogs.get(payload.continueFromTaskId)
    if (cached)
      return normalizeAgentLog(cached)
    return readAgentLog(settings, payload.continueFromTaskId)
  }

  const name = payload.continueFromTaskName?.trim().toLowerCase()
  if (!name)
    return undefined

  const logs = await listAgentLogs(settings, 100)
  const queryTokens = tokenizeTaskQuery(name)
  let best: { log: AgentTaskLog, score: number } | undefined
  for (const log of logs) {
    const haystack = [
      log.displayName,
      log.summary,
      log.userRequest,
      log.latestUserRequest,
      log.cwd,
      ...(log.keywords ?? []),
    ].filter(Boolean).join(' ').toLowerCase()
    let score = 0
    if ((log.displayName || '').toLowerCase() === name)
      score += 100
    if ((log.displayName || '').toLowerCase().includes(name) || name.includes((log.displayName || '').toLowerCase()))
      score += 60
    if (haystack.includes(name))
      score += 35
    for (const token of queryTokens) {
      if (haystack.includes(token))
        score += 8
    }
    if (score > (best?.score ?? 0))
      best = { log, score }
  }
  return best && best.score >= 16 ? best.log : undefined
}

function buildContinuationRequest(userRequest: string, parentLog: AgentTaskLog) {
  const changedFiles = parentLog.changedFiles?.slice(0, 40) ?? []
  const latestRun = parentLog.runs?.at(-1)
  return [
    'Continue the previous Lumi Claude Code task in the same working directory.',
    '',
    `Previous task name: ${parentLog.displayName || parentLog.taskType}`,
    `Previous task id: ${parentLog.taskId}`,
    `Previous working directory: ${parentLog.cwd}`,
    `Previous status: ${parentLog.status}`,
    '',
    'Previous user request:',
    parentLog.userRequest,
    '',
    changedFiles.length > 0 ? 'Previously changed files:' : '',
    ...changedFiles.map(file => `- ${file}`),
    '',
    (latestRun?.stdout || parentLog.stdout) ? 'Previous stdout tail:' : '',
    (latestRun?.stdout || parentLog.stdout) ? (latestRun?.stdout || parentLog.stdout).slice(-2000) : '',
    '',
    (latestRun?.stderr || parentLog.stderr) ? 'Previous stderr tail:' : '',
    (latestRun?.stderr || parentLog.stderr) ? (latestRun?.stderr || parentLog.stderr).slice(-1200) : '',
    '',
    'New follow-up request:',
    userRequest,
    '',
    'Continue from the existing files. Do not recreate the project from scratch unless the follow-up explicitly asks for a rewrite.',
  ].filter(Boolean).join('\n')
}

async function runClaudeTask(payload: ElectronClaudeCodeAgentRunPayload): Promise<ElectronClaudeCodeAgentResult> {
  const settings = resolveTaskSettings(payload.settings)
  const task = await createClaudeTask(payload)
  if (runningTasks.has(task.id) || pendingPermissionTasks.has(task.id))
    throw new Error(`任务正在运行中，不能同时继续：${task.displayName || task.id}`)
  appendTaskEvent(task.id, 'created', `任务已创建：${task.taskType}`, {
    displayName: task.displayName,
    parentTaskId: task.parentTaskId,
    cwd: task.cwd,
    permissionMode: task.permissionMode,
    userRequest: task.userRequest,
    generatedPrompt: task.generatedPrompt,
    allowedPaths: task.allowedPaths,
    deniedPaths: task.deniedPaths,
  })
  void openClaudeTaskWindow(task.id)

  if (requiresManualPermission(task.permissionMode)) {
    pendingPermissionTasks.set(task.id, { settings, task })
    appendTaskEvent(task.id, 'permission_request', `需要确认权限：${task.permissionMode}`, {
      permissionMode: task.permissionMode,
      cwd: task.cwd,
      reason: task.permissionMode === 'blocked'
        ? '该任务被权限策略阻止。'
        : '该任务超出了沙盒自动执行范围，需要你在任务窗口中确认。',
    })
    return {
      taskId: task.id,
      status: 'running',
      stdout: '',
      stderr: '',
      changedFiles: [],
      createdFiles: [],
      modifiedFiles: [],
      deletedFiles: [],
      startedAt: new Date().toISOString(),
      endedAt: '',
      task,
    }
  }

  if (payload.detached) {
    void executeClaudeTask(settings, task).catch((error) => {
      appendTaskEvent(task.id, 'error', error instanceof Error ? error.message : String(error))
    })
    return {
      taskId: task.id,
      status: 'running',
      stdout: '',
      stderr: '',
      changedFiles: [],
      createdFiles: [],
      modifiedFiles: [],
      deletedFiles: [],
      startedAt: new Date().toISOString(),
      endedAt: '',
      task,
    }
  }

  return executeClaudeTask(settings, task)
}

async function executeClaudeTask(settings: AgentSettings, task: ClaudeCodeTask): Promise<ElectronClaudeCodeAgentResult> {
  const before = await scanFiles(task.cwd)
  let commandSpec: ResolvedCommand
  try {
    commandSpec = await resolveExecutableCommand(settings.claudeCommand)
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const result: ClaudeCodeResult = {
      taskId: task.id,
      status: 'failed',
      stdout: '',
      stderr: '',
      changedFiles: [],
      createdFiles: [],
      modifiedFiles: [],
      deletedFiles: [],
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      error: message,
      diagnostics: {
        command: settings.claudeCommand,
        args: [],
        shell: undefined,
        resolveCommandFailed: true,
      },
    }
    const log = await writeAgentLog(settings, task, result)
    taskLogs.set(task.id, log)
    appendTaskEvent(task.id, 'completed', `任务失败：${message}`, {
      status: result.status,
      error: message,
    })
    return {
      ...result,
      task,
      log,
    }
  }
  const startedAt = new Date().toISOString()
  let stdout = ''
  let stderr = ''
  let status: ClaudeCodeResult['status'] = 'failed'
  let exitCode: number | undefined
  let errorText = ''

  const result = await new Promise<ClaudeCodeResult>((resolveResult) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    async function finish(code?: number | null, signal?: NodeJS.Signals | null) {
      if (settled)
        return
      settled = true
      if (timer)
        clearTimeout(timer)
      runningTasks.delete(task.id)
      exitCode = code ?? undefined
      if (!errorText && signal)
        errorText = `Process ended by signal ${signal}.`
      if (status !== 'timeout' && status !== 'cancelled')
        status = code === 0 ? 'success' : 'failed'
      const after = await scanFiles(task.cwd)
      const diff = diffSnapshots(before, after)
      const finalResult: ClaudeCodeResult = {
        taskId: task.id,
        status,
        stdout,
        stderr,
        ...diff,
        startedAt,
        endedAt: new Date().toISOString(),
        exitCode,
        error: errorText || undefined,
        diagnostics: {
          command: commandSpec.command,
          args: claudeArgs,
          shell: commandSpec.shell,
        },
      }
      appendTaskEvent(task.id, 'completed', `任务${status === 'success' ? '完成' : '结束'}：${status}`, {
        status,
        exitCode,
        error: finalResult.error,
        changedFiles: diff.changedFiles,
      })
      resolveResult(finalResult)
    }

    const claudeArgs = task.permissionMode === 'sandbox_auto'
      ? ['--dangerously-skip-permissions', '--print']
      : ['--print']
    appendTaskEvent(task.id, 'started', `Claude Code 已启动：${task.cwd}`, {
      permissionMode: task.permissionMode,
      args: claudeArgs,
      input: 'stdin',
    })
    const child = spawn(commandSpec.command, claudeArgs, {
      cwd: task.cwd,
      windowsHide: true,
      shell: commandSpec.shell,
      env: {
        ...process.env,
        LUMI_AGENT_TASK_ID: task.id,
      },
    })
    runningTasks.set(task.id, child)
    child.stdin.write(task.generatedPrompt)
    child.stdin.end()
    appendTaskEvent(task.id, 'started', 'Lumi 已通过 stdin 发送完整任务 Prompt。', {
      promptLength: task.generatedPrompt.length,
    })

    timer = setTimeout(() => {
      status = 'timeout'
      errorText = `Claude Code task timed out after ${task.timeoutMs}ms.`
      child.kill('SIGTERM')
    }, task.timeoutMs)

    child.stdout.on('data', (data) => {
      const text = String(data)
      stdout += text
      appendTaskEvent(task.id, 'stdout', text)
    })
    child.stderr.on('data', (data) => {
      const text = String(data)
      stderr += text
      appendTaskEvent(task.id, 'stderr', text)
    })
    child.on('error', (error) => {
      status = 'failed'
      errorText = error.message
      void finish(undefined, undefined)
    })
    child.on('close', (code, signal) => void finish(code, signal))
  })

  const log = await writeAgentLog(settings, task, result)
  taskLogs.set(task.id, log)
  return {
    ...result,
    task,
    log,
  }
}

async function cancelClaudeTask(taskId: string) {
  if (pendingPermissionTasks.has(taskId)) {
    await rejectTaskPermission(taskId)
    return
  }
  const child = runningTasks.get(taskId)
  if (!child)
    return
  runningTasks.delete(taskId)
  appendTaskEvent(taskId, 'completed', '任务已取消', { status: 'cancelled' })
  child.kill('SIGTERM')
}

async function approveTaskPermission(taskId: string) {
  const pending = pendingPermissionTasks.get(taskId)
  if (!pending)
    return
  pendingPermissionTasks.delete(taskId)
  const task: ClaudeCodeTask = {
    ...pending.task,
    permissionMode: 'sandbox_auto',
    generatedPrompt: buildClaudeCodePrompt({
      userRequest: pending.task.userRequest,
      taskType: pending.task.taskType,
      cwd: pending.task.cwd,
      permissionMode: 'sandbox_auto',
      allowedPaths: pending.task.allowedPaths,
      deniedPaths: pending.task.deniedPaths,
    }),
  }
  appendTaskEvent(taskId, 'permission_decision', '已批准：改为沙盒自动执行。', {
    decision: 'approved',
    permissionMode: task.permissionMode,
  })
  void executeClaudeTask(pending.settings, task).catch((error) => {
    appendTaskEvent(taskId, 'error', error instanceof Error ? error.message : String(error))
  })
}

async function rejectTaskPermission(taskId: string) {
  const pending = pendingPermissionTasks.get(taskId)
  if (!pending)
    return
  pendingPermissionTasks.delete(taskId)
  const now = new Date().toISOString()
  const result: ClaudeCodeResult = {
    taskId,
    status: 'cancelled',
    stdout: '',
    stderr: '',
    changedFiles: [],
    createdFiles: [],
    modifiedFiles: [],
    deletedFiles: [],
    startedAt: now,
    endedAt: now,
    error: 'User rejected permission request.',
  }
  const log = await writeAgentLog(pending.settings, pending.task, result)
  taskLogs.set(taskId, log)
  appendTaskEvent(taskId, 'permission_decision', '已拒绝权限请求。', {
    decision: 'rejected',
  })
  appendTaskEvent(taskId, 'completed', '任务已取消', { status: 'cancelled' })
}

async function getTaskSnapshot(settings: AgentSettings, taskId?: string) {
  const id = taskId || latestTaskId
  if (!id) {
    return {
      events: [],
      running: false,
    }
  }
  return {
    taskId: id,
    events: taskEvents.get(id) ?? [],
    log: taskLogs.get(id) ?? await readAgentLog(settings, id),
    running: runningTasks.has(id),
  }
}

export function createClaudeCodeAgentService(params: {
  context: ReturnType<typeof createContext>['context']
}) {
  defineInvokeHandler(params.context, electronClaudeCodeAgentRunTask, async payload => runClaudeTask(payload))
  defineInvokeHandler(params.context, electronClaudeCodeAgentCancelTask, async ({ taskId }) => cancelClaudeTask(taskId))
  defineInvokeHandler(params.context, electronClaudeCodeAgentApproveTaskPermission, async ({ taskId }) => approveTaskPermission(taskId))
  defineInvokeHandler(params.context, electronClaudeCodeAgentRejectTaskPermission, async ({ taskId }) => rejectTaskPermission(taskId))
  defineInvokeHandler(params.context, electronClaudeCodeAgentGetLog, async ({ taskId, settings }: any) => readAgentLog(resolveTaskSettings(settings), taskId))
  defineInvokeHandler(params.context, electronClaudeCodeAgentListLogs, async (payload: any) => listAgentLogs(resolveTaskSettings(payload?.settings), payload?.limit ?? 20))
  defineInvokeHandler(params.context, electronClaudeCodeAgentOpenTaskWindow, async (payload: any) => {
    if (payload?.settings)
      resolveTaskSettings(payload.settings)
    await openClaudeTaskWindow(payload?.taskId || '')
  })
  defineInvokeHandler(params.context, electronClaudeCodeAgentGetTaskSnapshot, async (payload: any) => getTaskSnapshot(resolveTaskSettings(payload?.settings), payload?.taskId))
  defineInvokeHandler(params.context, electronClaudeCodeAgentPickCommand, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 Claude Code 命令',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [
            { name: 'Claude Code 命令', extensions: ['cmd', 'exe', 'bat'] },
            { name: 'All files', extensions: ['*'] },
          ]
        : [{ name: 'All files', extensions: ['*'] }],
    })
    return { path: result.canceled ? undefined : result.filePaths[0] }
  })
  defineInvokeHandler(params.context, electronClaudeCodeAgentSearchCommand, async (payload: any) => {
    const command = String(payload?.command || 'claude').trim() || 'claude'
    try {
      const candidates = await findExecutableCommandCandidates(command)
      return {
        path: candidates[0],
        candidates,
      }
    }
    catch (error) {
      return {
        candidates: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
}

export const __testing = {
  classifyPath,
  isInsideResolvedRoot,
  resolveSafePath,
  scanFiles,
  diffSnapshots,
  normalizeSettings,
  findExecutableCommandCandidates,
  resolveExecutableCommand,
  createClaudeTask,
  listAgentLogs,
  runClaudeTask,
  cancelClaudeTask,
}



