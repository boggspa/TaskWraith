import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The "Working" row renders two ways from one component: a <button> when the
 * seat has a fan-out lane to jump to, a <div> otherwise. Both carry
 * `message-bubble assistant message-working`, so both are meant to read
 * identically — only the affordance differs.
 *
 * `.message-working-jump` exists to undo the UA button styling those shared
 * rules assume away, and it used to do that with `font: inherit`. That is a
 * SHORTHAND: it sets font-family, font-size, line-height, font-weight,
 * font-style, font-variant and font-stretch in one go. `.message-bubble`
 * deliberately declares the first three — including the user-configurable
 * `--transcript-font-family` — and both rules are single-class, so they tie on
 * specificity and SOURCE ORDER decides. `.message-working-jump` is ~370 lines
 * later, so the shorthand won and the button rendered "Working" in the ambient
 * UI font at the ambient size and line-height, while the div next to it used
 * the transcript font at `--font-size-md`/1.55.
 *
 * It also moved the shimmer: `.message-working-label::after` clips a 105deg
 * gradient to the text, so changing the glyph metrics and the box height
 * changes the sweep across it. Same cause, and the reason this reads as "the
 * shimmer looks slightly different" rather than "the font is wrong".
 *
 * The shorthand was never needed for those three. AUTHOR RULES BEAT UA RULES
 * REGARDLESS OF ORDER, so `.message-bubble` already neutralised the UA button
 * font — `font: inherit` only ever won against its own stylesheet.
 *
 * This is invisible until someone picks a transcript font that differs from the
 * UI font, which is why it wants a guard rather than an eye.
 */
const readCss = (relative: string): string =>
  readFileSync(join(process.cwd(), relative), 'utf8').replace(/\r\n/g, '\n')

const ruleBodyFor = (source: string, selector: string): string => {
  const start = source.indexOf(`\n${selector} {`)
  expect(start, `Missing CSS rule: ${selector}`).toBeGreaterThanOrEqual(0)
  const open = source.indexOf('{', start)
  const close = source.indexOf('}', open)
  expect(close, `Unterminated CSS rule: ${selector}`).toBeGreaterThan(open)
  return source.slice(open + 1, close)
}

const transcriptCss = (): string =>
  readCss('src/renderer/src/assets/css/02-transcript-messages-fx.css')

describe('both working-bubble variants share one typography', () => {
  it('states the bubble typography the jump variant must not override', () => {
    const body = ruleBodyFor(transcriptCss(), '.message-bubble')

    // Guarding the absence below is meaningless if the thing being protected
    // quietly moves elsewhere, so pin it here too.
    expect(body).toContain('font-family: var(--transcript-font-family)')
    expect(body).toContain('font-size:')
    expect(body).toContain('line-height:')
  })

  it('resets the UA button font without taking the bubble typography with it', () => {
    const body = ruleBodyFor(transcriptCss(), '.message-working-jump')

    // The shorthand. `font: inherit` / `font: 400 13px x` etc all reset
    // family + size + line-height, which `.message-bubble` owns.
    expect(body).not.toMatch(/(^|[;\s])font:/)
    // The same three as longhands — a shorthand ban is trivially sidestepped.
    expect(body).not.toContain('font-family:')
    expect(body).not.toContain('font-size:')
    expect(body).not.toContain('line-height:')
  })

  it('keeps the two variants on one shimmer by leaving the label metrics alone', () => {
    const body = ruleBodyFor(transcriptCss(), '.message-working-jump')

    // The sweep is clipped to the label's own text box, so anything here that
    // changes glyph metrics or tracking desynchronises the two variants'
    // shimmer even when the typeface matches.
    expect(body).not.toContain('letter-spacing:')
    expect(body).not.toContain('font-stretch:')
    expect(body).not.toContain('font-variant:')
  })
})
