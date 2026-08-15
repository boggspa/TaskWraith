import { describe, expect, it } from 'vitest'
import { tokeniseInlineMarkdownDiffStats } from './inlineMarkdownDiffStats'

function compact(value: string): Array<[string, string]> {
  return tokeniseInlineMarkdownDiffStats(value).map((segment) => [segment.kind, segment.value])
}

describe('tokeniseInlineMarkdownDiffStats', () => {
  it('recognises signed addition/deletion pairs without changing their glyphs', () => {
    expect(compact('Clean audit: +32 / −0, then +1,305 -244.')).toEqual([
      ['text', 'Clean audit: '],
      ['addition', '+32'],
      ['text', ' / '],
      ['deletion', '−0'],
      ['text', ', then '],
      ['addition', '+1,305'],
      ['text', ' '],
      ['deletion', '-244'],
      ['text', '.']
    ])
  })

  it('recognises explicit insertion/deletion labels in either order', () => {
    expect(compact('32 insertions, 0 deletions; 1 removal and 2 additions.')).toEqual([
      ['addition', '32'],
      ['text', ' insertions, '],
      ['deletion', '0'],
      ['text', ' deletions; '],
      ['deletion', '1'],
      ['text', ' removal and '],
      ['addition', '2'],
      ['text', ' additions.']
    ])
  })

  it('rejects ambiguous or non-integer signed values', () => {
    const values = [
      'lone +32 and lone -4',
      'math: 2 + 3 - 1',
      'spaced math: +2 - 1',
      'bitwise: +3 | -2',
      'currency: $+32 / -0 and $32 additions',
      'trailing currency: +32 / -0$ and +32 / -0 USD',
      'temperature: +32 / -5°C',
      'spaced temperature: +32 / -5 °C',
      'percent: +32% / -5%',
      'spaced percent: +32 / -5 %',
      'version: v1.2+3 -4',
      'date: 2026-08-15',
      'phone: +44 20 7946 0958',
      'compact arithmetic: +1305-244',
      'decimal: +1.5 / -0.5',
      'bad grouping: +1,30 / -2 and 1,30 insertions'
    ]

    for (const value of values) {
      expect(compact(value), value).toEqual([['text', value]])
    }
  })
})
