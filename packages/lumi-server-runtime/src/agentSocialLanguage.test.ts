import type { LanguageModelPort } from '@proj-airi/lumi-agent-runtime'

import { createFallbackLumiReplyIntent } from '@proj-airi/lumi-runtime'
import { describe, expect, it, vi } from 'vitest'

import { createServerSocialLanguagePort } from './agentSocialLanguage'
import { DOGGY_PERSON_ID, LumiServerDatabase } from './database'

describe('server Agent social-language feedback routing', () => {
  /** @example Explicit praise is reduced from the cognitive event without a second model request. */
  it('skips model feedback classification when the cognitive fast loop already classified the turn', async () => {
    const database = LumiServerDatabase.open(':memory:')
    const generate = vi.fn<LanguageModelPort['generate']>(async () => {
      throw new Error('Explicit feedback must not invoke the feedback model')
    })
    const port = createServerSocialLanguagePort({
      database,
      model: { generate },
    })
    const envelope = {
      eventId: 'event-feedback',
      conversationId: `lumi-direct:${DOGGY_PERSON_ID}`,
      personId: DOGGY_PERSON_ID,
      platform: 'qq',
      platformInstanceId: 'qq-main',
      externalUserId: '1770249418',
      timestamp: Date.parse('2026-07-29T10:00:00.000Z'),
      text: '这次不错',
      segments: [{ type: 'text' as const, text: '这次不错' }],
      attachments: [],
      sourceMessageId: 'message-feedback',
      participantPersonIds: [DOGGY_PERSON_ID],
      conversationType: 'direct' as const,
    }
    const intent = createFallbackLumiReplyIntent({ rawDraft: '上一条回复' })
    try {
      await port.recordSentReply({
        envelope,
        intent,
        reply: { messages: [{ text: '上一条回复' }], appliedExpressionIds: [] },
        sentMessageIds: ['assistant-before'],
        selectedReferenceIds: [],
      })

      await port.observeDirectFeedback({
        envelope,
        recentAssistantMessageIds: ['assistant-before'],
        recentAssistantTexts: ['上一条回复'],
        feedbackEvents: [{
          id: 'feedback-explicit-praise',
          actorId: DOGGY_PERSON_ID,
          conversationId: envelope.conversationId,
          conversationType: 'direct',
          kind: 'explicit_praise',
          sourceId: envelope.sourceMessageId,
          evidenceId: 'evidence-feedback',
          targetIds: ['assistant-before'],
          strength: 1,
          occurredAt: '2026-07-29T10:00:00.000Z',
          authorVerified: true,
          scope: 'private',
          sensitivity: 'private',
        }],
      })

      expect(generate).not.toHaveBeenCalled()
      expect(database.getSocialLanguageSnapshot().decisions[0]?.laterFeedback).toEqual({
        explicitPraise: true,
      })
    }
    finally {
      database.close()
    }
  })
})
