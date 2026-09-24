import { describe, expect, it, vi } from 'vitest'
import { ApnsTokenTable } from '../src/apnsTokenTable'
import { createRelayServer } from '../src/server'
import { createApnsGateway, type ApnsGatewaySender } from '../src/apnsGateway'
import { b64, exportRawEd25519PublicKey, generateIdentityKeyPair } from '../../src/shared/e2ee/keys'
import {
  sharedApnsCollapseId,
  signApnsRegisterRequest,
  signTriggerRequest
} from '../../src/shared/e2ee/push'

const nonce = () => b64.encode(Buffer.from(crypto.getRandomValues(new Uint8Array(16))))
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('ApnsTokenTable expiry', () => {
  it('reads an expired entry as absent and reaps it', () => {
    let nowMs = 1_700_000_000_000
    const table = new ApnsTokenTable({ path: '', ttlMs: 1000, now: () => nowMs })
    table.upsert({
      pairID: 'iphone-0123456789abcdef',
      macIdentityPubKey: 'mac',
      deviceTokenHex: 'aabbccdd00112233',
      env: 'sandbox',
      notifyFinishedTurns: true,
      issuedAt: nowMs
    })
    expect(table.get('iphone-0123456789abcdef', 'mac')?.deviceTokenHex).toBe('aabbccdd00112233')
    nowMs += 1001
    expect(table.get('iphone-0123456789abcdef', 'mac')).toBeUndefined()
    expect(table.size()).toBe(0)
  })
})

describe('Tier-2 gateway: expired registrations never deliver (P5)', () => {
  it('suppresses triggers after the token TTL while staying uniformly 200', async () => {
    const mac = generateIdentityKeyPair()
    const phone = generateIdentityKeyPair()
    const macKey = b64.encode(exportRawEd25519PublicKey(mac.publicKey))
    const phoneKey = b64.encode(exportRawEd25519PublicKey(phone.publicKey))
    let nowMs = Date.now()
    const send = vi.fn(async (_args: Parameters<ApnsGatewaySender['send']>[0]) => ({
      delivered: true
    }))
    const relay = await createRelayServer({
      port: 0,
      apnsGateway: createApnsGateway({ sender: { send }, tokenTtlMs: 60_000, now: () => nowMs })
    })
    try {
      const base = `http://127.0.0.1:${relay.port}`
      const registered = await fetch(`${base}/v1/apns/register`, {
        method: 'POST',
        body: JSON.stringify(
          signApnsRegisterRequest(phone, {
            macIdentityPubKey: macKey,
            deviceTokenHex: 'aabbccdd00112233',
            env: 'sandbox',
            notifyFinishedTurns: true,
            issuedAt: nowMs,
            nonce: nonce()
          })
        )
      })
      expect(registered.status).toBe(200)

      const trigger = (issuedAt: number) =>
        signTriggerRequest(mac, {
          targetIphoneIdentityPubKey: phoneKey,
          reason: 'runComplete',
          threadId: `thread-${Math.random().toString(36).slice(2, 8)}`,
          runId: 'run-1',
          collapseId: sharedApnsCollapseId({
            reason: 'runComplete',
            threadId: 't-1',
            runId: 'run-1'
          }),
          issuedAt,
          nonce: nonce()
        })

      // A live registration delivers.
      expect(
        (
          await fetch(`${base}/v1/push/trigger`, {
            method: 'POST',
            body: JSON.stringify(trigger(nowMs))
          })
        ).status
      ).toBe(200)
      await settle()
      expect(send).toHaveBeenCalledTimes(1)

      // Past the token TTL the trigger stays 200 but sends nothing.
      nowMs += 61_000
      expect(
        (
          await fetch(`${base}/v1/push/trigger`, {
            method: 'POST',
            body: JSON.stringify(trigger(nowMs))
          })
        ).status
      ).toBe(200)
      await settle()
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      await relay.close()
    }
  })
})
