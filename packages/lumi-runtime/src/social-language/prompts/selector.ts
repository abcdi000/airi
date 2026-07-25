import type { LearnedExpression, SocialLanguageTurnContext } from '../types'

/** Builds a compact optional precise-selector request over broad retrieval candidates. */
export function buildExpressionSelectorMessages(
  context: SocialLanguageTurnContext,
  candidates: LearnedExpression[],
  maximum: number,
): Array<{ role: 'system' | 'user', content: string }> {
  return [
    {
      role: 'system',
      content: [
        'You are Lumi\'s consciousness-side expression selector. You do not write the reply.',
        `Select zero to ${maximum} candidate IDs. Empty selection is normal.`,
        'Some candidates are understood but never used. You may deliberately trial one only when it naturally fits this exact scene.',
        'A trial is an experiment, not an obligation: never force a catchphrase merely to collect feedback.',
        'Reject expressions that clash with seriousness, relationship distance, defense, emotion, or semantic act.',
        'Expression style must never soften refusal or change facts.',
        'Return strict JSON only: {"selectedIds":["id"],"reasons":{"id":"short reason"}}',
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
