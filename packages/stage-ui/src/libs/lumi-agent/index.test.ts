import { describe, expect, it } from 'vitest'

import { buildClaudeCodePrompt, DEFAULT_AGENT_SETTINGS, routeAgentTask } from '.'

const settings = {
  ...DEFAULT_AGENT_SETTINGS,
  enabled: true,
  lumiSandboxRoot: 'D:/LumiSandbox',
}

describe('lumi agent task router', () => {
  it('routes web project requests to Claude Code sandbox', () => {
    const route = routeAgentTask('帮我做一个番茄钟网页', settings)
    expect(route.shouldDelegate).toBe(true)
    expect(route.taskType).toBe('web_project')
    expect(route.permissionMode).toBe('sandbox_auto')
    expect(route.executor).toBe('claude_code')
  })

  it('routes markdown edit requests', () => {
    const route = routeAgentTask('帮我修改这个 md', settings)
    expect(route.shouldDelegate).toBe(true)
    expect(route.taskType).toBe('markdown_edit')
  })

  it('routes note review as read only', () => {
    const route = routeAgentTask('帮我查看我的笔记', settings)
    expect(route.shouldDelegate).toBe(true)
    expect(route.taskType).toBe('note_review')
    expect(route.permissionMode).toBe('read_only')
  })

  it('routes self project improvements as proposal only', () => {
    const route = routeAgentTask('优化你的记忆系统', settings)
    expect(route.shouldDelegate).toBe(true)
    expect(route.taskType).toBe('self_project_improvement')
    expect(route.permissionMode).toBe('self_project_proposal')
  })

  it('does not delegate ordinary chat', () => {
    const route = routeAgentTask('今天有点累，陪我聊会儿', settings)
    expect(route.shouldDelegate).toBe(false)
    expect(route.reason).toBe('ordinary_chat')
  })
})

describe('lumi agent prompt', () => {
  it('includes the safety boundary', () => {
    const prompt = buildClaudeCodePrompt({
      userRequest: '帮我做一个 Todo 页面',
      taskType: 'web_project',
      cwd: 'D:/LumiSandbox/projects/todo',
      permissionMode: 'sandbox_auto',
      allowedPaths: ['D:/LumiSandbox/projects/todo'],
      deniedPaths: ['D:/pyProject/AIRI/airi'],
    })

    expect(prompt).toContain('Only work inside the allowed working directory.')
    expect(prompt).toContain('Do not read secrets')
    expect(prompt).toContain('Do not run git push')
    expect(prompt).toContain('index.html')
  })
})

