import { createOpenAI } from '@xsai-ext/providers/create'
import { z } from 'zod'

import { ProviderValidationCheck } from '../../types'
import { createOpenAICompatibleValidators } from '../../validators'
import { defineProvider } from '../registry'

const n1nConfigSchema = z.object({
  apiKey: z
    .string('API Key')
    .optional(),
  baseUrl: z
    .string('Base URL')
    .optional()
    .default('https://api.n1n.ai/v1'),
  maxToolSteps: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .default(64),
})

type N1NConfig = z.input<typeof n1nConfigSchema>

export const providerN1N = defineProvider<N1NConfig>({
  id: 'n1n',
  order: 9,
  name: 'n1n',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.n1n.title'),
  description: 'n1n.ai - High-performance AI API provider.',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.n1n.description'),
  tasks: ['chat'],
  icon: 'i-lobe-icons:openai',

  createProviderConfig: ({ t }) => n1nConfigSchema.extend({
    apiKey: n1nConfigSchema.shape.apiKey.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.api-key.placeholder'),
      type: 'password',
    }),
    baseUrl: n1nConfigSchema.shape.baseUrl.meta({
      labelLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.label'),
      descriptionLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.description'),
      placeholderLocalized: t('settings.pages.providers.catalog.edit.config.common.fields.field.base-url.placeholder'),
    }),
    maxToolSteps: n1nConfigSchema.shape.maxToolSteps.meta({
      labelLocalized: '最大工具步数',
      descriptionLocalized: '一次回复中允许意识模型连续调用工具的最大步数。浏览器、MCP、批量操作任务可适当调高；过高会让单次回复更久。',
      placeholderLocalized: '64',
    }),
  }),
  createProvider(config) {
    return createOpenAI(config.apiKey || '', config.baseUrl)
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
