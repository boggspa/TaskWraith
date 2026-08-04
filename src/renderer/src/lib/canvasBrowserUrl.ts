/*
 * canvasBrowserUrl.ts — pure address-bar helpers for the Canvas Browser.
 *
 * The renderer normalizes what a human TYPES into something the main-process
 * canvas policy can evaluate; it never widens what loads (main re-validates
 * every navigation: http/https only, link-local/metadata blocked, private
 * hosts allowlist-gated).
 */

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/s

/** Hosts a developer means as plain-http local endpoints when typed bare. */
function prefersHttp(host: string): boolean {
  const bare = host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  return (
    bare === 'localhost' ||
    bare.endsWith('.localhost') ||
    bare === '::1' ||
    bare === '0.0.0.0' ||
    /^127(\.\d{1,3}){3}$/.test(bare) ||
    /^(10|192\.168)(\.\d{1,3}){2,3}$/.test(bare)
  )
}

/**
 * Turn address-bar input into an absolute http(s) URL, or null when it cannot
 * be one. Scheme-less input gets https:// (http:// for loopback/LAN dev
 * hosts); anything with a non-web scheme is rejected rather than "fixed".
 */
export function normalizeBrowserUrlInput(raw: string): string | null {
  const input = (raw || '').trim()
  if (!input || /\s/.test(input)) return null
  // "localhost:3000" lexes as scheme "localhost:" — a colon followed by pure
  // digits (plus optional path) is a PORT, so treat that as scheme-less input.
  const schemeMatch = input.match(SCHEME_RE)
  const hasRealScheme = Boolean(schemeMatch) && !/^\d+([/?#].*)?$/.test(schemeMatch![2])
  let candidate = input
  if (hasRealScheme) {
    if (!/^https?:\/\//i.test(input)) return null
  } else {
    const hostPart = input.split(/[/?#]/, 1)[0]?.split(':', 1)[0] ?? ''
    candidate = `${prefersHttp(hostPart) ? 'http' : 'https'}://${input}`
  }
  try {
    const parsed = new URL(candidate)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!parsed.hostname) return null
    return parsed.toString()
  } catch {
    return null
  }
}

/** Is this a live web page a browser chrome can drive (vs sketch://, html://…)? */
export function isNavigableCanvasUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** Compact address-bar rendering: hide the boilerplate, keep the truth hoverable. */
export function browserAddressDisplay(url: string | undefined): string {
  if (!url || !isNavigableCanvasUrl(url)) return ''
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' && !parsed.search && !parsed.hash ? '' : parsed.pathname
    return `${parsed.host}${path}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
}
