import { createOpenRouter } from '@xsai-ext/providers/create'
import { z } from 'zod'

import { ProviderValidationCheck } from '../../types'
import { createOpenAICompatibleValidators } from '../../validators'
import { defineProvider } from '../registry'

export const OPENROUTER_ATTRIBUTION_HEADERS: Record<string, string> = {
  'HTTP-Referer': 'https://airi.moeru.ai/',
  'X-OpenRouter-Title': 'Project AIRI',
}

const openRouterConfigSchema = z.object({
  apiKey: z
    .string('API Key'),
  baseUrl: z
    .string('Base URL')
    .optional()
    .default('https://openrouter.ai/api/v1/'),
  maxToolSteps: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(64),
})

type OpenRouterConfig = z.input<typeof openRouterConfigSchema>

export const providerOpenRouterAI = defineProvider<OpenRouterConfig>({
  id: 'openrouter-ai',
  order: 0,
  name: 'OpenRouter',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.openrouter.title'),
  description: 'openrouter.ai',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.openrouter.description'),
  tasks: ['chat'],
  icon: 'i-lobe-icons:openrouter',

  createProviderConfig: ({ t }) => openRouterConfigSchema.extend({
    apiKey: openRouterConfigSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: openRouterConfigSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
    maxToolSteps: openRouterConfigSchema.shape.maxToolSteps.meta({
      labelLocalized: '最大工具步数',
      descriptionLocalized: '一次回复中允许意识模型连续调用工具的最大步数。浏览器、MCP、批量操作任务可适当调高；过高会让单次回复更久。',
      placeholderLocalized: '64',
    }),
  }),
  createProvider(config) {
    const base = createOpenRouter(config.apiKey, config.baseUrl)
    return {
      ...base,
      chat: (model: string) => ({
        ...base.chat(model),
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          const headers = new Headers(init?.headers)
          for (const [k, v] of Object.entries(OPENROUTER_ATTRIBUTION_HEADERS))
            headers.set(k, v)
          return globalThis.fetch(input, { ...init, headers })
        },
      }),
    }
  },

  validationRequiredWhen(config) {
    return !!config.apiKey?.trim()
  },
  validators: {
    ...createOpenAICompatibleValidators({
      checks: [ProviderValidationCheck.Connectivity, ProviderValidationCheck.ModelList, ProviderValidationCheck.ChatCompletions],
      additionalHeaders: OPENROUTER_ATTRIBUTION_HEADERS,
    }),
  },
})
