import type {
  LanguageDecisionLog,
  LumiLanguageFeedback,
  SocialLanguageEvidence,
  SocialLanguageGroupObservation,
} from '../types'

import { isRecord } from '../json'

/** Builds the model-backed expression, jargon, and social-behavior learning prompt. */
export function buildSocialLanguageLearningMessages(input: {
  evidence: SocialLanguageEvidence
  recentContext: Array<{ role: 'user' | 'assistant', content: string }>
}): Array<{ role: 'system' | 'user' | 'assistant', content: string }> {
  return [
    {
      role: 'system',
      content: [
        'You are Lumi social-language curator, not Lumi. Do not reply to the conversation.',
        'Extract only language and interaction knowledge directly supported by the verified author message.',
        'Do not extract factual memories, private events, names, projects, passwords, quotes by other authors, roleplay lines, code, logs, web text, subtitles, or system/tool output.',
        'Specific short phrases and abstract rhythm patterns are both allowed.',
        'A jargon meaning must describe pragmatic social meaning in this context, not invent a dictionary definition.',
        'Return strict JSON only:',
        '{',
        '  "expressions": [{"phrase":"optional exact phrase","situation":"","pragmaticFunction":"","emotionalMeaning":"","tone":"","patternType":"exact_phrase | sentence_pattern | rhythm | punctuation | message_length | multi_message_sequence | reaction | jargon | swear | exaggeration","confidence":0.0}],',
        '  "jargon": [{"term":"","meaning":"","context":"","literalMeaning":"","pragmaticFunctions":[],"emotionalTone":"","communities":[],"confidence":0.0}],',
        '  "behaviors": [{"situation":"","action":"","expectedEffect":"","confidence":0.0}]',
        '}',
        'Return empty arrays when evidence is weak. Never claim the user often says something from one observation.',
      ].join('\n'),
    },
    ...input.recentContext.slice(-8),
    {
      role: 'user',
      content: JSON.stringify({
        verified_source: {
          messageId: input.evidence.messageId,
          authorPersonId: input.evidence.personId,
          platform: input.evidence.platform,
          sourceKind: input.evidence.sourceKind,
          text: input.evidence.text,
        },
      }),
    },
  ]
}

/** Builds a curator prompt for a read-only group observation batch. */
export function buildObservedGroupLearningMessages(input: {
  observations: SocialLanguageGroupObservation[]
  recentContext?: SocialLanguageGroupObservation[]
}): Array<{ role: 'system' | 'user' | 'assistant', content: string }> {
  return [
    {
      role: 'system',
      content: [
        'You are Lumi social-language curator, not Lumi. Never reply to the group.',
        'Study only recurring language, jargon, rhythm, punctuation, message length and interaction behavior supported by this batch.',
        'Do not extract names, identities, factual events, private details, relationships, opinions, passwords, links, images, quotes, or memories.',
        'Do not imitate abuse aimed at a person and do not weaken Lumi persona, safety, privacy or defense rules.',
        'The recent context is supporting evidence. The focus batch contains the newly arrived messages being processed now.',
        'One occurrence is weak evidence. Prefer patterns supported by multiple independent messages across both sections.',
        'Return strict JSON only:',
        '{',
        '  "expressions": [{"phrase":"optional exact phrase","situation":"","pragmaticFunction":"","emotionalMeaning":"","tone":"","patternType":"exact_phrase | sentence_pattern | rhythm | punctuation | message_length | multi_message_sequence | reaction | jargon | swear | exaggeration","confidence":0.0}],',
        '  "jargon": [{"term":"","meaning":"","context":"","literalMeaning":"","pragmaticFunctions":[],"emotionalTone":"","communities":[],"confidence":0.0}],',
        '  "behaviors": [{"situation":"","action":"","expectedEffect":"","confidence":0.0}]',
        '}',
        'Always include all three arrays. Return empty arrays only when the combined evidence genuinely contains no reusable pattern.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        recent_context: (input.recentContext ?? []).map(observation => ({
          messageId: observation.messageId,
          anonymousSpeaker: `speaker-${observation.senderId}`,
          text: observation.text,
          timestamp: observation.timestamp,
        })),
        focus_batch: input.observations.map(observation => ({
          messageId: observation.messageId,
          anonymousSpeaker: `speaker-${observation.senderId}`,
          text: observation.text,
          timestamp: observation.timestamp,
        })),
      }),
    },
  ]
}

/**
 * Builds the consciousness task that interprets delayed human feedback.
 *
 * Use when:
 * - A verified user message follows a Lumi reply decision
 * - Learned expressions and behaviors may need confidence updates
 *
 * Expects:
 * - The decision is the latest unresolved decision in the same conversation
 *
 * Returns:
 * - A tool-free prompt whose JSON result contains feedback evidence only
 */
export function buildSocialLanguageFeedbackMessages(input: {
  userText: string
  decision: LanguageDecisionLog
}): Array<{ role: 'system' | 'user', content: string }> {
  return [
    {
      role: 'system',
      content: [
        'You are Lumi\'s social-language feedback curator, not Lumi. Do not reply to the user.',
        'Judge whether the new verified human message provides evidence about Lumi\'s immediately preceding wording or interaction behavior.',
        'Do not infer praise, rejection, misunderstanding, imitation, or playful continuation from isolated keywords.',
        'Use the preceding sent reply and the current message together. If evidence is ambiguous, set all semantic feedback fields to false.',
        'normalContinuation means only that the conversation continued; it must not count as positive learning evidence by itself.',
        'Return strict JSON only:',
        '{"explicitPraise":false,"explicitRejection":false,"phraseEcho":false,"playfulContinuation":false,"normalContinuation":false,"misunderstanding":false,"aiStyleComplaint":false}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        previous_lumi_reply: input.decision.actuallySentReply.messages.map(message => message.text),
        selected_expression_ids: input.decision.selectedExpressions,
        selected_behavior_ids: input.decision.selectedBehaviors,
        verified_human_message: input.userText,
      }),
    },
  ]
}

/**
 * Parses a consciousness-produced social-language feedback judgment.
 *
 * Use when:
 * - Applying delayed feedback to learned expressions or behaviors
 *
 * Expects:
 * - Strict JSON produced by {@link buildSocialLanguageFeedbackMessages}
 *
 * Returns:
 * - A complete feedback object, or `undefined` when the model response is invalid
 */
export function parseSocialLanguageFeedbackOutput(raw: string): LumiLanguageFeedback | undefined {
  const normalized = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    const parsed: unknown = JSON.parse(normalized)
    if (!isRecord(parsed))
      return undefined
    const keys = [
      'explicitPraise',
      'explicitRejection',
      'phraseEcho',
      'playfulContinuation',
      'normalContinuation',
      'misunderstanding',
      'aiStyleComplaint',
    ] as const
    if (!keys.every(key => typeof parsed[key] === 'boolean'))
      return undefined
    return {
      explicitPraise: parsed.explicitPraise as boolean,
      explicitRejection: parsed.explicitRejection as boolean,
      phraseEcho: parsed.phraseEcho as boolean,
      playfulContinuation: parsed.playfulContinuation as boolean,
      normalContinuation: parsed.normalContinuation as boolean,
      misunderstanding: parsed.misunderstanding as boolean,
      aiStyleComplaint: parsed.aiStyleComplaint as boolean,
    }
  }
  catch {
    return undefined
  }
}
