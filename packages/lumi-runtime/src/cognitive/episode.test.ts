import type { LumiCognitiveEvidence, LumiCognitiveIdentity } from './types'

import { describe, expect, it } from 'vitest'

import { createLumiConversationEpisode } from './episode'

const identity: LumiCognitiveIdentity = {
  actorId: 'doggy',
  personaId: 'lumi',
  conversationId: 'direct:doggy',
  conversationType: 'direct',
  participantUserIds: ['doggy'],
}

function primaryEvidence(
  sourceMessageId: string,
  patch: Partial<LumiCognitiveEvidence> = {},
): LumiCognitiveEvidence {
  return {
    id: `evidence:message:${sourceMessageId}`,
    actorId: identity.actorId,
    subjectUserIds: [identity.actorId],
    conversationId: identity.conversationId,
    conversationType: 'direct',
    kind: 'user_statement',
    origin: 'primary',
    content: `message ${sourceMessageId}`,
    sourceId: sourceMessageId,
    sourceMessageId,
    occurredAt: '2026-07-29T08:00:00.000Z',
    trust: 1,
    authorVerified: true,
    scope: 'private',
    sensitivity: 'private',
    participantUserIds: ['doggy'],
    derivedFromEvidenceIds: [],
    schemaVersion: 1,
    ...patch,
  }
}

describe('conversation episode consolidation', () => {
  /** @example A private summary remains derived from verified direct-message evidence. */
  it('creates one private episodic memory with transitive primary lineage', () => {
    const episode = createLumiConversationEpisode({
      identity,
      episodeId: 'dialogue:1',
      summary: 'Doggy and Lumi agreed to continue the Patchright migration.',
      sourceMessageIds: ['message-1', 'assistant-1', 'message-2'],
      primaryEvidence: [
        primaryEvidence('message-1'),
        primaryEvidence('message-2'),
      ],
      occurredAt: '2026-07-29T08:05:00.000Z',
    })

    expect(episode.evidence).toMatchObject({
      kind: 'conversation_episode',
      origin: 'derived',
      authorVerified: false,
      scope: 'private',
      sensitivity: 'private',
      derivedFromEvidenceIds: [
        'evidence:message:message-1',
        'evidence:message:message-2',
      ],
    })
    expect(episode.memory).toMatchObject({
      type: 'shared_event',
      status: 'active',
      scope: 'private',
      visibility: 'private',
      evidenceOrigin: 'derived',
      derivedFromEvidenceIds: [episode.evidence.id],
      sourceEpisodeStartMessageId: 'message-1',
      sourceEpisodeEndMessageId: 'message-2',
    })
  })

  /** @example Evidence from another person cannot become lineage for Doggy's episode. */
  it('rejects foreign or unverified primary evidence', () => {
    expect(() => createLumiConversationEpisode({
      identity,
      episodeId: 'dialogue:2',
      summary: 'A summary that must not cross identities.',
      sourceMessageIds: ['message-foreign'],
      primaryEvidence: [primaryEvidence('message-foreign', {
        actorId: 'moussy',
        authorVerified: false,
      })],
      occurredAt: '2026-07-29T08:10:00.000Z',
    })).toThrow('Conversation episode has no authorized primary evidence')
  })
})
