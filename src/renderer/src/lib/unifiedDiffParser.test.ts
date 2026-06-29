import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from './unifiedDiffParser'

describe('parseUnifiedDiff', () => {
  it('tracks old and new line numbers across a hunk', () => {
    const parsed = parseUnifiedDiff(
      [
        'diff --git a/example.ts b/example.ts',
        'index 1111111..2222222 100644',
        '--- a/example.ts',
        '+++ b/example.ts',
        '@@ -10,3 +10,4 @@',
        ' context',
        '-old line',
        '+new line',
        '+second new line',
        ' next context'
      ].join('\n')
    )

    expect(parsed.sections).toHaveLength(2)
    expect(parsed.sections[0].lines.map((line) => line.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'meta'
    ])
    expect(parsed.sections[1].header).toBe('@@ -10,3 +10,4 @@')
    expect(parsed.sections[1].lines).toEqual([
      { kind: 'context', oldLine: 10, newLine: 10, text: ' context' },
      { kind: 'del', oldLine: 11, newLine: null, text: '-old line' },
      { kind: 'add', oldLine: null, newLine: 11, text: '+new line' },
      { kind: 'add', oldLine: null, newLine: 12, text: '+second new line' },
      { kind: 'context', oldLine: 12, newLine: 13, text: ' next context' }
    ])
  })

  it('caps rendered diff lines without adding later empty hunks', () => {
    const parsed = parseUnifiedDiff(
      ['@@ -1,2 +1,2 @@', '-one', '+two', '@@ -20,2 +20,2 @@', '-twenty', '+twenty one'].join('\n'),
      { maxLines: 2 }
    )

    expect(parsed.truncated).toBe(true)
    expect(parsed.renderedLineCount).toBe(2)
    expect(parsed.omittedLineCount).toBe(2)
    expect(parsed.sections).toHaveLength(1)
    expect(parsed.sections[0].lines.map((line) => line.text)).toEqual(['-one', '+two'])
  })

  it('does not count hunk headers as omitted render lines', () => {
    const parsed = parseUnifiedDiff(['@@ -1,1 +1,1 @@', '-old', '+new'].join('\n'))

    expect(parsed.truncated).toBe(false)
    expect(parsed.totalLineCount).toBe(2)
    expect(parsed.renderedLineCount).toBe(2)
    expect(parsed.omittedLineCount).toBe(0)
  })

  it('returns no sections when a blank diff is capped to zero lines', () => {
    const parsed = parseUnifiedDiff('one\ntwo', { maxLines: 0 })

    expect(parsed.truncated).toBe(true)
    expect(parsed.renderedLineCount).toBe(0)
    expect(parsed.sections).toEqual([])
  })
})
