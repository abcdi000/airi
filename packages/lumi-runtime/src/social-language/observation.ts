import type {
  SocialLanguageGroupObservation,
  SocialLanguageObservationBatch,
  SocialLanguageSnapshot,
} from './types'

/** Adds one deduplicated observation without exposing it to chat history. */
export function enqueueGroupObservation(
  snapshot: SocialLanguageSnapshot,
  observation: SocialLanguageGroupObservation,
  maximumHistory = 1_000,
): SocialLanguageSnapshot {
  if (
    snapshot.observationBuffer.some(item => item.eventId === observation.eventId)
    || snapshot.observationHistory.some(item => item.eventId === observation.eventId)
  ) {
    return snapshot
  }
  const historyLimit = Math.max(1, Math.floor(maximumHistory))
  return {
    ...snapshot,
    // Pending evidence must never be discarded just because the monitor
    // history is bounded. The background curator is responsible for draining
    // this queue; only processed observations may leave it.
    observationBuffer: [...snapshot.observationBuffer, observation],
    observationHistory: [...snapshot.observationHistory, observation].slice(-historyLimit),
    updatedAt: Math.max(snapshot.updatedAt, observation.timestamp),
  }
}

/**
 * Selects the oldest source that has a complete batch.
 *
 * Message order remains stable inside each source, while an incomplete quiet
 * source cannot block a busier source from being curated.
 */
export function nextGroupObservationBatch(
  snapshot: SocialLanguageSnapshot,
  batchSize = 20,
): SocialLanguageGroupObservation[] {
  const sourceCounts = new Map<string, number>()
  for (const observation of snapshot.observationBuffer)
    sourceCounts.set(observation.sourceId, (sourceCounts.get(observation.sourceId) ?? 0) + 1)

  const sourceId = snapshot.observationBuffer.find(observation =>
    (sourceCounts.get(observation.sourceId) ?? 0) >= batchSize,
  )?.sourceId
  if (!sourceId)
    return []

  return snapshot.observationBuffer
    .filter(observation => observation.sourceId === sourceId)
    .slice(0, batchSize)
}

/** Removes a processed batch and records a text-free audit entry. */
export function completeGroupObservationBatch(
  snapshot: SocialLanguageSnapshot,
  observations: SocialLanguageGroupObservation[],
  batch: SocialLanguageObservationBatch,
): SocialLanguageSnapshot {
  const consumed = new Set(observations.map(item => item.eventId))
  return {
    ...snapshot,
    observationBuffer: snapshot.observationBuffer.filter(item => !consumed.has(item.eventId)),
    observationBatches: [...snapshot.observationBatches, batch].slice(-200),
    updatedAt: Math.max(snapshot.updatedAt, batch.processedAt),
  }
}
