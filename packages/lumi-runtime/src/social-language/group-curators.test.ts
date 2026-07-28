import { describe, expect, it } from 'vitest'

import {
  observePublicGroupKnowledge,
  parseObservedGroupCuratorOutput,
} from './group-curators'

describe('independent group learning curators', () => {
  it('accepts a structured expression only when all source messages belong to the focus batch', () => {
    const result = parseObservedGroupCuratorOutput({
      kind: 'expression',
      raw: JSON.stringify({
        candidates: [{
          sourceMessageIds: ['message-1', 'message-2'],
          phrase: '不是哥们',
          situation: '朋友间遇到意外情况',
          pragmaticFunction: '用短句表达意外',
          patternType: 'reaction',
          confidence: 0.9,
        }],
      }),
      allowedMessageIds: new Set(['message-1', 'message-2']),
    })

    expect(result.valid).toBe(true)
    expect(result.expressions).toHaveLength(1)
    expect(result.expressions[0]?.sourceMessageIds).toEqual(['message-1', 'message-2'])
    expect(result.jargon).toHaveLength(0)
    expect(result.behaviors).toHaveLength(0)
    expect(result.publicKnowledge).toHaveLength(0)
  })

  it('rejects an otherwise valid candidate when the model invents a source message', () => {
    const result = parseObservedGroupCuratorOutput({
      kind: 'behavior',
      raw: JSON.stringify({
        candidates: [{
          sourceMessageIds: ['invented-message'],
          situation: '聊天突然安静',
          action: '先等一会再决定是否接话',
          confidence: 0.9,
        }],
      }),
      allowedMessageIds: new Set(['message-1']),
    })

    expect(result.valid).toBe(false)
    expect(result.warning).toContain('provenance')
    expect(result.behaviors).toHaveLength(0)
  })

  it('rejects candidates that embed a sender name or account identifier', () => {
    const result = parseObservedGroupCuratorOutput({
      kind: 'jargon',
      raw: JSON.stringify({
        candidates: [{
          sourceMessageIds: ['message-1'],
          term: 'Doggy专用说法',
          meaning: '由账号 1770249418 使用的表达',
          context: '群聊',
          pragmaticFunctions: ['调侃'],
          confidence: 0.95,
        }],
      }),
      allowedMessageIds: new Set(['message-1']),
      forbiddenIdentityStrings: ['Doggy', '1770249418'],
    })

    expect(result.valid).toBe(false)
    expect(result.jargon).toHaveLength(0)
  })

  it('keeps each curator output isolated to its own knowledge type', () => {
    const behavior = parseObservedGroupCuratorOutput({
      kind: 'behavior',
      raw: JSON.stringify({
        candidates: [{
          sourceMessageIds: ['message-1'],
          situation: '对方连续发短消息',
          action: '等消息发完再一起回应',
          expectedEffect: '避免打断',
          confidence: 0.88,
        }],
      }),
      allowedMessageIds: new Set(['message-1']),
    })
    const knowledge = parseObservedGroupCuratorOutput({
      kind: 'public_knowledge',
      raw: JSON.stringify({
        candidates: [{
          sourceMessageIds: ['message-1'],
          content: '这个群周末常约游戏',
          confidence: 0.86,
        }],
      }),
      allowedMessageIds: new Set(['message-1']),
    })

    expect(behavior.valid).toBe(true)
    expect(behavior.behaviors).toHaveLength(1)
    expect(behavior.publicKnowledge).toHaveLength(0)
    expect(knowledge.valid).toBe(true)
    expect(knowledge.publicKnowledge).toHaveLength(1)
    expect(knowledge.behaviors).toHaveLength(0)
  })

  it('requires repeated source-backed observations before public knowledge becomes active', () => {
    const first = observePublicGroupKnowledge({
      id: 'knowledge-1',
      sourceId: 'study-group-1',
      sourceMessageIds: ['message-1'],
      proposal: {
        content: '这个群周末常约游戏',
        confidence: 0.9,
      },
      timestamp: 100,
    })
    const second = observePublicGroupKnowledge({
      existing: first,
      id: first.id,
      sourceId: first.sourceId,
      sourceMessageIds: ['message-2'],
      proposal: {
        content: first.content,
        confidence: 0.9,
      },
      timestamp: 200,
    })

    expect(first.status).toBe('candidate')
    expect(second.status).toBe('active')
    expect(second.sourceMessageIds).toEqual(['message-1', 'message-2'])
    expect(second.observationCount).toBe(2)
  })
})
