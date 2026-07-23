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
    expect(composer).toContain('<GitSyncChip snapshot={primaryGitSnapshot} />')
    expect(secondary).toContain('<GitSyncChip snapshot={snapshot} />')
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

  it('collapses the empty Codex changes track without changing other shells', () => {
    const css = readSource('src/renderer/src/assets/css/10-provider-shell-overrides.css')
    const selector =
      ':is([data-composer-style="codex"], [data-composer-style="chatgpt"])\n  .composer-workspace-above-row.style-unified:not('
    const start = css.indexOf(selector)
    const end = css.indexOf('}', start)
    const block = css.slice(start, end + 1)

    expect(start).toBeGreaterThan(-1)
    expect(block).toContain(':has(> .composer-above-bar-pill--changes)')
    expect(block).toContain('grid-template-columns: minmax(0, max-content) max-content')
    expect(block).not.toContain('data-composer-style="grok"')
  })

  it('keeps detached Codex workspace rows compact without changing other shells', () => {
    const css = readSource('src/renderer/src/assets/css/10-provider-shell-overrides.css')
    const selector =
      ':is([data-composer-style="codex"], [data-composer-style="chatgpt"])\n  :is(.composer-area, .composer-primary-stack)\n  > .composer-workspace-above-row.style-unified.composer-above-bar--cursor-lead'
    const start = css.indexOf(selector)
    const end = css.indexOf('}', start)
    const block = css.slice(start, end + 1)

    expect(start).toBeGreaterThan(-1)
    expect(block).toContain('display: flex !important')
    expect(block).not.toContain('data-composer-style="grok"')
  })

  it('uses amber for behind-only branches and red for true divergence', () => {
    const base = readSource('src/renderer/src/assets/css/07-composer-shells.css')
    const shellOverrides = readSource('src/renderer/src/assets/css/10-provider-shell-overrides.css')

    expect(base).toContain('.git-status-behind {\n  color: #ffc248;')
    expect(base).toContain('.git-status-behind.git-status-diverged {\n  color: #ff6b7a;')
    expect(base).toContain('.git-status-behind.git-status-diverged {\n  color: #d23b4e;')
    expect(shellOverrides).toContain(
      '.git-status-behind.git-status-diverged {\n  color: #ff6b7a !important;'
    )
  })

  it('lets preview shells inherit live geometry instead of rebuilding it locally', () => {
    const css = readSource('src/renderer/src/assets/css/04-settings-controls.css')

    expect(css).toContain('.settings-composer-preview-chat.app-transcript {')
    expect(css).not.toContain(
      '.settings-composer-preview-card[data-composer-style="grok"]\n  .settings-composer-preview-area'
    )
    expect(css).not.toContain('.settings-composer-preview-area .composer-textarea {')
    expect(css).not.toContain(
      '.settings-composer-preview-card[data-composer-style="default"] .composer-inner-module {'
    )

    const controlsStart = css.indexOf('.settings-composer-preview-controls {')
    const controlsEnd = css.indexOf('}', controlsStart)
    expect(css.slice(controlsStart, controlsEnd + 1)).toContain('align-items: start')
  })
})
