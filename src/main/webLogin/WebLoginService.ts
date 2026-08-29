import {
  partitionForWebSiteLogin,
  type WebSiteLogin,
  type WebSiteLoginAccess,
  type WebSiteLoginStatus
} from '../../shared/webSiteLogin'
import {
  classifyWebSiteLiveness,
  livenessProbeUrl,
  type WebSiteLivenessProbe,
  type WebSiteLivenessResponse
} from './WebSiteLoginLiveness'
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
  /** Optional: without it every probe answers "unknown", which is the honest
   *  degraded state rather than a guess. */
  probe?: WebSiteLivenessProbe
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

  /**
   * Ask the site whether its saved session still works.
   *
   * Advisory only, and never an authorization input (design section 8). Its one
   * consequence is telling the user which site needs them - which is the whole
   * answer to "TaskWraith cannot re-authenticate for you, so it had better be
   * excellent at saying so".
   */
  async probeLiveness(id: string): Promise<WebSiteLoginStatus> {
    const site = this.deps.store.get(id)
    if (!site) return 'unknown'
    let response: WebSiteLivenessResponse | null = null
    if (this.deps.probe) {
      try {
        response = await this.deps.probe({
          url: livenessProbeUrl(site),
          partition: partitionForWebSiteLogin(site.id)
        })
      } catch (error) {
        // An offline laptop is not an expired session. Saying so would send the
        // user to re-authenticate for nothing, and a prompt that cries wolf is
        // one they learn to dismiss.
        this.deps.log?.(`[web-login] liveness probe failed for ${id}: ${String(error)}`)
        response = null
      }
    }
    const status = classifyWebSiteLiveness(site, response)
    this.deps.store.setStatus(id, status)
    return status
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
    // Closing the window is not proof of a session, so the status comes from a
    // real request rather than from the window having been open.
    await this.probeLiveness(id)
    return {
      ok: true,
      suggestedOrigins: outcome.suggestedOrigins,
      site: this.deps.store.get(id)
    }
  }
}

function describeClearFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return /Close all Canvas Browser surfaces/i.test(message)
    ? 'Close this site’s open browser canvases first, then try again.'
    : message
}
