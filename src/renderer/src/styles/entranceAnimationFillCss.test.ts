import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Entrance animations must not depend on ever having STARTED.
 *
 * THE HAZARD (the class e4c260c20 fixed for the fan-out lane reveal): an
 * entrance animation declared with `both` (or `backwards`) fill applies its 0%
 * keyframe during the animation's BEFORE phase — the phase it sits in until
 * the document produces a frame to start it on. An occluded or unfocused
 * window produces no frames, so an element whose 0% frame is invisible
 * (opacity 0 / height 0) rests invisible until refocus. The window-idle-pause
 * exemption list only keeps PAUSED animations running; nothing can resume an
 * animation that never started.
 *
 * Dropping the fill is safe exactly when the element's STATIC resting style
 * equals the animation's 100% frame — then the before phase simply shows the
 * end state, and reduce-motion (`animation: none`) degrades to the same
 * pixels. The per-instance blocks below pin that equality, so a future edit
 * to either end has to argue with a test rather than silently reopening the
 * gap between them.
 */
const readCss = (name: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', name), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

/** Comments repeat rule text; drop them before matching. */
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

const PICKER_CSS = '08-theme-picker-overrides.css'

describe('entrance-animation fill hazard (08-theme-picker-overrides.css)', () => {
  it('declares no animation with a backwards-reaching fill anywhere in the file', () => {
    // File-wide ratchet: zero `both`/`backwards` fills exist today, and none
    // may return. `forwards` stays legal — holding an end state never hides
    // an element that failed to start. Covers the shorthand and the longhand.
    const offenders = rulesOf(readCss(PICKER_CSS)).filter(
      (rule) =>
        /animation[^;]*\b(both|backwards)\b/.test(rule.body) ||
        /animation-fill-mode\s*:\s*[^;]*\b(both|backwards)\b/.test(rule.body)
    )
    expect(
      offenders.map((rule) => rule.selector),
      'entrance animations must rest on static styles, not on backwards fill — see e4c260c20'
    ).toEqual([])
  })

  it('rests the ladder FX on the static opacity their emergence animates to', () => {
    const rules = rulesOf(readCss(PICKER_CSS))

    // The emergence rule: still present (the ratchet above must not be
    // satisfiable by deleting the animation outright), fill-free, and resting
    // on the same var-driven opacity its `to` frame lands on.
    const emergence = rules.find(
      (rule) =>
        rule.selector.includes('.composer-combined-picker-ladder-pulse') &&
        rule.body.includes('tw-ladder-emerge')
    )
    expect(emergence, 'ladder emergence animation rule went missing').toBeTruthy()
    expect(emergence?.body).toMatch(/animation:[^;]*tw-ladder-emerge/)
    expect(emergence?.body).not.toMatch(/animation:[^;]*\b(both|backwards)\b/)
    expect(emergence?.body).toContain('opacity: var(--ladder-fx-strength, 0)')

    // The equality that makes the missing fill safe: the keyframes' end frame
    // IS the static opacity above.
    const keyframes = stripComments(readCss(PICKER_CSS)).match(
      /@keyframes tw-ladder-emerge\s*\{([\s\S]*?\})\s*\}/
    )
    expect(keyframes, '@keyframes tw-ladder-emerge went missing').toBeTruthy()
    expect(normalize(keyframes?.[1] ?? '')).toContain(
      'to { opacity: var(--ladder-fx-strength, 0); }'
    )
  })

  it('rests the seat-change hop on the row natural state its 100% frame lands on', () => {
    const css = readCss(PICKER_CSS)
    const rules = rulesOf(css)

    const hop = rules.find(
      (rule) =>
        rule.selector === '.seat-change-message.is-fresh .seat-change-row' &&
        rule.body.includes('seat-change-hop')
    )
    expect(hop, 'seat-change hop animation rule went missing').toBeTruthy()
    expect(hop?.body).not.toMatch(/animation:[^;]*\b(both|backwards)\b/)

    // 100% frame = opacity 1, translateY(0) — the identity the row already has
    // with no animation at all …
    const keyframes = stripComments(css).match(/@keyframes seat-change-hop\s*\{([\s\S]*?\})\s*\}/)
    expect(keyframes, '@keyframes seat-change-hop went missing').toBeTruthy()
    const endFrame = normalize(keyframes?.[1] ?? '').match(/100%\s*\{([^}]*)\}/)
    expect(normalize(endFrame?.[1] ?? '')).toBe('opacity: 1; transform: translateY(0);')

    // … which stays true only while the base row declares neither opacity nor
    // transform. If one appears, the fill question must be re-derived.
    const base = rules.find((rule) => rule.selector === '.seat-change-row')
    expect(base, 'base .seat-change-row rule went missing').toBeTruthy()
    expect(base?.body).not.toMatch(/(^|[^-])opacity\s*:/)
    expect(base?.body).not.toMatch(/transform\s*:/)
  })
})
