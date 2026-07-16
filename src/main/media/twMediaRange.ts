import fs from 'fs'
import path from 'path'
import {
  THREAD_MEDIA_CHUNK_MAX_BYTES,
  maxTranscriptMediaBytesForMime,
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
  /** Descriptor for the exact regular file whose identity and size were verified. */
  fd: number
  /** Close the descriptor unless ownership was transferred to a read stream. */
  close: () => void
  /** Internal snapshot used to reject in-place mutation during bounded reads/copies. */
  readonly snapshot: Pick<fs.Stats, 'dev' | 'ino' | 'size' | 'mtimeMs'>
}

function sameFileIdentity(
  left: Pick<fs.Stats, 'dev' | 'ino'>,
  right: Pick<fs.Stats, 'dev' | 'ino'>
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function pathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

function trustedDirectorySnapshot(directory: string): fs.Stats | null {
  try {
    const lstat = fs.lstatSync(directory)
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) return null
    const stat = fs.statSync(directory)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    return (
      sameFileIdentity(lstat, stat) &&
      (uid === null || stat.uid === uid) &&
      // POSIX-only gate: Windows synthesizes mode bits, so world/group-
      // writable checks carry no signal there (ACLs are not modeled).
      (process.platform === 'win32' || (stat.mode & 0o022) === 0)
        ? stat
        : null
    )
  } catch {
    return null
  }
}

/**
 * Open one content-addressed asset from the store and bind all subsequent I/O
 * to that exact descriptor. The base directory is realpath-frozen first, the
 * shard and leaf must be non-symlinks, and the lstat/open/fstat identities must
 * agree. A leaf replacement in any of those gaps therefore fails closed.
 */
export function openTranscriptMediaAsset(input: {
  baseDir: string
  sha256: string
  mimeType: string
}): ResolvedTwMediaAsset | null {
  let realBase: string
  let candidate: string
  let baseSnapshot: fs.Stats
  try {
    realBase = fs.realpathSync.native(input.baseDir)
    const trustedBase = trustedDirectorySnapshot(realBase)
    if (!trustedBase) return null
    baseSnapshot = trustedBase
    candidate = transcriptMediaAssetPath(realBase, input.sha256, input.mimeType)
  } catch {
    return null
  }

  const shard = path.dirname(candidate)
  const shardSnapshot = trustedDirectorySnapshot(shard)
  if (!pathWithinRoot(shard, realBase) || !shardSnapshot) return null

  let before: fs.Stats
  let fd: number | null = null
  try {
    before = fs.lstatSync(candidate)
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      (process.platform !== 'win32' && (before.mode & 0o022) !== 0)
    ) {
      return null
    }
    fd = fs.openSync(
      candidate,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
    )
    const opened = fs.fstatSync(fd)
    const after = fs.lstatSync(candidate)
    const real = fs.realpathSync.native(candidate)
    const baseAfter = fs.lstatSync(realBase)
    const shardAfter = fs.lstatSync(shard)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size <= 0 ||
      opened.size > maxTranscriptMediaBytesForMime(input.mimeType) ||
      (uid !== null && opened.uid !== uid) ||
      (process.platform !== 'win32' && (opened.mode & 0o022) !== 0) ||
      after.isSymbolicLink() ||
      baseAfter.isSymbolicLink() ||
      shardAfter.isSymbolicLink() ||
      !sameFileIdentity(baseSnapshot, baseAfter) ||
      !sameFileIdentity(shardSnapshot, shardAfter) ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(after, opened) ||
      !pathWithinRoot(real, realBase) ||
      real !== candidate
    ) {
      return null
    }

    const ownedFd = fd
    fd = null
    let closed = false
    return {
      realPath: real,
      mime: input.mimeType,
      size: opened.size,
      fd: ownedFd,
      snapshot: {
        dev: opened.dev,
        ino: opened.ino,
        size: opened.size,
        mtimeMs: opened.mtimeMs
      },
      close: () => {
        if (closed) return
        closed = true
        fs.closeSync(ownedFd)
      }
    }
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Preserve the fail-closed result.
      }
    }
  }
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
  return openTranscriptMediaAsset({
    baseDir,
    sha256: parsed.sha256,
    mimeType: parsed.mime
  })
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
 * The legacy path API now also binds the read to an O_NOFOLLOW descriptor after
 * verifying the lstat/open/fstat identities.
 */
export function readAssetSlice(filePath: string, start: number, end: number): Buffer {
  let before: fs.Stats
  try {
    before = fs.lstatSync(filePath)
  } catch {
    throw new Error(`twmedia: unsafe asset path for ${filePath}`)
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`twmedia: unsafe asset path for ${filePath}`)
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fs.fstatSync(fd)
    const after = fs.lstatSync(filePath)
    if (
      !opened.isFile() ||
      after.isSymbolicLink() ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(after, opened)
    ) {
      throw new Error(`twmedia: asset changed while opening ${filePath}`)
    }
    return readOpenedAssetSlice(
      {
        realPath: filePath,
        mime: 'application/octet-stream',
        size: opened.size,
        fd,
        snapshot: {
          dev: opened.dev,
          ino: opened.ino,
          size: opened.size,
          mtimeMs: opened.mtimeMs
        },
        close: () => undefined
      },
      start,
      end
    )
  } finally {
    fs.closeSync(fd)
  }
}

export function verifyOpenedTwMediaAssetSnapshot(asset: ResolvedTwMediaAsset): boolean {
  try {
    const current = fs.fstatSync(asset.fd)
    return (
      current.isFile() &&
      sameFileIdentity(current, asset.snapshot) &&
      current.size === asset.snapshot.size &&
      current.mtimeMs === asset.snapshot.mtimeMs
    )
  } catch {
    return false
  }
}

/** Read from an already verified descriptor; no pathname is reopened. */
export function readOpenedAssetSlice(
  asset: ResolvedTwMediaAsset,
  start: number,
  end: number
): Buffer {
  const length = end - start + 1
  if (length <= 0) return Buffer.alloc(0)
  const buffer = Buffer.alloc(length)
  if (!verifyOpenedTwMediaAssetSnapshot(asset)) {
    throw new Error(`twmedia: asset changed before read for ${asset.realPath}`)
  }
  let offset = 0
  while (offset < length) {
    const read = fs.readSync(asset.fd, buffer, offset, length - offset, start + offset)
    if (read <= 0) break
    offset += read
  }
  if (offset !== length) {
    throw new Error(`twmedia: short read (${offset}/${length} bytes) for ${asset.realPath}`)
  }
  if (!verifyOpenedTwMediaAssetSnapshot(asset)) {
    throw new Error(`twmedia: asset changed during read for ${asset.realPath}`)
  }
  return buffer
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
 *  - `readOpenedAssetSlice` throws on a short read or in-place mutation — propagated so
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
  // Preserve the caller-visible validation errors for malformed identities.
  transcriptMediaAssetPath(baseDir, sha256, mimeType)
  const asset = openTranscriptMediaAsset({ baseDir, sha256, mimeType })
  if (!asset) throw new Error('twmedia: asset is missing or unsafe')
  try {
    const totalBytes = asset.size
    if (offset >= totalBytes) {
      throw new TranscriptMediaRangeOutOfBoundsError(offset, totalBytes)
    }
    // Server-side hard cap wins over the client's requested length; also clamp to the
    // remaining tail so we never read past EOF.
    const effLength = Math.min(requestedLength, THREAD_MEDIA_CHUNK_MAX_BYTES, totalBytes - offset)
    const buffer = readOpenedAssetSlice(asset, offset, offset + effLength - 1)
    return {
      dataBase64: buffer.toString('base64'),
      byteLength: buffer.length,
      offset,
      totalBytes
    }
  } finally {
    asset.close()
  }
}
