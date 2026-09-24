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

function resolvedAddressAllowed(addressClass: CanvasHostClass): boolean {
  return addressClass === 'public' || addressClass === 'private' || addressClass === 'loopback'
}

/**
 * DNS layer for the Canvas Browser's fixed metadata deny rule. Public names may
 * intentionally resolve to loopback or private addresses (local dev aliases,
 * routers, lab services); only link-local/cloud-metadata resolution is denied.
 */
export async function assertCanvasDnsAllowed(
  rawUrl: string,
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
  if (hostClass === 'loopback' || hostClass === 'private') return
  if (hostClass === 'linklocal') throw new CanvasDnsBlockedError(rawUrl, 'host_linklocal')
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
    if (!resolvedAddressAllowed(addressClass)) {
      throw new CanvasDnsBlockedError(rawUrl, `resolved_${addressClass}`)
    }
  }
}

export async function isCanvasDnsBlocked(
  rawUrl: string,
  resolveHost: CanvasResolveHost = defaultResolveHost
): Promise<boolean> {
  try {
    await assertCanvasDnsAllowed(rawUrl, resolveHost)
    return false
  } catch {
    return true
  }
}
