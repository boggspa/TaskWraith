import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The working fan-out lane reserves its collapsed band up front so the card
 * stops ratcheting open on every streamed delta (see the block comment in
 * 02-transcript-messages-fx.css).
 *
 * THE HAZARD THIS FILE GUARDS. A fan-out lane nests a SECOND
 * `LiveActivityViewport` inside the first — `EnsembleFanoutResultCard` renders
 * the lane viewport (331px), and its tools part renders
 * `.ensemble-fanout-tools-viewport` (184px) within it. Both emit the same
 * `.live-activity-viewport-scroll` class, and both publish their own
 * `--live-activity-collapsed-height`. So a DESCENDANT combinator in the
 * reservation rule matches the inner scroll container too, and pins a
 * single-row tool block to a fixed 184px box.
 *
 * Measured in Chromium with one 28px tool row:
 *   descendant combinator → tools box 184px, 156px of dead space
 *   child combinator      → tools box  28px,   0px of dead space
 * The lane band stays 331px either way — only the leak goes.
 *
 * The reservation must therefore only ever apply to the lane viewport's OWN
 * direct child.
 */
const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/02-transcript-messages-fx.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

/** Comments carry the same class names as the rules; drop them before matching. */
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Every selector in the sheet that reserves a height on a fan-out lane's
 * collapsed viewport — the base rule plus both reduce-motion overrides.
 */
const reservationSelectors = (css: string): string[] => {
  const matches = [
    ...stripComments(css).matchAll(
      /([^{}]*\.ensemble-fanout-result-viewport\.is-collapsed[^{}]*\.live-activity-viewport-scroll\s*)\{/g
    )
  ]
  return matches.map((match) => match[1].replace(/\s+/g, ' ').trim())
}

describe('fan-out lane viewport reservation', () => {
  it('is scoped to the lane viewport, never a nested tool viewport', () => {
    const selectors = reservationSelectors(readCss())
    // Base rule + prefers-reduced-motion + [data-reduce-motion]. If this count
    // changes, a new reservation site was added and must be scoped too.
    expect(
      selectors.length,
      `reservation selectors:\n${selectors.join('\n')}`
    ).toBeGreaterThanOrEqual(3)
    for (const selector of selectors) {
      expect(
        selector,
        `"${selector}" uses a descendant combinator, so it also matches the NESTED ` +
          '.ensemble-fanout-tools-viewport scroll container and pins a short tool ' +
          'block to a fixed 184px box. Use "> .live-activity-viewport-scroll".'
      ).toContain('> .live-activity-viewport-scroll')
    }
  })

  it('still reserves the lane band from the component-published height', () => {
    const css = readCss()
    const start = css.indexOf('.ensemble-fanout-result-card.is-working')
    expect(start, 'the reservation block').toBeGreaterThanOrEqual(0)
    const block = css.slice(start, css.indexOf('}', start))
    // The number belongs to the component (COLLAPSED_FANOUT_RESULT_VIEWPORT_HEIGHT
    // publishes it); a literal px here would drift from the cap it must match.
    expect(block).toContain('height: var(--live-activity-collapsed-height)')
    expect(block).not.toMatch(/height:\s*\d+px/)
  })

  it('keeps the nested tool viewport free to size to its content', () => {
    const css = stripComments(readCss())
    // Nothing may pin a height on the tools viewport: it lives inside the band
    // the lane already reserved, so a second reservation only adds dead space.
    const toolsRules = [
      ...css.matchAll(/([^{}]*\.ensemble-fanout-tools-viewport[^{}]*)\{([^}]*)\}/g)
    ]
    for (const [, selector, body] of toolsRules) {
      expect(
        body,
        `"${selector.replace(/\s+/g, ' ').trim()}" pins a height on the nested tool viewport`
      ).not.toMatch(/(^|[^-])\bheight:/)
    }
  })
})
