import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (relativePath: string): string =>
  readFileSync(join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n')

describe('workspace above-row parity', () => {
  it('keeps primary and secondary workspace rows on the shared class contract', () => {
    const composer = readSource('src/renderer/src/components/Composer.tsx')
    const secondary = readSource('src/renderer/src/components/ExternalPathAboveRow.tsx')
    const preview = readSource('src/renderer/src/components/ComposerShellPreview.tsx')

    expect(composer).toContain('style-unified composer-workspace-above-row')
    expect(secondary).toContain('style-unified composer-workspace-above-row')
    expect(preview).toContain('style-unified composer-workspace-above-row')
    expect(secondary).not.toContain('composer-above-bar-center-cluster')
    expect(secondary).not.toContain('composer-above-bar-trailing-cluster')
  })

  it('does not reintroduce secondary-only type or action geometry', () => {
    const css = readSource('src/renderer/src/assets/css/08-theme-picker-overrides.css')
    const secondaryStart = css.indexOf('.composer-above-bar-secondary {')
    const secondaryEnd = css.indexOf('}', secondaryStart)
    const secondaryBlock = css.slice(secondaryStart, secondaryEnd + 1)

    expect(secondaryStart).toBeGreaterThan(-1)
    expect(secondaryBlock).toContain('opacity: 1')
    expect(secondaryBlock).toContain('font-size: calc(var(--font-size-xs) + 1px)')
    expect(secondaryBlock).not.toContain('min-height:')
    expect(css).not.toContain('.composer-above-bar-secondary .composer-above-bar-action {')
  })

  it('applies the Codex and Grok three-zone grid by shared row class', () => {
    const css = readSource('src/renderer/src/assets/css/10-provider-shell-overrides.css')

    expect(css).toContain('.composer-workspace-above-row.style-unified {')
    expect(css).toContain(
      '.composer-workspace-above-row.style-unified\n  > .composer-above-bar-pill--changes {'
    )
    expect(css).not.toContain('composer-above-bar-center-cluster')
    expect(css).not.toContain('composer-above-bar-trailing-cluster')
  })
})
