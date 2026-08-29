import { describe, expect, it } from 'vitest'
import {
  authorizedOriginsForSite,
  isNavigationAllowedForSite,
  isWebSiteLoginId,
  normalizeWebSiteOrigin,
  parseWebSiteLogin,
  partitionForWebSiteLogin,
  proposeWebSiteLoginId,
  type WebSiteLogin
} from './webSiteLogin'

/**
 * The fence is the security value of the per-site split, so it is tested
 * against the ways a fence like this is actually defeated — subdomain
 * confusion, scheme downgrade, port confusion, userinfo prefixes and
 * origin-shaped strings that are not origins — rather than only the happy path.
 */

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

describe('normalizeWebSiteOrigin', () => {
  it('canonicalizes a bare host to an https origin', () => {
    expect(normalizeWebSiteOrigin('example.com')).toBe('https://example.com')
  })

  it('drops path, query and default port', () => {
    expect(normalizeWebSiteOrigin('https://example.com:443/a/b?c=d#e')).toBe('https://example.com')
  })

  it('keeps a non-default port, because it is part of the origin', () => {
    expect(normalizeWebSiteOrigin('https://example.com:8443/x')).toBe('https://example.com:8443')
  })

  it('refuses non-http(s) schemes rather than leaving them to the fence', () => {
    for (const input of [
      'file:///etc/passwd',
      'data:text/html,x',
      'about:blank',
      'blob:https://a'
    ]) {
      expect(normalizeWebSiteOrigin(input)).toBeNull()
    }
  })

  it('leaves IDN in punycode so a homograph stays visible in the row', () => {
    // U+0430 is Cyrillic "a"; the ASCII form is what the user must be shown.
    expect(normalizeWebSiteOrigin('https://exаmple.com')).toBe('https://xn--exmple-4nf.com')
  })

  it('returns null for junk and non-strings', () => {
    expect(normalizeWebSiteOrigin('')).toBeNull()
    expect(normalizeWebSiteOrigin('   ')).toBeNull()
    expect(normalizeWebSiteOrigin(null)).toBeNull()
    expect(normalizeWebSiteOrigin(42)).toBeNull()
  })
})

describe('isNavigationAllowedForSite', () => {
  it('admits the site origin itself, with any path', () => {
    expect(isNavigationAllowedForSite(site(), 'https://example.com/orders/1')).toBe(true)
  })

  it('refuses a different registrable domain', () => {
    expect(isNavigationAllowedForSite(site(), 'https://evil.com/')).toBe(false)
  })

  it('refuses a SUBDOMAIN of the authorized origin — no wildcarding', () => {
    expect(isNavigationAllowedForSite(site(), 'https://evil.example.com/')).toBe(false)
  })

  it('refuses a parent domain of the authorized origin', () => {
    const bound = site({ origin: 'https://app.example.com' })
    expect(isNavigationAllowedForSite(bound, 'https://example.com/')).toBe(false)
  })

  it('refuses a scheme downgrade to http', () => {
    expect(isNavigationAllowedForSite(site(), 'http://example.com/')).toBe(false)
  })

  it('refuses a different port on the authorized host', () => {
    expect(isNavigationAllowedForSite(site(), 'https://example.com:8443/')).toBe(false)
  })

  it('refuses a userinfo prefix that only looks like the authorized host', () => {
    expect(isNavigationAllowedForSite(site(), 'https://example.com@evil.com/')).toBe(false)
  })

  it('refuses non-http(s) targets', () => {
    expect(isNavigationAllowedForSite(site(), 'file:///etc/passwd')).toBe(false)
    expect(isNavigationAllowedForSite(site(), 'about:blank')).toBe(false)
  })

  it('admits an explicitly widened SSO hop, and only that one', () => {
    const bound = site({ extraOrigins: ['https://accounts.example-idp.com'] })
    expect(isNavigationAllowedForSite(bound, 'https://accounts.example-idp.com/login')).toBe(true)
    expect(isNavigationAllowedForSite(bound, 'https://other.example-idp.com/login')).toBe(false)
  })

  it('refuses a non-string target', () => {
    expect(isNavigationAllowedForSite(site(), null)).toBe(false)
    expect(isNavigationAllowedForSite(site(), { toString: () => 'https://example.com' })).toBe(
      false
    )
  })
})

describe('authorizedOriginsForSite', () => {
  it('dedupes and canonicalizes, keeping the site origin first', () => {
    const bound = site({
      extraOrigins: ['https://example.com:443/ignored-path', 'HTTPS://Accounts.Example.com']
    })
    expect(authorizedOriginsForSite(bound)).toEqual([
      'https://example.com',
      'https://accounts.example.com'
    ])
  })
})

describe('partitionForWebSiteLogin', () => {
  it('derives the site-scoped persistent partition', () => {
    expect(partitionForWebSiteLogin('example-com')).toBe('persist:taskwraith-site-example-com')
  })

  it('refuses an id that could escape the partition namespace', () => {
    for (const bad of ['../other', 'has space', 'Upper', '', 'persist:x', 'a'.repeat(80)]) {
      expect(isWebSiteLoginId(bad)).toBe(false)
      expect(() => partitionForWebSiteLogin(bad)).toThrow(/site login id/i)
    }
  })
})

describe('parseWebSiteLogin', () => {
  it('round-trips a well-formed row', () => {
    const row = site({ agentAccess: 'act', status: 'signed-in' })
    expect(parseWebSiteLogin(JSON.parse(JSON.stringify(row)))).toEqual(row)
  })

  it('drops a row whose origin is not http(s)', () => {
    expect(parseWebSiteLogin({ ...site(), origin: 'file:///x' })).toBeNull()
  })

  it('falls back to no agent access when the stored level is unrecognized', () => {
    const parsed = parseWebSiteLogin({ ...site(), agentAccess: 'admin' })
    expect(parsed?.agentAccess).toBe('off')
  })

  it('drops an extra origin that duplicates the site origin', () => {
    const parsed = parseWebSiteLogin({
      ...site(),
      extraOrigins: ['https://example.com/', 'https://idp.example.net']
    })
    expect(parsed?.extraOrigins).toEqual(['https://idp.example.net'])
  })

  it('caps extra origins rather than trusting the file', () => {
    const many = Array.from({ length: 40 }, (_value, index) => `https://h${index}.example.net`)
    const parsed = parseWebSiteLogin({ ...site(), extraOrigins: many })
    expect(parsed?.extraOrigins).toHaveLength(8)
  })
})

describe('proposeWebSiteLoginId', () => {
  it('derives a readable id from the host', () => {
    expect(proposeWebSiteLoginId('https://mail.example.co.uk')).toBe('mail-example-co-uk')
  })

  it('disambiguates against ids already taken', () => {
    expect(proposeWebSiteLoginId('https://example.com', ['example-com'])).toBe('example-com-2')
  })

  it('encodes a non-default port into the id so two ports never share a partition', () => {
    expect(proposeWebSiteLoginId('https://example.com:8443')).toBe('example-com-8443')
  })
})
