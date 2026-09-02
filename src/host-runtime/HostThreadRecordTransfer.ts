/**
 * Owner-only transfer artifacts for large Host-mediated thread records.
 *
 * The authenticated Host local-control line is bounded (HostLocalServer's
 * MAX_LINE_BYTES is 256_000), but a raw chat record is not: an ensemble
 * transcript can run to tens of megabytes. Inlining a record in a command frame
 * would therefore replace one failure with a size-dependent one. Instead the
 * publisher writes an owner-only artifact beside the profile and the command
 * carries only a bounded descriptor { transferId, sha256, byteLength }.
 *
 * Safety model is the one already used by HostEnvelopeVault:
 *
 *   1. The path is DERIVED from profilePath + transferId. No caller-supplied
 *      path ever reaches the filesystem, so there is nothing to traverse with.
 *   2. Creation is O_EXCL + O_NOFOLLOW into a 0o700 directory, fsynced, then
 *      renamed. A partially written artifact is never visible at the target
 *      path, so any artifact a consumer can see is complete.
 *   3. The consumer validates the file it actually opened via fstat on the live
 *      descriptor (regular file, single link, owner-only mode, exact byte
 *      length), never via a separate lstat that a replacement could race.
 *   4. Cleanup is INODE-BOUND. The consumer records dev/ino from that descriptor
 *      and unlinks only if the path still resolves to the same inode. A file
 *      swapped in after the read is left alone rather than deleted on behalf of
 *      whoever placed it there. This holds on the failure path too.
 *
 * Serialization happens exactly once, inside publish. A publisher that hashed
 * separately could drift from the bytes it wrote; doing both here makes that
 * class of bug unrepresentable.
 *
 * This module is deliberately transport-neutral and carries no command wiring:
 * it is the primitive both the desktop publisher and the Host consumer share.
 */

import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { isAbsolute, join, parse, resolve } from 'node:path'

/** Artifact directory, created beside the other owner-only Host state. */
export const HOST_THREAD_RECORD_TRANSFER_DIRECTORY = 'host-thread-record-transfer'

/**
 * Upper bound for a single transferred record, matching the existing chat-record
 * limit. Deliberately far above the local-control line limit: exceeding that
 * limit is the reason this seam exists.
 */
export const HOST_THREAD_RECORD_TRANSFER_MAX_BYTES = 64 * 1024 * 1024

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const TRANSFER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const HEX_256_PATTERN = /^[a-f0-9]{64}$/
const ARTIFACT_SUFFIX = '.record.json'

export class HostThreadRecordTransferError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'HostThreadRecordTransferError'
  }
}

/** The artifact exists but failed a structural, ownership, size, or digest check. */
export class HostThreadRecordTransferIntegrityError extends HostThreadRecordTransferError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'HostThreadRecordTransferIntegrityError'
  }
}

/** No artifact is published under this transfer id. */
export class HostThreadRecordTransferMissingError extends HostThreadRecordTransferError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'HostThreadRecordTransferMissingError'
  }
}

export interface HostThreadRecordTransferFileStat {
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly mode: number | bigint
  readonly size: number | bigint
  readonly nlink?: number | bigint
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

/** Synchronous filesystem seam, mirroring HostEnvelopeVaultFs for fault injection. */
export interface HostThreadRecordTransferFs {
  readonly constants: {
    readonly O_RDONLY: number
    readonly O_WRONLY: number
    readonly O_CREAT: number
    readonly O_EXCL: number
    readonly O_NOFOLLOW?: number
  }
  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): unknown
  realpathSync(path: string): string
  lstatSync(path: string, options?: { bigint: true }): HostThreadRecordTransferFileStat
  openSync(path: string, flags: number, mode?: number): number
  fstatSync(fd: number, options?: { bigint: true }): HostThreadRecordTransferFileStat
  readSync(
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number | null
  ): number
  writeSync(fd: number, data: Buffer): number
  fsyncSync(fd: number): void
  fchmodSync(fd: number, mode: number): void
  chmodSync(path: string, mode: number): void
  closeSync(fd: number): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
}

/** Exactly what a bounded command frame is allowed to carry. */
export interface HostThreadRecordTransferDescriptor {
  readonly transferId: string
  readonly sha256: string
  readonly byteLength: number
}

/** The exact file the consumer read, for inode-bound cleanup and audit. */
export interface HostThreadRecordTransferIdentity {
  readonly dev: string
  readonly ino: string
}

export interface HostThreadRecordTransferPublishOptions {
  readonly profilePath: string
  readonly transferId: string
  /** Serializable record. Serialized once here so publisher and consumer cannot drift. */
  readonly record: unknown
  readonly fs?: HostThreadRecordTransferFs
  readonly platform?: NodeJS.Platform
}

export interface HostThreadRecordTransferConsumeOptions {
  readonly profilePath: string
  /** Descriptor as received on the wire. The path is derived from it, never supplied. */
  readonly descriptor: HostThreadRecordTransferDescriptor
  readonly fs?: HostThreadRecordTransferFs
  readonly platform?: NodeJS.Platform
}

export interface HostThreadRecordTransferConsumeResult {
  readonly record: Record<string, unknown>
  readonly descriptor: HostThreadRecordTransferDescriptor
  readonly identity: HostThreadRecordTransferIdentity
  /** False when the artifact was replaced after the read and was therefore left in place. */
  readonly removed: boolean
}

export interface HostThreadRecordTransferRemoveOptions {
  readonly profilePath: string
  readonly transferId: string
  readonly fs?: HostThreadRecordTransferFs
  readonly platform?: NodeJS.Platform
}

/** Absolute transfer directory for a profile. Pure; performs no filesystem access. */
export function hostThreadRecordTransferDirectory(profilePath: string): string {
  if (typeof profilePath !== 'string' || !isAbsolute(profilePath)) {
    throw new TypeError('Host thread-record transfer requires an absolute profile path.')
  }
  const resolved = resolve(profilePath)
  if (resolved === parse(resolved).root) {
    throw new TypeError('Host thread-record transfer refuses a filesystem-root profile path.')
  }
  return join(resolved, HOST_THREAD_RECORD_TRANSFER_DIRECTORY)
}

/**
 * Bounded derivation. The transfer id is a single validated path segment, so the
 * join can only ever produce a direct child of the transfer directory; the
 * containment assertion makes that structural rather than implied.
 */
export function hostThreadRecordTransferPath(profilePath: string, transferId: string): string {
  assertTransferId(transferId)
  const directory = hostThreadRecordTransferDirectory(profilePath)
  const path = join(directory, `${transferId}${ARTIFACT_SUFFIX}`)
  if (parse(path).dir !== directory) {
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer id does not resolve to a direct child of the transfer directory.'
    )
  }
  return path
}

/**
 * Serializes and atomically publishes an owner-only artifact, returning the
 * bounded descriptor the command frame should carry.
 */
export function publishHostThreadRecordTransfer(
  options: HostThreadRecordTransferPublishOptions
): HostThreadRecordTransferDescriptor {
  const fs = options.fs ?? (nodeFs as unknown as HostThreadRecordTransferFs)
  const platform = options.platform ?? process.platform
  assertTransferId(options.transferId)

  const serialized = serializeRecord(options.record)
  if (serialized.byteLength > HOST_THREAD_RECORD_TRANSFER_MAX_BYTES) {
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer record exceeds the maximum artifact size.'
    )
  }
  const sha256 = createHash('sha256').update(serialized).digest('hex')

  const directory = prepareTransferDirectory(options.profilePath, fs, platform)
  const targetPath = hostThreadRecordTransferPath(options.profilePath, options.transferId)
  const temporaryPath = join(directory, `.${options.transferId}.${sha256.slice(0, 16)}.tmp`)

  let descriptor: number | null = null
  let published = false
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW || 0),
      PRIVATE_FILE_MODE
    )
    assertRegularFile(
      fs.fstatSync(descriptor, { bigint: true }),
      'Host thread-record transfer artifact'
    )
    if (platform !== 'win32') fs.fchmodSync(descriptor, PRIVATE_FILE_MODE)
    writeAll(fs, descriptor, serialized)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    fs.renameSync(temporaryPath, targetPath)
    published = true
    if (platform !== 'win32') fs.chmodSync(targetPath, PRIVATE_FILE_MODE)
    fsyncDirectory(fs, platform, directory)
  } catch (error) {
    if (!published) {
      try {
        fs.unlinkSync(temporaryPath)
      } catch {
        // An unpublished temp is never authoritative; leave the crash artefact
        // rather than unlinking a path we no longer understand.
      }
    }
    throw error instanceof HostThreadRecordTransferError
      ? error
      : new HostThreadRecordTransferError(
          'Host thread-record transfer artifact could not be published.',
          { cause: error }
        )
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }

  return { transferId: options.transferId, sha256, byteLength: serialized.byteLength }
}

/**
 * Validates and consumes the artifact named by the descriptor, then removes the
 * exact inode it read. Every check binds the live descriptor rather than the
 * path, so a replacement between open and unlink cannot be mistaken for the
 * artifact that was verified.
 */
export function consumeHostThreadRecordTransfer(
  options: HostThreadRecordTransferConsumeOptions
): HostThreadRecordTransferConsumeResult {
  const fs = options.fs ?? (nodeFs as unknown as HostThreadRecordTransferFs)
  const platform = options.platform ?? process.platform
  const expected = assertDescriptor(options.descriptor)
  const path = hostThreadRecordTransferPath(options.profilePath, expected.transferId)
  assertExistingTransferDirectory(options.profilePath, fs, platform)

  let descriptor: number | null = null
  let identity: { dev: number | bigint; ino: number | bigint } | null = null
  try {
    try {
      descriptor = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new HostThreadRecordTransferMissingError(
          'Host thread-record transfer artifact does not exist.',
          { cause: error }
        )
      }
      // O_NOFOLLOW reports ELOOP for a symlinked final component. That is a
      // substitution attempt, not a missing file.
      throw new HostThreadRecordTransferIntegrityError(
        'Host thread-record transfer artifact could not be opened as a real file.',
        { cause: error }
      )
    }

    const stat = fs.fstatSync(descriptor, { bigint: true })
    assertRegularFile(stat, 'Host thread-record transfer artifact')
    assertOwnerOnlyMode(stat, platform, 'Host thread-record transfer artifact')
    identity = { dev: stat.dev, ino: stat.ino }

    const size = typeof stat.size === 'bigint' ? Number(stat.size) : stat.size
    if (!Number.isSafeInteger(size) || size > HOST_THREAD_RECORD_TRANSFER_MAX_BYTES) {
      throw new HostThreadRecordTransferIntegrityError(
        'Host thread-record transfer artifact exceeds the maximum artifact size.'
      )
    }
    if (size !== expected.byteLength) {
      throw new HostThreadRecordTransferIntegrityError(
        'Host thread-record transfer artifact byte length does not match its descriptor.'
      )
    }

    const body = readBoundedExactly(fs, descriptor, size)
    if (createHash('sha256').update(body).digest('hex') !== expected.sha256) {
      throw new HostThreadRecordTransferIntegrityError(
        'Host thread-record transfer artifact digest does not match its descriptor.'
      )
    }

    const record = decodeRecord(body)
    fs.closeSync(descriptor)
    descriptor = null

    return {
      record,
      descriptor: expected,
      identity: describeIdentity(identity),
      removed: removeExactInode(fs, platform, path, identity)
    }
  } catch (error) {
    if (descriptor !== null) {
      fs.closeSync(descriptor)
      descriptor = null
    }
    // A verified-but-rejected artifact is removed so a poisoned transfer cannot
    // accumulate. Only the exact inode inspected above is ever unlinked.
    if (identity && error instanceof HostThreadRecordTransferIntegrityError) {
      try {
        removeExactInode(fs, platform, path, identity)
      } catch {
        // Cleanup is best-effort; the integrity failure is the reportable fault.
      }
    }
    throw error
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

/**
 * Removes an unconsumed artifact, for a publisher abandoning a transfer. Refuses
 * to unlink anything that is not an owner-only regular file, so a substituted
 * symlink cannot redirect the deletion.
 */
export function removeHostThreadRecordTransfer(
  options: HostThreadRecordTransferRemoveOptions
): boolean {
  const fs = options.fs ?? (nodeFs as unknown as HostThreadRecordTransferFs)
  const platform = options.platform ?? process.platform
  const path = hostThreadRecordTransferPath(options.profilePath, options.transferId)

  let stat: HostThreadRecordTransferFileStat
  try {
    stat = fs.lstatSync(path, { bigint: true })
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer artifact could not be inspected for removal.',
      { cause: error }
    )
  }
  assertRegularFile(stat, 'Host thread-record transfer artifact')
  assertOwnerOnlyMode(stat, platform, 'Host thread-record transfer artifact')
  return removeExactInode(fs, platform, path, { dev: stat.dev, ino: stat.ino })
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

/**
 * Unlinks only when the path still resolves to the inode the caller verified.
 * Returns false when the artifact was replaced, so the caller can report that it
 * deliberately left a stranger's file alone.
 */
function removeExactInode(
  fs: HostThreadRecordTransferFs,
  platform: NodeJS.Platform,
  path: string,
  identity: { dev: number | bigint; ino: number | bigint }
): boolean {
  let current: HostThreadRecordTransferFileStat
  try {
    current = fs.lstatSync(path, { bigint: true })
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer artifact could not be re-inspected before removal.',
      { cause: error }
    )
  }
  if (!sameInode(current, identity)) return false
  fs.unlinkSync(path)
  try {
    fsyncDirectory(fs, platform, parse(path).dir)
  } catch {
    // The unlink already succeeded; a directory fsync failure is not a leak.
  }
  return true
}

function sameInode(
  stat: HostThreadRecordTransferFileStat,
  identity: { dev: number | bigint; ino: number | bigint }
): boolean {
  return (
    toIdentityText(stat.dev) === toIdentityText(identity.dev) &&
    toIdentityText(stat.ino) === toIdentityText(identity.ino)
  )
}

function describeIdentity(identity: {
  dev: number | bigint
  ino: number | bigint
}): HostThreadRecordTransferIdentity {
  return { dev: toIdentityText(identity.dev), ino: toIdentityText(identity.ino) }
}

/** Decimal text, so a number and an equal bigint from a bigint-stat compare equal. */
// Stats are requested as bigint: NTFS file reference numbers exceed
// Number.MAX_SAFE_INTEGER, and a double-typed inode is no longer an exact
// identity (the vault and authority lease take the same precaution).
function toIdentityText(value: number | bigint): string {
  if (typeof value === 'bigint') return value.toString(10)
  if (!Number.isFinite(value)) {
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer artifact reported a non-finite file identity.'
    )
  }
  return BigInt(Math.trunc(value)).toString(10)
}

function serializeRecord(record: unknown): Buffer {
  if (!isPlainObject(record)) {
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer requires a plain object record.'
    )
  }
  let serialized: string
  try {
    serialized = JSON.stringify(record)
  } catch (error) {
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer record is not JSON-serializable.',
      { cause: error }
    )
  }
  if (typeof serialized !== 'string') {
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer record did not serialize to JSON text.'
    )
  }
  return Buffer.from(serialized, 'utf8')
}

function decodeRecord(body: Buffer): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown
  } catch (error) {
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer artifact is not valid JSON.',
      { cause: error }
    )
  }
  if (!isPlainObject(parsed)) {
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer artifact did not decode to a plain object.'
    )
  }
  return parsed
}

function prepareTransferDirectory(
  profilePath: string,
  fs: HostThreadRecordTransferFs,
  platform: NodeJS.Platform
): string {
  const directory = hostThreadRecordTransferDirectory(canonicalProfilePath(profilePath, fs))
  let stat: HostThreadRecordTransferFileStat | null = null
  try {
    stat = fs.lstatSync(directory)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw new HostThreadRecordTransferIntegrityError(
        'Host thread-record transfer directory cannot be inspected.',
        { cause: error }
      )
    }
  }
  if (!stat) {
    fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
    stat = fs.lstatSync(directory)
  }
  assertPrivateDirectory(stat, platform, 'Host thread-record transfer directory')
  return directory
}

function assertExistingTransferDirectory(
  profilePath: string,
  fs: HostThreadRecordTransferFs,
  platform: NodeJS.Platform
): void {
  const directory = hostThreadRecordTransferDirectory(profilePath)
  let stat: HostThreadRecordTransferFileStat
  try {
    stat = fs.lstatSync(directory)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new HostThreadRecordTransferMissingError(
        'Host thread-record transfer directory does not exist.',
        { cause: error }
      )
    }
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer directory cannot be inspected.',
      { cause: error }
    )
  }
  assertPrivateDirectory(stat, platform, 'Host thread-record transfer directory')
}

function canonicalProfilePath(profilePath: string, fs: HostThreadRecordTransferFs): string {
  if (typeof profilePath !== 'string' || !isAbsolute(profilePath)) {
    throw new TypeError('Host thread-record transfer requires an absolute profile path.')
  }
  const resolved = resolve(profilePath)
  if (resolved === parse(resolved).root) {
    throw new TypeError('Host thread-record transfer refuses a filesystem-root profile path.')
  }
  const canonical = fs.realpathSync(resolved)
  const stat = fs.lstatSync(canonical)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer profile path is not a real directory.'
    )
  }
  return canonical
}

function assertTransferId(transferId: string): void {
  if (typeof transferId !== 'string' || !TRANSFER_ID_PATTERN.test(transferId)) {
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer id is not a bounded filesystem-safe token.'
    )
  }
}

function assertDescriptor(
  descriptor: HostThreadRecordTransferDescriptor
): HostThreadRecordTransferDescriptor {
  if (!isPlainObject(descriptor)) {
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer descriptor must be an object.'
    )
  }
  assertTransferId(descriptor.transferId)
  if (typeof descriptor.sha256 !== 'string' || !HEX_256_PATTERN.test(descriptor.sha256)) {
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer descriptor sha256 must be lowercase hex-256.'
    )
  }
  if (
    typeof descriptor.byteLength !== 'number' ||
    !Number.isSafeInteger(descriptor.byteLength) ||
    descriptor.byteLength < 0 ||
    descriptor.byteLength > HOST_THREAD_RECORD_TRANSFER_MAX_BYTES
  ) {
    throw new HostThreadRecordTransferIntegrityError(
      'Host thread-record transfer descriptor byteLength is out of range.'
    )
  }
  return {
    transferId: descriptor.transferId,
    sha256: descriptor.sha256,
    byteLength: descriptor.byteLength
  }
}

function assertRegularFile(stat: HostThreadRecordTransferFileStat, label: string): void {
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.nlink !== undefined && stat.nlink !== 1)) {
    throw new HostThreadRecordTransferIntegrityError(`${label} is not a private regular file.`)
  }
}

function assertPrivateDirectory(
  stat: HostThreadRecordTransferFileStat,
  platform: NodeJS.Platform,
  label: string
): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new HostThreadRecordTransferIntegrityError(`${label} is not a real directory.`)
  }
  if (platform === 'win32') return
  const mode = typeof stat.mode === 'bigint' ? Number(stat.mode) : stat.mode
  if (!Number.isSafeInteger(mode) || (mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new HostThreadRecordTransferIntegrityError(`${label} lacks owner-only permissions.`)
  }
}

function assertOwnerOnlyMode(
  stat: HostThreadRecordTransferFileStat,
  platform: NodeJS.Platform,
  label: string
): void {
  if (platform === 'win32') return
  const mode = typeof stat.mode === 'bigint' ? Number(stat.mode) : stat.mode
  if (!Number.isSafeInteger(mode) || (mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new HostThreadRecordTransferIntegrityError(`${label} lacks owner-only permissions.`)
  }
}

/** Reads exactly the fstat-validated size; a growing fd can never allocate unbounded memory. */
function readBoundedExactly(
  fs: HostThreadRecordTransferFs,
  descriptor: number,
  size: number
): Buffer {
  const output = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < output.byteLength) {
    const read = fs.readSync(descriptor, output, offset, output.byteLength - offset, offset)
    if (!Number.isSafeInteger(read) || read <= 0) {
      throw new HostThreadRecordTransferIntegrityError(
        'Host thread-record transfer artifact ended before its declared byte length.'
      )
    }
    offset += read
  }
  return output
}

function writeAll(fs: HostThreadRecordTransferFs, descriptor: number, data: Buffer): void {
  let offset = 0
  while (offset < data.byteLength) {
    const written = fs.writeSync(descriptor, data.subarray(offset))
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new HostThreadRecordTransferError(
        'Host thread-record transfer artifact could not be written completely.'
      )
    }
    offset += written
  }
}

function fsyncDirectory(
  fs: HostThreadRecordTransferFs,
  platform: NodeJS.Platform,
  path: string
): void {
  if (platform === 'win32') return
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY)
  try {
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code
}
