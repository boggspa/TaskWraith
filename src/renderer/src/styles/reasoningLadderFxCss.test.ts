import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/08-theme-picker-overrides.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const fxSection = (source: string): string => {
  const start = source.indexOf('/* Active FX use the exact fill height')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('.composer-combined-picker-apply-all', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('reasoning ladder FX CSS', () => {
  it('hard-gates every animated layer to the active fill below the thumb', () => {
    const css = readCss()
    const section = fxSection(css)

    expect(section).toContain('bottom: 0')
    expect(section).toContain('height: var(--ladder-fill-height, 0px)')
    expect(section).toMatch(/\.composer-combined-picker-ladder-pulse \{[\s\S]*?overflow: hidden/)
    expect(section).toMatch(/\.composer-combined-picker-ladder-sparkles \{[\s\S]*?overflow: hidden/)
    expect(css).toContain(
      ".composer-combined-picker-ladder-track[data-dragging='true'] .composer-combined-picker-ladder-sparkles"
    )
  })

  it('preserves slow motion, caps sparkles at 50%, and disables motion on request', () => {
    const section = fxSection(readCss())

    expect(section).toContain('tw-ladder-provider-pulse 3.6s ease-in-out infinite')
    expect(section).toContain('tw-ladder-shimmer 3.2s linear infinite')
    expect(section).toContain('tw-ladder-sparkle 3.6s ease-in-out infinite')
    expect(section).toMatch(/50% \{\s*opacity: 0\.5/)
    expect(section).toMatch(
      /\[data-reduce-motion='true'\] \.composer-combined-picker-ladder-pulse::before \{\s*animation: none/
    )
  })
})

describe('trigger chip reasoning tier CSS', () => {
  const tierRule = (css: string, value: string): string => {
    const selector = `.composer-combined-picker-trigger[data-selected-reasoning="${value}"]`
    const start = css.indexOf(selector)
    expect(start, `selector for ${value}`).toBeGreaterThanOrEqual(0)
    const open = css.indexOf('{', start)
    return css.slice(start, css.indexOf('}', open) + 1)
  }

  it('hues every sub-Max tier off the provider chip accent, ramping upward', () => {
    const css = readCss()
    // Low (+ Kimi thinking-on + Codex light alias) — the subtlest mix.
    const low = tierRule(css, 'low')
    expect(low).toContain('data-selected-reasoning="light"')
    expect(low).toContain('data-selected-reasoning="on"')
    expect(low).toContain('var(--chip-accent, #8e6fd8) 38%')
    // Medium — slightly stronger.
    expect(tierRule(css, 'medium')).toContain('var(--chip-accent, #8e6fd8) 62%')
    // High — full hue, no effects.
    const high = tierRule(css, 'high')
    expect(high).toContain('var(--chip-accent, #8e6fd8) 84%')
    expect(high).not.toContain('animation')
  })

  it('gives Extra (xhigh) a slower, lower-contrast shimmer than Max/Ultra', () => {
    const css = readCss()
    const xhigh = css.slice(
      css.indexOf('.composer-combined-picker-trigger[data-selected-reasoning="xhigh"]'),
      css.indexOf(
        '[data-reduce-motion="true"]\n  .composer-combined-picker-trigger[data-selected-reasoning="xhigh"]'
      )
    )
    // Slower cadence than the 3.2s Max/Ultra sweep; softer highlight than its
    // 55%+white midpoint.
    expect(xhigh).toContain('text-shimmer-sweep 4.6s linear infinite')
    expect(xhigh).toContain('var(--chip-accent, #8e6fd8) 78%, #ffffff')
    // Faint sparkle field: dimmer container, smaller dots.
    expect(css).toMatch(/\.composer-combined-picker-trigger-sparkles\.is-faint \{\s*opacity: 0\.4/)
    // Muse wire `ultra` must shimmer with Codex/Claude `ultracode`.
    const topTier = css.slice(
      css.indexOf('.composer-combined-picker-trigger[data-selected-reasoning="ultracode"]'),
      css.indexOf(
        '[data-reduce-motion="true"]\n  .composer-combined-picker-trigger[data-selected-reasoning="ultracode"]'
      )
    )
    expect(topTier).toContain('data-selected-reasoning="ultra"')
    expect(topTier).toContain('text-shimmer-sweep 3.2s linear infinite')
  })

  it('gives epic-FX shells (obsidian/alabaster) a static hue instead of a stranded transparent fill', () => {
    const css = readCss()
    // Those shells kill background-image !important; the shimmer tiers must
    // fall back to an opaque provider-hue fill there or the label vanishes.
    const start = css.indexOf(
      ':is([data-composer-style="obsidian"], [data-composer-style="alabaster"])'
    )
    expect(start).toBeGreaterThanOrEqual(0)
    const block = css.slice(start, css.indexOf('}', css.indexOf('{', start)) + 1)
    expect(block).toContain('data-selected-reasoning="xhigh"')
    expect(block).toContain('data-selected-reasoning="max"')
    expect(block).toContain('data-selected-reasoning="ultracode"')
    expect(block).toContain('data-selected-reasoning="ultra"')
    expect(block).toContain('animation: none !important')
    expect(block).toMatch(/-webkit-text-fill-color: color-mix\([\s\S]*?\) !important/)
  })

  it('climbs the hued tiers toward the top mix on light themes, rather than into ink', () => {
    const css = readCss()
    const lightPrefix = ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"])'
    for (const tier of ['low', 'medium', 'high', 'xhigh']) {
      const selector = `${lightPrefix}\n  .composer-combined-picker-trigger[data-selected-reasoning="${tier}"]`
      expect(css, `light override for ${tier}`).toContain(selector)
    }
    const lightStart = css.indexOf('/* Light themes — this block only has to TAPER')
    expect(lightStart).toBeGreaterThanOrEqual(0)
    const lightBlock = css.slice(lightStart, lightStart + 4200)
    // The accent share RISES with the tier. It used to fall away to 14/20/26/28%,
    // which measured in the running app as chroma 30/29/38 against a plain label
    // ink of chroma 9 — no visible ladder at all, while Max kept the full hue.
    const shareFor = (tier: string): number => {
      const at = lightBlock.indexOf(`[data-selected-reasoning="${tier}"]`)
      expect(at, `light ${tier} rule`).toBeGreaterThanOrEqual(0)
      const rule = lightBlock.slice(at, lightBlock.indexOf('}', at))
      const share = rule.match(/var\(--chip-accent, #8e6fd8\) (\d+)%/)
      expect(share, `accent share for ${tier}`).not.toBeNull()
      return Number(share?.[1])
    }
    const ladder = ['low', 'medium', 'high', 'xhigh'].map(shareFor)
    expect(ladder, 'light tiers must climb').toEqual([...ladder].sort((a, b) => a - b))
    expect(new Set(ladder).size, 'no two light tiers share a mix').toBe(ladder.length)
    // Ink-led at the bottom so the rise reads as a rise, but never a bare cast.
    expect(Math.min(...ladder)).toBeGreaterThanOrEqual(40)
    expect(Math.max(...ladder)).toBeLessThan(100)
    // The hotspot still mixes toward theme ink, never toward paper.
    expect(lightBlock).not.toContain('#ffffff')
  })

  it('gives the alabaster gemini/kimi ink override back the ladder it erases', () => {
    const shard10 = readFileSync(
      join(process.cwd(), 'src/renderer/src/assets/css/10-provider-shell-overrides.css'),
      'utf8'
    ).replace(/\r\n/g, '\n')
    const guard =
      '[data-theme="alabaster"]:is([data-composer-style="gemini"], [data-composer-style="kimi"])'
    // That shell pair flattens the chip's text runs with an !important
    // -webkit-text-fill-color, which is the one rule in the tree that outranks
    // the ladder's own fill. Extra High and up survive it only because they
    // paint through background-image.
    const flatten = shard10.indexOf(`${guard}\n  :is(\n    .composer-combined-picker-trigger,`)
    expect(flatten, 'alabaster gemini/kimi ink override').toBeGreaterThanOrEqual(0)
    expect(shard10.slice(flatten, flatten + 700)).toContain(
      '-webkit-text-fill-color: rgba(18, 21, 27, 0.74) !important;'
    )
    const restore = shard10.slice(flatten + 700)
    for (const [tier, share] of [
      ['low', 42],
      ['light', 42],
      ['on', 42],
      ['medium', 64],
      ['high', 82]
    ] as const) {
      const at = restore.indexOf(
        `${guard}\n  .composer-combined-picker-trigger[data-selected-reasoning="${tier}"]`
      )
      expect(at, `restored ladder for ${tier}`).toBeGreaterThanOrEqual(0)
      const rule = restore.slice(at, restore.indexOf('\n}', at))
      expect(rule, `${tier} keeps the light-family mix`).toContain(
        `var(--chip-accent, #8e6fd8) ${share}%`
      )
      // The flatten sets BOTH `color` and `-webkit-text-fill-color` with
      // !important, so the restore has to answer on both or the glyphs stay ink.
      expect(rule, `${tier} must beat the !important flatten`).toContain(
        `var(--chip-accent, #8e6fd8) ${share}%, var(--text-primary) ${100 - share}%) !important;`
      )
      expect(rule).toContain('-webkit-text-fill-color: color-mix(')
      expect(
        (rule.match(/!important/g) ?? []).length,
        `${tier} needs !important on both fills`
      ).toBe(2)
    }
  })

  it('keeps Off plain and stills the Extra shimmer under reduce-motion', () => {
    const css = readCss()
    // No rule targets an "off" or empty reasoning value on the trigger chip.
    expect(css).not.toContain('[data-selected-reasoning="off"]')
    expect(css).not.toContain('[data-selected-reasoning=""]')
    // Reduce-motion freezes the xhigh sweep to a static hue.
    const reduced = css.slice(
      css.indexOf(
        '[data-reduce-motion="true"]\n  .composer-combined-picker-trigger[data-selected-reasoning="xhigh"]'
      )
    )
    expect(reduced).toContain('animation: none')
  })
})
