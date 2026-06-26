import { describe, it, expect } from 'vitest'
import { parseDiscoveredHost, probeTailnetHost, discoverTailnetHosts } from './TailnetDiscovery'
import type { TailscaleFetch, TailscaleHttpResponse } from './TailscaleDevices'

const TOKEN_URL = 'https://api.tailscale.com/api/v2/oauth/token'
const DEVICES_URL = 'https://api.tailscale.com/api/v2/tailnet/-/devices'
const SECRET = 'tskey-client-abc123CDEF'
const KEY_SELF = Buffer.alloc(32, 1).toString('base64')
const KEY_STUDIO = Buffer.alloc(32, 2).toString('base64')
const KEY_LAPTOP = Buffer.alloc(32, 3).toString('base64')
const KEY_DUP = Buffer.alloc(32, 4).toString('base64')

function res(body: unknown, ok = true, status = 200): TailscaleHttpResponse {
  return { ok, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
}
function notFound(): TailscaleHttpResponse {
  return { ok: false, status: 404, text: async () => 'not found' }
}

/** Route a stub fetch across the OAuth token, device list, and per-host
 * /v1/hostinfo probe URLs. `hostInfo[name] === null` → that host 404s. */
function makeFetch(opts: {
  devices: Array<{ id?: string; name: string; hostname?: string; os?: string }>
  hostInfo: Record<string, Record<string, unknown> | null>
  tokenOk?: boolean
}): { fetchImpl: TailscaleFetch; calls: string[] } {
  const calls: string[] = []
  const fetchImpl: TailscaleFetch = async (url) => {
    calls.push(url)
    if (url === TOKEN_URL) return opts.tokenOk === false ? notFound() : res({ access_token: 'tok' })
    if (url === DEVICES_URL) return res({ devices: opts.devices })
    const m = /^https:\/\/(.+)\/v1\/hostinfo$/.exec(url)
    if (m) {
      const body = opts.hostInfo[m[1]]
      return body == null ? notFound() : res(body)
    }
    return notFound()
  }
  return { fetchImpl, calls }
}

const hostBody = (pubKey: string, extra: Record<string, unknown> = {}) => ({
  protocol: 'taskwraith-e2ee-v1',
  macIdentityPubKey: pubKey,
  macDisplayName: `host-${pubKey}`,
  relayUrls: ['ws://192.168.1.2:8787'],
  ...extra
})

describe('parseDiscoveredHost', () => {
  it('parses a full host info body', () => {
    expect(
      parseDiscoveredHost({
        protocol: 'taskwraith-e2ee-v1',
        macIdentityPubKey: KEY_STUDIO,
        macDisplayName: 'Studio',
        relayUrls: ['ws://192.168.1.2:8787', 'wss://studio.ts.net'],
        hostPlatform: 'mac'
      })
    ).toEqual({
      macIdentityPubKey: KEY_STUDIO,
      macDisplayName: 'Studio',
      relayUrls: ['ws://192.168.1.2:8787', 'wss://studio.ts.net'],
      hostPlatform: 'mac'
    })
  })

  it('accepts the minimal TaskWraith shape', () => {
    expect(
      parseDiscoveredHost({
        protocol: 'taskwraith-e2ee-v1',
        macIdentityPubKey: KEY_STUDIO,
        relayUrls: ['wss://x']
      })
    ).toEqual({
      macIdentityPubKey: KEY_STUDIO,
      macDisplayName: undefined,
      relayUrls: ['wss://x'],
      hostPlatform: undefined
    })
  })

  it('rejects bodies without an identity pubkey or any relay URL', () => {
    expect(parseDiscoveredHost({ relayUrls: ['wss://x'] })).toBeNull()
    expect(parseDiscoveredHost({ protocol: 'taskwraith-e2ee-v1', macIdentityPubKey: KEY_STUDIO, relayUrls: [] })).toBeNull()
    expect(parseDiscoveredHost({ protocol: 'taskwraith-e2ee-v1', macIdentityPubKey: KEY_STUDIO })).toBeNull()
    expect(parseDiscoveredHost({ protocol: 'taskwraith-e2ee-v1', macIdentityPubKey: KEY_STUDIO, relayUrls: 'wss://x' })).toBeNull()
  })

  it('rejects non-objects', () => {
    expect(parseDiscoveredHost(null)).toBeNull()
    expect(parseDiscoveredHost('nope')).toBeNull()
    expect(parseDiscoveredHost(42)).toBeNull()
  })

  it('rejects non-TaskWraith protocol and malformed identity keys', () => {
    expect(parseDiscoveredHost({ protocol: 'other', macIdentityPubKey: KEY_STUDIO, relayUrls: ['wss://x'] })).toBeNull()
    expect(parseDiscoveredHost({ protocol: 'taskwraith-e2ee-v1', macIdentityPubKey: 'PUB', relayUrls: ['wss://x'] })).toBeNull()
    expect(parseDiscoveredHost({ protocol: 'taskwraith-e2ee-v1', macIdentityPubKey: Buffer.alloc(31).toString('base64'), relayUrls: ['wss://x'] })).toBeNull()
  })

  it('bounds optional display/platform fields', () => {
    expect(
      parseDiscoveredHost({
        protocol: 'taskwraith-e2ee-v1',
        macIdentityPubKey: KEY_STUDIO,
        macDisplayName: 'x'.repeat(120),
        relayUrls: ['wss://x'],
        hostPlatform: 'plan9'
      })
    ).toEqual({
      macIdentityPubKey: KEY_STUDIO,
      macDisplayName: undefined,
      relayUrls: ['wss://x'],
      hostPlatform: undefined
    })
  })

  it('drops empty/non-string/unsafe relay entries but keeps valid ones', () => {
    expect(
      parseDiscoveredHost({
        protocol: 'taskwraith-e2ee-v1',
        macIdentityPubKey: KEY_STUDIO,
        relayUrls: ['wss://a', '', 5, '  ', 'ws://192.168.1.2:8787', 'ws://evil.example']
      })?.relayUrls
    ).toEqual(['wss://a', 'ws://192.168.1.2:8787'])
  })
})

describe('probeTailnetHost', () => {
  it('GETs https://<name>/v1/hostinfo and returns the parsed host', async () => {
    const calls: string[] = []
    const fetchImpl: TailscaleFetch = async (url) => {
      calls.push(url)
      return res(hostBody(KEY_STUDIO))
    }
    const host = await probeTailnetHost('studio.ts.net', fetchImpl)
    expect(calls).toEqual(['https://studio.ts.net/v1/hostinfo'])
    expect(host?.macIdentityPubKey).toBe(KEY_STUDIO)
  })

  it('strips a trailing dot from the MagicDNS name', async () => {
    const calls: string[] = []
    const fetchImpl: TailscaleFetch = async (url) => {
      calls.push(url)
      return res(hostBody(KEY_STUDIO))
    }
    await probeTailnetHost('studio.ts.net.', fetchImpl)
    expect(calls[0]).toBe('https://studio.ts.net/v1/hostinfo')
  })

  it('rejects wss relay URLs that do not belong to the probed MagicDNS host', async () => {
    const host = await probeTailnetHost('studio.ts.net', async () =>
      res(hostBody(KEY_STUDIO, { relayUrls: ['wss://evil.example', 'wss://studio.ts.net'] }))
    )
    expect(host?.relayUrls).toEqual(['wss://studio.ts.net'])
    expect(
      await probeTailnetHost('studio.ts.net', async () =>
        res(hostBody(KEY_STUDIO, { relayUrls: ['wss://evil.example'] }))
      )
    ).toBeNull()
  })

  it('returns null on 404, empty body, non-JSON, invalid host, or fetch error', async () => {
    expect(await probeTailnetHost('a', async () => notFound())).toBeNull()
    expect(await probeTailnetHost('a', async () => res(''))).toBeNull()
    expect(await probeTailnetHost('a', async () => res('<html>'))).toBeNull()
    expect(await probeTailnetHost('a', async () => res({ nope: true }))).toBeNull()
    expect(
      await probeTailnetHost('a', async () => {
        throw new Error('ECONNREFUSED')
      })
    ).toBeNull()
  })

  it('returns null for a blank name without fetching', async () => {
    let called = false
    await probeTailnetHost('   ', async () => {
      called = true
      return notFound()
    })
    expect(called).toBe(false)
  })

  it('times out (→ null) when a device hangs instead of answering', async () => {
    // A fetch that never resolves — withTimeout must still settle to null.
    const hangingFetch: TailscaleFetch = () => new Promise<TailscaleHttpResponse>(() => {})
    const host = await probeTailnetHost('slow.ts.net', hangingFetch, 20)
    expect(host).toBeNull()
  })
})

describe('discoverTailnetHosts', () => {
  it('fails (typed) when the OAuth token exchange fails', async () => {
    const { fetchImpl } = makeFetch({ devices: [], hostInfo: {}, tokenOk: false })
    const out = await discoverTailnetHosts({ clientId: 'cid', clientSecret: SECRET, fetchImpl })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toMatch(/Tailscale/)
  })

  it('returns an empty list for a tailnet with no TaskWraith hosts', async () => {
    const { fetchImpl } = makeFetch({
      devices: [{ name: 'printer.ts.net' }, { name: 'nas.ts.net' }],
      hostInfo: { 'printer.ts.net': null, 'nas.ts.net': null }
    })
    const out = await discoverTailnetHosts({ clientId: 'cid', clientSecret: SECRET, fetchImpl })
    expect(out).toEqual({ ok: true, hosts: [] })
  })

  it('drops self + non-TaskWraith devices and keeps the rest', async () => {
    const { fetchImpl } = makeFetch({
      devices: [
        { name: 'self.ts.net' },
        { name: 'printer.ts.net' },
        { name: 'studio.ts.net' },
        { name: 'laptop.ts.net' }
      ],
      hostInfo: {
        'self.ts.net': hostBody(KEY_SELF),
        'printer.ts.net': null,
        'studio.ts.net': hostBody(KEY_STUDIO, { hostPlatform: 'mac' }),
        'laptop.ts.net': hostBody(KEY_LAPTOP, { hostPlatform: 'windows' })
      }
    })
    const out = await discoverTailnetHosts({
      clientId: 'cid',
      clientSecret: SECRET,
      excludeMacIdentityPubKeys: [KEY_SELF],
      fetchImpl
    })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.hosts.map((h) => h.macIdentityPubKey).sort()).toEqual([KEY_LAPTOP, KEY_STUDIO].sort())
      expect(out.hosts.find((h) => h.macIdentityPubKey === KEY_STUDIO)?.hostPlatform).toBe('mac')
    }
  })

  it('collapses the same host appearing under multiple MagicDNS names', async () => {
    const { fetchImpl } = makeFetch({
      devices: [{ name: 'studio.ts.net' }, { name: 'studio-alias.ts.net' }],
      hostInfo: { 'studio.ts.net': hostBody(KEY_DUP), 'studio-alias.ts.net': hostBody(KEY_DUP) }
    })
    const out = await discoverTailnetHosts({ clientId: 'cid', clientSecret: SECRET, fetchImpl })
    expect(out.ok && out.hosts.length).toBe(1)
  })

  it('caps the returned host count at maxHosts', async () => {
    const devices = Array.from({ length: 5 }, (_, i) => ({ name: `h${i}.ts.net` }))
    const hostInfo: Record<string, Record<string, unknown>> = {}
    for (let i = 0; i < 5; i++) hostInfo[`h${i}.ts.net`] = hostBody(Buffer.alloc(32, i + 10).toString('base64'))
    const { fetchImpl } = makeFetch({ devices, hostInfo })
    const out = await discoverTailnetHosts({
      clientId: 'cid',
      clientSecret: SECRET,
      maxHosts: 2,
      fetchImpl
    })
    expect(out.ok && out.hosts.length).toBe(2)
  })

  it('caps the number of devices probed at maxProbes', async () => {
    const devices = Array.from({ length: 10 }, (_, i) => ({ name: `h${i}.ts.net` }))
    const hostInfo: Record<string, Record<string, unknown>> = {}
    for (let i = 0; i < 10; i++) hostInfo[`h${i}.ts.net`] = hostBody(Buffer.alloc(32, i + 20).toString('base64'))
    const { fetchImpl, calls } = makeFetch({ devices, hostInfo })
    await discoverTailnetHosts({ clientId: 'cid', clientSecret: SECRET, maxProbes: 3, fetchImpl })
    const probeCalls = calls.filter((u) => u.endsWith('/v1/hostinfo'))
    expect(probeCalls.length).toBe(3)
  })
})
