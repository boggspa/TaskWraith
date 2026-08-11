import { describe, expect, it } from 'vitest'
import { generateIdentityKeyPair, b64, exportRawEd25519PublicKey } from './keys'
import {
  isApnsDeregisterRequest,
  isApnsRegisterRequest,
  isTriggerRequest,
  pairIdFromIdentityPubKey,
  sharedApnsCollapseId,
  signApnsDeregisterRequest,
  signApnsRegisterRequest,
  signTriggerRequest,
  verifyApnsDeregisterRequest,
  verifyApnsRegisterRequest,
  verifyTriggerRequest
} from './push'

const nonce = () => b64.encode(Buffer.from(crypto.getRandomValues(new Uint8Array(16))))

describe('push gateway protocol (P3)', () => {
  const mac = generateIdentityKeyPair()
  const phone = generateIdentityKeyPair()
  const macKey = b64.encode(exportRawEd25519PublicKey(mac.publicKey))
  const phoneKey = b64.encode(exportRawEd25519PublicKey(phone.publicKey))

  it('round-trips a signed register and rejects any tampered signed field', () => {
    const request = signApnsRegisterRequest(phone, {
      macIdentityPubKey: macKey,
      deviceTokenHex: 'aabbccdd00112233',
      env: 'sandbox',
      notifyFinishedTurns: false,
      issuedAt: Date.now(),
      nonce: nonce()
    })
    expect(isApnsRegisterRequest(request)).toBe(true)
    expect(verifyApnsRegisterRequest(request)).toBe(true)
    // env and the opt-out are INSIDE the signature: flipping either without
    // re-signing must fail — a MITM could otherwise move a device onto the
    // wrong Apple gateway or silently re-enable a disabled opt-out.
    expect(verifyApnsRegisterRequest({ ...request, env: 'production' })).toBe(false)
    expect(verifyApnsRegisterRequest({ ...request, notifyFinishedTurns: true })).toBe(false)
    expect(verifyApnsRegisterRequest({ ...request, deviceTokenHex: 'ffffffffffffffff' })).toBe(
      false
    )
  })

  it('round-trips deregister and trigger, refusing a cross-signed trigger', () => {
    const dereg = signApnsDeregisterRequest(phone, {
      macIdentityPubKey: macKey,
      issuedAt: Date.now(),
      nonce: nonce()
    })
    expect(isApnsDeregisterRequest(dereg)).toBe(true)
    expect(verifyApnsDeregisterRequest(dereg)).toBe(true)

    const trigger = signTriggerRequest(mac, {
      targetIphoneIdentityPubKey: phoneKey,
      reason: 'runComplete',
      threadId: 'thread-1',
      runId: 'run-1',
      collapseId: sharedApnsCollapseId({ reason: 'runComplete', threadId: 'thread-1' }),
      issuedAt: Date.now(),
      nonce: nonce()
    })
    expect(isTriggerRequest(trigger)).toBe(true)
    expect(verifyTriggerRequest(trigger)).toBe(true)
    // A trigger is MAC-signed; substituting the phone as claimed signer must
    // fail even though the phone key is a perfectly valid key.
    expect(verifyTriggerRequest({ ...trigger, macIdentityPubKey: phoneKey })).toBe(false)
    expect(verifyTriggerRequest({ ...trigger, reason: 'runFailed' })).toBe(false)
  })

  it('shape guards fail closed on junk', () => {
    expect(isTriggerRequest(null)).toBe(false)
    expect(isTriggerRequest({ v: 1 })).toBe(false)
    const good = signTriggerRequest(mac, {
      targetIphoneIdentityPubKey: phoneKey,
      reason: 'runComplete',
      collapseId: 'tw1-x',
      issuedAt: Date.now(),
      nonce: nonce()
    })
    expect(isTriggerRequest({ ...good, reason: 'shutdown' })).toBe(false)
    expect(isTriggerRequest({ ...good, collapseId: 'x'.repeat(65) })).toBe(false)
    expect(isTriggerRequest({ ...good, nonce: b64.encode(Buffer.alloc(4)) })).toBe(false)
    expect(isTriggerRequest({ ...good, issuedAt: Number.NaN })).toBe(false)
    expect(isApnsRegisterRequest({ ...good })).toBe(false)
  })

  it('derives the bridge-identical pairID and a header-safe collapse id', () => {
    const pairId = pairIdFromIdentityPubKey(phoneKey)
    expect(pairId).toMatch(/^iphone-[0-9a-f]{16}$/)
    // Deterministic — the relay and the Mac bridge must agree byte-for-byte.
    expect(pairIdFromIdentityPubKey(phoneKey)).toBe(pairId)
    const collapse = sharedApnsCollapseId({ reason: 'runComplete', threadId: 't', runId: 'r' })
    expect(collapse.length).toBeLessThanOrEqual(64)
    expect(collapse).toMatch(/^tw1-[0-9a-f]{56}$/)
    // No raw thread/run identifier may ride in an APNs header.
    expect(collapse).not.toContain('t|r')
  })
})
