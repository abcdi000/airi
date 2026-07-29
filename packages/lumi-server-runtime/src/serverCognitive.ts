import type {
  CognitiveContextPort,
  CognitiveDialogueTurn,
  DirectPerceptionEnvelope,
} from '@proj-airi/lumi-agent-runtime'
import type {
  LumiCognitiveIdentity,
  LumiMemoryFragment,
  LumiMemorySearchRequest,
} from '@proj-airi/lumi-runtime'

import type { LumiServerDatabase } from './database'

import {
  prepareLumiCognitiveTurn,
  selectPlannerSocialBehaviors,
} from '@proj-airi/lumi-runtime'

import { LUMI_PERSONA_ID } from './database'

/** Server-owned dependencies for automatic shallow cognitive recall. */
export interface ServerCognitiveContextOptions {
  /** Canonical server SQLite database. */
  database: LumiServerDatabase
  /** Optional semantic service; results are reloaded through database ACL. */
  semanticMemorySearch?: (
    request: LumiMemorySearchRequest,
    limit: number,
  ) => Promise<LumiMemoryFragment[]>
}

/**
 * Creates the server host boundary for Lumi's deterministic cognitive fast loop.
 *
 * Use when:
 * - A verified direct online message is entering the shared Agent Runtime
 * - Working memory and evidence must remain server-authoritative
 *
 * Expects:
 * - The online server has already committed the source message
 * - Group observation never enters this direct reply adapter
 *
 * Returns:
 * - A port that performs one bounded automatic recall before Planner
 */
export function createServerCognitiveContextPort(
  options: ServerCognitiveContextOptions,
): CognitiveContextPort {
  return {
    async prepareTurn({ envelope, recentTurns, signal }) {
      const identity = identityFromEnvelope(envelope)
      const currentText = visibleText(envelope)
      return await prepareLumiCognitiveTurn({
        identity,
        sourceMessageId: envelope.sourceMessageId,
        userText: currentText,
        recentTurns: dialogueTurns(recentTurns),
        repository: {
          async loadWorkingMemory(requestIdentity) {
            return options.database.loadCognitiveWorkingMemory(requestIdentity)
          },
          async commitFastLoop(input) {
            options.database.commitCognitiveFastLoop(input)
          },
          async recall(input) {
            const startedAt = Date.now()
            const request = memoryRequest(input.identity, input.query, input.limit)
            let candidateIds: string[]
            let vectorIndexStatus: string
            let fallbackReason: string | undefined
            if (options.semanticMemorySearch) {
              try {
                const semantic = await options.semanticMemorySearch(request, input.limit)
                throwIfAborted(input.signal)
                candidateIds = semantic.map(memory => memory.id)
                vectorIndexStatus = 'server_semantic_service'
              }
              catch {
                candidateIds = options.database
                  .listAccessibleMemories(request, Math.max(input.limit * 4, 20))
                  .map(memory => memory.id)
                vectorIndexStatus = 'structured_lexical_fallback'
                fallbackReason = 'semantic_recall_failed'
              }
            }
            else {
              candidateIds = options.database
                .listAccessibleMemories(request, Math.max(input.limit * 4, 20))
                .map(memory => memory.id)
              vectorIndexStatus = 'structured_lexical_fallback'
              fallbackReason = 'semantic_recall_unconfigured'
            }
            throwIfAborted(input.signal)
            const uniqueIds = [...new Set(candidateIds)]
            const memories = options.database
              .loadAccessibleMemoriesByIds(input.identity, uniqueIds)
              .slice(0, input.limit)
            return {
              memories,
              trace: {
                ran: true,
                reusedPreviousState: false,
                aclInputCount: uniqueIds.length,
                aclOutputCount: memories.length,
                lexicalCandidateCount: fallbackReason ? uniqueIds.length : 0,
                annCandidateCount: fallbackReason ? 0 : uniqueIds.length,
                mergedCandidateCount: uniqueIds.length,
                rerankedCandidateCount: memories.length,
                thresholdRejectedCount: Math.max(0, uniqueIds.length - memories.length),
                conflictRejectedCount: 0,
                injectedCount: memories.length,
                durationMs: Date.now() - startedAt,
                vectorIndexStatus,
                fallbackReason,
              },
            }
          },
          async loadMemoriesByIds(input) {
            throwIfAborted(input.signal)
            return options.database.loadAccessibleMemoriesByIds(input.identity, input.memoryIds)
          },
          async loadProjectionState(requestIdentity) {
            const projection = options.database.loadCognitiveProjectionState(requestIdentity)
            const snapshot = options.database.getSocialLanguageSnapshot()
            const behaviors = selectPlannerSocialBehaviors(snapshot.behaviors, {
              personId: requestIdentity.actorId,
              conversationId: requestIdentity.conversationId,
              conversationType: 'direct',
              platform: envelope.platform,
              currentUserText: currentText,
            }, 2)
            const lowerText = currentText.toLocaleLowerCase()
            const jargon = snapshot.jargon
              .filter(item => lowerText.includes(item.term.toLocaleLowerCase()))
              .slice(0, 4)
            return {
              ...projection,
              interactionStrategies: [
                ...behaviors.map(item => item.behavior.action),
                ...jargon.map(item => `按语境理解“${item.term}”：${item.meanings[0]?.meaning ?? item.pragmaticFunctions.join('、')}`),
              ],
            }
          },
        },
        signal,
      })
    },
    async recordContextUse({ envelope, memoryIds, hypothesisIds, usedAt }) {
      options.database.recordCognitiveContextUse({
        identity: identityFromEnvelope(envelope),
        memoryIds,
        hypothesisIds,
        usedAt,
      })
    },
  }
}

function identityFromEnvelope(envelope: DirectPerceptionEnvelope): LumiCognitiveIdentity {
  if (envelope.conversationType !== 'direct')
    throw new Error('Server cognitive context accepts direct conversations only')
  return {
    actorId: envelope.personId,
    personaId: LUMI_PERSONA_ID,
    conversationId: envelope.conversationId,
    conversationType: 'direct',
    participantUserIds: [...envelope.participantPersonIds],
  }
}

function dialogueTurns(turns: readonly CognitiveDialogueTurn[]) {
  return turns.map(turn => ({
    id: turn.messageIds.join('+'),
    role: turn.role,
    content: turn.textSegments.join('\n'),
  }))
}

function visibleText(envelope: DirectPerceptionEnvelope): string {
  return envelope.text?.trim() || envelope.segments
    .flatMap(segment => segment.type === 'text' ? [segment.text] : [])
    .join('\n')
    .trim()
}

function memoryRequest(
  identity: LumiCognitiveIdentity,
  query: string,
  limit: number,
): LumiMemorySearchRequest {
  return {
    query,
    userId: identity.actorId,
    viewerUserId: identity.actorId,
    personaId: identity.personaId,
    limit,
    conversationType: 'direct',
    conversationId: identity.conversationId,
    participantUserIds: [...identity.participantUserIds],
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason ?? new Error('Server cognitive recall aborted')
}
