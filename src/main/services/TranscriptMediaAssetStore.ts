import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { isSafeChatId } from '../ChatPath'
import type { PersistedAttachmentRef } from '../store/types'

export const TRANSCRIPT_MEDIA_ASSET_DIR = 'transcript-media'
export const TRANSCRIPT_MEDIA_OWNERSHIP_FILE = 'ownership-v1.json'
export const TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES = 8 * 1024 * 1024
// Per-chunk RAW byte cap for the CHUNKED/RANGE variant of the `threadMediaFetch`
// bridge action (iOS pulls a large content-addressed asset in bounded slices over
// the E2EE bridge — the only iOS transport; there is NO HTTP path). Sized well
// under 1 MiB because: the bytes ride ONE E2EE WebSocket frame, the relay enforces
// a 1 MiB frame cap (`relay/src/server.ts:93` `maxFrameBytes`, closes with 1009 on
// violation) and iOS uses the default 1 MiB `maximumMessageSize`; base64 inflates
// the raw bytes ×4/3, plus the JSON envelope + AES-GCM overhead. 448 KiB raw →
// ~597 KiB base64, leaving comfortable headroom under the frame cap.
export const THREAD_MEDIA_CHUNK_MAX_BYTES = 448 * 1024
// AV assets are far larger than images. These are WRITE caps (anti-flood) and the
// READ-clamp ceiling. NOTE: the streaming `twmedia://` protocol (S0b) bypasses
// read() entirely (fs.createReadStream off disk), so these caps bound ingestion +
// the base64-over-IPC fetch path, never playback.
export const TRANSCRIPT_MEDIA_MAX_AUDIO_BYTES = 64 * 1024 * 1024
export const TRANSCRIPT_MEDIA_MAX_VIDEO_BYTES = 512 * 1024 * 1024
export const TRANSCRIPT_MEDIA_MAX_PDF_BYTES = 80 * 1024 * 1024

/** Per-kind byte cap, keyed off the MIME top-level type. Image is the legacy
 * default. The read path MUST use this (not the image cap) or audio/video reads
 * back truncated/corrupt — the cap previously doubled as a hard 8MB read clamp. */
export function maxTranscriptMediaBytesForMime(mimeType: string): number {
  const m = mimeType.toLowerCase()
  if (m.startsWith('video/')) return TRANSCRIPT_MEDIA_MAX_VIDEO_BYTES
  if (m.startsWith('audio/')) return TRANSCRIPT_MEDIA_MAX_AUDIO_BYTES
  if (m === 'application/pdf') return TRANSCRIPT_MEDIA_MAX_PDF_BYTES
  return TRANSCRIPT_MEDIA_MAX_FULL_IMAGE_BYTES
}

const SHA256_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{32,96}$/
const TRANSCRIPT_MEDIA_OWNERSHIP_VERSION = 1
export const TRANSCRIPT_MEDIA_OWNERSHIP_MAX_FILE_BYTES = 8 * 1024 * 1024
export const TRANSCRIPT_MEDIA_OWNERSHIP_MAX_ASSETS = 50_000
export const TRANSCRIPT_MEDIA_OWNERSHIP_MAX_CHATS_PER_ASSET = 256
const TRANSCRIPT_MEDIA_OWNERSHIP_MAX_CHAT_ID_BYTES = 512
const TRANSCRIPT_MEDIA_EXTENSIONS = new Set([
  'png',
  'jpg',
  'webp',
  'gif',
  'bmp',
  'pdf',
  'wav',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'flac',
  'mp4',
  'mov',
  'webm'
])
const PERSISTED_ATTACHMENT_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'application/pdf'
])

export interface TranscriptMediaAssetWriteInput {
  sha256: string
  mimeType: string
  buffer: Buffer
  /** Main-owned canonical chat id. Renderer payloads must never author this. */
  appChatId?: string
}
export interface TranscriptMediaAssetReadInput {
  sha256: string
  mimeType: string
  maxBytes?: number
}

export type TranscriptMediaAssetReadResult =
  | { ok: true; buffer: Buffer; byteLength: number }
  | { ok: false; reason: 'invalid_hash' | 'missing' | 'too_large' | 'unsupported' }

export interface TranscriptMediaAssetOwnershipInput {
  sha256: string
  mimeType: string
  appChatId: string
}

export interface TranscriptMediaAssetTransferInput {
  sha256: string
  mimeType: string
  sourceAppChatId: string
  targetAppChatId: string
}

export type TranscriptMediaAssetOwnershipResult =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'invalid_asset'
        | 'invalid_chat'
        | 'missing'
        | 'ownership_limit'
        | 'persistence_failed'
        | 'not_owner'
        | 'unverified'
    }

export type TranscriptMediaAssetOwnershipBackfillResult =
  | {
      ok: true
      /** Raw claims supplied by an independently trusted migration source. */
      requestedGrants: number
      /** Unique asset/chat pairs after de-duplicating the scan. */
      distinctGrants: number
      /** Unique content-addressed assets checked on disk. */
      assetsChecked: number
      /** Unique grants newly added to the durable ledger. */
      addedGrants: number
      /** Unique grants that were already present. */
      existingGrants: number
      /** Repeated asset/chat pairs in the supplied scan. */
      duplicateRequests: number
      /** True only when this call atomically replaced the ledger once. */
      persisted: boolean
    }
  | {
      ok: false
      reason:
        | 'invalid_asset'
        | 'invalid_chat'
        | 'missing'
        | 'ownership_limit'
        | 'persistence_failed'
      /** Index of the first offending input when the failure is input-specific. */
      failedAt?: number
    }

export type TranscriptMediaContentAddressedWriteResult =
  | {
      ok: true
      persistenceVersion: 1
      sha256: string
      path: string
      mimeType: string
      byteLength: number
    }
  | { ok: false; reason: string }

export type TranscriptMediaPersistedAttachmentResolveResult =
  | { ok: true; attachment: PersistedAttachmentRef }
  | { ok: false; reason: 'invalid_reference' | 'missing' | 'too_large' | 'content_mismatch' }

export function isPersistedAttachmentRef(value: unknown): value is PersistedAttachmentRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType.trim().toLowerCase() : ''
  return (
    record.persistenceVersion === 1 &&
    typeof record.path === 'string' &&
    path.isAbsolute(record.path) &&
    typeof record.sha256 === 'string' &&
    SHA256_BASE64URL_PATTERN.test(record.sha256) &&
    PERSISTED_ATTACHMENT_MIME_TYPES.has(mimeType) &&
    typeof record.byteLength === 'number' &&
    Number.isSafeInteger(record.byteLength) &&
    record.byteLength > 0
  )
}

function mediaExtension(mimeType: string): string | null {
  switch (mimeType.toLowerCase()) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    case 'image/gif':
      return 'gif'
    case 'image/bmp':
      return 'bmp'
    case 'application/pdf':
      return 'pdf'
    // Audio containers (S0a — native AV pipeline).
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav'
    case 'audio/mpeg':
      return 'mp3'
    case 'audio/mp4':
      return 'm4a'
    case 'audio/aac':
      return 'aac'
    case 'audio/ogg':
      return 'ogg'
    case 'audio/flac':
    case 'audio/x-flac':
      return 'flac'
    // Video containers.
    case 'video/mp4':
      return 'mp4'
    case 'video/quicktime':
      return 'mov'
    case 'video/webm':
      return 'webm'
    default:
      return null
  }
}

function assertSafeSha256(value: string): void {
  if (!SHA256_BASE64URL_PATTERN.test(value)) {
    throw new Error('Invalid transcript media asset hash.')
  }
}

export function transcriptMediaAssetPath(
  baseDir: string,
  sha256: string,
  mimeType: string
): string {
  assertSafeSha256(sha256)
  const ext = mediaExtension(mimeType)
  if (!ext) throw new Error('Unsupported transcript media asset MIME type.')
  return path.join(baseDir, sha256.slice(0, 2), `${sha256}.${ext}`)
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFileSnapshotVersion(left: fs.Stats, right: fs.Stats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function pathWithinRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

function directoryIsMainOwned(directory: string): boolean {
  try {
    const lstat = fs.lstatSync(directory)
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) return false
    const stat = fs.statSync(directory)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    return (
      sameFileIdentity(lstat, stat) &&
      (uid === null || stat.uid === uid) &&
      (stat.mode & 0o022) === 0
    )
  } catch {
    return false
  }
}

function safeAssetTarget(
  baseDir: string,
  sha256: string,
  mimeType: string,
  createDirectories: boolean
): string | null {
  let target: string
  try {
    target = transcriptMediaAssetPath(baseDir, sha256, mimeType)
    if (createDirectories) {
      fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    }
    if (!directoryIsMainOwned(baseDir)) return null
    const realBase = fs.realpathSync.native(baseDir)
    const shard = path.dirname(target)
    if (createDirectories) {
      fs.mkdirSync(shard, { recursive: true, mode: 0o700 })
    }
    if (!directoryIsMainOwned(shard)) return null
    const realShard = fs.realpathSync.native(shard)
    if (!pathWithinRoot(realShard, realBase)) return null
    return path.join(realShard, path.basename(target))
  } catch {
    return null
  }
}

function readExactDescriptor(fd: number, byteLength: number): Buffer | null {
  const buffer = Buffer.allocUnsafe(byteLength)
  let offset = 0
  try {
    while (offset < byteLength) {
      const bytesRead = fs.readSync(fd, buffer, offset, byteLength - offset, offset)
      if (bytesRead <= 0) break
      offset += bytesRead
    }
    return offset === byteLength ? buffer : null
  } catch {
    return null
  }
}

interface TranscriptMediaOwnershipSnapshot {
  version: 1
  grants: Array<{ asset: string; appChatIds: string[] }>
}

function safeOwnershipChatId(value: unknown): value is string {
  return (
    isSafeChatId(value) &&
    Buffer.byteLength(value, 'utf8') <= TRANSCRIPT_MEDIA_OWNERSHIP_MAX_CHAT_ID_BYTES
  )
}

function ownershipAssetKey(sha256: string, mimeType: string): string | null {
  if (!SHA256_BASE64URL_PATTERN.test(sha256)) return null
  const ext = mediaExtension(mimeType)
  return ext ? `${sha256}.${ext}` : null
}

function validOwnershipAssetKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const separator = value.lastIndexOf('.')
  if (separator <= 0) return false
  return (
    SHA256_BASE64URL_PATTERN.test(value.slice(0, separator)) &&
    TRANSCRIPT_MEDIA_EXTENSIONS.has(value.slice(separator + 1))
  )
}

function safeOwnershipPath(baseDir: string, createDirectory: boolean): string | null {
  try {
    if (createDirectory) fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    if (!directoryIsMainOwned(baseDir)) return null
    return path.join(fs.realpathSync.native(baseDir), TRANSCRIPT_MEDIA_OWNERSHIP_FILE)
  } catch {
    return null
  }
}

function storedAssetExists(baseDir: string, sha256: string, mimeType: string): boolean {
  const target = safeAssetTarget(baseDir, sha256, mimeType, false)
  if (!target) return false
  let fd: number | null = null
  try {
    const lstat = fs.lstatSync(target)
    if (lstat.isSymbolicLink() || !lstat.isFile()) return false
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    return (
      stat.isFile() &&
      sameFileIdentity(stat, lstat) &&
      stat.size > 0 &&
      stat.size <= maxTranscriptMediaBytesForMime(mimeType)
    )
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Best-effort descriptor close.
      }
    }
  }
}

function loadOwnership(baseDir: string): Map<string, Set<string>> {
  const ownershipPath = safeOwnershipPath(baseDir, false)
  if (!ownershipPath) return new Map()
  let fd: number | null = null
  try {
    const lstat = fs.lstatSync(ownershipPath)
    if (lstat.isSymbolicLink() || !lstat.isFile()) return new Map()
    fd = fs.openSync(ownershipPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (
      !stat.isFile() ||
      !sameFileIdentity(stat, lstat) ||
      (uid !== null && stat.uid !== uid) ||
      (stat.mode & 0o022) !== 0 ||
      stat.size <= 0 ||
      stat.size > TRANSCRIPT_MEDIA_OWNERSHIP_MAX_FILE_BYTES
    ) {
      return new Map()
    }
    const raw = readExactDescriptor(fd, stat.size)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw.toString('utf8')) as Partial<TranscriptMediaOwnershipSnapshot>
    if (
      parsed.version !== TRANSCRIPT_MEDIA_OWNERSHIP_VERSION ||
      !Array.isArray(parsed.grants) ||
      parsed.grants.length > TRANSCRIPT_MEDIA_OWNERSHIP_MAX_ASSETS
    ) {
      return new Map()
    }
    const loaded = new Map<string, Set<string>>()
    for (const grant of parsed.grants) {
      if (
        !grant ||
        typeof grant !== 'object' ||
        !validOwnershipAssetKey(grant.asset) ||
        !Array.isArray(grant.appChatIds) ||
        grant.appChatIds.length === 0 ||
        grant.appChatIds.length > TRANSCRIPT_MEDIA_OWNERSHIP_MAX_CHATS_PER_ASSET ||
        loaded.has(grant.asset)
      ) {
        return new Map()
      }
      const appChatIds = new Set<string>()
      for (const appChatId of grant.appChatIds) {
        if (!safeOwnershipChatId(appChatId)) return new Map()
        appChatIds.add(appChatId)
      }
      loaded.set(grant.asset, appChatIds)
    }
    return loaded
  } catch {
    return new Map()
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Best-effort descriptor close.
      }
    }
  }
}

function serializeOwnership(ownership: Map<string, Set<string>>): Buffer | null {
  const snapshot: TranscriptMediaOwnershipSnapshot = {
    version: 1,
    grants: Array.from(ownership, ([asset, appChatIds]) => ({
      asset,
      appChatIds: Array.from(appChatIds).sort()
    })).sort((left, right) => left.asset.localeCompare(right.asset))
  }
  const serialized = Buffer.from(JSON.stringify(snapshot), 'utf8')
  return serialized.length <= TRANSCRIPT_MEDIA_OWNERSHIP_MAX_FILE_BYTES ? serialized : null
}

function persistOwnership(
  baseDir: string,
  ownership: Map<string, Set<string>>,
  preparedSnapshot: Buffer | null = serializeOwnership(ownership)
): boolean {
  const ownershipPath = safeOwnershipPath(baseDir, true)
  if (!ownershipPath || !preparedSnapshot) return false
  const serialized = preparedSnapshot
  const tempPath = `${ownershipPath}.${process.pid}.${randomUUID()}.tmp`
  let fd: number | null = null
  try {
    fd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600
    )
    fs.fchmodSync(fd, 0o600)
    let offset = 0
    while (offset < serialized.length) {
      const written = fs.writeSync(fd, serialized, offset, serialized.length - offset, offset)
      if (written <= 0) throw new Error('short_write')
      offset += written
    }
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tempPath, ownershipPath)
    try {
      const directoryFd = fs.openSync(path.dirname(ownershipPath), fs.constants.O_RDONLY)
      fs.fsyncSync(directoryFd)
      fs.closeSync(directoryFd)
    } catch {
      // Directory fsync is best effort on filesystems that reject it.
    }
    return true
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Preserve the persistence failure.
      }
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    } catch {
      // A stale temp file is safer than masking the persistence result.
    }
  }
}

export class TranscriptMediaAssetStore {
  private ownershipByAsset: Map<string, Set<string>>

  constructor(private readonly baseDir: string) {
    this.ownershipByAsset = loadOwnership(baseDir)
  }

  /** Exact content-address + canonical-chat ownership check. */
  owns(input: TranscriptMediaAssetOwnershipInput): boolean {
    const asset = ownershipAssetKey(input.sha256, input.mimeType)
    if (!asset || !safeOwnershipChatId(input.appChatId)) return false
    return this.ownershipByAsset.get(asset)?.has(input.appChatId) === true
  }

  /**
   * Main-authority grant for an existing store asset. Renderer-supplied chat ids
   * must never be routed here without an independently trusted owner lookup.
   */
  grant(input: TranscriptMediaAssetOwnershipInput): TranscriptMediaAssetOwnershipResult {
    const asset = ownershipAssetKey(input.sha256, input.mimeType)
    if (!asset) return { ok: false, reason: 'invalid_asset' }
    if (!safeOwnershipChatId(input.appChatId)) return { ok: false, reason: 'invalid_chat' }
    if (!storedAssetExists(this.baseDir, input.sha256, input.mimeType)) {
      return { ok: false, reason: 'missing' }
    }
    const current = this.ownershipByAsset.get(asset)
    if (current?.has(input.appChatId)) return { ok: true }
    if (
      (!current && this.ownershipByAsset.size >= TRANSCRIPT_MEDIA_OWNERSHIP_MAX_ASSETS) ||
      (current?.size ?? 0) >= TRANSCRIPT_MEDIA_OWNERSHIP_MAX_CHATS_PER_ASSET
    ) {
      return { ok: false, reason: 'ownership_limit' }
    }
    const next = new Map(this.ownershipByAsset)
    next.set(asset, new Set([...(current ?? []), input.appChatId]))
    if (!persistOwnership(this.baseDir, next)) {
      return { ok: false, reason: 'persistence_failed' }
    }
    this.ownershipByAsset = next
    return { ok: true }
  }

  /**
   * Atomically seed ownership from an independently trusted migration source.
   * Persisted chat JSON is renderer-authored and is explicitly NOT provenance
   * for this operation. A caller retaining this migration hook must authenticate
   * a separate main-owned manifest before constructing `inputs`.
   *
   * This is intentionally a bulk operation: assets are checked once, touched
   * sets are cloned once, and at most one ledger replacement is attempted.
   */
  backfillOwnership(
    inputs: readonly TranscriptMediaAssetOwnershipInput[]
  ): TranscriptMediaAssetOwnershipBackfillResult {
    const grouped = new Map<
      string,
      {
        sha256: string
        mimeType: string
        appChatIds: Set<string>
        firstIndex: number
      }
    >()
    let distinctGrants = 0

    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index]
      if (
        !input ||
        typeof input.sha256 !== 'string' ||
        typeof input.mimeType !== 'string'
      ) {
        return { ok: false, reason: 'invalid_asset', failedAt: index }
      }
      const asset = ownershipAssetKey(input.sha256, input.mimeType)
      if (!asset) return { ok: false, reason: 'invalid_asset', failedAt: index }
      if (!safeOwnershipChatId(input.appChatId)) {
        return { ok: false, reason: 'invalid_chat', failedAt: index }
      }
      let group = grouped.get(asset)
      if (!group) {
        group = {
          sha256: input.sha256,
          mimeType: input.mimeType,
          appChatIds: new Set(),
          firstIndex: index
        }
        grouped.set(asset, group)
      }
      const previousSize = group.appChatIds.size
      group.appChatIds.add(input.appChatId)
      if (group.appChatIds.size !== previousSize) distinctGrants += 1
    }

    for (const group of grouped.values()) {
      if (!storedAssetExists(this.baseDir, group.sha256, group.mimeType)) {
        return { ok: false, reason: 'missing', failedAt: group.firstIndex }
      }
    }

    let newAssetCount = 0
    for (const asset of grouped.keys()) {
      if (!this.ownershipByAsset.has(asset)) newAssetCount += 1
    }
    if (this.ownershipByAsset.size + newAssetCount > TRANSCRIPT_MEDIA_OWNERSHIP_MAX_ASSETS) {
      return { ok: false, reason: 'ownership_limit' }
    }

    const next = new Map(this.ownershipByAsset)
    let addedGrants = 0
    for (const [asset, group] of grouped) {
      const current = this.ownershipByAsset.get(asset)
      let additionsForAsset = 0
      for (const appChatId of group.appChatIds) {
        if (!current?.has(appChatId)) additionsForAsset += 1
      }
      if (
        (current?.size ?? 0) + additionsForAsset >
        TRANSCRIPT_MEDIA_OWNERSHIP_MAX_CHATS_PER_ASSET
      ) {
        return { ok: false, reason: 'ownership_limit', failedAt: group.firstIndex }
      }
      if (additionsForAsset === 0) continue
      const merged = new Set(current ?? [])
      for (const appChatId of group.appChatIds) merged.add(appChatId)
      next.set(asset, merged)
      addedGrants += additionsForAsset
    }

    const commonResult = {
      requestedGrants: inputs.length,
      distinctGrants,
      assetsChecked: grouped.size,
      addedGrants,
      existingGrants: distinctGrants - addedGrants,
      duplicateRequests: inputs.length - distinctGrants
    }
    if (addedGrants === 0) {
      return { ok: true, ...commonResult, persisted: false }
    }

    const serialized = serializeOwnership(next)
    if (!serialized) return { ok: false, reason: 'ownership_limit' }
    if (!persistOwnership(this.baseDir, next, serialized)) {
      return { ok: false, reason: 'persistence_failed' }
    }
    this.ownershipByAsset = next
    return { ok: true, ...commonResult, persisted: true }
  }

  /**
   * Additive transfer for a verified fork/sub-thread relation. Source ownership
   * is checked before invoking the trusted relation verifier; source access is
   * retained so opening a child cannot revoke media from its parent.
   */
  grantVerifiedTransfer(
    input: TranscriptMediaAssetTransferInput,
    verifyTransfer: (sourceAppChatId: string, targetAppChatId: string) => boolean
  ): TranscriptMediaAssetOwnershipResult {
    const asset = ownershipAssetKey(input.sha256, input.mimeType)
    if (!asset) return { ok: false, reason: 'invalid_asset' }
    if (
      !safeOwnershipChatId(input.sourceAppChatId) ||
      !safeOwnershipChatId(input.targetAppChatId)
    ) {
      return { ok: false, reason: 'invalid_chat' }
    }
    if (
      !this.owns({
        sha256: input.sha256,
        mimeType: input.mimeType,
        appChatId: input.sourceAppChatId
      })
    ) {
      return { ok: false, reason: 'not_owner' }
    }
    try {
      if (!verifyTransfer(input.sourceAppChatId, input.targetAppChatId)) {
        return { ok: false, reason: 'unverified' }
      }
    } catch {
      return { ok: false, reason: 'unverified' }
    }
    return this.grant({
      sha256: input.sha256,
      mimeType: input.mimeType,
      appChatId: input.targetAppChatId
    })
  }

  write(input: TranscriptMediaAssetWriteInput): { ok: true } | { ok: false; reason: string } {
    try {
      if (input.appChatId !== undefined && !safeOwnershipChatId(input.appChatId)) {
        return { ok: false, reason: 'invalid_chat' }
      }
      if (!mediaExtension(input.mimeType)) return { ok: false, reason: 'unsupported' }
      if (
        input.buffer.length <= 0 ||
        input.buffer.length > maxTranscriptMediaBytesForMime(input.mimeType)
      ) {
        return { ok: false, reason: 'too_large' }
      }
      const target = safeAssetTarget(this.baseDir, input.sha256, input.mimeType, true)
      if (!target) return { ok: false, reason: 'unsafe_asset_path' }
      let fd: number | null = null
      let createdStat: fs.Stats | null = null
      try {
        fd = fs.openSync(
          target,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600
        )
        createdStat = fs.fstatSync(fd)
        if (!createdStat.isFile()) throw new Error('unsafe_asset_path')
        let offset = 0
        while (offset < input.buffer.length) {
          const written = fs.writeSync(fd, input.buffer, offset, input.buffer.length - offset, offset)
          if (written <= 0) throw new Error('short_write')
          offset += written
        }
        fs.fsyncSync(fd)
        const finalStat = fs.fstatSync(fd)
        const targetLstat = fs.lstatSync(target)
        if (
          finalStat.size !== input.buffer.length ||
          targetLstat.isSymbolicLink() ||
          !sameFileIdentity(finalStat, createdStat) ||
          !sameFileIdentity(targetLstat, createdStat)
        ) {
          throw new Error('unsafe_asset_path')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          if (createdStat) {
            try {
              const current = fs.lstatSync(target)
              if (!current.isSymbolicLink() && sameFileIdentity(current, createdStat)) {
                fs.unlinkSync(target)
              }
            } catch {
              // Best-effort cleanup of a failed exclusive write.
            }
          }
          throw error
        }
        const existing = this.read({
          sha256: input.sha256,
          mimeType: input.mimeType,
          maxBytes: input.buffer.length
        })
        if (!existing.ok || !existing.buffer.equals(input.buffer)) {
          return { ok: false, reason: 'content_address_collision' }
        }
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd)
          } catch {
            // Best-effort descriptor close.
          }
        }
      }
      if (input.appChatId !== undefined) {
        return this.grant({
          sha256: input.sha256,
          mimeType: input.mimeType,
          appChatId: input.appChatId
        })
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  writeContentAddressed(input: {
    mimeType: string
    buffer: Buffer
    appChatId?: string
  }): TranscriptMediaContentAddressedWriteResult {
    const sha256 = createHash('sha256').update(input.buffer).digest('base64url')
    const written = this.write({
      sha256,
      mimeType: input.mimeType,
      buffer: input.buffer,
      appChatId: input.appChatId
    })
    if (!written.ok) return written
    const target = safeAssetTarget(this.baseDir, sha256, input.mimeType, false)
    if (!target) return { ok: false, reason: 'unsafe_asset_path' }
    const read = this.read({ sha256, mimeType: input.mimeType, maxBytes: input.buffer.length })
    if (!read.ok || !read.buffer.equals(input.buffer)) {
      return { ok: false, reason: read.ok ? 'content_address_collision' : read.reason }
    }
    return {
      ok: true,
      persistenceVersion: 1,
      sha256,
      path: target,
      mimeType: input.mimeType.toLowerCase(),
      byteLength: read.byteLength
    }
  }

  resolvePersistedAttachment(value: unknown): TranscriptMediaPersistedAttachmentResolveResult {
    if (!isPersistedAttachmentRef(value)) return { ok: false, reason: 'invalid_reference' }
    const mimeType = value.mimeType.toLowerCase()
    const target = safeAssetTarget(this.baseDir, value.sha256, mimeType, false)
    if (!target || path.resolve(value.path) !== target) return { ok: false, reason: 'missing' }
    const read = this.read({
      sha256: value.sha256,
      mimeType,
      maxBytes: value.byteLength
    })
    if (!read.ok) {
      return {
        ok: false,
        reason: read.reason === 'too_large' ? 'too_large' : 'missing'
      }
    }
    if (
      read.byteLength !== value.byteLength ||
      createHash('sha256').update(read.buffer).digest('base64url') !== value.sha256
    ) {
      return { ok: false, reason: 'content_mismatch' }
    }
    return {
      ok: true,
      attachment: {
        persistenceVersion: 1,
        ...(typeof value.id === 'string' && value.id.trim() ? { id: value.id } : {}),
        path: target,
        ...(typeof value.name === 'string' && value.name.trim() ? { name: value.name } : {}),
        sha256: value.sha256,
        mimeType,
        byteLength: read.byteLength
      }
    }
  }

  read(input: TranscriptMediaAssetReadInput): TranscriptMediaAssetReadResult {
    let target: string | null
    try {
      target = safeAssetTarget(this.baseDir, input.sha256, input.mimeType, false)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        reason: message.includes('MIME') ? 'unsupported' : 'invalid_hash'
      }
    }
    if (!target) {
      try {
        transcriptMediaAssetPath(this.baseDir, input.sha256, input.mimeType)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, reason: message.includes('MIME') ? 'unsupported' : 'invalid_hash' }
      }
      return { ok: false, reason: 'missing' }
    }
    let lstat: fs.Stats
    let fd: number
    try {
      lstat = fs.lstatSync(target)
      if (lstat.isSymbolicLink() || !lstat.isFile()) return { ok: false, reason: 'missing' }
      fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    } catch {
      return { ok: false, reason: 'missing' }
    }
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || !sameFileIdentity(stat, lstat)) return { ok: false, reason: 'missing' }
      // Per-kind ceiling, NOT the fixed 8MB image cap — clamping a video to 8MB on
      // read silently truncates it to corruption.
      const cap = maxTranscriptMediaBytesForMime(input.mimeType)
      const maxBytes = Math.max(1, Math.min(cap, input.maxBytes ?? cap))
      if (stat.size <= 0 || stat.size > maxBytes) return { ok: false, reason: 'too_large' }
      const buffer = readExactDescriptor(fd, stat.size)
      if (!buffer) return { ok: false, reason: 'missing' }
      const finalStat = fs.fstatSync(fd)
      if (finalStat.size !== stat.size || !sameFileSnapshotVersion(finalStat, stat)) {
        return { ok: false, reason: 'missing' }
      }
      return { ok: true, buffer, byteLength: buffer.length }
    } finally {
      fs.closeSync(fd)
    }
  }
}
