import type { GroupObservationEnvelope } from '../input'

import { errorMessageFrom } from '@moeru/std'

import { validateGroupObservationEnvelope } from '../input'

/** One group authorized as a read-only social-learning source. */
export interface StudyGroupPolicy {
  /** Stable internal source ID used by learning records. */
  sourceId: string
  /** AstrBot/platform instance that owns the group. */
  platformInstanceId: string
  /** External group ID within the platform instance. */
  groupId: string
  /** Whether new observations are accepted. */
  enabled: boolean
}

/** Runtime policy for group observation and batching. */
export interface GroupObservationPolicy {
  /** @default false */
  enabled: boolean
  /** @default 10 */
  batchSize: number
  /** @default 2000 */
  maximumTextLength: number
  /** Explicit allowlist of study groups. */
  studyGroups: readonly StudyGroupPolicy[]
}

/** Persisted append-only boundary for accepted group evidence. */
export interface GroupObservationPersistencePort {
  /** Returns whether an event was already accepted. */
  hasEvent: (eventId: string) => Promise<boolean>
  /** Persists accepted evidence before it becomes eligible for a batch. */
  append: (observation: GroupObservationEnvelope) => Promise<void>
}

/** A chronological, single-source learning batch. */
export interface GroupObservationBatch {
  sourceId: string
  platformInstanceId: string
  groupId: string
  observations: readonly GroupObservationEnvelope[]
}

/** Receives batches without gaining any reply or outbound capability. */
export interface GroupObservationBatchConsumer {
  consume: (batch: GroupObservationBatch) => Promise<void>
}

/** Minimal audit boundary for read-only group learning. */
export interface GroupObservationAuditPort {
  record: (entry: {
    eventId: string
    sourceId: string
    outcome: 'accepted' | 'dropped' | 'duplicate' | 'batch_completed' | 'batch_failed'
    reason?: string
    batchSize?: number
  }) => Promise<void> | void
}

/** Reply-free result returned by {@link GroupObservationRuntime.observe}. */
export interface GroupObservationReceipt {
  accepted: boolean
  replySuppressed: true
  sourceId?: string
  pendingInSource: number
  batchQueued: boolean
  reason?:
    | 'disabled'
    | 'source_not_allowed'
    | 'unverified_author'
    | 'self_message'
    | 'unsupported_source'
    | 'empty_content'
    | 'text_too_long'
    | 'duplicate'
}

interface SourceQueue {
  policy: StudyGroupPolicy
  pending: GroupObservationEnvelope[]
  processing: Promise<void>
}

/**
 * Accepts read-only group evidence and schedules isolated per-group batches.
 *
 * This runtime deliberately has no model, tool, consciousness, speech, or
 * outbound dependency. A group event therefore cannot acquire a reply path by
 * configuration or by a malicious batch consumer.
 *
 * Use when:
 * - AstrBot or another platform has already classified a group message
 * - Social-language learners need chronological, source-isolated batches
 *
 * Expects:
 * - Every study group has a unique `sourceId`
 * - The ingress adapter assigned `authorVerified` and `sourceKind`
 *
 * Returns:
 * - A receipt that can only acknowledge or suppress the observation
 */
export class GroupObservationRuntime {
  readonly #policy: GroupObservationPolicy
  readonly #persistence: GroupObservationPersistencePort
  readonly #consumer: GroupObservationBatchConsumer
  readonly #audit?: GroupObservationAuditPort
  readonly #sources = new Map<string, SourceQueue>()
  readonly #inflightEventIds = new Set<string>()

  constructor(options: {
    policy: GroupObservationPolicy
    persistence: GroupObservationPersistencePort
    consumer: GroupObservationBatchConsumer
    audit?: GroupObservationAuditPort
  }) {
    if (!Number.isInteger(options.policy.batchSize) || options.policy.batchSize < 1)
      throw new TypeError('Group observation batchSize must be a positive integer')
    if (!Number.isInteger(options.policy.maximumTextLength) || options.policy.maximumTextLength < 1)
      throw new TypeError('Group observation maximumTextLength must be a positive integer')

    const sourceIds = new Set<string>()
    for (const source of options.policy.studyGroups) {
      if (sourceIds.has(source.sourceId))
        throw new TypeError(`Duplicate study group sourceId: ${source.sourceId}`)
      sourceIds.add(source.sourceId)
      this.#sources.set(source.sourceId, {
        policy: source,
        pending: [],
        processing: Promise.resolve(),
      })
    }
    this.#policy = options.policy
    this.#persistence = options.persistence
    this.#consumer = options.consumer
    this.#audit = options.audit
  }

  /**
   * Validates and records one group observation without ever producing output.
   *
   * Use when:
   * - A platform group handler has already suppressed its default LLM
   *
   * Expects:
   * - `conversationType` is exactly `group_observation`
   *
   * Returns:
   * - A reply-free acknowledgement with batching metadata
   */
  async observe(envelope: GroupObservationEnvelope): Promise<GroupObservationReceipt> {
    validateGroupObservationEnvelope(envelope)
    const source = this.#sources.get(envelope.sourceId)
    const reason = this.#dropReason(envelope, source)
    if (reason)
      return this.#drop(envelope, reason, source?.pending.length ?? 0)

    if (this.#inflightEventIds.has(envelope.eventId) || await this.#persistence.hasEvent(envelope.eventId))
      return this.#drop(envelope, 'duplicate', source?.pending.length ?? 0, 'duplicate')

    this.#inflightEventIds.add(envelope.eventId)
    try {
      await this.#persistence.append(envelope)
    }
    finally {
      this.#inflightEventIds.delete(envelope.eventId)
    }

    const queue = source as SourceQueue
    queue.pending.push(envelope)
    const batchQueued = queue.pending.length >= this.#policy.batchSize
    if (batchQueued)
      this.#queueReadyBatches(queue)

    await this.#audit?.record({
      eventId: envelope.eventId,
      sourceId: envelope.sourceId,
      outcome: 'accepted',
    })
    return {
      accepted: true,
      replySuppressed: true,
      sourceId: envelope.sourceId,
      pendingInSource: queue.pending.length,
      batchQueued,
    }
  }

  /**
   * Waits until all already queued source batches finish.
   *
   * Use when:
   * - Tests need deterministic completion
   * - A host performs graceful shutdown
   *
   * Expects:
   * - Callers stop adding observations when using this for shutdown
   *
   * Returns:
   * - Nothing after all source-local chains settle
   */
  async drain(): Promise<void> {
    await Promise.all([...this.#sources.values()].map(source => source.processing))
  }

  #dropReason(
    envelope: GroupObservationEnvelope,
    source: SourceQueue | undefined,
  ): GroupObservationReceipt['reason'] | undefined {
    if (!this.#policy.enabled)
      return 'disabled'
    if (
      !source
      || !source.policy.enabled
      || source.policy.platformInstanceId !== envelope.platformInstanceId
      || source.policy.groupId !== envelope.groupId
    ) {
      return 'source_not_allowed'
    }
    if (!envelope.authorVerified)
      return 'unverified_author'
    if (envelope.isLumi)
      return 'self_message'
    if (envelope.sourceKind !== 'human_message')
      return 'unsupported_source'
    if (!envelope.text?.trim() && envelope.images.length === 0)
      return 'empty_content'
    if ((envelope.text?.length ?? 0) > this.#policy.maximumTextLength)
      return 'text_too_long'
    return undefined
  }

  async #drop(
    envelope: GroupObservationEnvelope,
    reason: NonNullable<GroupObservationReceipt['reason']>,
    pendingInSource: number,
    outcome: 'dropped' | 'duplicate' = 'dropped',
  ): Promise<GroupObservationReceipt> {
    await this.#audit?.record({
      eventId: envelope.eventId,
      sourceId: envelope.sourceId,
      outcome,
      reason,
    })
    return {
      accepted: false,
      replySuppressed: true,
      sourceId: envelope.sourceId || undefined,
      pendingInSource,
      batchQueued: false,
      reason,
    }
  }

  #queueReadyBatches(source: SourceQueue): void {
    while (source.pending.length >= this.#policy.batchSize) {
      const observations = source.pending.splice(0, this.#policy.batchSize)
      const batch: GroupObservationBatch = {
        sourceId: source.policy.sourceId,
        platformInstanceId: source.policy.platformInstanceId,
        groupId: source.policy.groupId,
        observations,
      }
      source.processing = source.processing.then(async () => {
        try {
          await this.#consumer.consume(batch)
          await this.#audit?.record({
            eventId: observations.at(-1)?.eventId ?? source.policy.sourceId,
            sourceId: source.policy.sourceId,
            outcome: 'batch_completed',
            batchSize: observations.length,
          })
        }
        catch (error) {
          await this.#audit?.record({
            eventId: observations.at(-1)?.eventId ?? source.policy.sourceId,
            sourceId: source.policy.sourceId,
            outcome: 'batch_failed',
            reason: errorMessageFrom(error) ?? 'Unknown group learning failure',
            batchSize: observations.length,
          })
        }
      })
    }
  }
}
