import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  MAX_ACCENTED_DIFF_LINES,
  diffToneLineClass,
  isAccentedDiffTone,
  looksLikeUnifiedDiff
} from './diffToneClass'

describe('diffToneLineClass', () => {
  it('accents +/- content lines under the diff tone and leaves context alone', () => {
    expect(diffToneLineClass('+const a = 1', 'diff')).toBe('activity-diff-line-add')
    expect(diffToneLineClass('-const a = 0', 'diff')).toBe('activity-diff-line-delete')
    expect(diffToneLineClass(' const a = 1', 'diff')).toBe('activity-diff-line-context')
    expect(diffToneLineClass('@@ -1,2 +1,2 @@', 'diff')).toBe('activity-diff-line-context')
  })

  it('treats +++/--- file headers as context, not as content changes', () => {
    expect(diffToneLineClass('+++ b/src/foo.ts', 'diff')).toBe('activity-diff-line-context')
    expect(diffToneLineClass('--- a/src/foo.ts', 'diff')).toBe('activity-diff-line-context')
  })

  it('paints a wholly-added block green and a wholly-removed block red', () => {
    expect(diffToneLineClass('const a = 1', 'addition')).toBe('activity-diff-line-add')
    expect(diffToneLineClass('+const a = 1', 'addition')).toBe('activity-diff-line-add')
    expect(diffToneLineClass('const a = 0', 'deletion')).toBe('activity-diff-line-delete')
    expect(diffToneLineClass('-const a = 0', 'deletion')).toBe('activity-diff-line-delete')
  })

  it('falls back to context for blank lines and opposite-direction markers', () => {
    // An addition block is not the place to assert a deletion, and vice versa.
    expect(diffToneLineClass('-stray', 'addition')).toBe('activity-diff-line-context')
    expect(diffToneLineClass('+stray', 'deletion')).toBe('activity-diff-line-context')
    expect(diffToneLineClass('', 'addition')).toBe('activity-diff-line-context')
    expect(diffToneLineClass('', 'deletion')).toBe('activity-diff-line-context')
  })

  it('leaves neutral output entirely unaccented', () => {
    expect(diffToneLineClass('+not a diff', 'neutral')).toBe('activity-diff-line-context')
    expect(diffToneLineClass('anything')).toBe('activity-diff-line-context')
  })

  it('reports which tones are worth splitting per line', () => {
    expect(isAccentedDiffTone('diff')).toBe(true)
    expect(isAccentedDiffTone('addition')).toBe(true)
    expect(isAccentedDiffTone('deletion')).toBe(true)
    expect(isAccentedDiffTone('neutral')).toBe(false)
    expect(isAccentedDiffTone(undefined)).toBe(false)
  })
})

describe('looksLikeUnifiedDiff', () => {
  it('detects the three real diff markers', () => {
    expect(looksLikeUnifiedDiff('diff --git a/foo.ts b/foo.ts\nindex 1..2')).toBe(true)
    expect(looksLikeUnifiedDiff('@@ -1,4 +1,6 @@\n context\n+added')).toBe(true)
    expect(looksLikeUnifiedDiff('--- a/foo.ts\n+++ b/foo.ts\n+added')).toBe(true)
  })

  it('does NOT paint ordinary prose or shell output as a diff', () => {
    // The whole point of the strict test: a bullet list starts with '-' and a
    // build log is full of '+' — accenting those is worse than leaving a diff flat.
    expect(looksLikeUnifiedDiff('- first bullet\n- second bullet')).toBe(false)
    expect(looksLikeUnifiedDiff('+ compiling foo.ts\n+ done')).toBe(false)
    expect(looksLikeUnifiedDiff('wrote 1 line')).toBe(false)
    expect(looksLikeUnifiedDiff('')).toBe(false)
    // A lone file header without its pair is not enough.
    expect(looksLikeUnifiedDiff('--- a/foo.ts\nsome text')).toBe(false)
  })
})

/*
 * Drift guard. The whole reason this module exists is that two transcript
 * surfaces rendered the same patch differently — the full-density
 * ActivityPreview accented +/- while the compact-density CompactToolTrace
 * foldout flattened it. Pin that BOTH still route through this one helper, so
 * a future edit can't quietly reintroduce a private copy in either file.
 */
describe('single tone authority', () => {
  const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('is the only tone→class mapping either transcript surface uses', () => {
    for (const path of [
      '../components/ActivityStack.tsx',
      '../components/CompactToolTrace.tsx'
    ]) {
      const source = read(path)
      expect(source).toContain("from '../lib/diffToneClass'")
      expect(source).toContain('diffToneLineClass(')
      // No local re-derivation of the class names.
      expect(source).not.toMatch(/function\s+getDiffToneClass/)
      expect(source).not.toMatch(/return\s+'activity-diff-line-(add|delete)'/)
    }
  })

  it('bounds per-line accenting so a huge patch cannot stall the transcript', () => {
    expect(MAX_ACCENTED_DIFF_LINES).toBeGreaterThan(100)
    expect(MAX_ACCENTED_DIFF_LINES).toBeLessThanOrEqual(2000)
    expect(read('../components/CompactToolTrace.tsx')).toContain('MAX_ACCENTED_DIFF_LINES')
  })
})
