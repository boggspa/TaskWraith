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
