import { describe, it, expect } from 'vitest'
import { randomBytes } from 'crypto'
import {
  computeTranscriptHash,
  confirmCodeFromTranscript,
  deriveSessionKeys,
  type TranscriptInputs
} from './keyschedule'
import {
  exportRawX25519PublicKey,
  generateEphemeralKeyPair,
  importRawX25519PublicKey
} from './keys'

function transcriptInputs(over: Partial<TranscriptInputs> = {}): TranscriptInputs {
  return {
    sessionId: 'sess-1',
    clientEphemeralPubKeyB64: 'Yw==',
    serverEphemeralPubKeyB64: 'cw==',
    clientNonceB64: 'bg==',
    serverNonceB64: 'Tg==',
    // Both long-lived identities are bound into the transcript; these fixed
    // stand-ins are enough because the assertions only pin determinism.
    macIdentityPubKeyB64: 'bWFjLWlkZW50aXR5',
    iphoneIdentityPubKeyB64: 'aXBob25lLWlkZW50aXR5',
    ...over
  }
}

describe('transcript hash', () => {
  it('is deterministic and order-sensitive on the ephemerals/nonces', () => {
    const base = computeTranscriptHash(transcriptInputs())
    expect(computeTranscriptHash(transcriptInputs())).toEqual(base)
    // swapping client/server ephemerals must change the hash
    const swapped = computeTranscriptHash(
      transcriptInputs({ clientEphemeralPubKeyB64: 'cw==', serverEphemeralPubKeyB64: 'Yw==' })
    )
    expect(swapped.equals(base)).toBe(false)
  })
})

describe('confirm code', () => {
  it('is a deterministic 6-digit string', () => {
    const hash = computeTranscriptHash(transcriptInputs())
    const code = confirmCodeFromTranscript(hash)
    expect(code).toMatch(/^\d{6}$/)
    expect(confirmCodeFromTranscript(hash)).toBe(code)
  })
})

describe('deriveSessionKeys', () => {
  it('both sides derive identical directional keys', () => {
    const client = generateEphemeralKeyPair()
    const server = generateEphemeralKeyPair()
    const clientNonce = randomBytes(16)
    const serverNonce = randomBytes(16)
    const fromClient = deriveSessionKeys({
      myEphemeralPrivate: client.privateKey,
      peerEphemeralPublic: importRawX25519PublicKey(exportRawX25519PublicKey(server.publicKey)),
      clientNonce,
      serverNonce
    })
    const fromServer = deriveSessionKeys({
      myEphemeralPrivate: server.privateKey,
      peerEphemeralPublic: importRawX25519PublicKey(exportRawX25519PublicKey(client.publicKey)),
      clientNonce,
      serverNonce
    })
    expect(fromClient.macToIphone.length).toBe(32)
    expect(fromClient.macToIphone.equals(fromServer.macToIphone)).toBe(true)
    expect(fromClient.iphoneToMac.equals(fromServer.iphoneToMac)).toBe(true)
    // the two directions must use different keys
    expect(fromClient.macToIphone.equals(fromClient.iphoneToMac)).toBe(false)
  })

  it('different nonces yield different keys (salt binds the nonces)', () => {
    const client = generateEphemeralKeyPair()
    const server = generateEphemeralKeyPair()
    const peer = importRawX25519PublicKey(exportRawX25519PublicKey(server.publicKey))
    const k1 = deriveSessionKeys({
      myEphemeralPrivate: client.privateKey,
      peerEphemeralPublic: peer,
      clientNonce: Buffer.alloc(16, 1),
      serverNonce: Buffer.alloc(16, 2)
    })
    const k2 = deriveSessionKeys({
      myEphemeralPrivate: client.privateKey,
      peerEphemeralPublic: peer,
      clientNonce: Buffer.alloc(16, 9),
      serverNonce: Buffer.alloc(16, 2)
    })
    expect(k1.macToIphone.equals(k2.macToIphone)).toBe(false)
  })
})
