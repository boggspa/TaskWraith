import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (file: string): string =>
  readFileSync(join(process.cwd(), file), 'utf8').replace(/\r\n/g, '\n')

/*
 * The pending-approval card is an OVERLAY over the composer, not a row
 * nested inside it. Two load-bearing facts this pins:
 *
 * 1. `.composer-surface` has `overflow: hidden` (it clips the native
 *    shell's full-bleed inner module to the frame's rounded corners), so
 *    the card MUST mount outside the surface — as a `.composer-area`
 *    child — or it can never paint over the textarea or exceed the
 *    frame. A well-meaning "move it back next to the other permission
 *    cards" refactor silently regresses the overlay into a clipped
 *    in-flow row.
 *
 * 2. The overlay geometry contract: absolute against `.composer-area`
 *    (the area is `pointer-events: none`, so the card re-enables its
 *    own), z-raised above the surface (2) and chip strips (4), wider
 *    than the surface's width cap but bounded by the pane for narrow
 *    hosts (side-chat sets --composer-content-max-width to 100%), and
 *    never itself a scroller (the ::after rim + radius clip assume a
 *    non-scrolling box — the preview region scrolls instead).
 */
describe('composer agent-approval overlay', () => {
  it('mounts the agent-approval card outside .composer-surface with the overlay modifier', () => {
    const source = readSource('src/renderer/src/components/Composer.tsx')

    expect(source).toContain('composer-permission-card composer-permission-card--overlay provider-')

    // The card renders AFTER the surface closes: the overlay comment marker
    // sits between the surface's closing tag and the approval conditional.
    const surfaceOpen = source.indexOf('className={`composer-surface ')
    const overlayMarker = source.indexOf('Agent-approval OVERLAY')
    const approvalBlock = source.indexOf('{pendingAgentApproval && (')
    expect(surfaceOpen).toBeGreaterThanOrEqual(0)
    expect(overlayMarker).toBeGreaterThan(surfaceOpen)
    expect(approvalBlock).toBeGreaterThan(overlayMarker)

    // No second agent-approval render site sneaks back inside the footer.
    expect(source.indexOf('{pendingAgentApproval && (', approvalBlock + 1)).toBe(-1)
  })

  it('keeps the overlay geometry contract', () => {
    const css = readSource('src/renderer/src/assets/css/03-composer-welcome-activity.css')
    const start = css.indexOf('.composer-permission-card--overlay {')
    expect(start).toBeGreaterThanOrEqual(0)
    const block = css.slice(start, css.indexOf('}', start) + 1)

    expect(block).toContain('position: absolute')
    // Lifted off the area's bottom edge — flush (bottom: 0) rides the
    // window edge because the area is only --composer-bottom-gap above it.
    expect(block).toContain('bottom: var(--space-lg, 16px)')
    expect(block).toContain('z-index: 40')
    expect(block).toContain('pointer-events: auto')
    expect(block).toContain(
      'width: min(calc(100% - 12px), calc(var(--composer-content-max-width) + 96px))'
    )
    // Non-scrolling card box; the preview region is the scroller.
    expect(block).toContain('overflow: hidden')
    expect(css).toMatch(
      /\.composer-permission-card--overlay \.agent-approval-preview \{[^}]*overflow-y: auto/
    )
  })

  it('keeps every child of the clipped card shrinkable, with the actions pinned', () => {
    // The card clips at max-height with overflow:hidden, and flex items
    // default to min-height:auto. Without these rules a single agent-authored
    // string — a draft body, or an external path — grows a child past the clip
    // and pushes Approve out of a box that has no scrollbar. Measured: a body
    // of newlines put Approve 5409px down a 564px card, and an ~800-char path
    // reproduced it after the body alone was bounded. No jsdom here, so pin
    // the rules themselves.
    const css = readSource('src/renderer/src/assets/css/03-composer-welcome-activity.css')

    expect(css).toMatch(/\.composer-permission-card--overlay > \* \{[^}]*min-height: 0/)
    expect(css).toMatch(
      /\.composer-permission-card--overlay > \.composer-permission-actions \{[^}]*flex: 0 0 auto/
    )
    // Both untrusted-text carriers get a ceiling AND a scrollbar.
    const bounded = css.match(
      /\.composer-permission-card--overlay \.composer-permission-message,\s*\.composer-permission-card--overlay \.composer-permission-external-path \{([^}]*)\}/
    )
    expect(bounded).not.toBeNull()
    expect(bounded![1]).toContain('max-height')
    expect(bounded![1]).toContain('overflow: auto')
  })
})
