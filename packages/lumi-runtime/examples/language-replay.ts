import type { LearnedExpression, LearnedSocialBehavior, LumiReplyIntent } from '../src'

import { projectLumiLanguageReplay } from '../src'

const now = Date.now()
const intent: LumiReplyIntent = {
  shouldReply: true,
  replyAct: 'react',
  semanticGoal: 'React naturally to a spectacular build failure without offering a long solution.',
  keyPoints: ['The build failed dramatically.'],
  referenceInfo: [],
  attitude: { willingnessToHelp: 'normal' },
  emotion: { primary: 'surprised', intensity: 0.72 },
  defenseState: { active: false, refusalRequired: false, prohibitedHelpTypes: [] },
  expressionIntent: {
    focus: 'the failed build',
    scene: 'familiar direct chat',
    tone: 'surprised and playful',
    desiredLength: 'tiny',
    preferredActs: ['short reaction'],
    avoid: ['assistant outline'],
  },
  immutableConstraints: ['Do not invent a fix that has not been verified.'],
}
const expressions: LearnedExpression[] = [{
  id: 'expression-build-explosion',
  phrase: '这难炸了',
  situation: 'a build or program fails spectacularly',
  pragmaticFunction: 'short exaggerated reaction',
  emotionalMeaning: 'surprise mixed with helpless amusement',
  tone: 'playful',
  patternType: 'exaggeration',
  origin: {
    personId: 'sample-person',
    conversationId: 'sample-conversation',
    platform: 'sample',
    messageIds: ['redacted-message'],
    source: 'human',
  },
  affinity: {
    global: 0.6,
    byPerson: { 'sample-person': 0.9 },
    byConversation: { 'sample-conversation': 0.9 },
    byPlatform: { sample: 0.8 },
  },
  familiarity: 0.85,
  ownership: 0.72,
  confidence: 0.9,
  observationCount: 5,
  useCount: 2,
  successfulUseCount: 2,
  awkwardUseCount: 0,
  explicitRejectionCount: 0,
  firstSeenAt: now - 30 * 86_400_000,
  lastSeenAt: now - 60_000,
  status: 'adopted',
}]
const behaviors: LearnedSocialBehavior[] = [{
  id: 'behavior-short-reaction',
  situation: 'familiar direct chat react to a build failure',
  action: 'send a short reaction first and do not immediately dump a solution',
  originEvidenceIds: ['redacted-message'],
  confidence: 0.82,
  affinity: {
    global: 0.4,
    byPerson: { 'sample-person': 0.9 },
    byConversation: { 'sample-conversation': 0.9 },
    byPlatform: { sample: 0.8 },
  },
  successCount: 3,
  failureCount: 0,
}]

const projections = projectLumiLanguageReplay({
  sample: {
    id: 'build-failure-replay',
    intent,
    legacyReply: 'The build failed. Let me provide a detailed troubleshooting checklist.',
    character: {
      corePersonality: 'Lumi has her own stance and reacts honestly.',
      baseReplyStyle: 'Natural familiar chat.',
      emotionSummary: 'surprised',
      relationshipSummary: 'familiar',
      defenseSummary: 'none',
    },
    context: {
      now,
      personId: 'sample-person',
      conversationId: 'sample-conversation',
      platform: 'sample',
      conversationType: 'direct',
      currentUserText: '究极大爆炸，构建又炸穿了',
      emotionTag: 'surprised',
      emotionIntensity: 0.72,
      relationshipCloseness: 0.8,
      defenseActive: false,
      recentAssistantTexts: [],
    },
  },
  expressions,
  behaviors,
})

console.info(JSON.stringify(projections, null, 2))
