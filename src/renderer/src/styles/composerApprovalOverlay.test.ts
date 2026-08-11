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

  /*
   * "Requested by" answers the same question the close-out table, the fan-out
   * lane card, the sub-thread return and the question card all answer — which
   * participant is this — and it now answers it with the same element instead
   * of a fifth chip vocabulary. Two facts the old `segmented-control-action`
   * pills could not carry come with it: the seat's PERMISSION TIER (the single
   * most relevant field on an approval modal, and the one the pills omitted),
   * and Boss/Captain authority, drawn as the glyph the stage-role pill used to
   * displace.
   */
  it('renders the attribution as the shared seat element, pills only as fallback', () => {
    const source = readSource('src/renderer/src/components/Composer.tsx')

    // The element itself, not a local re-implementation of its chips.
    expect(source).toContain("import { SeatStateChips, seatAccentVar } from './SeatChangeRow'")
    expect(source).toContain('className="composer-permission-attribution-seat"')
    // The hue is the seat's own, never re-derived: it resolves from the
    // HUMANISED model label, and any other derivation drifts from the chips
    // beside it on exactly the Ollama and Pi seats.
    expect(source).toContain('seatAccentVar(approvalSeat)')
    expect(source).toContain('<ParticipantRoleIcon')

    // The pills survive ONLY behind the no-seat branch. A seat that resolves no
    // model would otherwise render an identity-shaped strip naming nothing.
    const attribution = source.indexOf('composer-permission-attribution-label')
    expect(attribution).toBeGreaterThanOrEqual(0)
    const section = source.slice(attribution, source.indexOf('</section>', attribution))
    const seatBranch = section.indexOf('{approvalSeat ? (')
    const pill = section.indexOf('composer-permission-attribution-chip')
    expect(seatBranch).toBeGreaterThanOrEqual(0)
    expect(pill).toBeGreaterThan(seatBranch)
    expect(section.indexOf(') : (')).toBeLessThan(pill)
  })

  it('lets the seat cluster shrink so the permission tier survives a long model id', () => {
    // Composer triggers are `flex-shrink: 0` — correct in the toolbar, where the
    // trigger is a real control. Inside the width-capped card that pushes the
    // tier chip past the rim, and the tier is the whole reason the element beats
    // the pills it replaced. The model label ellipsises instead.
    const css = readSource('src/renderer/src/assets/css/03-composer-welcome-activity.css')

    expect(css).toMatch(
      /\.composer-permission-attribution-seat\.seat-state-chips \{[^}]*min-width: 0/
    )
    expect(css).toMatch(
      /\.composer-permission-attribution-seat > \.seat-change-chip\[data-composer-control='permission'\] \{[^}]*flex: 0 0 auto/
    )
    expect(css).toMatch(
      /\.composer-permission-attribution-seat \.composer-combined-picker-trigger-primary \{[^}]*text-overflow: ellipsis/
    )

    // Layout only. A `color` anywhere on this chain kills the provider hue, the
    // permission tint and the reasoning shimmer flowing into `.seat-change-chip`
    // from the composer's own rules. The role span's colour is inline, from
    // `seatAccentVar` — never here.
    const roleStart = css.indexOf('.composer-permission-attribution-role {')
    expect(roleStart).toBeGreaterThanOrEqual(0)
    const seatRules = css.slice(roleStart, css.indexOf('.composer-permission-countdown {'))
    expect(seatRules).not.toMatch(/^\s*color:/m)
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
