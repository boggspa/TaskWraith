import {
  authorizedOriginsForSite,
  normalizeWebSiteOrigin,
  type WebSiteLogin,
  type WebSiteLoginStatus
} from '../../shared/webSiteLogin'

/**
 * Is this site's saved session still good?
 *
 * Only a real request answers that, so this module makes one and reads the
 * answer conservatively. Closing the sign-in window proves nothing, and cookie
 * names prove less: the provider importer's first cut resolved on any cookie
 * with "session" in its name, which the login page sets before any credentials
 * are entered.
 *
 * THE RULES ARE DELIBERATELY BLUNT, because this is a heuristic and its only
 * consequence is asking the user a question (docs/appdrive/authorized-site-sessions.md,
 * section 8). It must never become an authorization input.
 *
 *  - Settled on the site's OWN origin with a non-auth status -> signed-in.
 *  - Settled on one of the site's SSO hops, or answered 401/403 -> expired,
 *    because being bounced to the identity provider is what a dead session
 *    looks like from outside.
 *  - Anything else (network error, a redirect off the fence, an odd status)
 *    -> unknown. An offline laptop is not an expired session, and saying so
 *    would send the user to re-authenticate for nothing.
 */

export interface WebSiteLivenessResponse {
  /** The URL the request actually settled on, after redirects. */
  finalUrl: string
  status: number
}

export interface WebSiteLivenessProbe {
  (input: { url: string; partition: string }): Promise<WebSiteLivenessResponse>
}

/** HTTP statuses that mean "you are not who you say you are". */
const AUTH_STATUSES = new Set([401, 403])

export function classifyWebSiteLiveness(
  site: WebSiteLogin,
  response: WebSiteLivenessResponse | null
): WebSiteLoginStatus {
  if (!response) return 'unknown'
  if (AUTH_STATUSES.has(response.status)) return 'expired'
  const settled = normalizeWebSiteOrigin(response.finalUrl)
  if (!settled) return 'unknown'
  const siteOrigin = normalizeWebSiteOrigin(site.origin)
  if (siteOrigin && settled === siteOrigin) {
    // A 5xx from the site itself says nothing about the session.
    return response.status >= 500 ? 'unknown' : 'signed-in'
  }
  const extraOrigins = authorizedOriginsForSite(site).filter((origin) => origin !== siteOrigin)
  if (extraOrigins.includes(settled)) return 'expired'
  return 'unknown'
}

/** The URL to probe: the site's own verify target if set, else its origin. */
export function livenessProbeUrl(site: WebSiteLogin): string {
  const configured = site.verify?.url ? normalizeVerifyUrl(site, site.verify.url) : null
  return configured ?? site.origin
}

/** A verify URL must stay inside the site's fence; anything else is ignored
 *  rather than followed, so a hand-edited catalogue cannot aim the probe at an
 *  arbitrary host. */
function normalizeVerifyUrl(site: WebSiteLogin, raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  const origin = normalizeWebSiteOrigin(parsed.origin)
  if (!origin || !authorizedOriginsForSite(site).includes(origin)) return null
  return parsed.toString()
}
