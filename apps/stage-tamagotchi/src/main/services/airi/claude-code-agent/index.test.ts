import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
  },
  BrowserWindow: vi.fn(() => ({
    isDestroyed: () => false,
    on: vi.fn(),
    webContents: {
      setWindowOpenHandler: vi.fn(),
    },
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  })),
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  },
  ipcMain: {},
  shell: {
    openExternal: vi.fn(),
  },
}))

describe('claude code agent path security', async () => {
  const { __testing } = await import('./index')

  it('rejects ../ escapes from the sandbox root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumi-agent-root-'))
    await expect(__testing.resolveSafePath(root, '../outside.txt')).rejects.toThrow(/escapes allowed root/)
  })

  it('keeps normalized Windows-like child paths inside the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumi-agent-root-'))
    const child = await __testing.resolveSafePath(root, 'projects/../projects/demo')
    expect(__testing.isInsideResolvedRoot(resolve(root), child)).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('rejects symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumi-agent-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'lumi-agent-outside-'))
    await writeFile(join(outside, 'note.txt'), 'secret')
    await symlink(outside, join(root, 'link'))
    await expect(__testing.resolveSafePath(root, 'link/note.txt')).rejects.toThrow(/escapes allowed root/)
  })
})

describe('claude code agent adapter', async () => {
  const { __testing } = await import('./index')

  it('returns a clear failed result when the Claude CLI does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumi-agent-root-'))
    await mkdir(join(root, 'projects'), { recursive: true })

    const result = await __testing.runClaudeTask({
      userRequest: '帮我做一个番茄钟网页',
      settings: {
        enabled: true,
        claudeCommand: 'definitely-not-a-real-claude-command',
        lumiSandboxRoot: root,
        trustedProjects: [],
        selfProjectRoots: [],
        forbiddenPaths: [],
        defaultPermissionMode: 'read_only',
        sandboxAutoApprove: true,
        maxTaskTimeoutMs: 10000,
        allowedCondaEnvs: [],
      },
    })

    expect(result.status).toBe('failed')
    expect(result.error || result.stderr).toBeTruthy()
    expect(result.log?.status).toBe('failed')
    expect(result.log?.diagnostics?.failureKind).toBe('command_not_found')
    expect(result.log?.runs?.[0]?.diagnostics?.failureKind).toBe('command_not_found')
  }, 20000)

  it('continues a named task in the same task thread and working directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumi-agent-root-'))
    await mkdir(join(root, 'projects'), { recursive: true })
    const settings = {
      enabled: true,
      claudeCommand: 'definitely-not-a-real-claude-command',
      lumiSandboxRoot: root,
      trustedProjects: [],
      selfProjectRoots: [],
      forbiddenPaths: [],
      defaultPermissionMode: 'read_only' as const,
      sandboxAutoApprove: true,
      maxTaskTimeoutMs: 10000,
      allowedCondaEnvs: [],
    }

    const first = await __testing.runClaudeTask({
      userRequest: 'create a pomodoro page for Lumi',
      taskType: 'web_project',
      targetName: 'pomodoro',
      settings,
    })
    const second = await __testing.runClaudeTask({
      userRequest: 'add a small Lumi reminder under the ring',
      continueFromTaskName: 'pomodoro',
      settings,
    })

    expect(second.taskId).toBe(first.taskId)
    expect(second.task?.cwd).toBe(first.task?.cwd)
    expect(second.task?.displayName).toBe(first.task?.displayName)
    expect(second.log?.runs?.length).toBe(2)
    expect(second.log?.latestUserRequest).toContain('reminder')
  }, 20000)

  it('does not create a new task when a requested continuation cannot be found', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumi-agent-root-'))
    await mkdir(join(root, 'projects'), { recursive: true })
    await expect(__testing.runClaudeTask({
      userRequest: 'continue that missing project',
      continueFromTaskName: 'missing-project',
      settings: {
        enabled: true,
        claudeCommand: 'definitely-not-a-real-claude-command',
        lumiSandboxRoot: root,
        trustedProjects: [],
        selfProjectRoots: [],
        forbiddenPaths: [],
        defaultPermissionMode: 'read_only',
        sandboxAutoApprove: true,
        maxTaskTimeoutMs: 10000,
        allowedCondaEnvs: [],
      },
    })).rejects.toThrow(/没有找到可继续的 Claude Code 任务/)
  }, 20000)
})
