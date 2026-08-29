import { describe, expect, it } from 'vitest'

import { WebLoginSignInWindowController, type SignInWindowHandle } from './WebLoginSignInWindow'
import type { WebSiteLogin } from '../../shared/webSiteLogin'

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

interface Harness {
  controller: WebLoginSignInWindowController
  created: Array<{ partition: string; title: string }>
  loaded: string[]
  close: () => void
  navigate: (url: string) => void
}

function harness(): Harness {
  const created: Array<{ partition: string; title: string }> = []
  const loaded: string[] = []
  let onClosed: (() => void) | null = null
  let onNavigate: ((url: string) => void) | null = null
  let destroyed = false
  const controller = new WebLoginSignInWindowController({
    createWindow: (opts) => {
      created.push(opts)
      const handle: SignInWindowHandle = {
        loadURL: async (url) => {
          loaded.push(url)
        },
        onClosed: (callback) => {
          onClosed = callback
        },
        onDidNavigate: (callback) => {
          onNavigate = callback
        },
        close: () => {
          destroyed = true
          onClosed?.()
        },
        isDestroyed: () => destroyed
      }
      return handle
    }
  })
  return {
    controller,
    created,
    loaded,
    close: () => {
      destroyed = true
      onClosed?.()
    },
    navigate: (url) => onNavigate?.(url)
  }
}

describe('WebLoginSignInWindowController', () => {
  it('opens on the site OWN persistent partition, not the shared jar', async () => {
    const h = harness()
    const pending = h.controller.signIn(site())
    expect(h.created).toEqual([
      { partition: 'persist:taskwraith-site-example-com', title: 'Sign in to Example' }
    ])
    expect(h.loaded).toEqual(['https://example.com'])
    h.close()
    await pending
  })

  it('settles only when the HUMAN closes the window', async () => {
    const h = harness()
    let settled = false
    const pending = h.controller.signIn(site()).then((outcome) => {
      settled = true
      return outcome
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    h.close()
    expect((await pending).ok).toBe(true)
  })

  it('reports the SSO hops the human passed through, as a suggestion', async () => {
    const h = harness()
    const pending = h.controller.signIn(site())
    h.navigate('https://accounts.example-idp.com/authorize?code=SECRET')
    h.navigate('https://example.com/dashboard')
    h.close()
    const outcome = await pending
    expect(outcome.ok).toBe(true)
    // Origins only, never the URL: a sign-in query string is where one-time
    // codes live.
    expect(outcome.ok && outcome.suggestedOrigins).toEqual(['https://accounts.example-idp.com'])
  })

  it('does not suggest an origin the site already authorizes', async () => {
    const h = harness()
    const pending = h.controller.signIn(site({ extraOrigins: ['https://idp.example.net'] }))
    h.navigate('https://idp.example.net/login')
    h.navigate('https://example.com/')
    h.close()
    const outcome = await pending
    expect(outcome.ok && outcome.suggestedOrigins).toEqual([])
  })

  it('never widens the fence by itself — it only reports', async () => {
    const h = harness()
    const subject = site()
    const pending = h.controller.signIn(subject)
    h.navigate('https://sso.elsewhere.example/')
    h.close()
    await pending
    expect(subject.extraOrigins).toEqual([])
  })

  it('refuses a second window for the same site', async () => {
    const h = harness()
    const pending = h.controller.signIn(site())
    expect(await h.controller.signIn(site())).toEqual({
      ok: false,
      siteId: 'example-com',
      reason: 'alreadyOpen'
    })
    h.close()
    await pending
  })

  it('allows a fresh sign-in once the window has closed', async () => {
    const h = harness()
    const first = h.controller.signIn(site())
    h.close()
    await first
    const second = h.controller.signIn(site())
    h.close()
    expect((await second).ok).toBe(true)
    expect(h.created).toHaveLength(2)
  })

  it('reports a window that could not be constructed instead of hanging', async () => {
    const controller = new WebLoginSignInWindowController({
      createWindow: () => {
        throw new Error('no display')
      }
    })
    expect(await controller.signIn(site())).toEqual({
      ok: false,
      siteId: 'example-com',
      reason: 'windowFailed'
    })
  })

  it('a failed load leaves the window up for the human rather than settling', async () => {
    const closers: Array<() => void> = []
    const controller = new WebLoginSignInWindowController({
      createWindow: () => ({
        loadURL: async () => {
          throw new Error('ERR_NAME_NOT_RESOLVED')
        },
        onClosed: (callback) => {
          closers.push(callback)
        },
        close: () => {},
        isDestroyed: () => false
      })
    })
    let settled = false
    const pending = controller.signIn(site()).then((outcome) => {
      settled = true
      return outcome
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    for (const close of closers) close()
    expect((await pending).ok).toBe(true)
  })

  it('refuses a site id that could escape the partition namespace', async () => {
    const h = harness()
    expect(await h.controller.signIn(site({ id: '../escape' }))).toEqual({
      ok: false,
      siteId: '../escape',
      reason: 'windowFailed'
    })
    expect(h.created).toEqual([])
  })

  it('closeAll is teardown only and does not fabricate a sign-in', async () => {
    const h = harness()
    const pending = h.controller.signIn(site())
    h.controller.closeAll()
    await pending
    expect(h.controller.isOpen('example-com')).toBe(false)
  })
})
