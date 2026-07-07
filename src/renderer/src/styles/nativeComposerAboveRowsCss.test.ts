import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readProviderOverridesCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/10-provider-shell-overrides.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const readComposerCss = (): string =>
  readFileSync(
    join(process.cwd(), 'src/renderer/src/assets/css/03-composer-welcome-activity.css'),
    'utf8'
  ).replace(/\r\n/g, '\n')

const cssBlockStartingAt = (source: string, selector: string): string => {
  const start = source.indexOf(selector)
  expect(start, `Missing selector: ${selector}`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end, `Missing block end for selector: ${selector}`).toBeGreaterThan(start)
  return source.slice(start, end + 1)
}

describe('native composer above-row CSS', () => {
  it('keeps the stack refraction scoped to non-empty native composer rows', () => {
    const css = readProviderOverridesCss()
    const nativeReset = css.indexOf('Native default merged instrument')
    const lensSelector = '> .composer-above-bar-stack:not(:empty)::before {'
    const lensSelectorIndex = css.indexOf(lensSelector)

    expect(nativeReset).toBeGreaterThanOrEqual(0)
    expect(lensSelectorIndex).toBeGreaterThan(nativeReset)
    expect(css).toContain(':root[data-advanced-fx-refraction="true"][data-composer-style="default"]')
    expect(css).toContain('.composer-above-bar-stack:empty {')

    const lensBlock = cssBlockStartingAt(css, lensSelector)
    expect(lensBlock).toContain('pointer-events: none')
    expect(lensBlock).toContain('var(--tw-glass-sheen')
    expect(lensBlock).toContain('var(--tw-glass-rim-light')
    expect(lensBlock).toContain('contain: layout paint')
  })

  it('reasserts direct-child dividers after late native row resets', () => {
    const css = readProviderOverridesCss()
    const dividerBlock = cssBlockStartingAt(
      css,
      '> .composer-above-bar-stack:not(:empty)\n  > * + * {'
    )

    expect(dividerBlock).toContain('border-top: 1px solid')
    expect(dividerBlock).toContain('var(--native-instrument-row-divider)')
    expect(dividerBlock).toContain('box-shadow: inset 0 1px 0')
    expect(dividerBlock).toContain('!important')
  })

  it('gives native no-above-row composers a visible top glass cushion', () => {
    const css = readComposerCss()
    const block = cssBlockStartingAt(
      css,
      '.composer-surface.composer-surface--native-no-above-rows {'
    )

    expect(css).toContain('[data-composer-style="default"]\n  .app-transcript\n  .composer-surface.composer-surface--native-no-above-rows {')
    expect(block).toContain('padding-top: 30px')
    expect(block).toContain('gap: var(--space-sm)')
  })
})
