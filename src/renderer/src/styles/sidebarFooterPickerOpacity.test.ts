import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', file), 'utf8')

const cssBlockStartingAt = (source: string, selector: string, fromIndex = 0): string => {
  const start = source.indexOf(selector, fromIndex)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('sidebar footer picker opacity CSS', () => {
  it('sets settings and footer picker shells to a 75% solid theme surface', () => {
    const css = readCss('05-polish-fx-layouts.css')

    const settingsBlock = cssBlockStartingAt(css, '.sidebar-settings-menu {')
    const lightSettingsBlock = cssBlockStartingAt(
      css,
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"]) .sidebar-settings-menu {'
    )
    const footerBlock = cssBlockStartingAt(css, '.sidebar-footer-popover {')
    const lightFooterBlock = cssBlockStartingAt(
      css,
      ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"]) .sidebar-footer-popover {'
    )

    for (const block of [settingsBlock, lightSettingsBlock, footerBlock, lightFooterBlock]) {
      expect(block).toContain('--sidebar-picker-bg-solid')
      expect(block).toContain('var(--sidebar-picker-bg-solid) 75%')
      expect(block).not.toContain('var(--panel-elevated-bg) 90%')
      expect(block).not.toContain('var(--surface-1) 88%')
    }
  })

  it('sets the shared chat create picker to a 75% solid theme surface', () => {
    const css = readCss('09-ensemble-work-session.css')

    const sharedBlock = cssBlockStartingAt(css, '.sidebar-new-menu.sidebar-shared-create-menu {')
    const lightSharedBlock = cssBlockStartingAt(
      css,
      '.sidebar-new-menu.sidebar-shared-create-menu {',
      css.indexOf('.sidebar-new-menu.sidebar-shared-create-menu {') + 1
    )

    for (const block of [sharedBlock, lightSharedBlock]) {
      expect(block).toContain('--sidebar-picker-bg-solid')
      expect(block).toContain('var(--sidebar-picker-bg-solid) 75%')
      expect(block).not.toContain('var(--panel-elevated-bg) 88%')
      expect(block).not.toContain('var(--surface-1) 86%')
    }
  })

  it('keeps sidebar pickers opaque when transparency is reduced', () => {
    const css = readCss('05-polish-fx-layouts.css')
    const reduceTransparencyBlock = cssBlockStartingAt(
      css,
      ':is(.sidebar-settings-menu, .sidebar-footer-popover, .sidebar-shared-create-menu) {'
    )

    expect(reduceTransparencyBlock).toContain(
      'background: var(--sidebar-picker-bg-solid) !important'
    )
    expect(reduceTransparencyBlock).toContain('backdrop-filter: none')
  })
})
