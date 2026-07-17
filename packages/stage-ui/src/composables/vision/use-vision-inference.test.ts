import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive, toRefs } from 'vue'

const stream = vi.fn()
const getProviderInstance = vi.fn()
const getProviderMetadata = vi.fn()

vi.mock('pinia', async () => {
  const actual = await vi.importActual<typeof import('pinia')>('pinia')
  return {
    ...actual,
    storeToRefs: (store: object) => toRefs(store as never),
  }
})

vi.mock('../../stores/llm', () => ({
  useLLM: () => ({
    stream,
  }),
}))

vi.mock('../../stores/providers', () => ({
  useProvidersStore: () => ({
    getProviderInstance,
    getProviderMetadata,
  }),
}))

vi.mock('../../stores/modules/vision', () => ({
  useVisionStore: () => reactive({
    activeProvider: 'mock-provider',
    activeModel: 'mock-model',
    ollamaThinkingEnabled: false,
  }),
}))

vi.mock('./use-vision-workloads', () => ({
  getVisionWorkload: () => ({
    prompt: 'Interpret this frame',
  }),
}))

describe('useVisionInference', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    stream.mockReset()
    getProviderInstance.mockReset()
    getProviderInstance.mockResolvedValue({
      chat: vi.fn().mockReturnValue({
        apiKey: 'test-key',
        baseURL: 'https://example.com/v1/',
      }),
    })
    getProviderMetadata.mockReset()
    getProviderMetadata.mockReturnValue({ category: 'vision' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes an abort signal to llmStore.stream', async () => {
    stream.mockImplementation(async (_model, _provider, _messages, options) => {
      expect(options?.abortSignal).toBeInstanceOf(AbortSignal)
      expect(options?.supportsTools).toBe(false)
      expect(options?.waitForTools).toBe(false)
      expect(options?.captureToolErrors).toBe(false)
      options?.onStreamEvent?.({ type: 'text-delta', text: 'Frame summary' })
    })

    const { useVisionInference } = await import('./use-vision-inference')
    const { runVisionInference } = useVisionInference()

    await expect(runVisionInference({
      imageDataUrl: 'data:image/png;base64,Zm9v',
      workloadId: 'screen:interpret',
    })).resolves.toBe('Frame summary')
  })

  it('aborts vision inference when the stream never settles', async () => {
    stream.mockImplementation((_model, _provider, _messages, options) => new Promise((_, reject) => {
      options?.abortSignal?.addEventListener('abort', () => {
        reject(options.abortSignal?.reason)
      }, { once: true })
    }))

    const { useVisionInference } = await import('./use-vision-inference')
    const { runVisionInference } = useVisionInference()

    const result = runVisionInference({
      imageDataUrl: 'data:image/png;base64,Zm9v',
      workloadId: 'screen:interpret',
    })
    const expectation = expect(result).rejects.toThrow('Vision inference timed out after 60000ms')

    await vi.advanceTimersByTimeAsync(60_000)

    await expectation
  })
})
