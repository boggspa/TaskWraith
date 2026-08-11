import { describe, expect, it, vi } from 'vitest'
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

const mac = generateIdentityKeyPair()
const phone = generateIdentityKeyPair()
const macKey = b64.encode(exportRawEd25519PublicKey(mac.publicKey))
const phoneKey = b64.encode(exportRawEd25519PublicKey(phone.publicKey))

function trigger(overrides: Partial<Parameters<typeof signTriggerRequest>[1]> = {}) {
  return signTriggerRequest(mac, {
    targetIphoneIdentityPubKey: phoneKey,
    reason: 'runComplete',
    threadId: `thread-${Math.random().toString(36).slice(2, 8)}`,
    runId: 'run-1',
    collapseId: sharedApnsCollapseId({ reason: 'runComplete', threadId: 't-1', runId: 'run-1' }),
    issuedAt: Date.now(),
    nonce: nonce(),
    ...overrides
  })
}

async function startGateway(sender: ApnsGatewaySender, bucket?: { capacity: number; refillPerMinute: number }) {
  const relay = await createRelayServer({
    port: 0,
    apnsGateway: createApnsGateway({ sender, ...(bucket ? { triggerBucket: bucket } : {}) })
  })
  const base = `http://127.0.0.1:${relay.port}`
  const registered = await fetch(`${base}/v1/apns/register`, {
    method: 'POST',
    body: JSON.stringify(
      signApnsRegisterRequest(phone, {
        macIdentityPubKey: macKey,
        deviceTokenHex: 'aabbccdd00112233',
        env: 'sandbox',
        notifyFinishedTurns: true,
        issuedAt: Date.now(),
        nonce: nonce()
      })
    )
  })
  expect(registered.status).toBe(200)
  return { relay, base }
}

describe('Tier-2 gateway: /v1/push/trigger (P5)', () => {
  it('delivers routing-only alerts with the shared collapse id, uniformly 200', async () => {
    const send = vi.fn(async () => ({ delivered: true }))
    const { relay, base } = await startGateway({ send })
    try {
      const response = await fetch(`${base}/v1/push/trigger`, {
        method: 'POST',
        body: JSON.stringify(trigger())
      })
      expect(response.status).toBe(200)
      await settle()
      expect(send).toHaveBeenCalledTimes(1)
      const args = send.mock.calls[0][0]
      expect(args.deviceTokenHex).toBe('aabbccdd00112233')
      expect(args.env).toBe('sandbox')
      expect(args.collapseId).toMatch(/^tw1-[0-9a-f]{56}$/)
      // Routing-only body: no thread id, no run id, no title from the Mac.
      const body = JSON.stringify(args.body)
      expect(body).not.toContain('thread-')
      expect(body).not.toContain('run-1')
    } finally {
      await relay.close()
    }
  })

  it('rejects any unknown field outright — the relay is the last gate before Apple', async () => {
    const send = vi.fn(async () => ({ delivered: true }))
    const { relay, base } = await startGateway({ send })
    try {
      const smuggled = { ...trigger(), workspaceId: 'ws-1' }
      const response = await fetch(`${base}/v1/push/trigger`, {
        method: 'POST',
        body: JSON.stringify(smuggled)
      })
      expect(response.status).toBe(400)
      await settle()
      expect(send).not.toHaveBeenCalled()
    } finally {
      await relay.close()
    }
  })

  it('coalesces repeat triggers for one [pair, thread, reason] inside the window', async () => {
    const send = vi.fn(async () => ({ delivered: true }))
    const { relay, base } = await startGateway({ send })
    try {
      const first = trigger({ threadId: 'thread-co' })
      const second = trigger({ threadId: 'thread-co' })
      expect((await fetch(`${base}/v1/push/trigger`, { method: 'POST', body: JSON.stringify(first) })).status).toBe(200)
      const repeat = await fetch(`${base}/v1/push/trigger`, {
        method: 'POST',
        body: JSON.stringify(second)
      })
      expect(repeat.status).toBe(200)
      expect((await repeat.json()).coalesced).toBe(true)
      await settle()
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      await relay.close()
    }
  })

  it('answers 429 once the per-Mac bucket is dry — the amplification guard', async () => {
    const send = vi.fn(async () => ({ delivered: true }))
    const { relay, base } = await startGateway({ send }, { capacity: 2, refillPerMinute: 0 })
    try {
      for (const expected of [200, 200, 429]) {
        const response = await fetch(`${base}/v1/push/trigger`, {
          method: 'POST',
          body: JSON.stringify(trigger())
        })
        expect(response.status).toBe(expected)
      }
    } finally {
      await relay.close()
    }
  })

  it('reaps ONLY on Unregistered; BadDeviceToken keeps the registration', async () => {
    let reason = 'BadDeviceToken'
    const send = vi.fn(async () => ({ delivered: false, reason }))
    const { relay, base } = await startGateway({ send })
    try {
      expect((await fetch(`${base}/v1/push/trigger`, { method: 'POST', body: JSON.stringify(trigger()) })).status).toBe(200)
      await settle()
      // BadDeviceToken kept the entry — a second trigger still sends.
      expect((await fetch(`${base}/v1/push/trigger`, { method: 'POST', body: JSON.stringify(trigger()) })).status).toBe(200)
      await settle()
      expect(send).toHaveBeenCalledTimes(2)

      reason = 'Unregistered'
      expect((await fetch(`${base}/v1/push/trigger`, { method: 'POST', body: JSON.stringify(trigger()) })).status).toBe(200)
      await settle()
      expect(send).toHaveBeenCalledTimes(3)
      // Unregistered reaped it: the next trigger accepts (uniform) but sends nothing.
      expect((await fetch(`${base}/v1/push/trigger`, { method: 'POST', body: JSON.stringify(trigger()) })).status).toBe(200)
      await settle()
      expect(send).toHaveBeenCalledTimes(3)
    } finally {
      await relay.close()
    }
  })

  it('honors the signed notifyFinishedTurns opt-out', async () => {
    const send = vi.fn(async () => ({ delivered: true }))
    const relay = await createRelayServer({
      port: 0,
      apnsGateway: createApnsGateway({ sender: { send } })
    })
    try {
      const base = `http://127.0.0.1:${relay.port}`
      await fetch(`${base}/v1/apns/register`, {
        method: 'POST',
        body: JSON.stringify(
          signApnsRegisterRequest(phone, {
            macIdentityPubKey: macKey,
            deviceTokenHex: 'aabbccdd00112233',
            env: 'sandbox',
            notifyFinishedTurns: false,
            issuedAt: Date.now(),
            nonce: nonce()
          })
        )
      })
      expect((await fetch(`${base}/v1/push/trigger`, { method: 'POST', body: JSON.stringify(trigger()) })).status).toBe(200)
      await settle()
      expect(send).not.toHaveBeenCalled()
    } finally {
      await relay.close()
    }
  })
})
