export const AGENT_TASK_TYPES = [
  'web_project',
  'markdown_edit',
  'document_generation',
  'document_edit',
  'note_review',
  'file_analysis',
  'coding_help',
  'self_project_improvement',
  'unknown',
] as const

export type AgentTaskType = typeof AGENT_TASK_TYPES[number]

export const AGENT_PERMISSION_MODES = [
  'read_only',
  'sandbox_auto',
  'trusted_project_assisted',
  'self_project_proposal',
  'self_project_write_once',
  'blocked',
] as const

export type AgentPermissionMode = typeof AGENT_PERMISSION_MODES[number]

export interface AgentSettings {
  enabled: boolean
  claudeCommand: string
  lumiSandboxRoot: string
  trustedProjects: string[]
  selfProjectRoots: string[]
  forbiddenPaths: string[]
  defaultPermissionMode: AgentPermissionMode
  sandboxAutoApprove: boolean
  maxTaskTimeoutMs: number
  allowedCondaEnvs: string[]
  defaultCondaEnv?: string
}

export interface AgentTaskRoute {
  shouldDelegate: boolean
  taskType: AgentTaskType
  executor: 'claude_code' | 'none'
  permissionMode: AgentPermissionMode
  targetSubdir: 'projects' | 'exports' | ''
  reason: string
}

export interface ClaudeCodeTask {
  id: string
  displayName?: string
  parentTaskId?: string
  initialUserRequest?: string
  latestUserRequest?: string
  summary?: string
  keywords?: string[]
  runs?: ClaudeCodeTaskRun[]
  userRequest: string
  generatedPrompt: string
  taskType: AgentTaskType
  cwd: string
  permissionMode: AgentPermissionMode
  allowedPaths: string[]
  deniedPaths: string[]
  condaEnv?: string
  timeoutMs: number
  createdAt: string
}

export interface ClaudeCodeTaskRun {
  runId: string
  userRequest: string
  generatedPrompt: string
  startedAt: string
  endedAt: string
  status: ClaudeCodeResult['status']
  stdout: string
  stderr: string
  changedFiles: string[]
  createdFiles: string[]
  modifiedFiles: string[]
  deletedFiles: string[]
  exitCode?: number
  error?: string
  diagnostics?: Record<string, any>
}

export interface ClaudeCodeResult {
  taskId: string
  status: 'running' | 'success' | 'failed' | 'cancelled' | 'timeout'
  stdout: string
  stderr: string
  changedFiles: string[]
  createdFiles: string[]
  modifiedFiles: string[]
  deletedFiles: string[]
  startedAt: string
  endedAt: string
  exitCode?: number
  error?: string
  diagnostics?: Record<string, any>
}

export interface AgentTaskLog extends ClaudeCodeTask, ClaudeCodeResult {
  taskId: string
  diagnostics?: Record<string, any>
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  enabled: false,
  claudeCommand: 'claude',
  lumiSandboxRoot: '',
  trustedProjects: [],
  selfProjectRoots: [],
  forbiddenPaths: [],
  defaultPermissionMode: 'read_only',
  sandboxAutoApprove: false,
  maxTaskTimeoutMs: 300000,
  allowedCondaEnvs: [],
}

function hasAny(text: string, patterns: Array<string | RegExp>) {
  return patterns.some((pattern) => {
    if (typeof pattern === 'string')
      return text.includes(pattern.toLowerCase())
    return pattern.test(text)
  })
}

export function routeAgentTask(userRequest: string, settings: Partial<AgentSettings> = {}): AgentTaskRoute {
  const text = userRequest.trim().toLowerCase()
  const sandboxConfigured = Boolean(settings.lumiSandboxRoot?.trim())

  if (!text) {
    return {
      shouldDelegate: false,
      taskType: 'unknown',
      executor: 'none',
      permissionMode: 'read_only',
      targetSubdir: '',
      reason: 'empty_request',
    }
  }

  if (hasAny(text, [
    '优化你的记忆系统',
    '修改 lumi 的 prompt',
    '修改lumi的prompt',
    '改你的用户画像系统',
    '改你的主动性逻辑',
    '优化你自己的代码',
    '改 airi-lumi 源码',
    '改airi-lumi源码',
    '改 airi 源码',
    '改你的源码',
    '修改你的代码',
  ])) {
    return {
      shouldDelegate: true,
      taskType: 'self_project_improvement',
      executor: 'claude_code',
      permissionMode: 'self_project_proposal',
      targetSubdir: '',
      reason: 'self_project_request',
    }
  }

  if (hasAny(text, ['做一个网页', '生成一个 html', 'html 页面', '番茄钟网页', 'todo 页面', '小游戏网页', '个人主页', '前端小工具', /做.*网页/])) {
    return {
      shouldDelegate: true,
      taskType: 'web_project',
      executor: 'claude_code',
      permissionMode: sandboxConfigured ? 'sandbox_auto' : 'read_only',
      targetSubdir: 'projects',
      reason: sandboxConfigured ? 'web_project_in_sandbox' : 'sandbox_not_configured',
    }
  }

  if (hasAny(text, ['修改这个 md', '改这个 md', '整理 markdown', '重排笔记', '改这个 readme', '整理成 md', 'markdown'])) {
    return {
      shouldDelegate: true,
      taskType: 'markdown_edit',
      executor: 'claude_code',
      permissionMode: sandboxConfigured ? 'sandbox_auto' : 'read_only',
      targetSubdir: 'exports',
      reason: sandboxConfigured ? 'markdown_edit' : 'path_unknown_or_sandbox_not_configured',
    }
  }

  if (hasAny(text, ['生成一份文档', '写一个报告', '生成 docx', '总结文档', '做成文档', '文档草稿'])) {
    return {
      shouldDelegate: true,
      taskType: 'document_generation',
      executor: 'claude_code',
      permissionMode: sandboxConfigured ? 'sandbox_auto' : 'read_only',
      targetSubdir: 'exports',
      reason: sandboxConfigured ? 'document_generation' : 'sandbox_not_configured',
    }
  }

  if (hasAny(text, ['修改 docx', '改这个 word', '整理这份文档', '文档重新排版', '重新排版文档'])) {
    return {
      shouldDelegate: true,
      taskType: 'document_edit',
      executor: 'claude_code',
      permissionMode: sandboxConfigured ? 'sandbox_auto' : 'read_only',
      targetSubdir: 'exports',
      reason: sandboxConfigured ? 'document_edit_copy_to_exports' : 'sandbox_not_configured',
    }
  }

  if (hasAny(text, ['查看我的笔记', '总结我的笔记', '笔记里关于', '整理学习笔记', '整理笔记'])) {
    return {
      shouldDelegate: true,
      taskType: 'note_review',
      executor: 'claude_code',
      permissionMode: 'read_only',
      targetSubdir: 'exports',
      reason: 'note_review_read_only',
    }
  }

  if (hasAny(text, ['看看这个文件', '分析这个文件', '总结这个文件', '找错误', '检查格式'])) {
    return {
      shouldDelegate: true,
      taskType: 'file_analysis',
      executor: 'claude_code',
      permissionMode: 'read_only',
      targetSubdir: '',
      reason: 'file_analysis_read_only',
    }
  }

  if (hasAny(text, ['帮我写个脚本', '修这个小项目', '运行测试', '看这个报错', '帮我写代码', '修这个项目'])) {
    return {
      shouldDelegate: true,
      taskType: 'coding_help',
      executor: 'claude_code',
      permissionMode: sandboxConfigured ? 'sandbox_auto' : 'read_only',
      targetSubdir: 'projects',
      reason: sandboxConfigured ? 'coding_help' : 'sandbox_not_configured',
    }
  }

  return {
    shouldDelegate: false,
    taskType: 'unknown',
    executor: 'none',
    permissionMode: 'read_only',
    targetSubdir: '',
    reason: 'ordinary_chat',
  }
}

export function buildClaudeCodePrompt(params: {
  userRequest: string
  taskType: AgentTaskType
  cwd: string
  permissionMode: AgentPermissionMode
  allowedPaths: string[]
  deniedPaths: string[]
}) {
  const taskSpecific = createTaskSpecificPrompt(params.taskType)
  return [
    'You are operating as an external coding/document agent for Lumi.',
    '',
    'User request:',
    params.userRequest,
    '',
    `Task type: ${params.taskType}`,
    `Permission mode: ${params.permissionMode}`,
    `Working directory: ${params.cwd}`,
    '',
    'Allowed paths:',
    ...params.allowedPaths.map(path => `- ${path}`),
    '',
    'Denied paths:',
    ...params.deniedPaths.map(path => `- ${path}`),
    '',
    'Rules:',
    '- Only work inside the allowed working directory.',
    '- Do not access or modify files outside allowed paths.',
    '- Do not modify Lumi/AIRI source code unless explicitly instructed in this task.',
    '- Do not read secrets, .env files, SSH keys, tokens, browser profiles, or system config.',
    '- Do not run destructive commands.',
    '- Do not run git push, npm publish, global installs, curl | bash, or powershell iex.',
    '- If the task requires an unsafe action, stop and explain why.',
    '- At the end, summarize created/modified/deleted files and how to verify the result.',
    '',
    taskSpecific,
  ].join('\n')
}

function createTaskSpecificPrompt(taskType: AgentTaskType) {
  if (taskType === 'web_project') {
    return [
      'Web project requirements:',
      '- Prefer plain HTML/CSS/JS and avoid dependencies unless necessary.',
      '- Default output files: index.html, style.css, main.js, README.md.',
      '- Keep the project self-contained and easy to open locally.',
    ].join('\n')
  }
  if (taskType === 'markdown_edit') {
    return [
      'Markdown edit requirements:',
      '- Preserve the original meaning.',
      '- Improve structure, headings, spacing, and readability.',
      '- If the source file is outside the sandbox, write the edited copy to exports instead of overwriting it.',
    ].join('\n')
  }
  if (taskType === 'document_generation') {
    return [
      'Document generation requirements:',
      '- Generate a Markdown source document first.',
      '- If docx is required, create convertible content or a local conversion script.',
      '- Write outputs under LumiSandbox/exports.',
    ].join('\n')
  }
  if (taskType === 'document_edit') {
    return [
      'Document edit requirements:',
      '- Do not overwrite non-sandbox original files.',
      '- Produce a revised copy under exports unless the file is explicitly inside the sandbox.',
      '- Summarize layout/content changes.',
    ].join('\n')
  }
  if (taskType === 'note_review') {
    return [
      'Note review requirements:',
      '- Read-only analysis by default.',
      '- Output summary, key points, todos, and relevant citations.',
      '- Do not modify the original notes.',
    ].join('\n')
  }
  if (taskType === 'self_project_improvement') {
    return [
      'Self project improvement requirements:',
      '- Do not directly modify files.',
      '- Produce a proposal only.',
      '- If code changes are needed, output a patch proposal with risks, affected modules, and rollback plan.',
    ].join('\n')
  }
  return 'General task requirements: stay within the declared permission boundary and summarize the result clearly.'
}
