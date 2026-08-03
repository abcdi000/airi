import process from 'node:process'
import readline from 'node:readline'

import { errorMessageFrom } from '@moeru/std'

const indexes = new Map()
const rebuilds = new Map()

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  const texts = Array.isArray(request.params?.texts) ? request.params.texts : []
  const vectors = texts.map((text) => {
    const normalized = String(text).toLowerCase()
    return [normalized.includes('birthday') ? 1 : 0, normalized.includes('minecraft') ? 1 : 0]
  })
  try {
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      ok: true,
      result: resultFor(request, vectors),
    })}\n`)
  }
  catch (error) {
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      ok: false,
      error: errorMessageFrom(error) ?? 'Unknown fixture worker error',
    })}\n`)
  }
})

function resultFor(request, vectors) {
  const params = request.params ?? {}
  if (request.method === 'embed')
    return { model: params.model, device: params.localFilesOnly ? 'test-local' : 'test-network', dimensions: 2, vectors }
  if (request.method === 'health')
    return { status: 'ok' }
  if (request.method === 'ann_open') {
    const state = indexes.get(params.path)
    return state ? status(state) : missingStatus(params)
  }
  if (request.method === 'ann_rebuild_begin') {
    const state = createState(params)
    rebuilds.set(params.path, state)
    return status(state, false)
  }
  if (request.method === 'ann_rebuild_add') {
    const state = requiredState(rebuilds, params.path)
    upsert(state, params)
    return status(state, false)
  }
  if (request.method === 'ann_rebuild_commit') {
    const state = requiredState(rebuilds, params.path)
    state.sequence = params.sequence
    rebuilds.delete(params.path)
    indexes.set(params.path, state)
    return status(state)
  }
  if (request.method === 'ann_rebuild_abort')
    return { aborted: rebuilds.delete(params.path) }
  if (request.method === 'ann_apply') {
    const state = requiredState(indexes, params.path)
    for (const key of params.removeKeys ?? [])
      state.vectors.delete(key)
    upsert(state, params)
    state.sequence = params.sequence
    return status(state)
  }
  if (request.method === 'ann_search') {
    const state = requiredState(indexes, params.path)
    const matches = [...state.vectors.entries()]
      .map(([key, vector]) => ({ key, score: cosine(params.vector, vector) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, params.count)
    return {
      ...status(state),
      keys: matches.map(match => match.key),
      scores: matches.map(match => match.score),
    }
  }
  throw new Error(`unsupported fixture method: ${request.method}`)
}

function createState(params) {
  return {
    model: params.model,
    dimensions: params.dimensions,
    sequence: 0,
    vectors: new Map(),
  }
}

function requiredState(collection, path) {
  const state = collection.get(path)
  if (!state)
    throw new Error('fixture ANN index is missing')
  return state
}

function upsert(state, params) {
  for (let index = 0; index < (params.keys?.length ?? 0); index += 1)
    state.vectors.set(params.keys[index], params.vectors[index])
}

function status(state, ready = true) {
  return {
    ready,
    needsRebuild: !ready,
    model: state.model,
    dimensions: state.dimensions,
    sequence: state.sequence,
    count: state.vectors.size,
  }
}

function missingStatus(params) {
  return {
    ready: false,
    needsRebuild: true,
    model: params.model,
    dimensions: params.dimensions,
    sequence: 0,
    count: 0,
    reason: 'missing_index',
  }
}

function cosine(left, right) {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] ** 2
    rightNorm += right[index] ** 2
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm) || 1)
}
