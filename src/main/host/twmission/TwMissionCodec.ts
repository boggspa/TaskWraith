/**
 * Host Arc Wave 5 — encode/decode `.twmission` JSON bytes.
 */

import { TextEncoder, TextDecoder } from 'node:util'
import { TW_MISSION_MAX_BUNDLE_BYTES, type TwMissionBundle } from './TwMissionTypes'

const utf8 = new TextEncoder()
const utf8dec = new TextDecoder('utf8', { fatal: true })

export type TwMissionCodecResult<T> = { ok: true; value: T } | { ok: false; error: string }
export type TwMissionEncodeResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string }

export function encodeTwMissionBundle(bundle: TwMissionBundle): TwMissionEncodeResult {
  try {
    const text = JSON.stringify(bundle)
    const bytes = utf8.encode(text)
    if (bytes.byteLength > TW_MISSION_MAX_BUNDLE_BYTES) {
      return { ok: false, error: 'bundle exceeds size ceiling' }
    }
    return { ok: true, bytes }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'encode failed'
    }
  }
}

export function decodeTwMissionBundleBytes(bytes: Uint8Array): TwMissionCodecResult<unknown> {
  if (!(bytes instanceof Uint8Array)) {
    return { ok: false, error: 'bytes required' }
  }
  if (bytes.byteLength === 0) {
    return { ok: false, error: 'empty bundle' }
  }
  if (bytes.byteLength > TW_MISSION_MAX_BUNDLE_BYTES) {
    return { ok: false, error: 'bundle exceeds size ceiling' }
  }
  try {
    const text = utf8dec.decode(bytes)
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'decode failed'
    }
  }
}
