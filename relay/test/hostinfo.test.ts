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
