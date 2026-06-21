import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasComposerButton } from './CanvasComposerButton'

describe('CanvasComposerButton (static render)', () => {
  it('renders an accessible trigger; the URL popover is collapsed by default', () => {
    const html = renderToStaticMarkup(<CanvasComposerButton onOpenCanvas={() => {}} />)
    expect(html).toContain('aria-label="Open a web canvas"')
    expect(html).toContain('composer-canvas-trigger')
    expect(html).toContain('aria-expanded="false"')
    // The popover (CanvasPaneLauncher) is not rendered until opened.
    expect(html).not.toContain('canvas-pane-launcher')
  })

  it('reflects the disabled prop on the trigger', () => {
    const html = renderToStaticMarkup(<CanvasComposerButton onOpenCanvas={() => {}} disabled />)
    expect(html).toContain('disabled')
  })
})
