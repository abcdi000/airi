import type {
  LumiBeliefHypothesis,
  LumiCognitiveEvidence,
  LumiCognitiveProfileLayer,
  LumiCognitiveProfileProjection,
} from './types'

/** Input used to create or update one hypothesis. */
export interface LumiHypothesisObservation {
  /** Person or Lumi identity described by the observation. */
  subjectId: string
  /** Stable semantic predicate. */
  predicate: string
  /** Host-validated value. */
  value: unknown
  /** Evidence record supporting or correcting the value. */
  evidence: LumiCognitiveEvidence
  /** Optional TTL in milliseconds. @default 604800000 */
  ttlMs?: number
}

/**
 * Applies one evidence-backed observation to a temporary hypothesis.
 *
 * Use when:
 * - Fast-loop host logic receives a trusted user statement or correction
 * - Medium-loop consolidation adds independently sourced evidence
 *
 * Expects:
 * - `existing`, when supplied, has the same subject and predicate
 * - Derived evidence retains its parent evidence IDs
 *
 * Returns:
 * - A tentative, supported, stable, or contradicted hypothesis
 */
export function observeLumiBeliefHypothesis(
  existing: LumiBeliefHypothesis | undefined,
  observation: LumiHypothesisObservation,
): LumiBeliefHypothesis {
  const now = observation.evidence.occurredAt
  const sameValue = existing ? equalValue(existing.value, observation.value) : true
  const isCorrection = observation.evidence.kind === 'user_correction'
  const supports = sameValue && !isCorrection
  const evidenceIds = supports
    ? uniqueStrings([...(existing?.evidenceIds ?? []), observation.evidence.id])
    : [...(existing?.evidenceIds ?? [])]
  const counterEvidenceIds = supports
    ? [...(existing?.counterEvidenceIds ?? [])]
    : uniqueStrings([...(existing?.counterEvidenceIds ?? []), observation.evidence.id])
  const evidenceCount = evidenceIds.length
  const independentEvidenceCount = countIndependentEvidenceIds(evidenceIds)
  const correctionPenalty = isCorrection && !sameValue ? observation.evidence.trust : 0
  const confidence = clamp01(
    (existing?.confidence ?? 0.25)
    + (supports ? 0.2 * observation.evidence.trust : -0.65 * correctionPenalty),
  )
  const stability = clamp01(
    (existing?.stability ?? 0.1)
    + (supports ? 0.2 * Math.min(1, independentEvidenceCount) : -0.7 * correctionPenalty),
  )
  const status = !supports && (isCorrection || confidence < 0.2)
    ? 'contradicted'
    : independentEvidenceCount >= 3 && confidence >= 0.78 && stability >= 0.65
      ? 'stable'
      : independentEvidenceCount >= 2 && confidence >= 0.55
        ? 'supported'
        : 'tentative'

  return {
    id: existing?.id ?? `belief:${observation.subjectId}:${stableKey(observation.predicate)}`,
    subjectId: observation.subjectId,
    predicate: observation.predicate.trim(),
    value: existing && !supports ? existing.value : observation.value,
    confidence,
    stability,
    evidenceIds,
    counterEvidenceIds,
    firstObservedAt: existing?.firstObservedAt ?? now,
    lastObservedAt: now,
    expiresAt: new Date(Date.parse(now) + (observation.ttlMs ?? 7 * 24 * 60 * 60 * 1000)).toISOString(),
    status,
    scope: existing?.scope ?? observation.evidence.scope,
    sensitivity: existing?.sensitivity ?? observation.evidence.sensitivity,
    conversationId: existing?.conversationId ?? observation.evidence.conversationId,
    participantUserIds: uniqueStrings([
      ...(existing?.participantUserIds ?? []),
      ...observation.evidence.participantUserIds,
    ]),
    evidenceCount,
    independentEvidenceCount,
    familiarity: clamp01((existing?.familiarity ?? 0) + (supports ? 0.08 : 0)),
    ownership: existing?.ownership ?? 0,
    positiveFeedback: existing?.positiveFeedback ?? 0,
    negativeFeedback: (existing?.negativeFeedback ?? 0) + (supports ? 0 : 1),
    rejectionCount: (existing?.rejectionCount ?? 0) + (isCorrection && !supports ? 1 : 0),
    firstSeenAt: existing?.firstSeenAt ?? now,
    lastSeenAt: now,
    lastUsedAt: existing?.lastUsedAt,
    decay: existing?.decay ?? 0,
  }
}

/**
 * Applies time decay and expiry without turning old inference into a fact.
 *
 * Use when:
 * - Slow-loop maintenance runs
 *
 * Expects:
 * - ISO timestamps
 *
 * Returns:
 * - A decayed or expired hypothesis
 */
export function decayLumiBeliefHypothesis(
  hypothesis: LumiBeliefHypothesis,
  now = new Date().toISOString(),
): LumiBeliefHypothesis {
  if (hypothesis.status === 'contradicted')
    return hypothesis
  if (hypothesis.expiresAt && Date.parse(hypothesis.expiresAt) <= Date.parse(now)) {
    return {
      ...hypothesis,
      status: 'expired',
      confidence: clamp01(hypothesis.confidence * 0.5),
      stability: clamp01(hypothesis.stability * 0.75),
      decay: clamp01(hypothesis.decay + 0.25),
    }
  }
  const elapsedDays = Math.max(0, (Date.parse(now) - Date.parse(hypothesis.lastObservedAt)) / 86_400_000)
  const decay = clamp01(hypothesis.decay + elapsedDays * 0.015)
  return {
    ...hypothesis,
    confidence: clamp01(hypothesis.confidence * (1 - Math.min(0.35, elapsedDays * 0.01))),
    decay,
  }
}

/**
 * Materializes profile projections from evidence-backed hypotheses.
 *
 * Use when:
 * - Medium or slow loops rebuild Daily, Dynamic, and Core profile views
 *
 * Expects:
 * - Expired and contradicted hypotheses may be present and are filtered
 * - `evidenceById` contains auditable source records where available
 *
 * Returns:
 * - Active or pending projections with complete belief/evidence lineage
 */
export function projectLumiBeliefsToProfile(input: {
  subjectId: string
  beliefs: readonly LumiBeliefHypothesis[]
  evidenceById: ReadonlyMap<string, LumiCognitiveEvidence>
  now?: string
}): LumiCognitiveProfileProjection[] {
  const now = input.now ?? new Date().toISOString()
  return input.beliefs
    .filter(belief => belief.subjectId === input.subjectId)
    .filter(belief => belief.status !== 'expired' && belief.status !== 'contradicted')
    .flatMap((belief) => {
      const evidence = belief.evidenceIds
        .map(id => input.evidenceById.get(id))
        .filter((item): item is LumiCognitiveEvidence => Boolean(item))
      const layer = profileLayer(belief, evidence)
      if (!layer)
        return []
      const explicitConfirmation = evidence.some(item =>
        item.authorVerified
        && item.origin === 'primary'
        && (item.kind === 'user_statement' || item.kind === 'user_correction')
        && item.trust >= 0.9,
      )
      const pending = layer === 'core' && (
        !explicitConfirmation
        || belief.stability < 0.8
        || highImpactPredicate(belief.predicate)
      )
      return [{
        id: `profile:${belief.id}:${layer}`,
        subjectId: belief.subjectId,
        layer,
        key: belief.predicate,
        value: printableValue(belief.value),
        beliefIds: [belief.id],
        evidenceIds: [...belief.evidenceIds],
        confidence: belief.confidence,
        stability: belief.stability,
        expiresAt: layer === 'core' ? undefined : belief.expiresAt,
        status: pending ? 'pending' as const : 'active' as const,
        scope: belief.scope,
        sensitivity: belief.sensitivity,
        updatedAt: now,
      }]
    })
}

function profileLayer(
  belief: LumiBeliefHypothesis,
  evidence: LumiCognitiveEvidence[],
): LumiCognitiveProfileLayer | undefined {
  if (belief.predicate.startsWith('current_') || belief.predicate === 'mood')
    return belief.expiresAt ? 'daily' : undefined
  const explicitProjectState = /project|goal|decision|focus|unresolved/i.test(belief.predicate)
    && evidence.some(item => item.authorVerified && item.origin === 'primary')
  if (belief.independentEvidenceCount >= 2 || explicitProjectState)
    return belief.status === 'stable' && belief.independentEvidenceCount >= 3 ? 'core' : 'dynamic'
  return undefined
}

function highImpactPredicate(predicate: string) {
  return /identity|personality|boundary|relationship|life_decision|long_term/i.test(predicate)
}

function countIndependentEvidenceIds(ids: string[]) {
  return new Set(ids.map(id => id.split(':').slice(0, -1).join(':') || id)).size
}

function equalValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function printableValue(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function stableKey(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4E00-\u9FFF]+/g, '-')
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}
