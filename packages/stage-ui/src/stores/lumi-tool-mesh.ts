import type { Tool } from '@xsai/shared-chat'

import type { ChatInteractionContext } from '../types/chat'

import { errorMessageFrom } from '@moeru/std'
import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { tool } from '@xsai/tool'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { z } from 'zod'

import { LUMI_AIRI_CARD_ID } from '../constants/lumi-card'
import { useLlmToolsStore } from './llm-tools'
import { useLlmToolsetPromptsStore } from './llm-toolset-prompts'
import { useLumiCurrentStateStore } from './lumi-current-state'
import { useLumiEmotionStore } from './lumi-emotion'
import { useLumiMemoryStore } from './lumi-memory'
import { useLumiUserProfileStore } from './lumi-user-profile'

export type LumiToolRiskLevel = 'low' | 'medium' | 'high' | 'critical'
export type LumiToolAccessScope = 'chat' | 'autonomous_life' | 'proactive_vision' | 'agent' | 'diary' | 'debug' | 'mcp'
export type LumiToolExecutionMode = 'auto' | 'operator_present_auto' | 'confirm' | 'blocked'
export type LumiToolStatus = 'implemented' | 'partial' | 'missing'
export type LumiToolRunStatus = 'success' | 'failed' | 'blocked' | 'missing' | 'pending_confirmation'

export interface LumiToolDefinition {
  id: string
  name: string
  description: string
  capabilities: string[]
  examples: string[]
  inputSchema: unknown
  outputSchema: unknown
  riskLevel: LumiToolRiskLevel
  accessScopes: LumiToolAccessScope[]
  executionMode: LumiToolExecutionMode
  status: LumiToolStatus
  implementationPath?: string
  canRead: boolean
  canWrite: boolean
  canExecuteProcess: boolean
  canAccessNetwork: boolean
  canModifySettings: boolean
  canTouchUserFiles: boolean
  canTouchLumiCore: boolean
  suggestedCombinations?: string[]
}

export interface LumiToolPlanStep {
  id: string
  toolId: string
  purpose: string
  input: Record<string, unknown>
  dependsOn?: string[]
  optional?: boolean
}

export type LumiModelDecision
  = | {
    mode: 'direct_answer'
    answer: string
  }
  | {
    mode: 'use_tools'
    goal: string
    reason: string
    toolPlan: LumiToolPlanStep[]
  }

export interface LumiToolExecutionContext {
  scope: LumiToolAccessScope
  source?: string
  allowCritical?: boolean
  maxSteps?: number
  /** Immutable conversation ID captured for the turn executing this tool. */
  conversationId?: string
  /** Conversation privacy boundary used to deny direct-user tools in groups. */
  conversationType?: ChatInteractionContext['conversationType']
  /** Human actor that initiated the turn. */
  actorId?: string
  /** Complete human audience for the conversation. */
  participantIds?: string[]
}

export interface LumiToolExecutionResult {
  stepId?: string
  toolId: string
  status: LumiToolRunStatus
  purpose?: string
  result?: unknown
  error?: string
  blockedReason?: string
}

export interface LumiToolPlanExecutionResult {
  goal: string
  status: 'success' | 'partial' | 'failed'
  executed: LumiToolExecutionResult[]
  skipped: Array<{ stepId: string, toolId: string, reason: string }>
  summary: string
}

export interface LumiToolUseLogEntry {
  id: string
  createdAt: string
  scope: LumiToolAccessScope
  source: string
  toolId: string
  toolName: string
  status: LumiToolRunStatus
  riskLevel: LumiToolRiskLevel
  purpose?: string
  inputPreview: string
  outputPreview: string
  error?: string
}

export interface LumiToolPlanLogEntry {
  id: string
  createdAt: string
  scope: LumiToolAccessScope
  source: string
  goal: string
  reason: string
  steps: LumiToolPlanStep[]
  status: 'planned' | 'executed' | 'failed'
  resultSummary?: string
}

export type LumiToolExecutor = (
  input: Record<string, unknown>,
  context: LumiToolExecutionContext,
  definition: LumiToolDefinition,
) => unknown | Promise<unknown>

const PROVIDER = 'lumi-tool-mesh'
const MAX_TOOL_STEPS = 5
const MAX_LOGS = 120

// Group conversations are shared timelines. These tools expose direct-user,
// operator, or private runtime state and must never rely on prompt compliance.
const CHAT_PRIVATE_TOOL_IDS = new Set([
  'search_diary',
  'read_diary_by_date',
  'write_diary_entry',
  'search_private_notes',
  'write_private_note',
  'get_runtime_logs',
  'get_autonomous_decision_log',
  'get_recent_tool_use_logs',
])

const GROUP_BLOCKED_TOOL_IDS = new Set([
  ...CHAT_PRIVATE_TOOL_IDS,
  'search_short_memory',
  'read_current_state',
  'update_current_state_candidate',
  'read_user_profile',
  'propose_user_profile_update',
  'read_emotion_state',
  'read_lumi_settings',
  'adjust_lumi_settings',
  'read_tool_permissions',
  'set_operator_present_mode',
])

interface LumiToolMeshExecuteOptionsExtension {
  lumiToolMeshInteraction?: ChatInteractionContext
}

function nowIso() {
  return new Date().toISOString()
}

function createId(prefix: string) {
  if (globalThis.crypto?.randomUUID)
    return `${prefix}_${globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

function preview(value: unknown, max = 700) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const normalized = (text || '').replace(/\s+/g, ' ').trim()
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized
}

function toolNameFrom(tool: Tool) {
  const candidate = tool as Tool & { name?: string, function?: { name?: string } }
  return candidate.function?.name ?? candidate.name ?? ''
}

/**
 * Binds the Tool Mesh plan entrypoint to one immutable interaction.
 *
 * Use when:
 * - Final model-facing tools have been merged for a Lumi turn.
 * - Concurrent conversations must not read mutable foreground identity state.
 *
 * Expects:
 * - `interaction` was captured from the target session before enqueue.
 *
 * Returns:
 * - Tools with only the Tool Mesh plan entrypoint wrapped for this turn.
 */
export function bindLumiToolMeshToolsForTurn(
  tools: Tool[],
  interaction?: ChatInteractionContext,
  options: { allowPrivateLumiTools?: boolean } = {},
): Tool[] {
  const visibleTools = options.allowPrivateLumiTools
    ? tools
    : tools.filter(candidate => !toolNameFrom(candidate).startsWith('lumi_diary_'))
  if (!interaction)
    return visibleTools

  return visibleTools.flatMap((candidate) => {
    if (toolNameFrom(candidate) !== 'lumi_tool_mesh_run_plan')
      return [candidate]
    return [{
      ...candidate,
      execute: async (input, options) => await candidate.execute(input, {
        ...options,
        lumiToolMeshInteraction: interaction,
      } as typeof options & LumiToolMeshExecuteOptionsExtension),
    }]
  })
}

function extractJson(raw: string) {
  const fenceStart = raw.indexOf('```')
  const fencedContentStart = fenceStart >= 0 ? raw.indexOf('\n', fenceStart + 3) : -1
  const fenceEnd = fencedContentStart >= 0 ? raw.indexOf('```', fencedContentStart + 1) : -1
  if (fencedContentStart >= 0 && fenceEnd > fencedContentStart)
    return raw.slice(fencedContentStart + 1, fenceEnd).trim()
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first < 0 || last <= first)
    return ''
  return raw.slice(first, last + 1)
}

function boolFlags(overrides: Partial<Pick<LumiToolDefinition, 'canRead' | 'canWrite' | 'canExecuteProcess' | 'canAccessNetwork' | 'canModifySettings' | 'canTouchUserFiles' | 'canTouchLumiCore'>> = {}) {
  return {
    canRead: false,
    canWrite: false,
    canExecuteProcess: false,
    canAccessNetwork: false,
    canModifySettings: false,
    canTouchUserFiles: false,
    canTouchLumiCore: false,
    ...overrides,
  }
}

function def(input: Omit<LumiToolDefinition, keyof ReturnType<typeof boolFlags>> & Partial<ReturnType<typeof boolFlags>>): LumiToolDefinition {
  return {
    ...input,
    ...boolFlags(input),
  }
}

async function searchLongMemoryForToolMesh(store: ReturnType<typeof useLumiMemoryStore>, input: Record<string, unknown>) {
  const query = String(input.query ?? '')
  const limit = Math.max(1, Math.min(10, Number(input.limit) || 5))
  const semantic = await store.retrieveSemantic({
    query,
    userId: 'local',
    personaId: LUMI_AIRI_CARD_ID,
    limit,
    conversationType: 'direct',
  })
  const rankedMemories = semantic.rankedMemories.slice(0, limit)
  const bestEvidence = rankedMemories[0]?.memory

  return {
    ...semantic,
    rankedMemories,
    answerEvidence: bestEvidence
      ? {
          id: bestEvidence.id,
          type: bestEvidence.type,
          content: bestEvidence.content,
          tags: bestEvidence.tags,
          scope: bestEvidence.scope,
          disclosureReason: bestEvidence.disclosureReason,
        }
      : null,
    memories: rankedMemories.map(item => ({
      id: item.memory.id,
      type: item.memory.type,
      content: item.memory.content,
      tags: item.memory.tags,
      scope: item.memory.scope,
      disclosureReason: item.memory.disclosureReason,
      confidence: item.memory.confidence,
      importance: item.memory.importance,
      finalScore: item.finalScore,
      scoreBreakdown: item.scoreBreakdown,
    })),
    status: rankedMemories.length ? 'evidence_found' : 'no_reliable_answer_memory',
    resultCount: rankedMemories.length,
    vectorDebug: {
      vectorUsed: semantic.vectorUsed,
      vectorSource: semantic.vectorSource,
      vectorFallback: semantic.vectorFallback,
    },
    instruction: rankedMemories.length
      ? 'Use answerEvidence.content and memories[].content as the only long-term recall evidence. For exact recall questions, answer from the returned content verbatim or with a faithful direct summary. Do not invent details beyond them.'
      : 'No reliable long-term memory answered the query. Do not guess.',
  }
}

const CORE_TOOL_DEFINITIONS: LumiToolDefinition[] = [
  def({
    id: 'search_long_memory',
    name: '搜索长期记忆',
    description: '检索 Lumi 的长期记忆，用于过去共同经历、稳定偏好、承诺、项目连续性、具体回忆问题，以及当前可见对话未解释清楚的具体人名/昵称/账号/地点/项目/事件/关系。',
    capabilities: ['long_memory', 'semantic_search', 'recall_evidence'],
    examples: ['用户问“你还记得我喜欢哪个层级吗？”', '继续以前讨论过的项目'],
    inputSchema: { query: 'string', limit: 'number?' },
    outputSchema: { memories: 'array', status: 'string' },
    riskLevel: 'low',
    accessScopes: ['autonomous_life', 'proactive_vision'],
    executionMode: 'auto',
    status: 'implemented',
    implementationPath: 'packages/stage-ui/src/stores/lumi-memory.ts',
    canRead: true,
    suggestedCombinations: ['read_user_profile', 'search_lumi_self_projects', 'search_lumiworld_manifest'],
  }),
  def({
    id: 'write_long_memory_candidate',
    name: '提交长期记忆候选',
    description: '把有长期价值的事实提交为长期记忆候选；不应写入运行日志或短期情绪。',
    capabilities: ['long_memory', 'candidate_write'],
    examples: ['用户明确表达稳定偏好', '任务完成后记录长期项目事实'],
    inputSchema: { content: 'string', type: 'string?', confidence: 'number?', importance: 'number?', tags: 'string[]?' },
    outputSchema: { stored: 'boolean', memory: 'object|null' },
    riskLevel: 'medium',
    accessScopes: ['autonomous_life', 'diary'],
    executionMode: 'operator_present_auto',
    status: 'implemented',
    implementationPath: 'packages/stage-ui/src/stores/lumi-memory.ts',
    canRead: true,
    canWrite: true,
    suggestedCombinations: ['propose_user_profile_update', 'add_lumi_progress_note'],
  }),
  def({
    id: 'search_short_memory',
    name: '搜索短期意识状态',
    description: '读取 Lumi 当前短期意识状态，包括最近话题、用户近期状态、活跃项目、未完成事项和续接点。',
    capabilities: ['current_state', 'short_memory', 'context'],
    examples: ['用户问“我们刚刚聊到哪？”', '需要续接当前话题'],
    inputSchema: { query: 'string?' },
    outputSchema: { context: 'string', state: 'object' },
    riskLevel: 'low',
    accessScopes: ['chat', 'autonomous_life', 'proactive_vision'],
    executionMode: 'auto',
    status: 'implemented',
    implementationPath: 'packages/stage-ui/src/stores/lumi-current-state.ts',
    canRead: true,
  }),
  def({
    id: 'read_current_state',
    name: '读取 current_state',
    description: '完整读取当前短期意识状态运行时缓存。',
    capabilities: ['current_state', 'read'],
    examples: ['调试 Lumi 最近意识状态'],
    inputSchema: {},
    outputSchema: { state: 'object' },
    riskLevel: 'low',
    accessScopes: ['chat', 'debug', 'autonomous_life'],
    executionMode: 'auto',
    status: 'implemented',
    implementationPath: 'packages/stage-ui/src/stores/lumi-current-state.ts',
    canRead: true,
  }),
  def({
    id: 'update_current_state_candidate',
    name: '更新 current_state 候选',
    description: '更新短期意识状态。只用于近期上下文，不允许覆盖长期用户画像核心锚点。',
    capabilities: ['current_state', 'write'],
    examples: ['项目推进后更新当前活跃项目', '记录本轮续接点'],
    inputSchema: { patch: 'Partial<LumiCurrentState>' },
    outputSchema: { state: 'object' },
    riskLevel: 'medium',
    accessScopes: ['chat', 'autonomous_life', 'proactive_vision'],
    executionMode: 'operator_present_auto',
    status: 'implemented',
    implementationPath: 'packages/stage-ui/src/stores/lumi-current-state.ts',
    canRead: true,
    canWrite: true,
  }),
  def({
    id: 'read_user_profile',
    name: '读取相关用户画像',
    description: '按当前问题读取相关用户画像条目，避免全量注入画像。',
    capabilities: ['user_profile', 'relevant_context'],
    examples: ['根据用户偏好调整回复方式', '查询用户长期目标'],
    inputSchema: { query: 'string', limit: 'number?' },
    outputSchema: { context: 'string', entries: 'array' },
    riskLevel: 'low',
    accessScopes: ['chat', 'autonomous_life', 'proactive_vision'],
    executionMode: 'auto',
    status: 'implemented',
    implementationPath: 'packages/stage-ui/src/stores/lumi-user-profile.ts',
    canRead: true,
  }),
  def({
    id: 'propose_user_profile_update',
    name: '提交用户画像候选',
    description: '提交用户画像候选，受 protected/core/pending/auto review 规则约束。',
    capabilities: ['user_profile', 'candidate_write', 'evidence'],
    examples: ['用户明确说明长期目标', '多条证据支持近期关注变化'],
    inputSchema: { candidates: 'LumiUserProfileCandidate[]', sourceKind: 'string?' },
    outputSchema: { results: 'array' },
    riskLevel: 'medium',
    accessScopes: ['chat', 'diary', 'autonomous_life'],
    executionMode: 'operator_present_auto',
    status: 'implemented',
    implementationPath: 'packages/stage-ui/src/stores/lumi-user-profile.ts',
    canRead: true,
    canWrite: true,
  }),
  def({
    id: 'read_emotion_state',
    name: '读取 Lumi 情绪状态',
    description: '读取 Lumi 当前迁移情绪状态和关系门控预览。',
    capabilities: ['emotion', 'relationship_gate'],
    examples: ['解释 Lumi 当前为什么更安静', '调试关系门控'],
    inputSchema: { userText: 'string?' },
    outputSchema: { state: 'object', expression: 'string', gate: 'object' },
    riskLevel: 'low',
    accessScopes: ['chat', 'debug', 'autonomous_life'],
    executionMode: 'auto',
    status: 'implemented',
    implementationPath: 'packages/stage-ui/src/stores/lumi-emotion.ts',
    canRead: true,
  }),
]

const PLACEHOLDER_TOOL_DEFINITIONS: LumiToolDefinition[] = [
  'search_lumi_self_projects',
  'get_lumi_self_project',
  'get_lumi_self_todos',
  'get_next_lumi_todo',
  'create_lumi_self_project',
  'add_lumi_self_todo',
  'update_lumi_self_todo',
  'add_lumi_progress_note',
  'search_idea_pool',
  'add_lumi_idea',
  'convert_idea_to_project',
  'get_recent_life_events',
  'run_life_tick',
  'advance_self_project_step',
  'reflect_lumi_project',
  'read_rest_state',
  'set_rest_state',
  'search_lumiworld_manifest',
  'list_lumiworld_artifacts',
  'read_lumiworld_file',
  'write_lumiworld_file',
  'update_lumiworld_manifest',
  'search_diary',
  'read_diary_by_date',
  'write_diary_entry',
  'search_private_notes',
  'write_private_note',
  'get_runtime_logs',
  'get_autonomous_decision_log',
  'get_recent_tool_use_logs',
  'list_observation_sources',
  'observe_screen',
  'analyze_chat_images',
  'get_environment_context',
  'search_agent_tasks',
  'prepare_claude_code_task',
  'run_claude_code_task',
  'continue_claude_code_task',
  'cancel_claude_code_task',
  'get_claude_task_log',
  'open_claude_task_window',
  'read_lumi_settings',
  'adjust_lumi_settings',
  'read_tool_permissions',
  'set_operator_present_mode',
  'list_mcp_tools',
  'call_mcp_tool',
  'refresh_mcp_tools',
].map(id => def({
  id,
  name: id,
  description: 'Registered placeholder. A runtime package should override this definition with a concrete executor when available.',
  capabilities: [id],
  examples: [],
  inputSchema: {},
  outputSchema: {},
  riskLevel: id.includes('run_') || id.includes('write_') || id.includes('adjust_') || id.includes('call_') ? 'high' : 'low',
  accessScopes: ['chat', 'autonomous_life', 'proactive_vision', 'debug'],
  executionMode: id.includes('write_') || id.includes('run_') || id.includes('adjust_') || id.includes('call_') ? 'confirm' : 'auto',
  status: 'missing',
  canRead: !id.includes('write_') && !id.includes('run_') && !id.includes('adjust_') && !id.includes('call_'),
  canWrite: id.includes('write_') || id.includes('update_') || id.includes('add_') || id.includes('create_') || id.includes('set_'),
  canExecuteProcess: id.includes('claude') || id.includes('run_'),
  canAccessNetwork: id.includes('mcp') || id.includes('screen'),
  canModifySettings: id.includes('settings') || id.includes('operator'),
  canTouchUserFiles: id.includes('claude') || id.includes('file'),
  canTouchLumiCore: false,
}))

export function parseLumiModelDecision(raw: string): LumiModelDecision | null {
  const json = extractJson(raw)
  if (!json)
    return null
  try {
    const parsed = JSON.parse(json)
    if (parsed?.mode === 'direct_answer' && typeof parsed.answer === 'string')
      return { mode: 'direct_answer', answer: parsed.answer }
    if (parsed?.mode === 'use_tools' && Array.isArray(parsed.toolPlan)) {
      return {
        mode: 'use_tools',
        goal: String(parsed.goal || ''),
        reason: String(parsed.reason || ''),
        toolPlan: parsed.toolPlan.slice(0, MAX_TOOL_STEPS).map((step: any, index: number) => ({
          id: String(step.id || `step_${index + 1}`),
          toolId: String(step.toolId || ''),
          purpose: String(step.purpose || ''),
          input: step.input && typeof step.input === 'object' && !Array.isArray(step.input) ? step.input : {},
          dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : undefined,
          optional: Boolean(step.optional),
        })).filter((step: LumiToolPlanStep) => step.toolId),
      }
    }
  }
  catch {
    return null
  }
  return null
}

export function orderToolPlanSteps(steps: LumiToolPlanStep[]) {
  const remaining = new Map(steps.map(step => [step.id, step]))
  const done = new Set<string>()
  const ordered: LumiToolPlanStep[] = []
  const skipped: Array<{ stepId: string, toolId: string, reason: string }> = []

  while (remaining.size > 0) {
    let progressed = false
    for (const [id, step] of [...remaining]) {
      const deps = step.dependsOn ?? []
      const missingDeps = deps.filter(dep => !done.has(dep))
      if (missingDeps.length > 0)
        continue
      ordered.push(step)
      remaining.delete(id)
      done.add(id)
      progressed = true
    }
    if (!progressed) {
      for (const [id, step] of remaining) {
        skipped.push({
          stepId: id,
          toolId: step.toolId,
          reason: `Unresolved dependencies: ${(step.dependsOn ?? []).filter(dep => !done.has(dep)).join(', ') || 'cycle'}`,
        })
      }
      break
    }
  }

  return { ordered, skipped }
}

export function buildToolMeshUsageGuidance(toolSummary: string) {
  return [
    '[Lumi Full Tool Mesh]',
    '你可以组合使用工具，而不是只调用单个工具。',
    '重要：下面列出的都是 Tool Mesh 内部 toolId，不是可直接调用的 function/tool 名称。',
    '唯一可直接调用的 Tool Mesh 函数是 `lumi_tool_mesh_run_plan`。',
    '如果你要使用下面的内部工具，必须调用 `lumi_tool_mesh_run_plan`，并把内部工具名写进参数 `toolPlan[].toolId`。',
    '禁止直接调用 `list_lumiworld_artifacts`、`search_lumi_self_projects`、`read_lumiworld_file` 等内部 toolId；直接调用会失败。',
    '正确示例：调用 `lumi_tool_mesh_run_plan`，参数为 {"goal":"查看 LumiWorld","reason":"用户询问小角落","toolPlan":[{"id":"list","toolId":"list_lumiworld_artifacts","purpose":"列出 LumiWorld 内容","input":{"limit":20}}]}。',
    '当你缺少信息时，先想：1. 我缺什么？2. 哪个工具能查到？3. 是否应该先查索引，再读详情？4. 是否需要先查记忆，再查项目或文件？5. 工具结果是否足够？6. 是否需要继续调用下一个工具？',
    '你拥有很多内部工具，包括记忆、画像、Self Todo、Idea Pool、Life Tick、LumiWorld、日记、私密笔记、Decision Log、Claude Code、MCP、屏幕观察和设置工具。',
    '当用户问你的项目、想法、Todo、最近做了什么、某个作品是什么、为什么刚才不说话、你研究到哪一步时，不要凭空回答，应该主动组合调用相关工具。',
    '当用户提到当前可见对话未解释的具体人名、昵称、账号名、地点、项目、事件、共同经历或关系称谓，而你需要知道它是谁、是什么或与当前用户及相关人物的关系时，先用 `search_long_memory` 查长期记忆；不要直接猜成朋友、同事或某个模糊对象。',
    '普通闲聊不需要调用工具；涉及事实、历史、项目、文件、行动状态时，优先用工具取证。',
    '可用内部 toolId 摘要：',
    toolSummary || '- Tool Mesh 尚未完成运行时注册。',
    '[/Lumi Full Tool Mesh]',
  ].join('\n')
}

export const useLumiToolMeshStore = defineStore('lumi-tool-mesh', () => {
  const definitionsByProvider = ref<Record<string, LumiToolDefinition[]>>({})
  const executors = new Map<string, LumiToolExecutor>()
  const toolUseLogs = useLocalStorageManualReset<LumiToolUseLogEntry[]>('runtime/lumi/tool-mesh/tool-use-logs', [])
  const recentPlans = useLocalStorageManualReset<LumiToolPlanLogEntry[]>('runtime/lumi/tool-mesh/recent-plans', [])
  const operatorPresentMode = useLocalStorageManualReset('settings/lumi/tool-mesh/operator-present-mode', true)
  const waitingForConfirmation = ref(false)
  const lastInjectionSummary = ref('')
  const registeredLlmTool = ref(false)

  const definitions = computed(() => {
    const map = new Map<string, LumiToolDefinition>()
    for (const list of Object.values(definitionsByProvider.value)) {
      for (const item of list)
        map.set(item.id, item)
    }
    return [...map.values()].sort((left, right) => left.id.localeCompare(right.id))
  })
  const implementedDefinitions = computed(() => definitions.value.filter(item => item.status === 'implemented'))
  const definitionsByRisk = computed(() => definitions.value.reduce<Record<LumiToolRiskLevel, number>>((acc, item) => {
    acc[item.riskLevel] += 1
    return acc
  }, { low: 0, medium: 0, high: 0, critical: 0 }))

  function definitionById(id: string) {
    return definitions.value.find(item => item.id === id)
  }

  function registerToolDefinitions(provider: string, items: LumiToolDefinition[], providerExecutors: Record<string, LumiToolExecutor> = {}) {
    definitionsByProvider.value = {
      ...definitionsByProvider.value,
      [provider]: items.map(item => ({ ...item, suggestedCombinations: item.suggestedCombinations ? [...item.suggestedCombinations] : undefined })),
    }
    for (const [id, executor] of Object.entries(providerExecutors))
      executors.set(id, executor)
    syncLlmToolRegistration()
  }

  function clearProvider(provider: string) {
    const removed = definitionsByProvider.value[provider] ?? []
    const { [provider]: _removed, ...remaining } = definitionsByProvider.value
    definitionsByProvider.value = remaining
    for (const item of removed)
      executors.delete(item.id)
    syncLlmToolRegistration()
  }

  function appendToolLog(entry: Omit<LumiToolUseLogEntry, 'id' | 'createdAt'>) {
    toolUseLogs.value = [
      {
        id: createId('tool-log'),
        createdAt: nowIso(),
        ...entry,
      },
      ...toolUseLogs.value,
    ].slice(0, MAX_LOGS)
  }

  function appendPlanLog(entry: Omit<LumiToolPlanLogEntry, 'id' | 'createdAt'>) {
    recentPlans.value = [
      {
        id: createId('tool-plan'),
        createdAt: nowIso(),
        ...entry,
      },
      ...recentPlans.value,
    ].slice(0, 40)
  }

  function canExecute(definition: LumiToolDefinition, context: LumiToolExecutionContext): { ok: boolean, status?: LumiToolRunStatus, reason?: string } {
    if (definition.status === 'missing')
      return { ok: false, status: 'missing', reason: 'Tool is registered as missing.' }
    if (context.scope === 'chat' && CHAT_PRIVATE_TOOL_IDS.has(definition.id))
      return { ok: false, status: 'blocked', reason: 'Lumi-private diary, notes, and runtime records are unavailable in user-facing chat.' }
    if (context.conversationType === 'group' && GROUP_BLOCKED_TOOL_IDS.has(definition.id))
      return { ok: false, status: 'blocked', reason: 'Direct-user and private runtime tools are unavailable in group conversations.' }
    if (!definition.accessScopes.includes(context.scope))
      return { ok: false, status: 'blocked', reason: `Tool is not available in scope ${context.scope}.` }
    if (definition.executionMode === 'blocked')
      return { ok: false, status: 'blocked', reason: 'Tool execution mode is blocked.' }
    if (definition.riskLevel === 'critical' && !context.allowCritical)
      return { ok: false, status: 'pending_confirmation', reason: 'Critical tool requires explicit confirmation.' }
    if (definition.executionMode === 'confirm')
      return { ok: false, status: 'pending_confirmation', reason: 'Tool requires explicit confirmation.' }
    if (definition.executionMode === 'operator_present_auto' && !operatorPresentMode.value)
      return { ok: false, status: 'pending_confirmation', reason: 'Operator present mode is disabled.' }
    return { ok: true }
  }

  async function executeTool(toolId: string, input: Record<string, unknown> = {}, context: LumiToolExecutionContext): Promise<LumiToolExecutionResult> {
    const definition = definitionById(toolId)
    if (!definition) {
      const result: LumiToolExecutionResult = { toolId, status: 'missing', error: 'Tool is not registered.' }
      appendToolLog({
        scope: context.scope,
        source: context.source ?? 'unknown',
        toolId,
        toolName: toolId,
        status: result.status,
        riskLevel: 'low',
        inputPreview: preview(input),
        outputPreview: '',
        error: result.error,
      })
      return result
    }

    const allowed = canExecute(definition, context)
    if (!allowed.ok) {
      if (allowed.status === 'pending_confirmation')
        waitingForConfirmation.value = true
      const result: LumiToolExecutionResult = {
        toolId,
        status: allowed.status ?? 'blocked',
        blockedReason: allowed.reason,
        error: allowed.reason,
      }
      appendToolLog({
        scope: context.scope,
        source: context.source ?? 'unknown',
        toolId,
        toolName: definition.name,
        status: result.status,
        riskLevel: definition.riskLevel,
        inputPreview: preview(input),
        outputPreview: '',
        error: result.error,
      })
      return result
    }

    const executor = executors.get(toolId)
    if (!executor) {
      const result: LumiToolExecutionResult = {
        toolId,
        status: definition.status === 'partial' ? 'blocked' : 'missing',
        error: 'Tool has no executor in this runtime.',
      }
      appendToolLog({
        scope: context.scope,
        source: context.source ?? 'unknown',
        toolId,
        toolName: definition.name,
        status: result.status,
        riskLevel: definition.riskLevel,
        inputPreview: preview(input),
        outputPreview: '',
        error: result.error,
      })
      return result
    }

    try {
      const value = await executor(input, context, definition)
      const result: LumiToolExecutionResult = { toolId, status: 'success', result: value }
      appendToolLog({
        scope: context.scope,
        source: context.source ?? 'unknown',
        toolId,
        toolName: definition.name,
        status: result.status,
        riskLevel: definition.riskLevel,
        inputPreview: preview(input),
        outputPreview: preview(value),
      })
      return result
    }
    catch (error) {
      const message = errorMessageFrom(error) ?? 'Unknown tool execution error.'
      const result: LumiToolExecutionResult = { toolId, status: 'failed', error: message }
      appendToolLog({
        scope: context.scope,
        source: context.source ?? 'unknown',
        toolId,
        toolName: definition.name,
        status: result.status,
        riskLevel: definition.riskLevel,
        inputPreview: preview(input),
        outputPreview: '',
        error: message,
      })
      return result
    }
  }

  async function executeToolPlan(payload: { goal: string, reason?: string, toolPlan: LumiToolPlanStep[] }, context: LumiToolExecutionContext): Promise<LumiToolPlanExecutionResult> {
    const limitedSteps = payload.toolPlan.slice(0, context.maxSteps ?? MAX_TOOL_STEPS)
    appendPlanLog({
      scope: context.scope,
      source: context.source ?? 'unknown',
      goal: payload.goal,
      reason: payload.reason ?? '',
      steps: limitedSteps,
      status: 'planned',
    })

    const { ordered, skipped } = orderToolPlanSteps(limitedSteps)
    const executed: LumiToolExecutionResult[] = []

    for (const step of ordered) {
      const failedDeps = (step.dependsOn ?? []).filter(dep => executed.find(item => item.stepId === dep && item.status !== 'success'))
      if (failedDeps.length > 0 && !step.optional) {
        skipped.push({ stepId: step.id, toolId: step.toolId, reason: `Dependency failed: ${failedDeps.join(', ')}` })
        continue
      }
      const result = await executeTool(step.toolId, step.input, context)
      executed.push({ ...result, stepId: step.id, purpose: step.purpose })
      if (result.status !== 'success' && !step.optional)
        break
    }

    const successCount = executed.filter(item => item.status === 'success').length
    const hardFailure = executed.some(item => item.status !== 'success') || skipped.some(item => !limitedSteps.find(step => step.id === item.stepId)?.optional)
    const status = successCount === 0 && hardFailure ? 'failed' : hardFailure ? 'partial' : 'success'
    const summary = [
      `${successCount}/${limitedSteps.length} tool steps succeeded.`,
      executed.filter(item => item.status !== 'success').map(item => `${item.toolId}: ${item.error ?? item.blockedReason ?? item.status}`).join('; '),
      skipped.length ? `Skipped: ${skipped.map(item => `${item.toolId}(${item.reason})`).join('; ')}` : '',
    ].filter(Boolean).join(' ')

    lastInjectionSummary.value = summary
    appendPlanLog({
      scope: context.scope,
      source: context.source ?? 'unknown',
      goal: payload.goal,
      reason: payload.reason ?? '',
      steps: limitedSteps,
      status: status === 'failed' ? 'failed' : 'executed',
      resultSummary: summary,
    })

    return { goal: payload.goal, status, executed, skipped, summary }
  }

  function buildToolSummary(scope?: LumiToolAccessScope, conversationType?: ChatInteractionContext['conversationType']) {
    const items = definitions.value
      .filter(item => !scope || item.accessScopes.includes(scope))
      .filter(item => scope !== 'chat' || !CHAT_PRIVATE_TOOL_IDS.has(item.id))
      .filter(item => conversationType !== 'group' || !GROUP_BLOCKED_TOOL_IDS.has(item.id))
      .sort((left, right) => {
        const statusScore = (value: LumiToolStatus) => value === 'implemented' ? 0 : value === 'partial' ? 1 : 2
        return statusScore(left.status) - statusScore(right.status) || left.id.localeCompare(right.id)
      })
    return items.map(item => [
      `- internal toolId: ${item.id}`,
      `[${item.status}/${item.riskLevel}/${item.executionMode}]`,
      item.description,
      item.suggestedCombinations?.length ? `可组合: ${item.suggestedCombinations.join(', ')}` : '',
    ].filter(Boolean).join(' ')).join('\n')
  }

  function buildPromptGuidance(scope: LumiToolAccessScope = 'chat', conversationType?: ChatInteractionContext['conversationType']) {
    const guidance = buildToolMeshUsageGuidance(buildToolSummary(scope, conversationType))
    return conversationType === 'group'
      ? `${guidance}\n[Group Tool Boundary]\nDirect-user profiles, short-term state, diaries, private notes, and operator/runtime state are unavailable in group conversations. Use only group-visible conversation context and memories returned by the dedicated memory tool.\n[/Group Tool Boundary]`
      : guidance
  }

  function createToolMeshPlanTool(): Promise<Tool> {
    return tool({
      name: 'lumi_tool_mesh_run_plan',
      description: 'The only callable entrypoint for Lumi Tool Mesh internal toolIds. Execute a multi-step plan by putting internal tool ids such as search_long_memory, list_lumiworld_artifacts, search_lumi_self_projects, read_lumiworld_file, memory/profile/todo/diary/screen/agent/MCP tools into toolPlan[].toolId. Use search_long_memory for unresolved concrete people, nicknames, accounts, places, projects, events, or relationships not explained in visible chat. Never call those internal tool ids as standalone function names.',
      parameters: z.object({
        goal: z.string().min(1).max(500),
        reason: z.string().min(1).max(800),
        toolPlan: z.array(z.object({
          id: z.string().min(1).max(80),
          toolId: z.string().min(1).max(120),
          purpose: z.string().min(1).max(500),
          input: z.record(z.string(), z.unknown()).default({}),
          dependsOn: z.array(z.string()).optional(),
          optional: z.boolean().optional(),
        })).min(1).max(MAX_TOOL_STEPS),
      }).strict(),
      execute: async (payload, options) => {
        const interaction = (options as typeof options & LumiToolMeshExecuteOptionsExtension)?.lumiToolMeshInteraction
        const result = await executeToolPlan({
          goal: payload.goal,
          reason: payload.reason,
          toolPlan: payload.toolPlan.map(step => ({
            ...step,
            input: step.input ?? {},
          })),
        }, {
          scope: 'chat',
          source: 'llm_tool',
          conversationId: interaction?.conversationId,
          conversationType: interaction?.conversationType,
          actorId: interaction?.actorId,
          participantIds: interaction?.participantIds,
        })
        return JSON.stringify({
          ...result,
          instruction: result.status === 'failed'
            ? 'Do not pretend the tools succeeded. Use the error details honestly and say what is still missing.'
            : 'Use the successful tool results as evidence. Do not invent details beyond the returned results.',
        })
      },
    })
  }

  function syncLlmToolRegistration() {
    const toolsStore = useLlmToolsStore()
    const promptsStore = useLlmToolsetPromptsStore()
    void toolsStore.registerTools(PROVIDER, Promise.all([createToolMeshPlanTool()]))
    promptsStore.registerToolsetPrompts(PROVIDER, [{
      id: 'lumi-full-tool-mesh-guidance',
      title: 'Lumi Full Tool Mesh',
      content: buildPromptGuidance('chat'),
    }])
    registeredLlmTool.value = true
  }

  function initializeCoreTools() {
    registerToolDefinitions('lumi-tool-mesh-core', [...PLACEHOLDER_TOOL_DEFINITIONS, ...CORE_TOOL_DEFINITIONS], {
      search_long_memory: async (input) => {
        const store = useLumiMemoryStore()
        store.initialize()
        return await searchLongMemoryForToolMesh(store, input)
      },
      write_long_memory_candidate: (input) => {
        const store = useLumiMemoryStore()
        store.initialize()
        const memory = store.rememberCandidate({
          type: String(input.type || 'user_fact') as any,
          content: String(input.content || ''),
          confidence: Number(input.confidence) || 0.65,
          importance: Number(input.importance) || 0.55,
          emotionalIntensity: Number(input.emotionalIntensity) || 0.3,
          relationshipRelevance: Number(input.relationshipRelevance) || 0.5,
          decay: typeof input.decay === 'number' ? input.decay : undefined,
          tags: Array.isArray(input.tags) ? input.tags.map(String) : ['tool_mesh'],
        } as any)
        return { stored: Boolean(memory), memory }
      },
      search_short_memory: async (input) => {
        const store = useLumiCurrentStateStore()
        await store.initializePersistence()
        return { query: input.query ?? '', context: store.buildPromptContext(), state: store.currentState }
      },
      read_current_state: async () => {
        const store = useLumiCurrentStateStore()
        await store.initializePersistence()
        return { state: store.currentState }
      },
      update_current_state_candidate: async (input) => {
        const store = useLumiCurrentStateStore()
        await store.initializePersistence()
        const patch = input.patch && typeof input.patch === 'object' && !Array.isArray(input.patch) ? input.patch : input
        await store.saveCurrentState(patch as any)
        return { state: store.currentState }
      },
      read_user_profile: async (input) => {
        const store = useLumiUserProfileStore()
        await store.initializePersistence()
        const context = store.buildRelevantContext({
          messageText: String(input.query ?? input.messageText ?? ''),
          limit: Math.max(1, Math.min(12, Number(input.limit) || 8)),
        })
        return { context, entries: store.activeEntries }
      },
      propose_user_profile_update: async (input) => {
        const store = useLumiUserProfileStore()
        await store.initializePersistence()
        const candidates = Array.isArray(input.candidates) ? input.candidates : []
        const results = store.applyCandidates(candidates as any, {
          sourceKind: String(input.sourceKind || 'manual') as any,
          sourceMessageId: typeof input.sourceMessageId === 'string' ? input.sourceMessageId : undefined,
        })
        return { results }
      },
      read_emotion_state: (input) => {
        const store = useLumiEmotionStore()
        store.initialize()
        return {
          state: store.currentState,
          expression: store.previewExpression(String(input.userText ?? '')),
          gate: store.previewRelationshipGate(String(input.userText ?? '')),
        }
      },
      get_recent_tool_use_logs: input => ({
        logs: toolUseLogs.value.slice(0, Math.max(1, Math.min(50, Number(input.limit) || 20))),
      }),
      read_tool_permissions: () => ({
        operatorPresentMode: operatorPresentMode.value,
        definitions: definitions.value.map(item => ({
          id: item.id,
          riskLevel: item.riskLevel,
          executionMode: item.executionMode,
          status: item.status,
          accessScopes: item.accessScopes,
          canRead: item.canRead,
          canWrite: item.canWrite,
          canExecuteProcess: item.canExecuteProcess,
          canAccessNetwork: item.canAccessNetwork,
          canModifySettings: item.canModifySettings,
          canTouchUserFiles: item.canTouchUserFiles,
          canTouchLumiCore: item.canTouchLumiCore,
        })),
      }),
      set_operator_present_mode: (input) => {
        operatorPresentMode.value = Boolean(input.enabled)
        return { operatorPresentMode: operatorPresentMode.value }
      },
    })
  }

  function resetLogs() {
    toolUseLogs.value = []
    recentPlans.value = []
    lastInjectionSummary.value = ''
    waitingForConfirmation.value = false
  }

  return {
    definitions,
    implementedDefinitions,
    definitionsByProvider,
    definitionsByRisk,
    toolUseLogs,
    recentPlans,
    operatorPresentMode,
    waitingForConfirmation,
    lastInjectionSummary,
    registeredLlmTool,
    registerToolDefinitions,
    clearProvider,
    definitionById,
    executeTool,
    executeToolPlan,
    buildToolSummary,
    buildPromptGuidance,
    createToolMeshPlanTool,
    syncLlmToolRegistration,
    initializeCoreTools,
    resetLogs,
  }
})
