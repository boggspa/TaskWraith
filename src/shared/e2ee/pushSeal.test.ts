import { describe, expect, it } from 'vitest'
import { deriveAgreementPublicRaw, openPush, sealPush, type PushEnvelope } from './pushSeal'
import { exportRawEd25519Seed, generateIdentityKeyPair } from './keys'

const macSeed = Buffer.alloc(32, 0x11)
const deviceSeed = Buffer.alloc(32, 0x22)
const PAIR_ID = 'iphone-deadbeefcafe0001'

describe('pushSeal', () => {
  it('round-trips: the paired device opens what its Mac sealed', () => {
    const plaintext = Buffer.from(
      JSON.stringify({ t: 'Codex finished', b: '3 files changed · refactor the transcript card' }),
      'utf8'
    )
    const envelope = sealPush({
      senderIdentitySeed: macSeed,
      recipientAgreePubRaw: deriveAgreementPublicRaw(deviceSeed),
      pairId: PAIR_ID,
      plaintext
    })
    const opened = openPush({
      recipientIdentitySeed: deviceSeed,
      senderAgreePubRaw: deriveAgreementPublicRaw(macSeed),
      pairId: PAIR_ID,
      envelope
    })
    expect(opened.equals(plaintext)).toBe(true)
  })

  it('derives a stable agreement public key from a seed (deterministic)', () => {
    expect(deriveAgreementPublicRaw(macSeed).equals(deriveAgreementPublicRaw(macSeed))).toBe(true)
    expect(deriveAgreementPublicRaw(macSeed).equals(deriveAgreementPublicRaw(deviceSeed))).toBe(false)
    expect(deriveAgreementPublicRaw(macSeed)).toHaveLength(32)
  })

  it('seals end-to-end off a real Mac identity seed (exportRawEd25519Seed)', () => {
    const macIdentity = generateIdentityKeyPair()
    const macSeed = exportRawEd25519Seed(macIdentity.privateKey)
    expect(macSeed).toHaveLength(32)
    const env = sealPush({
      senderIdentitySeed: macSeed,
      recipientAgreePubRaw: deriveAgreementPublicRaw(deviceSeed),
      pairId: PAIR_ID,
      plaintext: Buffer.from('done', 'utf8')
    })
    const opened = openPush({
      recipientIdentitySeed: deviceSeed,
      senderAgreePubRaw: deriveAgreementPublicRaw(macSeed),
      pairId: PAIR_ID,
      envelope: env
    })
    expect(opened.toString('utf8')).toBe('done')
  })

  it('rejects a tampered ciphertext (GCM tag)', () => {
    const envelope = sealPush({
      senderIdentitySeed: macSeed,
      recipientAgreePubRaw: deriveAgreementPublicRaw(deviceSeed),
      pairId: PAIR_ID,
      plaintext: Buffer.from('secret summary', 'utf8')
    })
    const ct = Buffer.from(envelope.ct, 'base64')
    ct[0] ^= 0xff
    const tampered: PushEnvelope = { ...envelope, ct: ct.toString('base64') }
    expect(() =>
      openPush({
        recipientIdentitySeed: deviceSeed,
        senderAgreePubRaw: deriveAgreementPublicRaw(macSeed),
        pairId: PAIR_ID,
        envelope: tampered
      })
    ).toThrow()
  })

  it('rejects a blob delivered to the wrong pairing (AAD binds pairId)', () => {
    const envelope = sealPush({
      senderIdentitySeed: macSeed,
      recipientAgreePubRaw: deriveAgreementPublicRaw(deviceSeed),
      pairId: PAIR_ID,
      plaintext: Buffer.from('secret summary', 'utf8')
    })
    expect(() =>
      openPush({
        recipientIdentitySeed: deviceSeed,
        senderAgreePubRaw: deriveAgreementPublicRaw(macSeed),
        pairId: 'iphone-someotherpairing',
        envelope
      })
    ).toThrow()
  })

  it('rejects an envelope from an unpaired sender (wrong agreement key)', () => {
    const envelope = sealPush({
      senderIdentitySeed: macSeed,
      recipientAgreePubRaw: deriveAgreementPublicRaw(deviceSeed),
      pairId: PAIR_ID,
      plaintext: Buffer.from('secret summary', 'utf8')
    })
    const strangerSeed = Buffer.alloc(32, 0x99)
    expect(() =>
      openPush({
        recipientIdentitySeed: deviceSeed,
        senderAgreePubRaw: deriveAgreementPublicRaw(strangerSeed),
        pairId: PAIR_ID,
        envelope
      })
    ).toThrow()
  })

  // CROSS-IMPL VECTOR — must match TaskWraithKit/PushSealTests.swift byte-for-byte.
  // Deterministic seeds + salt + nonce so Node-seal and Swift-open agree exactly.
  it('produces the pinned cross-impl vector (Node seal == Swift open)', () => {
    const salt = Buffer.alloc(24, 0x33)
    const nonce = Buffer.alloc(12, 0x44)
    const plaintext = Buffer.from('{"t":"Codex finished","b":"3 files changed"}', 'utf8')
    const envelope = sealPush({
      senderIdentitySeed: macSeed,
      recipientAgreePubRaw: deriveAgreementPublicRaw(deviceSeed),
      pairId: PAIR_ID,
      plaintext,
      salt,
      nonce
    })
    // Pin the exact bytes both implementations must agree on.
    expect(deriveAgreementPublicRaw(macSeed).toString('base64')).toBe(VECTOR.macAgreePubB64)
    expect(deriveAgreementPublicRaw(deviceSeed).toString('base64')).toBe(VECTOR.deviceAgreePubB64)
    expect(envelope.ct).toBe(VECTOR.ctB64)
    expect(envelope.tag).toBe(VECTOR.tagB64)
    // And the round-trip still holds for the pinned vector.
    const opened = openPush({
      recipientIdentitySeed: deviceSeed,
      senderAgreePubRaw: deriveAgreementPublicRaw(macSeed),
      pairId: PAIR_ID,
      envelope
    })
    expect(opened.toString('utf8')).toBe(plaintext.toString('utf8'))
  })
})

// Filled in from the test's own first run (see scripts note); the Swift twin
// hardcodes the same values. macSeed=0x11*32, deviceSeed=0x22*32, salt=0x33*24,
// nonce=0x44*12, pairId=PAIR_ID, plaintext='{"t":"Codex finished","b":"3 files changed"}'.
const VECTOR = {
  macAgreePubB64: 'i/Qc4tBuMe7vbrJm/d1Yolgav+fosm0AH1/AzFo3gzo=',
  deviceAgreePubB64: 'pYM/oH/HIoY+iuQOxH3DC9L9u+XJoY1Wn9FHqc/TBi8=',
  ctB64: 'Hdt+wOMmBetV7rgtUpqHrpGcxnFHS1OZlnP94dyveJWUAhP4DTmKZTlV12Q=',
  tagB64: 'BKS3ITwl8IlcEpzpF0ZOtg=='
}
