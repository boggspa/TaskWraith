import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyTranscriptSearchHighlights,
  clearTranscriptSearchHighlights,
  findQueryOccurrences,
  normalizeTranscriptHighlightQuery,
  TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT_NAME,
  TRANSCRIPT_SEARCH_HIGHLIGHT_NAME
} from './transcriptSearchHighlight'

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

describe('findQueryOccurrences', () => {
  it('finds every occurrence, case-insensitively', () => {
    expect(findQueryOccurrences('Alpha alpha ALPHA', 'alpha')).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 }
    ])
  })

  it('does not return overlapping ranges', () => {
    // "aaa" contains "aa" twice by overlap; a Range set must not double-paint.
    expect(findQueryOccurrences('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 }
    ])
  })

  it('returns nothing for an empty haystack or needle', () => {
    expect(findQueryOccurrences('', 'a')).toEqual([])
    expect(findQueryOccurrences('a', '')).toEqual([])
  })
})

describe('normalizeTranscriptHighlightQuery', () => {
  it('trims but never collapses internal whitespace', () => {
    // Collapsing would desynchronise offsets from the text node being walked.
    expect(normalizeTranscriptHighlightQuery('  two  words  ')).toBe('two  words')
  })
})

describe('highlight registry access', () => {
  it('is inert when the CSS Custom Highlight API is unavailable', () => {
    expect(() => clearTranscriptSearchHighlights()).not.toThrow()
    expect(
      applyTranscriptSearchHighlights({
        scroller: null,
        query: 'alpha',
        rowKeys: ['m-1#0'],
        activeRowKey: 'm-1#0'
      })
    ).toBe(0)
  })
})

describe('thread-search highlight wiring', () => {
  it('TranscriptPanel paints the mounted matched rows', () => {
    const source = read('../components/TranscriptPanel.tsx')
    expect(source).toContain('applyTranscriptSearchHighlights')
    expect(source).toContain('clearTranscriptSearchHighlights')
    expect(source).toContain('threadSearchMatchRowKeys')
    expect(source).toContain('threadSearchActiveRowKey')
  })

  it('MainAppLayout hands the main transcript the match list and the active row', () => {
    const source = read('../app/views/MainAppLayout.tsx')
    expect(source).toContain('threadSearchMatchRowKeys={threadSearchMatchRowKeys}')
    expect(source).toContain('threadSearchActiveRowKey={threadSearchActiveRowKey}')
  })

  it('styles both registered highlight names', () => {
    const css = read('../assets/css/19-thread-search.css')
    expect(css).toContain(`::highlight(${TRANSCRIPT_SEARCH_HIGHLIGHT_NAME})`)
    expect(css).toContain(`::highlight(${TRANSCRIPT_SEARCH_ACTIVE_HIGHLIGHT_NAME})`)
  })
})
