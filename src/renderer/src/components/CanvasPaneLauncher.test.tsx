import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasPaneLauncher } from './CanvasPaneLauncher'

describe('CanvasPaneLauncher (static render)', () => {
  it('renders an address field with browser placeholder and an open button', () => {
    const html = renderToStaticMarkup(<CanvasPaneLauncher onOpen={() => {}} />)
    expect(html).toContain('placeholder="https://example.com or localhost:3000"')
    expect(html).toContain('aria-label="Browser URL"')
    expect(html).toContain('Open browser')
  })

  // The open action is the shared rim pill, not a bare native button.
  it('renders the open action as a shared PillButton', () => {
    const html = renderToStaticMarkup(<CanvasPaneLauncher onOpen={() => {}} />)
    expect(html).toContain('segmented-control-action')
    expect(html).toContain('segmented-control-action--compact')
    expect(html).toContain('canvas-pane-launcher-open')
  })

  it('disables the open action until the address normalizes to a web URL', () => {
    const blank = renderToStaticMarkup(<CanvasPaneLauncher onOpen={() => {}} />)
    expect(blank).toContain('disabled')
    const nonsense = renderToStaticMarkup(
      <CanvasPaneLauncher onOpen={() => {}} defaultUrl="not a url" />
    )
    expect(nonsense).toContain('disabled')
    // Scheme-less dev-server addresses count as navigable (http:// is assumed).
    const filled = renderToStaticMarkup(
      <CanvasPaneLauncher onOpen={() => {}} defaultUrl="localhost:3000" />
    )
    expect(filled).not.toContain('disabled')
  })

  it('honors a provided defaultUrl', () => {
    const html = renderToStaticMarkup(
      <CanvasPaneLauncher onOpen={() => {}} defaultUrl="http://127.0.0.1:5173" />
    )
    expect(html).toContain('value="http://127.0.0.1:5173"')
  })
})
