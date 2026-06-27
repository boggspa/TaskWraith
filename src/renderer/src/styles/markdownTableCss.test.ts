import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/05-polish-fx-layouts.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

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
    const cellBlock = cssBlockStartingAt(css, '.message-markdown-pro th,\n.message-markdown-pro td {')
    const headerBlock = cssBlockStartingAt(css, '.message-markdown-pro th {')

    expect(tableBlock).toContain('table-layout: fixed')
    expect(cellBlock).toContain('overflow-wrap: break-word')
    expect(headerBlock).toContain('white-space: normal')
    expect(headerBlock).toContain('overflow-wrap: anywhere')
    expect(headerBlock).not.toContain('white-space: nowrap')
  })
})
