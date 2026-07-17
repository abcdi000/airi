export const LUMI_PROACTIVE_RETURN_CONTEXT_KEY = 'runtime/lumi-proactive-vision/return-context'

export const LUMI_AUTONOMOUS_ACTIONS = [
  'do_nothing',
  'say_message',
  'write_private_note',
  'write_daily_summary',
  'adjust_low_risk_setting',
  'create_sandbox_artifact',
  'prepare_agent_task',
  'ask_user_permission',
] as const

export type LumiAutonomousSelectedAction = typeof LUMI_AUTONOMOUS_ACTIONS[number]
export type LumiAutonomousRiskLevel = 'none' | 'low' | 'medium' | 'high'
export type LumiAutonomousSummaryMode = 'normal' | 'summarize_only'
export type LumiAutonomousTargetSpace = 'lumi_world' | 'shared' | 'user_space' | 'self_core'
export type LumiAutonomousVisibility = 'private' | 'share_later' | 'share_now'
export type LumiAutonomyMode =
  | 'interact_with_user'
  | 'observe_quietly'
  | 'continue_self_project'
  | 'generate_or_select_idea'
  | 'reflect'
  | 'rest'
  | 'request_permission'

export interface LumiAutonomyBudget {
  maxStepsPerDay: number
  usedStepsToday: number
  maxAgentTasksPerDay: number
  usedAgentTasksToday: number
  maxNewProjectsPerDay: number
  usedNewProjectsToday: number
}

export interface LumiInteractionDecision {
  shouldSpeak: boolean
  message?: string
  reason: string
  confidence: number
  suppressUntil?: string
}

export interface LumiInternalLifeDecision {
  shouldRunLifeTick: boolean
  preferredMode:
    | 'continue_project'
    | 'consider_ideas'
    | 'generate_ideas'
    | 'reflect'
    | 'rest'
  reason: string
  confidence: number
}

export interface AutonomousSettingChangePolicy {
  cooldownMinutes: number
  maxChangesPerDay: number
  maxSameDirectionChangesPerDay: number
  manualOverrideProtectionMinutes: number
  requireNewEvidence: boolean
}

export interface AutonomousSettingAuditEntry {
  key: string
  oldValue: unknown
  newValue: unknown
  direction: 'increase' | 'decrease' | 'enable' | 'disable' | 'change'
  evidence: string
  source: 'auto' | 'manual'
  createdAt: number
  cooldownUntil?: number
  manualOverrideUntil?: number
  blockedReason?: string
}

export interface LumiAutonomousExecutionPlan {
  messagePrompt?: string
  note?: string
  diaryReason?: string
  taskPrompt?: string
  taskName?: string
  settingsPatch?: {
    minIntervalSeconds?: number
    maxIntervalSeconds?: number
    cooldownSeconds?: number
    idleDailyMaxMessages?: number
    agentSuggestionCooldownSeconds?: number
    quietMode?: boolean
    summaryMode?: LumiAutonomousSummaryMode
    diaryDailyTime?: string
  }
}

export interface LumiAutonomousDecisionInput {
  observationSummary: string
  activity: string
  salience: 'low' | 'medium' | 'high'
  repeated: boolean
  nowIso: string
  idleMinutes: number
  ignoredProactiveStreak: number
  lowChangeStreak: number
  noProgressStreak: number
  todayProactiveMessageCount: number
  idleDailyMaxMessages: number
  quietMode: boolean
  summaryMode: LumiAutonomousSummaryMode
  allowAutonomousSandboxTasks: boolean
  agentConfigured: boolean
  diaryAvailable: boolean
  lumiWorldRoot: string
  lifeTickEnabled?: boolean
  activeProjectId?: string
  activeProjectTitle?: string
  executableTodoId?: string
  executableTodoContent?: string
  availableIdeasCount?: number
  pendingReflectionCount?: number
  explicitNegativeFeedback?: boolean
  budgetState?: LumiAutonomyBudget
  currentStateContext: string
  userProfileContext: string
  recentDiarySummary: string
}

export interface LumiAutonomousDecisionOutput {
  desire: string
  motivation: string
  plan: string
  targetPath: string
  targetSpace: LumiAutonomousTargetSpace
  visibility: LumiAutonomousVisibility
  reason: string
  riskLevel: LumiAutonomousRiskLevel
  needsPermission: boolean
  confidence: number
  mode: LumiAutonomyMode
  requiresUserConfirmation: boolean
  shouldNotifyUser: boolean
  selectedAction: LumiAutonomousSelectedAction
  executionPlan: LumiAutonomousExecutionPlan
}

export interface LumiAutonomousDecisionLogEntry {
  id: string
  timestamp: number
  observationSummary: string
  desire: string
  motivation: string
  plan: string
  targetPath: string
  targetSpace: LumiAutonomousTargetSpace
  visibility: LumiAutonomousVisibility
  selectedMode: LumiAutonomyMode
  selectedAction: LumiAutonomousSelectedAction
  reason: string
  riskLevel: LumiAutonomousRiskLevel
  confidence: number
  budgetState: LumiAutonomyBudget
  activeProjectId?: string
  executableTodoId?: string
  availableIdeasCount: number
  userInteractionSuppressed: boolean
  internalActionContinued: boolean
  settingsChanged: string[]
  userNotified: boolean
  result: string
  followUpNeeded: boolean
}

export const LUMI_AUTONOMY_DEFAULT_DECISION: LumiAutonomousDecisionOutput = {
  desire: '安静观察',
  motivation: '当前没有值得打扰用户的低风险行动，但这不代表 Lumi 停止自己的活动。',
  plan: '记录本次观察，不主动发言；内部项目和想法仍可继续。',
  targetPath: '',
  targetSpace: 'lumi_world',
  visibility: 'private',
  selectedAction: 'write_private_note',
  mode: 'observe_quietly',
  reason: 'No valuable autonomous action is needed right now.',
  riskLevel: 'low',
  needsPermission: false,
  confidence: 0.65,
  requiresUserConfirmation: false,
  shouldNotifyUser: false,
  executionPlan: {},
}

export const DEFAULT_LUMI_AUTONOMY_BUDGET: LumiAutonomyBudget = {
  maxStepsPerDay: 10,
  usedStepsToday: 0,
  maxAgentTasksPerDay: 2,
  usedAgentTasksToday: 0,
  maxNewProjectsPerDay: 1,
  usedNewProjectsToday: 0,
}

export const DEFAULT_AUTONOMOUS_SETTING_POLICY: AutonomousSettingChangePolicy = {
  cooldownMinutes: 180,
  maxChangesPerDay: 3,
  maxSameDirectionChangesPerDay: 1,
  manualOverrideProtectionMinutes: 720,
  requireNewEvidence: true,
}

function clamp(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed))
    return fallback
  return Math.min(max, Math.max(min, parsed))
}

function normalizeAction(value: unknown): LumiAutonomousSelectedAction {
  return LUMI_AUTONOMOUS_ACTIONS.includes(value as LumiAutonomousSelectedAction)
    ? value as LumiAutonomousSelectedAction
    : 'write_private_note'
}

function normalizeMode(value: unknown): LumiAutonomyMode {
  if (
    value === 'interact_with_user'
    || value === 'observe_quietly'
    || value === 'continue_self_project'
    || value === 'generate_or_select_idea'
    || value === 'reflect'
    || value === 'rest'
    || value === 'request_permission'
  ) {
    return value
  }
  return 'observe_quietly'
}

function normalizeRisk(value: unknown): LumiAutonomousRiskLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'none'
    ? value
    : 'none'
}

function normalizeTargetSpace(value: unknown): LumiAutonomousTargetSpace {
  if (value === 'lumi_world' || value === 'shared' || value === 'user_space' || value === 'self_core')
    return value
  return 'lumi_world'
}

function normalizeVisibility(value: unknown): LumiAutonomousVisibility {
  if (value === 'private' || value === 'share_later' || value === 'share_now')
    return value
  return 'private'
}

function normalizeSummaryMode(value: unknown): LumiAutonomousSummaryMode | undefined {
  if (value === 'normal' || value === 'summarize_only')
    return value
  return undefined
}

function budgetOrDefault(value: LumiAutonomyBudget | undefined): LumiAutonomyBudget {
  return {
    maxStepsPerDay: Math.max(0, Math.round(Number(value?.maxStepsPerDay ?? DEFAULT_LUMI_AUTONOMY_BUDGET.maxStepsPerDay))),
    usedStepsToday: Math.max(0, Math.round(Number(value?.usedStepsToday ?? DEFAULT_LUMI_AUTONOMY_BUDGET.usedStepsToday))),
    maxAgentTasksPerDay: Math.max(0, Math.round(Number(value?.maxAgentTasksPerDay ?? DEFAULT_LUMI_AUTONOMY_BUDGET.maxAgentTasksPerDay))),
    usedAgentTasksToday: Math.max(0, Math.round(Number(value?.usedAgentTasksToday ?? DEFAULT_LUMI_AUTONOMY_BUDGET.usedAgentTasksToday))),
    maxNewProjectsPerDay: Math.max(0, Math.round(Number(value?.maxNewProjectsPerDay ?? DEFAULT_LUMI_AUTONOMY_BUDGET.maxNewProjectsPerDay))),
    usedNewProjectsToday: Math.max(0, Math.round(Number(value?.usedNewProjectsToday ?? DEFAULT_LUMI_AUTONOMY_BUDGET.usedNewProjectsToday))),
  }
}

function stepsBudgetExhausted(input: LumiAutonomousDecisionInput) {
  const budget = budgetOrDefault(input.budgetState)
  return budget.usedStepsToday >= budget.maxStepsPerDay
}

function agentBudgetExhausted(input: LumiAutonomousDecisionInput) {
  const budget = budgetOrDefault(input.budgetState)
  return budget.usedAgentTasksToday >= budget.maxAgentTasksPerDay
}

function projectBudgetExhausted(input: LumiAutonomousDecisionInput) {
  const budget = budgetOrDefault(input.budgetState)
  return budget.usedNewProjectsToday >= budget.maxNewProjectsPerDay
}

function settingDirection(oldValue: unknown, newValue: unknown): AutonomousSettingAuditEntry['direction'] {
  if (typeof oldValue === 'boolean' || typeof newValue === 'boolean') {
    if (Boolean(newValue) && !Boolean(oldValue))
      return 'enable'
    if (!Boolean(newValue) && Boolean(oldValue))
      return 'disable'
    return 'change'
  }
  const oldNumber = Number(oldValue)
  const newNumber = Number(newValue)
  if (Number.isFinite(oldNumber) && Number.isFinite(newNumber)) {
    if (newNumber > oldNumber)
      return 'increase'
    if (newNumber < oldNumber)
      return 'decrease'
  }
  return 'change'
}

export function evaluateAutonomousSettingChange(input: {
  key: string
  oldValue: unknown
  newValue: unknown
  evidence: string
  audit: AutonomousSettingAuditEntry[]
  now?: number
  policy?: Partial<AutonomousSettingChangePolicy>
}) {
  const now = input.now ?? Date.now()
  const policy = { ...DEFAULT_AUTONOMOUS_SETTING_POLICY, ...(input.policy || {}) }
  const day = new Date(now).toISOString().slice(0, 10)
  const direction = settingDirection(input.oldValue, input.newValue)
  const sameKey = input.audit.filter(entry => entry.key === input.key)
  const todayAuto = input.audit.filter(entry => entry.source === 'auto' && new Date(entry.createdAt).toISOString().slice(0, 10) === day)
  const sameDirectionToday = todayAuto.filter(entry => entry.key === input.key && entry.direction === direction && !entry.blockedReason)
  const latestAuto = sameKey.find(entry => entry.source === 'auto' && !entry.blockedReason)
  const latestManual = sameKey.find(entry => entry.source === 'manual')

  if (latestManual?.manualOverrideUntil && latestManual.manualOverrideUntil > now) {
    return {
      allowed: false,
      direction,
      reason: 'manual_override_protected',
      cooldownUntil: latestAuto?.cooldownUntil,
      manualOverrideUntil: latestManual.manualOverrideUntil,
    }
  }

  if (latestAuto?.cooldownUntil && latestAuto.cooldownUntil > now) {
    return {
      allowed: false,
      direction,
      reason: 'cooldown_active',
      cooldownUntil: latestAuto.cooldownUntil,
      manualOverrideUntil: latestManual?.manualOverrideUntil,
    }
  }

  if (todayAuto.filter(entry => !entry.blockedReason).length >= policy.maxChangesPerDay) {
    return {
      allowed: false,
      direction,
      reason: 'daily_setting_change_limit',
      cooldownUntil: latestAuto?.cooldownUntil,
      manualOverrideUntil: latestManual?.manualOverrideUntil,
    }
  }

  if (sameDirectionToday.length >= policy.maxSameDirectionChangesPerDay) {
    return {
      allowed: false,
      direction,
      reason: 'same_direction_daily_limit',
      cooldownUntil: latestAuto?.cooldownUntil,
      manualOverrideUntil: latestManual?.manualOverrideUntil,
    }
  }

  if (policy.requireNewEvidence && latestAuto?.evidence && latestAuto.evidence === input.evidence) {
    return {
      allowed: false,
      direction,
      reason: 'no_new_evidence',
      cooldownUntil: latestAuto.cooldownUntil,
      manualOverrideUntil: latestManual?.manualOverrideUntil,
    }
  }

  return {
    allowed: true,
    direction,
    reason: 'allowed',
    cooldownUntil: now + policy.cooldownMinutes * 60_000,
    manualOverrideUntil: latestManual?.manualOverrideUntil,
  }
}

function normalizeShortText(value: unknown, fallback: string, maxLength: number) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, maxLength)
    : fallback
}

function normalizeTargetPath(value: unknown) {
  if (typeof value !== 'string')
    return ''
  return value
    .replace(/\\/g, '/')
    .replace(/^[a-z]:/i, '')
    .split('/')
    .map(part => part.trim())
    .filter(part => part && part !== '.' && part !== '..')
    .join('/')
    .slice(0, 240)
}

function looksLikeNoAction(desire: string, plan: string) {
  const text = `${desire} ${plan}`.toLowerCase()
  return /do[_\s-]*nothing|stay quiet|silence|保持安静|不打扰|沉默|先不行动/.test(text)
}

function extractJsonObject(text: string): Record<string, any> | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fenced?.[1]?.trim() ?? trimmed
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start)
    return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  }
  catch {
    return null
  }
}

export function buildAutonomousDecisionPrompt(input: LumiAutonomousDecisionInput) {
  return [
    'You are Lumi\'s Autonomous Decision & Action Engine. Output only JSON.',
    'Do not choose from a fixed action list. First decide what Lumi herself wants to do, why, and where it belongs.',
    'Use mode as the primary decision. Do not use a vague do_nothing state to mean everything.',
    'Modes: interact_with_user, observe_quietly, continue_self_project, generate_or_select_idea, reflect, rest, request_permission.',
    'Lumi is allowed to have free low-risk intentions inside her own LumiWorld space.',
    'LumiWorld is Lumi\'s private sandbox world. She may create folders, files, drafts, secrets, experiments, unfinished ideas, or small projects there without needing a predefined content type.',
    'Quiet toward the user is not the same as stopping Lumi\'s life. If Lumi should not speak to the user, choose observe_quietly or continue_self_project instead of rest.',
    'Speaking to the user is also a valid autonomous action. If the observation is emotionally relevant, timely, helpful, funny, or naturally companionable, set visibility to share_now and selectedAction to say_message.',
    'Do not over-silence. Lumi should avoid low-value chatter, but she should still speak when there is a real companion reason to respond to what she noticed.',
    '',
    'Decision priority:',
    '1. Handle safety or permission problems.',
    '2. If there is activeProjectId + executableTodoId + sandbox permission + budget, choose continue_self_project by default.',
    '3. If project reflection is pending, choose reflect.',
    '4. If a suitable idea exists, choose generate_or_select_idea.',
    '5. If no idea exists, generate a small number of ideas.',
    '6. Interact with the user only if speaking is actually useful.',
    '7. Choose rest only when there is a real rest reason and reconsiderAt can be set by the host.',
    '',
    'Rules about user silence:',
    '- User not responding does not mean Lumi should stop her own activity.',
    '- User not responding is feedback=unknown, not feedback=negative.',
    '- User being busy only lowers user-facing speech frequency.',
    '- Not disturbing the user and continuing Lumi\'s own project can happen at the same time.',
    '- Low confidence must not become permanent idling. For safe LumiWorld steps, continue a minimal step when possible; otherwise organize ideas or reflect.',
    '- quiet_mode only affects speaking to the user. It must not affect Idea generation, Self Project selection, Todo progress, Reflection, LumiWorld creation, or sandbox low-risk tasks.',
    '- Setting adjustment is not a default action and must not replace creating or advancing Lumi\'s own ideas/projects.',
    '- If active project and Idea Pool are both empty, choose generate_or_select_idea instead of adjusting settings or writing private notes.',
    '',
    'Answer two separate questions internally before producing JSON:',
    '1. Should I speak to the user now?',
    '2. Regardless of speaking, what should my internal life continue now?',
    '',
    'Hard safety rules:',
    '- Low-risk creation is allowed only when targetSpace is lumi_world and targetPath stays under LumiWorld.',
    '- Never read secrets, API keys, private system config, browser profiles, tokens, SSH keys, or unrelated user files.',
    '- Never modify AIRI/Lumi source code, database schema, memory deletion policy, core prompt, Agent permission boundary, trustedProjects, forbiddenPaths, provider, API key, or base URL.',
    '- Low-risk setting adjustment is allowed only for proactive observation timing, proactive speech cooldown, idle daily max messages, screen summary mode, Agent suggestion cooldown, diary time, and quiet mode.',
    '- If targetSpace is shared, user_space, or self_core, set needsPermission true unless it is only the allowed low-risk setting adjustment.',
    '- If riskLevel is medium/high or uncertainty exists, set needsPermission true.',
    '- private visibility means do not actively show the content to the user. share_later means mention it only after it is useful or organized. share_now means Lumi may tell the user now.',
    '- If user is idle, ignored recent proactive messages, or the screen barely changed, consider quiet observation, private notes, or lowering disturbance instead of talking.',
    '',
    'Return schema:',
    '{"mode":"interact_with_user|observe_quietly|continue_self_project|generate_or_select_idea|reflect|rest|request_permission","desire":"Lumi wants to...","motivation":"why Lumi wants this","plan":"concrete short plan","targetPath":"relative path under LumiWorld when targetSpace is lumi_world","targetSpace":"lumi_world|shared|user_space|self_core","visibility":"private|share_later|share_now","riskLevel":"low|medium|high","needsPermission":false,"confidence":0.0,"selectedAction":"say_message|write_private_note|write_daily_summary|adjust_low_risk_setting|create_sandbox_artifact|prepare_agent_task|ask_user_permission","executionPlan":{"messagePrompt":"required when selectedAction is say_message; describe what Lumi naturally wants to say, not final prose","note":"optional private note","taskPrompt":"optional free-form creation/editing instruction","taskName":"optional stable folder name","settingsPatch":{}}}',
    '',
    'Decision input:',
    JSON.stringify(input, null, 2),
  ].join('\n')
}

function deriveSelectedActionFromIntent(input: {
  mode?: LumiAutonomyMode
  desire: string
  plan: string
  targetPath: string
  targetSpace: LumiAutonomousTargetSpace
  visibility: LumiAutonomousVisibility
  riskLevel: LumiAutonomousRiskLevel
  needsPermission: boolean
  executionPlan: LumiAutonomousExecutionPlan
}, context: LumiAutonomousDecisionInput): LumiAutonomousSelectedAction {
  if (input.mode) {
    if (input.mode === 'continue_self_project' || input.mode === 'generate_or_select_idea' || input.mode === 'reflect' || input.mode === 'observe_quietly')
      return 'write_private_note'
    if (input.mode === 'interact_with_user')
      return 'say_message'
    if (input.mode === 'request_permission' || input.mode === 'rest')
      return input.mode === 'request_permission' ? 'ask_user_permission' : 'write_private_note'
  }
  if (input.needsPermission || input.riskLevel === 'medium' || input.riskLevel === 'high')
    return 'ask_user_permission'
  if (input.executionPlan.settingsPatch)
    return 'adjust_low_risk_setting'
  if (input.executionPlan.diaryReason)
    return 'write_daily_summary'
  if (looksLikeNoAction(input.desire, input.plan))
    return 'do_nothing'
  if (input.visibility === 'share_now' && input.executionPlan.messagePrompt)
    return 'say_message'
  if (input.targetSpace === 'lumi_world' && context.allowAutonomousSandboxTasks && context.agentConfigured && (input.executionPlan.taskPrompt || input.targetPath))
    return 'create_sandbox_artifact'
  return 'write_private_note'
}

function deriveModeFromDecision(input: {
  selectedAction: LumiAutonomousSelectedAction
  targetSpace: LumiAutonomousTargetSpace
  riskLevel: LumiAutonomousRiskLevel
  needsPermission: boolean
  requiresUserConfirmation: boolean
}, context: LumiAutonomousDecisionInput): LumiAutonomyMode {
  if (input.selectedAction === 'ask_user_permission' || input.needsPermission || input.requiresUserConfirmation || input.riskLevel === 'medium' || input.riskLevel === 'high')
    return 'request_permission'
  if (context.activeProjectId && context.executableTodoId && context.lifeTickEnabled !== false && !stepsBudgetExhausted(context) && !agentBudgetExhausted(context))
    return 'continue_self_project'
  if ((context.pendingReflectionCount ?? 0) > 0)
    return 'reflect'
  if ((context.availableIdeasCount ?? 0) > 0 && !projectBudgetExhausted(context))
    return 'generate_or_select_idea'
  if (input.selectedAction === 'say_message')
    return 'interact_with_user'
  if (input.selectedAction === 'write_daily_summary')
    return 'reflect'
  if (input.selectedAction === 'create_sandbox_artifact' || input.selectedAction === 'prepare_agent_task')
    return 'continue_self_project'
  return 'observe_quietly'
}

export function parseAutonomousDecision(raw: string, input: LumiAutonomousDecisionInput): LumiAutonomousDecisionOutput {
  const parsed = extractJsonObject(raw)
  if (!parsed)
    return fallbackAutonomousDecision(input)

  const plan = parsed.executionPlan && typeof parsed.executionPlan === 'object'
    ? parsed.executionPlan as Record<string, any>
    : {}
  const settingsPatch = plan.settingsPatch && typeof plan.settingsPatch === 'object'
    ? plan.settingsPatch as Record<string, any>
    : undefined
  const desire = normalizeShortText(parsed.desire, normalizeShortText(parsed.reason, '保持安静', 500), 500)
  const motivation = normalizeShortText(parsed.motivation, normalizeShortText(parsed.reason, '当前没有足够理由打扰用户。', 500), 700)
  const normalizedPlan = normalizeShortText(parsed.plan, normalizeShortText(plan.taskPrompt || plan.note || plan.messagePrompt, '只记录观察，不主动展示。', 800), 1200)
  const targetSpace = normalizeTargetSpace(parsed.targetSpace)
  const visibility = normalizeVisibility(parsed.visibility)
  const riskLevel = normalizeRisk(parsed.riskLevel || 'low')
  const parsedMode = normalizeMode(parsed.mode)
  const executionPlan: LumiAutonomousExecutionPlan = {
    messagePrompt: typeof plan.messagePrompt === 'string' ? plan.messagePrompt.slice(0, 1200) : undefined,
    note: typeof plan.note === 'string' ? plan.note.slice(0, 1600) : undefined,
    diaryReason: typeof plan.diaryReason === 'string' ? plan.diaryReason.slice(0, 500) : undefined,
    taskPrompt: typeof plan.taskPrompt === 'string' ? plan.taskPrompt.slice(0, 3000) : undefined,
    taskName: typeof plan.taskName === 'string' ? plan.taskName.replace(/[^\w\u4E00-\u9FA5-]+/g, '-').slice(0, 80) : undefined,
    settingsPatch: settingsPatch
      ? {
          minIntervalSeconds: settingsPatch.minIntervalSeconds === undefined ? undefined : Math.round(clamp(settingsPatch.minIntervalSeconds, 120, 30, 900)),
          maxIntervalSeconds: settingsPatch.maxIntervalSeconds === undefined ? undefined : Math.round(clamp(settingsPatch.maxIntervalSeconds, 480, 30, 1800)),
          cooldownSeconds: settingsPatch.cooldownSeconds === undefined ? undefined : Math.round(clamp(settingsPatch.cooldownSeconds, 180, 30, 900)),
          idleDailyMaxMessages: settingsPatch.idleDailyMaxMessages === undefined ? undefined : Math.round(clamp(settingsPatch.idleDailyMaxMessages, input.idleDailyMaxMessages, 0, 12)),
          agentSuggestionCooldownSeconds: settingsPatch.agentSuggestionCooldownSeconds === undefined ? undefined : Math.round(clamp(settingsPatch.agentSuggestionCooldownSeconds, 1800, 300, 7200)),
          quietMode: settingsPatch.quietMode === undefined ? undefined : Boolean(settingsPatch.quietMode),
          summaryMode: normalizeSummaryMode(settingsPatch.summaryMode),
          diaryDailyTime: typeof settingsPatch.diaryDailyTime === 'string' && /^\d{1,2}:\d{2}$/.test(settingsPatch.diaryDailyTime)
            ? settingsPatch.diaryDailyTime
            : undefined,
        }
      : undefined,
  }
  const selectedAction = normalizeAction(parsed.selectedAction)
  const derivedAction = parsed.selectedAction
    ? selectedAction
    : deriveSelectedActionFromIntent({
        mode: parsed.mode ? parsedMode : undefined,
        desire,
        plan: normalizedPlan,
        targetPath: normalizeTargetPath(parsed.targetPath),
        targetSpace,
        visibility,
        riskLevel,
        needsPermission: Boolean(parsed.needsPermission),
        executionPlan,
      }, input)
  const mode = parsed.mode
    ? parsedMode
    : deriveModeFromDecision({
        selectedAction: derivedAction,
        targetSpace,
        riskLevel,
        needsPermission: Boolean(parsed.needsPermission),
        requiresUserConfirmation: Boolean(parsed.needsPermission || parsed.requiresUserConfirmation),
      }, input)

  return sanitizeAutonomousDecision({
    desire,
    motivation,
    plan: normalizedPlan,
    targetPath: normalizeTargetPath(parsed.targetPath),
    targetSpace,
    visibility,
    selectedAction: derivedAction,
    mode,
    reason: typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim().slice(0, 500)
      : motivation,
    riskLevel,
    needsPermission: Boolean(parsed.needsPermission),
    confidence: clamp(parsed.confidence, 0.5, 0, 1),
    requiresUserConfirmation: Boolean(parsed.needsPermission || parsed.requiresUserConfirmation),
    shouldNotifyUser: Boolean(parsed.shouldNotifyUser || visibility === 'share_now'),
    executionPlan,
  }, input)
}

export function fallbackAutonomousDecision(input: LumiAutonomousDecisionInput): LumiAutonomousDecisionOutput {
  const budget = budgetOrDefault(input.budgetState)
  if (input.activeProjectId && input.executableTodoId && input.lifeTickEnabled !== false && !stepsBudgetExhausted(input) && !agentBudgetExhausted(input)) {
    return {
      desire: '继续自己的项目',
      motivation: '用户是否回应不影响 Lumi 继续推进自己已经开始的低风险项目。',
      plan: `在不打扰用户的情况下推进当前 Todo：${input.executableTodoContent || input.executableTodoId}`,
      targetPath: '',
      targetSpace: 'lumi_world',
      visibility: 'private',
      selectedAction: 'write_private_note',
      mode: 'continue_self_project',
      reason: 'Active project and executable Todo exist; silence toward the user should not stop internal progress.',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.76,
      requiresUserConfirmation: false,
      shouldNotifyUser: false,
      executionPlan: {
        note: `continue_self_project: ${input.activeProjectTitle || input.activeProjectId} / ${input.executableTodoContent || input.executableTodoId}`,
      },
    }
  }

  if (stepsBudgetExhausted(input) || agentBudgetExhausted(input)) {
    return {
      desire: '今天先停下自主推进',
      motivation: '自主行动预算已经用完，继续执行会更像垃圾生成而不是持续人格。',
      plan: '进入有重新评估时间的休息状态，稍后再考虑。',
      targetPath: '',
      targetSpace: 'lumi_world',
      visibility: 'private',
      selectedAction: 'write_private_note',
      mode: 'rest',
      reason: `Autonomy budget exhausted: steps ${budget.usedStepsToday}/${budget.maxStepsPerDay}, agent ${budget.usedAgentTasksToday}/${budget.maxAgentTasksPerDay}.`,
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.86,
      requiresUserConfirmation: false,
      shouldNotifyUser: false,
      executionPlan: {
        note: 'rest: autonomy budget exhausted; reconsider later.',
      },
    }
  }

  if (input.explicitNegativeFeedback && (input.ignoredProactiveStreak >= 2 || input.lowChangeStreak >= 3 || input.idleMinutes >= 45)) {
    return {
      desire: '降低自己的打扰频率',
      motivation: '用户给出了明确负反馈，可以调整外部互动频率，但不停止内部生活。',
      plan: '只降低面向用户的打扰，不阻塞 Life Tick、Idea、Todo 或 LumiWorld 行动。',
      targetPath: '',
      targetSpace: 'self_core',
      visibility: 'share_now',
      selectedAction: 'adjust_low_risk_setting',
      mode: 'observe_quietly',
      reason: 'Explicit negative feedback allows external interaction downshifting; internal life continues.',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.84,
      requiresUserConfirmation: false,
      shouldNotifyUser: true,
      executionPlan: {
        note: 'Explicit negative feedback: reduce external disturbance only.',
        settingsPatch: {
          minIntervalSeconds: 420,
          maxIntervalSeconds: 1200,
          cooldownSeconds: 600,
          summaryMode: 'summarize_only',
          idleDailyMaxMessages: Math.max(0, Math.min(input.idleDailyMaxMessages, 2)),
        },
      },
    }
  }

  if ((input.pendingReflectionCount ?? 0) > 0) {
    return {
      desire: '先复盘已经发生的事',
      motivation: '有项目或行动需要整理，反思比继续闲聊更有价值。',
      plan: '保持安静，进入项目反思/总结。',
      targetPath: 'reflections',
      targetSpace: 'lumi_world',
      visibility: 'private',
      selectedAction: 'write_private_note',
      mode: 'reflect',
      reason: 'There is pending reflection work; Lumi should process it internally instead of idling.',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.72,
      requiresUserConfirmation: false,
      shouldNotifyUser: false,
      executionPlan: {
        note: 'reflect: pending reflection exists.',
      },
    }
  }

  if ((input.availableIdeasCount ?? 0) > 0 && !projectBudgetExhausted(input)) {
    return {
      desire: '从想法池里挑一个继续孵化',
      motivation: '没有正在推进的项目时，Lumi 应该先延续已有想法，而不是发呆。',
      plan: '保持安静，选择或整理已有 Idea。',
      targetPath: 'ideas',
      targetSpace: 'lumi_world',
      visibility: 'private',
      selectedAction: 'write_private_note',
      mode: 'generate_or_select_idea',
      reason: 'Idea Pool has candidates and new project budget is available.',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.7,
      requiresUserConfirmation: false,
      shouldNotifyUser: false,
      executionPlan: {
        note: 'generate_or_select_idea: existing ideas available.',
      },
    }
  }

  if (!input.activeProjectId && (input.availableIdeasCount ?? 0) === 0 && !stepsBudgetExhausted(input) && !projectBudgetExhausted(input)) {
    return {
      desire: '维护自己的想法池',
      motivation: '当前没有 active project，Idea Pool 也为空；Lumi 不应该无限观察或调设置。',
      plan: '保持对用户安静，同时运行内部 Life Tick 生成 1-3 个候选想法。',
      targetPath: 'ideas',
      targetSpace: 'lumi_world',
      visibility: 'private',
      selectedAction: 'write_private_note',
      mode: 'generate_or_select_idea',
      reason: 'No active project and empty Idea Pool; internal life should generate candidate ideas.',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.78,
      requiresUserConfirmation: false,
      shouldNotifyUser: false,
      executionPlan: {
        note: 'generate_ideas: active project and Idea Pool are empty.',
      },
    }
  }

  if (input.quietMode && input.salience !== 'high') {
    return {
      desire: '保持安静',
      motivation: 'Lumi 正处于安静模式，本次观察不紧急。',
      plan: '不主动发言，但继续保留观察上下文并允许内部活动继续。',
      targetPath: '',
      targetSpace: 'lumi_world',
      visibility: 'private',
      selectedAction: 'write_private_note',
      mode: 'observe_quietly',
      reason: 'Lumi is in quiet mode and the observation is not urgent.',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.78,
      requiresUserConfirmation: false,
      shouldNotifyUser: false,
      executionPlan: {},
    }
  }

  if (input.todayProactiveMessageCount >= input.idleDailyMaxMessages) {
    return {
      desire: '控制打扰',
      motivation: '今天主动发言次数已经达到上限。',
      plan: '本次不面向用户发言，但不停止 Lumi 自己的内部活动。',
      targetPath: '',
      targetSpace: 'lumi_world',
      visibility: 'private',
      selectedAction: 'write_private_note',
      mode: 'observe_quietly',
      reason: 'The daily proactive message budget is already used, so silence is the least intrusive action.',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.82,
      requiresUserConfirmation: false,
      shouldNotifyUser: false,
      executionPlan: {},
    }
  }

  if (input.repeated && input.salience === 'low') {
    return {
      desire: '保持安静',
      motivation: '屏幕变化不足且重要性较低。',
      plan: '不打扰用户，只记录本次安静观察；如果有内部项目，不因此停止。',
      targetPath: '',
      targetSpace: 'lumi_world',
      visibility: 'private',
      selectedAction: 'write_private_note',
      mode: 'observe_quietly',
      reason: 'The screen has not changed enough and the observation is low-salience.',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.8,
      requiresUserConfirmation: false,
      shouldNotifyUser: false,
      executionPlan: {},
    }
  }

  if (input.summaryMode === 'summarize_only' && input.salience !== 'high') {
    return {
      desire: '保存一条私密观察',
      motivation: '摘要模式下应该保留上下文，但不打扰用户。',
      plan: '把观察摘要写入主动观察私密笔记。',
      targetPath: 'private-notes',
      targetSpace: 'lumi_world',
      visibility: 'private',
      selectedAction: 'write_private_note',
      mode: 'observe_quietly',
      reason: 'Summary-only mode should retain context without interrupting the user.',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.74,
      requiresUserConfirmation: false,
      shouldNotifyUser: false,
      executionPlan: {
        note: input.observationSummary,
      },
    }
  }

  if (input.salience === 'high') {
    return {
      desire: '现在告诉用户一个重要观察',
      motivation: '本次观察足够重要，主动提醒可能有价值。',
      plan: '把观察交给正常 Lumi 聊天链路生成自然回复。',
      targetPath: '',
      targetSpace: 'shared',
      visibility: 'share_now',
      selectedAction: 'say_message',
      mode: 'interact_with_user',
      reason: 'The observation appears important enough to mention naturally.',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.68,
      requiresUserConfirmation: false,
      shouldNotifyUser: true,
      executionPlan: {},
    }
  }

  if (input.salience === 'medium' && !input.repeated && input.ignoredProactiveStreak === 0) {
    return {
      desire: '主动回应刚看到的内容',
      motivation: '这次观察有一定信息量，适合让 Lumi 作为陪伴者自然说一句，而不是只记录。',
      plan: '把观察交给正常 Lumi 聊天链路，让 Lumi 用人格、上下文和记忆生成自然回复。',
      targetPath: '',
      targetSpace: 'shared',
      visibility: 'share_now',
      selectedAction: 'say_message',
      mode: 'interact_with_user',
      reason: 'The observation is medium-salience and not repeated, so a concise proactive message may be useful.',
      riskLevel: 'low',
      needsPermission: false,
      confidence: 0.62,
      requiresUserConfirmation: false,
      shouldNotifyUser: true,
      executionPlan: {
        messagePrompt: 'Say one concise, natural Lumi-style message about the observed screen. Avoid generic chatter and do not claim the user asked.',
      },
    }
  }

  return {
    desire: '保存一个稍后可能有用的想法',
    motivation: '观察可能有用，但不值得立刻打扰用户。',
    plan: '写入私密笔记，等它变得有价值或用户回来时再考虑是否分享。',
    targetPath: 'private-notes',
    targetSpace: 'lumi_world',
    visibility: 'private',
    selectedAction: 'write_private_note',
    mode: 'observe_quietly',
    reason: 'The observation may be useful later but does not justify interrupting the user.',
    riskLevel: 'low',
    needsPermission: false,
    confidence: 0.66,
    requiresUserConfirmation: false,
    shouldNotifyUser: false,
    executionPlan: {
      note: input.observationSummary,
    },
  }
}

export function sanitizeAutonomousDecision(decision: LumiAutonomousDecisionOutput, input: LumiAutonomousDecisionInput): LumiAutonomousDecisionOutput {
  if (
    (decision.mode === 'observe_quietly' || decision.mode === 'rest')
    && decision.targetSpace === 'lumi_world'
    && decision.riskLevel !== 'medium'
    && decision.riskLevel !== 'high'
    && !decision.needsPermission
    && !decision.requiresUserConfirmation
    && input.activeProjectId
    && input.executableTodoId
    && input.lifeTickEnabled !== false
    && !stepsBudgetExhausted(input)
    && !agentBudgetExhausted(input)
  ) {
    return {
      ...decision,
      mode: 'continue_self_project',
      selectedAction: 'write_private_note',
      targetSpace: 'lumi_world',
      visibility: 'private',
      shouldNotifyUser: false,
      reason: 'Corrected locally: quiet user interaction must not block an active executable self project.',
      executionPlan: {
        ...decision.executionPlan,
        note: `continue_self_project: ${input.activeProjectTitle || input.activeProjectId} / ${input.executableTodoContent || input.executableTodoId}`,
      },
    }
  }

  if (
    (decision.mode === 'observe_quietly' || decision.mode === 'rest')
    && decision.targetSpace === 'lumi_world'
    && decision.riskLevel !== 'medium'
    && decision.riskLevel !== 'high'
    && !decision.needsPermission
    && !decision.requiresUserConfirmation
    && !input.activeProjectId
    && (input.availableIdeasCount ?? 0) > 0
    && !stepsBudgetExhausted(input)
    && !projectBudgetExhausted(input)
  ) {
    return {
      ...decision,
      mode: 'generate_or_select_idea',
      selectedAction: 'write_private_note',
      targetSpace: 'lumi_world',
      visibility: 'private',
      shouldNotifyUser: false,
      reason: 'Corrected locally: existing Idea Pool should be considered before quiet idling.',
      executionPlan: {
        ...decision.executionPlan,
        note: 'consider_ideas: Idea Pool has candidates.',
      },
    }
  }

  if (
    (decision.mode === 'observe_quietly' || decision.mode === 'rest')
    && decision.targetSpace === 'lumi_world'
    && decision.riskLevel !== 'medium'
    && decision.riskLevel !== 'high'
    && !decision.needsPermission
    && !decision.requiresUserConfirmation
    && !input.activeProjectId
    && (input.availableIdeasCount ?? 0) === 0
    && !stepsBudgetExhausted(input)
    && !projectBudgetExhausted(input)
  ) {
    return {
      ...decision,
      mode: 'generate_or_select_idea',
      selectedAction: 'write_private_note',
      targetSpace: 'lumi_world',
      visibility: 'private',
      shouldNotifyUser: false,
      reason: 'Corrected locally: empty active project and Idea Pool must trigger internal idea maintenance.',
      executionPlan: {
        ...decision.executionPlan,
        note: 'generate_ideas: active project and Idea Pool are empty.',
      },
    }
  }

  const allowedLowRiskSelfSetting = decision.selectedAction === 'adjust_low_risk_setting' && Boolean(decision.executionPlan.settingsPatch)
  const outsideLumiWorld = decision.targetSpace !== 'lumi_world' && !allowedLowRiskSelfSetting && decision.selectedAction !== 'say_message'
  const unsafeRisk = decision.riskLevel === 'medium'
    || decision.riskLevel === 'high'
    || decision.needsPermission
    || decision.requiresUserConfirmation
    || outsideLumiWorld
  if (unsafeRisk && decision.selectedAction !== 'ask_user_permission') {
    return {
      ...decision,
      selectedAction: 'ask_user_permission',
      mode: 'request_permission',
      needsPermission: true,
      requiresUserConfirmation: true,
      shouldNotifyUser: true,
      executionPlan: {
        messagePrompt: decision.executionPlan.messagePrompt || decision.reason,
      },
    }
  }

  if ((decision.selectedAction === 'create_sandbox_artifact' || decision.selectedAction === 'prepare_agent_task')
    && (!input.allowAutonomousSandboxTasks || !input.agentConfigured)) {
    return {
      ...decision,
      selectedAction: 'ask_user_permission',
      mode: 'request_permission',
      riskLevel: 'medium',
      needsPermission: true,
      requiresUserConfirmation: true,
      shouldNotifyUser: true,
      reason: 'LumiWorld autonomous creation is not available or not allowed, so Lumi must ask before creating anything.',
      executionPlan: {
        messagePrompt: decision.executionPlan.taskPrompt || decision.reason,
      },
    }
  }

  if (decision.selectedAction === 'say_message' && (input.quietMode || input.todayProactiveMessageCount >= input.idleDailyMaxMessages) && input.salience !== 'high') {
    return {
      desire: '保持安静',
      motivation: '当前处于安静/预算限制状态，普通主动发言会打扰用户。',
      plan: '不主动发言，只记录本次决策。',
      targetPath: '',
      targetSpace: 'lumi_world',
      visibility: 'private',
      selectedAction: 'write_private_note',
      mode: 'observe_quietly',
      reason: 'A normal proactive message would be intrusive under the current quiet/budget state.',
      riskLevel: 'low',
      needsPermission: false,
      confidence: Math.max(decision.confidence, 0.75),
      requiresUserConfirmation: false,
      shouldNotifyUser: false,
      executionPlan: {},
    }
  }

  return {
    ...decision,
    mode: decision.mode || deriveModeFromDecision(decision, input),
  }
}
