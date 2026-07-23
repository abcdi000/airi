import process from 'node:process'
import readline from 'node:readline'

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  const texts = Array.isArray(request.params?.texts) ? request.params.texts : []
  const vectors = texts.map((text) => {
    const normalized = String(text).toLowerCase()
    return [normalized.includes('birthday') ? 1 : 0, normalized.includes('minecraft') ? 1 : 0]
  })
  process.stdout.write(`${JSON.stringify({
    id: request.id,
    ok: true,
    result: request.method === 'embed'
      ? { model: request.params.model, device: request.params.localFilesOnly ? 'test-local' : 'test-network', dimensions: 2, vectors }
      : { status: 'ok' },
  })}\n`)
})
