import type { ErrorInfo } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

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

  it('reports caught render errors without depending on successful telemetry', async () => {
    const recordRendererErrorBoundary = vi.fn(() => Promise.reject(new Error('ipc unavailable')))
    vi.stubGlobal('window', { api: { recordRendererErrorBoundary } })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const boundary = new ErrorBoundary({ children: null })
    const error = new Error('Maximum update depth exceeded')

    expect(() =>
      boundary.componentDidCatch(error, {
        componentStack: '\n    at TranscriptUserMessageGutter'
      } as ErrorInfo)
    ).not.toThrow()
    expect(recordRendererErrorBoundary).toHaveBeenCalledOnce()
    expect(recordRendererErrorBoundary).toHaveBeenCalledWith({
      name: 'Error',
      message: 'Maximum update depth exceeded',
      stack: error.stack,
      componentStack: '\n    at TranscriptUserMessageGutter'
    })
    await Promise.resolve()
  })
})
