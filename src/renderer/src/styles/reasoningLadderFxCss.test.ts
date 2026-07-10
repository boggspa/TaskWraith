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
    expect(block).toContain('animation: none !important')
    expect(block).toMatch(/-webkit-text-fill-color: color-mix\([\s\S]*?\) !important/)
  })

  it('re-mixes every hued tier toward theme ink on light themes (WCAG contrast)', () => {
    const css = readCss()
    const lightPrefix = ':is([data-theme="light"], [data-theme="mist"], [data-theme="sage"])'
    for (const tier of ['low', 'medium', 'high', 'xhigh']) {
      const selector = `${lightPrefix}\n  .composer-combined-picker-trigger[data-selected-reasoning="${tier}"]`
      expect(css, `light override for ${tier}`).toContain(selector)
    }
    // Light mixes are ink-dominant: the accent share stays well under 50%.
    const lightStart = css.indexOf('/* Light themes — bright brand hues')
    expect(lightStart).toBeGreaterThanOrEqual(0)
    const lightBlock = css.slice(lightStart, lightStart + 4200)
    expect(lightBlock).toContain('var(--chip-accent, #8e6fd8) 26%, var(--text-primary) 74%')
    expect(lightBlock).not.toContain('#ffffff')
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
