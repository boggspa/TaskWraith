import type { Session, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasBrowserProfileController } from './CanvasBrowserProfile'
import type { CanvasHostSurface } from './CanvasHostSurface'
import { CanvasWebDriver } from './CanvasWebDriver'
import { partitionForWebSiteLogin } from '../../shared/webSiteLogin'

/**
 * The site fence, at every path a document navigation can take.
 *
 * Five gates exist because they fail differently and no one of them covers the
 * others: open() and navigate() owe the caller a REASON, will-navigate is the
 * only hook that can refuse an in-page cause before Chromium commits it, the
 * window-open handler is the only place a page picks its own target, and the
 * request layer is the only one that sees a 30x redirect hop at all.
 *
 * The last test is the regression guard that matters most: an UNBOUND driver
 * must behave exactly as it did before site binding existed.
 */

type Listener = (...args: unknown[]) => void

interface Harness {
  driver: CanvasWebDriver
  emit: (event: string, ...args: unknown[]) => void
  shouldBlock: (details: { url: string; resourceType: string }) => boolean | Promise<boolean>
  windowOpen: (details: { url: string }) => { action: string }
  loadURL: ReturnType<typeof vi.fn>
  preventedNavigations: string[]
}

function harness(
  siteBinding?: {
    siteId: string
    authorizedOrigins: string[]
    agentAccess: 'off' | 'read' | 'act'
  },
  partitionOverride?: string
): Harness {
  const listeners = new Map<string, Listener[]>()
  let shouldBlock: Harness['shouldBlock'] = () => false
  let windowOpen: Harness['windowOpen'] = () => ({ action: 'deny' })
  const profile: CanvasBrowserProfileController = {
    // The driver refuses a binding whose partition is not that site's own, so a
    // bound harness must use the real derived name.
    partition:
      partitionOverride ??
      (siteBinding ? partitionForWebSiteLogin(siteBinding.siteId) : 'persist:test-unbound'),
    activeSurfaceCount: 0,
    register: (_wc, handlers) => {
      shouldBlock = handlers.shouldBlock as Harness['shouldBlock']
      return () => {}
    },
    clearBrowsingData: vi.fn(async () => {})
  }
  const loadURL = vi.fn(async () => {
    for (const listener of listeners.get('did-finish-load') ?? []) listener()
  })
  const webContents = {
    id: 21,
    session: {} as Session,
    setWindowOpenHandler: vi.fn((handler: Harness['windowOpen']) => {
      windowOpen = handler
    }),
    setWebRTCIPHandlingPolicy: vi.fn(),
    // Minimal isolated-world stub: enough for an ALLOWED act to get past the
    // read-only gate and reach dispatch, which is what those cases assert.
    executeJavaScriptInIsolatedWorld: vi.fn(async () => ({
      ok: true,
      found: true,
      action: 'click',
      executed: true,
      verified: 'yes',
      trustedInputEpoch: 0
    })),
    getURL: vi.fn(() => 'https://example.com/'),
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    }),
    removeListener: vi.fn(),
    loadURL
  } as unknown as WebContents
  const surface: CanvasHostSurface = {
    webContents,
    getTitle: () => 'Example',
    setContentSize: vi.fn(),
    isDestroyed: () => false,
    destroy: vi.fn(),
    onClosed: vi.fn()
  }
  const driver = new CanvasWebDriver('canvas-site', {
    browserProfile: profile,
    createSurface: () => surface,
    resolveHost: async () => ['93.184.216.34'],
    ...(siteBinding ? { siteBinding } : {})
  })
  const preventedNavigations: string[] = []
  return {
    driver,
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    get shouldBlock() {
      return shouldBlock
    },
    get windowOpen() {
      return windowOpen
    },
    loadURL,
    preventedNavigations
  }
}

const BOUND = {
  siteId: 'example-com',
  authorizedOrigins: ['https://example.com'],
  agentAccess: 'act' as const
}
const BOUND_READ_ONLY = { ...BOUND, agentAccess: 'read' as const }

describe('CanvasWebDriver site fence', () => {
  it('opens an in-fence URL', async () => {
    const h = harness(BOUND)
    await expect(h.driver.open({ url: 'https://example.com/orders' })).resolves.toBeTruthy()
    await h.driver.close()
  })

  it('refuses to OPEN out of fence, and names the site and the blocked origin', async () => {
    const h = harness(BOUND)
    await expect(h.driver.open({ url: 'https://evil.example.com/' })).rejects.toThrow(
      /example-com.*https:\/\/example\.com.*evil\.example\.com/s
    )
  })

  it('refuses to NAVIGATE out of fence once open', async () => {
    const h = harness(BOUND)
    await h.driver.open({ url: 'https://example.com/' })
    await expect(h.driver.navigate({ url: 'https://evil.com/' })).rejects.toThrow(
      /may only navigate to/i
    )
    await h.driver.close()
  })

  it('prevents an in-page navigation out of fence but allows one inside it', async () => {
    const h = harness(BOUND)
    await h.driver.open({ url: 'https://example.com/' })
    const blocked = { preventDefault: vi.fn() }
    h.emit('will-navigate', blocked, 'https://evil.com/')
    expect(blocked.preventDefault).toHaveBeenCalled()

    const allowed = { preventDefault: vi.fn() }
    h.emit('will-navigate', allowed, 'https://example.com/next')
    expect(allowed.preventDefault).not.toHaveBeenCalled()
    await h.driver.close()
  })

  it('drops an out-of-fence popup instead of loading it in place', async () => {
    const h = harness(BOUND)
    await h.driver.open({ url: 'https://example.com/' })
    h.loadURL.mockClear()
    // The handler returns { action: 'deny' } on EVERY path, fenced or not, so
    // that return value proves nothing. Whether it loaded in place is the claim.
    h.windowOpen({ url: 'https://evil.com/' })
    expect(h.loadURL).not.toHaveBeenCalled()

    h.windowOpen({ url: 'https://example.com/popup' })
    expect(h.loadURL).toHaveBeenCalledWith('https://example.com/popup')
    await h.driver.close()
  })

  it('blocks an out-of-fence MAIN-FRAME request at the request layer', async () => {
    const h = harness(BOUND)
    await h.driver.open({ url: 'https://example.com/' })
    expect(
      await Promise.resolve(
        h.shouldBlock({ url: 'https://evil.com/landing', resourceType: 'mainFrame' })
      )
    ).toBe(true)
    await h.driver.close()
  })

  it('leaves third-party SUB-RESOURCES alone, so real sites still work', async () => {
    const h = harness(BOUND)
    await h.driver.open({ url: 'https://example.com/' })
    await expect(
      h.shouldBlock({ url: 'https://cdn.thirdparty.net/app.js', resourceType: 'script' })
    ).resolves.toBe(false)
    await expect(
      h.shouldBlock({ url: 'https://fonts.example.net/x.woff2', resourceType: 'font' })
    ).resolves.toBe(false)
    await h.driver.close()
  })

  it('an UNBOUND driver keeps its pre-existing any-origin behaviour', async () => {
    const h = harness()
    await expect(h.driver.open({ url: 'https://anything.example/' })).resolves.toBeTruthy()
    await expect(h.driver.navigate({ url: 'https://elsewhere.example/' })).resolves.toBeTruthy()
    const event = { preventDefault: vi.fn() }
    h.emit('will-navigate', event, 'https://third.example/')
    expect(event.preventDefault).not.toHaveBeenCalled()
    await expect(
      h.shouldBlock({ url: 'https://fourth.example/', resourceType: 'mainFrame' })
    ).resolves.toBe(false)
    await h.driver.close()
  })
})

describe('CanvasWebDriver site binding integrity', () => {
  it('REFUSES a binding whose profile is not that site own partition', () => {
    // A binding and its partition are one invariant. Accepting the shared
    // app-wide profile alongside a binding would yield a surface that looks
    // fenced, passes every fence test above, and still carries every other
    // site's cookies.
    expect(() => harness(BOUND, 'persist:taskwraith-canvas-browser-v1')).toThrow(
      /does not match the profile partition/i
    )
  })

  it('opens a bound surface with no URL at all', async () => {
    const h = harness(BOUND)
    await expect(h.driver.open({})).resolves.toBeTruthy()
    await h.driver.close()
  })

  it('leaves an out-of-fence SUB-FRAME alone — a documented residual, not an oversight', async () => {
    // Sub-frame documents are classified with sub-resources: fencing them would
    // break payment iframes, SSO frames and captchas. The consequence is
    // recorded in authorized-site-sessions.md section 11 — a cross-origin frame
    // renders inside a bound surface and can reach an agent through
    // canvas_screenshot. Asserted so the exemption stays deliberate.
    const h = harness(BOUND)
    await h.driver.open({ url: 'https://example.com/' })
    expect(
      await Promise.resolve(
        h.shouldBlock({ url: 'https://embedded.example.net/', resourceType: 'subFrame' })
      )
    ).toBe(false)
    await h.driver.close()
  })

  it('an UNBOUND surface still loads a popup in place', async () => {
    const h = harness()
    await h.driver.open({ url: 'https://anything.example/' })
    h.loadURL.mockClear()
    h.windowOpen({ url: 'https://elsewhere.example/popup' })
    expect(h.loadURL).toHaveBeenCalledWith('https://elsewhere.example/popup')
    await h.driver.close()
  })

  it('reports a blocked redirect BY NAME rather than as a bare network error', async () => {
    const h = harness(BOUND)
    await h.driver.open({ url: 'https://example.com/' })
    // Simulate the real sequence: the request layer cancels the redirect hop,
    // then Chromium reports ERR_BLOCKED_BY_CLIENT on the main frame.
    h.loadURL.mockImplementation(async () => {
      void h.shouldBlock({ url: 'https://evil.com/landing', resourceType: 'mainFrame' })
      h.emit('did-fail-load', {}, -20, 'ERR_BLOCKED_BY_CLIENT', 'https://evil.com/landing', true)
    })
    await expect(h.driver.navigate({ url: 'https://example.com/redirector' })).rejects.toThrow(
      /may only navigate to/i
    )
    await h.driver.close()
  })
})

describe('CanvasWebDriver read-only site access', () => {
  const ACTUATION = ['click', 'fill', 'key', 'scroll', 'hover', 'select'] as const

  it.each(ACTUATION)('refuses %s on a read-only site, do-not-retry', async (kind) => {
    const h = harness(BOUND_READ_ONLY)
    await h.driver.open({ url: 'https://example.com/' })
    const result = await h.driver.act({ kind, ref: 'e1', value: 'x' })
    expect(result.ok).toBe(false)
    expect(result.executed).toBe(false)
    expect(result.refusalReason).toBe('site_read_only')
    expect(result.message).toMatch(/read-only/i)
    expect(result.message).toMatch(/Do not retry/i)
    // The refusal has to name the only way out, which is the USER widening it.
    expect(result.message).toMatch(/Work > Logins/)
    await h.driver.close()
  })

  it('still allows the read-only verb wait_for', async () => {
    const h = harness(BOUND_READ_ONLY)
    await h.driver.open({ url: 'https://example.com/' })
    const result = await h.driver.act({ kind: 'wait_for', selector: '#done', timeoutMs: 1 })
    expect(result.refusalReason).not.toBe('site_read_only')
    await h.driver.close()
  })

  it('permits actuation on a site the user set to act', async () => {
    const h = harness(BOUND)
    await h.driver.open({ url: 'https://example.com/' })
    const result = await h.driver.act({ kind: 'click', ref: 'e1' })
    expect(result.refusalReason).not.toBe('site_read_only')
    await h.driver.close()
  })

  it('leaves an UNBOUND canvas actuable exactly as before', async () => {
    const h = harness()
    await h.driver.open({ url: 'https://anything.example/' })
    const result = await h.driver.act({ kind: 'click', ref: 'e1' })
    expect(result.refusalReason).not.toBe('site_read_only')
    await h.driver.close()
  })
})
