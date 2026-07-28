import { describe, expect, it } from 'vitest'

import { parsePlannerToolArguments } from './model'

describe('planner tool argument normalization', () => {
  it('parses strict and double-encoded JSON objects', () => {
    expect(parsePlannerToolArguments('{"query":"Lumi"}')).toEqual({ query: 'Lumi' })
    expect(parsePlannerToolArguments('"{\\"query\\":\\"Lumi\\"}"')).toEqual({ query: 'Lumi' })
  })

  it('repairs bounded DeepSeek-style JSON syntax without changing string content', () => {
    expect(parsePlannerToolArguments('```json\n{"query":"Lumi",}\n```')).toEqual({ query: 'Lumi' })
    expect(parsePlannerToolArguments('工具参数：{query: \'Lumi\', limit: 3}')).toEqual({
      query: 'Lumi',
      limit: 3,
    })
    expect(parsePlannerToolArguments('{"query":"保留 {foo: bar,} 原文",}')).toEqual({
      query: '保留 {foo: bar,} 原文',
    })
  })

  it('rejects truncated documents and non-object values', () => {
    expect(parsePlannerToolArguments('{"query":"unfinished"')).toBeUndefined()
    expect(parsePlannerToolArguments('["not", "an", "object"]')).toBeUndefined()
    expect(parsePlannerToolArguments('totally invalid')).toBeUndefined()
  })
})
