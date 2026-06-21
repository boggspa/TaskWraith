import { describe, it, expect } from 'vitest'
import { createRelayServer } from '../src/server'
import { createApnsGateway } from '../src/apnsGateway'

// The Tier-2 APNs gateway is an INJECTED capability (RelayOptions.apnsGateway),
// constructed only by the standalone runner (cli.ts). The embedded + self-host
// relay passes none and must stay a blind forwarder that 404s every gateway
// path — exactly like /v1/hostinfo + /v1/beginpair without their providers.

const GATEWAY_PATHS = ['/v1/push/trigger', '/v1/apns/register', '/v1/apns/deregister']

describe('relay Tier-2 APNs gateway routing', () => {
  it('404s gateway paths when no gateway is injected (blind forwarder)', async () => {
    const relay = await createRelayServer({ port: 0 })
    try {
      for (const p of GATEWAY_PATHS) {
        const r = await fetch(`http://127.0.0.1:${relay.port}${p}`, { method: 'POST' })
        expect(r.status).toBe(404)
      }
    } finally {
      await relay.close()
    }
  })

  it('routes owned paths to the injected scaffold gateway (501 until implemented)', async () => {
    const relay = await createRelayServer({ port: 0, apnsGateway: createApnsGateway() })
    try {
      for (const p of GATEWAY_PATHS) {
        const r = await fetch(`http://127.0.0.1:${relay.port}${p}`, { method: 'POST' })
        expect(r.status).toBe(501)
      }
    } finally {
      await relay.close()
    }
  })

  it('falls through to 404 for non-gateway paths even when a gateway is injected', async () => {
    const relay = await createRelayServer({ port: 0, apnsGateway: createApnsGateway() })
    try {
      const r = await fetch(`http://127.0.0.1:${relay.port}/v1/nope`, { method: 'GET' })
      expect(r.status).toBe(404)
    } finally {
      await relay.close()
    }
  })

  it('leaves the hostinfo surface untouched (gateway injection is orthogonal)', async () => {
    const relay = await createRelayServer({ port: 0, apnsGateway: createApnsGateway() })
    try {
      const r = await fetch(`http://127.0.0.1:${relay.port}/v1/hostinfo`)
      expect(r.status).toBe(404)
    } finally {
      await relay.close()
    }
  })
})
