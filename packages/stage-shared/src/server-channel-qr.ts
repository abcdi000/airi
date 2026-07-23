import type { InferInput, InferOutput } from 'valibot'

import { array, check, literal, maxLength, minLength, object, parse, pipe, string, transform } from 'valibot'

export const SERVER_CHANNEL_QR_PAYLOAD_TYPE = 'airi:server-channel'
export const SERVER_CHANNEL_QR_PAYLOAD_VERSION = 1

export const LUMI_CHANNEL_CHAT_SCOPE = 'lumi:chat' as const
export const LUMI_CHANNEL_TOOL_SCOPES = [
  'lumi:tool:memory',
  'lumi:tool:web',
  'lumi:tool:minecraft',
  'lumi:tool:computer-use',
] as const
export type LumiChannelToolScope = typeof LUMI_CHANNEL_TOOL_SCOPES[number]
export const LUMI_CHANNEL_DEVICE_SCOPES = [LUMI_CHANNEL_CHAT_SCOPE, ...LUMI_CHANNEL_TOOL_SCOPES] as const
export type LumiChannelDeviceScope = typeof LUMI_CHANNEL_DEVICE_SCOPES[number]

/** Host limits for one reliable Lumi room voice message. */
export const LUMI_ROOM_VOICE_MAX_BYTES = 8 * 1024 * 1024
export const LUMI_ROOM_VOICE_MAX_DURATION_MS = 120_000
export const LUMI_ROOM_VOICE_MIME_TYPES = ['audio/wav', 'audio/wave', 'audio/x-wav'] as const

/** Returns whether an untrusted value is a currently issuable Lumi device scope. */
export function isLumiChannelDeviceScope(value: string): value is LumiChannelDeviceScope {
  return (LUMI_CHANNEL_DEVICE_SCOPES as readonly string[]).includes(value)
}

function isWebSocketUrl(value: string) {
  try {
    const url = new URL(value)
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && !!url.hostname
  }
  catch {
    return false
  }
}

function normalizeWebSocketUrl(value: string) {
  return new URL(value).toString()
}

export const ServerChannelQrUrlSchema = pipe(
  string(),
  check(isWebSocketUrl, 'Expected a ws or wss URL.'),
  transform(normalizeWebSocketUrl),
)

export const ServerChannelQrPayloadSchema = object({
  type: literal(SERVER_CHANNEL_QR_PAYLOAD_TYPE),
  version: literal(SERVER_CHANNEL_QR_PAYLOAD_VERSION),
  urls: pipe(array(ServerChannelQrUrlSchema), minLength(1)),
  authToken: string(),
})

export type ServerChannelQrPayloadInput = InferInput<typeof ServerChannelQrPayloadSchema>
export type ServerChannelQrPayload = InferOutput<typeof ServerChannelQrPayloadSchema>

export const LumiChannelDeviceQrPayloadSchema = object({
  type: literal('lumi:channel-device'),
  version: literal(1),
  urls: pipe(array(ServerChannelQrUrlSchema), minLength(1)),
  authToken: pipe(string(), minLength(1), maxLength(512)),
  conversationId: pipe(string(), minLength(1), maxLength(240)),
  roomTitle: pipe(string(), minLength(1), maxLength(160)),
  actor: object({
    provider: pipe(string(), minLength(1), maxLength(160)),
    providerInstanceId: pipe(string(), minLength(1), maxLength(160)),
    externalUserId: pipe(string(), minLength(1), maxLength(160)),
  }),
})

export type LumiChannelDeviceQrPayloadInput = InferInput<typeof LumiChannelDeviceQrPayloadSchema>
export type LumiChannelDeviceQrPayload = InferOutput<typeof LumiChannelDeviceQrPayloadSchema>

export function createServerChannelQrPayload(payload: ServerChannelQrPayloadInput) {
  return parse(ServerChannelQrPayloadSchema, payload)
}

export function parseServerChannelQrPayload(raw: string) {
  return parse(ServerChannelQrPayloadSchema, JSON.parse(raw))
}

/** Creates the one-device Lumi LAN pairing payload shown immediately after credential creation. */
export function createLumiChannelDeviceQrPayload(payload: LumiChannelDeviceQrPayloadInput) {
  return parse(LumiChannelDeviceQrPayloadSchema, payload)
}

/** Parses a Lumi LAN device pairing QR payload. */
export function parseLumiChannelDeviceQrPayload(raw: string) {
  return parse(LumiChannelDeviceQrPayloadSchema, JSON.parse(raw))
}
