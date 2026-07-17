import { describe, expect, it } from 'vitest'
import { evaluateAutonomousSettingChange, fallbackAutonomousDecision, parseAutonomousDecision, sanitizeAutonomousDecision } from './lumi-proactive-autonomy'
import type { LumiAutonomousDecisionInput, LumiAutonomousDecisionOutput } from './lumi-proactive-autonomy'

function createInput(overrides: Partial<LumiAutonomousDecisionInput> = {}): LumiAutonomousDecisionInput {
  return {
    observationSummary: 'The screen is mostly unchanged.',
    activity: 'coding',
    salience: 'low',
    repeated: false,
    nowIso: '2026-06-10T12:00:00.000Z',
    idleMinutes: 0,
    ignoredProactiveStreak: 0,
    lowChangeStreak: 0,
    noProgressStreak: 0,
    todayProactiveMessageCount: 0,
    idleDailyMaxMessages: 4,
    quietMode: false,
    summaryMode: 'normal',
    allowAutonomousSandboxTasks: true,
    agentConfigured: true,
    diaryAvailable: true,
    lumiWorldRoot: 'D:\\LumiSandbox\\LumiWorld',
    currentStateContext: '',
    userProfileContext: '',
    recentDiarySummary: '',
    ...overrides,
  }
}

describe('lumi proactive autonomy', () => {
  it('treats quiet mode as external silence without blocking internal idea maintenance', () => {
    const decision = fallbackAutonomousDecision(createInput({ quietMode: true }))

    expect(decision.mode).toBe('generate_or_select_idea')
    expect(decision.selectedAction).toBe('write_private_note')
    expect(decision.shouldNotifyUser).toBe(false)
    expect(decision.targetSpace).toBe('lumi_world')
    expect(decision.reason).toContain('empty Idea Pool')
  })

  it('reduces disturbance after ignored proactive messages', () => {
    const decision = fallbackAutonomousDecision(createInput({ ignoredProactiveStreak: 2 }))

    expect(decision.selectedAction).not.toBe('adjust_low_risk_setting')
    expect(decision.mode).toBe('generate_or_select_idea')
    expect(decision.executionPlan.settingsPatch?.quietMode).toBeUndefined()
  })

  it('only explicit negative feedback can trigger disturbance-reduction settings', () => {
    const decision = fallbackAutonomousDecision(createInput({
      ignoredProactiveStreak: 2,
      explicitNegativeFeedback: true,
      availableIdeasCount: 1,
    }))

    expect(decision.selectedAction).toBe('adjust_low_risk_setting')
    expect(decision.executionPlan.settingsPatch?.summaryMode).toBe('summarize_only')
  })

  it('continues self project when user is idle and an executable Todo exists', () => {
    const decision = fallbackAutonomousDecision(createInput({
      idleMinutes: 180,
      ignoredProactiveStreak: 4,
      activeProjectId: 'project-1',
      activeProjectTitle: 'Lumi room',
      executableTodoId: 'todo-1',
      executableTodoContent: 'Write the first room note',
      lifeTickEnabled: true,
      budgetState: {
        maxStepsPerDay: 10,
        usedStepsToday: 2,
        maxAgentTasksPerDay: 2,
        usedAgentTasksToday: 0,
        maxNewProjectsPerDay: 1,
        usedNewProjectsToday: 0,
      },
    }))

    expect(decision.mode).toBe('continue_self_project')
    expect(decision.shouldNotifyUser).toBe(false)
    expect(decision.reason).toContain('Active project')
  })

  it('does not rest when an executable Todo exists', () => {
    const decision = fallbackAutonomousDecision(createInput({
      activeProjectId: 'project-1',
      executableTodoId: 'todo-1',
      lifeTickEnabled: true,
    }))

    expect(decision.mode).not.toBe('rest')
    expect(decision.mode).toBe('continue_self_project')
  })

  it('uses Idea Pool before resting when no project is active', () => {
    const decision = fallbackAutonomousDecision(createInput({
      availableIdeasCount: 3,
      budgetState: {
        maxStepsPerDay: 10,
        usedStepsToday: 1,
        maxAgentTasksPerDay: 2,
        usedAgentTasksToday: 0,
        maxNewProjectsPerDay: 1,
        usedNewProjectsToday: 0,
      },
    }))

    expect(decision.mode).toBe('generate_or_select_idea')
  })

  it('generates ideas when active project and Idea Pool are empty', () => {
    const decision = fallbackAutonomousDecision(createInput({
      quietMode: true,
      summaryMode: 'summarize_only',
      availableIdeasCount: 0,
    }))

    expect(decision.mode).toBe('generate_or_select_idea')
    expect(decision.reason).toContain('empty Idea Pool')
  })

  it('can truly rest when action budget is exhausted', () => {
    const decision = fallbackAutonomousDecision(createInput({
      budgetState: {
        maxStepsPerDay: 8,
        usedStepsToday: 8,
        maxAgentTasksPerDay: 2,
        usedAgentTasksToday: 0,
        maxNewProjectsPerDay: 1,
        usedNewProjectsToday: 0,
      },
    }))

    expect(decision.mode).toBe('rest')
    expect(decision.reason).toContain('budget exhausted')
  })

  it('blocks sandbox tasks when sandbox automation is disabled', () => {
    const raw: LumiAutonomousDecisionOutput = {
      desire: 'Create a private note.',
      motivation: 'It may help Lumi later.',
      plan: 'Write one markdown note inside LumiWorld.',
      targetPath: 'notes/private.md',
      targetSpace: 'lumi_world',
      visibility: 'private',
      selectedAction: 'create_sandbox_artifact',
      mode: 'continue_self_project',
      reason: 'Prepare a small artifact.',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.8,
      requiresUserConfirmation: false,
      shouldNotifyUser: true,
      executionPlan: {
        taskPrompt: 'Create a note.',
      },
    }

    const decision = sanitizeAutonomousDecision(raw, createInput({ allowAutonomousSandboxTasks: false }))

    expect(decision.selectedAction).toBe('ask_user_permission')
    expect(decision.requiresUserConfirmation).toBe(true)
  })

  it('turns medium or high risk actions into permission requests', () => {
    const decision = sanitizeAutonomousDecision({
      desire: 'Change a risky setting.',
      motivation: 'The model guessed it might help.',
      plan: 'Try to change a risky setting.',
      targetPath: '',
      targetSpace: 'self_core',
      visibility: 'share_now',
      selectedAction: 'adjust_low_risk_setting',
      mode: 'request_permission',
      reason: 'Try to change a risky setting.',
      riskLevel: 'high',
      needsPermission: false,
      confidence: 0.9,
      requiresUserConfirmation: false,
      shouldNotifyUser: false,
      executionPlan: {
        settingsPatch: {
          quietMode: true,
        },
      },
    }, createInput())

    expect(decision.selectedAction).toBe('ask_user_permission')
    expect(decision.requiresUserConfirmation).toBe(true)
  })

  it('does not allow low-salience messages in quiet mode', () => {
    const decision = sanitizeAutonomousDecision({
      desire: 'Say something.',
      motivation: 'Tell the user what I saw.',
      plan: 'Send a normal proactive message.',
      targetPath: '',
      targetSpace: 'shared',
      visibility: 'share_now',
      selectedAction: 'say_message',
      mode: 'interact_with_user',
      reason: 'Say something.',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.7,
      requiresUserConfirmation: false,
      shouldNotifyUser: true,
      executionPlan: {
        messagePrompt: 'Tell the user what I saw.',
      },
    }, createInput({ quietMode: true, salience: 'low' }))

    expect(decision.mode).toBe('observe_quietly')
    expect(decision.selectedAction).toBe('write_private_note')
    expect(decision.shouldNotifyUser).toBe(false)
  })

  it('corrects observe_quietly to continue_self_project when executable Todo exists', () => {
    const decision = sanitizeAutonomousDecision({
      desire: '保持安静',
      motivation: '用户没有回应。',
      plan: '先不说话。',
      targetPath: '',
      targetSpace: 'lumi_world',
      visibility: 'private',
      selectedAction: 'write_private_note',
      mode: 'observe_quietly',
      reason: 'User did not respond.',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.6,
      requiresUserConfirmation: false,
      shouldNotifyUser: false,
      executionPlan: {},
    }, createInput({
      activeProjectId: 'project-1',
      activeProjectTitle: 'Lumi room',
      executableTodoId: 'todo-1',
      executableTodoContent: 'Write a draft',
    }))

    expect(decision.mode).toBe('continue_self_project')
    expect(decision.reason).toContain('Corrected locally')
  })

  it('parses JSON decisions and clamps low-risk setting patches', () => {
    const decision = parseAutonomousDecision(JSON.stringify({
      selectedAction: 'adjust_low_risk_setting',
      reason: 'The user is idle, reduce interruption.',
      riskLevel: 'low',
      confidence: 2,
      requiresUserConfirmation: false,
      shouldNotifyUser: true,
      executionPlan: {
        settingsPatch: {
          minIntervalSeconds: 5,
          maxIntervalSeconds: 9999,
          cooldownSeconds: 9999,
          idleDailyMaxMessages: 99,
          agentSuggestionCooldownSeconds: 1,
          quietMode: true,
          summaryMode: 'summarize_only',
        },
      },
    }), createInput())

    expect(decision.confidence).toBe(1)
    expect(decision.executionPlan.settingsPatch?.minIntervalSeconds).toBe(30)
    expect(decision.executionPlan.settingsPatch?.maxIntervalSeconds).toBe(1800)
    expect(decision.executionPlan.settingsPatch?.cooldownSeconds).toBe(900)
    expect(decision.executionPlan.settingsPatch?.idleDailyMaxMessages).toBe(12)
    expect(decision.executionPlan.settingsPatch?.agentSuggestionCooldownSeconds).toBe(300)
  })

  it('derives LumiWorld creation from a free low-risk intention', () => {
    const decision = parseAutonomousDecision(JSON.stringify({
      desire: '给 Doggy 做一个小小的观察草稿',
      motivation: '屏幕内容启发了一个稍后可能能分享的小点子。',
      plan: '在 LumiWorld 里创建一个 markdown 草稿，先私人保存。',
      targetPath: 'drafts/screen-thought.md',
      targetSpace: 'lumi_world',
      visibility: 'private',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.82,
      executionPlan: {
        taskPrompt: 'Create a markdown draft from this thought.',
      },
    }), createInput())

    expect(decision.selectedAction).toBe('create_sandbox_artifact')
    expect(decision.mode).toBe('continue_self_project')
    expect(decision.targetSpace).toBe('lumi_world')
    expect(decision.visibility).toBe('private')
    expect(decision.shouldNotifyUser).toBe(false)
  })

  it('requires permission when free intention targets user space', () => {
    const decision = parseAutonomousDecision(JSON.stringify({
      desire: '整理用户桌面文件',
      motivation: '看起来桌面有点乱。',
      plan: '移动用户桌面上的文件。',
      targetPath: 'Desktop',
      targetSpace: 'user_space',
      visibility: 'share_now',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.7,
      executionPlan: {
        taskPrompt: 'Move files.',
      },
    }), createInput())

    expect(decision.selectedAction).toBe('ask_user_permission')
    expect(decision.requiresUserConfirmation).toBe(true)
  })

  it('blocks repeated same-direction automatic setting changes', () => {
    const now = Date.parse('2026-06-10T12:00:00.000Z')
    const first = evaluateAutonomousSettingChange({
      key: 'cooldownMs',
      oldValue: 120000,
      newValue: 300000,
      evidence: 'explicit_negative_feedback',
      audit: [],
      now,
    })
    const second = evaluateAutonomousSettingChange({
      key: 'cooldownMs',
      oldValue: 300000,
      newValue: 600000,
      evidence: 'new_explicit_negative_feedback',
      audit: [{
        key: 'cooldownMs',
        oldValue: 120000,
        newValue: 300000,
        direction: first.direction,
        evidence: 'explicit_negative_feedback',
        source: 'auto',
        createdAt: now,
        cooldownUntil: first.cooldownUntil,
      }],
      now: now + 60_000,
    })

    expect(first.allowed).toBe(true)
    expect(second.allowed).toBe(false)
    expect(second.reason).toBe('cooldown_active')
  })

  it('protects manual overrides from automatic setting changes', () => {
    const now = Date.parse('2026-06-10T12:00:00.000Z')
    const decision = evaluateAutonomousSettingChange({
      key: 'quietMode',
      oldValue: false,
      newValue: true,
      evidence: 'explicit_negative_feedback',
      audit: [{
        key: 'quietMode',
        oldValue: true,
        newValue: false,
        direction: 'disable',
        evidence: 'manual_override',
        source: 'manual',
        createdAt: now - 60_000,
        manualOverrideUntil: now + 720 * 60_000,
      }],
      now,
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('manual_override_protected')
  })
})
