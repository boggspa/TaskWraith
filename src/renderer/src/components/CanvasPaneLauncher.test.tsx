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

  it('honors a provided defaultUrl', () => {
    const html = renderToStaticMarkup(
      <CanvasPaneLauncher onOpen={() => {}} defaultUrl="http://127.0.0.1:5173" />
    )
    expect(html).toContain('value="http://127.0.0.1:5173"')
  })
})
