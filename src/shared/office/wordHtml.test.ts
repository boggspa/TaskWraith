import { describe, expect, it } from 'vitest'
import { wordHtmlToModel, wordModelToHtml } from './wordHtml'
import type { WordDocumentModel } from './officeModels'

describe('wordModelToHtml', () => {
  it('renders headings, styled runs, lists and tables', () => {
    const model: WordDocumentModel = {
      kind: 'word',
      blocks: [
        { type: 'heading', level: 2, runs: [{ text: 'Section' }] },
        {
          type: 'paragraph',
          runs: [
            { text: 'plain ' },
            { text: 'bold', bold: true },
            { text: ' and ' },
            { text: 'link', link: 'https://x.y' }
          ]
        },
        { type: 'list-item', ordered: false, level: 0, runs: [{ text: 'a' }] },
        { type: 'list-item', ordered: false, level: 1, runs: [{ text: 'b' }] },
        { type: 'list-item', ordered: true, level: 0, runs: [{ text: 'c' }] },
        { type: 'table', rows: [[[{ text: 'x' }], [{ text: 'y' }]]] }
      ]
    }
    const html = wordModelToHtml(model)
    expect(html).toBe(
      '<h2>Section</h2>' +
        '<p>plain <strong>bold</strong> and <a href="https://x.y">link</a></p>' +
        '<ul><li>a</li><ul><li>b</li></ul></ul>' +
        '<ol><li>c</li></ol>' +
        '<table><tbody><tr><td>x</td><td>y</td></tr></tbody></table>'
    )
  })

  it('renders an empty document as a caret placeholder paragraph', () => {
    expect(wordModelToHtml({ kind: 'word', blocks: [] })).toBe('<p><br></p>')
    expect(wordModelToHtml({ kind: 'word', blocks: [{ type: 'paragraph', runs: [] }] })).toBe(
      '<p><br></p>'
    )
  })

  it('escapes markup in run text and encodes newlines as <br>', () => {
    const html = wordModelToHtml({
      kind: 'word',
      blocks: [{ type: 'paragraph', runs: [{ text: 'a<b> &\nnext' }] }]
    })
    expect(html).toBe('<p>a&lt;b&gt; &amp;<br>next</p>')
  })
})

describe('wordHtmlToModel', () => {
  it('round-trips the canonical markup', () => {
    const model: WordDocumentModel = {
      kind: 'word',
      blocks: [
        { type: 'heading', level: 1, runs: [{ text: 'Title' }] },
        {
          type: 'paragraph',
          runs: [{ text: 'mix ' }, { text: 'bi', bold: true, italic: true }, { text: ' tail' }]
        },
        { type: 'list-item', ordered: true, level: 0, runs: [{ text: 'one' }] },
        { type: 'table', rows: [[[{ text: 'c1' }], [{ text: 'c2' }]]] }
      ]
    }
    expect(wordHtmlToModel(wordModelToHtml(model))).toEqual(model)
  })

  it('parses Chromium execCommand artifacts: b/i tags, div line wrappers, style spans', () => {
    const html =
      '<div>Hello <b>world</b> again</div>' +
      '<div><span style="font-weight: bold;">heavy</span> <i>lean</i></div>' +
      '<div><br></div>' +
      '<div>tail</div>'
    const model = wordHtmlToModel(html)
    expect(model.blocks).toEqual([
      {
        type: 'paragraph',
        runs: [{ text: 'Hello ' }, { text: 'world', bold: true }, { text: ' again' }]
      },
      {
        type: 'paragraph',
        runs: [{ text: 'heavy', bold: true }, { text: ' ' }, { text: 'lean', italic: true }]
      },
      { type: 'paragraph', runs: [] },
      { type: 'paragraph', runs: [{ text: 'tail' }] }
    ])
  })

  it('promotes bare inline content at the root into a paragraph', () => {
    const model = wordHtmlToModel('typed before any block <strong>bold</strong>')
    expect(model.blocks).toEqual([
      {
        type: 'paragraph',
        runs: [{ text: 'typed before any block ' }, { text: 'bold', bold: true }]
      }
    ])
  })

  it('keeps interleaved text order around styled spans', () => {
    const model = wordHtmlToModel('<p>a <u>u</u> b <s>s</s> c</p>')
    const runs = model.blocks[0].type === 'paragraph' ? model.blocks[0].runs : []
    expect(runs.map((run) => run.text).join('')).toBe('a u b s c')
    expect(runs[1]).toEqual({ text: 'u', underline: true })
    expect(runs[3]).toEqual({ text: 's', strike: true })
  })

  it('flattens nested lists with correct levels and ignores non-http links', () => {
    const model = wordHtmlToModel(
      '<ul><li>top<ul><li>deep <a href="javascript:alert(1)">bad</a></li></ul></li></ul>'
    )
    expect(model.blocks).toEqual([
      { type: 'list-item', ordered: false, level: 0, runs: [{ text: 'top' }] },
      { type: 'list-item', ordered: false, level: 1, runs: [{ text: 'deep bad' }] }
    ])
  })

  it('reads thead/tbody tables with th cells', () => {
    const model = wordHtmlToModel(
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>V</td></tr></tbody></table>'
    )
    expect(model.blocks[0]).toEqual({
      type: 'table',
      rows: [[[{ text: 'H' }]], [[{ text: 'V' }]]]
    })
  })

  it('round-trips image blocks and imports pasted data-URI images', () => {
    const PNG_URI =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const model: WordDocumentModel = {
      kind: 'word',
      blocks: [
        { type: 'paragraph', runs: [{ text: 'above' }] },
        { type: 'image', image: { dataUri: PNG_URI, name: 'pixel.png', widthPx: 40, heightPx: 30 } }
      ]
    }
    const html = wordModelToHtml(model)
    expect(html).toContain(`<img src="${PNG_URI}" alt="pixel.png" width="40" height="30">`)
    expect(wordHtmlToModel(html)).toEqual(model)

    // Chromium paste shape: bare img inside a div, mixed with text. The
    // remote image is dropped; its wrapper survives as a blank line.
    const pasted = wordHtmlToModel(
      `<div>look: <img src="${PNG_URI}"></div><div><img src="https://remote.example/x.png"></div>`
    )
    expect(pasted.blocks).toEqual([
      { type: 'paragraph', runs: [{ text: 'look: ' }] },
      { type: 'image', image: { dataUri: PNG_URI, name: '' } },
      { type: 'paragraph', runs: [] }
    ])
  })

  it('returns a single empty paragraph for empty or placeholder input', () => {
    expect(wordHtmlToModel('')).toEqual({
      kind: 'word',
      blocks: [{ type: 'paragraph', runs: [] }]
    })
    expect(wordHtmlToModel('<p><br></p>')).toEqual({
      kind: 'word',
      blocks: [{ type: 'paragraph', runs: [] }]
    })
  })
})
