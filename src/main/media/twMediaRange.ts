import fs from 'fs'
import path from 'path'
import {
  THREAD_MEDIA_CHUNK_MAX_BYTES,
  transcriptMediaAssetPath
} from '../services/TranscriptMediaAssetStore'
import { TW_MEDIA_SCHEME, twMediaMimeForExt } from '../../shared/twMedia'

/**
 * Pure (electron-free, Node-testable) core of the `twmedia://` streaming
 * protocol — the HTTP Range math, the asset-URL parse, and the realpath jail.
 * The electron `protocol.handle` wiring lives in TwMediaProtocol.ts; everything
 * that can be unit-tested lives HERE (the adversarial review's key ask: the Range
 * arithmetic is the #2 risk of the whole AV pipeline, so it must be a pure fn).
 */

// Scheme + ext→mime live in src/shared/twMedia.ts (single source of truth, also
// used by the renderer URL builder). Re-exported so existing importers
// (TwMediaProtocol, tests) keep resolving them from here.
export { TW_MEDIA_SCHEME, twMediaMimeForExt }

// Mirror TranscriptMediaAssetStore's SHA256_BASE64URL_PATTERN.
const SHA_RE = /^[A-Za-z0-9_-]{32,96}$/

export interface ParsedTwMediaUrl {
  sha256: string
  ext: string
  mime: string
}

/**
 * Parse `twmedia://asset/<sha256>.<ext>` → validated `{sha256, ext, mime}`, or
 * null. The URL NEVER carries a filesystem path — only a content hash + ext — so
 * path traversal is impossible by construction (the sha regex rejects `..`/`/`).
 */
export function parseTwMediaUrl(rawUrl: string): ParsedTwMediaUrl | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${TW_MEDIA_SCHEME}:`) return null
  if (url.hostname !== 'asset') return null
  let file: string
  try {
    file = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  } catch {
    return null // malformed percent-encoding
  }
  const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9]+)$/.exec(file)
  if (!match) return null
  const sha256 = match[1]
  const ext = match[2].toLowerCase()
  if (!SHA_RE.test(sha256)) return null
  const mime = twMediaMimeForExt(ext)
  if (!mime) return null
  return { sha256, ext, mime }
}

export interface ResolvedTwMediaAsset {
  realPath: string
  mime: string
  size: number
}

/**
 * Resolve a twmedia URL to a real on-disk asset, realpath-jailed under `baseDir`.
 * Reuses `transcriptMediaAssetPath` (the asset store's own path layout — single
 * source of truth) so the URL maps deterministically to a content-addressed file,
 * then verifies the realpath stays under the (realpath'd) asset dir as
 * defence-in-depth against a symlink escape. Returns null for bad URL / missing
 * file / out-of-jail / non-file.
 */
export function resolveTwMediaAsset(baseDir: string, rawUrl: string): ResolvedTwMediaAsset | null {
  const parsed = parseTwMediaUrl(rawUrl)
  if (!parsed) return null
  let candidate: string
  try {
    candidate = transcriptMediaAssetPath(baseDir, parsed.sha256, parsed.mime)
  } catch {
    return null
  }
  let real: string
  let realBase: string
  try {
    real = fs.realpathSync.native(candidate)
    realBase = fs.realpathSync.native(baseDir)
  } catch {
    return null // missing file or base dir
  }
  // Symlink-safe jail: the resolved file must live under the resolved asset dir.
  // (Don't compare real===candidate — a legit base under a symlinked root, e.g.
  // /tmp→/private/tmp on macOS, diverges without any attack.)
  if (real !== realBase && !real.startsWith(realBase + path.sep)) return null
  let stat: fs.Stats
  try {
    stat = fs.statSync(real)
  } catch {
    return null
  }
  if (!stat.isFile()) return null
  return { realPath: real, mime: parsed.mime, size: stat.size }
}

export interface MediaRangeResult {
  status: 200 | 206 | 416
  start: number
  end: number
  /** Bytes to send (slice length for 206, full size for 200, 0 for 416). */
  contentLength: number
  /** `Content-Range` header value (206 + 416 only). */
  contentRange?: string
}

/**
 * Resolve a `Range` request header against a known file size into the response
 * decision. Chromium's media stack sends `Range: bytes=0-` even for tiny files
 * and EXPECTS a 206 back, so a parseable Range (even open-ended-from-0) yields
 * 206; only an ABSENT or UNPARSEABLE Range yields a full 200 (spec lets a server
 * ignore Range). Single-range only — multi-range is treated as unparseable → 200.
 */
export function resolveMediaRange(rangeHeader: string | null | undefined, size: number): MediaRangeResult {
  if (size <= 0) {
    return { status: 416, start: 0, end: 0, contentLength: 0, contentRange: `bytes */${Math.max(0, size)}` }
  }
  const full: MediaRangeResult = { status: 200, start: 0, end: size - 1, contentLength: size }
  if (!rangeHeader) return full
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim())
  if (!match) return full // multi-range / garbage → ignore Range, serve full (spec-OK)
  const rawStart = match[1]
  const rawEnd = match[2]
  if (rawStart === '' && rawEnd === '') {
    return { status: 416, start: 0, end: 0, contentLength: 0, contentRange: `bytes */${size}` }
  }
  let start: number
  let end: number
  if (rawStart === '') {
    // Suffix form `bytes=-N`: the last N bytes (used by <video> to probe the moov tail).
    const n = Number(rawEnd)
    if (!Number.isFinite(n) || n <= 0) {
      return { status: 416, start: 0, end: 0, contentLength: 0, contentRange: `bytes */${size}` }
    }
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || start >= size) {
    return { status: 416, start: 0, end: 0, contentLength: 0, contentRange: `bytes */${size}` }
  }
  return {
    status: 206,
    start,
    end,
    contentLength: end - start + 1,
    contentRange: `bytes ${start}-${end}/${size}`
  }
}

/**
 * Read exactly [start, end] (inclusive) off disk into a Buffer via positioned
 * reads. THROWS on a short read instead of returning fewer bytes than asked: the
 * caller has already committed `Content-Length = end-start+1`, and a body shorter
 * than its declared length silently wedges Chromium's `<video>` (it blocks forever
 * waiting for the missing bytes). Failing loudly turns it into an observable
 * network error the element can surface. Reachable via a TOCTOU window (the file
 * is replaced/truncated between the size stat and the read) or a transient fs hiccup.
 */
export function readAssetSlice(filePath: string, start: number, end: number): Buffer {
  const length = end - start + 1
  if (length <= 0) return Buffer.alloc(0)
  const buffer = Buffer.alloc(length)
  const fd = fs.openSync(filePath, 'r')
  try {
    let offset = 0
    while (offset < length) {
      const read = fs.readSync(fd, buffer, offset, length - offset, start + offset)
      if (read <= 0) break
      offset += read
    }
    if (offset !== length) {
      throw new Error(`twmedia: short read (${offset}/${length} bytes) for ${filePath}`)
    }
    return buffer
  } finally {
    fs.closeSync(fd)
  }
}

export interface TranscriptMediaRangeSlice {
  /** Base64 of THIS slice's bytes. */
  dataBase64: string
  /** This slice's raw byte length (post-clamp, pre-base64). */
  byteLength: number
  /** Echoed start offset of this slice. */
  offset: number
  /** Full asset size on disk — lets iOS know when it has pulled the last slice. */
  totalBytes: number
}

/** Thrown when the requested `offset` is at/beyond the asset's end. The bridge
 * handler maps this to `{ ok: false, reason }` (a 416-equivalent for the bridge). */
export class TranscriptMediaRangeOutOfBoundsError extends Error {
  constructor(public readonly offset: number, public readonly totalBytes: number) {
    super(`twmedia: range offset ${offset} is out of bounds for asset of ${totalBytes} bytes`)
    this.name = 'TranscriptMediaRangeOutOfBoundsError'
  }
}

/**
 * Pure, Node-testable core of the CHUNKED/RANGE `threadMediaFetch` bridge mode.
 * Reads ONE bounded slice of a content-addressed transcript media asset for the
 * E2EE bridge to iOS.
 *
 * Jail + DoS guards:
 *  - The path is resolved ONLY via `transcriptMediaAssetPath` (which runs
 *    `assertSafeSha256` + the mime→ext whitelist), so a hostile sha/mime can never
 *    escape the asset dir or address an arbitrary file.
 *  - `effLength` is HARD-clamped to `THREAD_MEDIA_CHUNK_MAX_BYTES` server-side,
 *    regardless of the client's `requestedLength` — a client cannot pull an
 *    arbitrarily large slice (frame-cap + memory DoS guard).
 *  - The read window is `[offset, offset + effLength - 1]`, always inside
 *    `[0, totalBytes)`: `offset` is validated `>= 0` by the request guard and
 *    `< totalBytes` here; `effLength` is additionally clamped to `totalBytes - offset`.
 *  - `readAssetSlice` throws on a short read (TOCTOU truncation) — propagated so
 *    the handler reports a failure rather than shipping a truncated body.
 */
export function readTranscriptMediaRangeSlice(input: {
  baseDir: string
  sha256: string
  mimeType: string
  offset: number
  requestedLength: number
}): TranscriptMediaRangeSlice {
  const { baseDir, sha256, mimeType, offset, requestedLength } = input
  // Path jail: assertSafeSha256 + mime→ext whitelist live inside this call.
  const filePath = transcriptMediaAssetPath(baseDir, sha256, mimeType)
  const totalBytes = fs.statSync(filePath).size
  if (offset >= totalBytes) {
    throw new TranscriptMediaRangeOutOfBoundsError(offset, totalBytes)
  }
  // Server-side hard cap wins over the client's requested length; also clamp to the
  // remaining tail so we never read past EOF.
  const effLength = Math.min(requestedLength, THREAD_MEDIA_CHUNK_MAX_BYTES, totalBytes - offset)
  const buffer = readAssetSlice(filePath, offset, offset + effLength - 1)
  return {
    dataBase64: buffer.toString('base64'),
    byteLength: buffer.length,
    offset,
    totalBytes
  }
}
