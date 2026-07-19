import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { isSafeChatId } from '../ChatPath'
import type { PersistedAttachmentRef } from '../store/types'

export const TRANSCRIPT_MEDIA_ASSET_DIR = 'transcript-media'
export const TRANSCRIPT_MEDIA_OWNERSHIP_FILE = 'ownership-v1.json'
export const TRANSCRIPT_MEDIA_PURGE_JOURNAL_FILE = '.purge-v1.json'
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
const TRANSCRIPT_MEDIA_FILE_INGEST_CHUNK_BYTES = 1024 * 1024
const TRANSCRIPT_MEDIA_STALE_INGEST_TEMP_AGE_MS = 24 * 60 * 60 * 1000
const TRANSCRIPT_MEDIA_PURGE_JOURNAL_VERSION = 1
const TRANSCRIPT_MEDIA_PURGE_JOURNAL_MAX_FILE_BYTES = 32 * 1024 * 1024
const TRANSCRIPT_MEDIA_PURGE_TEMP_PATTERN =
  /^\.purge-(?:journal|ledger)-([1-9]\d*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/
const TRANSCRIPT_MEDIA_INGEST_TEMP_PATTERN =
  /^\.ingest-([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/
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

export interface TranscriptMediaAssetOwnedWriteInput
  extends Omit<TranscriptMediaAssetWriteInput, 'appChatId'> {
  /** Main-owned canonical chat id. */
  appChatId: string
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
        | 'history_cleared'
    }

export type TranscriptMediaAssetOwnershipBatchResult =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'invalid_asset'
        | 'invalid_chat'
        | 'missing'
        | 'ownership_limit'
        | 'persistence_failed'
        | 'history_cleared'
      /** Index of the first offending input when the failure is input-specific. */
      failedAt?: number
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
        | 'history_cleared'
      /** Index of the first offending input when the failure is input-specific. */
      failedAt?: number
    }

export interface TranscriptMediaAssetPurgeSummary {
  revokedChats: number
  revokedGrants: number
  deletedAssets: number
}

export type TranscriptMediaHistoryMutationScope =
  | {
      kind: 'chat' | 'truncate'
      appChatIds: readonly string[]
    }
  | {
      kind: 'workspace'
      workspaceId: string
      appChatIds: readonly string[]
    }
  | {
      kind: 'global'
    }

declare const transcriptMediaHistoryMutationHoldBrand: unique symbol

/**
 * Opaque process-local admission hold spanning durable history prepare through
 * history commit. Only the store that issued a hold can release it.
 */
export type TranscriptMediaHistoryMutationHold = Readonly<{
  id: string
  kind: TranscriptMediaHistoryMutationScope['kind']
  [transcriptMediaHistoryMutationHoldBrand]: true
}>

export type TranscriptMediaAssetOwnedWriteBatchResult =
  | { ok: true; assets: Array<Extract<TranscriptMediaContentAddressedWriteResult, { ok: true }>> }
  | { ok: false; reason: string; failedAt?: number }

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

declare const transcriptMediaOwnedFileWriteReceiptBrand: unique symbol

export type TranscriptMediaOwnedFileWriteReceipt = Readonly<{
  id: string
  [transcriptMediaOwnedFileWriteReceiptBrand]: true
}>

export type TranscriptMediaOwnedFileWriteResult =
  | (Extract<TranscriptMediaContentAddressedWriteResult, { ok: true }> & {
      ownershipReceipt: TranscriptMediaOwnedFileWriteReceipt
    })
  | Extract<TranscriptMediaContentAddressedWriteResult, { ok: false }>

type TranscriptMediaInternalFileWriteResult =
  | (Extract<TranscriptMediaContentAddressedWriteResult, { ok: true }> & {
      /** Present only when this exact ingest exclusively published the target inode. */
      createdStat?: fs.Stats
    })
  | Extract<TranscriptMediaContentAddressedWriteResult, { ok: false }>

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
  if (left.ino !== right.ino) return false
  if (process.platform === 'win32') {
    // libuv fills `dev` inconsistently between handle-derived (fstat) and
    // path-derived (stat/lstat) stats on Windows, so a strict dev compare
    // rejects the very file we just wrote. The NTFS file index (`ino`) is
    // the identity authority there; tolerate a missing dev on either side.
    return left.dev === right.dev || left.dev === 0 || right.dev === 0
  }
  return left.dev === right.dev
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
      // POSIX-only: Windows synthesizes mode bits (0o777 directories), so the
      // group/world-writable gate carries no signal there. ACLs are the
      // Windows mechanism and are not modeled; the structural, symlink, and
      // identity checks above still apply on every platform.
      (process.platform === 'win32' || (stat.mode & 0o022) === 0)
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

function safeAssetIngestTempPath(baseDir: string): string | null {
  try {
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    if (!directoryIsMainOwned(baseDir)) return null
    const realBase = fs.realpathSync.native(baseDir)
    return path.join(realBase, `.ingest-${process.pid}-${randomUUID()}.tmp`)
  } catch {
    return null
  }
}

async function descriptorSnapshotMatchesPath(
  handle: fs.promises.FileHandle,
  filePath: string,
  expected: fs.Stats
): Promise<boolean> {
  try {
    const [descriptorStat, pathStat] = await Promise.all([
      handle.stat(),
      fs.promises.lstat(filePath)
    ])
    return (
      descriptorStat.isFile() &&
      pathStat.isFile() &&
      !pathStat.isSymbolicLink() &&
      sameFileSnapshotVersion(descriptorStat, expected) &&
      sameFileSnapshotVersion(pathStat, expected)
    )
  } catch {
    return false
  }
}

async function writeDescriptorChunk(
  handle: fs.promises.FileHandle,
  buffer: Buffer,
  byteLength: number,
  position: number
): Promise<void> {
  let written = 0
  while (written < byteLength) {
    const result = await handle.write(
      buffer,
      written,
      byteLength - written,
      position + written
    )
    if (result.bytesWritten <= 0) throw new Error('short_write')
    written += result.bytesWritten
  }
}

async function readDescriptorChunk(
  handle: fs.promises.FileHandle,
  buffer: Buffer,
  byteLength: number,
  position: number
): Promise<number> {
  let read = 0
  while (read < byteLength) {
    const result = await handle.read(buffer, read, byteLength - read, position + read)
    if (result.bytesRead <= 0) break
    read += result.bytesRead
  }
  return read
}

async function descriptorsEqual(
  left: fs.promises.FileHandle,
  right: fs.promises.FileHandle,
  byteLength: number
): Promise<boolean> {
  const chunkBytes = Math.min(TRANSCRIPT_MEDIA_FILE_INGEST_CHUNK_BYTES, byteLength)
  const leftChunk = Buffer.allocUnsafe(chunkBytes)
  const rightChunk = Buffer.allocUnsafe(chunkBytes)
  let position = 0
  while (position < byteLength) {
    const requested = Math.min(chunkBytes, byteLength - position)
    const [leftRead, rightRead] = await Promise.all([
      readDescriptorChunk(left, leftChunk, requested, position),
      readDescriptorChunk(right, rightChunk, requested, position)
    ])
    if (
      leftRead !== requested ||
      rightRead !== requested ||
      !leftChunk.subarray(0, requested).equals(rightChunk.subarray(0, requested))
    ) {
      return false
    }
    position += requested
  }
  return true
}

async function safeUnlinkMatchingFile(filePath: string, expected: fs.Stats): Promise<void> {
  try {
    const current = await fs.promises.lstat(filePath)
    if (!current.isSymbolicLink() && current.isFile() && sameFileIdentity(current, expected)) {
      await fs.promises.unlink(filePath)
    }
  } catch {
    // Best-effort cleanup of a file created by this process.
  }
}

function processIsDefinitelyDead(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH'
  }
}

async function safeUnlinkMatchingStaleFile(
  filePath: string,
  expected: fs.Stats
): Promise<void> {
  try {
    const current = await fs.promises.lstat(filePath)
    if (
      !current.isSymbolicLink() &&
      current.isFile() &&
      sameFileSnapshotVersion(current, expected)
    ) {
      await fs.promises.unlink(filePath)
    }
  } catch {
    // Best-effort cleanup; any ambiguity preserves the candidate.
  }
}

async function cleanupStaleAssetIngestTemps(baseDir: string): Promise<void> {
  try {
    if (!directoryIsMainOwned(baseDir)) return
    const realBase = fs.realpathSync.native(baseDir)
    const entries = await fs.promises.readdir(realBase)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    const now = Date.now()
    for (const entry of entries) {
      const match = TRANSCRIPT_MEDIA_INGEST_TEMP_PATTERN.exec(entry)
      if (!match) continue
      const pid = Number(match[1])
      if (pid === process.pid) continue
      const candidate = path.join(realBase, entry)
      let candidateStat: fs.Stats
      try {
        candidateStat = await fs.promises.lstat(candidate)
      } catch {
        continue
      }
      if (
        candidateStat.isSymbolicLink() ||
        !candidateStat.isFile() ||
        (uid !== null && candidateStat.uid !== uid) ||
        (uid !== null && (candidateStat.mode & 0o077) !== 0) ||
        !Number.isFinite(candidateStat.mtimeMs) ||
        now - candidateStat.mtimeMs < TRANSCRIPT_MEDIA_STALE_INGEST_TEMP_AGE_MS ||
        !processIsDefinitelyDead(pid)
      ) {
        continue
      }
      await safeUnlinkMatchingStaleFile(candidate, candidateStat)
    }
  } catch {
    // Reclamation is opportunistic and must never make a valid ingest fail.
  }
}

async function fsyncDirectoryBestEffort(directory: string): Promise<void> {
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(directory, fs.constants.O_RDONLY)
    await handle.sync()
  } catch {
    // Some platforms/filesystems reject directory fsync.
  } finally {
    await handle?.close().catch(() => undefined)
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

type TranscriptMediaOwnershipLoadResult =
  | { status: 'missing'; ownership: Map<string, Set<string>> }
  | { status: 'valid'; ownership: Map<string, Set<string>> }
  | { status: 'unavailable'; ownership: Map<string, Set<string>> }

interface TranscriptMediaPurgeFileIdentity {
  dev: string
  ino: string
  size: number
  mtimeMs: number
  ctimeMs: number
}

interface TranscriptMediaPurgeDirectoryIdentity {
  dev: string
  ino: string
}

interface TranscriptMediaPurgeFileRecord {
  original: string
  quarantine: string
  identity: TranscriptMediaPurgeFileIdentity
}

interface TranscriptMediaPurgeDirectoryRecord {
  relativePath: string
  identity: TranscriptMediaPurgeDirectoryIdentity
  removeWhenCommitted: boolean
}

interface TranscriptMediaPurgeJournal {
  version: 1
  transactionId: string
  mode: 'chats' | 'global'
  rootIdentity: TranscriptMediaPurgeDirectoryIdentity
  oldOwnershipDigest: string
  newOwnershipDigest: string | null
  oldLedger: TranscriptMediaPurgeFileRecord
  newLedgerTemp?: {
    relativePath: string
    identity: TranscriptMediaPurgeFileIdentity
  }
  files: TranscriptMediaPurgeFileRecord[]
  directories: TranscriptMediaPurgeDirectoryRecord[]
}

interface TranscriptMediaStrictFile {
  path: string
  stat: fs.Stats
  identity: TranscriptMediaPurgeFileIdentity
  buffer?: Buffer
}

type TranscriptMediaStrictOwnershipState =
  | { status: 'missing' }
  | ({ status: 'present'; digest: string } & TranscriptMediaStrictFile)
  | { status: 'unsafe' }

type TranscriptMediaPurgeRecoveryResult =
  | { ok: true; outcome: 'none' | 'rolled_back' | 'committed' }
  | { ok: false }

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

function digestBytes(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('base64url')
}

function purgeFileIdentity(stat: fs.Stats): TranscriptMediaPurgeFileIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  }
}

function purgeDirectoryIdentity(stat: fs.Stats): TranscriptMediaPurgeDirectoryIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

function samePurgeFileIdentity(
  stat: fs.Stats,
  expected: TranscriptMediaPurgeFileIdentity,
  includeSnapshot: boolean
): boolean {
  return (
    String(stat.dev) === expected.dev &&
    String(stat.ino) === expected.ino &&
    stat.size === expected.size &&
    (!includeSnapshot ||
      (stat.mtimeMs === expected.mtimeMs && stat.ctimeMs === expected.ctimeMs))
  )
}

function samePurgeDirectoryIdentity(
  stat: fs.Stats,
  expected: TranscriptMediaPurgeDirectoryIdentity
): boolean {
  return String(stat.dev) === expected.dev && String(stat.ino) === expected.ino
}

function statIsMainOwned(stat: fs.Stats): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  return (
    (uid === null || stat.uid === uid) &&
    (process.platform === 'win32' || (stat.mode & 0o022) === 0)
  )
}

function strictDirectory(
  directory: string,
  expected?: TranscriptMediaPurgeDirectoryIdentity
): { realPath: string; identity: TranscriptMediaPurgeDirectoryIdentity } | null {
  try {
    const lstat = fs.lstatSync(directory)
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) return null
    const stat = fs.statSync(directory)
    if (
      !stat.isDirectory() ||
      !sameFileIdentity(lstat, stat) ||
      !statIsMainOwned(stat) ||
      (expected && !samePurgeDirectoryIdentity(stat, expected))
    ) {
      return null
    }
    return { realPath: fs.realpathSync.native(directory), identity: purgeDirectoryIdentity(stat) }
  } catch {
    return null
  }
}

function strictPurgeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value)) {
    return false
  }
  const segments = value.split(/[\\/]/)
  return (
    segments.length <= 2 &&
    segments.every((segment) => Boolean(segment) && segment !== '.' && segment !== '..')
  )
}

function resolvePurgeRelativePath(baseDir: string, relativePath: string): string | null {
  if (!strictPurgeRelativePath(relativePath)) return null
  const candidate = path.resolve(baseDir, relativePath)
  return pathWithinRoot(candidate, path.resolve(baseDir)) ? candidate : null
}

function strictRegularFile(
  filePath: string,
  options: {
    expected?: TranscriptMediaPurgeFileIdentity
    includeExpectedSnapshot?: boolean
    readMaxBytes?: number
  } = {}
): TranscriptMediaStrictFile | null {
  let fd: number | null = null
  try {
    const before = fs.lstatSync(filePath)
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      !statIsMainOwned(before)
    ) {
      return null
    }
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const descriptor = fs.fstatSync(fd)
    const after = fs.lstatSync(filePath)
    if (
      !descriptor.isFile() ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      descriptor.nlink !== 1 ||
      after.nlink !== 1 ||
      !sameFileSnapshotVersion(before, descriptor) ||
      !sameFileSnapshotVersion(descriptor, after) ||
      !statIsMainOwned(descriptor) ||
      (options.expected &&
        !samePurgeFileIdentity(
          descriptor,
          options.expected,
          options.includeExpectedSnapshot !== false
        ))
    ) {
      return null
    }
    const buffer =
      options.readMaxBytes === undefined
        ? undefined
        : descriptor.size > 0 && descriptor.size <= options.readMaxBytes
          ? readExactDescriptor(fd, descriptor.size)
          : null
    if (options.readMaxBytes !== undefined && !buffer) return null
    return {
      path: filePath,
      stat: descriptor,
      identity: purgeFileIdentity(descriptor),
      ...(buffer ? { buffer } : {})
    }
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // The caller will fail closed on any subsequent identity check.
      }
    }
  }
}

function pathIsMissing(filePath: string): boolean {
  try {
    fs.lstatSync(filePath)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
  }
}

function strictOwnershipState(baseDir: string): TranscriptMediaStrictOwnershipState {
  const ownershipPath = safeOwnershipPath(baseDir, false)
  if (!ownershipPath) return { status: 'unsafe' }
  if (pathIsMissing(ownershipPath)) return { status: 'missing' }
  const file = strictRegularFile(ownershipPath, {
    readMaxBytes: TRANSCRIPT_MEDIA_OWNERSHIP_MAX_FILE_BYTES
  })
  if (!file?.buffer) return { status: 'unsafe' }
  return { status: 'present', ...file, digest: digestBytes(file.buffer) }
}

function fsyncDirectoryStrict(directory: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY)
    fs.fsyncSync(fd)
  } catch (error) {
    if (process.platform !== 'win32') throw error
    const code = (error as NodeJS.ErrnoException)?.code
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EINVAL') throw error
  } finally {
    if (fd !== null) fs.closeSync(fd)
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

function loadOwnership(baseDir: string): TranscriptMediaOwnershipLoadResult {
  try {
    fs.lstatSync(baseDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { status: 'missing', ownership: new Map() }
    }
    return { status: 'unavailable', ownership: new Map() }
  }
  const ownershipPath = safeOwnershipPath(baseDir, false)
  if (!ownershipPath) return { status: 'unavailable', ownership: new Map() }
  let fd: number | null = null
  try {
    let lstat: fs.Stats
    try {
      lstat = fs.lstatSync(ownershipPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { status: 'missing', ownership: new Map() }
      }
      return { status: 'unavailable', ownership: new Map() }
    }
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      return { status: 'unavailable', ownership: new Map() }
    }
    fd = fs.openSync(ownershipPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (
      !stat.isFile() ||
      !sameFileIdentity(stat, lstat) ||
      (uid !== null && stat.uid !== uid) ||
      (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) ||
      stat.size <= 0 ||
      stat.size > TRANSCRIPT_MEDIA_OWNERSHIP_MAX_FILE_BYTES
    ) {
      return { status: 'unavailable', ownership: new Map() }
    }
    const raw = readExactDescriptor(fd, stat.size)
    if (!raw) return { status: 'unavailable', ownership: new Map() }
    const parsed = JSON.parse(raw.toString('utf8')) as Partial<TranscriptMediaOwnershipSnapshot>
    if (
      parsed.version !== TRANSCRIPT_MEDIA_OWNERSHIP_VERSION ||
      !Array.isArray(parsed.grants) ||
      parsed.grants.length > TRANSCRIPT_MEDIA_OWNERSHIP_MAX_ASSETS
    ) {
      return { status: 'unavailable', ownership: new Map() }
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
        return { status: 'unavailable', ownership: new Map() }
      }
      const appChatIds = new Set<string>()
      for (const appChatId of grant.appChatIds) {
        if (!safeOwnershipChatId(appChatId)) {
          return { status: 'unavailable', ownership: new Map() }
        }
        appChatIds.add(appChatId)
      }
      loaded.set(grant.asset, appChatIds)
    }
    return { status: 'valid', ownership: loaded }
  } catch {
    return { status: 'unavailable', ownership: new Map() }
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
  const oldOwnership = strictOwnershipState(baseDir)
  if (
    oldOwnership.status === 'unsafe' ||
    (oldOwnership.status === 'present' && !oldOwnership.buffer)
  ) {
    return false
  }
  const serialized = preparedSnapshot
  const tempPath = `${ownershipPath}.${process.pid}.${randomUUID()}.tmp`
  const rollbackPath = `${ownershipPath}.${process.pid}.${randomUUID()}.rollback.tmp`
  let fd: number | null = null
  let replacementRenamed = false
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
    replacementRenamed = true
    const replacement = strictOwnershipState(baseDir)
    if (replacement.status !== 'present' || replacement.digest !== digestBytes(serialized)) {
      throw new Error('Transcript media ownership replacement was redirected.')
    }
    fsyncDirectoryStrict(path.dirname(ownershipPath))
    return true
  } catch {
    if (replacementRenamed) {
      try {
        const current = strictOwnershipState(baseDir)
        if (current.status !== 'present' || current.digest !== digestBytes(serialized)) {
          throw new Error('Transcript media ownership rollback found an ambiguous replacement.')
        }
        if (oldOwnership.status === 'present') {
          createStrictFile(rollbackPath, oldOwnership.buffer!)
          fs.renameSync(rollbackPath, ownershipPath)
        } else {
          fs.unlinkSync(ownershipPath)
        }
        fsyncDirectoryStrict(path.dirname(ownershipPath))
      } catch {
        // The caller permanently closes ownership mutation on ambiguous rollback.
      }
    }
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
    try {
      if (fs.existsSync(rollbackPath)) fs.unlinkSync(rollbackPath)
    } catch {
      // A stale rollback temp is safer than deleting an ambiguous replacement.
    }
  }
}

function validPurgeIdentity(value: unknown): value is TranscriptMediaPurgeFileIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const identity = value as Partial<TranscriptMediaPurgeFileIdentity>
  return (
    typeof identity.dev === 'string' &&
    /^\d+$/.test(identity.dev) &&
    typeof identity.ino === 'string' &&
    /^\d+$/.test(identity.ino) &&
    typeof identity.size === 'number' &&
    Number.isSafeInteger(identity.size) &&
    identity.size >= 0 &&
    typeof identity.mtimeMs === 'number' &&
    Number.isFinite(identity.mtimeMs) &&
    typeof identity.ctimeMs === 'number' &&
    Number.isFinite(identity.ctimeMs)
  )
}

function validPurgeDirectoryIdentity(
  value: unknown
): value is TranscriptMediaPurgeDirectoryIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const identity = value as Partial<TranscriptMediaPurgeDirectoryIdentity>
  return (
    typeof identity.dev === 'string' &&
    /^\d+$/.test(identity.dev) &&
    typeof identity.ino === 'string' &&
    /^\d+$/.test(identity.ino)
  )
}

function validPurgeFileRecord(value: unknown): value is TranscriptMediaPurgeFileRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<TranscriptMediaPurgeFileRecord>
  if (
    !strictPurgeRelativePath(record.original) ||
    !strictPurgeRelativePath(record.quarantine) ||
    !validPurgeIdentity(record.identity)
  ) {
    return false
  }
  return path.dirname(record.original) === path.dirname(record.quarantine)
}

function validPurgeJournal(value: unknown): value is TranscriptMediaPurgeJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const journal = value as Partial<TranscriptMediaPurgeJournal>
  if (
    journal.version !== TRANSCRIPT_MEDIA_PURGE_JOURNAL_VERSION ||
    typeof journal.transactionId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      journal.transactionId
    ) ||
    (journal.mode !== 'chats' && journal.mode !== 'global') ||
    !validPurgeDirectoryIdentity(journal.rootIdentity) ||
    typeof journal.oldOwnershipDigest !== 'string' ||
    !SHA256_BASE64URL_PATTERN.test(journal.oldOwnershipDigest) ||
    (journal.newOwnershipDigest !== null &&
      (typeof journal.newOwnershipDigest !== 'string' ||
        !SHA256_BASE64URL_PATTERN.test(journal.newOwnershipDigest))) ||
    !validPurgeFileRecord(journal.oldLedger) ||
    !Array.isArray(journal.files) ||
    journal.files.length > TRANSCRIPT_MEDIA_OWNERSHIP_MAX_ASSETS ||
    !journal.files.every(validPurgeFileRecord) ||
    !Array.isArray(journal.directories) ||
    journal.directories.length > TRANSCRIPT_MEDIA_OWNERSHIP_MAX_ASSETS ||
    !journal.directories.every((record) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) return false
      const directory = record as Partial<TranscriptMediaPurgeDirectoryRecord>
      return (
        strictPurgeRelativePath(directory.relativePath) &&
        !directory.relativePath.includes(path.sep) &&
        validPurgeDirectoryIdentity(directory.identity) &&
        typeof directory.removeWhenCommitted === 'boolean'
      )
    })
  ) {
    return false
  }
  if (
    journal.newLedgerTemp !== undefined &&
    (!journal.newLedgerTemp ||
      typeof journal.newLedgerTemp !== 'object' ||
      Array.isArray(journal.newLedgerTemp) ||
      !strictPurgeRelativePath(journal.newLedgerTemp.relativePath) ||
      journal.newLedgerTemp.relativePath.includes(path.sep) ||
      !validPurgeIdentity(journal.newLedgerTemp.identity))
  ) {
    return false
  }
  if (
    (journal.mode === 'chats') !==
    (typeof journal.newOwnershipDigest === 'string' && Boolean(journal.newLedgerTemp))
  ) {
    return false
  }
  const paths = [
    journal.oldLedger.original,
    journal.oldLedger.quarantine,
    ...journal.files.flatMap((record) => [record.original, record.quarantine]),
    ...(journal.newLedgerTemp ? [journal.newLedgerTemp.relativePath] : [])
  ]
  return new Set(paths).size === paths.length
}

function purgeJournalPath(baseDir: string): string | null {
  const ownershipPath = safeOwnershipPath(baseDir, false)
  return ownershipPath
    ? path.join(path.dirname(ownershipPath), TRANSCRIPT_MEDIA_PURGE_JOURNAL_FILE)
    : null
}

function loadPurgeJournal(baseDir: string):
  | { status: 'missing' }
  | { status: 'valid'; journal: TranscriptMediaPurgeJournal; file: TranscriptMediaStrictFile }
  | { status: 'unsafe' } {
  const journalPath = purgeJournalPath(baseDir)
  if (!journalPath) return { status: 'unsafe' }
  if (pathIsMissing(journalPath)) return { status: 'missing' }
  const file = strictRegularFile(journalPath, {
    readMaxBytes: TRANSCRIPT_MEDIA_PURGE_JOURNAL_MAX_FILE_BYTES
  })
  if (!file?.buffer) return { status: 'unsafe' }
  try {
    const parsed = JSON.parse(file.buffer.toString('utf8'))
    return validPurgeJournal(parsed)
      ? { status: 'valid', journal: parsed, file }
      : { status: 'unsafe' }
  } catch {
    return { status: 'unsafe' }
  }
}

function publishPurgeJournal(
  baseDir: string,
  journal: TranscriptMediaPurgeJournal
): TranscriptMediaStrictFile {
  const journalPath = purgeJournalPath(baseDir)
  if (!journalPath) throw new Error('Transcript media purge root is unsafe.')
  const serialized = Buffer.from(JSON.stringify(journal), 'utf8')
  if (serialized.length <= 0 || serialized.length > TRANSCRIPT_MEDIA_PURGE_JOURNAL_MAX_FILE_BYTES) {
    throw new Error('Transcript media purge journal is too large.')
  }
  let fd: number | null = null
  let created: fs.Stats | null = null
  try {
    fd = fs.openSync(
      journalPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600
    )
    fs.fchmodSync(fd, 0o600)
    created = fs.fstatSync(fd)
    let offset = 0
    while (offset < serialized.length) {
      const written = fs.writeSync(fd, serialized, offset, serialized.length - offset, offset)
      if (written <= 0) throw new Error('short_write')
      offset += written
    }
    fs.fsyncSync(fd)
    const finalStat = fs.fstatSync(fd)
    const pathStat = fs.lstatSync(journalPath)
    if (
      !finalStat.isFile() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      finalStat.nlink !== 1 ||
      pathStat.nlink !== 1 ||
      finalStat.size !== serialized.length ||
      !sameFileIdentity(finalStat, created) ||
      !sameFileIdentity(pathStat, created)
    ) {
      throw new Error('Transcript media purge journal publication was redirected.')
    }
    fs.closeSync(fd)
    fd = null
    fsyncDirectoryStrict(path.dirname(journalPath))
    const published = strictRegularFile(journalPath, {
      expected: purgeFileIdentity(finalStat),
      includeExpectedSnapshot: false,
      readMaxBytes: TRANSCRIPT_MEDIA_PURGE_JOURNAL_MAX_FILE_BYTES
    })
    if (!published?.buffer || !published.buffer.equals(serialized)) {
      throw new Error('Transcript media purge journal failed verification.')
    }
    return published
  } catch (error) {
    if (created) {
      try {
        const current = fs.lstatSync(journalPath)
        if (!current.isSymbolicLink() && sameFileIdentity(current, created)) {
          fs.unlinkSync(journalPath)
        }
      } catch {
        // A surviving journal blocks every later mutation until recovery.
      }
    }
    throw error
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Preserve the original publication failure.
      }
    }
  }
}

function createStrictFile(
  filePath: string,
  buffer: Buffer
): TranscriptMediaStrictFile {
  let fd: number | null = null
  let created: fs.Stats | null = null
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600
    )
    fs.fchmodSync(fd, 0o600)
    created = fs.fstatSync(fd)
    let offset = 0
    while (offset < buffer.length) {
      const written = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset)
      if (written <= 0) throw new Error('short_write')
      offset += written
    }
    fs.fsyncSync(fd)
    const finalStat = fs.fstatSync(fd)
    const pathStat = fs.lstatSync(filePath)
    if (
      !finalStat.isFile() ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      finalStat.nlink !== 1 ||
      finalStat.size !== buffer.length ||
      !sameFileIdentity(finalStat, created) ||
      !sameFileIdentity(pathStat, created)
    ) {
      throw new Error('Strict transcript media file publication was redirected.')
    }
    fs.closeSync(fd)
    fd = null
    return { path: filePath, stat: finalStat, identity: purgeFileIdentity(finalStat), buffer }
  } catch (error) {
    if (created) {
      try {
        const current = fs.lstatSync(filePath)
        if (!current.isSymbolicLink() && sameFileIdentity(current, created)) {
          fs.unlinkSync(filePath)
        }
      } catch {
        // A surviving unexpected file makes the enclosing transaction fail closed.
      }
    }
    throw error
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Preserve the original write failure.
      }
    }
  }
}

function assertPurgeRoot(
  baseDir: string,
  expected?: TranscriptMediaPurgeDirectoryIdentity
): { realBase: string; identity: TranscriptMediaPurgeDirectoryIdentity } {
  const root = strictDirectory(baseDir, expected)
  if (!root) throw new Error('Transcript media purge root is unsafe.')
  return { realBase: root.realPath, identity: root.identity }
}

function assertPurgeParent(
  baseDir: string,
  relativePath: string,
  directories: readonly TranscriptMediaPurgeDirectoryRecord[],
  rootIdentity: TranscriptMediaPurgeDirectoryIdentity
): string {
  const { realBase } = assertPurgeRoot(baseDir, rootIdentity)
  const resolved = resolvePurgeRelativePath(realBase, relativePath)
  if (!resolved) throw new Error('Transcript media purge path escaped its root.')
  const relativeParent = path.relative(realBase, path.dirname(resolved))
  if (!relativeParent) return resolved
  const directory = directories.find((candidate) => candidate.relativePath === relativeParent)
  if (!directory) throw new Error('Transcript media purge directory was not journaled.')
  const parent = strictDirectory(path.dirname(resolved), directory.identity)
  if (!parent || !pathWithinRoot(parent.realPath, realBase)) {
    throw new Error('Transcript media purge directory was redirected.')
  }
  return path.join(parent.realPath, path.basename(resolved))
}

function strictPathState(
  filePath: string,
  expected: TranscriptMediaPurgeFileIdentity,
  includeSnapshot: boolean
): 'missing' | 'matching' | 'unsafe' {
  if (pathIsMissing(filePath)) return 'missing'
  return strictRegularFile(filePath, {
    expected,
    includeExpectedSnapshot: includeSnapshot
  })
    ? 'matching'
    : 'unsafe'
}

function movePurgeFileToQuarantine(
  baseDir: string,
  journal: TranscriptMediaPurgeJournal,
  record: TranscriptMediaPurgeFileRecord
): void {
  const original = assertPurgeParent(
    baseDir,
    record.original,
    journal.directories,
    journal.rootIdentity
  )
  const quarantine = assertPurgeParent(
    baseDir,
    record.quarantine,
    journal.directories,
    journal.rootIdentity
  )
  if (strictPathState(original, record.identity, true) !== 'matching') {
    throw new Error(`Transcript media purge source ${record.original} changed.`)
  }
  if (!pathIsMissing(quarantine)) {
    throw new Error(`Transcript media purge quarantine ${record.quarantine} already exists.`)
  }
  let fd: number | null = null
  try {
    fd = fs.openSync(original, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const descriptor = fs.fstatSync(fd)
    const pathStat = fs.lstatSync(original)
    if (
      descriptor.nlink !== 1 ||
      pathStat.nlink !== 1 ||
      !samePurgeFileIdentity(descriptor, record.identity, true) ||
      !sameFileSnapshotVersion(descriptor, pathStat)
    ) {
      throw new Error(`Transcript media purge source ${record.original} changed.`)
    }
    assertPurgeParent(baseDir, record.original, journal.directories, journal.rootIdentity)
    fs.renameSync(original, quarantine)
    const moved = fs.lstatSync(quarantine)
    if (
      moved.isSymbolicLink() ||
      !moved.isFile() ||
      moved.nlink !== 1 ||
      !sameFileIdentity(moved, descriptor) ||
      !samePurgeFileIdentity(moved, record.identity, false) ||
      !pathIsMissing(original)
    ) {
      throw new Error(`Transcript media purge move for ${record.original} was redirected.`)
    }
    assertPurgeParent(baseDir, record.quarantine, journal.directories, journal.rootIdentity)
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

function restorePurgeFile(
  baseDir: string,
  journal: TranscriptMediaPurgeJournal,
  record: TranscriptMediaPurgeFileRecord
): void {
  const original = assertPurgeParent(
    baseDir,
    record.original,
    journal.directories,
    journal.rootIdentity
  )
  const quarantine = assertPurgeParent(
    baseDir,
    record.quarantine,
    journal.directories,
    journal.rootIdentity
  )
  const originalState = strictPathState(original, record.identity, false)
  const quarantineState = strictPathState(quarantine, record.identity, false)
  if (originalState === 'matching' && quarantineState === 'missing') return
  if (originalState !== 'missing' || quarantineState !== 'matching') {
    throw new Error(`Transcript media purge rollback for ${record.original} is ambiguous.`)
  }
  let fd: number | null = null
  try {
    fd = fs.openSync(quarantine, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const descriptor = fs.fstatSync(fd)
    const pathStat = fs.lstatSync(quarantine)
    if (
      descriptor.nlink !== 1 ||
      pathStat.nlink !== 1 ||
      !samePurgeFileIdentity(descriptor, record.identity, false) ||
      !sameFileIdentity(descriptor, pathStat)
    ) {
      throw new Error(`Transcript media purge rollback for ${record.original} changed.`)
    }
    fs.renameSync(quarantine, original)
    const restored = fs.lstatSync(original)
    if (
      restored.isSymbolicLink() ||
      !restored.isFile() ||
      restored.nlink !== 1 ||
      !sameFileIdentity(restored, descriptor) ||
      !pathIsMissing(quarantine)
    ) {
      throw new Error(`Transcript media purge rollback for ${record.original} was redirected.`)
    }
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

function deleteQuarantinedPurgeFile(
  baseDir: string,
  journal: TranscriptMediaPurgeJournal,
  record: TranscriptMediaPurgeFileRecord
): void {
  const original = assertPurgeParent(
    baseDir,
    record.original,
    journal.directories,
    journal.rootIdentity
  )
  const quarantine = assertPurgeParent(
    baseDir,
    record.quarantine,
    journal.directories,
    journal.rootIdentity
  )
  if (!pathIsMissing(original)) {
    throw new Error(`Transcript media purge source ${record.original} reappeared.`)
  }
  if (pathIsMissing(quarantine)) return
  let fd: number | null = null
  try {
    fd = fs.openSync(quarantine, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const descriptor = fs.fstatSync(fd)
    const pathStat = fs.lstatSync(quarantine)
    if (
      descriptor.nlink !== 1 ||
      pathStat.nlink !== 1 ||
      !samePurgeFileIdentity(descriptor, record.identity, false) ||
      !sameFileIdentity(descriptor, pathStat)
    ) {
      throw new Error(`Transcript media purge quarantine ${record.quarantine} changed.`)
    }
    fs.unlinkSync(quarantine)
    if (!pathIsMissing(quarantine)) {
      throw new Error(`Transcript media purge quarantine ${record.quarantine} survived unlink.`)
    }
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

function removePurgeJournalStrict(
  baseDir: string,
  expected: TranscriptMediaPurgeFileIdentity
): void {
  const journalPath = purgeJournalPath(baseDir)
  if (!journalPath) throw new Error('Transcript media purge journal path is unsafe.')
  const file = strictRegularFile(journalPath, {
    expected,
    includeExpectedSnapshot: false
  })
  if (!file) throw new Error('Transcript media purge journal changed.')
  fs.unlinkSync(journalPath)
  if (!pathIsMissing(journalPath)) throw new Error('Transcript media purge journal survived unlink.')
  fsyncDirectoryStrict(path.dirname(journalPath))
}

function removeNewLedgerTempStrict(
  baseDir: string,
  journal: TranscriptMediaPurgeJournal
): void {
  if (!journal.newLedgerTemp) return
  const tempPath = resolvePurgeRelativePath(baseDir, journal.newLedgerTemp.relativePath)
  if (!tempPath) throw new Error('Transcript media purge ledger temp escaped its root.')
  if (pathIsMissing(tempPath)) return
  const file = strictRegularFile(tempPath, {
    expected: journal.newLedgerTemp.identity,
    includeExpectedSnapshot: false
  })
  if (!file) throw new Error('Transcript media purge ledger temp changed.')
  fs.unlinkSync(tempPath)
}

function publishNewOwnershipLedger(
  baseDir: string,
  journal: TranscriptMediaPurgeJournal
): void {
  if (!journal.newLedgerTemp || !journal.newOwnershipDigest) {
    throw new Error('Transcript media purge replacement ledger is missing.')
  }
  const ownershipPath = safeOwnershipPath(baseDir, false)
  const tempPath = resolvePurgeRelativePath(baseDir, journal.newLedgerTemp.relativePath)
  if (!ownershipPath || !tempPath || !pathIsMissing(ownershipPath)) {
    throw new Error('Transcript media ownership ledger publication is ambiguous.')
  }
  const temp = strictRegularFile(tempPath, {
    expected: journal.newLedgerTemp.identity,
    includeExpectedSnapshot: false,
    readMaxBytes: TRANSCRIPT_MEDIA_OWNERSHIP_MAX_FILE_BYTES
  })
  if (!temp?.buffer || digestBytes(temp.buffer) !== journal.newOwnershipDigest) {
    throw new Error('Transcript media ownership ledger temp changed.')
  }
  fs.linkSync(tempPath, ownershipPath)
  const published = fs.lstatSync(ownershipPath)
  const linkedTemp = fs.lstatSync(tempPath)
  if (
    published.isSymbolicLink() ||
    !published.isFile() ||
    !linkedTemp.isFile() ||
    published.nlink !== 2 ||
    linkedTemp.nlink !== 2 ||
    !sameFileIdentity(published, temp.stat) ||
    !sameFileIdentity(linkedTemp, temp.stat)
  ) {
    throw new Error('Transcript media ownership ledger publication was redirected.')
  }
  fs.unlinkSync(tempPath)
  const canonical = strictRegularFile(ownershipPath, {
    expected: journal.newLedgerTemp.identity,
    includeExpectedSnapshot: false,
    readMaxBytes: TRANSCRIPT_MEDIA_OWNERSHIP_MAX_FILE_BYTES
  })
  if (!canonical?.buffer || digestBytes(canonical.buffer) !== journal.newOwnershipDigest) {
    throw new Error('Transcript media ownership ledger failed post-publication verification.')
  }
  fsyncDirectoryStrict(path.dirname(ownershipPath))
}

function normalizePublishedLedgerTemp(
  baseDir: string,
  journal: TranscriptMediaPurgeJournal
): void {
  if (!journal.newLedgerTemp || !journal.newOwnershipDigest) return
  const ownershipPath = safeOwnershipPath(baseDir, false)
  const tempPath = resolvePurgeRelativePath(baseDir, journal.newLedgerTemp.relativePath)
  if (!ownershipPath || !tempPath || pathIsMissing(ownershipPath) || pathIsMissing(tempPath)) return
  let canonicalFd: number | null = null
  let tempFd: number | null = null
  try {
    const canonicalPathStat = fs.lstatSync(ownershipPath)
    const tempPathStat = fs.lstatSync(tempPath)
    // Before commit the old canonical ledger and the prepared replacement temp
    // are intentionally distinct single-link files. Recovery will select
    // rollback from the old digest and remove the temp; there is nothing to
    // normalize until exclusive publication links both paths to one inode.
    if (
      canonicalPathStat.nlink === 1 &&
      tempPathStat.nlink === 1 &&
      !sameFileIdentity(canonicalPathStat, tempPathStat)
    ) {
      return
    }
    if (
      canonicalPathStat.isSymbolicLink() ||
      tempPathStat.isSymbolicLink() ||
      !canonicalPathStat.isFile() ||
      !tempPathStat.isFile() ||
      canonicalPathStat.nlink !== 2 ||
      tempPathStat.nlink !== 2 ||
      !sameFileIdentity(canonicalPathStat, tempPathStat) ||
      !samePurgeFileIdentity(canonicalPathStat, journal.newLedgerTemp.identity, false)
    ) {
      throw new Error('Transcript media ownership ledger hard-link state is unsafe.')
    }
    canonicalFd = fs.openSync(ownershipPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    tempFd = fs.openSync(tempPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const canonicalStat = fs.fstatSync(canonicalFd)
    const tempStat = fs.fstatSync(tempFd)
    if (
      !sameFileIdentity(canonicalStat, canonicalPathStat) ||
      !sameFileIdentity(tempStat, canonicalPathStat)
    ) {
      throw new Error('Transcript media ownership ledger hard-link identity changed.')
    }
    const bytes = readExactDescriptor(canonicalFd, canonicalStat.size)
    if (!bytes || digestBytes(bytes) !== journal.newOwnershipDigest) {
      throw new Error('Transcript media ownership ledger hard-link bytes changed.')
    }
    fs.unlinkSync(tempPath)
    fsyncDirectoryStrict(path.dirname(ownershipPath))
  } finally {
    if (canonicalFd !== null) fs.closeSync(canonicalFd)
    if (tempFd !== null) fs.closeSync(tempFd)
  }
}

function ownershipMapMatches(
  left: Map<string, Set<string>>,
  right: Map<string, Set<string>>
): boolean {
  const leftBytes = serializeOwnership(left)
  const rightBytes = serializeOwnership(right)
  return Boolean(leftBytes && rightBytes && leftBytes.equals(rightBytes))
}

function restorePurgeTransaction(
  baseDir: string,
  journal: TranscriptMediaPurgeJournal,
  journalIdentity: TranscriptMediaPurgeFileIdentity
): void {
  for (const record of journal.files) restorePurgeFile(baseDir, journal, record)

  const ownershipPath = safeOwnershipPath(baseDir, false)
  if (!ownershipPath) throw new Error('Transcript media ownership path is unsafe during rollback.')
  const oldQuarantine = assertPurgeParent(
    baseDir,
    journal.oldLedger.quarantine,
    journal.directories,
    journal.rootIdentity
  )
  const current = strictOwnershipState(baseDir)
  const quarantineState = strictPathState(oldQuarantine, journal.oldLedger.identity, false)
  if (current.status === 'present' && current.digest === journal.oldOwnershipDigest) {
    if (quarantineState !== 'missing') {
      throw new Error('Transcript media ownership rollback retained two ledgers.')
    }
  } else if (current.status === 'missing' && quarantineState === 'matching') {
    let fd: number | null = null
    try {
      fd = fs.openSync(oldQuarantine, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      const descriptor = fs.fstatSync(fd)
      const pathStat = fs.lstatSync(oldQuarantine)
      if (
        descriptor.nlink !== 1 ||
        !sameFileIdentity(descriptor, pathStat) ||
        !samePurgeFileIdentity(descriptor, journal.oldLedger.identity, false)
      ) {
        throw new Error('Transcript media ownership rollback ledger changed.')
      }
      fs.renameSync(oldQuarantine, ownershipPath)
      const restored = strictOwnershipState(baseDir)
      if (restored.status !== 'present' || restored.digest !== journal.oldOwnershipDigest) {
        throw new Error('Transcript media ownership rollback ledger failed verification.')
      }
    } finally {
      if (fd !== null) fs.closeSync(fd)
    }
  } else {
    throw new Error('Transcript media ownership rollback state is ambiguous.')
  }
  removeNewLedgerTempStrict(baseDir, journal)
  for (const directory of journal.directories) {
    const resolved = resolvePurgeRelativePath(baseDir, directory.relativePath)
    if (!resolved || !strictDirectory(resolved, directory.identity)) {
      throw new Error('Transcript media purge rollback directory changed.')
    }
    fsyncDirectoryStrict(resolved)
  }
  fsyncDirectoryStrict(baseDir)
  removePurgeJournalStrict(baseDir, journalIdentity)
}

function finishCommittedPurgeTransaction(
  baseDir: string,
  journal: TranscriptMediaPurgeJournal,
  journalIdentity: TranscriptMediaPurgeFileIdentity
): void {
  normalizePublishedLedgerTemp(baseDir, journal)
  for (const record of journal.files) {
    deleteQuarantinedPurgeFile(baseDir, journal, record)
  }
  const oldLedgerQuarantine = assertPurgeParent(
    baseDir,
    journal.oldLedger.quarantine,
    journal.directories,
    journal.rootIdentity
  )
  if (!pathIsMissing(oldLedgerQuarantine)) {
    const oldLedger = strictRegularFile(oldLedgerQuarantine, {
      expected: journal.oldLedger.identity,
      includeExpectedSnapshot: false,
      readMaxBytes: TRANSCRIPT_MEDIA_OWNERSHIP_MAX_FILE_BYTES
    })
    if (!oldLedger?.buffer || digestBytes(oldLedger.buffer) !== journal.oldOwnershipDigest) {
      throw new Error('Transcript media purge old ledger quarantine changed.')
    }
    fs.unlinkSync(oldLedgerQuarantine)
  }
  removeNewLedgerTempStrict(baseDir, journal)
  for (const directory of journal.directories) {
    const resolved = resolvePurgeRelativePath(baseDir, directory.relativePath)
    if (!resolved) throw new Error('Transcript media purge directory escaped its root.')
    if (pathIsMissing(resolved)) {
      if (!directory.removeWhenCommitted) {
        throw new Error('Transcript media purge directory disappeared.')
      }
      continue
    }
    const current = strictDirectory(resolved, directory.identity)
    if (!current) throw new Error('Transcript media purge directory changed.')
    fsyncDirectoryStrict(resolved)
    if (directory.removeWhenCommitted) {
      if (fs.readdirSync(resolved).length !== 0) {
        throw new Error('Transcript media purge directory retained unexpected entries.')
      }
      fs.rmdirSync(resolved)
    }
  }
  if (journal.mode === 'global') {
    const survivors = fs
      .readdirSync(baseDir)
      .filter((entry) => entry !== TRANSCRIPT_MEDIA_PURGE_JOURNAL_FILE)
    if (survivors.length > 0) {
      throw new Error('Transcript media global purge observed a concurrent surviving entry.')
    }
  }
  fsyncDirectoryStrict(baseDir)
  removePurgeJournalStrict(baseDir, journalIdentity)
}

function recoverPurgeTransaction(baseDir: string): TranscriptMediaPurgeRecoveryResult {
  try {
    fs.lstatSync(baseDir)
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? { ok: true, outcome: 'none' }
      : { ok: false }
  }
  const loaded = loadPurgeJournal(baseDir)
  if (loaded.status === 'missing') return { ok: true, outcome: 'none' }
  if (loaded.status !== 'valid') return { ok: false }
  const { journal, file } = loaded
  try {
    assertPurgeRoot(baseDir, journal.rootIdentity)
    normalizePublishedLedgerTemp(baseDir, journal)
    const ownership = strictOwnershipState(baseDir)
    if (
      journal.mode === 'chats' &&
      ownership.status === 'present' &&
      ownership.digest === journal.newOwnershipDigest
    ) {
      finishCommittedPurgeTransaction(baseDir, journal, file.identity)
      return { ok: true, outcome: 'committed' }
    }
    if (
      journal.mode === 'global' &&
      (ownership.status === 'missing' ||
        (ownership.status === 'present' && ownership.digest !== journal.oldOwnershipDigest))
    ) {
      if (ownership.status === 'present') return { ok: false }
      finishCommittedPurgeTransaction(baseDir, journal, file.identity)
      return { ok: true, outcome: 'committed' }
    }
    if (
      ownership.status === 'present' &&
      ownership.digest !== journal.oldOwnershipDigest
    ) {
      return { ok: false }
    }
    restorePurgeTransaction(baseDir, journal, file.identity)
    return { ok: true, outcome: 'rolled_back' }
  } catch {
    return { ok: false }
  }
}

function purgeQuarantineRelativePath(
  original: string,
  transactionId: string,
  index: number
): string {
  const parent = path.dirname(original)
  const name = `.purge-${transactionId}-${String(index).padStart(6, '0')}.tmp`
  return parent === '.' ? name : path.join(parent, name)
}

function inspectPurgeFileRecord(
  baseDir: string,
  original: string,
  transactionId: string,
  index: number
): TranscriptMediaPurgeFileRecord {
  const resolved = resolvePurgeRelativePath(baseDir, original)
  if (!resolved) throw new Error('Transcript media purge source escaped its root.')
  const file = strictRegularFile(resolved)
  if (!file) throw new Error(`Transcript media purge source ${original} is unsafe.`)
  return {
    original,
    quarantine: purgeQuarantineRelativePath(original, transactionId, index),
    identity: file.identity
  }
}

function ownershipAssetRelativePath(asset: string): string | null {
  if (!validOwnershipAssetKey(asset)) return null
  const separator = asset.lastIndexOf('.')
  const sha256 = asset.slice(0, separator)
  return path.join(sha256.slice(0, 2), asset)
}

function createEmptyOwnershipLedgerStrict(baseDir: string): TranscriptMediaStrictOwnershipState {
  const ownershipPath = safeOwnershipPath(baseDir, true)
  if (!ownershipPath) throw new Error('Transcript media ownership path is unsafe.')
  if (!pathIsMissing(ownershipPath)) return strictOwnershipState(baseDir)
  const empty = serializeOwnership(new Map())
  if (!empty) throw new Error('Transcript media empty ownership ledger could not serialize.')
  createStrictFile(ownershipPath, empty)
  fsyncDirectoryStrict(path.dirname(ownershipPath))
  return strictOwnershipState(baseDir)
}

function createNewLedgerTemp(
  baseDir: string,
  transactionId: string,
  serialized: Buffer
): { relativePath: string; identity: TranscriptMediaPurgeFileIdentity } {
  const ownershipPath = safeOwnershipPath(baseDir, false)
  if (!ownershipPath) throw new Error('Transcript media ownership path is unsafe.')
  const relativePath = `.purge-ledger-${process.pid}-${transactionId}.tmp`
  if (!TRANSCRIPT_MEDIA_PURGE_TEMP_PATTERN.test(relativePath)) {
    throw new Error('Transcript media purge ledger temp name is invalid.')
  }
  const file = createStrictFile(path.join(path.dirname(ownershipPath), relativePath), serialized)
  return { relativePath, identity: file.identity }
}

function ensureDirectoryRecord(
  baseDir: string,
  relativePath: string,
  records: Map<string, TranscriptMediaPurgeDirectoryRecord>,
  removeWhenCommitted: boolean
): void {
  if (!relativePath || relativePath === '.') return
  const resolved = resolvePurgeRelativePath(baseDir, relativePath)
  if (!resolved) throw new Error('Transcript media purge directory escaped its root.')
  const directory = strictDirectory(resolved)
  if (!directory || !pathWithinRoot(directory.realPath, fs.realpathSync.native(baseDir))) {
    throw new Error(`Transcript media purge directory ${relativePath} is unsafe.`)
  }
  const existing = records.get(relativePath)
  if (existing &&
      (existing.identity.dev !== directory.identity.dev ||
        existing.identity.ino !== directory.identity.ino)) {
    throw new Error(`Transcript media purge directory ${relativePath} changed.`)
  }
  records.set(relativePath, {
    relativePath,
    identity: directory.identity,
    removeWhenCommitted: existing?.removeWhenCommitted || removeWhenCommitted
  })
}

function enumerateGlobalPurge(
  baseDir: string,
  transactionId: string
): {
  files: TranscriptMediaPurgeFileRecord[]
  directories: TranscriptMediaPurgeDirectoryRecord[]
} {
  const { realBase } = assertPurgeRoot(baseDir)
  const directoryRecords = new Map<string, TranscriptMediaPurgeDirectoryRecord>()
  const originals: string[] = []
  for (const entry of fs.readdirSync(realBase).sort()) {
    if (entry === TRANSCRIPT_MEDIA_OWNERSHIP_FILE || entry === TRANSCRIPT_MEDIA_PURGE_JOURNAL_FILE) {
      continue
    }
    const candidate = path.join(realBase, entry)
    const entryStat = fs.lstatSync(candidate)
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Transcript media global purge found a redirected entry: ${entry}.`)
    }
    if (entryStat.isFile()) {
      originals.push(entry)
      continue
    }
    if (!entryStat.isDirectory()) {
      throw new Error(`Transcript media global purge found an unsupported entry: ${entry}.`)
    }
    ensureDirectoryRecord(realBase, entry, directoryRecords, true)
    for (const child of fs.readdirSync(candidate).sort()) {
      const relative = path.join(entry, child)
      const childPath = path.join(candidate, child)
      const childStat = fs.lstatSync(childPath)
      if (childStat.isSymbolicLink() || !childStat.isFile()) {
        throw new Error(`Transcript media global purge found an unsafe nested entry: ${relative}.`)
      }
      originals.push(relative)
    }
  }
  const files = originals.map((original, index) =>
    inspectPurgeFileRecord(realBase, original, transactionId, index)
  )
  return {
    files,
    directories: Array.from(directoryRecords.values()).sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    )
  }
}

function purgeFailure(message: string, cause?: unknown): Error {
  return new Error(message, cause === undefined ? undefined : { cause })
}

interface TranscriptMediaHistoryMutationHoldRecord {
  kind: TranscriptMediaHistoryMutationScope['kind']
  workspaceId: string | null
  appChatIds: Set<string>
}

interface TranscriptMediaOwnedFileWriteReceiptRecord {
  asset: string
  appChatId: string
  grantAdded: boolean
}

interface TranscriptMediaActivePurge {
  completion: Promise<void>
  resolve: () => void
}

export class TranscriptMediaAssetStore {
  private ownershipByAsset: Map<string, Set<string>>
  private ownershipMutationsUnavailable: boolean
  private purgeRecoveryUnavailable: boolean
  private purgeInProgress = false
  private activePurge: TranscriptMediaActivePurge | null = null
  private ingestGeneration = 0
  private ownedFileWriteRollbackTail: Promise<void> = Promise.resolve()
  private readonly activeIngests = new Set<Promise<void>>()
  private readonly historyMutationHolds = new Map<
    TranscriptMediaHistoryMutationHold,
    TranscriptMediaHistoryMutationHoldRecord
  >()
  private readonly ownedFileWriteReceipts = new Map<
    TranscriptMediaOwnedFileWriteReceipt,
    TranscriptMediaOwnedFileWriteReceiptRecord
  >()

  constructor(private readonly baseDir: string) {
    const recovery = recoverPurgeTransaction(baseDir)
    const loaded = loadOwnership(baseDir)
    this.ownershipByAsset = loaded.ownership
    this.purgeRecoveryUnavailable = !recovery.ok
    this.ownershipMutationsUnavailable = !recovery.ok || loaded.status === 'unavailable'
  }

  private persistOwnership(
    ownership: Map<string, Set<string>>,
    preparedSnapshot?: Buffer
  ): boolean {
    if (this.ownershipMutationsUnavailable) return false
    if (!persistOwnership(this.baseDir, ownership, preparedSnapshot)) {
      this.ownershipMutationsUnavailable = true
      return false
    }
    return true
  }

  /**
   * Raise a history-lifecycle admission hold synchronously. The hold precedes
   * every purge await and remains live after the purge receipt, until the outer
   * history transaction has durably committed (or recovery explicitly releases
   * it). Beginning any scope also invalidates active unowned file ingests.
   */
  beginHistoryMutation(
    scope: TranscriptMediaHistoryMutationScope
  ): TranscriptMediaHistoryMutationHold {
    if (this.purgeInProgress) {
      throw new Error('Transcript media purge is already in progress.')
    }
    if (!scope || typeof scope !== 'object') {
      throw new Error('Transcript media history mutation scope is invalid.')
    }

    const kind = (scope as { kind?: unknown }).kind
    if (kind !== 'chat' && kind !== 'truncate' && kind !== 'workspace' && kind !== 'global') {
      throw new Error('Transcript media history mutation kind is invalid.')
    }
    const appChatIds = new Set<string>()
    let workspaceId: string | null = null
    if (kind !== 'global') {
      const scoped = scope as Exclude<TranscriptMediaHistoryMutationScope, { kind: 'global' }>
      if (!Array.isArray(scoped.appChatIds)) {
        throw new Error('Transcript media history mutation requires canonical chat ids.')
      }
      for (const appChatId of scoped.appChatIds) {
        if (!safeOwnershipChatId(appChatId)) {
          throw new Error('Transcript media history mutation received an invalid chat id.')
        }
        appChatIds.add(appChatId)
      }
      if ((kind === 'chat' || kind === 'truncate') && appChatIds.size === 0) {
        throw new Error('Transcript media scoped history mutation requires a chat id.')
      }
      if (kind === 'workspace') {
        const workspaceScope = scope as Extract<
          TranscriptMediaHistoryMutationScope,
          { kind: 'workspace' }
        >
        workspaceId =
          typeof workspaceScope.workspaceId === 'string' ? workspaceScope.workspaceId.trim() : ''
        if (!workspaceId) {
          throw new Error('Transcript media workspace history mutation requires a workspace id.')
        }
      }
    }

    const hold = Object.freeze({
      id: randomUUID(),
      kind
    }) as TranscriptMediaHistoryMutationHold
    this.historyMutationHolds.set(hold, {
      kind,
      workspaceId,
      appChatIds
    })
    this.ingestGeneration += 1
    return hold
  }

  /** Release only the exact hold issued by this store; duplicate releases are no-ops. */
  endHistoryMutation(hold: TranscriptMediaHistoryMutationHold): boolean {
    return this.historyMutationHolds.delete(hold)
  }

  private historyMutationBlocksUnscopedWrite(): boolean {
    return this.historyMutationHolds.size > 0
  }

  private historyMutationBlocksChats(appChatIds: Iterable<string>): boolean {
    if (this.historyMutationHolds.size === 0) return false
    const candidates = new Set(appChatIds)
    for (const record of this.historyMutationHolds.values()) {
      if (record.kind === 'global') return true
      for (const appChatId of candidates) {
        if (record.appChatIds.has(appChatId)) return true
      }
    }
    return false
  }

  private asyncIngestAdmissionChanged(generation: number): boolean {
    return (
      generation !== this.ingestGeneration ||
      this.purgeInProgress ||
      this.historyMutationBlocksUnscopedWrite()
    )
  }

  private beginStrictPurge(): TranscriptMediaActivePurge {
    if (this.purgeInProgress || this.activePurge) {
      throw new Error('A transcript media purge is already in progress.')
    }
    let resolve!: () => void
    const completion = new Promise<void>((settle) => {
      resolve = settle
    })
    const activePurge = { completion, resolve }
    this.activePurge = activePurge
    this.purgeInProgress = true
    this.ingestGeneration += 1
    return activePurge
  }

  private endStrictPurge(activePurge: TranscriptMediaActivePurge): void {
    if (this.activePurge !== activePurge) {
      this.ownershipMutationsUnavailable = true
      activePurge.resolve()
      return
    }
    this.activePurge = null
    this.purgeInProgress = false
    activePurge.resolve()
  }

  private async runAfterActivePurge<T>(work: () => Promise<T>): Promise<T> {
    while (this.activePurge) {
      await this.activePurge.completion
    }
    // Invoke synchronously in the continuation that observed no active purge;
    // revokeChatOwnershipStrict acquires purge authority before its first await.
    return work()
  }

  private async serializeOwnedFileWriteRollback<T>(work: () => Promise<T>): Promise<T> {
    const predecessor = this.ownedFileWriteRollbackTail
    let release!: () => void
    this.ownedFileWriteRollbackTail = new Promise<void>((resolve) => {
      release = resolve
    })
    await predecessor
    try {
      return await work()
    } finally {
      release()
    }
  }

  /**
   * Revoke exact canonical chat owners and physically erase an asset only when
   * the resulting durable ledger has no surviving owner for it. The old ledger
   * and every doomed asset are first moved into same-directory quarantine under
   * a fsynced recovery journal; the replacement ledger is then published with
   * an exclusive hard-link and collapsed back to one link before commit.
   *
   * Any ambiguous path, symlink, hard link, directory substitution, persistence
   * failure, or cleanup failure rejects the promise. Callers must await this
   * method before committing chat-history deletion.
   */
  async revokeChatOwnershipStrict(
    appChatIds: Iterable<string>,
    exactAssetsByChat?: ReadonlyMap<string, ReadonlySet<string>>
  ): Promise<TranscriptMediaAssetPurgeSummary> {
    if (this.purgeInProgress) {
      throw new Error('A transcript media purge is already in progress.')
    }
    if (this.ownershipMutationsUnavailable || this.purgeRecoveryUnavailable) {
      throw new Error('Transcript media ownership is unavailable; chat purge was stopped.')
    }
    const revokedChats = new Set<string>()
    try {
      for (const appChatId of appChatIds) {
        if (!safeOwnershipChatId(appChatId)) {
          throw new Error('Transcript media chat purge received an invalid canonical chat id.')
        }
        revokedChats.add(appChatId)
      }
    } catch (error) {
      throw purgeFailure('Transcript media chat purge inputs are invalid.', error)
    }
    if (revokedChats.size === 0) {
      return { revokedChats: 0, revokedGrants: 0, deletedAssets: 0 }
    }

    const activePurge = this.beginStrictPurge()
    let newLedgerTemp: { relativePath: string; identity: TranscriptMediaPurgeFileIdentity } | null =
      null
    try {
      await Promise.all([...this.activeIngests])
      const loaded = loadOwnership(this.baseDir)
      if (
        loaded.status === 'unavailable' ||
        !ownershipMapMatches(loaded.ownership, this.ownershipByAsset)
      ) {
        this.ownershipMutationsUnavailable = true
        throw new Error('Transcript media ownership changed outside the active store.')
      }

      const next = new Map<string, Set<string>>()
      const deletedAssetKeys: string[] = []
      let revokedGrants = 0
      for (const [asset, currentOwners] of this.ownershipByAsset) {
        const surviving = new Set(currentOwners)
        for (const appChatId of revokedChats) {
          if (exactAssetsByChat && !exactAssetsByChat.get(appChatId)?.has(asset)) continue
          if (surviving.delete(appChatId)) revokedGrants += 1
        }
        if (surviving.size > 0) next.set(asset, surviving)
        else if (surviving.size !== currentOwners.size) deletedAssetKeys.push(asset)
      }
      if (revokedGrants === 0) {
        return { revokedChats: revokedChats.size, revokedGrants: 0, deletedAssets: 0 }
      }

      const oldOwnership = strictOwnershipState(this.baseDir)
      if (oldOwnership.status !== 'present') {
        this.ownershipMutationsUnavailable = true
        throw new Error('Transcript media ownership ledger is missing or unsafe.')
      }
      const serialized = serializeOwnership(next)
      if (!serialized) throw new Error('Transcript media ownership replacement exceeds its cap.')
      const transactionId = randomUUID()
      const root = assertPurgeRoot(this.baseDir)
      const directoryRecords = new Map<string, TranscriptMediaPurgeDirectoryRecord>()
      const files = deletedAssetKeys.map((asset, index) => {
        const original = ownershipAssetRelativePath(asset)
        if (!original) throw new Error(`Transcript media ownership asset ${asset} is invalid.`)
        ensureDirectoryRecord(
          root.realBase,
          path.dirname(original),
          directoryRecords,
          false
        )
        return inspectPurgeFileRecord(root.realBase, original, transactionId, index)
      })
      newLedgerTemp = createNewLedgerTemp(root.realBase, transactionId, serialized)
      const oldLedger = inspectPurgeFileRecord(
        root.realBase,
        TRANSCRIPT_MEDIA_OWNERSHIP_FILE,
        transactionId,
        files.length
      )
      if (oldLedger.identity.dev !== oldOwnership.identity.dev ||
          oldLedger.identity.ino !== oldOwnership.identity.ino ||
          oldLedger.identity.size !== oldOwnership.identity.size) {
        throw new Error('Transcript media ownership ledger changed during purge preparation.')
      }
      const journal: TranscriptMediaPurgeJournal = {
        version: 1,
        transactionId,
        mode: 'chats',
        rootIdentity: root.identity,
        oldOwnershipDigest: oldOwnership.digest,
        newOwnershipDigest: digestBytes(serialized),
        oldLedger,
        newLedgerTemp,
        files,
        directories: Array.from(directoryRecords.values()).sort((left, right) =>
          left.relativePath.localeCompare(right.relativePath)
        )
      }
      const journalFile = publishPurgeJournal(root.realBase, journal)
      newLedgerTemp = null
      try {
        for (const record of journal.files) movePurgeFileToQuarantine(root.realBase, journal, record)
        for (const directory of journal.directories) {
          const directoryPath = resolvePurgeRelativePath(root.realBase, directory.relativePath)
          if (!directoryPath) throw new Error('Transcript media purge directory escaped its root.')
          fsyncDirectoryStrict(directoryPath)
        }
        movePurgeFileToQuarantine(root.realBase, journal, journal.oldLedger)
        fsyncDirectoryStrict(root.realBase)
        publishNewOwnershipLedger(root.realBase, journal)
        this.ownershipByAsset = next
        finishCommittedPurgeTransaction(root.realBase, journal, journalFile.identity)
      } catch (error) {
        const disk = strictOwnershipState(root.realBase)
        if (!(disk.status === 'present' && disk.digest === journal.newOwnershipDigest)) {
          try {
            restorePurgeTransaction(root.realBase, journal, journalFile.identity)
          } catch (rollbackError) {
            this.purgeRecoveryUnavailable = true
            this.ownershipMutationsUnavailable = true
            throw purgeFailure(
              'Transcript media chat purge failed and rollback requires restart recovery.',
              rollbackError
            )
          }
        } else {
          this.purgeRecoveryUnavailable = true
          this.ownershipMutationsUnavailable = true
        }
        throw purgeFailure('Transcript media chat purge failed before history commit.', error)
      }
      return {
        revokedChats: revokedChats.size,
        revokedGrants,
        deletedAssets: files.length
      }
    } finally {
      if (newLedgerTemp) {
        const tempPath = resolvePurgeRelativePath(this.baseDir, newLedgerTemp.relativePath)
        if (tempPath) {
          try {
            const current = strictRegularFile(tempPath, {
              expected: newLedgerTemp.identity,
              includeExpectedSnapshot: false
            })
            if (current) fs.unlinkSync(tempPath)
          } catch {
            this.ownershipMutationsUnavailable = true
          }
        }
      }
      this.endStrictPurge(activePurge)
    }
  }

  /**
   * Strict global history purge. Every safe regular file below the media root is
   * quarantined and erased, every empty shard is removed, and the ownership
   * ledger itself is deleted. A corrupt ordinary ledger may be erased globally,
   * but a redirected, hard-linked, or structurally unsafe tree rejects the call.
   */
  async clearAllStrict(): Promise<TranscriptMediaAssetPurgeSummary> {
    if (this.purgeInProgress) {
      throw new Error('A transcript media purge is already in progress.')
    }
    if (this.purgeRecoveryUnavailable) {
      throw new Error('Transcript media purge recovery is unavailable; global clear was stopped.')
    }
    const activePurge = this.beginStrictPurge()
    try {
      await Promise.all([...this.activeIngests])
      try {
        fs.lstatSync(this.baseDir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          this.ownershipByAsset = new Map()
          this.ownershipMutationsUnavailable = false
          return { revokedChats: 0, revokedGrants: 0, deletedAssets: 0 }
        }
        throw purgeFailure('Transcript media global purge root is unavailable.', error)
      }
      const root = assertPurgeRoot(this.baseDir)
      const revokedOwnerIds = new Set<string>()
      let revokedGrants = 0
      for (const owners of this.ownershipByAsset.values()) {
        revokedGrants += owners.size
        for (const owner of owners) revokedOwnerIds.add(owner)
      }
      let oldOwnership = strictOwnershipState(root.realBase)
      if (oldOwnership.status === 'missing') oldOwnership = createEmptyOwnershipLedgerStrict(root.realBase)
      if (oldOwnership.status !== 'present') {
        throw new Error('Transcript media ownership ledger is redirected or hard-linked.')
      }
      const transactionId = randomUUID()
      const enumerated = enumerateGlobalPurge(root.realBase, transactionId)
      const oldLedger = inspectPurgeFileRecord(
        root.realBase,
        TRANSCRIPT_MEDIA_OWNERSHIP_FILE,
        transactionId,
        enumerated.files.length
      )
      if (oldLedger.identity.dev !== oldOwnership.identity.dev ||
          oldLedger.identity.ino !== oldOwnership.identity.ino ||
          oldLedger.identity.size !== oldOwnership.identity.size) {
        throw new Error('Transcript media ownership ledger changed during global purge preparation.')
      }
      const journal: TranscriptMediaPurgeJournal = {
        version: 1,
        transactionId,
        mode: 'global',
        rootIdentity: root.identity,
        oldOwnershipDigest: oldOwnership.digest,
        newOwnershipDigest: null,
        oldLedger,
        files: enumerated.files,
        directories: enumerated.directories
      }
      const journalFile = publishPurgeJournal(root.realBase, journal)
      try {
        for (const record of journal.files) movePurgeFileToQuarantine(root.realBase, journal, record)
        for (const directory of journal.directories) {
          const directoryPath = resolvePurgeRelativePath(root.realBase, directory.relativePath)
          if (!directoryPath) throw new Error('Transcript media purge directory escaped its root.')
          fsyncDirectoryStrict(directoryPath)
        }
        movePurgeFileToQuarantine(root.realBase, journal, journal.oldLedger)
        fsyncDirectoryStrict(root.realBase)
        this.ownershipByAsset = new Map()
        finishCommittedPurgeTransaction(root.realBase, journal, journalFile.identity)
      } catch (error) {
        const disk = strictOwnershipState(root.realBase)
        if (disk.status === 'present' && disk.digest === journal.oldOwnershipDigest) {
          try {
            restorePurgeTransaction(root.realBase, journal, journalFile.identity)
          } catch (rollbackError) {
            this.purgeRecoveryUnavailable = true
            this.ownershipMutationsUnavailable = true
            throw purgeFailure(
              'Transcript media global purge failed and rollback requires restart recovery.',
              rollbackError
            )
          }
        } else {
          this.purgeRecoveryUnavailable = true
          this.ownershipMutationsUnavailable = true
        }
        throw purgeFailure('Transcript media global purge failed before history commit.', error)
      }
      this.ownershipByAsset = new Map()
      this.ownershipMutationsUnavailable = false
      return {
        revokedChats: revokedOwnerIds.size,
        revokedGrants,
        deletedAssets: enumerated.files.length
      }
    } finally {
      this.endStrictPurge(activePurge)
    }
  }

  /** Exact content-address + canonical-chat ownership check. */
  owns(input: TranscriptMediaAssetOwnershipInput): boolean {
    const asset = ownershipAssetKey(input.sha256, input.mimeType)
    if (!asset || !safeOwnershipChatId(input.appChatId)) return false
    return this.ownershipByAsset.get(asset)?.has(input.appChatId) === true
  }

  /**
   * Apply independently trusted grants as one immutable ledger replacement.
   * Inputs are fully validated before the next ownership map is published, so
   * any failure leaves every requested grant unapplied.
   */
  private applyOwnershipGrants(
    inputs: readonly TranscriptMediaAssetOwnershipInput[]
  ): TranscriptMediaAssetOwnershipBackfillResult {
    if (this.ownershipMutationsUnavailable) {
      return { ok: false, reason: 'persistence_failed' }
    }
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

    if (this.historyMutationBlocksChats(inputs.map((input) => input.appChatId))) {
      return { ok: false, reason: 'history_cleared' }
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
    if (!this.persistOwnership(next, serialized)) {
      return { ok: false, reason: 'persistence_failed' }
    }
    this.ownershipByAsset = next
    return { ok: true, ...commonResult, persisted: true }
  }

  /**
   * Main-authority batch grant for existing store assets. Renderer-supplied chat
   * ids must never be routed here without an independently trusted owner lookup.
   */
  grantMany(
    inputs: readonly TranscriptMediaAssetOwnershipInput[]
  ): TranscriptMediaAssetOwnershipBatchResult {
    const result = this.applyOwnershipGrants(inputs)
    return result.ok
      ? { ok: true }
      : {
          ok: false,
          reason: result.reason,
          ...(result.failedAt === undefined ? {} : { failedAt: result.failedAt })
        }
  }

  /** One-item compatibility wrapper around the atomic batch grant. */
  grant(input: TranscriptMediaAssetOwnershipInput): TranscriptMediaAssetOwnershipResult {
    const result = this.grantMany([input])
    return result.ok ? result : { ok: false, reason: result.reason }
  }

  /**
   * Atomically seed ownership from an independently trusted migration source.
   * Persisted chat JSON is renderer-authored and is explicitly NOT provenance
   * for this operation. A caller retaining this migration hook must authenticate
   * a separate main-owned manifest before constructing `inputs`.
   *
   * This retains migration counters while sharing the same validation and single
   * ledger replacement used by ordinary main-authority batches.
   */
  backfillOwnership(
    inputs: readonly TranscriptMediaAssetOwnershipInput[]
  ): TranscriptMediaAssetOwnershipBackfillResult {
    return this.applyOwnershipGrants(inputs)
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
      this.historyMutationBlocksChats([input.sourceAppChatId, input.targetAppChatId])
    ) {
      return { ok: false, reason: 'history_cleared' }
    }
    if (this.ownershipMutationsUnavailable) return { ok: false, reason: 'persistence_failed' }
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

  private writeAssetBytes(
    input: Omit<TranscriptMediaAssetWriteInput, 'appChatId'>
  ):
    | { ok: true; target: string; createdStat?: fs.Stats }
    | { ok: false; reason: string } {
    try {
      if (!SHA256_BASE64URL_PATTERN.test(input.sha256)) {
        return { ok: false, reason: 'unsafe_asset_path' }
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
      let createdFinalStat: fs.Stats | undefined
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
        // The ownership ledger may only name bytes whose directory entries are
        // durable. Sync the file entry in its shard and the shard entry in the
        // media root before any grant can be published.
        fsyncDirectoryStrict(path.dirname(target))
        fsyncDirectoryStrict(path.dirname(path.dirname(target)))
        createdFinalStat = finalStat
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
      return { ok: true, target, ...(createdFinalStat ? { createdStat: createdFinalStat } : {}) }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  private rollbackNewUnownedAssets(
    created: ReadonlyArray<{
      input: Pick<TranscriptMediaAssetWriteInput, 'sha256' | 'mimeType'>
      target: string
      stat: fs.Stats
    }>
  ): boolean {
    if (created.length === 0) return true
    const diskOwnership = loadOwnership(this.baseDir)
    if (diskOwnership.status === 'unavailable') return false
    for (const candidate of [...created].reverse()) {
      const asset = ownershipAssetKey(candidate.input.sha256, candidate.input.mimeType)
      if (!asset) return false
      // An ambiguous/late grant wins over cleanup. Never remove bytes now owned
      // by another chat or by a grant that committed despite a reported error.
      if ((diskOwnership.ownership.get(asset)?.size ?? 0) > 0) continue
      const canonical = safeAssetTarget(
        this.baseDir,
        candidate.input.sha256,
        candidate.input.mimeType,
        false
      )
      if (!canonical || canonical !== candidate.target) return false
      if (pathIsMissing(candidate.target)) continue
      let fd: number | null = null
      let closeFailed = false
      try {
        const pathStat = fs.lstatSync(candidate.target)
        if (
          pathStat.isSymbolicLink() ||
          !pathStat.isFile() ||
          pathStat.nlink !== 1 ||
          !sameFileIdentity(pathStat, candidate.stat)
        ) {
          throw new Error('Transcript media rollback target identity changed.')
        }
        fd = fs.openSync(candidate.target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
        const descriptor = fs.fstatSync(fd)
        const finalPathStat = fs.lstatSync(candidate.target)
        if (
          descriptor.nlink !== 1 ||
          finalPathStat.nlink !== 1 ||
          !sameFileIdentity(descriptor, candidate.stat) ||
          !sameFileIdentity(finalPathStat, candidate.stat)
        ) {
          throw new Error('Transcript media rollback descriptor identity changed.')
        }
        fs.unlinkSync(candidate.target)
        if (!pathIsMissing(candidate.target)) {
          throw new Error('Transcript media rollback target remained after unlink.')
        }
        fsyncDirectoryStrict(path.dirname(candidate.target))
      } catch {
        return false
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd)
          } catch {
            closeFailed = true
          }
        }
      }
      if (closeFailed) return false
    }
    return true
  }

  /**
   * Atomically publish a batch of content-addressed bytes with their exact chat
   * grants. A failed write or grant removes only files exclusively created by
   * this call; pre-existing/shared assets are preserved.
   */
  writeOwnedMany(
    inputs: readonly TranscriptMediaAssetOwnedWriteInput[]
  ): TranscriptMediaAssetOwnedWriteBatchResult {
    if (
      this.historyMutationBlocksChats(
        inputs
          .map((input) => input?.appChatId)
          .filter((appChatId): appChatId is string => typeof appChatId === 'string')
      )
    ) {
      return { ok: false, reason: 'history_cleared' }
    }
    if (this.ownershipMutationsUnavailable || this.purgeInProgress) {
      return {
        ok: false,
        reason: safeOwnershipPath(this.baseDir, false)
          ? 'persistence_failed'
          : 'unsafe_asset_path'
      }
    }
    const created: Array<{
      input: Pick<TranscriptMediaAssetWriteInput, 'sha256' | 'mimeType'>
      target: string
      stat: fs.Stats
    }> = []
    const grants: TranscriptMediaAssetOwnershipInput[] = []
    const assets: Array<Extract<TranscriptMediaContentAddressedWriteResult, { ok: true }>> = []
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index]
      if (!input || !safeOwnershipChatId(input.appChatId)) {
        if (!this.rollbackNewUnownedAssets(created)) this.ownershipMutationsUnavailable = true
        return { ok: false, reason: 'invalid_chat', failedAt: index }
      }
      const bytes = this.writeAssetBytes(input)
      if (!bytes.ok) {
        if (!this.rollbackNewUnownedAssets(created)) this.ownershipMutationsUnavailable = true
        return { ok: false, reason: bytes.reason, failedAt: index }
      }
      if (bytes.createdStat) {
        created.push({ input, target: bytes.target, stat: bytes.createdStat })
      }
      assets.push({
        ok: true,
        persistenceVersion: 1,
        sha256: input.sha256,
        path: bytes.target,
        mimeType: input.mimeType.toLowerCase(),
        byteLength: input.buffer.length
      })
      grants.push({
        sha256: input.sha256,
        mimeType: input.mimeType,
        appChatId: input.appChatId
      })
    }
    const granted = this.grantMany(grants)
    if (granted.ok) return { ok: true, assets }
    if (!this.rollbackNewUnownedAssets(created)) {
      this.ownershipMutationsUnavailable = true
      return { ok: false, reason: 'ownership_rollback_failed' }
    }
    return {
      ok: false,
      reason: granted.reason,
      ...(granted.failedAt === undefined ? {} : { failedAt: granted.failedAt })
    }
  }

  write(input: TranscriptMediaAssetWriteInput): { ok: true } | { ok: false; reason: string } {
    if (this.purgeInProgress) return { ok: false, reason: 'history_cleared' }
    if (input.appChatId !== undefined && !safeOwnershipChatId(input.appChatId)) {
      return { ok: false, reason: 'invalid_chat' }
    }
    if (input.appChatId !== undefined) {
      const result = this.writeOwnedMany([
        {
          sha256: input.sha256,
          mimeType: input.mimeType,
          buffer: input.buffer,
          appChatId: input.appChatId
        }
      ])
      return result.ok ? { ok: true } : { ok: false, reason: result.reason }
    }
    if (this.historyMutationBlocksUnscopedWrite()) {
      return { ok: false, reason: 'history_cleared' }
    }
    const written = this.writeAssetBytes(input)
    return written.ok ? { ok: true } : written
  }

  /**
   * Persist a main-owned staging file without materializing the full asset in the
   * Electron main-process heap. The source is descriptor-anchored and copied into
   * a private, fsynced store temp file in bounded chunks while its canonical hash
   * is computed. A hard link publishes the complete file atomically, so concurrent
   * ingests can never observe a partially-written content-addressed target.
   *
   * Ownership is intentionally out of scope: producer tools grant the returned ref
   * to their canonical chat only after the main-side tool result has been built.
   */
  async writeContentAddressedFromFile(input: {
    sourcePath: string
    mimeType: string
  }): Promise<TranscriptMediaContentAddressedWriteResult> {
    if (this.purgeInProgress || this.historyMutationBlocksUnscopedWrite()) {
      return { ok: false, reason: 'history_cleared' }
    }
    return this.runActiveFileIngest(async (generation) => {
      const result = await this.writeContentAddressedFromFileAtGeneration(input, generation)
      return this.publicFileWriteResult(result)
    })
  }

  /**
   * Stream a main-owned file into the content-addressed store and publish its
   * canonical chat grant before returning. The active-ingest reservation spans
   * both byte publication and the synchronous ledger replacement, so a history
   * hold either invalidates/rolls back the new inode or observes an owned asset
   * that its strict purge can delete.
   */
  async writeOwnedContentAddressedFromFile(input: {
    sourcePath: string
    mimeType: string
    appChatId: string
    /** Exact main-owned run/output authority, rechecked immediately before grant. */
    isAuthorized?: () => boolean
  }): Promise<TranscriptMediaOwnedFileWriteResult> {
    if (!safeOwnershipChatId(input.appChatId)) {
      return { ok: false, reason: 'invalid_chat' }
    }
    if (!this.ownedFileWriteAuthorized(input.isAuthorized)) {
      return { ok: false, reason: 'authority_lost' }
    }
    if (
      this.purgeInProgress ||
      this.historyMutationBlocksChats([input.appChatId]) ||
      this.historyMutationBlocksUnscopedWrite()
    ) {
      return { ok: false, reason: 'history_cleared' }
    }
    return this.runActiveFileIngest(async (generation) => {
      const written = await this.writeContentAddressedFromFileAtGeneration(input, generation)
      if (!written.ok) return written
      if (
        this.asyncIngestAdmissionChanged(generation) ||
        !this.ownedFileWriteAuthorized(input.isAuthorized)
      ) {
        if (!this.rollbackCreatedFileIngest(input.mimeType, written)) {
          this.ownershipMutationsUnavailable = true
          return { ok: false, reason: 'history_clear_rollback_failed' }
        }
        return {
          ok: false,
          reason: this.asyncIngestAdmissionChanged(generation)
            ? 'history_cleared'
            : 'authority_lost'
        }
      }
      const grantAlreadyExisted = this.owns({
        sha256: written.sha256,
        mimeType: written.mimeType,
        appChatId: input.appChatId
      })
      const granted = this.grant({
        sha256: written.sha256,
        mimeType: written.mimeType,
        appChatId: input.appChatId
      })
      if (!granted.ok) {
        if (!this.rollbackCreatedFileIngest(input.mimeType, written)) {
          this.ownershipMutationsUnavailable = true
          return { ok: false, reason: 'ownership_rollback_failed' }
        }
        return { ok: false, reason: granted.reason }
      }
      const ownershipReceipt = Object.freeze({
        id: randomUUID()
      }) as TranscriptMediaOwnedFileWriteReceipt
      const asset = ownershipAssetKey(written.sha256, written.mimeType)
      if (!asset) {
        throw new Error('Owned transcript media ingest produced an invalid asset key.')
      }
      this.ownedFileWriteReceipts.set(ownershipReceipt, {
        asset,
        appChatId: input.appChatId,
        grantAdded: !grantAlreadyExisted
      })
      const result = this.publicFileWriteResult(written)
      if (!result.ok) return result
      return { ...result, ownershipReceipt }
    })
  }

  private ownedFileWriteAuthorized(isAuthorized?: () => boolean): boolean {
    if (!isAuthorized) return true
    try {
      return isAuthorized() === true
    } catch {
      return false
    }
  }

  /** Commit a caller's post-await authority check and retire rollback capability. */
  commitOwnedFileWrite(receipt: TranscriptMediaOwnedFileWriteReceipt): boolean {
    return this.commitOwnedFileWrites([receipt])
  }

  /**
   * Atomically retire a complete publication batch. Validate every exact
   * receipt before deleting any of them so a stale later page cannot strand an
   * earlier committed grant outside the caller's rollback authority.
   */
  commitOwnedFileWrites(receipts: readonly TranscriptMediaOwnedFileWriteReceipt[]): boolean {
    const unique = new Set(receipts)
    if (unique.size !== receipts.length) return false
    for (const receipt of unique) {
      if (!this.ownedFileWriteReceipts.has(receipt)) return false
    }
    for (const receipt of unique) this.ownedFileWriteReceipts.delete(receipt)
    return true
  }

  /**
   * Roll back only the exact grant introduced by one owned async ingest. Shared
   * or pre-existing ownership survives; physical bytes are purged only when the
   * resulting durable refcount reaches zero.
   */
  async rollbackOwnedFileWriteStrict(
    receipt: TranscriptMediaOwnedFileWriteReceipt
  ): Promise<TranscriptMediaAssetPurgeSummary | null> {
    return this.serializeOwnedFileWriteRollback(async () => {
      const record = this.ownedFileWriteReceipts.get(receipt)
      if (!record) return null
      if (!record.grantAdded) {
        this.ownedFileWriteReceipts.delete(receipt)
        return { revokedChats: 0, revokedGrants: 0, deletedAssets: 0 }
      }

      // History deletion owns the store-wide purge authority. Exact receipt
      // rollback waits for that durable transaction to settle, then replays its
      // narrowly-scoped revocation against the resulting ownership ledger.
      const result = await this.runAfterActivePurge(() =>
        this.revokeChatOwnershipStrict(
          [record.appChatId],
          new Map([[record.appChatId, new Set([record.asset])]])
        )
      )
      this.ownedFileWriteReceipts.delete(receipt)
      return result
    })
  }

  private async runActiveFileIngest<T>(
    work: (generation: number) => Promise<T>
  ): Promise<T> {
    const generation = this.ingestGeneration
    let settle!: () => void
    const reservation = new Promise<void>((resolve) => {
      settle = resolve
    })
    // Reservation is synchronous and precedes the first filesystem await. A
    // same-tick clear therefore sees and joins this ingest before enumerating.
    this.activeIngests.add(reservation)
    try {
      return await work(generation)
    } finally {
      this.activeIngests.delete(reservation)
      settle()
    }
  }

  private publicFileWriteResult(
    result: TranscriptMediaInternalFileWriteResult
  ): TranscriptMediaContentAddressedWriteResult {
    if (!result.ok) return result
    return {
      ok: true,
      persistenceVersion: 1,
      sha256: result.sha256,
      path: result.path,
      mimeType: result.mimeType,
      byteLength: result.byteLength
    }
  }

  private rollbackCreatedFileIngest(
    mimeType: string,
    result: Extract<TranscriptMediaInternalFileWriteResult, { ok: true }>
  ): boolean {
    if (!result.createdStat) return true
    return this.rollbackNewUnownedAssets([
      {
        input: { sha256: result.sha256, mimeType },
        target: result.path,
        stat: result.createdStat
      }
    ])
  }

  private async writeContentAddressedFromFileAtGeneration(input: {
    sourcePath: string
    mimeType: string
  }, generation: number): Promise<TranscriptMediaInternalFileWriteResult> {
    if (this.asyncIngestAdmissionChanged(generation)) {
      return { ok: false, reason: 'history_cleared' }
    }
    if (typeof input.sourcePath !== 'string' || !path.isAbsolute(input.sourcePath)) {
      return { ok: false, reason: 'unsafe_source_path' }
    }
    if (typeof input.mimeType !== 'string') return { ok: false, reason: 'unsupported' }
    const normalizedMimeType = input.mimeType.toLowerCase()
    if (!mediaExtension(normalizedMimeType)) return { ok: false, reason: 'unsupported' }

    let sourceHandle: fs.promises.FileHandle | null = null
    let tempHandle: fs.promises.FileHandle | null = null
    let tempPath: string | null = null
    let tempIdentity: fs.Stats | null = null
    let publishedTarget: string | null = null
    let publishedIdentity: fs.Stats | null = null
    let publishedSha256: string | null = null

    try {
      let sourcePathStat: fs.Stats
      try {
        sourcePathStat = await fs.promises.lstat(input.sourcePath)
      } catch (error) {
        return {
          ok: false,
          reason: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unsafe_source_path'
        }
      }
      if (sourcePathStat.isSymbolicLink() || !sourcePathStat.isFile()) {
        return { ok: false, reason: 'unsafe_source_path' }
      }

      try {
        sourceHandle = await fs.promises.open(
          input.sourcePath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
        )
      } catch (error) {
        return {
          ok: false,
          reason: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unsafe_source_path'
        }
      }
      const sourceStat = await sourceHandle.stat()
      const uid = typeof process.getuid === 'function' ? process.getuid() : null
      if (
        !sourceStat.isFile() ||
        !sameFileSnapshotVersion(sourcePathStat, sourceStat) ||
        (uid !== null && sourceStat.uid !== uid)
      ) {
        return { ok: false, reason: 'unsafe_source_path' }
      }
      const cap = maxTranscriptMediaBytesForMime(normalizedMimeType)
      if (sourceStat.size <= 0 || sourceStat.size > cap) {
        return { ok: false, reason: 'too_large' }
      }

      if (this.asyncIngestAdmissionChanged(generation)) {
        return { ok: false, reason: 'history_cleared' }
      }

      tempPath = safeAssetIngestTempPath(this.baseDir)
      if (!tempPath) return { ok: false, reason: 'unsafe_asset_path' }
      await cleanupStaleAssetIngestTemps(path.dirname(tempPath))
      tempHandle = await fs.promises.open(
        tempPath,
        fs.constants.O_RDWR |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600
      )
      await tempHandle.chmod(0o600)
      tempIdentity = await tempHandle.stat()
      if (
        !tempIdentity.isFile() ||
        (uid !== null && tempIdentity.uid !== uid) ||
        (uid !== null && (tempIdentity.mode & 0o077) !== 0)
      ) {
        throw new Error('unsafe_asset_path')
      }

      const hash = createHash('sha256')
      const chunk = Buffer.allocUnsafe(
        Math.min(TRANSCRIPT_MEDIA_FILE_INGEST_CHUNK_BYTES, sourceStat.size)
      )
      let position = 0
      while (position < sourceStat.size) {
        const requested = Math.min(chunk.length, sourceStat.size - position)
        const bytesRead = await readDescriptorChunk(sourceHandle, chunk, requested, position)
        if (bytesRead !== requested) throw new Error('source_changed')
        hash.update(chunk.subarray(0, requested))
        await writeDescriptorChunk(tempHandle, chunk, requested, position)
        position += requested
      }
      await tempHandle.sync()

      if (!(await descriptorSnapshotMatchesPath(sourceHandle, input.sourcePath, sourceStat))) {
        throw new Error('source_changed')
      }
      const [tempFinalStat, tempPathStat] = await Promise.all([
        tempHandle.stat(),
        fs.promises.lstat(tempPath)
      ])
      if (
        !tempFinalStat.isFile() ||
        tempPathStat.isSymbolicLink() ||
        !tempPathStat.isFile() ||
        tempFinalStat.size !== sourceStat.size ||
        !sameFileIdentity(tempFinalStat, tempIdentity) ||
        !sameFileIdentity(tempPathStat, tempIdentity)
      ) {
        throw new Error('unsafe_asset_path')
      }

      const sha256 = hash.digest('base64url')
      if (this.asyncIngestAdmissionChanged(generation)) {
        throw new Error('history_cleared')
      }
      const target = safeAssetTarget(this.baseDir, sha256, normalizedMimeType, true)
      if (!target) throw new Error('unsafe_asset_path')

      try {
        await fs.promises.link(tempPath, target)
        // The hard link is the irreversible publication point. A concurrent
        // ingest may adopt the canonical target immediately, so failures in our
        // subsequent validation or directory fsync must never roll it back.
        const targetStat = await fs.promises.lstat(target)
        if (
          targetStat.isSymbolicLink() ||
          !targetStat.isFile() ||
          targetStat.size !== sourceStat.size ||
          !sameFileIdentity(targetStat, tempFinalStat)
        ) {
          throw new Error('unsafe_asset_path')
        }
        publishedTarget = target
        publishedIdentity = targetStat
        publishedSha256 = sha256
        await fsyncDirectoryBestEffort(path.dirname(target))
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
        let existingHandle: fs.promises.FileHandle | null = null
        try {
          const existingPathStat = await fs.promises.lstat(target)
          if (existingPathStat.isSymbolicLink() || !existingPathStat.isFile()) {
            return { ok: false, reason: 'content_address_collision' }
          }
          existingHandle = await fs.promises.open(
            target,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
          )
          const existingStat = await existingHandle.stat()
          // Identity + size only — no timestamp comparison. The concurrent
          // winner legitimately mutates the target's ctime when it unlinks
          // its temp hard-link twin, so a snapshot-version check here races
          // that cleanup and misreports identical content as a collision.
          // The open handle pins the inode and descriptorsEqual proves the
          // bytes; a fresh identity re-check proves the path still names
          // the inode we validated.
          if (
            !existingStat.isFile() ||
            existingStat.size !== sourceStat.size ||
            !sameFileIdentity(existingStat, existingPathStat) ||
            !(await descriptorsEqual(tempHandle, existingHandle, sourceStat.size))
          ) {
            return { ok: false, reason: 'content_address_collision' }
          }
          const adoptedPathStat = await fs.promises.lstat(target)
          if (
            adoptedPathStat.isSymbolicLink() ||
            !adoptedPathStat.isFile() ||
            !sameFileIdentity(adoptedPathStat, existingStat) ||
            adoptedPathStat.size !== sourceStat.size
          ) {
            return { ok: false, reason: 'content_address_collision' }
          }
        } catch {
          return { ok: false, reason: 'content_address_collision' }
        } finally {
          await existingHandle?.close().catch(() => undefined)
        }
      }

      await tempHandle.close()
      tempHandle = null
      await sourceHandle.close()
      sourceHandle = null
      if (tempPath && tempIdentity) {
        await safeUnlinkMatchingFile(tempPath, tempIdentity)
        tempPath = null
        tempIdentity = null
      }
      if (this.asyncIngestAdmissionChanged(generation)) {
        if (
          publishedTarget &&
          publishedIdentity &&
          publishedSha256 &&
          !this.rollbackNewUnownedAssets([
            {
              input: { sha256: publishedSha256, mimeType: normalizedMimeType },
              target: publishedTarget,
              stat: publishedIdentity
            }
          ])
        ) {
          this.ownershipMutationsUnavailable = true
          return { ok: false, reason: 'history_clear_rollback_failed' }
        }
        return { ok: false, reason: 'history_cleared' }
      }
      return {
        ok: true,
        persistenceVersion: 1,
        sha256,
        path: target,
        mimeType: normalizedMimeType,
        byteLength: sourceStat.size,
        ...(publishedIdentity ? { createdStat: publishedIdentity } : {})
      }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    } finally {
      await tempHandle?.close().catch(() => undefined)
      await sourceHandle?.close().catch(() => undefined)
      if (tempPath && tempIdentity) {
        await safeUnlinkMatchingFile(tempPath, tempIdentity)
      }
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
