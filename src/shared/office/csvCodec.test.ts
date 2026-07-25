import { describe, expect, it } from 'vitest'
import { buildDelimitedText, parseDelimitedText } from './csvCodec'

describe('parseDelimitedText', () => {
  it('parses simple rows with CRLF and LF endings', () => {
    expect(parseDelimitedText('a,b,c\r\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3']
    ])
  })

  it('handles quoted fields with embedded delimiters, quotes and newlines', () => {
    const text = '"a,1","say ""hi""","line1\nline2"\r\nplain,,end\r\n'
    expect(parseDelimitedText(text)).toEqual([
      ['a,1', 'say "hi"', 'line1\nline2'],
      ['plain', '', 'end']
    ])
  })

  it('strips a UTF-8 BOM and tolerates missing trailing newline', () => {
    expect(parseDelimitedText('\uFEFFx,y')).toEqual([['x', 'y']])
  })

  it('parses TSV with the tab delimiter', () => {
    expect(parseDelimitedText('a\tb\n1\t2\n', '\t')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })

  it('returns an empty grid for empty input', () => {
    expect(parseDelimitedText('')).toEqual([])
  })
})

describe('buildDelimitedText', () => {
  it('quotes only fields that need it and ends rows with CRLF', () => {
    const text = buildDelimitedText([
      ['plain', 'with,comma', 'with"quote', 'multi\nline'],
      ['', 'x', '', '']
    ])
    expect(text).toBe('plain,"with,comma","with""quote","multi\nline"\r\n,x,,\r\n')
  })

  it('round-trips through parse', () => {
    const rows = [
      ['name', 'note'],
      ['a,b', 'say "hi"\nsecond line'],
      ['', 'trailing']
    ]
    expect(parseDelimitedText(buildDelimitedText(rows))).toEqual(rows)
  })
})
