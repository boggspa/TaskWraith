import { describe, expect, it, vi } from 'vitest'
import {
  createAdvertisableRelayCache,
  probeRelayFrontDoor,
  probeUrlForRelay,
  selectAdvertisableRelayUrls,
  type AdvertisableRelaySelection
} from './relayReachability'

describe('probeUrlForRelay', () => {
  it('maps wss:// to https:// preserving host and port', () => {
    const url = probeUrlForRelay('wss://mac.tailnet.ts.net')
    expect(url?.protocol).toBe('https:')
    expect(url?.host).toBe('mac.tailnet.ts.net')
    expect(url?.pathname).toBe('/')

    const withPort = probeUrlForRelay('wss://relay.example:8443/v1/session/abc?x=1')
    expect(withPort?.protocol).toBe('https:')
    expect(withPort?.port).toBe('8443')
    // The probe dials the origin, not a session path.
    expect(withPort?.pathname).toBe('/')
    expect(withPort?.search).toBe('')
  })

  it('maps ws:// to http://', () => {
    const url = probeUrlForRelay('ws://192.168.1.20:8787')
    expect(url?.protocol).toBe('http:')
    expect(url?.host).toBe('192.168.1.20:8787')

    const tailnet = probeUrlForRelay('ws://100.99.131.73:8787')
    expect(tailnet?.protocol).toBe('http:')
    expect(tailnet?.host).toBe('100.99.131.73:8787')
  })

  it('rejects non-websocket and unparseable URLs', () => {
    expect(probeUrlForRelay('https://example.com')).toBeNull()
    expect(probeUrlForRelay('not a url')).toBeNull()
  })
})

describe('probeRelayFrontDoor', () => {
  it('treats a non-gateway HTTP response as reachable — 404 included', async () => {
    const request = vi.fn(async () => ({ statusCode: 404 }))
    const result = await probeRelayFrontDoor('wss://mac.tailnet.ts.net', { request })
    expect(result.reachable).toBe(true)
    expect(result.detail).toBe('HTTP 404 from mac.tailnet.ts.net')
    expect(request).toHaveBeenCalledTimes(1)
    const [url, timeoutMs] = request.mock.calls[0] as unknown as [URL, number]
    expect(url.protocol).toBe('https:')
    expect(timeoutMs).toBe(3_000)
  })

  it('rejects a gateway 502/504 — tailscale serve up but the relay behind it is dead', async () => {
    for (const statusCode of [502, 504]) {
      const result = await probeRelayFrontDoor('wss://mac.tailnet.ts.net', {
        request: vi.fn(async () => ({ statusCode }))
      })
      expect(result.reachable).toBe(false)
      expect(result.detail).toMatch(new RegExp(`HTTP ${statusCode}.*relay is down`))
    }
  })

  it('keeps 503 (relay at capacity) and other non-gateway statuses reachable', async () => {
    for (const statusCode of [200, 426, 503]) {
      const result = await probeRelayFrontDoor('wss://mac.tailnet.ts.net', {
        request: vi.fn(async () => ({ statusCode }))
      })
      expect(result.reachable).toBe(true)
      expect(result.detail).toBe(`HTTP ${statusCode} from mac.tailnet.ts.net`)
    }
  })

  it('surfaces the dial failure verbatim (the -1004 family)', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 100.99.131.73:443'), {
      code: 'ECONNREFUSED'
    })
    const result = await probeRelayFrontDoor('wss://mac.tailnet.ts.net', {
      request: vi.fn(async () => {
        throw refused
      })
    })
    expect(result.reachable).toBe(false)
    expect(result.detail).toBe('ECONNREFUSED: connect ECONNREFUSED 100.99.131.73:443')
  })

  it('reports timeouts with the configured budget', async () => {
    const result = await probeRelayFrontDoor('ws://192.168.1.20:8787', {
      timeoutMs: 1_500,
      request: vi.fn(async (_url: URL, timeoutMs: number) => {
        throw new Error(`timed out after ${timeoutMs}ms`)
      })
    })
    expect(result.reachable).toBe(false)
    expect(result.detail).toBe('timed out after 1500ms')
  })

  it('fails closed on a non-websocket URL without dialing', async () => {
    const request = vi.fn(async () => ({ statusCode: 200 }))
    const result = await probeRelayFrontDoor('https://example.com', { request })
    expect(result.reachable).toBe(false)
    expect(result.detail).toMatch(/not a ws:\/\/ or wss:\/\/ URL/)
    expect(request).not.toHaveBeenCalled()
  })
})

describe('selectAdvertisableRelayUrls', () => {
  const probeMap = (
    map: Record<string, { reachable: boolean; detail: string }>
  ): typeof probeRelayFrontDoor => {
    return async (url) => map[url] ?? { reachable: false, detail: 'unknown candidate' }
  }

  it('keeps every answering door in caller order', async () => {
    const selection = await selectAdvertisableRelayUrls(
      ['ws://192.168.0.147:8787', 'wss://mac.tailnet.ts.net'],
      {
        probe: probeMap({
          'ws://192.168.0.147:8787': { reachable: true, detail: 'HTTP 404' },
          'wss://mac.tailnet.ts.net': { reachable: true, detail: 'HTTP 404' }
        })
      }
    )
    expect(selection.advertisable).toEqual(['ws://192.168.0.147:8787', 'wss://mac.tailnet.ts.net'])
    expect(selection.warnings).toEqual([])
  })

  it('drops dead optional WSS while keeping LAN and direct Tailscale pairing alive', async () => {
    const selection = await selectAdvertisableRelayUrls(
      [
        'ws://192.168.0.147:8787',
        'ws://100.99.131.73:8787',
        'wss://mac.tailnet.ts.net'
      ],
      {
        probe: probeMap({
          'ws://192.168.0.147:8787': { reachable: true, detail: 'HTTP 404' },
          'ws://100.99.131.73:8787': { reachable: true, detail: 'HTTP 404' },
          'wss://mac.tailnet.ts.net': {
            reachable: false,
            detail: 'ECONNREFUSED: connect ECONNREFUSED 100.99.131.73:443'
          }
        })
      }
    )
    expect(selection.advertisable).toEqual([
      'ws://192.168.0.147:8787',
      'ws://100.99.131.73:8787'
    ])
    expect(selection.warnings).toEqual([
      "wss://mac.tailnet.ts.net isn't answering (ECONNREFUSED: connect ECONNREFUSED 100.99.131.73:443)"
    ])
  })

  it('returns an empty advertisable set when nothing answers', async () => {
    const selection = await selectAdvertisableRelayUrls(
      ['ws://192.168.0.147:8787', 'wss://mac.tailnet.ts.net'],
      { probe: probeMap({}) }
    )
    expect(selection.advertisable).toEqual([])
    expect(selection.warnings).toHaveLength(2)
  })
})

describe('createAdvertisableRelayCache', () => {
  const lan = 'ws://192.168.0.147:8787'
  const wss = 'wss://mac.tailnet.ts.net'

  it('drops dead doors once probed (the off-LAN case: keep wss, drop the dead LAN door)', async () => {
    const probe = vi.fn(async () => ({ advertisable: [wss], warnings: ['lan dead'] }))
    const cache = createAdvertisableRelayCache({ probe, now: () => 1000 })
    await cache.refresh([lan, wss])
    expect(cache.readSync([lan, wss])).toEqual([wss])
  })

  it('cold readSync returns the raw candidates (never hides the host) but kicks a probe', () => {
    const probe = vi.fn(() => new Promise<AdvertisableRelaySelection>(() => {})) // never resolves
    const cache = createAdvertisableRelayCache({ probe, now: () => 1000 })
    expect(cache.readSync([lan, wss])).toEqual([lan, wss])
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('serves from cache within the TTL and re-probes once past it', async () => {
    let t = 1000
    const probe = vi.fn(async () => ({ advertisable: [wss], warnings: [] }))
    const cache = createAdvertisableRelayCache({ probe, ttlMs: 5000, now: () => t })
    await cache.refresh([lan, wss])
    expect(probe).toHaveBeenCalledTimes(1)
    t = 4000
    cache.readSync([lan, wss]) // within TTL → no re-probe
    expect(probe).toHaveBeenCalledTimes(1)
    t = 7000
    cache.readSync([lan, wss]) // stale → background re-probe
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('falls back to the raw candidates when every door is dead (host stays discoverable)', async () => {
    const probe = vi.fn(async () => ({ advertisable: [], warnings: ['all dead'] }))
    const cache = createAdvertisableRelayCache({ probe, now: () => 1000 })
    await cache.refresh([lan, wss])
    expect(cache.readSync([lan, wss])).toEqual([lan, wss])
  })

  it('a probe rejection does not poison the cache or hide the host', async () => {
    const probe = vi.fn(async () => {
      throw new Error('boom')
    })
    const cache = createAdvertisableRelayCache({ probe, now: () => 1000 })
    const sel = await cache.refresh([lan, wss])
    expect(sel.advertisable).toEqual([lan, wss])
    expect(cache.readSync([lan, wss])).toEqual([lan, wss])
  })

  it('an empty candidate list advertises nothing', () => {
    const cache = createAdvertisableRelayCache({ probe: vi.fn(), now: () => 1000 })
    expect(cache.readSync([])).toEqual([])
  })
})
