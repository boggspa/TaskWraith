import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRelayServer } from '../src/server'
import { createApnsGateway } from '../src/apnsGateway'
import { b64, exportRawEd25519PublicKey, generateIdentityKeyPair } from '../../src/shared/e2ee/keys'
import { signApnsDeregisterRequest, signApnsRegisterRequest } from '../../src/shared/e2ee/push'

const nonce = () => b64.encode(Buffer.from(crypto.getRandomValues(new Uint8Array(16))))

const mac = generateIdentityKeyPair()
const phone = generateIdentityKeyPair()
const macKey = b64.encode(exportRawEd25519PublicKey(mac.publicKey))

function registerBody(issuedAt = Date.now(), overrides: Record<string, unknown> = {}) {
  return {
    ...signApnsRegisterRequest(phone, {
      macIdentityPubKey: macKey,
      deviceTokenHex: 'aabbccdd00112233',
      env: 'sandbox',
      notifyFinishedTurns: true,
      issuedAt,
      nonce: nonce()
    }),
    ...overrides
  }
}

describe('Tier-2 gateway: /v1/apns/register + /v1/apns/deregister (P4)', () => {
  it('registers, persists durably, enforces issuedAt monotonicity, and deregisters', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apns-table-'))
    const tablePath = join(dir, 'bridge', 'apns-tokens.json')
    const relay = await createRelayServer({
      port: 0,
      apnsGateway: createApnsGateway({ tokenTablePath: tablePath })
    })
    try {
      const base = `http://127.0.0.1:${relay.port}`
      const first = await fetch(`${base}/v1/apns/register`, {
        method: 'POST',
        body: JSON.stringify(registerBody(Date.now()))
      })
      expect(first.status).toBe(200)
      expect(existsSync(tablePath)).toBe(true)
      const persisted = JSON.parse(readFileSync(tablePath, 'utf8')) as {
        entries: Array<Record<string, unknown>>
      }
      expect(persisted.entries).toHaveLength(1)
      // The table stores the ROUTING hash, never the phone identity key.
      expect(JSON.stringify(persisted)).not.toContain(
        b64.encode(exportRawEd25519PublicKey(phone.publicKey))
      )
      expect(persisted.entries[0].pairID).toMatch(/^iphone-[0-9a-f]{16}$/)

      // An OLDER issuedAt replay must never roll a live token back.
      const stale = await fetch(`${base}/v1/apns/register`, {
        method: 'POST',
        body: JSON.stringify(registerBody(Date.now() - 60_000))
      })
      expect(stale.status).toBe(409)

      const dereg = await fetch(`${base}/v1/apns/deregister`, {
        method: 'POST',
        body: JSON.stringify(
          signApnsDeregisterRequest(phone, {
            macIdentityPubKey: macKey,
            issuedAt: Date.now(),
            nonce: nonce()
          })
        )
      })
      expect(dereg.status).toBe(200)
      const after = JSON.parse(readFileSync(tablePath, 'utf8')) as { entries: unknown[] }
      expect(after.entries).toHaveLength(0)
    } finally {
      await relay.close()
    }
  })

  it('answers uniformly on tamper, replay, and stale clocks — never which check failed', async () => {
    const relay = await createRelayServer({ port: 0, apnsGateway: createApnsGateway({}) })
    try {
      const base = `http://127.0.0.1:${relay.port}`
      // Tampered signed field → uniform 404 (same as unknown route shape).
      const tampered = registerBody(Date.now(), { env: 'production' })
      const bad = await fetch(`${base}/v1/apns/register`, {
        method: 'POST',
        body: JSON.stringify(tampered)
      })
      expect(bad.status).toBe(404)
      expect(await bad.text()).not.toContain('sig')

      // Nonce replay: identical body twice → second 400.
      const body = registerBody()
      const okFirst = await fetch(`${base}/v1/apns/register`, {
        method: 'POST',
        body: JSON.stringify(body)
      })
      expect(okFirst.status).toBe(200)
      const replay = await fetch(`${base}/v1/apns/register`, {
        method: 'POST',
        body: JSON.stringify(body)
      })
      expect(replay.status).toBe(400)

      // A clock far outside the freshness window → 400.
      const old = await fetch(`${base}/v1/apns/register`, {
        method: 'POST',
        body: JSON.stringify(registerBody(Date.now() - 10 * 60 * 1000))
      })
      expect(old.status).toBe(400)
    } finally {
      await relay.close()
    }
  })
})
