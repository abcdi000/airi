#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

function toRuntimeString(raw: string): string {
  return raw
    .replace(/\\v/g, '\v')
    .replace(/\\\\/g, '\\')
}

const sourcePath = process.argv[2]
if (!sourcePath)
  throw new Error('Usage: decode-boss-safety <path-to-main.js>')

const source = await readFile(sourcePath, 'utf8')
const branchStart = source.indexOf('if(n&&i&&a&&o)', 660_000)
const decoderStart = source.lastIndexOf('function L(e)', branchStart)
const decoderEnd = source.indexOf('var Wh', decoderStart)
if (decoderStart < 0 || decoderEnd < 0 || branchStart < 0)
  throw new Error('Expected safety decoder or branch was not found')

const createDecoder = new Function(
  'window',
  `${source.slice(decoderStart, decoderEnd)}; return L`,
) as (window: { atob: typeof atob, TextDecoder: typeof TextDecoder }) => (value: string) => string
const decode = createDecoder({ atob, TextDecoder })
const branch = source.slice(branchStart, branchStart + 2_500)
const values = [...branch.matchAll(/L\("((?:\\.|[^"\\])*)"\)/g)]
  .map(match => match[1])

for (const encoded of new Set(values)) {
  let decoded: string
  try {
    decoded = decode(toRuntimeString(encoded))
  }
  catch (error) {
    decoded = `<decode failed: ${error instanceof Error ? error.message : String(error)}>`
  }
  console.log(JSON.stringify({ encoded, decoded }))
}
