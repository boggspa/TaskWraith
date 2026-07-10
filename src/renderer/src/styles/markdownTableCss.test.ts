import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (cssPath = 'src/renderer/src/assets/css/05-polish-fx-layouts.css'): string =>
  readFileSync(join(process.cwd(), cssPath), 'utf8').replace(/\r\n/g, '\n')

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('markdown table CSS', () => {
  it('wraps table content before falling back to local horizontal scroll', () => {
    const css = readCss()

    const tableBlock = cssBlockStartingAt(
      css,
      '.message-markdown-pro .markdown-table-scroll > table {'
    )
    const cellBlock = cssBlockStartingAt(
      css,
      '.message-markdown-pro th,\n.message-markdown-pro td {'
    )
    const headerBlock = cssBlockStartingAt(css, '.message-markdown-pro th {')

    expect(tableBlock).toContain('table-layout: fixed')
    expect(cellBlock).toContain('overflow-wrap: break-word')
    expect(headerBlock).toContain('white-space: normal')
    expect(headerBlock).toContain('overflow-wrap: anywhere')
    expect(headerBlock).not.toContain('white-space: nowrap')
  })

  it('keeps eight-column table headers whole and delegates overflow to the local scroller', () => {
    const css = readCss()
    const scrollBlock = cssBlockStartingAt(css, '.message-markdown-pro .markdown-table-scroll {')
    const denseHeaderBlock = cssBlockStartingAt(
      css,
      '.message-markdown-pro .markdown-table-scroll > table:has(thead > tr > th:nth-child(8)) thead > tr > th {'
    )
    const cellBlock = cssBlockStartingAt(
      css,
      '.message-markdown-pro th,\n.message-markdown-pro td {'
    )

    expect(scrollBlock).toContain('overflow-x: auto')
    expect(denseHeaderBlock).toContain('width: 7rem')
    expect(denseHeaderBlock).toContain('white-space: nowrap')
    expect(denseHeaderBlock).toContain('overflow-wrap: normal')
    expect(cellBlock).toContain('overflow-wrap: break-word')
  })

  it('keeps wide tables inside system-message transcript bounds', () => {
    const transcriptCss = readCss('src/renderer/src/assets/css/02-transcript-messages-fx.css')
    const systemBubbleBlock = cssBlockStartingAt(transcriptCss, '\n.message-bubble.system {')

    expect(systemBubbleBlock).toContain('min-width: 0')
    expect(systemBubbleBlock).toContain('max-width: 100%')
  })
})
