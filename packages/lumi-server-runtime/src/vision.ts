import type { CommonContentPart } from '@xsai/shared-chat'

import type { LumiVisionAnalyzer } from './astrbotIntegration'

import { Buffer } from 'node:buffer'

import {
  buildLumiVisionPrompt,
  createLumiImageUnderstandingResult,
} from '@proj-airi/lumi-runtime'
import { generateText } from '@xsai/generate-text'

export interface OpenAICompatibleVisionOptions {
  apiKey?: string
  baseURL: string
  model: string
  /** Testable Fetch boundary; defaults to global fetch. */
  fetch?: typeof globalThis.fetch
}

/** Creates the server-owned Lumi Eyes adapter used by external perception bridges. */
export function createOpenAICompatibleVisionAnalyzer(options: OpenAICompatibleVisionOptions): LumiVisionAnalyzer {
  const baseURL = new URL(options.baseURL).href
  const model = options.model.trim()
  if (!model)
    throw new Error('Vision model is required')
  return {
    async analyze(input) {
      const content: CommonContentPart[] = [
        { type: 'text', text: buildLumiVisionPrompt(input.userText) },
        {
          type: 'image_url',
          image_url: {
            url: `data:${input.mimeType};base64,${Buffer.from(input.image).toString('base64')}`,
          },
        },
      ]
      const response = await generateText({
        apiKey: options.apiKey?.trim() || undefined,
        baseURL,
        model,
        messages: [{ role: 'user', content }],
        temperature: 0,
        fetch: options.fetch,
      })
      if (!response.text?.trim())
        throw new Error('Lumi vision model returned no text')
      return createLumiImageUnderstandingResult({
        text: response.text,
        workloadId: 'lumi:astrbot-image',
        workloadLabel: `AstrBot image ${input.segmentIndex}`,
        model,
      })
    },
  }
}
