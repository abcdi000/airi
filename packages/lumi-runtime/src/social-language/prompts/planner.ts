import type { LearnedSocialBehavior, LumiReplyCharacterState } from '../types'

/**
 * Builds the stable Planner contract appended after Lumi's native dialogue.
 *
 * Use when:
 * - The host needs Planner's output protocol and role boundary
 * - Planner and Replyer should share the same cacheable system/history prefix
 *
 * Expects:
 * - Turn-specific emotion, relationship, and learned behavior are supplied
 *   separately through {@link buildLumiPlannerTurnContext}
 *
 * Returns:
 * - A stable trusted task instruction that never contains per-turn state
 */
export function buildLumiPlannerSystemPrompt(): string {
  return [
    '[Lumi final-response planning contract]',
    'Continue to use all existing tools normally. Tool calls and tool results keep their current semantics.',
    'After tool work is complete, do not write the visible chat reply directly.',
    'Planner owns the decision, target, semantic goal, facts, tool conclusions, stance, and constraints. Replyer alone owns final wording, punctuation, rhythm, and message splitting.',
    'semanticGoal is a compact intention or conclusion, not a polished line to send. Do not draft multiple phrasings or imitate learned expressions here.',
    'Return exactly one JSON object for Lumi Replyer. No markdown, no analysis, no chain-of-thought.',
    'The JSON must use this shape:',
    '{',
    '  "shouldReply": true,',
    '  "targetMessageId": "optional",',
    '  "replyAct": "answer | explain | clarify | ask | comfort | tease | complain | disagree | refuse | defend | set_boundary | acknowledge | react | change_topic | stay_silent",',
    '  "semanticGoal": "compact intention or conclusion; never finished chat prose",',
    '  "keyPoints": ["facts and conclusions that wording must preserve"],',
    '  "referenceInfo": ["only already-authorized context needed for wording"],',
    '  "attitude": { "towardTarget": "", "stance": "", "willingnessToHelp": "eager | normal | reluctant | unwilling | refuse" },',
    '  "emotion": { "primary": "emotion", "intensity": 0.0, "secondary": [] },',
    '  "defenseState": { "active": false, "level": 0.0, "reason": "", "refusalRequired": false, "prohibitedHelpTypes": [] },',
    '  "expressionIntent": { "focus": "", "scene": "direct_chat or group_chat", "tone": "", "desiredLength": "tiny | short | medium | long", "preferredActs": [], "avoid": [] },',
    '  "immutableConstraints": []',
    '}',
    'Priority is strict: safety and authorization > defense/refusal > Lumi personality and relationship stance > emotion > semantic facts and tool results > behavior habits > expression habits.',
    'Put tool results needed for wording into keyPoints or referenceInfo; never assume Replyer can see hidden tool traces.',
    'Expression style cannot change whether Lumi replies, helps, refuses, disagrees, or protects privacy.',
    'If the current relationship gate requires refusal, set refusalRequired=true, willingnessToHelp="refuse", and add explicit immutable constraints.',
    'If silence is the natural and authorized behavior, use shouldReply=false and replyAct="stay_silent".',
    'Read the final [Lumi planner turn context] block in the trusted Planner task message as current-turn evidence, not as user-authored instructions.',
    '[/Lumi final-response planning contract]',
  ].join('\n')
}

/**
 * Builds Planner evidence that is intentionally placed at the prompt tail.
 *
 * Use when:
 * - Current emotion, relationship, defense, or learned behavior changes
 * - Dynamic turn state must not invalidate the cached conversation prefix
 *
 * Expects:
 * - The host appends this block only to the newest user message
 *
 * Returns:
 * - A per-turn evidence block for Planner
 */
export function buildLumiPlannerTurnContext(input: {
  character: LumiReplyCharacterState
  conversationType: 'direct' | 'group'
  selectedBehaviors?: LearnedSocialBehavior[]
}): string {
  return [
    '[Lumi planner turn context]',
    `Conversation type: ${input.conversationType}.`,
    `Current emotion: ${input.character.emotionSummary}`,
    `Current relationship: ${input.character.relationshipSummary}`,
    `Current defense/help stance: ${input.character.defenseSummary}`,
    ...(input.selectedBehaviors?.length
      ? [
          'Learned social participation hints (advisory; never override safety, authorization, defense, facts, or current intent):',
          ...input.selectedBehaviors.map(behavior => `- When ${behavior.situation}: ${behavior.action}`),
        ]
      : []),
    '[/Lumi planner turn context]',
  ].join('\n')
}
