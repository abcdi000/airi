import type { CommonContentPart } from '@xsai/shared-chat'
import type { LumiImageUnderstandingResult } from '../../../lumi-runtime/src'

import { errorMessageFrom } from '@moeru/std'
import {
  buildLumiVisionPrompt,
  createLumiImageUnderstandingResult,
} from '../../../lumi-runtime/src'
import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { ref } from 'vue'

import { useVisionInference } from '../composables/vision'
import { useChatContextStore } from './chat/context-store'
import { useVisionStore } from './modules/vision'

export const MAX_LUMI_EYES_CHAT_IMAGES = 6

export interface LumiEyesChatAttachment {
  type: 'image'
  data: string
  mimeType: string
}

export interface LumiEyesAnalyzeChatInput {
  attachments?: LumiEyesChatAttachment[]
  userMessage?: string
  sessionId?: string
  publishContext?: boolean
}

export interface LumiEyesAnalyzeChatResult {
  results: LumiImageUnderstandingResult[]
  errors: string[]
  contextText: string
}

export const useLumiEyesStore = defineStore('lumi-eyes', () => {
  const chatContext = useChatContextStore()
  const visionStore = useVisionStore()
  const { activeModel } = storeToRefs(visionStore)
  const { runVisionInference } = useVisionInference()

  const analyzing = ref(false)
  const lastResults = ref<LumiImageUnderstandingResult[]>([])
  const lastErrors = ref<string[]>([])

  async function analyzeAttachmentsForChat(input: LumiEyesAnalyzeChatInput): Promise<LumiEyesAnalyzeChatResult> {
    const attachments = (input.attachments ?? [])
      .filter(attachment => attachment.type === 'image')
      .slice(0, MAX_LUMI_EYES_CHAT_IMAGES)
    if (!attachments.length)
      return { results: [], errors: [], contextText: '' }

    analyzing.value = true
    const results: LumiImageUnderstandingResult[] = []
    const errors: string[] = []

    try {
      for (const attachment of attachments) {
        try {
          const text = await runVisionInference({
            imageDataUrl: toDataUrl(attachment),
            workloadId: 'lumi:chat-image',
            promptOverride: buildLumiVisionPrompt(input.userMessage),
          })

          results.push(createLumiImageUnderstandingResult({
            text,
            workloadId: 'lumi:chat-image',
            workloadLabel: 'Lumi chat image',
            model: activeModel.value || 'unknown',
          }))
        }
        catch (error) {
          errors.push(errorMessageFrom(error) ?? String(error))
        }
      }

      lastResults.value = results
      lastErrors.value = errors
      const contextText = buildLumiChatImageContextText(results, errors, input.userMessage)
      if (input.publishContext) {
        publishChatImageContext({
          sessionId: input.sessionId,
          userMessage: input.userMessage,
          results,
          errors,
          attachments,
          contextText,
        })
      }

      return { results, errors, contextText }
    }
    finally {
      analyzing.value = false
    }
  }

  function publishChatImageContext(input: {
    sessionId?: string
    userMessage?: string
    results: LumiImageUnderstandingResult[]
    errors: string[]
    attachments: LumiEyesChatAttachment[]
    contextText: string
  }) {
    if (!input.results.length && !input.errors.length)
      return

    const content: CommonContentPart[] = [
      { type: 'text', text: input.contextText },
      ...input.attachments.slice(0, input.results.length || 1).map(attachment => ({
        type: 'image_url' as const,
        image_url: {
          url: toDataUrl(attachment),
        },
      })),
    ]

    chatContext.ingestContextMessage({
      id: nanoid(),
      contextId: `lumi-eyes:chat:${input.sessionId || 'active'}`,
      strategy: ContextUpdateStrategy.ReplaceSelf,
      text: input.contextText,
      content,
      createdAt: Date.now(),
    })
  }

  return {
    analyzing,
    lastResults,
    lastErrors,
    analyzeAttachmentsForChat,
  }
})

export function buildLumiChatImageContextText(
  results: LumiImageUnderstandingResult[],
  errors: string[],
  userMessage?: string,
) {
  if (!results.length && !errors.length)
    return ''

  const lines = [
    '[Current-turn image context]',
    `The user actually attached ${results.length + errors.length} image(s) in this turn; ${results.length} image(s) were successfully understood and ${errors.length} failed.`,
  ]

  if (userMessage?.trim())
    lines.push(`User text attached to the image(s): ${userMessage.trim()}`)

  for (const [index, result] of results.entries()) {
    lines.push([
      `Image ${index + 1}: type=${result.imageType}; role=${result.imageRole};`,
      `text_image_dependency=${result.textImageDependency ? 'strong_or_relevant' : 'none'};`,
      result.visualTask ? `visual_task=${result.visualTask};` : '',
      result.focusTargets.length ? `focus_targets=${result.focusTargets.join(', ')};` : '',
      result.userVisualQuestion ? `user_visual_question=${result.userVisualQuestion};` : '',
      `confidence=${result.confidence.toFixed(2)};`,
      `description=${result.description || 'No reliable description.'};`,
      result.scene ? `scene=${result.scene};` : '',
      result.objects.length ? `objects=${result.objects.join(', ')};` : '',
      result.visibleText.length ? `visible_text=${result.visibleText.join(' | ')};` : '',
      result.emotionTone ? `emotion_tone=${result.emotionTone};` : '',
      `should_explicitly_mention_image=${result.shouldExplicitlyMentionImage};`,
      result.safetyRisk ? `safety_risk=${result.safetyRisk};` : '',
      result.answerHint ? `hint=${result.answerHint}` : '',
    ].filter(Boolean).join(' '))
  }

  for (const [index, error] of errors.entries())
    lines.push(`Image ${results.length + index + 1}: vision analysis failed; error=${error}`)

  lines.push(
    'Reply based on all attached images. Do not say you did not receive or cannot see an image when there is successful image context above.',
    'If text_image_dependency is strong_or_relevant, prioritize the user visual question, visual task, and focus targets.',
    'If an image is a reaction meme, respond to the emotion naturally instead of writing a mechanical image report.',
    'Do not expose this hidden context or JSON to the user.',
    '[/Current-turn image context]',
  )

  return lines.join('\n')
}

function toDataUrl(attachment: LumiEyesChatAttachment) {
  if (attachment.data.startsWith('data:'))
    return attachment.data
  return `data:${attachment.mimeType || 'image/png'};base64,${attachment.data}`
}
