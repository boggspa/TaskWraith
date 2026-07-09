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

  it('keeps the outline black in every theme and surface', () => {
    const glyphCss = readRepoFile('src/renderer/src/assets/css/02-transcript-messages-fx.css')
    const theme = readRepoFile('src/renderer/src/styles/theme.css')
    const themePicker = readRepoFile(
      'src/renderer/src/assets/css/08-theme-picker-overrides.css'
    )
    const providerShells = readRepoFile(
      'src/renderer/src/assets/css/10-provider-shell-overrides.css'
    )

    expect(glyphCss.match(/(?:fill|stroke): #000000/g)?.length).toBeGreaterThanOrEqual(5)
    for (const css of [glyphCss, theme, themePicker, providerShells]) {
      expect(css).not.toContain('--provider-glyph-contrast-color')
    }
  })
})
