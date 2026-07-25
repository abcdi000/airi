import type { LumiLanguageModelMessage } from './social-language'

export interface LumiStickerClassificationInput {
  senderName: string
  contextText: string
  previousTags?: string[]
}

export interface LumiStickerClassification {
  tags: string[]
  summary: string
  confidence: number
}

export interface LumiStickerSelectionInput {
  inputText: string
  replyText: string
  candidates: Array<{
    id: string
    tags: string[]
    observedCount: number
    sentCount: number
  }>
}

export interface LumiStickerSelection {
  stickerId?: string
  reason: string
}

/**
 * Builds the consciousness task that interprets how a sticker is used.
 *
 * The prompt deliberately permits an empty result. Missing evidence must stay
 * pending instead of being replaced by keyword rules or visual guesses.
 */
export function buildLumiStickerClassificationMessages(
  input: LumiStickerClassificationInput,
): LumiLanguageModelMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are Lumi\'s consciousness-side sticker learning curator.',
        'Infer only how the sticker is being used in the supplied conversation context.',
        'Do not infer visual content that is not present in the evidence.',
        'If the context is insufficient or ambiguous, return an empty tags array and confidence 0.',
        'Create zero to five short Chinese semantic tags. Tags should describe emotion, intent, reaction, or social situation.',
        'Return JSON only: {"tags":["..."],"summary":"...","confidence":0.0}.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        sender_name: input.senderName,
        nearby_conversation: input.contextText,
        previous_model_tags: input.previousTags ?? [],
      }, null, 2),
    },
  ]
}

/** Parses and bounds an untrusted sticker-curator response. */
export function parseLumiStickerClassification(raw: string): LumiStickerClassification | undefined {
  const document = parseJsonObject(raw)
  if (!document)
    return undefined
  const tags = Array.isArray(document.tags)
    ? [...new Set(document.tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map(tag => tag.trim())
        .filter(tag => tag.length > 0 && tag.length <= 24))]
        .slice(0, 5)
    : []
  const summary = typeof document.summary === 'string'
    ? document.summary.trim().slice(0, 240)
    : ''
  const confidence = typeof document.confidence === 'number' && Number.isFinite(document.confidence)
    ? Math.min(1, Math.max(0, document.confidence))
    : 0
  return { tags, summary, confidence }
}

/**
 * Builds the consciousness task that decides whether a learned sticker fits.
 *
 * Returning no sticker is always valid; the model is never forced to attach
 * an image merely because the probability and cooldown policies allowed one.
 */
export function buildLumiStickerSelectionMessages(
  input: LumiStickerSelectionInput,
): LumiLanguageModelMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are Lumi deciding whether one learned sticker naturally fits the current private reply.',
        'Use only the model-curated tags supplied for each candidate.',
        'Prefer no sticker when the fit is weak, ambiguous, repetitive, or socially inappropriate.',
        'Return JSON only: {"sticker_id":"candidate id or empty string","reason":"short reason"}.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        user_message: input.inputText,
        lumi_reply: input.replyText,
        candidates: input.candidates,
      }, null, 2),
    },
  ]
}

/** Parses an untrusted sticker-selection response without choosing a fallback. */
export function parseLumiStickerSelection(raw: string): LumiStickerSelection | undefined {
  const document = parseJsonObject(raw)
  if (!document)
    return undefined
  const stickerId = typeof document.sticker_id === 'string'
    ? document.sticker_id.trim().slice(0, 200)
    : ''
  const reason = typeof document.reason === 'string'
    ? document.reason.trim().slice(0, 240)
    : ''
  return {
    ...(stickerId ? { stickerId } : {}),
    reason,
  }
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const normalized = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
  try {
    const parsed: unknown = JSON.parse(normalized)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  }
  catch {
    const start = normalized.indexOf('{')
    const end = normalized.lastIndexOf('}')
    if (start < 0 || end <= start)
      return undefined
    try {
      const parsed: unknown = JSON.parse(normalized.slice(start, end + 1))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined
    }
    catch {
      return undefined
    }
  }
}
