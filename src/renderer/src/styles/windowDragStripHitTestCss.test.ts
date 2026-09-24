import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(new URL(`../assets/css/${file}`, import.meta.url), 'utf8')

/* 2026-08 right-dock header click-swallow pin.
 *
 * The dock's header row — `.right-dock-switcher`, `.right-dock-cmdk-hint`,
 * `.right-dock-close` — was losing most of its clicks to two invisible window
 * chrome surfaces. Both are fixed here, and they fail in DIFFERENT layers, which
 * is why one fix cannot cover both.
 *
 * 1. DOM hit-testing — `.window-drag-strip`, a bare `<div aria-hidden />`
 *    (App.tsx) whose only job is to be an OS window-drag region on macOS. It is
 *    `position: fixed; top: 0; height: 26px; z-index: 4` and had no
 *    `pointer-events` rule, so it hit-tested its full border box while painting
 *    nothing. Nothing between it and the document root creates a stacking
 *    context — `.app-root`, `.app-main`, `.chat-split-region`, `.right-dock` and
 *    `.right-dock-header` are all `z-index: auto` — so it competed in the root
 *    stacking context and won outright. There is no `.app-header` in the
 *    rendered tree, so the dock starts at window y=0 and all three controls
 *    share a vertical centre of y≈22.5, INSIDE the strip's 0..26 band: aiming at
 *    the middle of any of them always missed and only their bottom ~10px worked.
 *
 * 2. OS draggable regions — the dock is `-webkit-app-region: no-drag`, but the
 *    side chat it can host is an `.app-transcript`, which carries its own 32px
 *    darwin `::before` drag band. Draggable regions are flat geometry folded in
 *    layout order with last-op-wins, so that DESCENDANT re-armed a window-move
 *    band inside a dock that had explicitly opted out.
 *
 * `pointer-events: none` fixes (1) and specifically NOT a z-index bump on the
 * header: Chromium collects `-webkit-app-region` from the layout tree and never
 * consults `pointer-events`, so window dragging is untouched, whereas raising
 * `.right-dock-header` would make it a stacking context and trap its own
 * `z-index: 40` surface menu inside it. It cannot fix (2) at all — that one is
 * resolved by the OS before the renderer hit-tests anything, so the drag band
 * itself has to go.
 *
 * These assertions read the live declarations rather than hardcoding geometry,
 * so they also fail if someone re-adds a hit-testing overlay at the top of the
 * window.
 */

/** The declaration block of a base (line-anchored, single-selector) rule. */
const baseRuleBlock = (css: string, selector: string): string => {
  const start = css.indexOf(`\n${selector} {`)
  expect(start, `missing base rule for ${selector}`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('\n}', start))
}

const baseRuleZIndex = (css: string, selector: string): number => {
  const match = baseRuleBlock(css, selector).match(/z-index:\s*(-?\d+)/)
  expect(match, `no z-index in ${selector}`).not.toBeNull()
  return Number(match?.[1])
}

describe('right-dock header controls stay clickable', () => {
  const baseCss = readCss('00-fonts-base.css')
  const dockCss = readCss('11-side-chat.css')

  it('lets clicks fall through the macOS window-drag strip', () => {
    expect(baseRuleBlock(baseCss, '.window-drag-strip')).toMatch(/pointer-events:\s*none/)
  })

  it('keeps the drag strip a drag region, because that is the whole point of it', () => {
    // pointer-events must not be "fixed" by dropping the app-region instead:
    // the strip exists so a frameless macOS window can still be dragged.
    expect(baseRuleBlock(baseCss, '.window-drag-strip')).toMatch(/-webkit-app-region:\s*drag/)
  })

  it('documents why pass-through is the dock header ' + "row's only defence", () => {
    // The strip outranks the header, and the header deliberately stays at
    // z-index: auto so its own surface menu can escape the dock. If someone
    // ever gives the header a stacking context, this pin should be revisited
    // rather than silently relied on.
    const stripZ = baseRuleZIndex(baseCss, '.window-drag-strip')
    const headerBlock = baseRuleBlock(dockCss, '.right-dock-header')

    expect(stripZ).toBeGreaterThan(0)
    expect(headerBlock).not.toMatch(/z-index:/)
  })

  it('strips the nested transcript drag band back out inside the dock', () => {
    // A transcript hosted in the dock (the side chat) would otherwise re-arm the
    // 32px OS drag band its ::before carries, over a dock that is explicitly
    // no-drag. Last-op-wins on region folding means the descendant beats the
    // ancestor, so the band has to be removed rather than out-stacked.
    expect(
      baseRuleBlock(dockCss, ":root[data-platform='darwin'] .right-dock .app-transcript::before")
    ).toMatch(/content:\s*none/)
  })

  it('keeps that override specific enough to beat the transcript rule it undoes', () => {
    // The rule being beaten is `:root[data-platform='darwin'] .app-transcript::before`
    // in 02-transcript-messages-fx.css. The override adds `.right-dock`, so it
    // wins on specificity rather than on file order.
    const transcriptCss = readCss('02-transcript-messages-fx.css')

    expect(transcriptCss).toContain(":root[data-platform='darwin'] .app-transcript::before")
    expect(dockCss).toContain(":root[data-platform='darwin'] .right-dock .app-transcript::before")
  })
})
