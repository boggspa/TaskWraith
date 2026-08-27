import { randomBytes } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { basename, isAbsolute, parse, resolve } from 'node:path'

/**
 * A profile has exactly one durable authority owner. The host must acquire this
 * before opening any profile-backed store, provider runtime, or recovery log.
 *
 * This is deliberately a small Node-only primitive. It does not import
 * Electron, choose a profile directory, or start a daemon. Its caller supplies
 * a canonical profile root and retains the returned lease for the lifetime of
 * that profile's writer.
 */
export const HOST_PROFILE_AUTHORITY_LEASE_FILENAME = 'taskwraith-host-authority-v1.json'
export const HOST_PROFILE_AUTHORITY_RECLAIM_GUARD_FILENAME =
  'taskwraith-host-authority-v1.json.reclaim'
export const HOST_PROFILE_AUTHORITY_MAX_RECORD_BYTES = 4 * 1024

const SCHEMA_VERSION = 1
const OWNER_PURPOSE = 'taskwraith:host-profile-authority-owner:v1'
const RECLAIM_GUARD_PURPOSE = 'taskwraith:host-profile-authority-reclaim-guard:v1'
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const MAX_RECLAIM_ATTEMPTS = 4
const TOKEN_PATTERN = /^[a-f0-9]{64}$/
const PROCESS_START_IDENTITY_PATTERN = /^[A-Za-z0-9:_-]{8,256}$/

export type HostProfileAuthorityOwnerLiveness = 'live' | 'stale' | 'unknown'

export interface HostProfileAuthorityOwnerRecord {
  readonly schemaVersion: 1
  readonly purpose: typeof OWNER_PURPOSE
  readonly pid: number
  readonly processStartIdentity: string
  readonly processStartedAt: string
  readonly acquiredAt: string
  readonly token: string
}

export type HostProfileAuthorityPeek =
  | { readonly kind: 'absent' }
  | { readonly kind: 'live'; readonly owner: HostProfileAuthorityOwnerRecord }
  | { readonly kind: 'stale'; readonly owner: HostProfileAuthorityOwnerRecord }
  | { readonly kind: 'unknown'; readonly owner: HostProfileAuthorityOwnerRecord }
  | { readonly kind: 'unreadable' }

export interface HostProfileAuthorityProcessIdentity {
  readonly pid: number
  readonly processStartIdentity: string
  readonly processStartedAt: string
}

/**
 * The default liveness implementation is conservative: a pid that exists is
 * live even if it has been reused. A host launcher can inject a platform-aware
 * process-start identity checker to prove reuse and reclaim more promptly.
 */
export interface HostProfileAuthorityProcessPort {
  readonly current: HostProfileAuthorityProcessIdentity
  inspectOwner(owner: HostProfileAuthorityProcessIdentity): HostProfileAuthorityOwnerLiveness
}

export interface HostProfileAuthorityClock {
  now(): Date
}

export interface HostProfileAuthorityIdentityPort {
  createOpaqueToken(): string
}

export interface HostProfileAuthorityLeaseFileStat {
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly size: number | bigint
  readonly mode: number | bigint
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

/**
 * Intentionally small synchronous filesystem seam. It keeps authority
 * acquisition deterministic under fault injection and avoids exposing any
 * Electron-shaped filesystem API to the Node host runtime.
 */
export interface HostProfileAuthorityLeaseFs {
  readonly constants: {
    readonly O_RDONLY: number
    readonly O_WRONLY: number
    readonly O_CREAT: number
    readonly O_EXCL: number
    readonly O_NOFOLLOW?: number
    readonly O_NONBLOCK?: number
  }
  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): unknown
  realpathSync(path: string): string
  lstatSync(path: string): HostProfileAuthorityLeaseFileStat
  openSync(path: string, flags: number, mode?: number): number
  fstatSync(fd: number): HostProfileAuthorityLeaseFileStat
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
  unlinkSync(path: string): void
}

export interface HostProfileAuthorityLeaseOptions {
  /** Canonical profile directory supplied by the host's profile resolver. */
  readonly profilePath: string
  readonly fs?: HostProfileAuthorityLeaseFs
  readonly platform?: NodeJS.Platform
  readonly processPort?: HostProfileAuthorityProcessPort
  readonly clock?: HostProfileAuthorityClock
  readonly identity?: HostProfileAuthorityIdentityPort
  /** Test-only deterministic interleaving seam, invoked while the guard is held. */
  readonly onReclaimGuardAcquired?: () => void
}

export class HostProfileAuthorityLeaseBusyError extends Error {
  readonly owner: HostProfileAuthorityOwnerRecord
  readonly liveness: Exclude<HostProfileAuthorityOwnerLiveness, 'stale'>

  constructor(
    owner: HostProfileAuthorityOwnerRecord,
    liveness: Exclude<HostProfileAuthorityOwnerLiveness, 'stale'>
  ) {
    super(
      `The profile authority is held by pid ${owner.pid} ` +
        `(${liveness === 'live' ? 'owner is live' : 'owner liveness is indeterminate'}).`
    )
    this.name = 'HostProfileAuthorityLeaseBusyError'
    this.owner = owner
    this.liveness = liveness
  }
}

/** A pre-existing artefact was unsafe to interpret or reclaim automatically. */
export class HostProfileAuthorityLeaseBlockedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'HostProfileAuthorityLeaseBlockedError'
  }
}

interface FileIdentity {
  readonly dev: string
  readonly ino: string
}

interface ReadRecord<T> {
  readonly record: T
  readonly identity: FileIdentity
}

interface ReclaimGuardRecord {
  readonly schemaVersion: 1
  readonly purpose: typeof RECLAIM_GUARD_PURPOSE
  readonly pid: number
  readonly processStartIdentity: string
  readonly processStartedAt: string
  readonly acquiredAt: string
  readonly token: string
  readonly expectedOwnerToken: string
}

const processStartedAt = new Date(Date.now() - Math.floor(process.uptime() * 1_000)).toISOString()
const processStartIdentity = `node:${process.pid}:${process.hrtime.bigint().toString(16)}`

const productionFs: HostProfileAuthorityLeaseFs = nodeFs as HostProfileAuthorityLeaseFs

const defaultProcessPort: HostProfileAuthorityProcessPort = {
  current: {
    pid: process.pid,
    processStartIdentity,
    processStartedAt
  },
  inspectOwner: (owner) => {
    try {
      process.kill(owner.pid, 0)
      return 'live'
    } catch (error) {
      if (isErrno(error, 'ESRCH')) return 'stale'
      return 'unknown'
    }
  }
}

const defaultClock: HostProfileAuthorityClock = { now: () => new Date() }
const defaultIdentity: HostProfileAuthorityIdentityPort = {
  createOpaqueToken: () => randomBytes(32).toString('hex')
}

/**
 * Cross-process ownership lease for a single profile writer.
 *
 * Atomic O_EXCL creation decides the winner. Any automatic stale-owner
 * recovery is serialized behind a second O_EXCL guard and rechecks the exact
 * observed owner token and file identity immediately before unlinking it.
 */
export class HostProfileAuthorityLease {
  private readonly fs: HostProfileAuthorityLeaseFs
  private readonly platform: NodeJS.Platform
  private readonly processPort: HostProfileAuthorityProcessPort
  private readonly clock: HostProfileAuthorityClock
  private readonly identity: HostProfileAuthorityIdentityPort
  private readonly profilePath: string
  private readonly ownerPath: string
  private readonly reclaimGuardPath: string
  private readonly ownerRecord: HostProfileAuthorityOwnerRecord
  private readonly ownerFileIdentity: FileIdentity
  private readonly onReclaimGuardAcquired?: () => void
  private released = false

  private constructor(
    resolvedOptions: ResolvedOptions,
    ownerRecord: HostProfileAuthorityOwnerRecord,
    ownerFileIdentity: FileIdentity
  ) {
    this.fs = resolvedOptions.fs
    this.platform = resolvedOptions.platform
    this.processPort = resolvedOptions.processPort
    this.clock = resolvedOptions.clock
    this.identity = resolvedOptions.identity
    this.profilePath = resolvedOptions.profilePath
    this.ownerPath = resolvedOptions.ownerPath
    this.reclaimGuardPath = resolvedOptions.reclaimGuardPath
    this.ownerRecord = ownerRecord
    this.ownerFileIdentity = ownerFileIdentity
    this.onReclaimGuardAcquired = resolvedOptions.onReclaimGuardAcquired
  }

  static acquire(options: HostProfileAuthorityLeaseOptions): HostProfileAuthorityLease {
    const resolved = resolveOptions(options)
    ensurePrivateProfileDirectory(resolved)
    const candidate = createOwnerRecord(resolved)

    for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
      const created = createExclusiveRecord(resolved, resolved.ownerPath, candidate)
      if (created) return new HostProfileAuthorityLease(resolved, candidate, created)

      const observed = readOptionalOwnerRecord(
        resolved,
        resolved.ownerPath,
        'profile authority owner'
      )
      if (!observed) continue

      const liveness = inspectOwner(resolved.processPort, observed.record)
      if (liveness !== 'stale')
        throw new HostProfileAuthorityLeaseBusyError(observed.record, liveness)

      reclaimStaleOwner(resolved, observed)
    }

    throw new HostProfileAuthorityLeaseBlockedError(
      'The profile authority changed during stale-owner recovery; refusing an unproven acquisition.'
    )
  }

  /**
   * Read-only liveness of the durable owner record. Does not mkdir, acquire,
   * or reclaim. Malformed artefacts fail closed as `unreadable`.
   */
  static peek(
    options: Pick<
      HostProfileAuthorityLeaseOptions,
      'profilePath' | 'fs' | 'platform' | 'processPort'
    >
  ): HostProfileAuthorityPeek {
    if (!options || typeof options.profilePath !== 'string' || !isAbsolute(options.profilePath)) {
      return { kind: 'unreadable' }
    }
    const fs = options.fs || productionFs
    const platform = options.platform || process.platform
    const processPort = options.processPort || defaultProcessPort
    const configuredPath = resolve(options.profilePath)
    if (configuredPath === parse(configuredPath).root) return { kind: 'unreadable' }
    let profilePath: string
    try {
      const stat = fs.lstatSync(configuredPath)
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { kind: 'unreadable' }
      profilePath = fs.realpathSync(configuredPath)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { kind: 'absent' }
      return { kind: 'unreadable' }
    }
    const resolved: ResolvedOptions = {
      fs,
      platform,
      processPort,
      clock: defaultClock,
      identity: defaultIdentity,
      profilePath,
      ownerPath: joinLeaf(profilePath, HOST_PROFILE_AUTHORITY_LEASE_FILENAME),
      reclaimGuardPath: joinLeaf(profilePath, HOST_PROFILE_AUTHORITY_RECLAIM_GUARD_FILENAME)
    }
    try {
      const observed = readOptionalOwnerRecord(
        resolved,
        resolved.ownerPath,
        'profile authority owner'
      )
      if (!observed) return { kind: 'absent' }
      const liveness = inspectOwner(processPort, observed.record)
      if (liveness === 'live') return { kind: 'live', owner: observed.record }
      if (liveness === 'stale') return { kind: 'stale', owner: observed.record }
      return { kind: 'unknown', owner: observed.record }
    } catch {
      return { kind: 'unreadable' }
    }
  }

  /** The canonical profile root this instance fenced. */
  get path(): string {
    return this.profilePath
  }

  /** Exact owner record written for this lease. Treat its token as secret capability material. */
  get owner(): Readonly<HostProfileAuthorityOwnerRecord> {
    return this.ownerRecord
  }

  /**
   * Proves this exact lease remains live before a profile-backed operation.
   * A released lease, missing/malformed owner record, opaque-token mismatch,
   * or inode replacement all fail closed.
   */
  assertHeld(): void {
    if (this.released) {
      throw new HostProfileAuthorityLeaseBlockedError('Profile authority lease was released.')
    }
    const options: ResolvedOptions = {
      fs: this.fs,
      platform: this.platform,
      processPort: this.processPort,
      clock: this.clock,
      identity: this.identity,
      profilePath: this.profilePath,
      ownerPath: this.ownerPath,
      reclaimGuardPath: this.reclaimGuardPath,
      onReclaimGuardAcquired: this.onReclaimGuardAcquired
    }
    const observed = readOptionalOwnerRecord(options, this.ownerPath, 'profile authority owner')
    if (
      !observed ||
      observed.record.token !== this.ownerRecord.token ||
      serializeRecord(observed.record) !== serializeRecord(this.ownerRecord) ||
      !sameFileIdentity(observed.identity, this.ownerFileIdentity)
    ) {
      throw new HostProfileAuthorityLeaseBlockedError(
        'Profile authority lease is no longer the exact owner record.'
      )
    }
  }

  /**
   * Removes only the same inode and same opaque token this instance acquired.
   * Repeated calls are harmless. A missing, replaced, or malformed path is
   * deliberately left in place rather than risking a successor's authority.
   */
  release(): boolean {
    if (this.released) return false
    const options: ResolvedOptions = {
      fs: this.fs,
      platform: this.platform,
      processPort: this.processPort,
      clock: this.clock,
      identity: this.identity,
      profilePath: this.profilePath,
      ownerPath: this.ownerPath,
      reclaimGuardPath: this.reclaimGuardPath,
      onReclaimGuardAcquired: this.onReclaimGuardAcquired
    }
    const guard = createReclaimGuardRecord(options, this.ownerRecord.token)
    const guardIdentity = createExclusiveRecord(options, this.reclaimGuardPath, guard)
    if (!guardIdentity) return false

    let removed = false
    try {
      options.onReclaimGuardAcquired?.()
      removed = removeExactOwnerRecord(options, this.ownerRecord.token, this.ownerFileIdentity)
    } finally {
      removeExactReclaimGuard(options, guard.token, guardIdentity)
    }
    this.released = true
    return removed
  }

  /** Alias suited to shutdown finally blocks. It has the same idempotent semantics as release(). */
  dispose(): boolean {
    return this.release()
  }
}

interface ResolvedOptions {
  readonly fs: HostProfileAuthorityLeaseFs
  readonly platform: NodeJS.Platform
  readonly processPort: HostProfileAuthorityProcessPort
  readonly clock: HostProfileAuthorityClock
  readonly identity: HostProfileAuthorityIdentityPort
  readonly profilePath: string
  readonly ownerPath: string
  readonly reclaimGuardPath: string
  readonly onReclaimGuardAcquired?: () => void
}

function resolveOptions(options: HostProfileAuthorityLeaseOptions): ResolvedOptions {
  if (!options || typeof options !== 'object') {
    throw new TypeError('Host profile authority lease options are required.')
  }
  if (typeof options.profilePath !== 'string' || options.profilePath.length === 0) {
    throw new TypeError('Host profile authority requires a profile path.')
  }
  if (!isAbsolute(options.profilePath)) {
    throw new TypeError('Host profile authority requires an absolute profile path.')
  }

  const fs = options.fs || productionFs
  const configuredPath = resolve(options.profilePath)
  if (configuredPath === parse(configuredPath).root) {
    throw new TypeError('Host profile authority refuses a filesystem root.')
  }

  fs.mkdirSync(configuredPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  const profilePath = fs.realpathSync(configuredPath)
  if (
    !isAbsolute(profilePath) ||
    resolve(profilePath) !== profilePath ||
    profilePath === parse(profilePath).root
  ) {
    throw new HostProfileAuthorityLeaseBlockedError(
      'Host profile authority could not resolve a canonical non-root profile directory.'
    )
  }

  const processPort = options.processPort || defaultProcessPort
  assertCurrentProcessIdentity(processPort.current)
  const clock = options.clock || defaultClock
  const identity = options.identity || defaultIdentity
  if (typeof processPort.inspectOwner !== 'function') {
    throw new TypeError('Host profile authority requires an owner-liveness function.')
  }
  if (typeof clock.now !== 'function')
    throw new TypeError('Host profile authority requires a clock.')
  if (typeof identity.createOpaqueToken !== 'function') {
    throw new TypeError('Host profile authority requires an opaque-token generator.')
  }

  return {
    fs,
    platform: options.platform || process.platform,
    processPort,
    clock,
    identity,
    profilePath,
    ownerPath: joinLeaf(profilePath, HOST_PROFILE_AUTHORITY_LEASE_FILENAME),
    reclaimGuardPath: joinLeaf(profilePath, HOST_PROFILE_AUTHORITY_RECLAIM_GUARD_FILENAME),
    onReclaimGuardAcquired: options.onReclaimGuardAcquired
  }
}

function ensurePrivateProfileDirectory(options: ResolvedOptions): void {
  const stat = options.fs.lstatSync(options.profilePath)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new HostProfileAuthorityLeaseBlockedError(
      'Host profile authority requires a real profile directory, not a link or non-directory.'
    )
  }
  if (options.platform !== 'win32')
    options.fs.chmodSync(options.profilePath, PRIVATE_DIRECTORY_MODE)
}

function createOwnerRecord(options: ResolvedOptions): HostProfileAuthorityOwnerRecord {
  const acquiredAt = canonicalNow(options.clock)
  const token = options.identity.createOpaqueToken()
  assertOpaqueToken(token, 'Host profile authority token')
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    purpose: OWNER_PURPOSE,
    pid: options.processPort.current.pid,
    processStartIdentity: options.processPort.current.processStartIdentity,
    processStartedAt: options.processPort.current.processStartedAt,
    acquiredAt,
    token
  })
}

function reclaimStaleOwner(
  options: ResolvedOptions,
  observed: ReadRecord<HostProfileAuthorityOwnerRecord>
): void {
  const guard = createReclaimGuardRecord(options, observed.record.token)
  const guardIdentity = createExclusiveRecord(options, options.reclaimGuardPath, guard)
  if (!guardIdentity) {
    const activeGuard = readOptionalReclaimGuardRecord(options, options.reclaimGuardPath)
    if (!activeGuard) return
    const liveness = inspectOwner(options.processPort, activeGuard.record)
    if (liveness === 'live') {
      throw new HostProfileAuthorityLeaseBlockedError(
        'A live reclaimer is validating the stale profile authority; refusing a parallel reclaim.'
      )
    }
    throw new HostProfileAuthorityLeaseBlockedError(
      'A stale or indeterminate reclaim guard remains; refusing unsafe automatic guard recovery.'
    )
  }

  try {
    options.onReclaimGuardAcquired?.()
    const current = readOptionalOwnerRecord(options, options.ownerPath, 'profile authority owner')
    if (
      !current ||
      current.record.token !== observed.record.token ||
      !sameFileIdentity(current.identity, observed.identity)
    ) {
      return
    }

    const liveness = inspectOwner(options.processPort, current.record)
    if (liveness !== 'stale') throw new HostProfileAuthorityLeaseBusyError(current.record, liveness)
    removeExactOwnerRecord(options, observed.record.token, observed.identity)
  } finally {
    removeExactReclaimGuard(options, guard.token, guardIdentity)
  }
}

function createReclaimGuardRecord(
  options: ResolvedOptions,
  expectedOwnerToken: string
): ReclaimGuardRecord {
  const acquiredAt = canonicalNow(options.clock)
  const token = options.identity.createOpaqueToken()
  assertOpaqueToken(token, 'Host profile authority reclaim token')
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    purpose: RECLAIM_GUARD_PURPOSE,
    pid: options.processPort.current.pid,
    processStartIdentity: options.processPort.current.processStartIdentity,
    processStartedAt: options.processPort.current.processStartedAt,
    acquiredAt,
    token,
    expectedOwnerToken
  })
}

function createExclusiveRecord(
  options: ResolvedOptions,
  path: string,
  record: HostProfileAuthorityOwnerRecord | ReclaimGuardRecord
): FileIdentity | null {
  const flags =
    options.fs.constants.O_WRONLY |
    options.fs.constants.O_CREAT |
    options.fs.constants.O_EXCL |
    (options.fs.constants.O_NOFOLLOW || 0)
  let descriptor: number | null = null
  let openedIdentity: FileIdentity | null = null
  let creationFailed = false
  let failure: unknown
  try {
    try {
      descriptor = options.fs.openSync(path, flags, PRIVATE_FILE_MODE)
    } catch (error) {
      if (isErrno(error, 'EEXIST')) return null
      throw error
    }
    const descriptorStat = options.fs.fstatSync(descriptor)
    assertRegularFile(descriptorStat, path)
    openedIdentity = fileIdentity(descriptorStat, path)
    const pathStat = options.fs.lstatSync(path)
    assertSameFile(pathStat, openedIdentity, path)
    if (options.platform !== 'win32') options.fs.fchmodSync(descriptor, PRIVATE_FILE_MODE)

    writeAll(options.fs, descriptor, Buffer.from(serializeRecord(record), 'utf8'))
    options.fs.fsyncSync(descriptor)
    assertSameFile(options.fs.lstatSync(path), openedIdentity, path)
  } catch (error) {
    creationFailed = true
    failure = error
  } finally {
    if (descriptor !== null) {
      try {
        options.fs.closeSync(descriptor)
      } catch (error) {
        if (!creationFailed) {
          creationFailed = true
          failure = error
        }
      }
    }
  }

  if (creationFailed) {
    if (openedIdentity) removePathIfSameIdentity(options, path, openedIdentity)
    throw failure
  }
  if (!openedIdentity) {
    throw new HostProfileAuthorityLeaseBlockedError(
      'Profile authority exclusive creation ended without an owned file identity.'
    )
  }
  try {
    fsyncDirectory(options)
  } catch (error) {
    removePathIfSameIdentity(options, path, openedIdentity)
    throw error
  }
  return openedIdentity
}

function readOptionalOwnerRecord(
  options: ResolvedOptions,
  path: string,
  label: string
): ReadRecord<HostProfileAuthorityOwnerRecord> | null {
  const read = readOptionalRecord(options, path, label)
  if (!read) return null
  return { record: parseOwnerRecord(read.raw, label), identity: read.identity }
}

function readOptionalReclaimGuardRecord(
  options: ResolvedOptions,
  path: string
): ReadRecord<ReclaimGuardRecord> | null {
  const read = readOptionalRecord(options, path, 'profile authority reclaim guard')
  if (!read) return null
  return { record: parseReclaimGuardRecord(read.raw), identity: read.identity }
}

function readOptionalRecord(
  options: Pick<ResolvedOptions, 'fs' | 'platform'>,
  path: string,
  label: string
): { raw: string; identity: FileIdentity } | null {
  const flags =
    options.fs.constants.O_RDONLY |
    (options.fs.constants.O_NOFOLLOW || 0) |
    (options.fs.constants.O_NONBLOCK || 0)
  let descriptor: number | null = null
  try {
    try {
      descriptor = options.fs.openSync(path, flags)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null
      throw blockedReadError(label, error)
    }
    const descriptorStat = options.fs.fstatSync(descriptor)
    assertRegularFile(descriptorStat, label)
    assertOwnerOnlyMode(descriptorStat, options.platform, label)
    const identity = fileIdentity(descriptorStat, label)
    assertSameFile(options.fs.lstatSync(path), identity, label)
    const size = boundedSize(descriptorStat.size, label)
    const bytes = readExactly(options.fs, descriptor, size, label)
    if (bytes.byteLength !== size) {
      throw new HostProfileAuthorityLeaseBlockedError(
        `${label} changed while it was being read; refusing a partial authority record.`
      )
    }
    const finalDescriptorStat = options.fs.fstatSync(descriptor)
    assertSameFile(finalDescriptorStat, identity, label)
    assertOwnerOnlyMode(finalDescriptorStat, options.platform, label)
    if (boundedSize(finalDescriptorStat.size, label) !== size) {
      throw new HostProfileAuthorityLeaseBlockedError(
        `${label} changed size while it was being read; refusing a raced authority record.`
      )
    }
    assertSameFile(options.fs.lstatSync(path), identity, label)
    return { raw: bytes.toString('utf8'), identity }
  } catch (error) {
    if (error instanceof HostProfileAuthorityLeaseBlockedError) throw error
    throw blockedReadError(label, error)
  } finally {
    if (descriptor !== null) options.fs.closeSync(descriptor)
  }
}

function removeExactOwnerRecord(
  options: Pick<ResolvedOptions, 'fs' | 'platform' | 'profilePath'>,
  token: string,
  expectedIdentity: FileIdentity
): boolean {
  const ownerPath = joinLeaf(options.profilePath, HOST_PROFILE_AUTHORITY_LEASE_FILENAME)
  const read = readOptionalRecord(options, ownerPath, 'profile authority owner')
  if (!read) return false
  const owner = parseOwnerRecord(read.raw, 'profile authority owner')
  if (owner.token !== token || !sameFileIdentity(read.identity, expectedIdentity)) return false
  options.fs.unlinkSync(ownerPath)
  fsyncDirectory(options)
  return true
}

function removeExactReclaimGuard(
  options: ResolvedOptions,
  token: string,
  expectedIdentity: FileIdentity
): boolean {
  const read = readOptionalReclaimGuardRecord(options, options.reclaimGuardPath)
  if (!read || read.record.token !== token || !sameFileIdentity(read.identity, expectedIdentity)) {
    return false
  }
  options.fs.unlinkSync(options.reclaimGuardPath)
  fsyncDirectory(options)
  return true
}

function removePathIfSameIdentity(
  options: Pick<ResolvedOptions, 'fs' | 'platform' | 'profilePath'>,
  path: string,
  expectedIdentity: FileIdentity
): void {
  try {
    const stat = options.fs.lstatSync(path)
    assertRegularFile(stat, path)
    if (!sameFileIdentity(fileIdentity(stat, path), expectedIdentity)) return
    options.fs.unlinkSync(path)
    fsyncDirectory(options)
  } catch {
    // Failure leaves the artefact in place, which is the safe outcome.
  }
}

function parseOwnerRecord(raw: string, label: string): HostProfileAuthorityOwnerRecord {
  const value = parseExactRecord(raw, label, [
    'schemaVersion',
    'purpose',
    'pid',
    'processStartIdentity',
    'processStartedAt',
    'acquiredAt',
    'token'
  ])
  if (value.schemaVersion !== SCHEMA_VERSION || value.purpose !== OWNER_PURPOSE) {
    throw new HostProfileAuthorityLeaseBlockedError(`${label} has an unsupported authority schema.`)
  }
  const record: HostProfileAuthorityOwnerRecord = {
    schemaVersion: SCHEMA_VERSION,
    purpose: OWNER_PURPOSE,
    pid: requirePid(value.pid, `${label}.pid`),
    processStartIdentity: requireProcessStartIdentity(
      value.processStartIdentity,
      `${label}.processStartIdentity`
    ),
    processStartedAt: requireCanonicalIso(value.processStartedAt, `${label}.processStartedAt`),
    acquiredAt: requireCanonicalIso(value.acquiredAt, `${label}.acquiredAt`),
    token: requireOpaqueToken(value.token, `${label}.token`)
  }
  assertCanonicalSerialized(raw, record, label)
  return Object.freeze(record)
}

function parseReclaimGuardRecord(raw: string): ReclaimGuardRecord {
  const label = 'profile authority reclaim guard'
  const value = parseExactRecord(raw, label, [
    'schemaVersion',
    'purpose',
    'pid',
    'processStartIdentity',
    'processStartedAt',
    'acquiredAt',
    'token',
    'expectedOwnerToken'
  ])
  if (value.schemaVersion !== SCHEMA_VERSION || value.purpose !== RECLAIM_GUARD_PURPOSE) {
    throw new HostProfileAuthorityLeaseBlockedError(`${label} has an unsupported authority schema.`)
  }
  const record: ReclaimGuardRecord = {
    schemaVersion: SCHEMA_VERSION,
    purpose: RECLAIM_GUARD_PURPOSE,
    pid: requirePid(value.pid, `${label}.pid`),
    processStartIdentity: requireProcessStartIdentity(
      value.processStartIdentity,
      `${label}.processStartIdentity`
    ),
    processStartedAt: requireCanonicalIso(value.processStartedAt, `${label}.processStartedAt`),
    acquiredAt: requireCanonicalIso(value.acquiredAt, `${label}.acquiredAt`),
    token: requireOpaqueToken(value.token, `${label}.token`),
    expectedOwnerToken: requireOpaqueToken(value.expectedOwnerToken, `${label}.expectedOwnerToken`)
  }
  assertCanonicalSerialized(raw, record, label)
  return Object.freeze(record)
}

function parseExactRecord(
  raw: string,
  label: string,
  expectedKeys: readonly string[]
): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch (error) {
    throw new HostProfileAuthorityLeaseBlockedError(`${label} is not valid JSON.`, { cause: error })
  }
  if (!isPlainObject(value)) {
    throw new HostProfileAuthorityLeaseBlockedError(`${label} must be a plain JSON object.`)
  }
  const actualKeys = Object.keys(value).sort()
  const sortedExpected = [...expectedKeys].sort()
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new HostProfileAuthorityLeaseBlockedError(`${label} has unexpected or missing fields.`)
  }
  return value
}

function assertCanonicalSerialized(
  raw: string,
  record: HostProfileAuthorityOwnerRecord | ReclaimGuardRecord,
  label: string
): void {
  if (raw !== serializeRecord(record)) {
    throw new HostProfileAuthorityLeaseBlockedError(
      `${label} is not a canonical bounded authority record.`
    )
  }
}

function serializeRecord(record: HostProfileAuthorityOwnerRecord | ReclaimGuardRecord): string {
  return `${JSON.stringify(record)}\n`
}

function assertCurrentProcessIdentity(value: HostProfileAuthorityProcessIdentity): void {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Host profile authority requires a current process identity.')
  }
  requirePid(value.pid, 'current process pid')
  requireProcessStartIdentity(value.processStartIdentity, 'current process start identity')
  requireCanonicalIso(value.processStartedAt, 'current process startedAt')
}

function inspectOwner(
  processPort: HostProfileAuthorityProcessPort,
  owner: HostProfileAuthorityProcessIdentity
): HostProfileAuthorityOwnerLiveness {
  try {
    const result = processPort.inspectOwner(owner)
    if (result === 'live' || result === 'stale' || result === 'unknown') return result
  } catch {
    // A liveness checker is evidence, never permission to steal an owner.
  }
  return 'unknown'
}

function canonicalNow(clock: HostProfileAuthorityClock): string {
  const value = clock.now()
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError('Host profile authority clock returned an invalid time.')
  }
  return value.toISOString()
}

function requirePid(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > 2_147_483_647
  ) {
    throw new HostProfileAuthorityLeaseBlockedError(`${label} must be a positive process id.`)
  }
  return value
}

function requireProcessStartIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !PROCESS_START_IDENTITY_PATTERN.test(value)) {
    throw new HostProfileAuthorityLeaseBlockedError(`${label} is invalid.`)
  }
  return value
}

function assertOpaqueToken(value: unknown, label: string): asserts value is string {
  requireOpaqueToken(value, label)
}

function requireOpaqueToken(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) {
    throw new HostProfileAuthorityLeaseBlockedError(
      `${label} must be a 32-byte lowercase-hex token.`
    )
  }
  return value
}

function requireCanonicalIso(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new HostProfileAuthorityLeaseBlockedError(`${label} must be a canonical ISO timestamp.`)
  }
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new HostProfileAuthorityLeaseBlockedError(`${label} must be a canonical ISO timestamp.`)
  }
  return value
}

function assertRegularFile(stat: HostProfileAuthorityLeaseFileStat, label: string): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new HostProfileAuthorityLeaseBlockedError(`${label} is not a regular authority file.`)
  }
}

function assertOwnerOnlyMode(
  stat: HostProfileAuthorityLeaseFileStat,
  platform: NodeJS.Platform,
  label: string
): void {
  if (platform === 'win32') return
  const mode = typeof stat.mode === 'bigint' ? Number(stat.mode) : stat.mode
  if (!Number.isSafeInteger(mode) || (mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new HostProfileAuthorityLeaseBlockedError(
      `${label} does not have owner-only authority-file permissions.`
    )
  }
}

function boundedSize(size: number | bigint, label: string): number {
  const normalized = typeof size === 'bigint' ? Number(size) : size
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 0 ||
    normalized > HOST_PROFILE_AUTHORITY_MAX_RECORD_BYTES
  ) {
    throw new HostProfileAuthorityLeaseBlockedError(
      `${label} exceeds the ${HOST_PROFILE_AUTHORITY_MAX_RECORD_BYTES}-byte authority record limit.`
    )
  }
  return normalized
}

function fileIdentity(stat: HostProfileAuthorityLeaseFileStat, label: string): FileIdentity {
  const dev = normalizeIdentityPart(stat.dev)
  const ino = normalizeIdentityPart(stat.ino)
  if (dev === null || ino === null || ino === '0') {
    throw new HostProfileAuthorityLeaseBlockedError(
      `${label} does not expose a stable file identity for compare-before-release.`
    )
  }
  return { dev, ino }
}

function normalizeIdentityPart(value: number | bigint): string | null {
  if (typeof value === 'bigint') return value >= 0n ? value.toString(10) : null
  if (!Number.isSafeInteger(value) || value < 0) return null
  return String(value)
}

function assertSameFile(
  stat: HostProfileAuthorityLeaseFileStat,
  expectedIdentity: FileIdentity,
  label: string
): void {
  assertRegularFile(stat, label)
  if (!sameFileIdentity(fileIdentity(stat, label), expectedIdentity)) {
    throw new HostProfileAuthorityLeaseBlockedError(
      `${label} changed identity while it was being validated.`
    )
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function readExactly(
  fs: HostProfileAuthorityLeaseFs,
  descriptor: number,
  size: number,
  label: string
): Buffer {
  const output = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < output.byteLength) {
    const read = fs.readSync(descriptor, output, offset, output.byteLength - offset, offset)
    if (!Number.isSafeInteger(read) || read <= 0) break
    offset += read
  }
  if (offset !== output.byteLength) {
    throw new HostProfileAuthorityLeaseBlockedError(`${label} ended before its validated size.`)
  }
  return output
}

function writeAll(fs: HostProfileAuthorityLeaseFs, descriptor: number, data: Buffer): void {
  let offset = 0
  while (offset < data.byteLength) {
    const written = fs.writeSync(descriptor, data.subarray(offset))
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new HostProfileAuthorityLeaseBlockedError(
        'Could not write the complete authority record.'
      )
    }
    offset += written
  }
}

function fsyncDirectory(options: Pick<ResolvedOptions, 'fs' | 'platform' | 'profilePath'>): void {
  if (options.platform === 'win32') return
  const descriptor = options.fs.openSync(options.profilePath, options.fs.constants.O_RDONLY)
  try {
    options.fs.fsyncSync(descriptor)
  } finally {
    options.fs.closeSync(descriptor)
  }
}

function joinLeaf(directory: string, leaf: string): string {
  if (basename(leaf) !== leaf || leaf === '.' || leaf === '..') {
    throw new TypeError('Host profile authority filename is unsafe.')
  }
  return resolve(directory, leaf)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function blockedReadError(label: string, cause: unknown): HostProfileAuthorityLeaseBlockedError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new HostProfileAuthorityLeaseBlockedError(`${label} cannot be read safely (${detail}).`, {
    cause
  })
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  )
}
