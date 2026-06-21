import { describe, it, expect } from 'vitest'
import {
  fetchTailscaleAccessToken,
  listTailnetDevices,
  enumerateTailnetDevices,
  type TailscaleFetch,
  type TailscaleHttpResponse
} from './TailscaleDevices'
import {
  looksLikeTailscaleOAuthClientSecret,
  looksLikeTailscaleAuthKey
} from '../shared/tailscaleAuthKey'

const SECRET = 'tskey-client-abc123-def456ghi789'

function res(status: number, body: string): TailscaleHttpResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => body }
}

/** A fetch stub that routes by URL substring and records calls. */
function stubFetch(routes: {
  token?: TailscaleHttpResponse | (() => Promise<TailscaleHttpResponse>)
  devices?: TailscaleHttpResponse | (() => Promise<TailscaleHttpResponse>)
}): { fetchImpl: TailscaleFetch; calls: Array<{ url: string; init: unknown }> } {
  const calls: Array<{ url: string; init: unknown }> = []
  const fetchImpl: TailscaleFetch = async (url, init) => {
    calls.push({ url, init })
    const pick = url.includes('/oauth/token') ? routes.token : routes.devices
    if (!pick) throw new Error(`unexpected fetch: ${url}`)
    return typeof pick === 'function' ? pick() : pick
  }
  return { fetchImpl, calls }
}

describe('Tailscale OAuth client-secret validator', () => {
  it('accepts a tskey-client- secret and rejects other key classes', () => {
    expect(looksLikeTailscaleOAuthClientSecret(SECRET)).toBe(true)
    expect(looksLikeTailscaleOAuthClientSecret('  ' + SECRET + ' ')).toBe(true)
    expect(looksLikeTailscaleOAuthClientSecret('tskey-auth-abc123def456')).toBe(false)
    expect(looksLikeTailscaleOAuthClientSecret('tskey-api-abc123def456')).toBe(false)
    expect(looksLikeTailscaleOAuthClientSecret('not-a-key')).toBe(false)
    expect(looksLikeTailscaleOAuthClientSecret('tskey-client-with space')).toBe(false)
  })

  it('is disjoint from the node auth-key validator', () => {
    // An OAuth client secret must NOT pass the node auth-key gate (it would be
    // routed down `tailscale up` and fail), and vice versa.
    expect(looksLikeTailscaleAuthKey(SECRET)).toBe(false)
    expect(looksLikeTailscaleOAuthClientSecret('tskey-auth-abc123def456')).toBe(false)
  })
})

describe('fetchTailscaleAccessToken', () => {
  it('rejects a malformed secret without making a request', async () => {
    const { fetchImpl, calls } = stubFetch({})
    const out = await fetchTailscaleAccessToken({
      clientId: 'cid',
      clientSecret: 'garbage',
      fetchImpl
    })
    expect(out.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('returns the access token on success', async () => {
    const { fetchImpl, calls } = stubFetch({
      token: res(200, JSON.stringify({ access_token: 'tok-xyz', expires_in: 3600 }))
    })
    const out = await fetchTailscaleAccessToken({
      clientId: 'cid',
      clientSecret: SECRET,
      fetchImpl
    })
    expect(out).toEqual({ ok: true, accessToken: 'tok-xyz' })
    // Secret goes in the form body, never the URL.
    expect(calls[0].url).not.toContain(SECRET)
    expect((calls[0].init as { body: string }).body).toContain('client_secret=')
  })

  it('surfaces the scope hint on a 401 and never leaks the secret', async () => {
    const { fetchImpl } = stubFetch({
      token: res(401, `unauthorized for ${SECRET}`)
    })
    const out = await fetchTailscaleAccessToken({
      clientId: 'cid',
      clientSecret: SECRET,
      fetchImpl
    })
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.message).toContain('devices:core:read')
      expect(out.message).not.toContain(SECRET)
    }
  })

  it('redacts the secret if a thrown network error echoes it', async () => {
    const fetchImpl: TailscaleFetch = async () => {
      throw new Error(`connect failed with ${SECRET}`)
    }
    const out = await fetchTailscaleAccessToken({ clientId: 'cid', clientSecret: SECRET, fetchImpl })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).not.toContain(SECRET)
  })

  it('fails cleanly when no token is present', async () => {
    const { fetchImpl } = stubFetch({ token: res(200, JSON.stringify({ nope: true })) })
    const out = await fetchTailscaleAccessToken({ clientId: 'cid', clientSecret: SECRET, fetchImpl })
    expect(out.ok).toBe(false)
  })
})

describe('listTailnetDevices', () => {
  const devicesBody = JSON.stringify({
    devices: [
      { id: '1', name: 'studio.tailnet.ts.net.', hostname: 'studio', os: 'macOS' },
      { id: '2', name: 'winbox.tailnet.ts.net', hostname: 'winbox', os: 'windows' },
      { id: '3', hostname: 'nameless', os: 'linux' } // no MagicDNS name → dropped
    ]
  })

  it('parses devices, strips the trailing dot, and drops nameless entries', async () => {
    const { fetchImpl, calls } = stubFetch({ devices: res(200, devicesBody) })
    const out = await listTailnetDevices({ accessToken: 'tok', fetchImpl })
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.devices.map((d) => d.magicDNSName)).toEqual([
        'studio.tailnet.ts.net',
        'winbox.tailnet.ts.net'
      ])
      expect(out.devices[1].os).toBe('windows')
    }
    expect((calls[0].init as { headers: Record<string, string> }).headers.authorization).toBe(
      'Bearer tok'
    )
  })

  it('fails on a non-200', async () => {
    const { fetchImpl } = stubFetch({ devices: res(403, 'forbidden') })
    const out = await listTailnetDevices({ accessToken: 'tok', fetchImpl })
    expect(out.ok).toBe(false)
  })

  it('fails on an unreadable body', async () => {
    const { fetchImpl } = stubFetch({ devices: res(200, 'not json') })
    const out = await listTailnetDevices({ accessToken: 'tok', fetchImpl })
    expect(out.ok).toBe(false)
  })

  it('redacts the access token if a thrown network error echoes it', async () => {
    const token = 'tskey-access-SECRET123'
    const fetchImpl: TailscaleFetch = async () => {
      throw new Error(`connect failed talking to ${token}`)
    }
    const out = await listTailnetDevices({ accessToken: token, fetchImpl })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.message).not.toContain(token)
  })
})

describe('enumerateTailnetDevices', () => {
  it('chains token → device list', async () => {
    const { fetchImpl } = stubFetch({
      token: res(200, JSON.stringify({ access_token: 'tok' })),
      devices: res(200, JSON.stringify({ devices: [{ id: '1', name: 'a.ts.net', hostname: 'a', os: 'linux' }] }))
    })
    const out = await enumerateTailnetDevices({ clientId: 'cid', clientSecret: SECRET, fetchImpl })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.devices).toHaveLength(1)
  })

  it('short-circuits when the token exchange fails (no device call)', async () => {
    const { fetchImpl, calls } = stubFetch({ token: res(401, 'bad') })
    const out = await enumerateTailnetDevices({ clientId: 'cid', clientSecret: SECRET, fetchImpl })
    expect(out.ok).toBe(false)
    expect(calls).toHaveLength(1) // only the token attempt
  })
})
