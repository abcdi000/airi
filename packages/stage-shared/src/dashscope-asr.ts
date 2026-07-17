import { defineEventa, defineInvokeEventa } from '@moeru/eventa'

export interface DashScopeAsrStartPayload {
  sessionId: string
  apiKey: string
  baseUrl: string
  model: string
  workspaceId?: string
  sampleRate?: number
  languageHints?: string[]
  vocabularyId?: string
  maxSentenceSilence?: number
  semanticPunctuationEnabled?: boolean
  punctuationPredictionEnabled?: boolean
  inverseTextNormalizationEnabled?: boolean
  disfluencyRemovalEnabled?: boolean
  multiThresholdModeEnabled?: boolean
  heartbeat?: boolean
}

export interface DashScopeAsrStartResult {
  sessionId: string
  accepted: boolean
}

export type DashScopeAsrClientEvent
  = | { sessionId: string, type: 'audio', chunk: Uint8Array }
    | { sessionId: string, type: 'finish' }
    | { sessionId: string, type: 'abort', reason?: string }

export type DashScopeAsrServerEvent
  = | { sessionId: string, type: 'started' }
    | { sessionId: string, type: 'partial', text: string, sentenceId?: number }
    | { sessionId: string, type: 'final', text: string, sentenceId?: number }
    | { sessionId: string, type: 'finished' }
    | { sessionId: string, type: 'error', message: string, code?: string }

export const electronDashScopeAsrStart = defineInvokeEventa<DashScopeAsrStartResult, DashScopeAsrStartPayload>('eventa:invoke:electron:dashscope-asr:start')
export const electronDashScopeAsrClientEvent = defineEventa<DashScopeAsrClientEvent>('eventa:event:electron:dashscope-asr:client')
export const electronDashScopeAsrServerEvent = defineEventa<DashScopeAsrServerEvent>('eventa:event:electron:dashscope-asr:server')
