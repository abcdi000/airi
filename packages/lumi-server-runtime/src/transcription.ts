import { errorMessageFrom } from '@moeru/std'

export interface LumiVoiceTranscriptionInput {
  audio: Uint8Array
  mimeType: string
  fileName: string
}

export interface LumiVoiceTranscriber {
  /** Converts authenticated client audio into text without assigning an identity. */
  transcribe: (input: LumiVoiceTranscriptionInput) => Promise<string>
}

export interface OpenAICompatibleTranscriberOptions {
  baseURL: string
  apiKey?: string
  model: string
  language?: string
  prompt?: string
}

/** Creates an OpenAI-compatible multipart audio transcription adapter. */
export function createOpenAICompatibleTranscriber(options: OpenAICompatibleTranscriberOptions): LumiVoiceTranscriber {
  const endpoint = new URL('audio/transcriptions', ensureTrailingSlash(options.baseURL)).toString()
  return {
    async transcribe(input) {
      const form = new FormData()
      form.set('model', options.model)
      form.set('file', new Blob([input.audio], { type: input.mimeType }), input.fileName)
      if (options.language)
        form.set('language', options.language)
      if (options.prompt)
        form.set('prompt', options.prompt)
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : undefined,
        body: form,
      })
      if (!response.ok)
        throw new Error(await transcriptionError(response))
      const body = await response.json() as { text?: unknown }
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text)
        throw new Error('The transcription provider returned no text')
      return text
    },
  }
}

function ensureTrailingSlash(value: string) {
  return value.endsWith('/') ? value : `${value}/`
}

async function transcriptionError(response: Response) {
  try {
    const body = await response.json() as { error?: { message?: unknown } | string, message?: unknown }
    if (typeof body.error === 'string')
      return body.error
    if (typeof body.error?.message === 'string')
      return body.error.message
    if (typeof body.message === 'string')
      return body.message
  }
  catch (error) {
    return errorMessageFrom(error) ?? `Transcription failed (${response.status})`
  }
  return `Transcription failed (${response.status})`
}
