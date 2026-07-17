import { createDeepSeek } from '@xsai-ext/providers/create'
import { z } from 'zod'

import { ProviderValidationCheck } from '../../types'
import { createOpenAICompatibleValidators } from '../../validators'
import { defineProvider } from '../registry'

const deepSeekConfigSchema = z.object({
  apiKey: z
    .string('API Key'),
  baseUrl: z
    .string('Base URL')
    .optional()
    .default('https://api.deepseek.com/'),
  thinkingMode: z
    .enum(['auto', 'enabled', 'disabled'])
    .optional()
    .default('auto'),
  reasoningEffort: z
    .enum(['auto', 'high', 'max'])
    .optional()
    .default('auto'),
  maxOutputTokens: z
    .number()
    .int()
    .min(0)
    .max(64_000)
    .optional()
    .default(0),
  maxContextMessages: z
    .number()
    .int()
    .min(0)
    .max(500)
    .optional()
    .default(80),
  maxToolSteps: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(64),
})

type DeepSeekConfig = z.input<typeof deepSeekConfigSchema>

function normalizeBaseUrl(value: unknown) {
  let baseUrl = typeof value === 'string' ? value.trim() : ''
  if (baseUrl && !baseUrl.endsWith('/'))
    baseUrl += '/'
  return baseUrl
}

function withDeepSeekRequestOptions(body: Record<string, unknown>, config: DeepSeekConfig) {
  const nextBody = { ...body }
  const thinkingMode = config.thinkingMode || 'auto'
  const reasoningEffort = config.reasoningEffort || 'auto'
  const maxOutputTokens = Number(config.maxOutputTokens || 0)

  if (thinkingMode !== 'auto') {
    nextBody.extra_body = {
      ...(typeof body.extra_body === 'object' && body.extra_body != null ? body.extra_body as Record<string, unknown> : {}),
      thinking: {
        type: thinkingMode,
      },
    }
  }

  if (reasoningEffort !== 'auto')
    nextBody.reasoning_effort = reasoningEffort

  if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0)
    nextBody.max_tokens = Math.min(64_000, Math.max(1, Math.round(maxOutputTokens)))

  return nextBody
}

export const providerDeepSeek = defineProvider<DeepSeekConfig>({
  id: 'deepseek',
  order: 4,
  name: 'DeepSeek',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.deepseek.title'),
  description: 'deepseek.com',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.deepseek.description'),
  tasks: ['chat'],
  icon: 'i-lobe-icons:deepseek',
  iconColor: 'i-lobe-icons:deepseek-color',

  createProviderConfig: ({ t }) => deepSeekConfigSchema.extend({
    apiKey: deepSeekConfigSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: deepSeekConfigSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
    maxToolSteps: deepSeekConfigSchema.shape.maxToolSteps.meta({
      labelLocalized: '最大工具步数',
      descriptionLocalized: '一次回复中允许意识模型连续调用工具的最大步数。浏览器、MCP、批量操作任务可适当调高；过高会让单次回复更久。',
      placeholderLocalized: '64',
    }),
  }),
  createProvider(config) {
    const baseUrl = normalizeBaseUrl(config.baseUrl || 'https://api.deepseek.com/')
    const baseProvider = createDeepSeek(config.apiKey, baseUrl)

    return {
      ...baseProvider,
      chat(model: string) {
        const chatOptions = baseProvider.chat(model)
        return {
          ...chatOptions,
          fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            const body = typeof init?.body === 'string'
              ? JSON.parse(init.body) as Record<string, unknown>
              : {}

            const fetcher = (chatOptions.fetch ?? globalThis.fetch) as typeof globalThis.fetch
            return fetcher(input, {
              ...init,
              headers: {
                ...(init?.headers as Record<string, string> | undefined),
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(withDeepSeekRequestOptions(body, config)),
            })
          },
        }
      },
    }
  },

  validationRequiredWhen(config) {
    return !!config.apiKey?.trim()
  },
  validators: {
    ...createOpenAICompatibleValidators({
      checks: [ProviderValidationCheck.Connectivity, ProviderValidationCheck.ModelList, ProviderValidationCheck.ChatCompletions],
    }),
  },
})
