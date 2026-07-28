import type {
  ToolAvailabilityContext,
  ToolExecutionResult,
  ToolInvocation,
  ToolRegistry,
  ToolSpec,
} from './registry'

import { errorMessageFrom } from '@moeru/std'

/** One step in a host-managed tool DAG. */
export interface ToolPlanStep {
  id: string
  toolName: string
  arguments: Readonly<Record<string, unknown>>
  dependsOn?: readonly string[]
  optional?: boolean
  idempotencyKey?: string
}

/** Execution state recorded for one DAG step. */
export interface ToolPlanStepResult {
  stepId: string
  toolName: string
  success: boolean
  skipped: boolean
  optional: boolean
  startedAt: number
  finishedAt: number
  result?: ToolExecutionResult
  errorCode?: string
  errorMessage?: string
}

/** Complete, auditable tool DAG result. */
export interface ToolPlanExecutionResult {
  success: boolean
  steps: readonly ToolPlanStepResult[]
  startedAt: number
  finishedAt: number
}

/** Tool DAG limits. */
export interface ToolExecutorOptions {
  /** @default 4 */
  maxConcurrency?: number
  /** @default 24 */
  maxSteps?: number
  /** @default 30000 */
  stepTimeoutMs?: number
}

/** Invalid graph or invocation configuration. */
export class ToolPlanValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolPlanValidationError'
  }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const candidate = value === undefined ? fallback : Math.floor(value)
  if (!Number.isFinite(candidate) || candidate < min || candidate > max)
    throw new RangeError(`Expected an integer between ${min} and ${max}`)
  return candidate
}

function validatePlan(steps: readonly ToolPlanStep[], maxSteps: number): Map<string, ToolPlanStep> {
  if (steps.length > maxSteps)
    throw new ToolPlanValidationError(`Tool plan exceeds maxSteps=${maxSteps}`)
  const byId = new Map<string, ToolPlanStep>()
  for (const step of steps) {
    if (!step.id.trim())
      throw new ToolPlanValidationError('Tool plan step ID must be non-empty')
    if (byId.has(step.id))
      throw new ToolPlanValidationError(`Duplicate tool plan step ID: ${step.id}`)
    byId.set(step.id, step)
  }
  for (const step of steps) {
    for (const dependencyId of step.dependsOn ?? []) {
      if (!byId.has(dependencyId))
        throw new ToolPlanValidationError(`Missing dependency ${dependencyId} for step ${step.id}`)
      if (dependencyId === step.id)
        throw new ToolPlanValidationError(`Step ${step.id} cannot depend on itself`)
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (stepId: string): void => {
    if (visiting.has(stepId))
      throw new ToolPlanValidationError(`Cyclic tool plan dependency involving ${stepId}`)
    if (visited.has(stepId))
      return
    visiting.add(stepId)
    const step = byId.get(stepId)
    for (const dependencyId of step?.dependsOn ?? [])
      visit(dependencyId)
    visiting.delete(stepId)
    visited.add(stepId)
  }
  for (const step of steps)
    visit(step.id)
  return byId
}

async function executeWithTimeout(
  spec: ToolSpec,
  invocation: ToolInvocation,
  context: ToolAvailabilityContext,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<ToolExecutionResult> {
  if (spec.idempotencyPolicy === 'required' && !invocation.idempotencyKey)
    throw new ToolPlanValidationError(`Tool ${spec.name} requires an idempotency key`)
  if (parentSignal?.aborted)
    throw parentSignal.reason ?? new Error(`Tool ${spec.name} was aborted`)

  const controller = new AbortController()
  const abortFromParent = (): void => controller.abort(parentSignal?.reason)
  parentSignal?.addEventListener('abort', abortFromParent, { once: true })

  let timeout: ReturnType<typeof setTimeout> | undefined
  let rejectOnAbort: (() => void) | undefined
  try {
    const aborted = new Promise<ToolExecutionResult>((_resolve, reject) => {
      rejectOnAbort = () => {
        reject(controller.signal.reason ?? new Error(`Tool ${spec.name} was aborted`))
      }
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
    })
    timeout = setTimeout(() => {
      controller.abort(new Error(`Tool ${spec.name} timed out after ${timeoutMs} ms`))
    }, timeoutMs)

    return await Promise.race([
      spec.handler({
        invocation,
        conversationId: context.conversationId,
        personId: context.personId,
        signal: controller.signal,
      }),
      aborted,
    ])
  }
  finally {
    if (timeout)
      clearTimeout(timeout)
    if (rejectOnAbort)
      controller.signal.removeEventListener('abort', rejectOnAbort)
    parentSignal?.removeEventListener('abort', abortFromParent)
  }
}

async function executeStep(
  registry: ToolRegistry,
  step: ToolPlanStep,
  context: ToolAvailabilityContext,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ToolPlanStepResult> {
  const startedAt = Date.now()
  const spec = registry.get(step.toolName)
  if (!spec) {
    return {
      stepId: step.id,
      toolName: step.toolName,
      success: false,
      skipped: false,
      optional: step.optional ?? false,
      startedAt,
      finishedAt: Date.now(),
      errorCode: 'TOOL_NOT_FOUND',
      errorMessage: `Tool not found: ${step.toolName}`,
    }
  }
  if (!await registry.canExecute(step.toolName, context)) {
    return {
      stepId: step.id,
      toolName: step.toolName,
      success: false,
      skipped: true,
      optional: step.optional ?? false,
      startedAt,
      finishedAt: Date.now(),
      errorCode: 'TOOL_NOT_AVAILABLE',
      errorMessage: `Tool is not available in the current runtime context: ${step.toolName}`,
    }
  }

  try {
    const effectiveTimeoutMs = boundedInteger(spec.timeoutMs, timeoutMs, 10, 600_000)
    const result = await executeWithTimeout(spec, {
      callId: step.id,
      toolName: step.toolName,
      arguments: step.arguments,
      idempotencyKey: step.idempotencyKey,
    }, context, effectiveTimeoutMs, signal)
    return {
      stepId: step.id,
      toolName: step.toolName,
      success: result.success,
      skipped: false,
      optional: step.optional ?? false,
      startedAt,
      finishedAt: Date.now(),
      result,
      ...(!result.success
        ? {
            errorCode: result.errorCode ?? 'TOOL_FAILED',
            errorMessage: result.errorMessage ?? `Tool failed: ${step.toolName}`,
          }
        : {}),
    }
  }
  catch (error) {
    return {
      stepId: step.id,
      toolName: step.toolName,
      success: false,
      skipped: false,
      optional: step.optional ?? false,
      startedAt,
      finishedAt: Date.now(),
      errorCode: error instanceof ToolPlanValidationError
        ? 'INVALID_INVOCATION'
        : signal?.aborted
          ? 'TOOL_EXECUTION_ABORTED'
          : 'TOOL_EXECUTION_ERROR',
      errorMessage: errorMessageFrom(error) ?? 'Tool execution failed',
    }
  }
}

async function runWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  run: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      const value = values[index]
      if (value !== undefined)
        await run(value)
    }
  })
  await Promise.all(workers)
}

/**
 * Executes a validated tool DAG with bounded parallelism.
 *
 * Use when:
 * - A Planner step emits multiple tool calls
 * - Tool Mesh adapts a compound plan into shared ToolSpecs
 *
 * Expects:
 * - Side-effecting steps provide required idempotency keys
 * - The registry owns risk and confirmation policy in each handler
 *
 * Returns:
 * - Chronologically sorted, auditable results for every planned step
 */
export async function executeToolPlan(
  registry: ToolRegistry,
  steps: readonly ToolPlanStep[],
  context: ToolAvailabilityContext,
  options: ToolExecutorOptions = {},
  signal?: AbortSignal,
): Promise<ToolPlanExecutionResult> {
  const maxConcurrency = boundedInteger(options.maxConcurrency, 4, 1, 32)
  const maxSteps = boundedInteger(options.maxSteps, 24, 1, 256)
  const stepTimeoutMs = boundedInteger(options.stepTimeoutMs, 30_000, 10, 600_000)
  const byId = validatePlan(steps, maxSteps)
  const startedAt = Date.now()
  const results = new Map<string, ToolPlanStepResult>()
  const pending = new Set(steps.map(step => step.id))

  while (pending.size > 0) {
    if (signal?.aborted)
      throw signal.reason ?? new Error('Tool plan aborted')

    const ready = [...pending]
      .map(stepId => byId.get(stepId))
      .filter((step): step is ToolPlanStep => Boolean(step))
      .filter(step => (step.dependsOn ?? []).every(dependencyId => results.has(dependencyId)))
    if (ready.length === 0)
      throw new ToolPlanValidationError('Tool plan cannot make progress')

    await runWithConcurrency(ready, maxConcurrency, async (step) => {
      const blockedBy = (step.dependsOn ?? [])
        .map(dependencyId => ({ dependency: byId.get(dependencyId), result: results.get(dependencyId) }))
        .find(item => item.result && !item.result.success && !item.dependency?.optional)
      if (blockedBy) {
        const now = Date.now()
        results.set(step.id, {
          stepId: step.id,
          toolName: step.toolName,
          success: false,
          skipped: true,
          optional: step.optional ?? false,
          startedAt: now,
          finishedAt: now,
          errorCode: 'DEPENDENCY_FAILED',
          errorMessage: `Dependency failed: ${blockedBy.dependency?.id ?? 'unknown'}`,
        })
      }
      else {
        results.set(step.id, await executeStep(registry, step, context, stepTimeoutMs, signal))
      }
      pending.delete(step.id)
    })
  }

  const orderedResults = steps
    .map(step => results.get(step.id))
    .filter((result): result is ToolPlanStepResult => Boolean(result))
  return {
    success: orderedResults.every(result => result.success || result.optional),
    steps: orderedResults,
    startedAt,
    finishedAt: Date.now(),
  }
}
