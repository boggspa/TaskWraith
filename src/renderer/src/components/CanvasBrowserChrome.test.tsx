import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CanvasBrowserChrome, toCanvasBrowserNavState } from './CanvasBrowserChrome'

const baseProps = {
  chatId: 'chat-a',
  canvasId: 'c1',
  initialState: {
    url: 'https://example.com/docs?x=1',
    title: 'Docs',
    isLoading: false,
    canGoBack: true,
    canGoForward: false
  }
}

describe('CanvasBrowserChrome (static render)', () => {
  it('renders back/forward/reload/external controls and the address bar', () => {
    const html = renderToStaticMarkup(<CanvasBrowserChrome {...baseProps} />)
    expect(html).toContain('aria-label="Browser controls"')
    expect(html).toContain('aria-label="Back"')
    expect(html).toContain('aria-label="Forward"')
    expect(html).toContain('aria-label="Reload"')
    expect(html).toContain('aria-label="Open in default browser"')
    // Compact display: origin boilerplate stripped, path + query kept.
    expect(html).toContain('value="example.com/docs?x=1"')
  })

  it('reflects history depth in the disabled state of back/forward', () => {
    const html = renderToStaticMarkup(<CanvasBrowserChrome {...baseProps} />)
    // canGoBack=true → Back enabled; canGoForward=false → Forward disabled.
    const back = html.slice(
      html.indexOf('aria-label="Back"') - 220,
      html.indexOf('aria-label="Back"')
    )
    const forward = html.slice(
      html.indexOf('aria-label="Forward"') - 220,
      html.indexOf('aria-label="Forward"')
    )
    expect(back).not.toContain('disabled')
    expect(forward).toContain('disabled')
  })

  it('shows the stop control and shimmer while loading', () => {
    const html = renderToStaticMarkup(
      <CanvasBrowserChrome
        {...baseProps}
        initialState={{ ...baseProps.initialState, isLoading: true }}
      />
    )
    expect(html).toContain('aria-label="Stop loading"')
    expect(html).toContain('canvas-browser-progress')
    expect(html).toContain('is-loading')
  })

  it('marks https addresses secure and http ones plain', () => {
    const secure = renderToStaticMarkup(<CanvasBrowserChrome {...baseProps} />)
    expect(secure).toContain('canvas-browser-address-scheme is-secure')
    const plain = renderToStaticMarkup(
      <CanvasBrowserChrome
        {...baseProps}
        initialState={{ ...baseProps.initialState, url: 'http://localhost:3000/' }}
      />
    )
    expect(plain).not.toContain('is-secure')
  })

  it('renders a usable empty address rail for a blank browser', () => {
    const html = renderToStaticMarkup(
      <CanvasBrowserChrome
        {...baseProps}
        initialState={{ ...baseProps.initialState, url: 'about:blank', title: '' }}
      />
    )
    expect(html).toContain('placeholder="Enter a web address"')
    expect(html).toContain('value=""')
    expect(html).toContain('aria-label="Address"')
  })
})

describe('toCanvasBrowserNavState', () => {
  it('decodes a well-formed push and fails closed on garbage', () => {
    expect(
      toCanvasBrowserNavState({
        canvasId: 'c1',
        chatId: 'chat-a',
        state: {
          url: 'https://a.test/',
          title: 'A',
          isLoading: true,
          canGoBack: false,
          canGoForward: true
        }
      })
    ).toEqual({
      url: 'https://a.test/',
      title: 'A',
      isLoading: true,
      canGoBack: false,
      canGoForward: true
    })
    expect(toCanvasBrowserNavState(null)).toBeNull()
    expect(toCanvasBrowserNavState({})).toBeNull()
    expect(toCanvasBrowserNavState({ state: 'nope' })).toBeNull()
    expect(toCanvasBrowserNavState({ state: { url: 7, isLoading: 'yes' } })).toEqual({
      url: '',
      title: '',
      isLoading: false,
      canGoBack: false,
      canGoForward: false
    })
  })
})
