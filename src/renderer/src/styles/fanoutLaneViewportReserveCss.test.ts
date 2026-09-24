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

const normalize = (value: string): string => value.replace(/\s+/g, ' ').trim()

interface CssRule {
  selector: string
  body: string
}

/** Innermost declaration blocks only — `[^{}]+` steps over @media wrappers. */
const rulesOf = (css: string): CssRule[] =>
  [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: normalize(match[1]),
    body: normalize(match[2])
  }))

/** The lane reservation rule: the band, with no reveal marker on the selector. */
const reservationRule = (css: string): CssRule | undefined =>
  rulesOf(css).find(
    (rule) =>
      rule.selector.includes('.ensemble-fanout-result-viewport.is-collapsed') &&
      rule.selector.includes('> .live-activity-viewport-scroll') &&
      !rule.selector.includes('.is-revealing')
  )

/** Every rule that actually declares the reveal animation. */
const revealRules = (css: string): CssRule[] =>
  rulesOf(css).filter((rule) => /animation:[^;]*fanout-lane-viewport-reveal/.test(rule.body))

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

  /**
   * THE BAND MUST NOT BE PRODUCED BY THE ANIMATION.
   *
   * While the reveal and the reservation shared one rule, the lane's height
   * came from `animation: … both`: `both` includes `backwards`, so the 0%
   * keyframe (`height: 0`) is what the element uses for the animation's BEFORE
   * phase — the phase an animation sits in until the document produces its
   * first frame. An occluded or unfocused window produces none, so the lane
   * stayed at height 0 and the card read as empty until the window was
   * refocused. The idle-pause exemption patches the PAUSED case only; it cannot
   * reach an animation that never started.
   *
   * Splitting them means the band is a plain declaration that is always in
   * effect, and the reveal is decoration layered on top. Whatever stops the
   * animation — idle pause, an occluded window, reduce-motion, a browser that
   * never runs it — now costs the flourish and never the content.
   */
  it('reserves the band with a plain declaration, never from an animation', () => {
    const rule = reservationRule(readCss())
    expect(rule, 'the lane reservation rule').toBeDefined()
    expect(rule!.body).toContain('height: var(--live-activity-collapsed-height)')
    expect(
      rule!.body,
      'the reservation rule also carries the reveal, so the band is only as ' +
        'visible as the animation is running. Move the animation to its own rule.'
    ).not.toContain('animation:')
  })

  it('never lets the reveal fill backwards over the reserved band', () => {
    const rules = revealRules(readCss())
    expect(rules.length, 'rules declaring the reveal animation').toBeGreaterThan(0)
    for (const rule of rules) {
      const shorthand = /animation:([^;]*)/.exec(rule.body)?.[1] ?? ''
      expect(
        shorthand,
        `"${rule.selector}" fills the reveal backwards, so the animation's before ` +
          'phase applies its `height: 0` keyframe and hides the reserved band ' +
          'until the document animates again.'
      ).not.toMatch(/(?<![\w-])(both|backwards)(?![\w-])/)
    }
  })

  /**
   * A CSS animation restarts every time its rule STARTS matching, so binding the
   * reveal to durable state replays it. `.is-working` is supplied per render
   * from the working-indicator presentation and `.is-collapsed` flips on every
   * expand/collapse, and the row itself remounts whenever its index-embedded
   * rowKey churns — which a fan-out wave does the moment its second lane lands.
   * The reveal must therefore hang off a marker that is raised once per lane and
   * retired when the animation ends.
   */
  /**
   * Reduce-motion drops the flourish and keeps the band. That used to be
   * automatic, because one rule carried both and the override only named
   * `animation`. Now that they are separate rules an override aimed one
   * compound too wide would cancel the reservation itself and leave the lane
   * collapsing back to its content height on every streamed delta — the exact
   * ratchet the reservation exists to stop, visible only to the users who asked
   * for less motion.
   */
  it('lets both reduce-motion signals cancel the reveal but never the band', () => {
    const css = readCss()
    const cancels = rulesOf(css).filter(
      (rule) =>
        /animation:\s*none/.test(rule.body) &&
        rule.selector.includes('.ensemble-fanout-result-viewport.is-collapsed')
    )
    // prefers-reduced-motion + :root[data-reduce-motion].
    expect(cancels.map((rule) => rule.selector)).toHaveLength(2)
    for (const rule of cancels) {
      expect(
        rule.selector,
        `"${rule.selector}" cancels the animation on the RESERVATION rule, so ` +
          'reduce-motion also gives up the reserved band. Aim it at .is-revealing.'
      ).toContain('.is-collapsed.is-revealing')
    }
    expect(reservationRule(css)!.body).not.toMatch(/animation:\s*none/)
  })

  it('arms the reveal from a one-shot marker, not from durable lane state', () => {
    for (const rule of revealRules(readCss())) {
      expect(
        rule.selector,
        `"${rule.selector}" replays whenever .is-working or .is-collapsed is ` +
          're-applied, and on every remount. Gate it on .is-revealing.'
      ).toContain('.is-collapsed.is-revealing')
    }
  })
})
