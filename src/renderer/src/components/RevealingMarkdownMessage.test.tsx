import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { graphemeCount } from '../lib/advanceReveal'
import {
  RevealingMarkdownMessage,
  activeCodeTailStart,
  fencedCodeRanges,
  safeMessageSlice,
  safeTailSlice
} from './RevealingMarkdownMessage'
import { StableMarkdownBlock } from './StableMarkdownBlock'

describe('safeTailSlice', () => {
  it('reveals code blocks instantly (never a partial fence)', () => {
    const code = '```ts\nconst x = 1'
    expect(safeTailSlice(code, 'code', 2)).toBe(code)
  })

  it('reveals paragraphs / headings at the grapheme cursor', () => {
    expect(safeTailSlice('hello world', 'paragraph', 5)).toBe('hello')
    expect(safeTailSlice('# Title here', 'heading', 7)).toBe('# Title')
  })

  it('keeps multi-byte graphemes whole in a paragraph slice', () => {
    const p = 'hi 👨‍👩‍👧‍👦 there'
    // 4 graphemes = "hi " + the family emoji, never a split surrogate.
    expect(safeTailSlice(p, 'paragraph', 4)).toBe('hi 👨‍👩‍👧‍👦')
  })

  it('reveals lists/tables at completed-line granularity (no half-row flip)', () => {
    const list = '- one\n- two\n- thr'
    // Cursor mid-third-item → cut to the last newline (two completed items).
    expect(safeTailSlice(list, 'list', 14)).toBe('- one\n- two\n')
    // No completed line yet → show nothing rather than a half-item.
    expect(safeTailSlice('- on', 'list', 3)).toBe('')

    const table = '| a | b |\n| - | - |\n| 1 |'
    expect(safeTailSlice(table, 'table', 24)).toBe('| a | b |\n| - | - |\n')
  })
})

describe('safeMessageSlice', () => {
  it('does not expose a newly stable block before the message-global cursor reaches it', () => {
    const content = 'First paragraph is visible.\n\nSecond paragraph is still buffered.'
    const cursor = graphemeCount('First paragraph')
    const visible = safeMessageSlice(content, cursor)

    expect(visible).toBe('First paragraph')
    expect(visible).not.toContain('Second paragraph')
  })

  it('keeps the active list on a completed-line boundary', () => {
    const content = '- one\n- two\n- partial item'
    const cursor = graphemeCount('- one\n- two\n- part')
    expect(safeMessageSlice(content, cursor)).toBe('- one\n- two\n')
  })

  it('keeps a caught-up live list row hidden until its newline arrives', () => {
    const partial = '- one\n- two'
    expect(safeMessageSlice(partial, graphemeCount(partial))).toBe('- one\n')

    const completed = `${partial}\n`
    expect(safeMessageSlice(completed, graphemeCount(completed))).toBe(completed)
  })

  it('holds a partial prose word and reveals the terminal word whole', () => {
    const content = 'Smooth leg'
    expect(safeMessageSlice(content, graphemeCount(content))).toBe('Smooth ')
    expect(safeMessageSlice(content, graphemeCount(content), true)).toBe(content)
  })

  it('keeps mid-word English advances on a stable projection (paint-gate invariant)', () => {
    // Phase B paint gate commits React state only when this string changes.
    // Mid-word grapheme cursor advances must not thrash remardown.
    const prefix = 'Smooth streaming '
    const word = 'words'
    const held = safeMessageSlice(prefix + 'w', graphemeCount(prefix + 'w'))
    expect(held).toBe(prefix)

    for (let index = 1; index < word.length; index += 1) {
      const partial = prefix + word.slice(0, index + 1)
      expect(safeMessageSlice(partial, graphemeCount(partial))).toBe(held)
    }

    const completed = `${prefix}${word} `
    expect(safeMessageSlice(completed, graphemeCount(completed))).toBe(completed)
  })

  it('preserves the literal trailing newline discarded by the block splitter', () => {
    const content = '- one\n- two\nX'
    const cursor = graphemeCount('- one\n- two\n')
    expect(safeMessageSlice(content, cursor)).toBe('- one\n- two\n')
  })

  it('never retracts an ambiguous list marker when the item begins', () => {
    for (const content of ['- ', '- o', '1. ', '1. o']) {
      expect(safeMessageSlice(content, graphemeCount(content))).toBe('')
    }
    expect(safeMessageSlice('- one\n', graphemeCount('- one\n'))).toBe('- one\n')
  })

  it('holds a table until its header and separator rows are complete', () => {
    const header = '| a | b |\n'
    const partial = `${header}| --- | `
    const complete = `${header}| --- | --- |\n`

    expect(safeMessageSlice(header, graphemeCount(header))).toBe('')
    expect(safeMessageSlice(partial, graphemeCount(partial))).toBe('')
    expect(safeMessageSlice(complete, graphemeCount(complete))).toBe(complete)
  })

  it('holds unfinished inline markdown until it can mount in its final structure', () => {
    expect(safeMessageSlice('This is **bold ', graphemeCount('This is **bold '))).toBe(
      'This is '
    )
    const bold = 'This is **bold text** '
    expect(safeMessageSlice(bold, graphemeCount(bold))).toBe(bold)
    const italic = 'This is *italic text* '
    expect(safeMessageSlice(italic, graphemeCount(italic))).toBe(italic)
    const identifier = 'Use _private variable and *args safely '
    expect(safeMessageSlice(identifier, graphemeCount(identifier))).toBe(identifier)

    expect(safeMessageSlice('[Open AI', graphemeCount('[Open AI'))).toBe('')
    const link = '[Open AI](https://example.com) '
    expect(safeMessageSlice(link, graphemeCount(link))).toBe(link)
    expect(safeMessageSlice('![Alt text', graphemeCount('![Alt text'))).toBe('')
  })

  it('uses grapheme progression for scripts that do not separate words with spaces', () => {
    const content = 'こんにちは世界'
    expect(safeMessageSlice(content, graphemeCount(content))).toBe(content)
  })

  it('does not let the quiet-fragment release expose ambiguous markdown prefixes', () => {
    const projectQuiet = (content: string) =>
      safeMessageSlice(content, graphemeCount(content), false, undefined, true)

    expect(projectQuiet('This is **')).toBe('This is ')
    expect(projectQuiet('This is **b')).toBe('This is ')
    expect(projectQuiet('1')).toBe('')
    expect(projectQuiet('1. ')).toBe('')
    expect(projectQuiet('Use `')).toBe('Use ')
    expect(projectQuiet('Use `i')).toBe('Use ')
    expect(projectQuiet('[label]')).toBe('')
    expect(projectQuiet('[label](')).toBe('')
    expect(projectQuiet('!')).toBe('')
    expect(projectQuiet('![')).toBe('')
  })

  it('holds pipe-table and CJK-link frontiers until their final structure is known', () => {
    for (const content of ['| a ', '| a |', 'a | b\n--- | ']) {
      expect(safeMessageSlice(content, graphemeCount(content))).toBe('')
    }
    expect(safeMessageSlice('a | b', graphemeCount('a | b'))).toBe('a | ')
    expect(safeMessageSlice('[リンク]', graphemeCount('[リンク]'))).toBe('')
    expect(safeMessageSlice('[リンク](', graphemeCount('[リンク]('))).toBe('')
    const completeLink = '[リンク](https://example.com)'
    expect(safeMessageSlice(completeLink, graphemeCount(completeLink))).toBe(completeLink)

    const pipeProse = 'Use foo | bar and `git log | head` safely '
    expect(safeMessageSlice(pipeProse, graphemeCount(pipeProse))).toBe(pipeProse)
  })

  it('reports the active fenced-code start so code can stay atomic', () => {
    const content = 'Intro paragraph.\n\n```ts\nconst value = 1'
    expect(activeCodeTailStart(content)).toBe(graphemeCount('Intro paragraph.\n\n'))
    expect(activeCodeTailStart('```ts\nconst value = 1\n```')).toBeNull()
    expect(activeCodeTailStart('Plain text only')).toBeNull()
  })

  it('maps both closed and active fences to atomic grapheme ranges', () => {
    const content = 'Before 👋\n\n```ts\nconst x = 1\n```\n\nAfter\n\n~~~\nopen'
    const ranges = fencedCodeRanges(content)

    expect(ranges).toHaveLength(2)
    expect(ranges[0]).toEqual({
      start: graphemeCount('Before 👋\n\n'),
      end: graphemeCount('Before 👋\n\n```ts\nconst x = 1\n```\n')
    })
    expect(ranges[1]).toEqual({
      start: graphemeCount('Before 👋\n\n```ts\nconst x = 1\n```\n\nAfter\n\n'),
      end: graphemeCount(content)
    })
  })
})

describe('RevealingMarkdownMessage (smoke)', () => {
  it('renders the full content when not live (non-animated path)', () => {
    const html = renderToStaticMarkup(
      <RevealingMarkdownMessage content={'A paragraph.\n\nSecond para.'} isLive={false} />
    )
    expect(html).toContain('A paragraph.')
    expect(html).toContain('Second para.')
  })

  it('shares semantic inline diff rendering with settled Markdown', () => {
    const html = renderToStaticMarkup(
      <RevealingMarkdownMessage content={'Committed **+14 / -5**.'} isLive={false} />
    )
    expect(html).toContain('markdown-inline-diff-stat is-addition')
    expect(html).toContain('markdown-inline-diff-stat is-deletion')
    expect(html).toContain('+14')
    expect(html).toContain('-5')
  })

  it('shares inline color-token rendering with settled Markdown', () => {
    const html = renderToStaticMarkup(
      <RevealingMarkdownMessage content={'Violet #B73BD5 is ready.'} isLive={false} />
    )
    expect(html).toContain('class="markdown-color-token"')
    expect(html).toContain('data-color-token="#B73BD5"')
    expect(html).toContain('markdown-color-token-swatch')
  })

  it('renders the stable prefix immediately even while live', () => {
    // The settled first block is solid regardless of the tail reveal cursor.
    const html = renderToStaticMarkup(
      <RevealingMarkdownMessage content={'Settled block.\n\ntail growing'} isLive reduceMotion />
    )
    expect(html).toContain('Settled block.')
  })

  it('does not replay temporal fades over an already-painted reattached tail', () => {
    const html = renderToStaticMarkup(
      <RevealingMarkdownMessage
        content={'A smoothly revealed assistant message.'}
        isLive
        messageTimestamp="2020-01-01T00:00:00.000Z"
        provider="codex"
        model="gpt-5.5"
      />
    )
    expect(html).not.toContain('stream-reveal-token')
    expect(html).toContain('data-reveal-speed=')
    expect(html).toContain('A')
  })

  it('bounds fade spans to one frontier container even in a mixed list block', () => {
    const mixed = `intro\n${Array.from({ length: 240 }, (_, index) => `- item${index}`).join('\n')}`
    const html = renderToStaticMarkup(
      <StableMarkdownBlock raw={mixed} revealTokens animatedWordWindow={48} />
    )
    expect((html.match(/stream-reveal-token/g) || []).length).toBeLessThanOrEqual(48)

    const prose = Array.from({ length: 80 }, (_, index) => `word${index}`).join(' ')
    const proseHtml = renderToStaticMarkup(
      <StableMarkdownBlock raw={prose} revealTokens animatedWordWindow={48} />
    )
    expect((proseHtml.match(/stream-reveal-token/g) || []).length).toBe(48)
  })
})
