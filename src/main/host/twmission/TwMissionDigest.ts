/**
 * Host Arc Wave 5 — integrity digest helpers for `.twmission` bundles.
 */

import { createHash } from 'node:crypto'

/** Stable JSON stringify: sorted object keys, no whitespace variance. */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeysDeep(obj[key])
    }
    return out
  }
  return value
}

/** Lowercase hex SHA-256 of UTF-8 bytes. */
export function sha256HexUtf8(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Digest the payload portion of a bundle (everything except integrityDigest).
 * Manifest digest field is excluded so the digest is not self-referential.
 */
export function digestTwMissionPayload(payload: unknown): string {
  return sha256HexUtf8(canonicalJsonStringify(payload))
}
