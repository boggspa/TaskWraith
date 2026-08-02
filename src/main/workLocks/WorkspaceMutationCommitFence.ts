import { randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { join, resolve } from 'node:path'

import { isWorkspaceLockOpaqueId, isWorkspaceLockOwnerDisplayText } from './WorkspaceLockTypes'

export const WORKSPACE_MUTATION_COMMIT_FENCE_DIRECTORY = 'workspace-mutation-commit-fence'
export const WORKSPACE_MUTATION_COMMIT_FENCE_FILENAME = 'fence.json'
export const WORKSPACE_MUTATION_COMMIT_RECLAIM_GUARD_FILENAME = 'reclaim-guard.json'

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const FENCE_RECORD_KEYS = [
  'acquiredAt',
  'fenceId',
  'lockOwnerId',
  'pid',
  'processBirthIdentity',
  'runId'
] as const
const LEGACY_FENCE_PRESENTATION_KEYS = [
  'chatId',
  'chatTitle',
  'displayName',
  'laneId',
  'lifecycle',
  'participantId',
  'provider'
] as const
const LEGACY_FENCE_RECORD_KEYS = new Set<string>([
  ...FENCE_RECORD_KEYS,
  ...LEGACY_FENCE_PRESENTATION_KEYS
])

export interface WorkspaceMutationCommitFenceIdentity {
  readonly lockOwnerId: string
  readonly runId: string
  readonly pid: number
  readonly processBirthIdentity: string
}

export interface WorkspaceMutationCommitFencePartition {
  readonly worktreeCanonicalPath: string
  readonly worktreeObjectIdentity: string
}

/** The exact, complete owner record persisted in userData. */
export interface WorkspaceMutationCommitFenceOwner extends WorkspaceMutationCommitFenceIdentity {
  readonly partitionKey?: string
  readonly fenceId: string
  readonly acquiredAt: string
}

export type WorkspaceMutationCommitFenceProcessObservation =
  | { state: 'dead' }
  | { state: 'live'; processBirthIdentity: string }
  | { state: 'identity_unavailable' }

export interface WorkspaceMutationCommitFenceStat {
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly mode: number | bigint
  readonly size: number | bigint
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

/** Injectable synchronous filesystem seam; exact liveness remains asynchronous. */
export interface WorkspaceMutationCommitFenceFs {
  readonly constants: {
    readonly O_RDONLY: number
    readonly O_WRONLY: number
    readonly O_CREAT: number
    readonly O_EXCL: number
    readonly O_NOFOLLOW?: number
  }
  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): unknown
  lstatSync(path: string): WorkspaceMutationCommitFenceStat
  openSync(path: string, flags: number, mode?: number): number
  fstatSync(fd: number): WorkspaceMutationCommitFenceStat
  readFileSync(fd: number): Buffer
  writeSync(fd: number, data: string | Buffer, position?: number): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  chmodSync(path: string, mode: number): void
  linkSync(existingPath: string, newPath: string): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
}

export interface WorkspaceMutationCommitFenceOptions {
  /**
   * Machine-shared per-user authority root. Profile-specific Electron
   * userData would split the global commit fence across desktop instances.
   */
  userDataRoot: string
  observeProcess: (
    pid: number
  ) =>
    | WorkspaceMutationCommitFenceProcessObservation
    | Promise<WorkspaceMutationCommitFenceProcessObservation>
  nowIso?: () => string
  nextId?: (kind: 'fence' | 'reclaim-guard') => string
  fs?: WorkspaceMutationCommitFenceFs
  /** Deterministic fault/interleaving seam; production callers should omit it. */
  onReclaimGuardAcquired?: (
    guard: Readonly<WorkspaceMutationCommitReclaimGuard>
  ) => void | Promise<void>
  /** Deterministic stale-cleanup interleaving seam; production callers omit it. */
  onStaleReclaimGuardQuarantined?: () => void | Promise<void>
}

interface ArtifactSnapshot {
  readonly bytes: Buffer
  readonly raw: string
  readonly stat: WorkspaceMutationCommitFenceStat
}

interface WorkspaceMutationCommitReclaimGuard {
  readonly guardId: string
  readonly expectedFenceId: string
  readonly contender: WorkspaceMutationCommitFenceOwner
}

export class WorkspaceMutationCommitFenceBusyError extends Error {
  readonly existing: WorkspaceMutationCommitFenceOwner | null

  constructor(existing: WorkspaceMutationCommitFenceOwner | null) {
    super('Another workspace mutation is already inside its brokered commit critical section.')
    this.name = 'WorkspaceMutationCommitFenceBusyError'
    this.existing = existing
  }
}

export class WorkspaceMutationCommitFenceIdentityUnavailableError extends Error {
  readonly pid: number
  readonly existing: WorkspaceMutationCommitFenceOwner | null

  constructor(pid: number, existing: WorkspaceMutationCommitFenceOwner | null) {
    super(`Exact process-birth identity is unavailable for workspace mutation fence PID ${pid}.`)
    this.name = 'WorkspaceMutationCommitFenceIdentityUnavailableError'
    this.pid = pid
    this.existing = existing
  }
}

export class WorkspaceMutationCommitFenceOwnerNotLiveError extends Error {
  readonly owner: WorkspaceMutationCommitFenceIdentity

  constructor(owner: WorkspaceMutationCommitFenceIdentity) {
    super(
      `Workspace mutation fence owner PID ${owner.pid} is dead or no longer has the supplied process-birth identity.`
    )
    this.name = 'WorkspaceMutationCommitFenceOwnerNotLiveError'
    this.owner = owner
  }
}

export class WorkspaceMutationCommitFenceReleaseError extends Error {
  readonly expected: WorkspaceMutationCommitFenceOwner

  constructor(expected: WorkspaceMutationCommitFenceOwner) {
    super('Workspace mutation commit fence changed before its exact owner could release it.')
    this.name = 'WorkspaceMutationCommitFenceReleaseError'
    this.expected = expected
  }
}

/**
 * Cross-process critical section for the mutation itself.
 *
 * This is deliberately independent from WorkspaceLockAuthority's short WAL
 * transition/generation fence. It stays held while a broker executor awaits,
 * so two cooperating desktop processes cannot concurrently commit mutations
 * even after both have separately acquired durable workspace-lock leases.
 *
 * The first schema is intentionally global within userData. That is stricter
 * than the eventual per-worktree partitioning but never grants unsafe
 * concurrency and makes no claim about provider-native hunk atomicity.
 */
export class WorkspaceMutationCommitFence {
  private readonly fs: WorkspaceMutationCommitFenceFs
  private readonly directory: string
  private readonly observeProcess: WorkspaceMutationCommitFenceOptions['observeProcess']
  private readonly nowIso: () => string
  private readonly nextId: NonNullable<WorkspaceMutationCommitFenceOptions['nextId']>
  private readonly onReclaimGuardAcquired?: WorkspaceMutationCommitFenceOptions['onReclaimGuardAcquired']
  private readonly onStaleReclaimGuardQuarantined?: WorkspaceMutationCommitFenceOptions['onStaleReclaimGuardQuarantined']

  constructor(options: WorkspaceMutationCommitFenceOptions) {
    if (!options.userDataRoot || !options.userDataRoot.trim()) {
      throw new Error('Workspace mutation commit fence requires a userData root.')
    }
    if (typeof options.observeProcess !== 'function') {
      throw new Error('Workspace mutation commit fence requires exact process observation.')
    }
    this.fs = options.fs || (nodeFs as unknown as WorkspaceMutationCommitFenceFs)
    this.directory = join(resolve(options.userDataRoot), WORKSPACE_MUTATION_COMMIT_FENCE_DIRECTORY)
    this.observeProcess = options.observeProcess
    this.nowIso = options.nowIso || (() => new Date().toISOString())
    this.nextId = options.nextId || (() => randomUUID())
    this.onReclaimGuardAcquired = options.onReclaimGuardAcquired
    this.onStaleReclaimGuardQuarantined = options.onStaleReclaimGuardQuarantined
  }

  readFence(): WorkspaceMutationCommitFenceOwner | null {
    this.ensurePrivateDirectory()
    const snapshot = this.readOptionalRegularFile(this.fencePath())
    return snapshot ? parseFence(snapshot.raw, this.fencePath()) : null
  }

  /**
   * Acquires the global mutation fence or rejects with a typed fail-closed
   * error. Busy callers may retry at the broker boundary if their operation is
   * still current; the fence itself never guesses a queue lifetime.
   */
  async acquire(
    owner: WorkspaceMutationCommitFenceIdentity
  ): Promise<WorkspaceMutationCommitFenceOwner> {
    validateIdentity(owner)
    await this.assertProspectiveOwnerIsLive(owner)
    const contender = freezeFence({
      lockOwnerId: owner.lockOwnerId,
      runId: owner.runId,
      pid: owner.pid,
      processBirthIdentity: owner.processBirthIdentity,
      fenceId: this.issueId('fence'),
      acquiredAt: this.issueTimestamp()
    })

    for (;;) {
      if (this.tryCreateFence(contender)) return contender

      const existing = this.readFence()
      // A legitimate owner may have released between O_EXCL and the read.
      if (!existing) continue

      const observation = await this.observeExact(existing.pid)
      if (observation.state === 'identity_unavailable') {
        throw new WorkspaceMutationCommitFenceIdentityUnavailableError(existing.pid, existing)
      }
      if (
        observation.state === 'live' &&
        observation.processBirthIdentity === existing.processBirthIdentity
      ) {
        throw new WorkspaceMutationCommitFenceBusyError(existing)
      }

      const reclaimed = await this.reclaim(existing, contender)
      if (reclaimed) return reclaimed
      // The stale owner released while the reclaim guard was being acquired.
      // Start over with the same unique contender rather than widening scope.
    }
  }

  /**
   * Releases only the exact full record returned by acquire. A foreign owner,
   * a reclaimed fence, or an ABA-delayed release is rejected without mutation.
   */
  release(expected: WorkspaceMutationCommitFenceOwner): boolean {
    validateFence(expected)
    this.ensurePrivateDirectory()
    const current = this.readFence()
    if (!current || !sameFence(current, expected)) return false

    const snapshot = this.readRequiredRegularFile(this.fencePath())
    const rechecked = parseFence(snapshot.raw, this.fencePath())
    if (!sameFence(rechecked, expected)) return false

    this.fs.unlinkSync(this.fencePath())
    this.fsyncDirectory()
    const remaining = this.readOptionalRegularFile(this.fencePath())
    if (remaining) {
      throw new Error('Workspace mutation commit fence release could not be verified.')
    }
    return true
  }

  /**
   * Holds the exact cross-process fence across the complete async executor and
   * releases it in finally. Cleanup failure is never hidden by callback failure.
   */
  async withFence<T>(
    owner: WorkspaceMutationCommitFenceIdentity,
    operation: (fence: WorkspaceMutationCommitFenceOwner) => T | Promise<T>
  ): Promise<T> {
    if (typeof operation !== 'function') {
      throw new Error('Workspace mutation commit fence requires an operation callback.')
    }
    const fence = await this.acquire(owner)
    let operationCompleted = false
    let result: T | undefined
    let operationError: unknown
    let releaseError: unknown
    try {
      result = await operation(fence)
      operationCompleted = true
    } catch (error) {
      operationError = error
    } finally {
      try {
        if (!this.release(fence)) {
          releaseError = new WorkspaceMutationCommitFenceReleaseError(fence)
        }
      } catch (error) {
        releaseError = error
      }
    }

    if (!operationCompleted) {
      if (releaseError !== undefined) {
        throw new AggregateError(
          [operationError, releaseError],
          'Workspace mutation and exact commit-fence release both failed.'
        )
      }
      throw operationError
    }
    if (releaseError !== undefined) throw releaseError
    return result as T
  }

  private async assertProspectiveOwnerIsLive(
    owner: WorkspaceMutationCommitFenceIdentity
  ): Promise<void> {
    const observation = await this.observeExact(owner.pid)
    if (observation.state === 'identity_unavailable') {
      throw new WorkspaceMutationCommitFenceIdentityUnavailableError(owner.pid, null)
    }
    if (
      observation.state === 'dead' ||
      observation.processBirthIdentity !== owner.processBirthIdentity
    ) {
      throw new WorkspaceMutationCommitFenceOwnerNotLiveError(owner)
    }
  }

  private async reclaim(
    expected: WorkspaceMutationCommitFenceOwner,
    contender: WorkspaceMutationCommitFenceOwner
  ): Promise<WorkspaceMutationCommitFenceOwner | null> {
    if (expected.fenceId === contender.fenceId) {
      throw new Error('Workspace mutation replacement fence must have a unique fence id.')
    }
    const guard = await this.acquireReclaimGuard(expected, contender)
    if (!guard) {
      throw new WorkspaceMutationCommitFenceBusyError(this.readFence())
    }

    try {
      await this.onReclaimGuardAcquired?.(guard)

      // A delayed reclaimer must re-read after it owns the O_EXCL guard. This
      // exact comparison is what prevents it from replacing a newer winner.
      const current = this.readFence()
      if (!current) return null
      if (!sameFence(current, expected)) {
        throw new WorkspaceMutationCommitFenceBusyError(current)
      }

      const observation = await this.observeExact(current.pid)
      if (observation.state === 'identity_unavailable') {
        throw new WorkspaceMutationCommitFenceIdentityUnavailableError(current.pid, current)
      }
      if (
        observation.state === 'live' &&
        observation.processBirthIdentity === current.processBirthIdentity
      ) {
        throw new WorkspaceMutationCommitFenceBusyError(current)
      }

      // The exact owner is conclusively dead or PID-reused. Removing it before
      // O_EXCL creation means an ordinary acquirer may win this race, but the
      // reclaimer can never overwrite that live winner.
      const rechecked = this.readFence()
      if (!rechecked || !sameFence(rechecked, expected)) {
        if (!rechecked) return null
        throw new WorkspaceMutationCommitFenceBusyError(rechecked)
      }
      const currentGuard = this.readReclaimGuard()
      if (!currentGuard || !sameGuard(currentGuard, guard)) {
        throw new WorkspaceMutationCommitFenceBusyError(rechecked)
      }
      this.fs.unlinkSync(this.fencePath())
      this.fsyncDirectory()
      if (!this.tryCreateFence(contender)) {
        throw new WorkspaceMutationCommitFenceBusyError(this.readFence())
      }
      return contender
    } finally {
      this.releaseReclaimGuard(guard)
    }
  }

  private tryCreateFence(fence: WorkspaceMutationCommitFenceOwner): boolean {
    this.ensurePrivateDirectory()
    return this.tryWriteNewRegularFile(this.fencePath(), `${JSON.stringify(fence)}\n`)
  }

  private async acquireReclaimGuard(
    expected: WorkspaceMutationCommitFenceOwner,
    contender: WorkspaceMutationCommitFenceOwner
  ): Promise<WorkspaceMutationCommitReclaimGuard | null> {
    const guard: WorkspaceMutationCommitReclaimGuard = Object.freeze({
      guardId: this.issueId('reclaim-guard'),
      expectedFenceId: expected.fenceId,
      contender
    })
    const created = this.tryWriteNewRegularFile(
      this.reclaimGuardPath(),
      `${JSON.stringify(guard)}\n`
    )
    if (created) return guard

    // A crashed reclaimer must not brick mutation commits forever. Reclaim its
    // fully-published guard only after a fresh exact birth observation.
    const existing = this.readReclaimGuard()
    if (!existing) return this.acquireReclaimGuard(expected, contender)
    const observation = await this.observeExact(existing.contender.pid)
    if (observation.state === 'identity_unavailable') {
      throw new WorkspaceMutationCommitFenceIdentityUnavailableError(
        existing.contender.pid,
        this.readFence()
      )
    }
    if (
      observation.state === 'live' &&
      observation.processBirthIdentity === existing.contender.processBirthIdentity
    ) {
      return null
    }
    const recovered = await this.quarantineStaleReclaimGuard(existing)
    if (!recovered) return null
    return this.acquireReclaimGuard(expected, contender)
  }

  private async quarantineStaleReclaimGuard(
    observed: WorkspaceMutationCommitReclaimGuard
  ): Promise<boolean> {
    const quarantinePath = join(this.directory, `.reclaim-guard-quarantine-${randomUUID()}.json`)
    try {
      this.fs.renameSync(this.reclaimGuardPath(), quarantinePath)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false
      throw error
    }
    this.fsyncDirectory()
    try {
      await this.onStaleReclaimGuardQuarantined?.()
      const quarantined = parseReclaimGuard(
        this.readRequiredRegularFile(quarantinePath).raw,
        quarantinePath
      )
      if (sameGuard(quarantined, observed)) return true
      try {
        this.fs.linkSync(quarantinePath, this.reclaimGuardPath())
        this.fsyncDirectory()
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error
      }
      return false
    } finally {
      this.fs.unlinkSync(quarantinePath)
      this.fsyncDirectory()
    }
  }

  private readReclaimGuard(): WorkspaceMutationCommitReclaimGuard | null {
    const snapshot = this.readOptionalRegularFile(this.reclaimGuardPath())
    return snapshot ? parseReclaimGuard(snapshot.raw, this.reclaimGuardPath()) : null
  }

  private releaseReclaimGuard(expected: WorkspaceMutationCommitReclaimGuard): void {
    const current = this.readReclaimGuard()
    if (!current || !sameGuard(current, expected)) return
    this.fs.unlinkSync(this.reclaimGuardPath())
    this.fsyncDirectory()
    if (this.readReclaimGuard()) {
      throw new Error('Workspace mutation reclaim guard release could not be verified.')
    }
  }

  private tryWriteNewRegularFile(path: string, content: string): boolean {
    const temporaryPath = join(this.directory, `.${randomUUID()}.tmp`)
    const flags =
      this.fs.constants.O_WRONLY |
      this.fs.constants.O_CREAT |
      this.fs.constants.O_EXCL |
      (this.fs.constants.O_NOFOLLOW || 0)
    let fd: number | null = null
    let published = false
    let unlinkError: unknown = undefined
    try {
      fd = this.fs.openSync(temporaryPath, flags, PRIVATE_FILE_MODE)
      const opened = this.fs.fstatSync(fd)
      assertRegularFile(opened, temporaryPath)
      if (process.platform !== 'win32' && (Number(opened.mode) & 0o077) !== 0) {
        throw new Error(`Workspace mutation authority file is not private: ${temporaryPath}`)
      }
      writeFully(this.fs, fd, Buffer.from(content, 'utf8'))
      this.fs.fsyncSync(fd)
      this.fs.closeSync(fd)
      fd = null
      try {
        this.fs.linkSync(temporaryPath, path)
        published = true
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error
      }
      this.fs.unlinkSync(temporaryPath)
    } finally {
      if (fd !== null) this.fs.closeSync(fd)
      try {
        this.fs.unlinkSync(temporaryPath)
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) unlinkError = error
      }
    }
    if (unlinkError !== undefined) throw unlinkError
    this.fsyncDirectory()
    if (!published) return false
    const written = this.readRequiredRegularFile(path)
    if (written.raw !== content) {
      throw new Error(`Workspace mutation authority file write could not be verified: ${path}`)
    }
    return true
  }

  private readOptionalRegularFile(path: string): ArtifactSnapshot | null {
    try {
      return this.readRequiredRegularFile(path)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null
      throw error
    }
  }

  private readRequiredRegularFile(path: string): ArtifactSnapshot {
    const before = this.fs.lstatSync(path)
    assertRegularFile(before, path)
    const flags = this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW || 0)
    let fd: number | null = null
    try {
      fd = this.fs.openSync(path, flags)
      const opened = this.fs.fstatSync(fd)
      assertRegularFile(opened, path)
      if (!sameFileIdentity(before, opened)) {
        throw new Error(`Workspace mutation authority file changed while opening: ${path}`)
      }
      const bytes = this.fs.readFileSync(fd)
      const after = this.fs.lstatSync(path)
      if (!sameFileIdentity(opened, after)) {
        throw new Error(`Workspace mutation authority file changed while reading: ${path}`)
      }
      const final = this.fs.fstatSync(fd)
      if (!sameFileIdentity(opened, final) || numericSize(final.size, path) !== bytes.byteLength) {
        throw new Error(`Workspace mutation authority file changed while reading: ${path}`)
      }
      return { bytes, raw: decodeUtf8(bytes, path), stat: final }
    } finally {
      if (fd !== null) this.fs.closeSync(fd)
    }
  }

  private ensurePrivateDirectory(): void {
    const created = this.fs.mkdirSync(this.directory, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE
    })
    const stat = this.fs.lstatSync(this.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        `Workspace mutation commit-fence authority is not a real directory: ${this.directory}`
      )
    }
    this.fs.chmodSync(this.directory, PRIVATE_DIRECTORY_MODE)
    const privateStat = this.fs.lstatSync(this.directory)
    if (
      !privateStat.isDirectory() ||
      privateStat.isSymbolicLink() ||
      (process.platform !== 'win32' && (Number(privateStat.mode) & 0o077) !== 0)
    ) {
      throw new Error(`Workspace mutation commit-fence authority is not private: ${this.directory}`)
    }
    if (created) this.fsyncParentDirectory()
  }

  private fsyncParentDirectory(): void {
    const parent = join(this.directory, '..')
    const flags = this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW || 0)
    let fd: number | null = null
    try {
      fd = this.fs.openSync(parent, flags)
      const stat = this.fs.fstatSync(fd)
      if (!stat.isDirectory()) {
        throw new Error(`Workspace mutation fsync target is not a directory: ${parent}`)
      }
      this.fs.fsyncSync(fd)
    } catch (error) {
      if (!isErrno(error, 'EINVAL') && !isErrno(error, 'EPERM') && !isErrno(error, 'EISDIR')) {
        throw error
      }
    } finally {
      if (fd !== null) this.fs.closeSync(fd)
    }
  }

  private fsyncDirectory(): void {
    const flags = this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW || 0)
    let fd: number | null = null
    try {
      fd = this.fs.openSync(this.directory, flags)
      const stat = this.fs.fstatSync(fd)
      if (!stat.isDirectory()) {
        throw new Error(`Workspace mutation fsync target is not a directory: ${this.directory}`)
      }
      this.fs.fsyncSync(fd)
    } catch (error) {
      // Windows and some network filesystems do not implement directory fsync.
      if (!isErrno(error, 'EINVAL') && !isErrno(error, 'EPERM') && !isErrno(error, 'EISDIR')) {
        throw error
      }
    } finally {
      if (fd !== null) this.fs.closeSync(fd)
    }
  }

  private async observeExact(pid: number): Promise<WorkspaceMutationCommitFenceProcessObservation> {
    const observation = await this.observeProcess(pid)
    if (
      !observation ||
      (observation.state !== 'dead' &&
        observation.state !== 'live' &&
        observation.state !== 'identity_unavailable') ||
      (observation.state === 'live' &&
        !isOpaqueString(observation.processBirthIdentity, 'process birth identity'))
    ) {
      throw new Error('Workspace mutation process observation is invalid.')
    }
    return observation
  }

  private issueId(kind: 'fence' | 'reclaim-guard'): string {
    const id = this.nextId(kind)
    if (!isOpaqueString(id, `${kind} id`)) {
      throw new Error(`Workspace mutation ${kind} id is invalid.`)
    }
    return id
  }

  private issueTimestamp(): string {
    const timestamp = this.nowIso()
    if (typeof timestamp !== 'string' || !timestamp || !Number.isFinite(Date.parse(timestamp))) {
      throw new Error('Workspace mutation fence acquisition timestamp is invalid.')
    }
    return timestamp
  }

  private fencePath(): string {
    return join(this.directory, WORKSPACE_MUTATION_COMMIT_FENCE_FILENAME)
  }

  private reclaimGuardPath(): string {
    return join(this.directory, WORKSPACE_MUTATION_COMMIT_RECLAIM_GUARD_FILENAME)
  }
}

function parseFence(raw: string, path: string): WorkspaceMutationCommitFenceOwner {
  const value = parseJsonRecord(raw, path, 'fence')
  return canonicalizeFenceRecord(value, path)
}

function parseReclaimGuard(raw: string, path: string): WorkspaceMutationCommitReclaimGuard {
  const value = parseJsonRecord(raw, path, 'reclaim guard')
  assertExactKeys(value, ['contender', 'expectedFenceId', 'guardId'])
  if (
    !isOpaqueString(value.guardId, 'reclaim guard id') ||
    !isOpaqueString(value.expectedFenceId, 'expected fence id') ||
    typeof value.contender !== 'object' ||
    value.contender === null ||
    Array.isArray(value.contender)
  ) {
    throw new Error(`Workspace mutation reclaim guard is corrupt: ${path}`)
  }
  const contender = canonicalizeFenceRecord(value.contender as Record<string, unknown>, path)
  return Object.freeze({
    guardId: value.guardId,
    expectedFenceId: value.expectedFenceId,
    contender
  })
}

function canonicalizeFenceRecord(
  value: Record<string, unknown>,
  path: string
): WorkspaceMutationCommitFenceOwner {
  const keys = Object.keys(value).sort()
  const canonical = keysMatch(keys, FENCE_RECORD_KEYS)
  if (!canonical) {
    const hasEveryAuthorityField = FENCE_RECORD_KEYS.every((key) => hasOwn(value, key))
    const hasLegacyPresentation = LEGACY_FENCE_PRESENTATION_KEYS.some((key) => hasOwn(value, key))
    const hasOnlyKnownFields = keys.every((key) => LEGACY_FENCE_RECORD_KEYS.has(key))
    if (!hasEveryAuthorityField || !hasLegacyPresentation || !hasOnlyKnownFields) {
      throw new Error('Workspace mutation authority record has an unexpected schema.')
    }
    validateLegacyFencePresentation(value, path)
  }

  const owner = {
    lockOwnerId: value.lockOwnerId,
    runId: value.runId,
    pid: value.pid,
    processBirthIdentity: value.processBirthIdentity,
    fenceId: value.fenceId,
    acquiredAt: value.acquiredAt
  } as unknown as WorkspaceMutationCommitFenceOwner
  validateFence(owner)
  return freezeFence(owner)
}

function validateLegacyFencePresentation(value: Record<string, unknown>, path: string): void {
  if (
    hasOwn(value, 'lifecycle') &&
    value.lifecycle !== 'run' &&
    value.lifecycle !== 'launching-child' &&
    value.lifecycle !== 'child'
  ) {
    throw new Error(`Workspace mutation legacy fence metadata is corrupt: ${path}`)
  }
  for (const key of ['chatId', 'laneId', 'participantId', 'provider'] as const) {
    if (hasOwn(value, key) && !isWorkspaceLockOpaqueId(value[key])) {
      throw new Error(`Workspace mutation legacy fence metadata is corrupt: ${path}`)
    }
  }
  for (const key of ['chatTitle', 'displayName'] as const) {
    if (hasOwn(value, key) && !isWorkspaceLockOwnerDisplayText(value[key])) {
      throw new Error(`Workspace mutation legacy fence metadata is corrupt: ${path}`)
    }
  }
}

function parseJsonRecord(raw: string, path: string, label: string): Record<string, unknown> {
  if (!raw.endsWith('\n')) {
    throw new Error(`Workspace mutation ${label} is truncated: ${path}`)
  }
  if (raw.slice(0, -1).includes('\n') || raw.includes('\r')) {
    throw new Error(`Workspace mutation ${label} is corrupt: ${path}`)
  }
  let value: unknown
  try {
    value = JSON.parse(raw.slice(0, -1))
  } catch {
    throw new Error(`Workspace mutation ${label} is corrupt: ${path}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Workspace mutation ${label} is corrupt: ${path}`)
  }
  return value as Record<string, unknown>
}

function validateIdentity(value: WorkspaceMutationCommitFenceIdentity): void {
  if (
    !value ||
    !isOpaqueString(value.lockOwnerId, 'lock owner id') ||
    !isOpaqueString(value.runId, 'run id') ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !isOpaqueString(value.processBirthIdentity, 'process birth identity')
  ) {
    throw new Error('Workspace mutation commit-fence owner identity is invalid.')
  }
}

function validateFence(value: WorkspaceMutationCommitFenceOwner): void {
  validateIdentity(value)
  if (
    !isOpaqueString(value.fenceId, 'fence id') ||
    typeof value.acquiredAt !== 'string' ||
    !value.acquiredAt ||
    !Number.isFinite(Date.parse(value.acquiredAt))
  ) {
    throw new Error('Workspace mutation commit-fence owner record is invalid.')
  }
}

function freezeFence(value: WorkspaceMutationCommitFenceOwner): WorkspaceMutationCommitFenceOwner {
  return Object.freeze({ ...value })
}

function sameFence(
  left: WorkspaceMutationCommitFenceOwner,
  right: WorkspaceMutationCommitFenceOwner
): boolean {
  return (
    left.lockOwnerId === right.lockOwnerId &&
    left.runId === right.runId &&
    left.pid === right.pid &&
    left.processBirthIdentity === right.processBirthIdentity &&
    left.fenceId === right.fenceId &&
    left.acquiredAt === right.acquiredAt
  )
}

function sameGuard(
  left: WorkspaceMutationCommitReclaimGuard,
  right: WorkspaceMutationCommitReclaimGuard
): boolean {
  return (
    left.guardId === right.guardId &&
    left.expectedFenceId === right.expectedFenceId &&
    sameFence(left.contender, right.contender)
  )
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value).sort()
  if (!keysMatch(keys, expected)) {
    throw new Error('Workspace mutation authority record has an unexpected schema.')
  }
}

function keysMatch(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isOpaqueString(value: unknown, _label: string): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    value.trim() === value &&
    !value.includes('\0') &&
    !value.includes('\r') &&
    !value.includes('\n')
  )
}

function assertRegularFile(stat: WorkspaceMutationCommitFenceStat, path: string): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Workspace mutation authority artefact is not a regular file: ${path}`)
  }
}

function sameFileIdentity(
  left: WorkspaceMutationCommitFenceStat,
  right: WorkspaceMutationCommitFenceStat
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function numericSize(size: number | bigint, path: string): number {
  const numeric = Number(size)
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`Workspace mutation authority file size is invalid: ${path}`)
  }
  return numeric
}

function decodeUtf8(bytes: Buffer, path: string): string {
  const raw = bytes.toString('utf8')
  if (!Buffer.from(raw, 'utf8').equals(bytes)) {
    throw new Error(`Workspace mutation authority file is not valid UTF-8: ${path}`)
  }
  return raw
}

function writeFully(fs: WorkspaceMutationCommitFenceFs, fd: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.byteLength) {
    const written = fs.writeSync(fd, bytes.subarray(offset))
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error('Workspace mutation authority write made no progress.')
    }
    offset += written
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  )
}
