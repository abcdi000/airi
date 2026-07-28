import type { PersistedWaitContinuation } from '../../ports/persistence'
import type { WaitController, WaitResult } from '../../runtime/wait-controller'
import type { ToolSpec } from '../registry'

/**
 * Creates the Planner wait tool for one direct session.
 */
export function createWaitTool<TMessage>(options: {
  controller: WaitController<TMessage>
  onResumedMessage?: (message: TMessage) => Promise<void> | void
  continuation?: () => PersistedWaitContinuation
}): ToolSpec {
  return {
    name: 'wait',
    description: '暂停当前私聊，直到收到新消息或达到限定等待时间。',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: {
          type: 'number',
          minimum: 0,
          maximum: 3600,
        },
      },
      required: ['seconds'],
      additionalProperties: false,
    },
    provider: 'lumi-agent-runtime',
    visibility: 'visible',
    stage: 'planner',
    chatScope: 'direct',
    riskLevel: 'low',
    executionMode: 'automatic',
    sideEffectType: 'none',
    idempotencyPolicy: 'none',
    requiredScopes: [],
    async handler({ invocation, signal }) {
      const seconds = numberValue(invocation.arguments.seconds)
      if (seconds === undefined) {
        return {
          success: false,
          errorCode: 'INVALID_WAIT_DURATION',
          errorMessage: 'wait.seconds must be a finite number.',
        }
      }
      const result = await options.controller.wait({
        toolCallId: invocation.callId,
        targetSeconds: seconds,
        continuation: options.continuation?.(),
        signal,
      })
      if (result.reason === 'message' && result.message !== undefined)
        await options.onResumedMessage?.(result.message)
      return {
        success: true,
        output: publicWaitResult(result),
      }
    },
  }
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(3_600, value))
    : undefined
}

function publicWaitResult<TMessage>(result: WaitResult<TMessage>) {
  return {
    reason: result.reason,
    waitedMs: result.waitedMs,
    receivedNewMessage: result.reason === 'message',
  }
}
