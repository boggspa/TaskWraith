import { describe, expect, it } from 'vitest'

import { classifyWebSiteLiveness, livenessProbeUrl } from './WebSiteLoginLiveness'
import type { WebSiteLogin } from '../../shared/webSiteLogin'

function site(overrides: Partial<WebSiteLogin> = {}): WebSiteLogin {
  return {
    id: 'example-com',
    label: 'Example',
    origin: 'https://example.com',
    extraOrigins: ['https://sso.example-idp.com'],
    agentAccess: 'read',
    status: 'unknown',
    createdAt: '2026-08-29T00:00:00.000Z',
    ...overrides
  }
}

describe('classifyWebSiteLiveness', () => {
  it('settling on the site own origin means signed in', () => {
    expect(
      classifyWebSiteLiveness(site(), { finalUrl: 'https://example.com/account', status: 200 })
    ).toBe('signed-in')
  })

  it('being bounced to the SSO hop means expired', () => {
    // Getting handed to the identity provider is what a dead session looks
    // like from outside.
    expect(
      classifyWebSiteLiveness(site(), {
        finalUrl: 'https://sso.example-idp.com/authorize?redirect=x',
        status: 200
      })
    ).toBe('expired')
  })

  it('401 and 403 mean expired whatever the URL says', () => {
    for (const status of [401, 403]) {
      expect(classifyWebSiteLiveness(site(), { finalUrl: 'https://example.com/', status })).toBe(
        'expired'
      )
    }
  })

  it('a 5xx from the site says nothing about the session', () => {
    expect(classifyWebSiteLiveness(site(), { finalUrl: 'https://example.com/', status: 503 })).toBe(
      'unknown'
    )
  })

  it('an offline probe is UNKNOWN, never expired', () => {
    // Sending the user to re-authenticate because their laptop lost wifi is
    // exactly the false positive that makes people ignore the prompt.
    expect(classifyWebSiteLiveness(site(), null)).toBe('unknown')
  })

  it('an unrecognized landing origin is unknown, not a verdict', () => {
    expect(
      classifyWebSiteLiveness(site(), { finalUrl: 'https://cdn.elsewhere.net/', status: 200 })
    ).toBe('unknown')
  })

  it('a 404 on the site own origin still means the session works', () => {
    expect(
      classifyWebSiteLiveness(site(), { finalUrl: 'https://example.com/gone', status: 404 })
    ).toBe('signed-in')
  })

  it('handles a site with no SSO hops', () => {
    const bare = site({ extraOrigins: [] })
    expect(classifyWebSiteLiveness(bare, { finalUrl: 'https://example.com/', status: 200 })).toBe(
      'signed-in'
    )
    expect(
      classifyWebSiteLiveness(bare, { finalUrl: 'https://sso.example-idp.com/', status: 200 })
    ).toBe('unknown')
  })
})

describe('livenessProbeUrl', () => {
  it('defaults to the site origin', () => {
    expect(livenessProbeUrl(site())).toBe('https://example.com')
  })

  it('uses a configured verify target inside the fence', () => {
    expect(livenessProbeUrl(site({ verify: { url: 'https://example.com/api/me' } }))).toBe(
      'https://example.com/api/me'
    )
  })

  it('accepts a verify target on an authorized SSO hop', () => {
    expect(livenessProbeUrl(site({ verify: { url: 'https://sso.example-idp.com/session' } }))).toBe(
      'https://sso.example-idp.com/session'
    )
  })

  it('IGNORES a verify target outside the fence rather than following it', () => {
    // A hand-edited catalogue must not be able to aim the probe - which runs
    // with the site's cookies - at an arbitrary host.
    expect(livenessProbeUrl(site({ verify: { url: 'https://attacker.example/collect' } }))).toBe(
      'https://example.com'
    )
  })

  it('ignores an unparseable verify target', () => {
    expect(livenessProbeUrl(site({ verify: { url: 'not a url' } }))).toBe('https://example.com')
  })
})
