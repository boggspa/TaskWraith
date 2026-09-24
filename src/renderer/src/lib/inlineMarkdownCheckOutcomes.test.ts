import { describe, expect, it } from 'vitest'
import { tokeniseInlineMarkdownCheckOutcomes } from './inlineMarkdownCheckOutcomes'

function compact(value: string): Array<[string, string]> {
  return tokeniseInlineMarkdownCheckOutcomes(value).map((segment) => [segment.kind, segment.value])
}

describe('tokeniseInlineMarkdownCheckOutcomes', () => {
  it('accents counted outcomes and leaves their label glyphs in the text', () => {
    expect(compact('2,127 passed, 5 failed, 3 skipped.')).toEqual([
      ['pass', '2,127'],
      ['text', ' passed, '],
      ['fail', '5'],
      ['text', ' failed, '],
      ['skip', '3'],
      ['text', ' skipped.']
    ])
  })

  it('reads the unit between a count and its label, including stacked nouns', () => {
    expect(compact('2 test files failed while 96 test files passed')).toEqual([
      ['fail', '2'],
      ['text', ' test files failed while '],
      ['pass', '96'],
      ['text', ' test files passed']
    ])
  })

  it('shares one trailing label across a slash-joined pair of counts', () => {
    expect(compact('98 files / 2127 tests green')).toEqual([
      ['pass', '98'],
      ['text', ' files / '],
      ['pass', '2127'],
      ['text', ' tests green']
    ])
  })

  it('accents a ratio as a single unit', () => {
    expect(compact('68/68 passing and 2122/2127 tests green')).toEqual([
      ['pass', '68/68'],
      ['text', ' passing and '],
      ['pass', '2122/2127'],
      ['text', ' tests green']
    ])
  })

  it('reads zero failures as the good news it is, and zero passes as nothing', () => {
    expect(compact('0 failures')).toEqual([
      ['pass', '0'],
      ['text', ' failures']
    ])
    expect(compact('0 errors, 0 warnings')).toEqual([
      ['pass', '0'],
      ['text', ' errors, '],
      ['pass', '0'],
      ['text', ' warnings']
    ])
    expect(compact('3 warnings')).toEqual([
      ['skip', '3'],
      ['text', ' warnings']
    ])
    expect(compact('0 passed')).toEqual([['text', '0 passed']])
    expect(compact('0 skipped')).toEqual([['text', '0 skipped']])
  })

  it('accents uncounted verdicts as whole phrases', () => {
    expect(compact('Typecheck passes.')).toEqual([
      ['pass', 'Typecheck passes'],
      ['text', '.']
    ])
    expect(compact('The build succeeded but tests failed')).toEqual([
      ['text', 'The '],
      ['pass', 'build succeeded'],
      ['text', ' but '],
      ['fail', 'tests failed']
    ])
    expect(compact('lint clean')).toEqual([['pass', 'lint clean']])
  })

  it('keeps a negated problem whole so its polarity cannot invert', () => {
    expect(compact('no lint errors')).toEqual([['pass', 'no lint errors']])
    expect(compact('no failing tests and zero regressions')).toEqual([
      ['pass', 'no failing tests'],
      ['text', ' and '],
      ['pass', 'zero regressions']
    ])
  })

  it('accents each side of a verdict transition and the "all" verdict idiom', () => {
    expect(compact('All green — 68/68, red→green')).toEqual([
      ['pass', 'All green'],
      ['text', ' — 68/68, '],
      ['fail', 'red'],
      ['text', '→'],
      ['pass', 'green']
    ])
    expect(compact('went green -> red')).toEqual([
      ['text', 'went '],
      ['pass', 'green'],
      ['text', ' -> '],
      ['fail', 'red']
    ])
  })

  it('leaves counts and words that are not check results alone', () => {
    const values = [
      '95% passing',
      'v1.2 fails',
      'the deadline passed',
      '3 files changed',
      'Chapter 3 of 9',
      'released 2026-08-15',
      'refund of $5 failed',
      'ran 12 tests',
      'a green button and a red border',
      '2 tests passable',
      'lint passages',
      'small green tiles'
    ]

    for (const value of values) {
      expect(compact(value), value).toEqual([['text', value]])
    }
  })
})
