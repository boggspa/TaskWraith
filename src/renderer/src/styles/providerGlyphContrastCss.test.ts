import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readRepoFile = (relativePath: string): string =>
  readFileSync(join(process.cwd(), relativePath), 'utf8')

describe('provider glyph contrast CSS', () => {
  it('uses a one-unit contrast pass behind the provider foreground', () => {
    const css = readRepoFile('src/renderer/src/assets/css/02-transcript-messages-fx.css')

    expect(css).toContain('.provider-glyph-contrast-outline .provider-glyph-line')
    expect(css).toContain('stroke-width: 2.75')
    expect(css).toContain('.provider-glyph-contrast-outline .provider-glyph-accent')
    expect(css).toContain('stroke-width: 2.85')
  })

  it('switches between white dark-mode and black light-mode contrast tokens', () => {
    const theme = readRepoFile('src/renderer/src/styles/theme.css')

    expect(theme).toContain('--provider-glyph-contrast-color: #FFFFFF')
    expect(theme).toContain('[data-theme="light"]')
    expect(theme).toContain('--provider-glyph-contrast-color: #000000')
    expect(theme).toMatch(
      /@media \(prefers-color-scheme: light\)\s*{\s*:root\[data-theme="system"\][^{]*{[^}]*--provider-glyph-contrast-color: #000000/s
    )
  })

  it('tracks inverted composer surface polarity', () => {
    const themePicker = readRepoFile(
      'src/renderer/src/assets/css/08-theme-picker-overrides.css'
    )
    const providerShells = readRepoFile(
      'src/renderer/src/assets/css/10-provider-shell-overrides.css'
    )

    expect(themePicker).toContain('--provider-glyph-contrast-color: #FFFFFF')
    expect(themePicker).toContain('--provider-glyph-contrast-color: #000000')
    expect(providerShells).toContain('--provider-glyph-contrast-color: #FFFFFF')
    expect(providerShells).toContain('--provider-glyph-contrast-color: #000000')
  })
})
