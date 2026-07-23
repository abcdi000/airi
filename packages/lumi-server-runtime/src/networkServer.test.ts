import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createLumiNetworkServer } from './networkServer'

describe('createLumiNetworkServer', () => {
  it('serves health without exposing management data', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumi-network-test-'))
    const server = await createLumiNetworkServer({
      databasePath: join(directory, 'server.sqlite3'),
      authSecret: 'test-only-secret-with-at-least-thirty-two-characters',
      publicBaseURL: 'http://127.0.0.1:6130',
      serverVersion: 'test',
      createReplyGenerator: () => ({ async generate() { return { content: 'test' } } }),
    })
    try {
      const response = await server.app.request('/health')
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ status: 'ok', role: 'server-runtime' })

      const managementResponse = await server.app.request('/api/manager/users')
      expect(managementResponse.status).toBe(404)
    }
    finally {
      await server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('refuses plaintext listeners reachable beyond the local machine', async () => {
    await expect(createLumiNetworkServer({
      databasePath: 'unused.sqlite3',
      authSecret: 'test-only-secret-with-at-least-thirty-two-characters',
      publicBaseURL: 'http://192.168.1.5:6130',
      hostname: '0.0.0.0',
      serverVersion: 'test',
      createReplyGenerator: () => ({ async generate() { return { content: 'test' } } }),
    })).rejects.toThrow('Lumi refuses plaintext HTTP/WS on a non-loopback listener')
  })

  it('closes a real listener without leaving the server process alive', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumi-network-lifecycle-'))
    const server = await createLumiNetworkServer({
      databasePath: join(directory, 'server.sqlite3'),
      authSecret: 'test-only-secret-with-at-least-thirty-two-characters',
      publicBaseURL: 'http://127.0.0.1',
      hostname: '127.0.0.1',
      port: 0,
      serverVersion: 'test',
      createReplyGenerator: () => ({ async generate() { return { content: 'test' } } }),
    })
    try {
      await server.start()
      await expect(Promise.race([
        server.stop().then(() => 'stopped'),
        new Promise<string>(resolve => setTimeout(resolve, 2_000, 'timeout')),
      ])).resolves.toBe('stopped')
    }
    finally {
      await server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('authenticates voice transcription and enforces the byte limit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumi-network-voice-'))
    const transcribed: Array<{ mimeType: string, bytes: number }> = []
    const server = await createLumiNetworkServer({
      databasePath: join(directory, 'server.sqlite3'),
      authSecret: 'test-only-secret-with-at-least-thirty-two-characters',
      publicBaseURL: 'http://127.0.0.1:6130',
      serverVersion: 'test',
      maxVoiceBytes: 8,
      voiceTranscriber: {
        async transcribe(input) {
          transcribed.push({ mimeType: input.mimeType, bytes: input.audio.byteLength })
          return '你好 Lumi'
        },
      },
      createReplyGenerator: () => ({ async generate() { return { content: 'test' } } }),
      manager: { token: 'test-manager-token-with-at-least-thirty-two-characters' },
    })
    try {
      const bootstrap = await server.managerApp!.request('/bootstrap/doggy', {
        method: 'POST',
        headers: { 'authorization': 'Bearer test-manager-token-with-at-least-thirty-two-characters', 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'doggy', password: 'correct-horse-battery-staple' }),
      })
      expect(bootstrap.status).toBe(200)
      const signIn = await server.app.request('/api/auth/sign-in/username', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'doggy', password: 'correct-horse-battery-staple' }),
      })
      const token = signIn.headers.get('set-auth-token')
      expect(token).toBeTruthy()

      const unauthorized = await server.app.request('/api/lumi/transcribe', {
        method: 'POST',
        headers: { 'content-type': 'audio/wav', 'content-length': '3' },
        body: new Uint8Array([1, 2, 3]),
      })
      expect(unauthorized.status).toBe(401)

      const accepted = await server.app.request('/api/lumi/transcribe', {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'audio/wav', 'content-length': '3' },
        body: new Uint8Array([1, 2, 3]),
      })
      expect(accepted.status).toBe(200)
      expect(await accepted.json()).toEqual({ text: '你好 Lumi' })
      expect(transcribed).toEqual([{ mimeType: 'audio/wav', bytes: 3 }])

      const tooLarge = await server.app.request('/api/lumi/transcribe', {
        method: 'POST',
        headers: { 'authorization': `Bearer ${token}`, 'content-type': 'audio/wav', 'content-length': '9' },
        body: new Uint8Array(9),
      })
      expect(tooLarge.status).toBe(413)
    }
    finally {
      await server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
