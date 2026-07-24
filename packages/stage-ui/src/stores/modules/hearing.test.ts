import { describe, expect, it } from 'vitest'

import { filterTranscriptionByConfidence, resolveTranscriptionModel } from './hearing'

describe('resolveTranscriptionModel', () => {
  it('uses the provider-configured model when the hearing selection is empty', () => {
    expect(resolveTranscriptionModel('', 'whisper-1', 'openai-compatible-audio-transcription')).toBe('whisper-1')
  })

  it('prefers the explicit hearing model over the provider fallback', () => {
    expect(resolveTranscriptionModel('gpt-4o-transcribe', 'whisper-1', 'openai-compatible-audio-transcription')).toBe('gpt-4o-transcribe')
  })
})

describe('filterTranscriptionByConfidence', () => {
  const segments = [
    { text: 'Hello ', avg_logprob: -0.3 },
    { text: 'world ', avg_logprob: -1.2 },
    { text: 'gibberish', avg_logprob: -2.5 },
  ]

  it('keeps all segments when threshold is very low', () => {
    expect(filterTranscriptionByConfidence(segments, -3)).toBe('Hello world gibberish')
  })

  it('filters out low-confidence segments', () => {
    expect(filterTranscriptionByConfidence(segments, -1)).toBe('Hello')
  })

  it('filters out all segments when threshold is 0', () => {
    expect(filterTranscriptionByConfidence(segments, 0)).toBe('')
  })

  it('returns empty string for empty segments', () => {
    expect(filterTranscriptionByConfidence([], -1)).toBe('')
  })

  it('trims whitespace from result', () => {
    expect(filterTranscriptionByConfidence([{ text: '  hello  ', avg_logprob: -0.5 }], -1)).toBe('hello')
  })
})
