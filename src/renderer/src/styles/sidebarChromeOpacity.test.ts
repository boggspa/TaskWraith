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
  it('derives the fixed chrome fill from the decoupled --sidebar-chrome-color token', () => {
    const lines = readRepoFile('src/renderer/src/styles/theme.css').split('\n')
    const fillLine = lines.find((line) => line.includes('--sidebar-chrome-fixed-bg:'))
    expect(fillLine, 'Missing --sidebar-chrome-fixed-bg token').toBeTruthy()
    // Derived from --sidebar-chrome-color, NOT --sidebar-bg-solid (which stays the
    // list surface colour) and NOT --sidebar-bg (transparent in native_glass).
    expect(fillLine).toContain('var(--sidebar-chrome-color) 85%')
    expect(fillLine).not.toContain('--sidebar-bg-solid')
    expect(fillLine).not.toContain('var(--sidebar-bg)')
    // Dark default is the requested #1D1D1C.
    const darkColor = lines.find(
      (line) => line.includes('--sidebar-chrome-color:') && line.includes('#1d1d1c')
    )
    expect(darkColor, 'Missing dark --sidebar-chrome-color: #1d1d1c').toBeTruthy()
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

  it('pins the chrome regions (incl. the top band) fully opaque under Reduce Transparency', () => {
    const css = readCss('05-polish-fx-layouts.css')
    const reduced = cssBlockStartingAt(
      css,
      '[data-reduce-transparency="true"] .app-sidebar .sidebar-top-chrome,'
    )
    expect(reduced).toContain('.sidebar-masthead')
    expect(reduced).toContain('.sidebar-footer')
    expect(reduced).toContain('.model-usage-summary--sidebar')
    // Uses the chrome colour opaque — not --sidebar-bg-solid (the list colour).
    expect(reduced).toContain('background: var(--sidebar-chrome-color) !important;')
  })

  it('wraps the top region (masthead->search) in a seamless fixed-alpha band, excluding the list', () => {
    const css = readCss('05-polish-fx-layouts.css')
    const band = cssBlockStartingAt(css, '.app-sidebar .sidebar-top-chrome {')
    expect(band).toContain('background: var(--sidebar-chrome-fixed-bg);')
    // Bleeds the sidebar-content side padding + the 10px gap so it reads as one
    // flat edge-to-edge rectangle rather than the old floating masthead card.
    expect(band).toContain('margin: 0 calc(var(--space-md) * -1) -10px;')
    // The list + its own scroll container are NOT part of the band.
    expect(band).not.toContain('sidebar-hierarchy-scroll')
  })
})
