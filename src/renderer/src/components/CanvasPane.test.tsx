import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasPane, canvasPaneRect } from './CanvasPane'

describe('canvasPaneRect', () => {
  it('rounds and clamps an element rect into a floating-view rect', () => {
    expect(canvasPaneRect({ left: 10.4, top: 20.6, width: 300.5, height: 199.4 })).toEqual({
      x: 10,
      y: 21,
      width: 301,
      height: 199
    })
  })

  it('never produces negative width/height', () => {
    expect(canvasPaneRect({ left: 0, top: 0, width: -5, height: -1 })).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0
    })
  })
})

describe('CanvasPane (static render)', () => {
  it('renders a toolbar with the title and a close affordance', () => {
    const html = renderToStaticMarkup(
      <CanvasPane canvasId="c1" title="My Preview" url="http://localhost:3000" onClose={() => {}} />
    )
    expect(html).toContain('My Preview')
    expect(html).toContain('canvas-pane-host')
    expect(html).toContain('aria-label="Close canvas pane"')
  })

  it('falls back to the url, then a default label, for the title', () => {
    expect(renderToStaticMarkup(<CanvasPane canvasId="c1" url="http://x/" />)).toContain('http://x/')
    expect(renderToStaticMarkup(<CanvasPane canvasId="c1" />)).toContain('Canvas')
  })

  it('omits the close button when no onClose is given', () => {
    const html = renderToStaticMarkup(<CanvasPane canvasId="c1" title="X" />)
    expect(html).not.toContain('canvas-pane-close')
  })
})
