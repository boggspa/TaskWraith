import { lookup } from 'dns/promises'
import { classifyCanvasHost, type CanvasHostClass } from './canvasTypes'

const DNS_LOOKUP_TIMEOUT_MS = 2_000

export type CanvasResolveHost = (host: string) => Promise<string[]>

export class CanvasDnsBlockedError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string
  ) {
    super(`Canvas URL was rejected: ${reason} (${url}).`)
    this.name = 'CanvasDnsBlockedError'
  }
}

async function defaultResolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true })
  return records.map((record) => record.address)
}

function allowlistMatches(rawHost: string, allowlist: string[]): boolean {
  const host = rawHost.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
  const allow = allowlist
    .map((entry) => entry.toLowerCase().trim().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, ''))
    .filter(Boolean)
  return allow.some((entry) => host === entry || host.endsWith(`.${entry}`))
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('dns_timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

function resolvedAddressAllowed(
  addressClass: CanvasHostClass,
  rawHost: string,
  address: string,
  allowlist: string[]
): boolean {
  if (addressClass === 'public') return true
  if (addressClass === 'private') {
    return allowlistMatches(rawHost, allowlist) || allowlistMatches(address, allowlist)
  }
  // A public DNS name resolving to loopback is a rebinding vector unless the
  // user explicitly allowlisted the loopback address itself. Direct
  // localhost/127/::1 was already allowed before DNS resolution.
  if (addressClass === 'loopback') {
    return allowlistMatches(address, allowlist)
  }
  return false
}

/**
 * DNS layer for Canvas SSRF protection. The pure URL validator catches literal
 * IPs and metadata hostnames; this closes the common rebinding case where a
 * public-looking hostname resolves to loopback, private LAN, or link-local IPs.
 *
 * Canvas intentionally differs from web_fetch: loopback is allowed for dev
 * servers, and allowlisted private hosts may be opened for local-network apps.
 */
export async function assertCanvasDnsAllowed(
  rawUrl: string,
  allowlist: string[] = [],
  resolveHost: CanvasResolveHost = defaultResolveHost
): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return
  }
  if (!parsed.hostname) return
  const protocol = parsed.protocol.toLowerCase()
  if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'ws:' && protocol !== 'wss:') {
    return
  }

  const rawHost = parsed.hostname
  const hostClass = classifyCanvasHost(rawHost)
  if (hostClass === 'loopback') return
  if (hostClass === 'linklocal') throw new CanvasDnsBlockedError(rawUrl, 'host_linklocal')
  if (hostClass === 'private' && !allowlistMatches(rawHost, allowlist)) {
    throw new CanvasDnsBlockedError(rawUrl, 'host_private')
  }
  if (hostClass !== 'public') return

  let addresses: string[]
  try {
    addresses = await withTimeout(resolveHost(rawHost), DNS_LOOKUP_TIMEOUT_MS)
  } catch {
    throw new CanvasDnsBlockedError(rawUrl, 'dns_unresolved')
  }
  if (addresses.length === 0) throw new CanvasDnsBlockedError(rawUrl, 'dns_empty')

  for (const address of addresses) {
    const addressClass = classifyCanvasHost(address)
    if (!resolvedAddressAllowed(addressClass, rawHost, address, allowlist)) {
      throw new CanvasDnsBlockedError(rawUrl, `resolved_${addressClass}`)
    }
  }
}

export async function isCanvasDnsBlocked(
  rawUrl: string,
  allowlist: string[] = [],
  resolveHost: CanvasResolveHost = defaultResolveHost
): Promise<boolean> {
  try {
    await assertCanvasDnsAllowed(rawUrl, allowlist, resolveHost)
    return false
  } catch {
    return true
  }
}
