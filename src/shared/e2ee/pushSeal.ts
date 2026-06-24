/*
 * taskwraith-e2ee-v1 — encrypted PUSH envelope (offline, no live session).
 *
 * Run-complete APNs pushes must stay content-blind to Apple / the relay, but the
 * iOS Notification Service Extension needs the rich content on-device. There is
 * no live session at push time, so the session's ephemeral content keys are
 * unavailable. Instead we derive a STATIC shared secret from the two paired
 * identities and seal a tiny plaintext under a per-push subkey.
 *
 * Construction — static-static ECDH (mutual-auth; NO forward secrecy, which is
 * acceptable for low-sensitivity, short-TTL one-liners):
 *   - Each endpoint derives a DEDICATED X25519 agreement keypair from its 32-byte
 *     Ed25519 identity seed via HKDF. This is NOT an Ed25519->X25519 conversion
 *     (that birational map is unimplemented and unneeded) — it's a separate,
 *     domain-separated key whose only input is the same secret seed. Each side
 *     publishes its agreement PUBLIC key to the peer once, over the live E2EE
 *     session, at APNs-token registration.
 *   - Per push: ss = X25519(senderAgreePriv, recipientAgreePub); a random 24B
 *     `salt` derives a FRESH AEAD key K = HKDF(ss, salt) so a long-lived ss never
 *     reuses a (key, nonce) pair; AES-256-GCM with a random 12B nonce; AAD =
 *     "taskwraith-push-v1|<pairId>" binds the blob to its pairing.
 *   - Only the paired Mac+device can derive ss, so decryptability itself proves
 *     provenance — no extra signature is required.
 *
 * The Swift twin (TaskWraithKit/PushSeal.swift) opens this byte-for-byte; the
 * cross-impl vector pins the match on both sides.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  type KeyObject
} from 'crypto'
import {
  b64,
  deriveSharedSecret,
  exportRawX25519PublicKey,
  importRawX25519PublicKey,
  type KeyPair
} from './keys'

/** PKCS#8 DER prefix for an X25519 raw private scalar (OID 1.3.101.110). */
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')
const AGREEMENT_INFO = 'taskwraith-push-agreement-v1'
const AEAD_INFO = 'taskwraith-push-v1 aead'
const AAD_PREFIX = 'taskwraith-push-v1|'
const SALT_LEN = 24
const NONCE_LEN = 12
const TAG_LEN = 16

export interface PushEnvelope {
  /** Envelope version. */
  v: 1
  /** base64 24-byte HKDF salt (derives the per-push AEAD subkey). */
  s: string
  /** base64 12-byte AES-GCM nonce. */
  n: string
  /** base64 ciphertext. */
  ct: string
  /** base64 16-byte AES-GCM tag. */
  tag: string
}

function x25519PrivateKeyFromScalar(scalar: Buffer): KeyObject {
  if (scalar.length !== 32) throw new Error('x25519 scalar must be 32 bytes')
  return createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, scalar]),
    format: 'der',
    type: 'pkcs8'
  })
}

/** Derive the dedicated X25519 push-agreement keypair from a 32-byte identity seed. */
export function deriveAgreementKeyPair(identitySeed: Buffer): KeyPair {
  if (identitySeed.length !== 32) throw new Error('identity seed must be 32 bytes')
  const scalar = Buffer.from(hkdfSync('sha256', identitySeed, Buffer.alloc(0), AGREEMENT_INFO, 32))
  const privateKey = x25519PrivateKeyFromScalar(scalar)
  const publicKey = createPublicKey(privateKey)
  return { publicKey, privateKey }
}

/** The raw 32-byte X25519 agreement public key to publish to the peer once. */
export function deriveAgreementPublicRaw(identitySeed: Buffer): Buffer {
  return exportRawX25519PublicKey(deriveAgreementKeyPair(identitySeed).publicKey)
}

/**
 * Seal `plaintext` to the recipient's agreement public key. `salt`/`nonce` are
 * injectable purely for deterministic cross-impl test vectors; production seals
 * always use fresh random values.
 */
export function sealPush(args: {
  senderIdentitySeed: Buffer
  recipientAgreePubRaw: Buffer
  pairId: string
  plaintext: Buffer
  salt?: Buffer
  nonce?: Buffer
}): PushEnvelope {
  const senderPriv = deriveAgreementKeyPair(args.senderIdentitySeed).privateKey
  const recipientPub = importRawX25519PublicKey(args.recipientAgreePubRaw)
  const ss = deriveSharedSecret(senderPriv, recipientPub)
  const salt = args.salt ?? randomBytes(SALT_LEN)
  const nonce = args.nonce ?? randomBytes(NONCE_LEN)
  if (salt.length !== SALT_LEN) throw new Error('salt must be 24 bytes')
  if (nonce.length !== NONCE_LEN) throw new Error('nonce must be 12 bytes')
  const key = Buffer.from(hkdfSync('sha256', ss, salt, AEAD_INFO, 32))
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from(AAD_PREFIX + args.pairId, 'utf8'))
  const ct = Buffer.concat([cipher.update(args.plaintext), cipher.final()])
  return {
    v: 1,
    s: b64.encode(salt),
    n: b64.encode(nonce),
    ct: b64.encode(ct),
    tag: b64.encode(cipher.getAuthTag())
  }
}

/** Open an envelope sealed by the paired peer. Throws on any failure (the NSE
 * treats any throw as "show the generic fallback", never a partial). */
export function openPush(args: {
  recipientIdentitySeed: Buffer
  senderAgreePubRaw: Buffer
  pairId: string
  envelope: PushEnvelope
}): Buffer {
  if (args.envelope.v !== 1) throw new Error(`unsupported push envelope version ${args.envelope.v}`)
  const recipientPriv = deriveAgreementKeyPair(args.recipientIdentitySeed).privateKey
  const senderPub = importRawX25519PublicKey(args.senderAgreePubRaw)
  const ss = deriveSharedSecret(recipientPriv, senderPub)
  const salt = b64.decode(args.envelope.s)
  const nonce = b64.decode(args.envelope.n)
  const tag = b64.decode(args.envelope.tag)
  if (tag.length !== TAG_LEN) throw new Error('bad tag length')
  const key = Buffer.from(hkdfSync('sha256', ss, salt, AEAD_INFO, 32))
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(Buffer.from(AAD_PREFIX + args.pairId, 'utf8'))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(b64.decode(args.envelope.ct)), decipher.final()])
}
