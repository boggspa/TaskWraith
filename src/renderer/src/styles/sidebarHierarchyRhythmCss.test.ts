import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css/01-sidebar.css'), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('sidebar hierarchy rhythm CSS', () => {
  it('keeps top-level section rows on one shared spacing grid', () => {
    const css = readCss()
    const scrollBlock = cssBlockStartingAt(css, '.sidebar-hierarchy-scroll {')
    const childResetBlock = cssBlockStartingAt(css, '.sidebar-hierarchy-scroll > :is(')
    const headerBlock = cssBlockStartingAt(css, '.sidebar-hierarchy-scroll .sidebar-section-header {')
    const sectionBlock = cssBlockStartingAt(css, '.sidebar-hierarchy-section {')

    expect(scrollBlock).toContain('--sidebar-section-row-gap: 10px')
    expect(scrollBlock).toContain('--sidebar-section-header-height: 28px')
    expect(scrollBlock).toContain('--sidebar-section-body-gap: 4px')
    expect(scrollBlock).toContain('gap: var(--sidebar-section-row-gap)')
    expect(childResetBlock).toContain('.sidebar-shared-section')
    expect(headerBlock).toContain('min-height: var(--sidebar-section-header-height)')
    expect(headerBlock).toContain('margin-bottom: 0')
    expect(sectionBlock).toContain('gap: var(--sidebar-section-body-gap)')
  })
})
