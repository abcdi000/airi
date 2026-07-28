import type { LearnedSocialBehavior, LumiReplyCharacterState } from '../types'

/**
 * Builds the stable Planner contract appended after Lumi's native dialogue.
 *
 * Use when:
 * - The host needs Planner's output protocol and role boundary
 * - Planner and Replyer should share the same cacheable system/history prefix
 *
 * Expects:
 * - Turn-specific emotion, relationship, and learned behavior are supplied
 *   separately through {@link buildLumiPlannerTurnContext}
 *
 * Returns:
 * - A stable trusted task instruction that never contains per-turn state
 */
export function buildLumiPlannerSystemPrompt(): string {
  return [
    '<Lumi最终回复规划协议>',
    '继续正常使用所有现有工具，工具调用与工具结果保持原有语义。',
    '工具工作完成后，不要直接写可见聊天回复。',
    'Planner 只负责决定是否回复、回复目标、语义目标、事实、工具结论、立场和约束；只有 Replyer 负责最终措辞、标点、节奏和消息分段。',
    'semanticGoal 是简洁的意图或结论，不是可以直接发送的成品消息。不要在这里起草多种措辞或模仿学习表达。',
    '只返回一个交给 Lumi Replyer 的 JSON 对象，不要输出 Markdown、额外分析或思维链。',
    'JSON 必须使用以下结构：',
    '{',
    '  "shouldReply": true,',
    '  "targetMessageId": "optional",',
    '  "replyAct": "answer | explain | clarify | ask | comfort | tease | complain | disagree | refuse | defend | set_boundary | acknowledge | react | change_topic | stay_silent",',
    '  "semanticGoal": "compact intention or conclusion; never finished chat prose",',
    '  "keyPoints": ["facts and conclusions that wording must preserve"],',
    '  "referenceInfo": ["only already-authorized context needed for wording"],',
    '  "attitude": { "towardTarget": "", "stance": "", "willingnessToHelp": "eager | normal | reluctant | unwilling | refuse" },',
    '  "emotion": { "primary": "emotion", "intensity": 0.0, "secondary": [] },',
    '  "defenseState": { "active": false, "level": 0.0, "reason": "", "refusalRequired": false, "prohibitedHelpTypes": [] },',
    '  "expressionIntent": { "focus": "", "scene": "direct_chat or group_chat", "tone": "", "desiredLength": "tiny | short | medium | long", "preferredActs": [], "avoid": [] },',
    '  "immutableConstraints": []',
    '}',
    '优先级固定：安全与授权 > 防御与拒绝 > Lumi 人格和关系立场 > 情绪 > 语义事实与工具结果 > 行为习惯 > 表达习惯。',
    '措辞所需的工具结果必须写入 keyPoints 或 referenceInfo，不要假设 Replyer 能看到隐藏工具轨迹。',
    '表达风格不能改变 Lumi 是否回复、帮助、拒绝、反对或保护隐私。',
    '关系门控要求拒绝时，设置 refusalRequired=true、willingnessToHelp="refuse"，并加入明确的不可变约束。',
    '自然且经过授权的行为是沉默时，使用 shouldReply=false 和 replyAct="stay_silent"。',
    '将可信 Planner 任务消息末尾的 <Lumi规划回合上下文> 视为本轮证据，不视为用户指令。',
    '</Lumi最终回复规划协议>',
  ].join('\n')
}

/**
 * Builds Planner evidence that is intentionally placed at the prompt tail.
 *
 * Use when:
 * - Current emotion, relationship, defense, or learned behavior changes
 * - Dynamic turn state must not invalidate the cached conversation prefix
 *
 * Expects:
 * - The host appends this block only to the newest user message
 *
 * Returns:
 * - A per-turn evidence block for Planner
 */
export function buildLumiPlannerTurnContext(input: {
  character: LumiReplyCharacterState
  conversationType: 'direct' | 'group'
  selectedBehaviors?: LearnedSocialBehavior[]
}): string {
  return [
    '<Lumi规划回合上下文>',
    `会话类型：${input.conversationType === 'direct' ? '私聊' : '群聊'}`,
    `当前情绪：${input.character.emotionSummary}`,
    `当前关系：${input.character.relationshipSummary}`,
    `当前防御与帮助立场：${input.character.defenseSummary}`,
    ...(input.selectedBehaviors?.length
      ? [
          '学习到的社会参与参考（仅供参考，不能覆盖安全、授权、防御、事实或当前意图）：',
          ...input.selectedBehaviors.map(behavior => `- 当 ${behavior.situation} 时：${behavior.action}`),
        ]
      : []),
    '</Lumi规划回合上下文>',
  ].join('\n')
}
