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

// The top masthead band and footer/status derive their fill
// from --sidebar-chrome-color (decoupled from the .app-sidebar list surface,
// which rides the sidebar-opacity slider) and tie its ALPHA 1:1 to the MAIN-PANE
// opacity setting via --main-pane-opacity-100 — fully opaque at the default 100%,
// fading in lockstep with the Main-Pane slider. See --sidebar-chrome-fixed-bg.
describe('sidebar chrome fixed opacity CSS', () => {
  it('derives the chrome fill from --sidebar-chrome-color, alpha tied to the Main-Pane slider', () => {
    const lines = readRepoFile('src/renderer/src/styles/theme.css').split('\n')
    const fillLine = lines.find((line) => line.includes('--sidebar-chrome-fixed-bg:'))
    expect(fillLine, 'Missing --sidebar-chrome-fixed-bg token').toBeTruthy()
    // Derived from --sidebar-chrome-color, NOT --sidebar-bg-solid (which stays the
    // list surface colour) and NOT --sidebar-bg (transparent in native_glass).
    // Alpha rides the Main-Pane opacity 1:1 via --main-pane-opacity-100.
    expect(fillLine).toContain('var(--sidebar-chrome-color) var(--main-pane-opacity-100)')
    expect(fillLine).not.toContain('--sidebar-bg-solid')
    expect(fillLine).not.toContain('var(--sidebar-bg)')
    // Dark default matches the dark transcript (#161616).
    const darkColor = lines.find(
      (line) => line.includes('--sidebar-chrome-color:') && line.includes('#161616')
    )
    expect(darkColor, 'Missing dark --sidebar-chrome-color: #161616').toBeTruthy()
  })

  it('shares one theme-adaptive rim token across the chrome sections', () => {
    const theme = readRepoFile('src/renderer/src/styles/theme.css')
    // Light rim on the dark default, dark rim on the light-family flip.
    expect(theme).toContain('--sidebar-chrome-rim: rgba(255, 255, 255, 0.08)')
    expect(theme).toContain('--sidebar-chrome-rim: rgba(18, 21, 27, 0.08)')
    const band = cssBlockStartingAt(
      readCss('05-polish-fx-layouts.css'),
      '.app-sidebar .sidebar-top-chrome {'
    )
    expect(band).toContain('inset 0 0 0 1px var(--sidebar-chrome-rim)')
  })

  it('lets the masthead inherit the fixed chrome band without stacking opacity', () => {
    const css = readCss('05-polish-fx-layouts.css')
    const masthead = cssBlockStartingAt(css, '.sidebar-masthead {')
    expect(masthead).toContain('background: transparent !important;')
    expect(masthead).not.toContain('background: var(--sidebar-chrome-fixed-bg)')
  })

  it('paints footer/status with the fixed chrome token but leaves Model Usage component-owned', () => {
    const css = readCss('05-polish-fx-layouts.css')
    const footer = cssBlockStartingAt(
      css,
      '.app-sidebar .sidebar-footer {',
      css.indexOf('Footer/status shares')
    )
    expect(footer).toContain('background: var(--sidebar-chrome-fixed-bg) !important;')
    expect(footer).not.toContain('model-usage-summary--sidebar')
    // The workspace/threads list + its toggle/search/headers must NOT be pinned
    // here — they stay at the user-defined opacity.
    expect(footer).not.toContain('sidebar-hierarchy-scroll')
    expect(footer).not.toContain('sidebar-view-tabs')
    expect(footer).not.toContain('sidebar-search-section')
  })

  it('pins the chrome regions (incl. the top band) fully opaque under Reduce Transparency', () => {
    const css = readCss('05-polish-fx-layouts.css')
    const reduced = cssBlockStartingAt(
      css,
      '[data-reduce-transparency="true"] .app-sidebar .sidebar-top-chrome,'
    )
    expect(reduced).toContain('.sidebar-masthead')
    expect(reduced).toContain('.sidebar-footer')
    expect(reduced).not.toContain('.model-usage-summary--sidebar')
    // Uses the chrome colour opaque — not --sidebar-bg-solid (the list colour).
    expect(reduced).toContain('background: var(--sidebar-chrome-color) !important;')
  })

  it('wraps the top region (masthead->search) in a seamless fixed-alpha band, excluding the list', () => {
    const css = readCss('05-polish-fx-layouts.css')
    const band = cssBlockStartingAt(css, '.app-sidebar .sidebar-top-chrome {')
    expect(band).toContain('background: var(--sidebar-chrome-fixed-bg);')
    // Bleeds the sidebar-content padding (top + sides) + the 10px gap so it reads
    // as one flat edge-to-edge rectangle rather than the old floating masthead
    // card, ALWAYS reaching the content's top edge — the update pill renders
    // inside the band, so there is no conditional carve-out above it.
    expect(band).toContain('margin: calc(var(--space-md) * -1) calc(var(--space-md) * -1) -10px;')
    expect(band).toContain('padding: var(--space-md) var(--space-md) 10px;')
    // The list + its own scroll container are NOT part of the band.
    expect(band).not.toContain('sidebar-hierarchy-scroll')
  })

  it('keeps the update pill row on the band fill instead of carving a gap above it', () => {
    const css = readCss('05-polish-fx-layouts.css')
    // The old layout rendered the pill row ABOVE the band and suppressed the
    // band's top bleed via :has(), leaving the row on the raw slider-opacity
    // sidebar surface — a visible gap in the chrome. The pill row now lives
    // inside .sidebar-top-chrome and must stay paint-free (band supplies the
    // fill), with no :has() escape hatch reintroducing the gap.
    expect(css).not.toContain(':has(> .sidebar-update-pill-row)')
    const row = cssBlockStartingAt(css, '.sidebar-update-pill-row {')
    expect(row).not.toContain('background')
  })

  it('paints the chrome fill behind the macOS traffic lights, non-interactively', () => {
    const css = readCss('01-sidebar.css')
    const fill = cssBlockStartingAt(css, ":root[data-platform='darwin'] .sidebar-titlebar-fill {")
    expect(fill).toContain('background: var(--sidebar-chrome-fixed-bg);')
    // Matches the .app-sidebar padding-top inset and never intercepts input.
    expect(fill).toContain('height: 36px')
    expect(fill).toContain('pointer-events: none;')
    // Must beat the epic-FX / native_glass `.app-sidebar > *` position:relative
    // override, or the fill drops into flow and stops overlaying the strip.
    expect(fill).toContain('position: absolute !important;')
  })
})
