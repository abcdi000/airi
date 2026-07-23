export type ProviderFieldId = 'accountId' | 'apiVersion' | 'region' | 'resourceName'

export interface ServerProviderPreset {
  id: string
  name: string
  description: string
  icon: string
  baseURL: string
  defaultModels: string[]
  balance?: 'deepseek'
  apiKeyOptional?: boolean
  fields?: ProviderFieldId[]
  modelList?: 'api' | 'static'
}

function compatible(
  id: string,
  name: string,
  description: string,
  icon: string,
  baseURL: string,
  options: Partial<ServerProviderPreset> = {},
): ServerProviderPreset {
  return { id, name, description, icon, baseURL, defaultModels: [], modelList: 'api', ...options }
}

/** Chat providers mirrored from the client provider registry. */
export const SERVER_PROVIDER_PRESETS: ServerProviderPreset[] = [
  compatible('openrouter-ai', 'OpenRouter', '聚合全球模型，模型目录实时获取', 'i-lobe-icons:openrouter', 'https://openrouter.ai/api/v1/'),
  compatible('aihubmix', 'AIHubMix', '多模型聚合服务', 'i-lobe-icons:aihubmix-color', 'https://aihubmix.com/v1/'),
  compatible('azure-openai', 'Azure OpenAI', 'Microsoft Azure OpenAI 部署', 'i-simple-icons:microsoftazure', 'https://YOUR_RESOURCE_NAME.cognitiveservices.azure.com/openai/v1/', { fields: ['apiVersion'], modelList: 'static' }),
  compatible('deepseek', 'DeepSeek', '官方 API，支持思考模式和余额查询', 'i-lobe-icons:deepseek-color', 'https://api.deepseek.com/', { defaultModels: ['deepseek-v4-flash', 'deepseek-v4-pro'], balance: 'deepseek' }),
  compatible('openai', 'OpenAI', 'OpenAI 官方 API', 'i-lobe-icons:openai', 'https://api.openai.com/v1/'),
  compatible('anthropic', 'Anthropic', 'Claude 模型官方 API', 'i-lobe-icons:claude-color', 'https://api.anthropic.com/v1/', { defaultModels: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805'], modelList: 'static' }),
  compatible('volcengine-coding-plan', '火山引擎 Coding Plan', '火山方舟 Coding Plan', 'i-lobe-icons:volcengine', 'https://ark.cn-beijing.volces.com/api/coding/v3/', { defaultModels: ['doubao-seed-2.0-code', 'doubao-seed-2.0-pro', 'doubao-seed-2.0-lite', 'doubao-seed-code', 'minimax-m2.5', 'glm-4.7', 'deepseek-v3.2', 'kimi-k2.5'], modelList: 'static' }),
  compatible('byteplus', 'BytePlus', 'BytePlus ModelArk', 'i-lobe-icons:bytedance-color', 'https://ark.ap-southeast.bytepluses.com/api/v3/', { defaultModels: ['seed-2-0-pro-260328', 'seed-2-0-lite-260228', 'seed-2-0-mini-260215', 'kimi-k2-5-260127', 'glm-4-7-251222'], modelList: 'static' }),
  compatible('byteplus-coding-plan', 'BytePlus Coding Plan', 'BytePlus 编程模型套餐', 'i-lobe-icons:bytedance-color', 'https://ark.ap-southeast.bytepluses.com/api/coding/v3/', { defaultModels: ['dola-seed-2.0-pro', 'dola-seed-2.0-lite', 'bytedance-seed-code', 'glm-4.7', 'kimi-k2.5', 'gpt-oss-120b'], modelList: 'static' }),
  compatible('google-generative-ai', 'Google Gemini', 'Google AI Studio OpenAI 兼容接口', 'i-lobe-icons:gemini-color', 'https://generativelanguage.googleapis.com/v1beta/openai/'),
  compatible('amazon-bedrock', 'Amazon Bedrock', 'AWS Bedrock Mantle OpenAI 兼容端点', 'i-lobe-icons:aws-color', 'https://bedrock-mantle.us-east-1.api.aws/v1/', { fields: ['region'] }),
  compatible('azure-ai-foundry', 'Azure AI Foundry', 'Azure AI 模型推理终结点', 'i-simple-icons:microsoftazure', 'https://YOUR_RESOURCE_NAME.services.ai.azure.com/models/', { modelList: 'static' }),
  compatible('groq', 'Groq', '高速云端推理', 'i-lobe-icons:groq', 'https://api.groq.com/openai/v1/'),
  compatible('siliconflow', 'SiliconFlow', '硅基流动模型 API', 'i-solar:cloud-bold-duotone', 'https://api.siliconflow.cn/v1/'),
  compatible('xai', 'xAI', 'Grok 官方 API', 'i-lobe-icons:xai', 'https://api.x.ai/v1/'),
  compatible('zai', 'Z.ai', '智谱国际 API', 'i-lobe-icons:zai', 'https://api.z.ai/api/paas/v4/'),
  compatible('moonshot-ai', 'Moonshot AI', 'Kimi 官方 API', 'i-lobe-icons:moonshot', 'https://api.moonshot.ai/v1/'),
  compatible('minimax', 'MiniMax', 'MiniMax 中国大陆 API', 'i-lobe-icons:minimax-color', 'https://api.minimaxi.com/v1/', { defaultModels: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'M2-her'], modelList: 'static' }),
  compatible('minimax-global', 'MiniMax Global', 'MiniMax 国际 API', 'i-lobe-icons:minimax-color', 'https://api.minimax.io/v1/', { defaultModels: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'M2-her'], modelList: 'static' }),
  compatible('mistral-ai', 'Mistral', 'Mistral AI 官方 API', 'i-lobe-icons:mistral-color', 'https://api.mistral.ai/v1/'),
  compatible('perplexity-ai', 'Perplexity', '联网检索与研究模型', 'i-lobe-icons:perplexity-color', 'https://api.perplexity.ai/', { defaultModels: ['sonar', 'sonar-pro', 'sonar-reasoning-pro', 'sonar-deep-research'], modelList: 'static' }),
  compatible('nvidia', 'NVIDIA NIM', 'NVIDIA API Catalog', 'i-simple-icons:nvidia', 'https://integrate.api.nvidia.com/v1/'),
  compatible('cerebras-ai', 'Cerebras', 'Cerebras 高速推理', 'i-lobe-icons:cerebras-color', 'https://api.cerebras.ai/v1/'),
  compatible('together-ai', 'Together.ai', 'Together 推理平台', 'i-lobe-icons:together-color', 'https://api.together.xyz/v1/'),
  compatible('fireworks-ai', 'Fireworks.ai', 'Fireworks 推理平台', 'i-lobe-icons:fireworks-color', 'https://api.fireworks.ai/inference/v1/'),
  compatible('featherless-ai', 'Featherless.ai', '开源模型推理平台', 'i-lobe-icons:featherless-color', 'https://api.featherless.ai/v1/'),
  compatible('novita-ai', 'Novita AI', 'Novita 模型 API', 'i-lobe-icons:novita-color', 'https://api.novita.ai/openai/'),
  compatible('modelscope', 'ModelScope', '魔搭社区推理 API', 'i-lobe-icons:modelscope-color', 'https://api-inference.modelscope.cn/v1/'),
  compatible('mimo', 'Xiaomi MiMo', '小米 MiMo 官方 API', 'i-simple-icons:xiaomi', 'https://api.xiaomimimo.com/v1/'),
  compatible('comet-api', 'CometAPI', '多模型聚合 API', 'i-lobe-icons:cometapi', 'https://api.cometapi.com/v1/'),
  compatible('302-ai', '302.AI', '多模型聚合 API', 'i-lobe-icons:ai302', 'https://api.302.ai/v1/'),
  compatible('n1n', 'n1n', 'OpenAI 兼容模型服务', 'i-solar:bolt-circle-bold-duotone', 'https://api.n1n.ai/v1/'),
  compatible('cloudflare-workers-ai', 'Cloudflare Workers AI', 'Cloudflare 账户级推理接口', 'i-lobe-icons:cloudflare-color', 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1/', { fields: ['accountId'] }),
  compatible('lm-studio', 'LM Studio', '本机 LM Studio 服务', 'i-lobe-icons:lmstudio', 'http://127.0.0.1:1234/v1/', { apiKeyOptional: true }),
  compatible('ollama', 'Ollama', '本机 Ollama 服务', 'i-lobe-icons:ollama', 'http://127.0.0.1:11434/v1/', { apiKeyOptional: true }),
  compatible('openai-compatible', 'OpenAI Compatible', '任意 OpenAI 兼容服务', 'i-solar:tuning-2-bold-duotone', 'http://127.0.0.1:8000/v1/', { apiKeyOptional: true }),
]
