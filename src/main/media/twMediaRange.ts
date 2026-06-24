import fs from 'fs'
import path from 'path'
import { transcriptMediaAssetPath } from '../services/TranscriptMediaAssetStore'

/**
 * Pure (electron-free, Node-testable) core of the `twmedia://` streaming
 * protocol — the HTTP Range math, the asset-URL parse, and the realpath jail.
 * The electron `protocol.handle` wiring lives in TwMediaProtocol.ts; everything
 * that can be unit-tested lives HERE (the adversarial review's key ask: the Range
 * arithmetic is the #2 risk of the whole AV pipeline, so it must be a pure fn).
 */

export const TW_MEDIA_SCHEME = 'twmedia'

// ext -> canonical MIME. MUST stay consistent with
// TranscriptMediaAssetStore.mediaExtension (the mime -> ext direction). A
// round-trip test in twMediaRange.test.ts locks the two maps together.
const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm'
}

export function twMediaMimeForExt(ext: string): string | null {
  return EXT_TO_MIME[ext.toLowerCase()] ?? null
}

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
