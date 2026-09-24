import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasPaneLauncher } from './CanvasPaneLauncher'

describe('CanvasPaneLauncher (static render)', () => {
  it('renders a blank-first browser button without a URL field', () => {
    const html = renderToStaticMarkup(<CanvasPaneLauncher onOpen={() => {}} />)
    expect(html).toContain('Open browser')
    expect(html).not.toContain('<input')
  })

  // The open action is the shared rim pill, not a bare native button.
  it('renders the open action as a shared PillButton', () => {
    const html = renderToStaticMarkup(<CanvasPaneLauncher onOpen={() => {}} />)
    expect(html).toContain('segmented-control-action')
    expect(html).toContain('segmented-control-action--compact')
    expect(html).toContain('canvas-pane-launcher-open')
  })

  it('keeps the open action enabled before any address exists', () => {
    const html = renderToStaticMarkup(<CanvasPaneLauncher onOpen={() => {}} />)
    expect(html).not.toContain('disabled')
  })
})
