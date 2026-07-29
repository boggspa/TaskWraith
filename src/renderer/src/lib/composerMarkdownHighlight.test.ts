import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../../../main/store/types'
import {
  hasComposerMarkdown,
  segmentComposerRichText,
  type ComposerRichRun
} from './composerMarkdownHighlight'

function participant(overrides: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'ensemble-reviewer',
    provider: 'claude',
    enabled: true,
    role: 'Reviewer',
    instructions: '',
    order: 1,
    model: 'claude-opus-4-7',
    permissionPresetId: 'read_only',
    ...overrides
  }
}

const seg = (value: string, participants: EnsembleParticipant[] = []): ComposerRichRun[] =>
  segmentComposerRichText(value, participants)

const concat = (runs: ComposerRichRun[]): string => runs.map((run) => run.text).join('')

/** Flags of the first run whose text equals `text` (exact match). */
const flagsOf = (runs: ComposerRichRun[], text: string): string[] | undefined =>
  runs.find((run) => run.text === text)?.flags

const allFlags = (runs: ComposerRichRun[]): string[] => runs.flatMap((run) => run.flags)

describe('segmentComposerRichText — text fidelity', () => {
  it('returns a single plain run for markdown-free text', () => {
    expect(seg('just words, nothing else')).toEqual([
      { text: 'just words, nothing else', flags: [] }
    ])
  })

  it('never rewrites text: concatenated runs equal the input for gnarly drafts', () => {
    const inputs = [
      '**bold** *it* __u__ ~~s~~ `c`',
      '```js\nconst a = "**not bold**"\n```\ntail',
      '> quoted **deep**\n- item one\n1. numbered\ntrailing',
      'unclosed **bold and `code plus *stars',
      '*a`b*`c_d_e~~f~~g',
      '  \n\n``\n```\n> \n- \n* \n1. \n',
      'emoji 🙂 **bo🙂ld** done',
      'a\r\n- crlf line'
    ]
    for (const input of inputs) {
      expect(concat(seg(input))).toBe(input)
    }
  })

  it('returns [] for the empty draft', () => {
    expect(seg('')).toEqual([])
  })
})

describe('segmentComposerRichText — inline emphasis', () => {
  it('splits **bold** into dimmed markers and a bold content run', () => {
    const runs = seg('a **bold** b')
    expect(flagsOf(runs, '**')).toEqual(['md-marker'])
    expect(flagsOf(runs, 'bold')).toEqual(['md-bold'])
    expect(concat(runs)).toBe('a **bold** b')
  })

  it('handles *italic* and _italic_, but never snake_case', () => {
    expect(flagsOf(seg('x *it* y'), 'it')).toEqual(['md-italic'])
    expect(flagsOf(seg('x _it_ y'), 'it')).toEqual(['md-italic'])
    expect(allFlags(seg('snake_case_name'))).toEqual([])
  })

  it('allows intra-word * but not intra-word _ or __', () => {
    expect(flagsOf(seg('a*b*c'), 'b')).toEqual(['md-italic'])
    expect(allFlags(seg('a_b_c'))).toEqual([])
    expect(allFlags(seg('x__init__'))).toEqual([])
  })

  it('underlines __text__ and strikes ~~text~~', () => {
    expect(flagsOf(seg('__init__'), 'init')).toEqual(['md-underline'])
    expect(flagsOf(seg('do ~~not~~ this'), 'not')).toEqual(['md-strike'])
  })

  it('leaves unclosed, empty, and wrong-run-length delimiters plain', () => {
    expect(allFlags(seg('**unclosed'))).toEqual([])
    expect(allFlags(seg('****'))).toEqual([])
    expect(allFlags(seg('***both***'))).toEqual([])
    expect(allFlags(seg('~~~x~~~'))).toEqual([])
    expect(allFlags(seg('say * not emphasis * ok'))).toEqual([])
  })

  it('rejects space-adjacent content edges (glob-style stars stay plain)', () => {
    expect(allFlags(seg('rm *.ts or *.md now'))).toEqual([])
    expect(allFlags(seg('func(*args, **kwargs)'))).toEqual([])
  })
})

describe('segmentComposerRichText — code', () => {
  it('tints inline code including its backticks', () => {
    const runs = seg('see `getFoo()` here')
    expect(flagsOf(runs, '`')).toEqual(['md-code', 'md-marker'])
    expect(flagsOf(runs, 'getFoo()')).toEqual(['md-code'])
  })

  it('gives code precedence over emphasis delimiters inside it', () => {
    const runs = seg('*a `b*` c')
    expect(allFlags(runs)).not.toContain('md-italic')
    expect(flagsOf(runs, 'b*')).toEqual(['md-code'])
  })

  it('lets emphasis span across a code span', () => {
    const runs = seg('*a `code` b*')
    expect(flagsOf(runs, 'code')).toEqual(['md-code', 'md-italic'])
    expect(flagsOf(runs, 'a ')).toEqual(['md-italic'])
  })

  it('ignores empty and double-backtick spans', () => {
    expect(allFlags(seg('a `` b'))).toEqual([])
  })

  it('marks fence lines and interior lines as code-block, with no inline parsing inside', () => {
    const runs = seg('```js\n**not bold** `x`\n```')
    expect(flagsOf(runs, '```js')).toEqual(['md-code-block', 'md-marker'])
    expect(flagsOf(runs, '**not bold** `x`')).toEqual(['md-code-block'])
    expect(allFlags(runs)).not.toContain('md-bold')
    expect(allFlags(runs)).not.toContain('md-code')
  })

  it('treats an unclosed fence as open to the end (live typing)', () => {
    const runs = seg('```\nstill code')
    expect(flagsOf(runs, 'still code')).toEqual(['md-code-block'])
  })
})

describe('segmentComposerRichText — block prefixes', () => {
  it('marks quote markers and tints quoted content', () => {
    const runs = seg('> hello there')
    expect(flagsOf(runs, '>')).toEqual(['md-quote-marker'])
    expect(flagsOf(runs, 'hello there')).toEqual(['md-quote'])
  })

  it('supports >>> and no-space quotes', () => {
    expect(flagsOf(seg('>>> big quote'), '>>>')).toEqual(['md-quote-marker'])
    expect(flagsOf(seg('>tight'), 'tight')).toEqual(['md-quote'])
  })

  it('parses inline markdown inside quotes', () => {
    const runs = seg('> **bold** quote')
    expect(flagsOf(runs, 'bold')).toEqual(['md-quote', 'md-bold'])
  })

  it('tints bullet markers for -, *, +, and ordered lists', () => {
    expect(flagsOf(seg('- item'), '-')).toEqual(['md-bullet-marker'])
    expect(flagsOf(seg('* item'), '*')).toEqual(['md-bullet-marker'])
    expect(flagsOf(seg('+ item'), '+')).toEqual(['md-bullet-marker'])
    expect(flagsOf(seg('1. first'), '1.')).toEqual(['md-bullet-marker'])
    expect(flagsOf(seg('12) twelfth'), '12)')).toEqual(['md-bullet-marker'])
    expect(flagsOf(seg('  - indented'), '-')).toEqual(['md-bullet-marker'])
  })

  it('does not misread prose dashes, decimals, or hrules as bullets', () => {
    expect(allFlags(seg('well- anyway'))).toEqual([])
    expect(allFlags(seg('1.5 kg'))).toEqual([])
    expect(allFlags(seg('---'))).toEqual([])
  })

  it('combines quote + bullet on one line', () => {
    const runs = seg('> - item')
    expect(flagsOf(runs, '>')).toEqual(['md-quote-marker'])
    expect(flagsOf(runs, '-')).toEqual(['md-quote', 'md-bullet-marker'])
    expect(flagsOf(runs, ' item')).toEqual(['md-quote'])
  })

  it('a * bullet is a bullet, not an italic opener', () => {
    const runs = seg('* item with *it* inside')
    expect(flagsOf(runs, '*')).toEqual(['md-bullet-marker'])
    expect(flagsOf(runs, 'it')).toEqual(['md-italic'])
  })
})

describe('segmentComposerRichText — mention interplay', () => {
  it('bolds across a mention while keeping the mention token intact', () => {
    const runs = seg('**hi @Reviewer yo**', [participant()])
    const mentionRun = runs.find((run) => run.mention)
    expect(mentionRun?.text).toBe('@Reviewer')
    expect(mentionRun?.flags).toEqual(['md-bold'])
    expect(flagsOf(runs, 'hi ')).toEqual(['md-bold'])
    expect(concat(runs)).toBe('**hi @Reviewer yo**')
  })

  it('never pairs a delimiter outside a mention with one inside its label', () => {
    const runs = seg('a *x [@R*le](ensemble-dm://ensemble-reviewer) y', [participant()])
    expect(allFlags(runs)).not.toContain('md-italic')
    const mentionRun = runs.find((run) => run.mention)
    expect(mentionRun?.text).toBe('@R*le')
  })

  it('keeps structured-mention shortening while highlighting around it', () => {
    const runs = seg('Ask [@Reviewer](ensemble-dm://ensemble-reviewer) for **more**', [
      participant()
    ])
    expect(concat(runs)).toBe('Ask @Reviewer for **more**')
    expect(concat(runs)).not.toContain('ensemble-dm://')
    expect(flagsOf(runs, 'more')).toEqual(['md-bold'])
  })

  it('gives a mention inside a fence the code-block tint but never marker dimming', () => {
    const runs = seg('```\n@Reviewer\n```', [participant()])
    const mentionRun = runs.find((run) => run.mention)
    expect(mentionRun?.flags).toEqual(['md-code-block'])
  })

  it('quotes containing mentions tint both correctly', () => {
    const runs = seg('> ping @Reviewer now', [participant()])
    const mentionRun = runs.find((run) => run.mention)
    expect(mentionRun?.flags).toEqual(['md-quote'])
    expect(flagsOf(runs, ' now')).toEqual(['md-quote'])
  })
})

describe('segmentComposerRichText — robustness', () => {
  it('handles astral characters without corrupting offsets', () => {
    const runs = seg('🙂 **bo🙂ld** 🙂')
    expect(flagsOf(runs, 'bo🙂ld')).toEqual(['md-bold'])
    expect(concat(runs)).toBe('🙂 **bo🙂ld** 🙂')
  })

  it('stays fast on pathological delimiter storms', () => {
    const storm = `${'*'.repeat(2000)}\n${'`a'.repeat(1000)}\n${' *a'.repeat(500)}`
    const started = performance.now()
    const runs = seg(storm)
    expect(concat(runs)).toBe(storm)
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('handles a 20k-character single line without blowing up', () => {
    const long = `${'a'.repeat(9999)} **mid** ${'b'.repeat(9999)}`
    const runs = seg(long)
    expect(flagsOf(runs, 'mid')).toEqual(['md-bold'])
    expect(concat(runs)).toBe(long)
  })
})

describe('hasComposerMarkdown', () => {
  it('is false for empty, plain, and trigger-less drafts', () => {
    expect(hasComposerMarkdown('', [])).toBe(false)
    expect(hasComposerMarkdown('plain words only', [])).toBe(false)
    expect(hasComposerMarkdown('a * b', [])).toBe(false)
    expect(hasComposerMarkdown('snake_case_name', [])).toBe(false)
  })

  it('is true for each supported construct', () => {
    expect(hasComposerMarkdown('**b**', [])).toBe(true)
    expect(hasComposerMarkdown('`c`', [])).toBe(true)
    expect(hasComposerMarkdown('```\nx', [])).toBe(true)
    expect(hasComposerMarkdown('> q', [])).toBe(true)
    expect(hasComposerMarkdown('- item', [])).toBe(true)
    expect(hasComposerMarkdown('~~s~~', [])).toBe(true)
  })

  it('ignores markdown-ish characters inside mention labels', () => {
    expect(
      hasComposerMarkdown('hi [@R*le](ensemble-dm://ensemble-reviewer) there', [participant()])
    ).toBe(false)
  })
})
