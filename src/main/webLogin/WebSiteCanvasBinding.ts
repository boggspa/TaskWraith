import type { CanvasBrowserProfileController } from '../canvas/CanvasBrowserProfile'
import {
  authorizedOriginsForSite,
  type WebSiteBinding,
  type WebSiteLogin
} from '../../shared/webSiteLogin'
import type { WebSiteProfileRegistry } from './WebSiteProfileRegistry'

/**
 * Turn a saved-site id into the two things a web canvas needs to be bound to
 * it: that site's own persistent profile, and the fence its navigation obeys.
 *
 * Extracted from the composition root deliberately. `src/main/index.ts` gets one
 * call; the resolution rules — unknown site fails closed, origins are resolved
 * ONCE at bind time — are testable here without Electron.
 *
 * Origins are snapshotted at bind time rather than read live per navigation.
 * A live read would mean editing a site's allowed origins silently re-scopes
 * every canvas already open on it, including one an agent is mid-task in; the
 * user's edit should take effect on the NEXT canvas, where they can see it.
 */
export interface WebSiteCanvasBinding {
  browserProfile: CanvasBrowserProfileController
  siteBinding: WebSiteBinding
}

export interface WebSiteCanvasBindingDeps {
  getSite: (siteId: string) => WebSiteLogin | null
  profiles: WebSiteProfileRegistry
}

export class WebSiteLoginAccessDeniedError extends Error {
  constructor(siteId: string) {
    super(
      `The saved login "${siteId}" is not available to agents. Set its access to ` +
        `Read only or Can act in Work > Logins first.`
    )
    this.name = 'WebSiteLoginAccessDeniedError'
  }
}

export class UnknownWebSiteLoginError extends Error {
  constructor(siteId: string) {
    super(
      `No saved login named "${siteId}". Add the site in Work > Logins and sign in ` +
        `before opening a canvas bound to it.`
    )
    this.name = 'UnknownWebSiteLoginError'
  }
}

/**
 * Fails closed. An unknown or removed site id NEVER falls back to the shared
 * app-wide profile: silently handing back the jar that holds every other site's
 * cookies is the exact failure this feature exists to prevent, and it would look
 * like success at the call site.
 */
export function resolveWebSiteCanvasBinding(
  deps: WebSiteCanvasBindingDeps,
  siteId: string,
  options: { requireAgentAccess?: boolean } = {}
): WebSiteCanvasBinding {
  const site = deps.getSite(siteId)
  if (!site) throw new UnknownWebSiteLoginError(siteId)
  // I3 is enforced HERE, not at the tool, because this resolver is the single
  // chokepoint every binder must pass and it already holds the row. A default of
  // `off` that nothing consults is not a default.
  if (options.requireAgentAccess !== false && site.agentAccess === 'off') {
    throw new WebSiteLoginAccessDeniedError(site.id)
  }
  const authorizedOrigins = authorizedOriginsForSite(site)
  if (authorizedOrigins.length === 0) throw new UnknownWebSiteLoginError(siteId)
  return {
    browserProfile: deps.profiles.profileFor(site.id),
    siteBinding: { siteId: site.id, authorizedOrigins }
  }
}
