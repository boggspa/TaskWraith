import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(new URL(`../assets/css/${file}`, import.meta.url), 'utf8')

/* 2026-08 composer-popover vs transcript-rail stacking pin.
 *
 * The two transcript side rails (user-message gutter left, participant-filter
 * rail right) and every composer popover are ALL `createPortal(…, document.body)`
 * + `position: fixed`, so they are sibling children of <body> with no
 * intervening stacking context: raw z-index alone decides who paints on top,
 * and — because the rail's buttons are `pointer-events: auto` — who takes the
 * click.
 *
 * The rails were added later at 10030/10031, deliberately ABOVE the sheet
 * backdrop band (~70-9140) so a backdrop can't bleed over them; sheets are
 * handled instead by the `html:has(...)` hide list in
 * 02-transcript-messages-fx.css. Doing that leapfrogged the older popover band
 * and nobody moved the popovers up, so the participant-filter rail painted
 * OVER the participant chip popover (9500) and over the row's `+`
 * add-participant popover (1000) — reported as icons floating on top of the
 * popover's Role / Goal fields, with the chip's own hover tooltip (10060,
 * portaled from the SAME component) already correctly above the rail.
 *
 * The fix puts the popovers in the documented portaled-popover band —
 * "a portaled transcript popover must clear app chrome + docks", 10060, shared
 * with .transcript-message-context-menu / .transcript-file-card /
 * .ensemble-above-chip-tooltip.
 *
 * These assertions read the LIVE numbers out of the CSS and compare them
 * rather than hardcoding either side, so they also fail if someone later
 * raises a rail past the popovers instead of regressing the popovers.
 *
 * Do NOT "fix" a future recurrence by adding these popovers to the rails'
 * `html:has(...)` hide list. That list is for full-screen sheets that own the
 * whole screen; a chip popover is a small anchored dialog, and hiding a
 * navigation rail whenever any picker opens makes the rail flicker away.
 */

/** z-index of a base (line-anchored, no compound/descendant) rule block. */
const baseRuleZIndex = (css: string, selector: string): number => {
  const start = css.indexOf(`\n${selector} {`)
  expect(start, `missing base rule for ${selector}`).toBeGreaterThanOrEqual(0)
  const block = css.slice(start, css.indexOf('\n}', start))
  const match = block.match(/z-index:\s*(-?\d+)/)
  expect(match, `no z-index in ${selector}`).not.toBeNull()
  return Number(match?.[1])
}

describe('composer popover vs transcript rail stacking', () => {
  const railCss = readCss('02-transcript-messages-fx.css')
  const gutterZ = baseRuleZIndex(railCss, '.transcript-user-gutter')
  const filterRailZ = baseRuleZIndex(railCss, '.transcript-participant-filter-rail')

  it('floats the participant chip popover above both body-portaled rails', () => {
    const z = baseRuleZIndex(readCss('09-ensemble-work-session.css'), '.ensemble-above-overflow')

    expect(z).toBeGreaterThan(filterRailZ)
    expect(z).toBeGreaterThan(gutterZ)
  })

  it('floats the combined picker popover above both body-portaled rails', () => {
    // Shell for the participants row's `+` add-participant popover
    // (.is-ensemble-add-participant) as well as the composer model,
    // permission and workspace pickers — one shell, one stacking answer.
    const z = baseRuleZIndex(
      readCss('08-theme-picker-overrides.css'),
      '.composer-combined-picker-popover'
    )

    expect(z).toBeGreaterThan(filterRailZ)
    expect(z).toBeGreaterThan(gutterZ)
  })

  it('raises only roster-owned nested pickers above the outer Ensemble portal', () => {
    const baseCombinedZ = baseRuleZIndex(
      readCss('08-theme-picker-overrides.css'),
      '.composer-combined-picker-popover'
    )
    const outerRosterZ = baseRuleZIndex(
      readCss('03-composer-welcome-activity.css'),
      '.composer-ensemble-toggle-popover'
    )
    const nestedRosterZ = baseRuleZIndex(
      readCss('39-ensemble-roster-popover.css'),
      '.composer-combined-picker-popover.is-ensemble-roster-nested-picker'
    )

    expect(baseCombinedZ).toBeLessThan(outerRosterZ)
    expect(nestedRosterZ).toBeGreaterThan(outerRosterZ)
  })

  it('keeps the chip popover from covering its own hover tooltip band', () => {
    // The tooltip is suppressed while the popover is open (`!overflowOpen` in
    // EnsembleParticipantsAboveRow), so they never actually collide — but both
    // belong to the same portaled-popover band, and a popover that outran it
    // would mean the band had been abandoned rather than joined.
    const css = readCss('09-ensemble-work-session.css')

    expect(baseRuleZIndex(css, '.ensemble-above-overflow')).toBeLessThanOrEqual(
      baseRuleZIndex(css, '.ensemble-above-chip-tooltip')
    )
  })
})
