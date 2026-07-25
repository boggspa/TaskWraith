import { describe, expect, it } from 'vitest'
import { markdownToWordModel, parseInlineMarkdown, wordModelToMarkdown } from './wordMarkdown'
import type { WordDocumentModel } from './officeModels'

describe('markdownToWordModel', () => {
  it('parses headings, paragraphs, lists and tables', () => {
    const model = markdownToWordModel(
      [
        '# Title',
        '',
        'Intro paragraph with **bold** and _italic_ and `code`.',
        '',
        '- first',
        '- second',
        '  - nested',
        '1. one',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |'
      ].join('\n')
    )
    expect(model.blocks[0]).toEqual({
      type: 'heading',
      level: 1,
      runs: [{ text: 'Title' }]
    })
    expect(model.blocks[1].type).toBe('paragraph')
    const paragraphRuns = model.blocks[1].type === 'paragraph' ? model.blocks[1].runs : []
    expect(paragraphRuns).toEqual([
      { text: 'Intro paragraph with ' },
      { text: 'bold', bold: true },
      { text: ' and ' },
      { text: 'italic', italic: true },
      { text: ' and ' },
      { text: 'code', code: true },
      { text: '.' }
    ])
    expect(model.blocks.slice(2, 6)).toEqual([
      { type: 'list-item', ordered: false, level: 0, runs: [{ text: 'first' }] },
      { type: 'list-item', ordered: false, level: 0, runs: [{ text: 'second' }] },
      { type: 'list-item', ordered: false, level: 1, runs: [{ text: 'nested' }] },
      { type: 'list-item', ordered: true, level: 0, runs: [{ text: 'one' }] }
    ])
    expect(model.blocks[6]).toEqual({
      type: 'table',
      rows: [
        [[{ text: 'A' }], [{ text: 'B' }]],
        [[{ text: '1' }], [{ text: '2' }]]
      ]
    })
  })

  it('parses links, strikethrough and underline spans', () => {
    const runs = parseInlineMarkdown('see [docs](https://example.com) ~~old~~ <u>under</u>')
    expect(runs).toEqual([
      { text: 'see ' },
      { text: 'docs', link: 'https://example.com' },
      { text: ' ' },
      { text: 'old', strike: true },
      { text: ' ' },
      { text: 'under', underline: true }
    ])
  })

  it('joins consecutive plain lines into one paragraph', () => {
    const model = markdownToWordModel('line one\nline two\n\nnext para\n')
    expect(model.blocks).toHaveLength(2)
  })
})

describe('wordModelToMarkdown', () => {
  it('round-trips a representative document', () => {
    const source = [
      '## Section',
      '',
      'Plain with **bold** and _em_ and [link](https://x.y).',
      '',
      '- a',
      '  - b',
      '',
      '| H1 | H2 |',
      '| --- | --- |',
      '| c | d |'
    ].join('\n')
    const model = markdownToWordModel(source)
    const rebuilt = wordModelToMarkdown(model)
    expect(markdownToWordModel(rebuilt)).toEqual(model)
  })

  it('escapes literal markdown control characters', () => {
    const model: WordDocumentModel = {
      kind: 'word',
      blocks: [{ type: 'paragraph', runs: [{ text: 'price *is* 2_000 [really]' }] }]
    }
    const markdown = wordModelToMarkdown(model)
    expect(markdown).toBe('price \\*is\\* 2\\_000 \\[really\\]\n')
    const reparsed = markdownToWordModel(markdown)
    expect(reparsed.blocks[0]).toEqual({
      type: 'paragraph',
      runs: [{ text: 'price *is* 2_000 [really]' }]
    })
  })

  it('renders underline as a u-span and keeps ordered list markers', () => {
    const model: WordDocumentModel = {
      kind: 'word',
      blocks: [
        { type: 'list-item', ordered: true, level: 0, runs: [{ text: 'u', underline: true }] }
      ]
    }
    expect(wordModelToMarkdown(model)).toBe('1. <u>u</u>\n')
  })
})
