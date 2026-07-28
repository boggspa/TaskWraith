import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (relativePath: string): string =>
  readFileSync(join(process.cwd(), relativePath), 'utf8').replace(/\r\n/g, '\n')

describe('composer above-row minimise control', () => {
  it('wires a direct telemetry control to an all-shell composer state class', () => {
    const composer = readSource('src/renderer/src/components/Composer.tsx')

    expect(composer).toContain('areComposerAboveRowsMinimized')
    expect(composer).toContain('composer-area--above-rows-minimized')
    expect(composer).toContain('<ComposerAboveRowsToggleButton')
    expect(composer).toContain('onToggle={setAreComposerAboveRowsMinimized}')
    expect(composer).toContain('(!hasComposerAboveRows || areComposerAboveRowsMinimized)')
  })

  it('collapses every above-row shape while preserving reduced-motion support', () => {
    const css = readSource('src/renderer/src/assets/css/17-composer-hint-pills.css')

    expect(css).toContain('.composer-above-rows-toggle-button {')
    expect(css).toContain('.composer-above-rows-toggle-button.is-active')
    expect(css).toContain('.composer-area--above-rows-minimized')
    expect(css).toContain('.composer-above-bar-stack')
    expect(css).toContain('.composer-above-bar--cursor-lead')
    expect(css).toContain('.composer-attachment-tray')
    expect(css).toContain('max-block-size: 0 !important')
    expect(css).toContain('visibility: hidden')
    expect(css).toContain('transform: translateY(12px) scaleY(0.94)')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('[data-reduce-motion')
  })
})
