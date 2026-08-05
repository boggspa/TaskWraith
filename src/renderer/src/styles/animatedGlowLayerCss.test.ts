import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A `filter` re-runs whenever the filtered element's own paint output changes.
 * On a shimmering label the paint output changes EVERY FRAME by construction —
 * that is what the shimmer is — so a `drop-shadow` sharing the element costs a
 * full filter pass per element, per frame, with no amortisation across
 * instances. Measured on this 3840x2160 window (2026-08-05): 120 shimmering
 * labels carrying their own drop-shadow held 16.6fps with 55 dropped frames;
 * the same 120 with the glow split onto a contained layer held 30fps with
 * none. Composited effects (transform/opacity) stayed flat to n=200 either
 * way — the split is paint-bound vs compositable, not "how many animations".
 *
 * The fix is NOT to delete the glow. Splitting it onto `::before` while the
 * sweep runs on `::after` keeps the identical visual and costs nothing,
 * because the glow layer's own paint never invalidates.
 *
 * Two things here are load-bearing and both were established by measurement,
 * not by reading:
 *
 *   `contain: paint` — a glow layer WITHOUT it measured identically to
 *   shipping the filter on the animating element (25fps / 20 dropped at n=80).
 *   The pseudo-element structure alone buys nothing; the promotion is the win.
 *
 *   the sweep on `::after`, not on the label — CSS paints an element's own
 *   background at step 1 and its positioned children at step 6, so a `::before`
 *   glow over a `background-clip: text` shimmer HIDES the shimmer. Both layers
 *   must be pseudo-elements so DOM order settles which is in front.
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

describe('shimmering working label keeps its glow on a contained layer', () => {
  it('leaves the label element itself with nothing to repaint', () => {
    const body = ruleBodyFor(transcriptCss(), '.message-working-label')

    expect(body).not.toContain('filter:')
    expect(body).not.toContain('animation:')
  })

  it('carries the drop-shadow glow on a layer contained out of the sweep', () => {
    const body = ruleBodyFor(transcriptCss(), '.message-working-label::before')

    expect(body).toContain('drop-shadow')
    expect(body).toContain('contain: paint')
    // The label sets -webkit-text-fill-color: transparent so the sweep can use
    // background-clip; the glow layer inherits that and renders NOTHING unless
    // it opts back out.
    expect(body).toContain('-webkit-text-fill-color: currentColor')
    expect(body).toContain('content: attr(data-label)')
  })

  it('runs the sweep on the front layer, unfiltered', () => {
    const body = ruleBodyFor(transcriptCss(), '.message-working-label::after')

    expect(body).toContain('animation: text-shimmer-sweep')
    expect(body).toContain('background-clip: text')
    expect(body).toContain('content: attr(data-label)')
    expect(body).not.toContain('filter:')
  })

  it('still collapses to a solid, motionless label under reduce-motion', () => {
    const css = transcriptCss()
    const start = css.indexOf(`[data-reduce-motion='true'] .message-working-label`)
    expect(start).toBeGreaterThanOrEqual(0)
    const section = css.slice(start, start + 700)

    // Both layers are decoration; reduce-motion drops them and lets the real
    // DOM text show through, so the label survives turning motion off.
    expect(section).toContain(`[data-reduce-motion='true'] .message-working-label::before`)
    expect(section).toContain(`[data-reduce-motion='true'] .message-working-label::after`)
    expect(section).toContain('content: none')
  })

  it('supplies the glyphs the two layers echo', () => {
    const tsx = readCss('src/renderer/src/components/AppChromeSymbols.tsx')
    const at = tsx.indexOf('className="message-working-label"')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(tsx.slice(at, at + 160)).toContain('data-label={label}')
  })
})
