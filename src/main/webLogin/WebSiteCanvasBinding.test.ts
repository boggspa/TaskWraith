import { describe, expect, it, vi } from 'vitest'

import {
  UnknownWebSiteLoginError,
  WebSiteLoginAccessDeniedError,
  resolveWebSiteCanvasBinding
} from './WebSiteCanvasBinding'
import { WebSiteProfileRegistry } from './WebSiteProfileRegistry'
import type { WebSiteLogin } from '../../shared/webSiteLogin'

function site(overrides: Partial<WebSiteLogin> = {}): WebSiteLogin {
  return {
    id: 'example-com',
    label: 'Example',
    origin: 'https://example.com',
    extraOrigins: [],
    agentAccess: 'read',
    status: 'signed-in',
    createdAt: '2026-08-29T00:00:00.000Z',
    ...overrides
  }
}

function deps(found: WebSiteLogin | null): {
  getSite: (id: string) => WebSiteLogin | null
  profiles: WebSiteProfileRegistry
} {
  return {
    getSite: vi.fn(() => found),
    profiles: new WebSiteProfileRegistry({
      createProfile: (partition) => ({
        partition,
        activeSurfaceCount: 0,
        register: () => () => {},
        clearBrowsingData: async () => {}
      })
    })
  }
}

describe('resolveWebSiteCanvasBinding', () => {
  it('binds to the site partition and its authorized origins', () => {
    const resolved = resolveWebSiteCanvasBinding(deps(site()), 'example-com')
    expect(resolved.browserProfile.partition).toBe('persist:taskwraith-site-example-com')
    expect(resolved.siteBinding).toEqual({
      siteId: 'example-com',
      authorizedOrigins: ['https://example.com'],
      agentAccess: 'read'
    })
  })

  it('carries the SSO hops the user widened the site with', () => {
    const resolved = resolveWebSiteCanvasBinding(
      deps(site({ extraOrigins: ['https://accounts.example-idp.com'] })),
      'example-com'
    )
    expect(resolved.siteBinding.authorizedOrigins).toEqual([
      'https://example.com',
      'https://accounts.example-idp.com'
    ])
  })

  it('FAILS CLOSED on an unknown site rather than falling back to the shared jar', () => {
    expect(() => resolveWebSiteCanvasBinding(deps(null), 'gone')).toThrow(UnknownWebSiteLoginError)
  })

  it('fails closed when a corrupt row resolves to no usable origin', () => {
    // A bare hostname is legitimately normalized ("example.com" is how users
    // type it), so the corrupt case has to be an origin no scheme rule admits.
    const broken = { ...site(), origin: 'file:///etc/passwd', extraOrigins: [] } as WebSiteLogin
    expect(() => resolveWebSiteCanvasBinding(deps(broken), 'example-com')).toThrow(
      UnknownWebSiteLoginError
    )
  })

  it('reuses one partition across canvases for the same site', () => {
    const shared = deps(site())
    const first = resolveWebSiteCanvasBinding(shared, 'example-com')
    const second = resolveWebSiteCanvasBinding(shared, 'example-com')
    expect(second.browserProfile).toBe(first.browserProfile)
  })

  it('snapshots origins at bind time so a later edit cannot re-scope a live canvas', () => {
    const mutable = site()
    const shared = { ...deps(mutable), getSite: () => mutable }
    const bound = resolveWebSiteCanvasBinding(shared, 'example-com')
    mutable.extraOrigins = ['https://added-later.example']
    expect(bound.siteBinding.authorizedOrigins).toEqual(['https://example.com'])
  })
})

describe('resolveWebSiteCanvasBinding agent access', () => {
  it('REFUSES a site the user has not opened to agents', () => {
    expect(() =>
      resolveWebSiteCanvasBinding(deps(site({ agentAccess: 'off' })), 'example-com')
    ).toThrow(WebSiteLoginAccessDeniedError)
  })

  it('admits read and act', () => {
    for (const level of ['read', 'act'] as const) {
      expect(
        resolveWebSiteCanvasBinding(deps(site({ agentAccess: level })), 'example-com').siteBinding
          .siteId
      ).toBe('example-com')
    }
  })

  it('lets a human-initiated bind opt out of the agent-access gate', () => {
    // The sign-in window binds the same site before any access is granted.
    expect(
      resolveWebSiteCanvasBinding(deps(site({ agentAccess: 'off' })), 'example-com', {
        requireAgentAccess: false
      }).siteBinding.siteId
    ).toBe('example-com')
  })
})

describe('resolveWebSiteCanvasBinding carries the access level', () => {
  it('hands the driver the level the user chose, not just the origins', () => {
    // The driver refuses actuation on `read`, so the level has to travel with
    // the binding - a fence without it would let a read-only site be acted in.
    for (const level of ['read', 'act'] as const) {
      expect(
        resolveWebSiteCanvasBinding(deps(site({ agentAccess: level })), 'example-com').siteBinding
          .agentAccess
      ).toBe(level)
    }
  })
})
