import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorBoundary } from './ErrorBoundary'

describe('ErrorBoundary', () => {
  it('wires the reload button to the error details for screen readers', () => {
    const boundary = new ErrorBoundary({ children: null })
    boundary.state = { error: new Error('boom') }
    const html = renderToStaticMarkup(boundary.render())
    expect(html).toContain('id="error-boundary-details"')
    expect(html).toContain('aria-label="Reload TaskWraith window"')
    expect(html).toContain('aria-describedby="error-boundary-details"')
    expect(html).toContain('boom')
  })
})