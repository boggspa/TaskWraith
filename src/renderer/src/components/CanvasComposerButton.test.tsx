import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasComposerButton } from './CanvasComposerButton'

describe('CanvasComposerButton (static render)', () => {
  it('renders a bare hint-pill trigger consistent with the other footer icons', () => {
    const html = renderToStaticMarkup(<CanvasComposerButton />)
    expect(html).toContain('aria-label="Open Canvas"')
    // Same affordances as Multiview/Goal: bare trigger + hover hint pill.
    expect(html).toContain('composer-canvas-trigger')
    expect(html).toContain('composer-hint-pill')
    expect(html).toContain('data-hint-label="Canvas"')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    // No block wrapper "box", and the popover (CanvasPaneLauncher) is collapsed.
    expect(html).not.toContain('canvas-composer-button')
    expect(html).not.toContain('canvas-pane-launcher')
  })

  it('reflects the disabled prop on the trigger', () => {
    const html = renderToStaticMarkup(<CanvasComposerButton disabled />)
    expect(html).toContain('disabled')
  })

  it('opens Browser and Sketch as explicit dock presentations', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/CanvasComposerButton.tsx'),
      'utf8'
    )
    expect(source).toContain('window.api.canvas?.openEmbedded')
    expect(source).toContain('window.api.canvas?.openSketchEmbedded')
    expect(source).toContain('window.api.canvas?.openEmulatorEmbedded')
    expect(source.match(/presentation: 'dock'/g)).toHaveLength(3)
    expect(source).toContain('<CanvasPaneLauncher onOpen={() => void handleOpen()} />')
    expect(source).not.toContain('handleOpen(url)')
    expect(source).not.toContain('openWindow({')
    expect(source).not.toContain('openSketchWindow({')
  })
})
