import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(new URL(`../assets/css/${file}`, import.meta.url), 'utf8')

/**
 * Muse wiring (f865a6680) accidentally inserted a bare `.provider-muse,` into the
 * Mistral settings-comparison color rule. That selector paints *every* Muse-classed
 * element with `--provider-mistral-color` (#D44404) — heatmap filter tabs, and
 * via inheritance on `.app-transcript.provider-muse`, composer neutrals (+ / XXK).
 * Scoped `.settings-model-comparison-*.provider-muse` rules do not undo that leak.
 */
describe('muse provider accent does not leak mistral orange-red', () => {
  it('does not group a bare .provider-muse into the mistral comparison color rule', () => {
    const css = readCss('04-settings-controls.css')
    const start = css.indexOf('.settings-model-comparison-dot.provider-mistral')
    expect(start, 'mistral comparison-dot rule missing').toBeGreaterThanOrEqual(0)
    const brace = css.indexOf('{', start)
    expect(brace).toBeGreaterThan(start)
    const selectors = css.slice(start, brace)
    expect(selectors).toContain('provider-mistral')
    expect(selectors).not.toContain('provider-muse')
  })

  it('never assigns --provider-mistral-color via a bare .provider-muse selector', () => {
    const css = readCss('04-settings-controls.css')
    const offenders: string[] = []
    for (const match of css.matchAll(/([^{]+)\{([^}]*)\}/g)) {
      const selectors = match[1]
      const body = match[2]
      if (!body.includes('--provider-mistral-color')) continue
      const hasBareMuse = selectors.split(',').some((part) => /^\s*\.provider-muse\s*$/.test(part))
      if (hasBareMuse) offenders.push(selectors.replace(/\s+/g, ' ').trim())
    }
    expect(offenders, `bare .provider-muse mistral color rules: ${offenders.join(' | ')}`).toEqual(
      []
    )
  })

  it('keeps the scoped muse comparison color on --provider-muse-color', () => {
    const css = readCss('04-settings-controls.css')
    const start = css.indexOf('.settings-model-comparison-dot.provider-muse')
    expect(start, 'muse comparison-dot rule missing').toBeGreaterThanOrEqual(0)
    const end = css.indexOf('}', start)
    const block = css.slice(start, end + 1)
    expect(block).toContain('var(--provider-muse-color)')
    expect(block).not.toContain('--provider-mistral-color')
  })
})
