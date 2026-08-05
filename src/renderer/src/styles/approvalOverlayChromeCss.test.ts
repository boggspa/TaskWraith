import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(new URL(`../assets/css/${file}`, import.meta.url), 'utf8')

/* 2026-08 approval-modal redraft pins.
 *
 * 1. The transcript side rails (user-message gutter left, participant-filter
 *    rail right) are body-portaled `position: fixed` elements at z-index
 *    10030/10031 — nothing inside `.composer-area` can out-stack them. While
 *    an approval overlay is pending it IS the designated interaction surface
 *    (the composer area is pointer-events: none), so both rails join the same
 *    `html:has(...)` hide list they already use for sheet backdrops. These
 *    pins keep the two lists carrying the overlay class in sync — dropping it
 *    from either regresses the rails painting OVER the approval card.
 *
 * 2. The card chrome derives from the per-participant accent (`--accent`
 *    pinned inline by Composer, fan-out result-card pattern). The old
 *    hand-written per-provider tint rules (codex/claude/kimi) must stay gone:
 *    they carried equal specificity and would silently override the accent
 *    chrome for exactly those three providers.
 */
describe('approval overlay chrome', () => {
  it('hides both transcript rails while an approval overlay is pending', () => {
    const css = readCss('02-transcript-messages-fx.css')

    const hideListFor = (rail: string): RegExp =>
      new RegExp(
        `html:has\\(:is\\([^)]*\\.composer-permission-card--overlay[^)]*\\)\\)\\s*${rail}\\s*\\{\\s*display:\\s*none\\s*!important`
      )
    expect(css).toMatch(hideListFor('\\.transcript-participant-filter-rail'))
    expect(css).toMatch(hideListFor('\\.transcript-user-gutter'))
  })

  it('derives the card chrome from the pinned participant accent', () => {
    const css = readCss('03-composer-welcome-activity.css')
    const start = css.indexOf('.composer-permission-card {')
    expect(start).toBeGreaterThanOrEqual(0)
    const block = css.slice(start, css.indexOf('}', start) + 1)

    expect(block).toContain('--approval-accent')
  })

  it('keeps the dead per-provider tint rules out', () => {
    const css = readCss('03-composer-welcome-activity.css')

    expect(css).not.toContain('.composer-permission-card.provider-codex')
    expect(css).not.toContain('.composer-permission-card.provider-claude')
    expect(css).not.toContain('.composer-permission-card.provider-kimi')
  })
})
