/*
 * Cross-implementation golden vectors.
 *
 * Fixed inputs → fixed byte outputs for every wire-format crypto primitive.
 * The Swift/CryptoKit port (ios/TaskWraithKit) asserts the SAME constants, so
 * this file is the contract that keeps the two implementations byte-identical:
 * if a change to the shared lib alters a transcript hash, confirm code, HKDF
 * key, sealed frame, signature, or resolve signing string, this fails loudly
 * in the public suite — a signal to re-run the iOS vector check.
 *
 * Inputs are deterministic 32-byte seeds wrapped into Node KeyObjects via the
 * standard PKCS#8 prefixes (the same 32 bytes CryptoKit takes as
 * `rawRepresentation`), so both stacks key off identical material. Ed25519
 * signatures and AES-GCM are deterministic, hence exact-equality assertions.
 */

import { describe, it, expect } from 'vitest'
import { createPrivateKey, createPublicKey } from 'crypto'
import {
  b64,
  exportRawEd25519PublicKey,
  exportRawX25519PublicKey,
  signEd25519,
  verifyEd25519,
  deriveSharedSecret
} from './keys'
import { computeTranscriptHash, confirmCodeFromTranscript, deriveSessionKeys } from './keyschedule'
import { seal, open } from './cipher'
import { registerSigningString, resolveSigningString } from './resolve'
import {
  apnsDeregisterSigningString,
  apnsRegisterSigningString,
  sharedApnsCollapseId,
  triggerSigningString
} from './push'
import { createHash } from 'crypto'

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex')
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex')
const edPriv = (seed: Buffer) =>
  createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' })
const xPriv = (seed: Buffer) =>
  createPrivateKey({ key: Buffer.concat([X_PKCS8, seed]), format: 'der', type: 'pkcs8' })
const fill = (byte: number) => Buffer.alloc(32, byte)

// Fixed material — keep in lockstep with ios/TaskWraithKit/Tests vectors.
const macEphSeed = fill(0x11)
const iphoneEphSeed = fill(0x22)
const macIdSeed = fill(0x33)
const iphoneIdSeed = fill(0x44)
const clientNonce = Buffer.alloc(16, 0xaa)
const serverNonce = Buffer.alloc(16, 0xbb)
const sessionId = 'vector-session'

const macEphPriv = xPriv(macEphSeed)
const macEphPub = createPublicKey(macEphPriv)
const iphoneEphPriv = xPriv(iphoneEphSeed)
const iphoneEphPub = createPublicKey(iphoneEphPriv)
const macIdPriv = edPriv(macIdSeed)
const macIdPub = createPublicKey(macIdPriv)
const iphoneIdPub = createPublicKey(edPriv(iphoneIdSeed))

describe('cross-impl golden vectors (must match ios/TaskWraithKit)', () => {
  it('raw public keys derive from the fixed seeds', () => {
    expect(exportRawX25519PublicKey(macEphPub).toString('hex')).toBe(
      '7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'
    )
    expect(exportRawX25519PublicKey(iphoneEphPub).toString('hex')).toBe(
      '0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20'
    )
    expect(exportRawEd25519PublicKey(macIdPub).toString('hex')).toBe(
      '17cb79fb2b4120f2b1ec65e4198d6e08b28e813feb01e4a400839b85e18080ce'
    )
    expect(exportRawEd25519PublicKey(iphoneIdPub).toString('hex')).toBe(
      'd759793bbc13a2819a827c76adb6fba8a49aee007f49f2d0992d99b825ad2c48'
    )
  })

  const transcript = computeTranscriptHash({
    sessionId,
    clientEphemeralPubKeyB64: b64.encode(exportRawX25519PublicKey(iphoneEphPub)),
    serverEphemeralPubKeyB64: b64.encode(exportRawX25519PublicKey(macEphPub)),
    clientNonceB64: b64.encode(clientNonce),
    serverNonceB64: b64.encode(serverNonce),
    // v2 transcript: both long-lived identities are bound (identity-splice
    // defense). Golden values regenerated 2026-06-11; the Swift
    // InteropVectorsTests carry the SAME values.
    macIdentityPubKeyB64: b64.encode(exportRawEd25519PublicKey(macIdPub)),
    iphoneIdentityPubKeyB64: b64.encode(exportRawEd25519PublicKey(iphoneIdPub))
  })

  it('transcript hash + confirm code', () => {
    expect(transcript.toString('hex')).toBe(
      '9b9764575b8a73a88377d24588d88331e84bc7969972b2a50019fe1c0fdb264f'
    )
    expect(confirmCodeFromTranscript(transcript)).toBe('390103')
  })

  it('X25519 shared secret agrees both directions', () => {
    const a = deriveSharedSecret(macEphPriv, iphoneEphPub)
    const b = deriveSharedSecret(iphoneEphPriv, macEphPub)
    expect(a.equals(b)).toBe(true)
    expect(a.toString('hex')).toBe(
      '9e004098efc091d4ec2663b4e9f5cfd4d7064571690b4bea97ab146ab9f35056'
    )
  })

  it('HKDF directional session keys', () => {
    const keys = deriveSessionKeys({
      myEphemeralPrivate: macEphPriv,
      peerEphemeralPublic: iphoneEphPub,
      clientNonce,
      serverNonce
    })
    expect(keys.macToIphone.toString('hex')).toBe(
      'c328ecb05aed3e0c14dc8b25c0f2a4abf4300495c6a158f586d0833bd0b30a0c'
    )
    expect(keys.iphoneToMac.toString('hex')).toBe(
      '9a72c741f010d393760f6fab2eb408d047e8014d0d5bda52c50ffb2171a863f0'
    )
  })

  const macToIphone = Buffer.from(
    'c328ecb05aed3e0c14dc8b25c0f2a4abf4300495c6a158f586d0833bd0b30a0c',
    'hex'
  )
  const plaintext = Buffer.from(
    JSON.stringify({ msgId: 1, method: 'bridge.runEvent', params: { n: 42 } }),
    'utf8'
  )

  it('AES-256-GCM seal produces the golden nonce/ct/tag (and opens back)', () => {
    const sealed = seal(macToIphone, 'mac->iphone', sessionId, 0, plaintext)
    expect(sealed.nonce.toString('hex')).toBe('000000010000000000000000')
    expect(sealed.ct.toString('hex')).toBe(
      '9eaacd940b78937c9689aa5b22b9d8151f7da06583bb95e9b4f72329fe2ac832066a363840346e697e774e5bbea2ddaa4d5512d17ed28f6d'
    )
    expect(sealed.tag.toString('hex')).toBe('e02aef7c8b154d6fce01878e3e6d649d')
    expect(open(macToIphone, 'mac->iphone', sessionId, 0, sealed).equals(plaintext)).toBe(true)
  })

  it('Ed25519 signature over the transcript is deterministic + verifies', () => {
    const sig = signEd25519(macIdPriv, transcript)
    expect(sig.toString('hex')).toBe(
      '7e293c15123713d7392c0e4902313b51aca0d7fb5bb37cee64ac7e76d1e556cf5e6067f5c380ddd7600a5e7bc44a40ebc5db72d0a5fe838d9997d3f2e5635708'
    )
    expect(verifyEd25519(macIdPub, transcript, sig)).toBe(true)
  })

  it('resolve signing strings are byte-stable', () => {
    expect(
      registerSigningString({
        macIdentityPubKey: b64.encode(exportRawEd25519PublicKey(macIdPub)),
        sessionId,
        allowedPeers: [b64.encode(exportRawEd25519PublicKey(iphoneIdPub))],
        issuedAt: 1_700_000_000_000,
        ttlMs: 3_600_000
      })
    ).toBe(
      'taskwraith-resolve-v1|register|F8t5+ytBIPKx7GXkGY1uCLKOgT/rAeSkAIObheGAgM4=|vector-session|11l5O7wTooGagnx2rbb7qKSa7gB/SfLQmS2ZuCWtLEg=|1700000000000|3600000'
    )
    expect(
      resolveSigningString({
        macIdentityPubKey: b64.encode(exportRawEd25519PublicKey(macIdPub)),
        iphoneIdentityPubKey: b64.encode(exportRawEd25519PublicKey(iphoneIdPub)),
        nonce: b64.encode(Buffer.alloc(16, 0xcc)),
        issuedAt: 1_700_000_000_000
      })
    ).toBe(
      'taskwraith-resolve-v1|resolve|F8t5+ytBIPKx7GXkGY1uCLKOgT/rAeSkAIObheGAgM4=|11l5O7wTooGagnx2rbb7qKSa7gB/SfLQmS2ZuCWtLEg=|zMzMzMzMzMzMzMzMzMzMzA==|1700000000000'
    )
  })

  it('push gateway signing strings are byte-stable (P3 lock)', () => {
    // These vectors AUTHOR the byte layout the design doc left unwritten —
    // Swift InteropVectorsTests carries the SAME literals. Booleans encode as
    // String(boolean) ('true'/'false'), which is also Swift's String(Bool).
    const macKey = b64.encode(exportRawEd25519PublicKey(macIdPub))
    const phoneKey = b64.encode(exportRawEd25519PublicKey(iphoneIdPub))
    const nonce = b64.encode(Buffer.alloc(16, 0xdd))
    expect(
      apnsRegisterSigningString({
        macIdentityPubKey: macKey,
        iphoneIdentityPubKey: phoneKey,
        deviceTokenHex: 'aabbccdd00112233',
        env: 'sandbox',
        notifyFinishedTurns: true,
        issuedAt: 1_700_000_000_000,
        nonce
      })
    ).toBe(
      `taskwraith-push-trigger-v1|apns-register|F8t5+ytBIPKx7GXkGY1uCLKOgT/rAeSkAIObheGAgM4=|11l5O7wTooGagnx2rbb7qKSa7gB/SfLQmS2ZuCWtLEg=|aabbccdd00112233|sandbox|true|1700000000000|${nonce}`
    )
    expect(
      apnsDeregisterSigningString({
        macIdentityPubKey: macKey,
        iphoneIdentityPubKey: phoneKey,
        issuedAt: 1_700_000_000_000,
        nonce
      })
    ).toBe(
      `taskwraith-push-trigger-v1|apns-deregister|${macKey}|${phoneKey}|1700000000000|${nonce}`
    )
    expect(
      triggerSigningString({
        macIdentityPubKey: macKey,
        targetIphoneIdentityPubKey: phoneKey,
        reason: 'runComplete',
        threadId: 'thread-9',
        runId: 'run-3',
        collapseId: 'tw1-abc',
        issuedAt: 1_700_000_000_000,
        nonce
      })
    ).toBe(
      `taskwraith-push-trigger-v1|trigger|${macKey}|${phoneKey}|runComplete|thread-9|run-3||tw1-abc|1700000000000|${nonce}`
    )
    // The one derivation both tiers and the relay coalesce key share.
    expect(sharedApnsCollapseId({ reason: 'runComplete', threadId: 't-1', runId: 'r-1' })).toBe(
      `tw1-${createHash('sha256').update('runComplete|t-1|r-1').digest('hex').slice(0, 56)}`
    )
    expect(
      sharedApnsCollapseId({ reason: 'runComplete', threadId: 't-1', runId: 'r-1' }).length
    ).toBeLessThanOrEqual(64)
  })
})
