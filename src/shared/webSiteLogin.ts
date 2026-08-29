/**
 * Authorized site sessions — the model layer.
 *
 * Design: `docs/appdrive/authorized-site-sessions.md`. The one-line version:
 * every site the user signs into gets its OWN persistent Electron partition,
 * and a canvas bound to that site may only navigate documents to origins the
 * user authorized for it. Before this, one shared
 * `persist:taskwraith-canvas-browser-v1` jar held every session at once and the
 * navigation gate carried no host allowlist, so an agent leased for one site
 * was one `canvas_navigate` away from acting as the user anywhere.
 *
 * Everything here is pure and Electron-free so the fence can be unit-tested
 * without a browser. No secret is modelled: a `WebSiteLogin` is a catalogue
 * entry, and the session itself lives in Chromium's own per-partition store.
 */

/** What an agent may do with a site's session. */
export const WEB_SITE_LOGIN_ACCESS_LEVELS = ['off', 'read', 'act'] as const
export type WebSiteLoginAccess = (typeof WEB_SITE_LOGIN_ACCESS_LEVELS)[number]

/** Last known state of the stored session. Advisory: only a real request proves it. */
export const WEB_SITE_LOGIN_STATUSES = ['never', 'signed-in', 'expired', 'unknown'] as const
export type WebSiteLoginStatus = (typeof WEB_SITE_LOGIN_STATUSES)[number]

export interface WebSiteLogin {
  /** Opaque, stable, and the ONLY input to the partition name. */
  id: string
  label: string
  /** Canonical `scheme://host[:port]`, punycode as `URL` produces it. */
  origin: string
  /** Identity-provider / SSO hops. Each entry widens this site's fence. */
  extraOrigins: string[]
  agentAccess: WebSiteLoginAccess
  status: WebSiteLoginStatus
  createdAt: string
  lastSignedInAt?: string
  lastVerifiedAt?: string
}

/** The renderer- and agent-facing projection. Identical today, named separately
 *  so a future durable-only field cannot leak by forgetting to strip it. */
export type WebSiteLoginProjection = WebSiteLogin

export const WEB_SITE_LOGIN_PARTITION_PREFIX = 'persist:taskwraith-site-'

/** Ids are restricted to this charset because they are interpolated into a
 *  partition name. A partition string is a capability: two ids that collapse to
 *  one partition would silently merge two sites' cookie jars, which is the exact
 *  state the per-site split exists to prevent. */
const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

export const MAX_WEB_SITE_LOGIN_LABEL = 120
export const MAX_WEB_SITE_LOGIN_EXTRA_ORIGINS = 8
/** Catalogue ceiling. Generous for humans, bounded against a runaway writer. */
export const MAX_WEB_SITE_LOGINS = 256

export function isWebSiteLoginId(value: unknown): value is string {
  return typeof value === 'string' && SITE_ID_PATTERN.test(value)
}

export function isWebSiteLoginAccess(value: unknown): value is WebSiteLoginAccess {
  return (
    typeof value === 'string' && (WEB_SITE_LOGIN_ACCESS_LEVELS as readonly string[]).includes(value)
  )
}

export function isWebSiteLoginStatus(value: unknown): value is WebSiteLoginStatus {
  return typeof value === 'string' && (WEB_SITE_LOGIN_STATUSES as readonly string[]).includes(value)
}

/**
 * The site's dedicated persistent partition.
 *
 * Derived, never stored. Persisting it would let a corrupt or hand-edited
 * catalogue point two rows at one jar.
 */
export function partitionForWebSiteLogin(id: string): string {
  if (!isWebSiteLoginId(id)) {
    throw new Error('A site login id must be lowercase alphanumeric with dashes.')
  }
  return `${WEB_SITE_LOGIN_PARTITION_PREFIX}${id}`
}

/**
 * Canonicalize user input into `scheme://host[:port]`.
 *
 * Accepts a bare host (`example.com`), a full URL, or an origin. Returns null
 * for anything that is not http(s) — `file:`, `data:`, `blob:` and `about:` are
 * refused here rather than downstream, so the fence never has to reason about a
 * URL whose origin is `"null"`.
 *
 * IDN is deliberately left in the ASCII/punycode form `URL` produces: a
 * homograph must be VISIBLE in the site row, and a prettified display would
 * hide exactly the case the user needs to catch.
 */
export function normalizeWebSiteOrigin(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  // `URL.origin` already drops the default port and lowercases the host.
  const origin = url.origin
  return origin === 'null' ? null : origin
}

/** Every origin this site's fence admits, deduped and canonical. */
export function authorizedOriginsForSite(site: WebSiteLogin): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const candidate of [site.origin, ...site.extraOrigins]) {
    const normalized = normalizeWebSiteOrigin(candidate)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

/**
 * THE FENCE. True only when `url` is a document navigation this site permits.
 *
 * Exact origin equality, with no subdomain wildcarding. Wildcards are how a
 * fence like this is defeated: `*.example.com` admits `evil.example.com` the
 * moment anyone can host there, and the user cannot see that in a site row. A
 * site that genuinely spans hosts widens itself through `extraOrigins`, which
 * is rendered to the user for exactly this reason.
 *
 * Sub-resources are NOT passed through here — see the design doc. Fencing them
 * would break every site that uses a CDN, and a control that breaks the product
 * gets switched off, which protects nothing.
 */
export function isNavigationAllowedForSite(site: WebSiteLogin, url: unknown): boolean {
  const target = normalizeWebSiteOrigin(typeof url === 'string' ? url : '')
  if (!target) return false
  return authorizedOriginsForSite(site).includes(target)
}

/** Read-back guard for the durable catalogue. Returns null rather than throwing
 *  so one corrupt row drops instead of bricking the whole file. */
export function parseWebSiteLogin(value: unknown): WebSiteLogin | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (!isWebSiteLoginId(raw.id)) return null
  const origin = normalizeWebSiteOrigin(raw.origin)
  if (!origin) return null
  if (typeof raw.label !== 'string') return null
  const label = raw.label.trim().slice(0, MAX_WEB_SITE_LOGIN_LABEL)
  if (!label) return null
  if (typeof raw.createdAt !== 'string' || !raw.createdAt.trim()) return null
  const agentAccess = isWebSiteLoginAccess(raw.agentAccess) ? raw.agentAccess : 'off'
  const status = isWebSiteLoginStatus(raw.status) ? raw.status : 'unknown'
  const extraOrigins: string[] = []
  if (Array.isArray(raw.extraOrigins)) {
    for (const entry of raw.extraOrigins) {
      const normalized = normalizeWebSiteOrigin(entry)
      if (!normalized || normalized === origin || extraOrigins.includes(normalized)) continue
      if (extraOrigins.length >= MAX_WEB_SITE_LOGIN_EXTRA_ORIGINS) break
      extraOrigins.push(normalized)
    }
  }
  return {
    id: raw.id,
    label,
    origin,
    extraOrigins,
    agentAccess,
    status,
    createdAt: raw.createdAt,
    ...(typeof raw.lastSignedInAt === 'string' ? { lastSignedInAt: raw.lastSignedInAt } : {}),
    ...(typeof raw.lastVerifiedAt === 'string' ? { lastVerifiedAt: raw.lastVerifiedAt } : {})
  }
}

/** Derive a readable, collision-resistant id from an origin. The caller
 *  disambiguates a collision; this only proposes. */
export function proposeWebSiteLoginId(
  origin: string,
  taken: readonly string[] = []
): string | null {
  const normalized = normalizeWebSiteOrigin(origin)
  if (!normalized) return null
  const host = new URL(normalized).host
  const base = host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  if (!base || !isWebSiteLoginId(base)) return null
  if (!taken.includes(base)) return base
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!taken.includes(candidate)) return candidate
  }
  return null
}
