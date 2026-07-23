export interface ServerTranscriptionPreset {
  id: string
  name: string
  description: string
  icon: string
  baseURL: string
  models: string[]
  apiKeyOptional?: boolean
}

export const SERVER_TRANSCRIPTION_PRESETS: ServerTranscriptionPreset[] = [
  { id: 'openai', name: 'OpenAI', description: 'OpenAI 文件转写与说话人分离模型', icon: 'i-lobe-icons:openai', baseURL: 'https://api.openai.com/v1/', models: ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'gpt-4o-transcribe-diarize'] },
  { id: 'groq', name: 'Groq', description: '低延迟 Whisper 推理服务', icon: 'i-lobe-icons:groq', baseURL: 'https://api.groq.com/openai/v1/', models: ['whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en'] },
  { id: 'mimo', name: 'Xiaomi MiMo', description: 'MiMo 多模态音频转写接口', icon: 'i-simple-icons:xiaomi', baseURL: 'https://api.xiaomimimo.com/v1/', models: ['mimo-v2-omni'] },
  { id: 'comet-api', name: 'CometAPI', description: '聚合式 OpenAI 兼容音频接口', icon: 'i-lobe-icons:cometapi', baseURL: 'https://api.cometapi.com/v1/', models: ['whisper-1', 'gpt-4o-mini-transcribe'] },
  { id: 'openai-compatible', name: 'OpenAI Compatible', description: '自定义兼容 audio/transcriptions 的服务', icon: 'i-solar:tuning-2-bold-duotone', baseURL: 'http://127.0.0.1:8000/v1/', models: ['whisper-1'], apiKeyOptional: true },
]
