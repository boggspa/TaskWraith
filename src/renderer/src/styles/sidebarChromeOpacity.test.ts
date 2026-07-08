import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readRepoFile = (relativePath: string): string =>
  readFileSync(join(process.cwd(), relativePath), 'utf8')

const readCss = (file: string): string =>
  readRepoFile(join('src/renderer/src/assets/css', file))

const cssBlockStartingAt = (source: string, selector: string, fromIndex = 0): string => {
  const start = source.indexOf(selector, fromIndex)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

// The sidebar's masthead, model-usage pane, and footer/status keep a FIXED 85%
// fill independent of the user's Settings -> Appearance sidebar-opacity slider,
// while the workspace/threads list keeps riding the factor-scaled .app-sidebar
// surface. See --sidebar-chrome-fixed-bg in theme.css.
describe('sidebar chrome fixed opacity CSS', () => {
  it('defines the fixed chrome token anchored on the always-opaque --sidebar-bg-solid', () => {
    const theme = readRepoFile('src/renderer/src/styles/theme.css')
    const tokenLine = theme
      .split('\n')
      .find((line) => line.includes('--sidebar-chrome-fixed-bg:'))
    expect(tokenLine, 'Missing --sidebar-chrome-fixed-bg token').toBeTruthy()
    // Must anchor on --sidebar-bg-solid (opaque in every mode; --sidebar-bg is
    // literally `transparent` in native_glass, and --surface-1/2 miss the
    // obsidian/alabaster .app-sidebar theme flip).
    expect(tokenLine).toContain('var(--sidebar-bg-solid) 85%')
    expect(tokenLine).not.toContain('var(--sidebar-bg)')
    expect(tokenLine).not.toContain('--surface-1')
    expect(tokenLine).not.toContain('--surface-2')
  })

  it('paints the masthead with the fixed chrome token (no longer transparent)', () => {
    const css = readCss('05-polish-fx-layouts.css')
    const masthead = cssBlockStartingAt(css, '.sidebar-masthead {')
    expect(masthead).toContain('background: var(--sidebar-chrome-fixed-bg) !important;')
    expect(masthead).not.toContain('background: transparent')
  })

  it('paints the footer/status and model-usage pane with the fixed chrome token', () => {
    const css = readCss('05-polish-fx-layouts.css')
    const grouped = cssBlockStartingAt(
      css,
      '.app-sidebar .sidebar-footer,\n.app-sidebar .model-usage-summary--sidebar {'
    )
    expect(grouped).toContain('background: var(--sidebar-chrome-fixed-bg) !important;')
    // The workspace/threads list + its toggle/search/headers must NOT be pinned
    // here — they stay at the user-defined opacity.
    expect(grouped).not.toContain('sidebar-hierarchy-scroll')
    expect(grouped).not.toContain('sidebar-view-tabs')
    expect(grouped).not.toContain('sidebar-search-section')
  })

  it('pins the three chrome regions fully opaque under Reduce Transparency', () => {
    const css = readCss('05-polish-fx-layouts.css')
    const reduced = cssBlockStartingAt(
      css,
      '[data-reduce-transparency="true"] .app-sidebar .sidebar-masthead,'
    )
    expect(reduced).toContain('.sidebar-footer')
    expect(reduced).toContain('.model-usage-summary--sidebar')
    expect(reduced).toContain('background: var(--sidebar-bg-solid) !important;')
  })
})
