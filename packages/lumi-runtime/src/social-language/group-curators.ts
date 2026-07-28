import type {
  GroupLearningCuratorKind,
  JargonKnowledgeProposal,
  LearnedBehaviorProposal,
  LearnedExpressionProposal,
  PublicGroupKnowledge,
} from './types'

import { clamp01, isRecord, parseJsonObject, stringArray, stringValue } from './json'
import { parseSocialLanguageLearningResult } from './learning'

export interface SourcedGroupCandidate<TCandidate> {
  sourceMessageIds: string[]
  candidate: TCandidate
}

export interface PublicKnowledgeProposal {
  content: string
  confidence: number
}

export interface ParsedGroupCuratorOutput {
  valid: boolean
  expressions: Array<SourcedGroupCandidate<LearnedExpressionProposal>>
  jargon: Array<SourcedGroupCandidate<JargonKnowledgeProposal>>
  behaviors: Array<SourcedGroupCandidate<LearnedBehaviorProposal>>
  publicKnowledge: Array<SourcedGroupCandidate<PublicKnowledgeProposal>>
  warning?: string
}

/** Creates or reinforces one source-scoped public-knowledge candidate. */
export function observePublicGroupKnowledge(input: {
  existing?: PublicGroupKnowledge
  id: string
  sourceId: string
  sourceMessageIds: string[]
  proposal: PublicKnowledgeProposal
  timestamp: number
}): PublicGroupKnowledge {
  const observationCount = (input.existing?.observationCount ?? 0) + 1
  const confidence = Math.max(input.existing?.confidence ?? 0, input.proposal.confidence)
  return {
    id: input.existing?.id ?? input.id,
    sourceId: input.sourceId,
    content: input.proposal.content,
    sourceMessageIds: [...new Set([
      ...(input.existing?.sourceMessageIds ?? []),
      ...input.sourceMessageIds,
    ])].slice(-128),
    confidence,
    observationCount,
    firstSeenAt: input.existing?.firstSeenAt ?? input.timestamp,
    lastSeenAt: input.timestamp,
    status: input.existing?.status === 'rejected' || input.existing?.status === 'archived'
      ? input.existing.status
      : observationCount >= 2 && confidence >= 0.8 ? 'active' : 'candidate',
  }
}

/**
 * Parses one isolated curator response and validates batch provenance.
 *
 * Use when:
 * - Curators run independently and must not write candidates from invented sources
 *
 * Expects:
 * - `allowedMessageIds` contains exactly the current focus batch
 *
 * Returns:
 * - Only structurally valid candidates whose source IDs belong to the batch
 */
export function parseObservedGroupCuratorOutput(input: {
  kind: GroupLearningCuratorKind
  raw: string
  allowedMessageIds: ReadonlySet<string>
  forbiddenIdentityStrings?: readonly string[]
}): ParsedGroupCuratorOutput {
  const empty = {
    expressions: [],
    jargon: [],
    behaviors: [],
    publicKnowledge: [],
  }
  const document = parseJsonObject(input.raw)
  if (!document || !Array.isArray(document.candidates))
    return { valid: false, ...empty, warning: 'Curator did not return a candidates array' }

  const accepted = document.candidates.flatMap((value) => {
    if (!isRecord(value))
      return []
    const sourceMessageIds = stringArray(value.sourceMessageIds, 64, 200)
    if (
      sourceMessageIds.length === 0
      || sourceMessageIds.some(messageId => !input.allowedMessageIds.has(messageId))
      || containsForbiddenIdentity(value, input.forbiddenIdentityStrings ?? [])
    ) {
      return []
    }
    return [{ sourceMessageIds, value }]
  })

  if (document.candidates.length > 0 && accepted.length === 0)
    return { valid: false, ...empty, warning: 'Curator candidates failed provenance or identity validation' }

  if (input.kind === 'public_knowledge') {
    const publicKnowledge = accepted.flatMap(({ sourceMessageIds, value }) => {
      const content = stringValue(value.content, '', 4_000)
      if (!content)
        return []
      return [{
        sourceMessageIds,
        candidate: {
          content,
          confidence: clamp01(value.confidence),
        },
      }]
    })
    return { valid: document.candidates.length === 0 || publicKnowledge.length > 0, ...empty, publicKnowledge }
  }

  const parsedCandidates = accepted.flatMap(({ sourceMessageIds, value }) => {
    const parsed = parseSocialLanguageLearningResult(JSON.stringify({
      expressions: input.kind === 'expression' ? [value] : [],
      jargon: input.kind === 'jargon' ? [value] : [],
      behaviors: input.kind === 'behavior' ? [value] : [],
    }))
    if (!parsed.valid)
      return []
    return [{
      sourceMessageIds,
      expression: parsed.expressions[0],
      jargon: parsed.jargon[0],
      behavior: parsed.behaviors[0],
    }]
  })
  if (document.candidates.length > 0 && parsedCandidates.length === 0)
    return { valid: false, ...empty, warning: 'Curator candidates failed field validation' }

  return {
    valid: true,
    expressions: parsedCandidates.flatMap(item => item.expression
      ? [{ candidate: item.expression, sourceMessageIds: item.sourceMessageIds }]
      : []),
    jargon: parsedCandidates.flatMap(item => item.jargon
      ? [{ candidate: item.jargon, sourceMessageIds: item.sourceMessageIds }]
      : []),
    behaviors: parsedCandidates.flatMap(item => item.behavior
      ? [{ candidate: item.behavior, sourceMessageIds: item.sourceMessageIds }]
      : []),
    publicKnowledge: [],
  }
}

function containsForbiddenIdentity(
  candidate: Record<string, unknown>,
  forbiddenIdentityStrings: readonly string[],
): boolean {
  const serialized = JSON.stringify(candidate).toLocaleLowerCase()
  return forbiddenIdentityStrings
    .map(value => value.trim().toLocaleLowerCase())
    .filter(value => value.length >= 2)
    .some(value => serialized.includes(value))
}
