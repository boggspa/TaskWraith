import { describe, expect, it } from 'vitest'
import { buildCompletionPushPlaintext } from './CompletionPushContent'

describe('buildCompletionPushPlaintext', () => {
  it('produces the agreed JSON contract', () => {
    const buf = buildCompletionPushPlaintext({
      title: 'Codex',
      preview: 'Refactored the transcript card',
      filesChanged: 3,
      additions: 128,
      deletions: 44
    })
    expect(JSON.parse(buf.toString('utf8'))).toEqual({
      title: 'Codex',
      preview: 'Refactored the transcript card',
      filesChanged: 3,
      additions: 128,
      deletions: 44
    })
  })

  it('clips an over-long preview/title and normalizes the counts', () => {
    const buf = buildCompletionPushPlaintext({
      title: 't'.repeat(200),
      preview: 'x'.repeat(500),
      filesChanged: -2,
      additions: 1.9,
      deletions: Number.NaN
    })
    const parsed = JSON.parse(buf.toString('utf8'))
    expect(Array.from(parsed.preview as string)).toHaveLength(240)
    expect((parsed.preview as string).endsWith('…')).toBe(true)
    expect(Array.from(parsed.title as string)).toHaveLength(80)
    expect(parsed.filesChanged).toBe(0) // negative clamped
    expect(parsed.additions).toBe(1) // floored
    expect(parsed.deletions).toBe(0) // NaN → 0
  })

  it('clips on code-point boundaries (never splits a surrogate pair)', () => {
    const buf = buildCompletionPushPlaintext({
      title: '',
      preview: '😀'.repeat(300),
      filesChanged: 0,
      additions: 0,
      deletions: 0
    })
    const parsed = JSON.parse(buf.toString('utf8'))
    expect(Array.from(parsed.preview as string)).toHaveLength(240)
    expect((parsed.preview as string).includes('�')).toBe(false)
  })

  it('trims surrounding whitespace', () => {
    const buf = buildCompletionPushPlaintext({
      title: '  Codex  ',
      preview: '\n done \n',
      filesChanged: 0,
      additions: 0,
      deletions: 0
    })
    const parsed = JSON.parse(buf.toString('utf8'))
    expect(parsed.title).toBe('Codex')
    expect(parsed.preview).toBe('done')
  })
})
