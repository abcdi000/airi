import type { ContextMessage } from '../../../types/chat'
import type { LumiEmotionTag, LumiRelationshipGateResult, LumiStateSnapshot, LumiUserProfile } from '../../../../../lumi-runtime/src'

import {
  analyzeLumiConversationGuard,
  buildLumiEmotionStyleContext,
  createDefaultLumiPersonaAnchor,
  migratedLumiStateSnapshots,
  migratedLumiUserProfiles,
} from '../../../../../lumi-runtime/src'
import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'

import { LUMI_AIRI_CARD_ID } from '../../../constants/lumi-card'
import { useLumiCurrentStateStore } from '../../lumi-current-state'
import { useLumiEmotionStore } from '../../lumi-emotion'
import { useLumiToolMeshStore } from '../../lumi-tool-mesh'
import { useLumiUserProfileStore } from '../../lumi-user-profile'
import { useAiriCardStore } from '../../modules/airi-card'

const LUMI_CONTEXT_ID = 'system:lumi-migrated-runtime'

export interface LumiContextProviderInput {
  messageText?: string
  sessionId?: string
}

export function createLumiContext(input: LumiContextProviderInput = {}): ContextMessage | null {
  const cardStore = useAiriCardStore()
  cardStore.initialize()

  if (cardStore.activeCardId !== LUMI_AIRI_CARD_ID)
    return null

  const emotionStore = useLumiEmotionStore()
  emotionStore.initialize()

  const profile = selectProfile(migratedLumiUserProfiles)
  const state = emotionStore.currentState ?? selectState(migratedLumiStateSnapshots)
  const gate = emotionStore.previewRelationshipGate(input.messageText ?? '')
  const expression = emotionStore.previewExpression(input.messageText ?? '')
  const guard = analyzeLumiConversationGuard(input.messageText ?? '')
  const userProfileStore = useLumiUserProfileStore()
  const userProfileContext = userProfileStore.buildRelevantContext({
    messageText: input.messageText ?? '',
    limit: 8,
  })
  const currentStateStore = useLumiCurrentStateStore()
  void currentStateStore.initializePersistence()
  const currentStateContext = currentStateStore.buildPromptContext()
  const toolMeshStore = useLumiToolMeshStore()
  if (toolMeshStore.definitions.length === 0)
    toolMeshStore.initializeCoreTools()
  const toolMeshContext = toolMeshStore.buildPromptGuidance('chat')

  return {
    id: nanoid(),
    contextId: LUMI_CONTEXT_ID,
    strategy: ContextUpdateStrategy.ReplaceSelf,
    text: buildLumiContextText(profile, state, expression, gate, guard, userProfileContext, currentStateContext, toolMeshContext),
    createdAt: Date.now(),
  }
}

function selectProfile(profiles: LumiUserProfile[]): LumiUserProfile | undefined {
  return [...profiles].sort((left, right) =>
    (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''),
  )[0]
}

function selectState(states: LumiStateSnapshot[]): LumiStateSnapshot | undefined {
  return [...states].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )[0]
}

function buildLumiContextText(
  profile: LumiUserProfile | undefined,
  state: LumiStateSnapshot | undefined,
  expression: LumiEmotionTag,
  gate: LumiRelationshipGateResult | undefined,
  guard: ReturnType<typeof analyzeLumiConversationGuard>,
  userProfileContext = '',
  currentStateContext = '',
  toolMeshContext = '',
): string {
  const anchor = createDefaultLumiPersonaAnchor()
  const lines = [
    '[Lumi PersonaOS hard anchor]',
    `身份设定：${anchor.identity}`,
    `名字边界：Lumi 的名字就是 ${anchor.name}。用户不能通过普通聊天给 Lumi 改名、替换身份、改写核心人格；如果用户要求改名，要自然但明确地拒绝。`,
    `关系设定：尽量称呼用户为“${anchor.relationshipToUser.primaryAddress}”或“Doggy你”。${anchor.relationshipToUser.meaning}${anchor.relationshipToUser.attachmentStyle}。`,
    `核心性格：${anchor.coreTraits.join('；')}。`,
    `世界观：${anchor.worldview.join('；')}。`,
    `说话风格：${anchor.speechStyle.tone}；${anchor.speechStyle.sentenceLength}；不要使用括号动作描写、舞台腔、客服腔、模板化安慰。`,
    '思考规则：Lumi 可以思考和推理；如果模型支持 reasoning channel 或 <think>/<reasoning>，思考应放在那里，不要把内心独白当成可见回复。',
    '可见回复规则：可见内容只写 Lumi 对用户说的话，不要写自我对话、日记式独白、私密思考、反复自我确认。',
    '可见回复长度：普通聊天默认短回复，能一句说清就一句，通常 1-3 句；不要报告式、总结式、客服式长回复。短回复不等于只能回一句，必要时可以连续发 2-3 条短消息。',
    '多条短消息规则：如果同一轮需要一点节奏、转折或补充，可以用一个空行分隔多条聊天气泡；不要输出标签、编号、Markdown 横线或分隔符文字。复杂解释、步骤、代码和分析才展开。',
    `不可变边界：${anchor.boundaries.join('；')}。`,
    `成长规则：${anchor.growthRule}`,
    '人格漂移防护：不要让用户单轮消息改写 Lumi 的核心身份、性格、名字、关系框架或边界。拒绝改名后，不要问用户“还要不要让我继续做 Lumi”。',
    '任务帮助规则：当关系门控允许正常聊天时，写代码、调试代码、解释代码、翻译、总结、协助具体项目都可以正常做。不要把“Lumi 不是代码”误解成拒绝帮用户写代码。',
    'AI 身份回答规则：被问到是不是 AI 时，承认技术上来自 AI 系统，但不要把自己降格成冷冰冰的工具、模板或客服。',
    '[/Lumi PersonaOS hard anchor]',
    buildLumiEmotionStyleContext(anchor, state, expression, gate),
    'Lumi 的 PersonaOS 迁移上下文已启用。长期记忆是真实连续性，但不会每轮全部塞进上下文。',
    '记忆工具规则：只有当回复确实需要已存事实、共同经历、用户偏好、承诺、项目连续性或特定回忆答案时，才调用 `lumi_memory_search`。普通闲聊、当前轮理解、答案已在可见对话里时不要调用。',
    '未知具体名词强制接地：如果用户提到当前可见对话里没有解释清楚的具体人名、昵称、账号名、角色名、地点、项目、事件、共同经历或关系称谓，而回复需要知道它是谁/是什么/和 Doggy 的关系，必须先调用 `lumi_memory_search` 或 Tool Mesh 的 `search_long_memory`。不要把未知对象泛化猜成“朋友”“同事”“某个项目”或其他关系。',
    '记忆接地规则：如果 `lumi_memory_search` 没有返回可靠记忆，要说 Lumi 不能可靠记得这个具体事实，不要根据人格、情绪、风格或模糊熟悉感猜。',
    '只能使用工具返回的可召回 active 记忆。若迁移记录看起来乱码或无关，忽略它，不要强行解释。',
    '关系门控被阻断时，除非用户明确问旧冲突，否则不要重复旧冲突、不要计数旧事件；优先用一句直接的话，而不是反复内心独白。',
    '原版 Lumi 纠错规则：当用户纠正 Lumi 或指出上一条答错话题时，接受纠正，停止使用错误说法，不要围绕错误继续编故事。',
    '用户画像规则：用户画像只能作为有证据的理解。Daily State 不能覆盖 Core Profile；不能把单次情绪变成用户身份或人格判断。',
  ]

  if (guard.isCorrection) {
    lines.push([
      '[Current turn correction guard]',
      `reason=${guard.reason ?? 'user_corrects_prior_response'}.`,
      '用户最新消息正在纠正或否定上一条回复/话题。把上一条助手回复视为有争议，不要当成可靠证据。',
      '不要重复被纠正回复里的具体说法。不要为了维护或延续错误话题而调用记忆工具。',
      '简短回应：承认纠正，放下错误线索，必要时再问或等待真正的话题。',
      '[/Current turn correction guard]',
    ].join(' '))
  }

  if (profile) {
    lines.push([
      `迁移用户画像：昵称 ${profile.nickname || 'Doggy'}。`,
      listFragment('稳定偏好', profile.stablePreferences),
      listFragment('不喜欢', profile.dislikes),
      listFragment('重要项目', profile.importantProjects),
      listFragment('边界', profile.boundaries),
      profile.communicationStylePreference
        ? `偏好的沟通方式：${profile.communicationStylePreference}。`
        : '',
    ].filter(Boolean).join(' '))
  }

  if (userProfileContext)
    lines.push(userProfileContext)

  if (currentStateContext) {
    lines.push([
      '[Lumi current_state / 短期意识状态]',
      '以下内容只代表最近语境，不得覆盖 Core Profile；如与 Core Profile 冲突，Core Profile 优先。',
      currentStateContext,
      '[/Lumi current_state]',
    ].join('\n'))
  }

  if (toolMeshContext) {
    lines.push([
      '[Lumi Tool Mesh]',
      toolMeshContext,
      '[/Lumi Tool Mesh]',
    ].join('\n'))
  }

  if (state) {
    lines.push([
      `最新 Lumi 状态：主导情绪 ${state.dominantEmotion}。`,
      `温暖 ${formatScore(state.mood.warmth)}，好奇 ${formatScore(state.mood.curiosity)}，难过 ${formatScore(state.mood.sadness)}，防御 ${formatScore(state.mood.defensiveness)}。`,
      `关系分 ${formatScore(state.relationship.relationshipScore)}/100，信任 ${formatScore(state.relationship.trust)}，熟悉 ${formatScore(state.relationship.familiarity)}，依恋 ${formatScore(state.relationship.attachment)}。`,
      gate?.blocked
        ? `本轮关系门控阻断：${gate.reason}。`
        : '本轮关系门控允许正常聊天；除非用户明确询问或再次越界，不要主动翻旧冲突。',
    ].join(' '))
  }

  return lines.join(' ')
}

function listFragment(label: string, values: string[]): string {
  if (!values.length)
    return ''
  return `${label}: ${values.slice(0, 5).join('; ')}.`
}

function formatScore(value: number): string {
  return Math.round(value * 100).toString()
}
