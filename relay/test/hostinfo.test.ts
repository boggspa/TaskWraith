import { describe, it, expect } from 'vitest'
import { createRelayServer } from '../src/server'

// /v1/hostinfo is the read-only advertisement that powers QR-optional discovery:
// a tailnet peer probes it to learn whether a machine runs TaskWraith and to
// fetch its PUBLIC bootstrap material. The relay stays dumb — it serves whatever
// the injected provider returns, and 404s when there's none (shared relay).

const SAMPLE = {
  protocol: 'taskwraith-e2ee-v1',
  macIdentityPubKey: 'AAAA',
  macDisplayName: 'Studio',
  relayUrls: ['wss://studio.tailnet.ts.net'],
  hostPlatform: 'mac'
}

describe('relay /v1/hostinfo advertisement', () => {
  it('serves the configured host info as JSON', async () => {
    const relay = await createRelayServer({ port: 0, hostInfo: () => SAMPLE })
    try {
      const r = await fetch(`http://127.0.0.1:${relay.port}/v1/hostinfo`)
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toContain('application/json')
      const j = (await r.json()) as Record<string, unknown>
      expect(j.macIdentityPubKey).toBe('AAAA')
      expect(j.protocol).toBe('taskwraith-e2ee-v1')
      expect(j.hostPlatform).toBe('mac')
    } finally {
      await relay.close()
    }
  })

  it('404s when no provider is configured (shared relay)', async () => {
    const relay = await createRelayServer({ port: 0 })
    try {
      const r = await fetch(`http://127.0.0.1:${relay.port}/v1/hostinfo`)
      expect(r.status).toBe(404)
    } finally {
      await relay.close()
    }
  })

  it('404s when the provider advertises nothing (null)', async () => {
    const relay = await createRelayServer({ port: 0, hostInfo: () => null })
    try {
      const r = await fetch(`http://127.0.0.1:${relay.port}/v1/hostinfo`)
      expect(r.status).toBe(404)
    } finally {
      await relay.close()
    }
  })

  it('rejects non-GET methods', async () => {
    const relay = await createRelayServer({ port: 0, hostInfo: () => SAMPLE })
    try {
      const r = await fetch(`http://127.0.0.1:${relay.port}/v1/hostinfo`, { method: 'POST' })
      expect(r.status).toBe(405)
    } finally {
      await relay.close()
    }
  })
})

describe('relay /v1/beginpair on-demand pairing trigger', () => {
  const BOOTSTRAP = {
    v: 1,
    protocol: 'taskwraith-e2ee-v1',
    sessionId: 'sess-123',
    macIdentityPubKey: 'AAAA',
    macDisplayName: 'Studio',
    relayUrls: ['wss://studio.tailnet.ts.net'],
    hostPlatform: 'mac',
    expiresAt: 9999999999999
  }

  it('mints a pairing session via the callback and returns its bootstrap', async () => {
    let called = 0
    const relay = await createRelayServer({
      port: 0,
      beginPair: async () => {
        called += 1
        return BOOTSTRAP
      }
    })
    try {
      const r = await fetch(`http://127.0.0.1:${relay.port}/v1/beginpair`, { method: 'POST' })
      expect(r.status).toBe(200)
      const j = (await r.json()) as Record<string, unknown>
      expect(j.sessionId).toBe('sess-123')
      expect(j.macIdentityPubKey).toBe('AAAA')
      expect(called).toBe(1)
    } finally {
      await relay.close()
    }
  })

  it('404s when no beginPair callback is configured', async () => {
    const relay = await createRelayServer({ port: 0 })
    try {
      const r = await fetch(`http://127.0.0.1:${relay.port}/v1/beginpair`, { method: 'POST' })
      expect(r.status).toBe(404)
    } finally {
      await relay.close()
    }
  })

  it('503s when a pairing window cannot be opened (null)', async () => {
    const relay = await createRelayServer({ port: 0, beginPair: async () => null })
    try {
      const r = await fetch(`http://127.0.0.1:${relay.port}/v1/beginpair`, { method: 'POST' })
      expect(r.status).toBe(503)
    } finally {
      await relay.close()
    }
  })

  it('503s when the callback throws', async () => {
    const relay = await createRelayServer({
      port: 0,
      beginPair: async () => {
        throw new Error('bridge not ready')
      }
    })
    try {
      const r = await fetch(`http://127.0.0.1:${relay.port}/v1/beginpair`, { method: 'POST' })
      expect(r.status).toBe(503)
    } finally {
      await relay.close()
    }
  })

  it('rejects non-POST methods', async () => {
    const relay = await createRelayServer({ port: 0, beginPair: async () => BOOTSTRAP })
    try {
      const r = await fetch(`http://127.0.0.1:${relay.port}/v1/beginpair`, { method: 'GET' })
      expect(r.status).toBe(405)
    } finally {
      await relay.close()
    }
  })
})
