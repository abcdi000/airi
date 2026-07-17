import { describe, expect, it } from 'vitest'

import { shouldSkipLumiMemorySearch } from './lumi-memory-tools'

describe('lumi memory search guard', () => {
  it('skips ordinary short chat', () => {
    expect(shouldSkipLumiMemorySearch('你好')).toBeTruthy()
    expect(shouldSkipLumiMemorySearch('行吧')).toBeTruthy()
  })

  it('allows explicit recall questions', () => {
    expect(shouldSkipLumiMemorySearch('你还记得我最喜欢哪个层级吗')).toBe('')
    expect(shouldSkipLumiMemorySearch('上次我说过的项目是什么')).toBe('')
  })

  it('allows relationship and identity fact questions', () => {
    expect(shouldSkipLumiMemorySearch('Doggy的女朋友是谁')).toBe('')
    expect(shouldSkipLumiMemorySearch('Doggy的朋友是谁')).toBe('')
    expect(shouldSkipLumiMemorySearch('我的账号用户名叫什么')).toBe('')
    expect(shouldSkipLumiMemorySearch('之前我说过的昵称是什么')).toBe('')
  })

  it('allows unresolved concrete names before they are explained in visible chat', () => {
    expect(shouldSkipLumiMemorySearch('Moussy在宜宾那边啊')).toBe('')
    expect(shouldSkipLumiMemorySearch('Steam上那个Moussy呢')).toBe('')
  })

  it('skips correction and topic-change messages', () => {
    expect(shouldSkipLumiMemorySearch('不是这个，你说错了')).toBe('topic_change_or_correction')
  })
})
