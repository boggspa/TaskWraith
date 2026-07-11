import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readCss = (file: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/assets/css', file), 'utf8').replace(
    /\r\n/g,
    '\n'
  )

const readSkyRevealCss = (): string => {
  const css = readCss('08-theme-picker-overrides.css')
  const marker = '/* Light-mode sky reveal — only paint the top sky band'
  const start = css.indexOf(marker)
  expect(start, 'Missing light-mode sky reveal contract').toBeGreaterThanOrEqual(0)
  return css.slice(start)
}

describe('light transcript sky reveal', () => {
  it('only paints the blue reveal when that transcript mounts a sky layer', () => {
    const css = readSkyRevealCss()

    expect(css).toContain(':root[data-fx-enabled="true"]:is(')
    expect(css).toContain('.app-transcript:has(> .sky-visual-fx) {')
    expect(css).toContain('.app-transcript.welcome-mode:has(> .sky-visual-fx) {')
    expect(css).not.toContain('\n  .app-transcript {')
    expect(css).not.toContain('\n  .app-transcript.welcome-mode {')
  })

  it('keys native-glass and pane-opacity fallbacks to each pane’s actual sky layer', () => {
    const nativeGlassCss = readCss('09-ensemble-work-session.css')
    const providerOverridesCss = readCss('10-provider-shell-overrides.css')

    expect(nativeGlassCss).toContain('.app-transcript:not(:has(> .sky-visual-fx)),')
    expect(nativeGlassCss).not.toContain(':not([data-fx-enabled="true"]) .app-transcript,')
    expect(providerOverridesCss).toContain(
      ':root[data-main-pane-opacity-override="true"] .app-transcript:not(:has(> .sky-visual-fx)),'
    )
    expect(providerOverridesCss).not.toContain(
      ':root[data-main-pane-opacity-override="true"]:not([data-fx-enabled="true"]) .app-transcript,'
    )
  })
})
