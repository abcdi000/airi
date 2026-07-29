import type {
  LumiCognitiveLifecycle,
  LumiFeedbackEvent,
  LumiFeedbackKind,
} from './types'

/**
 * Classifies only explicit user feedback; ambiguous acknowledgements remain unclassified.
 *
 * Use when:
 * - A verified user message follows a Lumi reply or decision
 *
 * Expects:
 * - Plain user-visible text
 *
 * Returns:
 * - One or more explicit feedback categories, or an empty list
 */
export function classifyExplicitLumiFeedback(text: string): LumiFeedbackKind[] {
  const normalized = text.trim().toLowerCase()
  if (!normalized || /^(?:嗯+|对的?|好的?|行|可以|ok|okay)[。.!！?？~～]*$/i.test(normalized))
    return []

  const result = new Set<LumiFeedbackKind>()
  if (/说得好|做得好|很好|太棒了|厉害|谢谢你|这次不错/.test(normalized))
    result.add('explicit_praise')
  if (/别这样|不要这样|我拒绝|不需要|停下|别再/.test(normalized))
    result.add('explicit_rejection')
  if (/你这样说.*自然|自然多了|这才像人|这句不错/.test(normalized))
    result.add('expression_natural')
  if (/ai味|机器人味|太机械|太模板|不像人/i.test(normalized))
    result.add('expression_ai_like')
  if (/你又重复|别重复|说过了|怎么又是这句/.test(normalized))
    result.add('expression_repeated')
  if (/不是这样|你记错了|纠正一下|应该是|其实是/.test(normalized))
    result.add('fact_correction')
  if (/换个话题|说点别的|不说这个|先不聊这个/.test(normalized))
    result.add('topic_switched')
  if (/就按这个|确认这个|这个方案可以|决定了/.test(normalized))
    result.add('decision_confirmed')
  if (/撤销|反悔|不按这个|取消这个决定/.test(normalized))
    result.add('decision_revoked')
  return [...result]
}

/**
 * Applies explicit feedback to shared lifecycle counters without changing access scope.
 *
 * Use when:
 * - Expression, behavior, strategy, or belief reducers consume a Feedback Bus event
 *
 * Expects:
 * - The caller has already verified the event targets this asset
 *
 * Returns:
 * - Updated lifecycle metrics; ownership never increases from Lumi self-output alone
 */
export function reduceLumiFeedbackLifecycle(
  lifecycle: LumiCognitiveLifecycle,
  event: LumiFeedbackEvent,
): LumiCognitiveLifecycle {
  const positive = event.kind === 'explicit_praise'
    || event.kind === 'expression_natural'
    || event.kind === 'decision_confirmed'
    || event.kind === 'tool_succeeded'
  const negative = event.kind === 'explicit_rejection'
    || event.kind === 'expression_ai_like'
    || event.kind === 'expression_repeated'
    || event.kind === 'decision_revoked'
    || event.kind === 'tool_failed'
  if (!positive && !negative)
    return { ...lifecycle, lastSeenAt: event.occurredAt }

  const strength = clamp01(event.strength)
  return {
    ...lifecycle,
    confidence: clamp01(lifecycle.confidence + (positive ? 0.08 : -0.16) * strength),
    stability: clamp01(lifecycle.stability + (positive ? 0.04 : -0.1) * strength),
    positiveFeedback: lifecycle.positiveFeedback + (positive ? 1 : 0),
    negativeFeedback: lifecycle.negativeFeedback + (negative ? 1 : 0),
    rejectionCount: lifecycle.rejectionCount + (event.kind === 'explicit_rejection' ? 1 : 0),
    lastSeenAt: event.occurredAt,
  }
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}
