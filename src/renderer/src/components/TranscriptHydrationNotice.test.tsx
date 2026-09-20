import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TranscriptHydrationNotice } from './TranscriptHydrationNotice'

describe('TranscriptHydrationNotice', () => {
  it('renders nothing when the selected transcript is ready', () => {
    expect(
      renderToStaticMarkup(
        createElement(TranscriptHydrationNotice, {
          state: null,
          onRetry: vi.fn()
        })
      )
    ).toBe('')
  })

  it('distinguishes a pending read from an empty conversation', () => {
    const markup = renderToStaticMarkup(
      createElement(TranscriptHydrationNotice, {
        state: { chatId: 'a', phase: 'loading' },
        onRetry: vi.fn()
      })
    )
    expect(markup).toContain('Loading saved transcript…')
    expect(markup).toContain('role="status"')
    expect(markup).not.toContain('<button')
  })

  it('exposes an accessible Retry button when automatic recovery is exhausted', () => {
    const markup = renderToStaticMarkup(
      createElement(TranscriptHydrationNotice, {
        state: { chatId: 'a', phase: 'failed' },
        onRetry: vi.fn()
      })
    )
    expect(markup).toContain('Couldn’t load saved transcript.')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('>Retry</button>')
  })
})
