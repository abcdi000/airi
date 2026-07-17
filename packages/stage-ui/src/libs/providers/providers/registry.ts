import type { ComposerTranslation } from 'vue-i18n'
import type { $ZodType } from 'zod/v4/core'

import type { ProviderDefinition } from '../types'

import { orderBy } from 'es-toolkit'
import { z } from 'zod'

const providerRegistry = new Map<string, ProviderDefinition>()
const MAX_TOOL_STEPS_FIELD = 'maxToolSteps'

function getSchemaShape(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object')
    return undefined

  const candidate = schema as {
    shape?: Record<string, unknown>
    _def?: {
      shape?: Record<string, unknown> | (() => Record<string, unknown>)
    }
  }

  if (candidate.shape && typeof candidate.shape === 'object')
    return candidate.shape

  const defShape = candidate._def?.shape
  if (typeof defShape === 'function')
    return defShape()
  if (defShape && typeof defShape === 'object')
    return defShape

  return undefined
}

function withChatToolStepConfig<T>(schema: $ZodType<T>): $ZodType<T> {
  const extensible = schema as $ZodType<T> & {
    extend?: (shape: Record<string, unknown>) => $ZodType<T>
  }

  if (typeof extensible.extend !== 'function')
    return schema

  const shape = getSchemaShape(schema)
  if (shape?.[MAX_TOOL_STEPS_FIELD])
    return schema

  return extensible.extend({
    [MAX_TOOL_STEPS_FIELD]: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .default(64)
      .meta({
        labelLocalized: '最大工具步数',
        descriptionLocalized: '一次回复中允许意识模型连续调用工具的最大步数。浏览器、MCP、批量操作任务可适当调高；过高会让单次回复更久。',
        placeholderLocalized: '64',
      }),
  })
}

export function listProviders(): ProviderDefinition[] {
  const providerDefs = Array.from(providerRegistry.values()).map(def => ({ order: 99999, ...def }))
  const sorted = orderBy(providerDefs, [p => p.order, 'name'], ['asc', 'asc'])
  return sorted
}

export function getDefinedProvider(id: string): ProviderDefinition | undefined {
  return providerRegistry.get(id)
}

export function defineProvider<T>(definition: { createProviderConfig: (contextOptions: { t: ComposerTranslation }) => $ZodType<T> } & ProviderDefinition<T>): ProviderDefinition<T> {
  const provider = {
    ...definition,
  }
  if (definition.tasks.includes('chat')) {
    const createProviderConfig = definition.createProviderConfig
    provider.createProviderConfig = contextOptions => withChatToolStepConfig(createProviderConfig(contextOptions))
  }

  providerRegistry.set(definition.id, provider)

  return provider
}
