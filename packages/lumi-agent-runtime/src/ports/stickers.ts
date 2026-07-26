/** A sticker candidate authorized for a direct reply. */
export interface StickerCandidate {
  id: string
  localPath: string
  labels: readonly string[]
  score: number
  sentCount: number
  lastSentAt?: number
}

/** Existing Lumi sticker library adapter. */
export interface StickerPort {
  findCandidates: (input: {
    personId: string
    conversationId: string
    emotionOrScene?: string
    userText: string
    replyText: string
    limit: number
  }) => Promise<readonly StickerCandidate[]>
  recordSent: (input: {
    stickerId: string
    personId: string
    conversationId: string
    sentAt: number
  }) => Promise<void>
}
