import type { LearnedExpression, SocialLanguageTurnContext } from '../types'

/** Builds a compact optional precise-selector request over broad retrieval candidates. */
export function buildExpressionSelectorMessages(
  context: SocialLanguageTurnContext,
  candidates: LearnedExpression[],
  maximum: number,
  systemPromptOverride?: string,
): Array<{ role: 'system' | 'user', content: string }> {
  return [
    {
      role: 'system',
      content: systemPromptOverride?.trim() || [
        '你是 Lumi 意识侧的表达选择器，不负责写最终回复。',
        `从候选中选择 0 到 ${maximum} 个 ID；不选择任何候选是正常结果。`,
        '有些候选只是已经理解但从未使用；只有与当前场景自然契合时，才可以主动试用一个。',
        '试用只是实验，不是义务；绝不能为了收集反馈而强塞口癖。',
        '拒绝与严肃程度、关系距离、防御状态、情绪或语义行为冲突的表达。',
        '表达风格不得软化拒绝或改变事实。',
        '只返回严格 JSON：{"selectedIds":["id"],"reasons":{"id":"简短原因"}}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        scene: {
          text: context.currentUserText,
          replyAct: context.replyIntent.replyAct,
          expressionIntent: context.replyIntent.expressionIntent,
          emotion: context.replyIntent.emotion,
          defense: context.replyIntent.defenseState,
          conversationType: context.conversationType,
          platform: context.platform,
        },
        candidates: candidates.map(candidate => ({
          id: candidate.id,
          phrase: candidate.phrase,
          situation: candidate.situation,
          pragmaticFunction: candidate.pragmaticFunction,
          tone: candidate.tone,
          status: candidate.status,
          observationCount: candidate.observationCount,
          useCount: candidate.useCount,
          successfulUseCount: candidate.successfulUseCount,
          ownership: candidate.ownership,
          familiarity: candidate.familiarity,
          confidence: candidate.confidence,
        })),
      }),
    },
  ]
}
