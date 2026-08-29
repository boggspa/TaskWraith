import type { WebSiteLogin, WebSiteLoginAccess } from '../../shared/webSiteLogin'
import type { WebSiteLoginStore } from './WebSiteLoginStore'
import type { WebSiteProfileRegistry } from './WebSiteProfileRegistry'
import type { WebLoginSignInWindowController } from './WebLoginSignInWindow'

/**
 * The one place that knows the ORDER these three collaborators must be used in.
 *
 * Forget is clear-then-remove, and that order is load-bearing: the partition is
 * derived from the id, so dropping the row first and failing the clear leaves a
 * signed-in cookie jar with nothing pointing at it. The store retires ids as the
 * backstop, but the backstop is not the contract - this is.
 *
 * Sign-out is clear-and-keep. Both refuse while the site still has open canvas
 * surfaces, because clearing under a live page leaves the page authenticated in
 * memory and the jar empty, which reads to the user as "it did nothing".
 */
export interface WebLoginServiceDeps {
  store: WebSiteLoginStore
  profiles: WebSiteProfileRegistry
  signInWindows: WebLoginSignInWindowController
  log?: (line: string) => void
}

export interface WebLoginMutationResult {
  ok: boolean
  error?: string
}

export interface WebLoginSignInResult {
  ok: boolean
  reason?: string
  suggestedOrigins?: string[]
  site?: WebSiteLogin | null
}

export class WebLoginService {
  private readonly deps: WebLoginServiceDeps

  constructor(deps: WebLoginServiceDeps) {
    this.deps = deps
  }

  list(): WebSiteLogin[] {
    return this.deps.store.list()
  }

  add(input: { origin: string; label?: string }): {
    ok: boolean
    error?: string
    site?: WebSiteLogin
  } {
    return this.deps.store.add(input)
  }

  update(
    id: string,
    patch: { label?: string; extraOrigins?: string[]; agentAccess?: WebSiteLoginAccess }
  ): { ok: boolean; error?: string; site?: WebSiteLogin } {
    return this.deps.store.update(id, patch)
  }

  /** Clear the jar, keep the row. */
  async signOut(id: string): Promise<WebLoginMutationResult> {
    if (!this.deps.store.get(id)) return { ok: false, error: 'That site is no longer saved.' }
    try {
      await this.deps.profiles.clearSite(id)
    } catch (error) {
      return { ok: false, error: describeClearFailure(error) }
    }
    this.deps.store.setStatus(id, 'never')
    return { ok: true }
  }

  /** Clear the jar, THEN drop the row. Never the other way round. */
  async forget(id: string): Promise<WebLoginMutationResult> {
    if (!this.deps.store.get(id)) return { ok: false, error: 'That site is no longer saved.' }
    try {
      await this.deps.profiles.forgetSite(id)
    } catch (error) {
      // Leave the row in place: a catalogue entry the user can retry is far
      // better than an orphaned signed-in partition with nothing naming it.
      return { ok: false, error: describeClearFailure(error) }
    }
    this.deps.store.remove(id)
    return { ok: true }
  }

  async signIn(id: string): Promise<WebLoginSignInResult> {
    const site = this.deps.store.get(id)
    if (!site) return { ok: false, reason: 'That site is no longer saved.' }
    const outcome = await this.deps.signInWindows.signIn(site)
    if (!outcome.ok) {
      return {
        ok: false,
        reason:
          outcome.reason === 'alreadyOpen'
            ? `A sign-in window for ${site.label} is already open.`
            : `Could not open a sign-in window for ${site.label}.`
      }
    }
    // Status is advisory and deliberately optimistic-free: closing the window is
    // not proof of a session, so this records "unknown" until something actually
    // makes a request. The liveness probe that upgrades it is a later slice.
    const updated = this.deps.store.setStatus(id, 'unknown')
    return { ok: true, suggestedOrigins: outcome.suggestedOrigins, site: updated }
  }
}

function describeClearFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /Close all Canvas Browser surfaces/i.test(message)
    ? 'Close this site’s open browser canvases first, then try again.'
    : message
}
