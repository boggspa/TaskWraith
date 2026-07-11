import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSidebarCss = (): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css/01-sidebar.css'), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

const readThemeCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/08-theme-picker-overrides.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('sidebar hierarchy rhythm CSS', () => {
  it('keeps top-level section rows on one shared vertical rhythm', () => {
    const css = readSidebarCss()
    const scrollBlock = cssBlockStartingAt(css, '.sidebar-hierarchy-scroll {')
    const panelBlock = cssBlockStartingAt(css, '#sidebar-threads-panel,')
    const childResetBlock = cssBlockStartingAt(css, '.sidebar-hierarchy-section > :is(')
    const headerBlock = cssBlockStartingAt(css, '.sidebar-hierarchy-scroll .sidebar-section-header {')
    const sectionBlock = cssBlockStartingAt(css, '\n.sidebar-hierarchy-section {')
    const emptySectionBlock = cssBlockStartingAt(css, '.sidebar-hierarchy-section:empty {')

    expect(scrollBlock).toContain('--sidebar-section-row-gap: 10px')
    expect(scrollBlock).toContain('--sidebar-section-header-height: 28px')
    expect(scrollBlock).toContain('--sidebar-section-body-gap: 4px')
    expect(scrollBlock).toContain('--sidebar-section-action-size: 22px')
    expect(scrollBlock).toContain('gap: var(--sidebar-section-row-gap)')
    expect(panelBlock).toContain('#sidebar-projects-panel')
    expect(panelBlock).toContain('display: flex')
    // 120a5230b (iOS-parity sidebar chrome): the panels' section rhythm
    // moved OFF the flex gap — each section carries its own padding-block
    // plus a full-width top divider, so the divider sits centered between
    // sections (a panel flex gap would double the spacing) and the chrome
    // travels with the section when drag-reordering changes flex `order`.
    expect(panelBlock).toContain('gap: 0')
    expect(sectionBlock).toContain('padding-block: 9px')
    expect(sectionBlock).toContain('border-top: 1px solid')
    // Null-content sections must not leave a stray divider/padding band.
    expect(emptySectionBlock).toContain('display: none')
    expect(childResetBlock).toContain('.sidebar-shared-section')
    expect(headerBlock).toContain('min-height: var(--sidebar-section-header-height)')
    expect(headerBlock).toContain('margin-bottom: 0')
    expect(sectionBlock).toContain('gap: var(--sidebar-section-body-gap)')
  })

  it('keeps section header actions on a shared trailing slot', () => {
    const css = readSidebarCss()
    const headerBlock = cssBlockStartingAt(css, '\n.sidebar-section-header {')
    const toggleBlock = cssBlockStartingAt(css, '\n.sidebar-section-header-toggle {')
    const wrapBlock = cssBlockStartingAt(
      css,
      '.sidebar-section-header > .sidebar-new-menu-wrap {'
    )
    const actionBlock = cssBlockStartingAt(css, '.sidebar-section-header-action {')

    expect(headerBlock).toContain('width: 100%')
    expect(toggleBlock).toContain('flex: 1 1 auto')
    expect(toggleBlock).toContain('max-width: 100%')
    expect(wrapBlock).toContain('flex: 0 0 var(--sidebar-section-action-size)')
    expect(actionBlock).toContain('flex: 0 0 var(--sidebar-section-action-size)')
  })

  it('overrides provider shell header margins inside the hierarchy scroll', () => {
    const css = readThemeCss()
    const block = cssBlockStartingAt(
      css,
      '.app-sidebar .sidebar-hierarchy-scroll .sidebar-section-header {'
    )

    expect(block).toContain('margin: 0 !important')
    expect(block).toContain('padding: 0 !important')
  })
})
