import { describe, expect, it } from 'vitest'
import { buildQuestionPushPlaintext } from './QuestionPushContent'

describe('buildQuestionPushPlaintext', () => {
  it('keeps only the first meaningful question line', () => {
    const out = JSON.parse(
      buildQuestionPushPlaintext({
        question: '\n  Should I ship it?\nSecond line with more context.'
      }).toString('utf8')
    )

    expect(out).toEqual({ question: 'Should I ship it?' })
  })

  it('falls back to a non-empty prompt and clips long text', () => {
    const empty = JSON.parse(buildQuestionPushPlaintext({ question: '   ' }).toString('utf8'))
    expect(empty.question).toBe('Open TaskWraith to answer.')

    const clipped = JSON.parse(
      buildQuestionPushPlaintext({ question: 'x'.repeat(300) }).toString('utf8')
    )
    expect(Array.from(clipped.question)).toHaveLength(180)
    expect(clipped.question.endsWith('…')).toBe(true)
  })
})
