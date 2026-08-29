import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { WebLoginsDockPanelView, type WebLoginsDockPanelViewProps } from './WebLoginsDockPanel'
import type { WebSiteLogin } from '../../../shared/webSiteLogin'

/** No jsdom in this repo, so the pure view is exercised as SSR markup - which
 *  is also what the user actually reads. */
function site(overrides: Partial<WebSiteLogin> = {}): WebSiteLogin {
  return {
    id: 'example-com',
    label: 'Example',
    origin: 'https://example.com',
    extraOrigins: [],
    agentAccess: 'off',
    status: 'never',
    createdAt: '2026-08-29T00:00:00.000Z',
    ...overrides
  }
}

function render(overrides: Partial<WebLoginsDockPanelViewProps> = {}): string {
  const props: WebLoginsDockPanelViewProps = {
    sites: [],
    origin: '',
    busyId: null,
    error: null,
    suggestions: null,
    onOriginChange: () => {},
    onAdd: () => {},
    onAccessChange: () => {},
    onSignIn: () => {},
    onSignOut: () => {},
    onForget: () => {},
    onAcceptSuggestions: () => {},
    onDismissSuggestions: () => {},
    onAllowBlockedEmbeds: () => {},
    ...overrides
  }
  return renderToStaticMarkup(<WebLoginsDockPanelView {...props} />)
}

describe('WebLoginsDockPanelView', () => {
  it('NEVER renders a password field', () => {
    // The whole product claim is that TaskWraith does not handle credentials.
    // A password input appearing here would be the feature quietly becoming a
    // password manager.
    const html = render({ sites: [site(), site({ id: 'other', label: 'Other' })] })
    expect(html).not.toContain('type="password"')
    expect(html.toLowerCase()).not.toContain('password"')
  })

  it('tells the user where their password actually goes', () => {
    expect(render()).toContain('never sees your password')
  })

  it('shows an empty state rather than a bare list', () => {
    expect(render()).toContain('No saved logins yet')
  })

  it('renders the EXACT origin, not a prettified one', () => {
    // A homograph has to be visible in the row, so the punycode form is shown.
    const html = render({ sites: [site({ origin: 'https://xn--exmple-4nf.com' })] })
    expect(html).toContain('https://xn--exmple-4nf.com')
  })

  it('names what each access level actually means', () => {
    expect(render({ sites: [site({ agentAccess: 'off' })] })).toContain(
      'No agent can open this site'
    )
    expect(render({ sites: [site({ agentAccess: 'read' })] })).toContain('cannot click or type')
    expect(render({ sites: [site({ agentAccess: 'act' })] })).toContain('act in this account')
  })

  it('offers all three access levels with the default selected', () => {
    const html = render({ sites: [site()] })
    expect(html).toContain('No agent access')
    expect(html).toContain('Agents can read')
    expect(html).toContain('Agents can act as me')
    expect(html).toMatch(/<option[^>]*selected[^>]*value="off"|value="off"[^>]*selected/)
  })

  it('shows the widened origins a site carries', () => {
    const html = render({ sites: [site({ extraOrigins: ['https://idp.example.net'] })] })
    expect(html).toContain('https://idp.example.net')
  })

  it('surfaces an error as an alert', () => {
    const html = render({ error: 'Close this site’s open browser canvases first.' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('open browser canvases')
  })

  it('OFFERS the SSO origins rather than applying them', () => {
    const html = render({
      sites: [site()],
      suggestions: { id: 'example-com', origins: ['https://sso.example.net'] }
    })
    expect(html).toContain('https://sso.example.net')
    expect(html).toContain('Allow')
    expect(html).toContain('Not now')
  })

  it('disables the row actions while that row is busy', () => {
    // A non-empty origin so the Add button is not also disabled and the count
    // measures the row alone.
    const html = render({ sites: [site()], busyId: 'example-com', origin: 'new.example' })
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(3)
  })

  it('leaves other rows enabled while one is busy', () => {
    const html = render({
      sites: [site(), site({ id: 'other-example', label: 'Other' })],
      busyId: 'example-com',
      origin: 'new.example'
    })
    // Still three: the second row's Sign in / Sign out / Forget stay live.
    expect(html.match(/disabled=""/g) ?? []).toHaveLength(3)
  })

  it('renders each status in the user words, not the enum', () => {
    expect(render({ sites: [site({ status: 'never' })] })).toContain('Not signed in')
    expect(render({ sites: [site({ status: 'signed-in' })] })).toContain('Signed in')
    expect(render({ sites: [site({ status: 'expired' })] })).toContain('Sign-in expired')
    expect(render({ sites: [site({ status: 'unknown' })] })).toContain('Sign-in not verified')
  })
})

describe('WebLoginsDockPanelView blocked embeds', () => {
  it('explains a blocked embed instead of leaving a page mysteriously broken', () => {
    const html = render({
      sites: [site({ blockedEmbedOrigins: ['https://pay.example-psp.com'] })]
    })
    expect(html).toContain('https://pay.example-psp.com')
    expect(html).toContain('blocked')
    expect(html).toContain('Allow embeds')
  })

  it('shows nothing when the site has no blocked embeds', () => {
    expect(render({ sites: [site()] })).not.toContain('Allow embeds')
  })

  it('lists every blocked origin, not just the first', () => {
    const html = render({
      sites: [site({ blockedEmbedOrigins: ['https://a.example', 'https://b.example'] })]
    })
    expect(html).toContain('https://a.example')
    expect(html).toContain('https://b.example')
  })
})
