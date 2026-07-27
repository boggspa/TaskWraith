import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasPaneLauncher } from './CanvasPaneLauncher'

describe('CanvasPaneLauncher (static render)', () => {
  it('renders a URL field (defaulting) and an open button', () => {
    const html = renderToStaticMarkup(<CanvasPaneLauncher onOpen={() => {}} />)
    expect(html).toContain('value="http://localhost:3000"')
    expect(html).toContain('aria-label="Canvas URL"')
    expect(html).toContain('Open web canvas')
  })

  // The open action is the shared rim pill, not a bare native button.
  it('renders the open action as a shared PillButton', () => {
    const html = renderToStaticMarkup(<CanvasPaneLauncher onOpen={() => {}} />)
    expect(html).toContain('segmented-control-action')
    expect(html).toContain('segmented-control-action--compact')
    expect(html).toContain('canvas-pane-launcher-open')
  })

  it('disables the open action when the URL is blank', () => {
    const blank = renderToStaticMarkup(<CanvasPaneLauncher onOpen={() => {}} defaultUrl="   " />)
    expect(blank).toContain('disabled')
    const filled = renderToStaticMarkup(<CanvasPaneLauncher onOpen={() => {}} />)
    expect(filled).not.toContain('disabled')
  })

  it('honors a provided defaultUrl', () => {
    const html = renderToStaticMarkup(
      <CanvasPaneLauncher onOpen={() => {}} defaultUrl="http://127.0.0.1:5173" />
    )
    expect(html).toContain('value="http://127.0.0.1:5173"')
  })
})
