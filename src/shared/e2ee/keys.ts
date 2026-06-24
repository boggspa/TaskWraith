/*
 * taskwraith-e2ee-v1 — key material + raw<->DER conversion.
 *
 * Node's KeyObject speaks SPKI/DER public keys (44 bytes for X25519/Ed25519 =
 * a fixed 12-byte ASN.1 prefix + the 32 raw key bytes). CryptoKit speaks RAW
 * 32-byte keys (`rawRepresentation`). The wire carries RAW keys, so these
 * helpers strip/re-add the DER prefix. The prefixes are verified constants;
 * `exportRaw*` asserts the live DER prefix still matches, so a Node change that
 * altered the encoding fails loudly instead of corrupting the handshake.
 */

import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject
} from 'crypto'

/** SPKI/DER prefix for an X25519 public key (OID 1.3.101.110). Verified 12 bytes. */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
/** SPKI/DER prefix for an Ed25519 public key (OID 1.3.101.112). Verified 12 bytes. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const RAW_KEY_LEN = 32

export interface KeyPair {
  publicKey: KeyObject
  privateKey: KeyObject
}

export function generateEphemeralKeyPair(): KeyPair {
  return generateKeyPairSync('x25519')
}

export function generateIdentityKeyPair(): KeyPair {
  return generateKeyPairSync('ed25519')
}

function exportRaw(publicKey: KeyObject, expectedPrefix: Buffer): Buffer {
  const der = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  if (der.length !== expectedPrefix.length + RAW_KEY_LEN) {
    throw new Error(`Unexpected SPKI length ${der.length}`)
  }
  const prefix = der.subarray(0, expectedPrefix.length)
  if (!prefix.equals(expectedPrefix)) {
    throw new Error(`Unexpected SPKI prefix ${prefix.toString('hex')}`)
  }
  return Buffer.from(der.subarray(expectedPrefix.length))
}

function importRaw(raw: Buffer, prefix: Buffer): KeyObject {
  if (raw.length !== RAW_KEY_LEN) throw new Error(`Raw key must be 32 bytes, got ${raw.length}`)
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' })
}

export function exportRawX25519PublicKey(publicKey: KeyObject): Buffer {
  return exportRaw(publicKey, X25519_SPKI_PREFIX)
}
export function importRawX25519PublicKey(raw: Buffer): KeyObject {
  return importRaw(raw, X25519_SPKI_PREFIX)
}
export function exportRawEd25519PublicKey(publicKey: KeyObject): Buffer {
  return exportRaw(publicKey, ED25519_SPKI_PREFIX)
}
export function importRawEd25519PublicKey(raw: Buffer): KeyObject {
  return importRaw(raw, ED25519_SPKI_PREFIX)
}

/** Raw X25519 ECDH → 32-byte shared secret. Rejects an all-zero output
 * (a contributory-behaviour / small-subgroup tell) before it reaches HKDF —
 * cheap defense-in-depth (the ephemerals are already bound into the signed
 * transcript, so a substituted point also changes the confirm code). */
export function deriveSharedSecret(privateKey: KeyObject, peerPublicKey: KeyObject): Buffer {
  const secret = diffieHellman({ privateKey, publicKey: peerPublicKey })
  if (secret.every((b) => b === 0)) {
    throw new Error('X25519 shared secret is all-zero (invalid peer point)')
  }
  return secret
}

/** Ed25519 detached signature (64 bytes) over `message`. */
export function signEd25519(privateKey: KeyObject, message: Buffer): Buffer {
  return edSign(null, message, privateKey)
}

/** Verify an Ed25519 signature against a public key object. */
export function verifyEd25519(publicKey: KeyObject, message: Buffer, signature: Buffer): boolean {
  try {
    return edVerify(null, message, publicKey, signature)
  } catch {
    return false
  }
}

/** Serialize an Ed25519 private identity key to PKCS#8 DER (for at-rest persistence). */
export function exportPrivateKeyDer(privateKey: KeyObject): Buffer {
  return privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer
}
export function importEd25519PrivateKeyDer(der: Buffer): KeyObject {
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
}

/** The raw 32-byte Ed25519 seed (the JWK `d` value) from a private KeyObject.
 * This is the same 32-byte secret iOS persists as `Curve25519.Signing.PrivateKey
 * .rawRepresentation`, and the input the push-agreement key is HKDF-derived from
 * (see pushSeal.ts). Throws if the key isn't an Ed25519 private key. */
export function exportRawEd25519Seed(privateKey: KeyObject): Buffer {
  const jwk = privateKey.export({ format: 'jwk' }) as { crv?: string; d?: string }
  if (jwk.crv !== 'Ed25519' || !jwk.d) {
    throw new Error('exportRawEd25519Seed: not an Ed25519 private key')
  }
  const seed = Buffer.from(jwk.d, 'base64url')
  if (seed.length !== 32) {
    throw new Error(`exportRawEd25519Seed: expected a 32-byte seed, got ${seed.length}`)
  }
  return seed
}

export const b64 = {
  encode: (buf: Buffer): string => buf.toString('base64'),
  decode: (text: string): Buffer => Buffer.from(text, 'base64')
}
