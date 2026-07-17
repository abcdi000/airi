import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive, toRefs } from 'vue'

const runVisionInference = vi.fn()
const ingestContextMessage = vi.fn()

vi.mock('pinia', async () => {
  const actual = await vi.importActual<typeof import('pinia')>('pinia')
  return {
    ...actual,
    storeToRefs: (store: object) => toRefs(store as never),
  }
})

vi.mock('../composables/vision', () => ({
  useVisionInference: () => ({
    runVisionInference,
  }),
}))

vi.mock('./chat/context-store', () => ({
  useChatContextStore: () => ({
    ingestContextMessage,
  }),
}))

vi.mock('./modules/vision', () => ({
  useVisionStore: () => reactive({
    activeModel: 'qwen3-vl-flash',
  }),
}))

describe('lumi-eyes store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    runVisionInference.mockReset()
    ingestContextMessage.mockReset()
    runVisionInference.mockResolvedValue(JSON.stringify({
      image_type: 'screenshot',
      image_role: 'main_subject',
      description: 'A chat screenshot.',
      objects: ['chat window'],
      visible_text: 'hello',
      confidence: 0.9,
      text_image_dependency: 'strong',
      visual_task: 'scene_understanding',
      focus_targets: ['chat content'],
      user_visual_question: 'look at this image',
    }))
  })

  it('uses Lumi chat-image workload and Lumi chat prompt for chat attachments', async () => {
    const { useLumiEyesStore } = await import('./lumi-eyes')
    const store = useLumiEyesStore()

    const result = await store.analyzeAttachmentsForChat({
      attachments: [
        {
          type: 'image',
          data: 'aW1hZ2U=',
          mimeType: 'image/png',
        },
      ],
      userMessage: 'look at this image',
    })

    expect(runVisionInference).toHaveBeenCalledWith(expect.objectContaining({
      imageDataUrl: 'data:image/png;base64,aW1hZ2U=',
      workloadId: 'lumi:chat-image',
    }))
    expect(runVisionInference.mock.calls[0]?.[0]?.promptOverride).toContain('You are Lumi Eyes')
    expect(runVisionInference.mock.calls[0]?.[0]?.promptOverride).toContain('User companion text: look at this image')
    expect(result.contextText).toContain('[Current-turn image context]')
    expect(result.contextText).toContain('A chat screenshot.')
  })
})
