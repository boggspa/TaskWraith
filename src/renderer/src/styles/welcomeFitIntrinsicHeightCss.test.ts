import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (path: string): string =>
  readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n')

const cssBlockStartingAt = (source: string, marker: string): string => {
  const start = source.indexOf(marker)
  expect(start, `Missing marker: ${marker}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for marker: ${marker}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

/** These rules carry long rationale comments that quote the values they replaced,
 *  so negative assertions have to run against declarations only. */
const withoutComments = (block: string): string => block.replace(/\/\*[\s\S]*?\*\//g, '')

/*
 * The welcome screen collapses surfaces (notification → dashboard → heatmap) as
 * the pane gets shorter, so the greeting + composer always survive. That ladder
 * is driven by the JS fit observer in App.tsx, which compares the flow's
 * measured height against the pane height.
 *
 * The measurement is only meaningful while the measured boxes keep their
 * intrinsic height. When the composer stack was allowed to shrink, it silently
 * absorbed the overflow instead — a 267px stack laid out at 109px — so the
 * required height could never exceed the available height, the ladder never
 * engaged, and the composer got crushed under the dashboard + heatmap. These
 * declarations are what make the overflow real and therefore detectable.
 */
describe('welcome fit intrinsic-height CSS', () => {
  const css = readCss('src/renderer/src/assets/css/03-composer-welcome-activity.css')

  it('keeps the welcome composer stack at its intrinsic height', () => {
    const block = cssBlockStartingAt(
      css,
      '.app-transcript.welcome-mode:not(.multiview-pane-transcript) .composer-primary-stack {'
    )

    // `flex-shrink` governs the plain flex path (no notification zone).
    expect(block).toContain('flex-shrink: 0')
    // `min-height` governs the `:has(> .notification-zone)` grid path, where
    // flex properties are ignored. `min-height: 0` re-opens the bug.
    expect(block).toContain('min-height: auto')
    expect(withoutComments(block)).not.toMatch(/min-height:\s*0/)
  })

  it('keeps the 90-day heatmap at its intrinsic height', () => {
    // The fit budget counts the heatmap's height as a hard requirement, so a
    // squeezed heatmap understates the budget the same way a squeezed stack does.
    const block = cssBlockStartingAt(css, '  > .welcome-standalone-heatmaps {')

    expect(block).toContain('flex-shrink: 0')
    expect(withoutComments(block)).not.toMatch(/min-height:\s*0/)
  })

  it('still hides the three surfaces in priority order once the fit ladder engages', () => {
    // Guards the other half of the contract: the classes the observer applies
    // must still map to rules that actually remove each surface from the flow.
    expect(css).toContain('.app-transcript.welcome-mode.welcome-dashboard-hidden-by-fit')
    expect(css).toContain('.app-transcript.welcome-mode.welcome-heatmaps-hidden-by-fit')

    const dashboardHidden = cssBlockStartingAt(
      css,
      '.app-transcript.welcome-mode.welcome-dashboard-hidden-by-fit .welcome-usage-region {'
    )
    expect(dashboardHidden).toContain('visibility: hidden')

    const heatmapsHidden = cssBlockStartingAt(
      css,
      '.app-transcript.welcome-mode.welcome-heatmaps-hidden-by-fit .welcome-standalone-heatmaps {'
    )
    expect(heatmapsHidden).toContain('visibility: hidden')
  })
})
