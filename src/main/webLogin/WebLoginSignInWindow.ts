import {
  normalizeWebSiteOrigin,
  partitionForWebSiteLogin,
  type WebSiteLogin
} from '../../shared/webSiteLogin'

/**
 * The human-only sign-in window (docs/appdrive/authorized-site-sessions.md, I2).
 *
 * THE POINT OF THIS MODULE IS WHAT IT DOES NOT DO. There is no capture, no
 * cookie polling, no export, and no renderer projection of anything but status.
 * The user authenticates; the cookies land in that site's own persistent
 * partition; that IS the mechanism. No password ever exists in TaskWraith's
 * address space, so "agents cannot see or type passwords" is structural rather
 * than a policy check that has to run inside a page the site controls.
 *
 * It differs from `providers/WebSessionBrowser.ts`, which deliberately uses an
 * in-memory partition and lifts the cookie header out for safeStorage. That is
 * the right shape for a provider usage probe and the wrong one here.
 *
 * SECTION 6a APPLIES VERBATIM. No canvas driver may resolve this window's
 * webContents. That is enforced structurally - this module is never handed to
 * the canvas layer, and `WebLoginSignInWindowIsolation.test.ts` pins the absent
 * import edge - not by a refusal list inside a driver.
 *
 * The window is NOT origin-fenced. It has to follow an SSO redirect the user's
 * identity provider chooses, and the human is the one driving. The origins they
 * pass through are reported back so the UI can OFFER to widen the site's fence;
 * nothing is widened automatically, because an origin in the fence is authority
 * and authority is the user's to grant.
 */

export interface SignInWindowHandle {
  loadURL: (url: string) => Promise<void>
  onClosed: (callback: () => void) => void
  /** Committed navigations, so the caller can offer the SSO hops afterwards. */
  onDidNavigate?: (callback: (url: string) => void) => void
  close: () => void
  isDestroyed: () => boolean
}

export interface WebLoginSignInWindowDeps {
  createWindow: (opts: { partition: string; title: string }) => SignInWindowHandle
  log?: (line: string) => void
}

export type WebLoginSignInOutcome =
  | {
      ok: true
      siteId: string
      /** Origins the human passed through, minus the ones already authorized.
       *  Offer, never apply. */
      suggestedOrigins: string[]
    }
  | { ok: false; siteId: string; reason: 'alreadyOpen' | 'windowFailed' }

export class WebLoginSignInWindowController {
  private readonly open = new Map<string, SignInWindowHandle>()
  private readonly deps: WebLoginSignInWindowDeps

  constructor(deps: WebLoginSignInWindowDeps) {
    this.deps = deps
  }

  isOpen(siteId: string): boolean {
    const handle = this.open.get(siteId)
    if (handle && !handle.isDestroyed()) return true
    if (handle) this.open.delete(siteId)
    return false
  }

  /**
   * Resolves when the human closes the window. There is no success signal to
   * detect here on purpose: whether a session was actually established is a
   * question only a real request can answer, so the caller probes afterwards
   * rather than this module guessing from cookie names. The first cut of the
   * provider importer resolved on any cookie with "session" in its name, which
   * the login page sets before any credentials are entered.
   */
  async signIn(site: WebSiteLogin): Promise<WebLoginSignInOutcome> {
    if (this.isOpen(site.id)) return { ok: false, siteId: site.id, reason: 'alreadyOpen' }

    const authorized = new Set(
      [site.origin, ...site.extraOrigins]
        .map((entry) => normalizeWebSiteOrigin(entry))
        .filter((entry): entry is string => Boolean(entry))
    )
    const visited = new Set<string>()

    let handle: SignInWindowHandle
    try {
      handle = this.deps.createWindow({
        partition: partitionForWebSiteLogin(site.id),
        title: `Sign in to ${site.label}`
      })
    } catch (error) {
      this.deps.log?.(`[web-login] sign-in window failed for ${site.id}: ${String(error)}`)
      return { ok: false, siteId: site.id, reason: 'windowFailed' }
    }
    this.open.set(site.id, handle)

    return new Promise<WebLoginSignInOutcome>((resolve) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        this.open.delete(site.id)
        resolve({
          ok: true,
          siteId: site.id,
          suggestedOrigins: [...visited].filter((origin) => !authorized.has(origin))
        })
      }
      handle.onClosed(settle)
      handle.onDidNavigate?.((url) => {
        const origin = normalizeWebSiteOrigin(url)
        // Origins only, never URLs. A sign-in flow's query string is exactly
        // where one-time codes live, and nothing here should hold one even in
        // memory.
        if (origin) visited.add(origin)
      })
      handle.loadURL(site.origin).catch((error) => {
        this.deps.log?.(`[web-login] sign-in load failed for ${site.id}: ${String(error)}`)
        // A failed load is not a failed sign-in: the window is up and the human
        // can retry or navigate. Only the close settles this.
      })
    })
  }

  /** App teardown only. Never called to "finish" a sign-in on the user's behalf. */
  closeAll(): void {
    for (const [siteId, handle] of this.open) {
      if (!handle.isDestroyed()) handle.close()
      this.open.delete(siteId)
    }
  }
}
