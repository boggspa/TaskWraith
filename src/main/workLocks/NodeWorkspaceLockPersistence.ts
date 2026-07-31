import { randomUUID } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { join, resolve } from 'node:path'

import type { WorkspaceLockAuthorityFence } from './WorkspaceLockTypes'
import { isRuntimeMarkerName } from './RuntimeMarkerPattern'

/**
 * The authority state is deliberately separate from a checkout. A checkout is
 * agent-controlled input. The supplied root must be one machine-shared,
 * per-user authority boundary across dev, packaged, and profile instances.
 */
export const WORKSPACE_LOCK_AUTHORITY_DIRECTORY = 'work-lock-authority'
export const WORKSPACE_LOCK_EVENTS_FILENAME = 'events.jsonl'
export const WORKSPACE_LOCK_INSTANCE_FENCE_FILENAME = 'instance-fence.json'
export const WORKSPACE_LOCK_RECLAIM_GUARD_FILENAME = 'instance-fence.reclaim-guard.json'

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

export interface NodeWorkspaceLockPersistenceStat {
  readonly dev: number | bigint
  readonly ino: number | bigint
  readonly mode: number | bigint
  readonly size: number | bigint
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

/**
 * Small synchronous filesystem seam. Production uses node:fs; tests and
 * fault-injection callers may provide a deliberately constrained substitute.
 */
export interface NodeWorkspaceLockPersistenceFs {
  readonly constants: {
    readonly O_RDONLY: number
    readonly O_WRONLY: number
    readonly O_APPEND: number
    readonly O_CREAT: number
    readonly O_EXCL: number
    readonly O_NOFOLLOW?: number
  }
  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): unknown
  lstatSync(path: string): NodeWorkspaceLockPersistenceStat
  realpathSync(path: string): string
  openSync(path: string, flags: number, mode?: number): number
  fstatSync(fd: number): NodeWorkspaceLockPersistenceStat
  readFileSync(fd: number): Buffer
  writeSync(fd: number, data: string | Buffer, position?: number): number
  fsyncSync(fd: number): void
  closeSync(fd: number): void
  chmodSync(path: string, mode: number): void
  linkSync(existingPath: string, newPath: string): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
}

export interface NodeWorkspaceLockPersistenceOptions {
  /**
   * Machine-shared per-user authority root supplied by the composition root.
   * A profile-specific Electron userData path is not sufficient.
   */
  userDataRoot: string
  /** Kept injectable so a future product migration can use a sibling store. */
  authorityDirectoryName?: string
  /**
   * The authority owns process-birth observation. Missing/indeterminate
   * liveness is treated as live so a different desktop process is never
   * stolen from on a guess.
   */
  isFenceOwnerLive?: (fence: WorkspaceLockAuthorityFence) => boolean
  /** Test-only deterministic interleaving seam for reclaim-guard races. */
  onReclaimGuardAcquired?: () => void
  /** Test-only seam after a stale guard has been atomically quarantined. */
  onStaleReclaimGuardQuarantined?: () => void | Promise<void>
  fs?: NodeWorkspaceLockPersistenceFs
}

export interface WorkspaceLockEventSnapshot {
  /** Exact UTF-8 WAL bytes, returned as a string after JSONL validation. */
  raw: string
  byteLength: number
}

export type WorkspaceLockFenceMutationResult =
  | { ok: true }
  | { ok: false; existing: WorkspaceLockAuthorityFence | null }

interface ArtifactSnapshot {
  readonly bytes: Buffer
  readonly raw: string
  readonly stat: NodeWorkspaceLockPersistenceStat
}

interface WorkspaceLockReclaimGuard {
  guardId: string
  expectedFenceId: string
  contender: WorkspaceLockAuthorityFence
}

/**
 * Synchronous crash-durable persistence for the work-lock authority.
 *
 * This is intentionally a storage primitive, not a lock policy engine. Its
 * compare-before-mutate operations are exact fencing checks for cooperating
 * writers. Portable Node cannot provide a cross-process CAS rename, so callers
 * must also retain their unique instance fence; every mutation verifies its
 * observed artefacts and fails closed on ambiguity or corruption.
 */
export class NodeWorkspaceLockPersistence {
  private readonly fs: NodeWorkspaceLockPersistenceFs
  private readonly root: string
  private readonly authorityDirectory: string
  private readonly onReclaimGuardAcquired?: () => void
  private readonly onStaleReclaimGuardQuarantined?: () => void | Promise<void>

  constructor(options: NodeWorkspaceLockPersistenceOptions) {
    if (!options.userDataRoot || !options.userDataRoot.trim()) {
      throw new Error('Workspace-lock persistence requires a userData root.')
    }
    const directoryName = options.authorityDirectoryName || WORKSPACE_LOCK_AUTHORITY_DIRECTORY
    if (!isSinglePathSegment(directoryName)) {
      throw new Error('Workspace-lock authority directory name is unsafe.')
    }
    this.fs = options.fs || (nodeFs as unknown as NodeWorkspaceLockPersistenceFs)
    this.root = resolve(options.userDataRoot)
    this.authorityDirectory = join(this.root, directoryName)
    this.onReclaimGuardAcquired = options.onReclaimGuardAcquired
    this.onStaleReclaimGuardQuarantined = options.onStaleReclaimGuardQuarantined
  }

  authorityPath(): string {
    return this.authorityDirectory
  }

  /** Reads and validates every JSONL frame before giving it to the authority. */
  readEvents(): WorkspaceLockEventSnapshot {
    this.ensureAuthorityDirectory()
    const path = this.eventsPath()
    const snapshot = this.readOptionalRegularFile(path, true)
    if (!snapshot) return { raw: '', byteLength: 0 }
    validateJsonLines(snapshot.raw, path)
    return { raw: snapshot.raw, byteLength: snapshot.bytes.byteLength }
  }

  /**
   * Appends exactly one complete JSONL frame if the caller's byte fence still
   * matches. The returned value is the durable byte length after the append.
   */
  appendEvent(serializedLineWithNewline: string, expectedByteLength: number): number {
    validateExpectedByteLength(expectedByteLength)
    validateJsonlFrame(serializedLineWithNewline)
    this.ensureAuthorityDirectory()

    const path = this.eventsPath()
    const before = this.readOptionalRegularFile(path)
    const observedByteLength = before?.bytes.byteLength || 0
    if (observedByteLength !== expectedByteLength) {
      throw new Error(
        `Workspace-lock WAL byte fence changed (expected ${expectedByteLength}, observed ${observedByteLength}).`
      )
    }
    if (before) {
      validateJsonLines(before.raw, path)
      if (!before.raw.endsWith('\n')) {
        throw new Error(`Workspace-lock WAL has an uncommitted torn tail: ${path}`)
      }
    }

    const encoded = Buffer.from(serializedLineWithNewline, 'utf8')
    const flags =
      this.fs.constants.O_WRONLY |
      this.fs.constants.O_APPEND |
      this.fs.constants.O_CREAT |
      (this.fs.constants.O_NOFOLLOW || 0)
    let fd: number | null = null
    try {
      fd = this.fs.openSync(path, flags, PRIVATE_FILE_MODE)
      const opened = this.fs.fstatSync(fd)
      assertRegularFile(opened, path)
      const actualLength = numericSize(opened.size, path)
      if (actualLength !== expectedByteLength) {
        throw new Error(
          `Workspace-lock WAL byte fence changed while opening (expected ${expectedByteLength}, observed ${actualLength}).`
        )
      }
      writeFully(this.fs, fd, encoded)
      this.fs.fsyncSync(fd)
      if (!before) this.fsyncDirectory(this.authorityDirectory)
      return actualLength + encoded.byteLength
    } finally {
      if (fd !== null) this.fs.closeSync(fd)
    }
  }

  /**
   * Re-establishes durability after an append reported an ambiguous failure.
   * Read visibility is insufficient: the exact complete WAL must be reopened
   * and successfully fsynced before an acquisition may be acknowledged.
   */
  confirmEventsDurable(expectedByteLength: number): void {
    validateExpectedByteLength(expectedByteLength)
    this.ensureAuthorityDirectory()
    const path = this.eventsPath()
    const flags = this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW || 0)
    let fd: number | null = null
    try {
      fd = this.fs.openSync(path, flags)
      const opened = this.fs.fstatSync(fd)
      assertRegularFile(opened, path)
      const actualLength = numericSize(opened.size, path)
      if (actualLength !== expectedByteLength) {
        throw new Error(
          `Workspace-lock WAL durability fence changed (expected ${expectedByteLength}, observed ${actualLength}).`
        )
      }
      this.fs.fsyncSync(fd)
    } finally {
      if (fd !== null) this.fs.closeSync(fd)
    }
  }

  /**
   * Removes only an uncommitted, unterminated final WAL fragment. Callers hold
   * the short transition mutex while repairing, then re-read before appending.
   * It deliberately cannot be used to rewrite a complete (or corrupt) frame.
   */
  repairTornEventTail(expectedByteLength: number, completePrefix: string): number {
    validateExpectedByteLength(expectedByteLength)
    if (typeof completePrefix !== 'string' || (completePrefix && !completePrefix.endsWith('\n'))) {
      throw new Error('Workspace-lock WAL repair prefix must be empty or newline-terminated.')
    }
    validateJsonLines(completePrefix, this.eventsPath())
    this.ensureAuthorityDirectory()
    const path = this.eventsPath()
    const current = this.readOptionalRegularFile(path, true)
    const raw = current?.raw || ''
    const actualByteLength = current?.bytes.byteLength || 0
    if (actualByteLength !== expectedByteLength) {
      throw new Error(
        `Workspace-lock WAL byte fence changed (expected ${expectedByteLength}, observed ${actualByteLength}).`
      )
    }
    // Validate every committed frame before comparing the tail. A malformed
    // complete frame is corruption, not a repairable torn tail.
    validateJsonLines(raw, path)
    if (!raw || raw.endsWith('\n')) {
      throw new Error('Workspace-lock WAL has no torn tail to repair.')
    }
    const lastNewline = raw.lastIndexOf('\n')
    const actualPrefix = lastNewline < 0 ? '' : raw.slice(0, lastNewline + 1)
    if (actualPrefix !== completePrefix) {
      throw new Error(
        'Workspace-lock WAL repair prefix does not exactly match the committed frames.'
      )
    }

    this.atomicReplaceRegularFile(path, completePrefix, true, true)
    const repaired = this.readEvents()
    const repairedByteLength = Buffer.byteLength(completePrefix)
    if (repaired.raw !== completePrefix || repaired.byteLength !== repairedByteLength) {
      throw new Error('Workspace-lock WAL torn-tail repair could not be verified.')
    }
    return repairedByteLength
  }

  readInstanceFence(): WorkspaceLockAuthorityFence | null {
    this.ensureAuthorityDirectory()
    const snapshot = this.readOptionalRegularFile(this.fencePath())
    return snapshot ? parseFence(snapshot.raw, this.fencePath()) : null
  }

  /**
   * Acquires the short-lived transition mutex. A live fence is never replaced;
   * a conclusively dead fence is atomically reclaimed with a new fence id.
   */
  acquireInstanceFence(fence: WorkspaceLockAuthorityFence): WorkspaceLockFenceMutationResult {
    validateFence(fence)
    this.ensureAuthorityDirectory()
    const path = this.fencePath()
    const data = `${JSON.stringify(fence)}\n`
    if (!this.atomicCreateRegularFile(path, data)) {
      // Storage never authorizes reclaim from cached or PID-only evidence.
      // The async authority must freshly observe exact process birth, then
      // call replaceInstanceFence with this exact fence id.
      return { ok: false, existing: this.readInstanceFence() }
    }
    return { ok: true }
  }

  /**
   * Replaces a fence only when the live fenceId exactly matches. Reusing a
   * fenceId is refused: it would turn an ABA replacement into a valid release.
   */
  replaceInstanceFence(
    expectedFenceId: string,
    replacement: WorkspaceLockAuthorityFence
  ): WorkspaceLockFenceMutationResult {
    if (!isOpaqueId(expectedFenceId))
      throw new Error('Workspace-lock expected fence id is invalid.')
    validateFence(replacement)
    if (replacement.fenceId === expectedFenceId) {
      throw new Error('Workspace-lock replacement fence must have a new fence id.')
    }
    const guard = this.acquireReclaimGuard(expectedFenceId, replacement)
    if (!guard) return { ok: false, existing: this.readInstanceFence() }
    try {
      this.onReclaimGuardAcquired?.()
      // The guard serializes all cooperative reclaimers. Re-read after it is
      // held so a delayed contender can never overwrite the winner's fence.
      const current = this.readInstanceFence()
      if (!current || current.fenceId !== expectedFenceId) return { ok: false, existing: current }
      const currentGuard = this.readReclaimGuard()
      if (!currentGuard || currentGuard.guardId !== guard.guardId) {
        return { ok: false, existing: current }
      }

      this.atomicReplaceRegularFile(this.fencePath(), `${JSON.stringify(replacement)}\n`)
      const installed = this.readInstanceFence()
      if (!installed || installed.fenceId !== replacement.fenceId) {
        throw new Error('Workspace-lock fence replacement could not be verified.')
      }
      return { ok: true }
    } finally {
      this.releaseReclaimGuard(guard)
    }
  }

  /**
   * Recovers only a crashed reclaim transition, using a caller-supplied fresh
   * exact process-birth decision. Cached PID observations must never be used.
   */
  async recoverStaleReclaimGuard(
    isOwnerConclusiveStale: (owner: WorkspaceLockAuthorityFence) => boolean | Promise<boolean>
  ): Promise<boolean> {
    const observed = this.readReclaimGuard()
    if (!observed) return false
    if (!(await isOwnerConclusiveStale(observed.contender))) return false
    const quarantinePath = join(
      this.authorityDirectory,
      `.reclaim-guard-quarantine-${randomUUID()}.json`
    )
    try {
      this.fs.renameSync(this.reclaimGuardPath(), quarantinePath)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false
      throw error
    }
    this.fsyncDirectory(this.authorityDirectory)
    try {
      await this.onStaleReclaimGuardQuarantined?.()
      const quarantined = parseReclaimGuard(
        this.readRequiredRegularFile(quarantinePath).raw,
        quarantinePath
      )
      if (quarantined.guardId === observed.guardId) return true
      // The observed guard changed before the atomic rename. Restore the
      // quarantined newer inode only if no still-newer contender has already
      // occupied the canonical pathname.
      try {
        this.fs.linkSync(quarantinePath, this.reclaimGuardPath())
        this.fsyncDirectory(this.authorityDirectory)
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error
      }
      return false
    } finally {
      this.fs.unlinkSync(quarantinePath)
      this.fsyncDirectory(this.authorityDirectory)
    }
  }

  /** Removes a fence only for the exact current fence id. */
  releaseInstanceFence(expectedFenceId: string): boolean {
    if (!isOpaqueId(expectedFenceId))
      throw new Error('Workspace-lock expected fence id is invalid.')
    this.ensureAuthorityDirectory()
    const path = this.fencePath()
    const current = this.readInstanceFence()
    if (!current || current.fenceId !== expectedFenceId) return false
    // Re-check the leaf is still a regular artefact immediately before unlink.
    const snapshot = this.readRequiredRegularFile(path)
    const rechecked = parseFence(snapshot.raw, path)
    if (rechecked.fenceId !== expectedFenceId) return false
    this.fs.unlinkSync(path)
    this.fsyncDirectory(this.authorityDirectory)
    if (this.readOptionalRegularFile(path)) {
      throw new Error('Workspace-lock fence release could not be verified.')
    }
    return true
  }

  /** Reads a derived checkout marker without ever trusting its path. */
  readDerivedMarker(canonicalEffectiveWorktreeRoot: string, markerName: string): string | null {
    const path = this.markerPath(canonicalEffectiveWorktreeRoot, markerName)
    if (!path) return null
    const snapshot = this.readOptionalRegularFile(path)
    return snapshot?.raw || null
  }

  /** Same-directory temp + fsync + rename makes a marker replacement atomic. */
  writeDerivedMarker(
    canonicalEffectiveWorktreeRoot: string,
    markerName: string,
    content: string,
    expectedWorktreeObjectIdentity: string
  ): void {
    if (typeof content !== 'string')
      throw new Error('Workspace-lock marker content must be a string.')
    this.atomicReplaceRegularFile(
      this.markerPath(
        canonicalEffectiveWorktreeRoot,
        markerName,
        expectedWorktreeObjectIdentity,
        false
      )!,
      content,
      false
    )
  }

  /** Deletes only a regular marker in its validated authority directory. */
  removeDerivedMarker(
    canonicalEffectiveWorktreeRoot: string,
    markerName: string,
    expectedWorktreeObjectIdentity: string
  ): boolean {
    try {
      const path = this.markerPath(
        canonicalEffectiveWorktreeRoot,
        markerName,
        expectedWorktreeObjectIdentity,
        true
      )
      if (!path) return false
      const current = this.readOptionalRegularFile(path)
      if (!current) return false
      this.fs.unlinkSync(path)
      this.fsyncDirectory(join(path, '..'))
      if (this.readOptionalRegularFile(path)) {
        throw new Error('Workspace-lock marker removal could not be verified.')
      }
      return true
    } catch (error) {
      // Inactive cleanup is complete when the exact leaf or any parent no
      // longer exists. Active writes intentionally retain strict fail-closed
      // root resolution in writeDerivedMarker.
      if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return false
      throw error
    }
  }

  private eventsPath(): string {
    return join(this.authorityDirectory, WORKSPACE_LOCK_EVENTS_FILENAME)
  }

  private fencePath(): string {
    return join(this.authorityDirectory, WORKSPACE_LOCK_INSTANCE_FENCE_FILENAME)
  }

  private reclaimGuardPath(): string {
    return join(this.authorityDirectory, WORKSPACE_LOCK_RECLAIM_GUARD_FILENAME)
  }

  private markerPath(
    canonicalEffectiveWorktreeRoot: string,
    markerName: string,
    expectedWorktreeObjectIdentity?: string,
    replacedRootIsAbsent = false
  ): string | null {
    if (!isRuntimeMarkerName(markerName)) {
      throw new Error('Workspace-lock marker name is not a canonical runtime marker.')
    }
    const inputRoot = resolve(canonicalEffectiveWorktreeRoot)
    let lexicalStat: NodeWorkspaceLockPersistenceStat
    let realRoot: string
    try {
      lexicalStat = this.fs.lstatSync(inputRoot)
      if (!lexicalStat.isDirectory() || lexicalStat.isSymbolicLink()) {
        if (replacedRootIsAbsent) return null
        throw new Error(`Workspace-lock marker root is not a no-follow directory: ${inputRoot}`)
      }
      realRoot = resolve(this.fs.realpathSync(inputRoot))
    } catch (error) {
      if (replacedRootIsAbsent && (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR'))) {
        return null
      }
      throw error
    }
    // Callers canonicalize aliases before persistence. Following a newly
    // introduced root or parent symlink would redirect marker IO.
    if (realRoot !== inputRoot) {
      if (replacedRootIsAbsent) return null
      throw new Error('Workspace-lock marker root no longer resolves to its canonical path.')
    }
    const stat = this.fs.lstatSync(realRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      if (replacedRootIsAbsent) return null
      throw new Error(`Workspace-lock marker root is not a real directory: ${realRoot}`)
    }
    const objectIdentity = `dev:${String(stat.dev)}:ino:${String(stat.ino)}`
    if (expectedWorktreeObjectIdentity && objectIdentity !== expectedWorktreeObjectIdentity) {
      if (replacedRootIsAbsent) return null
      throw new Error('Workspace-lock marker root physical identity changed after acquisition.')
    }
    return join(realRoot, markerName)
  }

  private ensureAuthorityDirectory(): void {
    this.ensurePrivateDirectory(this.authorityDirectory)
  }

  private ensurePrivateDirectory(path: string): void {
    const created = this.fs.mkdirSync(path, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE
    })
    const stat = this.fs.lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Workspace-lock authority artefact is not a real directory: ${path}`)
    }
    this.fs.chmodSync(path, PRIVATE_DIRECTORY_MODE)
    const privateStat = this.fs.lstatSync(path)
    if (
      !privateStat.isDirectory() ||
      privateStat.isSymbolicLink() ||
      (Number(privateStat.mode) & 0o077) !== 0
    ) {
      throw new Error(`Workspace-lock authority directory is not private: ${path}`)
    }
    if (created) this.fsyncDirectory(join(path, '..'))
  }

  /**
   * A replace-after-read is not a CAS. This O_EXCL artefact closes that gap
   * for reclaimers before they perform their mandatory in-guard re-read.
   */
  private acquireReclaimGuard(
    expectedFenceId: string,
    contender: WorkspaceLockAuthorityFence
  ): WorkspaceLockReclaimGuard | null {
    this.ensureAuthorityDirectory()
    const guard: WorkspaceLockReclaimGuard = {
      guardId: randomUUID(),
      expectedFenceId,
      contender
    }
    const path = this.reclaimGuardPath()
    if (!this.atomicCreateRegularFile(path, `${JSON.stringify(guard)}\n`)) {
      // Reading validates the existing guard instead of treating a corrupt
      // authority artefact as a harmless contention response.
      this.readReclaimGuard()
      return null
    }
    return guard
  }

  private readReclaimGuard(): WorkspaceLockReclaimGuard | null {
    const path = this.reclaimGuardPath()
    const snapshot = this.readOptionalRegularFile(path)
    return snapshot ? parseReclaimGuard(snapshot.raw, path) : null
  }

  /** Exact guard-id release prevents a delayed reclaimer deleting a new guard. */
  private releaseReclaimGuard(guard: WorkspaceLockReclaimGuard): void {
    const path = this.reclaimGuardPath()
    const current = this.readReclaimGuard()
    // A stale-guard rescuer may have atomically quarantined this pathname.
    // Never unlink a different/new canonical guard, and let the caller's
    // mandatory pre-commit guard check determine whether it may proceed.
    if (!current || current.guardId !== guard.guardId) return
    this.fs.unlinkSync(path)
    this.fsyncDirectory(this.authorityDirectory)
    if (this.readReclaimGuard()) {
      throw new Error('Workspace-lock reclaim guard release could not be verified.')
    }
  }

  private readOptionalRegularFile(path: string, allowTornUtf8 = false): ArtifactSnapshot | null {
    try {
      return this.readRequiredRegularFile(path, allowTornUtf8)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null
      throw error
    }
  }

  private readRequiredRegularFile(path: string, allowTornUtf8 = false): ArtifactSnapshot {
    const before = this.fs.lstatSync(path)
    assertRegularFile(before, path)
    const flags = this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW || 0)
    let fd: number | null = null
    try {
      fd = this.fs.openSync(path, flags)
      const opened = this.fs.fstatSync(fd)
      assertRegularFile(opened, path)
      if (!sameIdentity(before, opened)) {
        throw new Error(`Workspace-lock authority artefact changed identity while opening: ${path}`)
      }
      const bytes = this.fs.readFileSync(fd)
      const after = this.fs.lstatSync(path)
      if (!sameIdentity(opened, after)) {
        throw new Error(`Workspace-lock authority artefact changed identity while reading: ${path}`)
      }
      const final = this.fs.fstatSync(fd)
      if (numericSize(final.size, path) !== bytes.byteLength) {
        throw new Error(`Workspace-lock authority artefact changed size while reading: ${path}`)
      }
      return {
        bytes,
        raw: allowTornUtf8 ? decodeWalUtf8(bytes, path) : decodeUtf8(bytes, path),
        stat: final
      }
    } finally {
      if (fd !== null) this.fs.closeSync(fd)
    }
  }

  private atomicReplaceRegularFile(
    path: string,
    content: string,
    privateDirectory = true,
    allowTornExisting = false
  ): void {
    const directory = join(path, '..')
    if (privateDirectory) {
      this.ensurePrivateDirectory(directory)
    } else {
      const stat = this.fs.lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Workspace-lock marker parent is not a real directory: ${directory}`)
      }
    }
    // Never silently overwrite a symlink/device/FIFO left in the authority.
    const existing = this.readOptionalRegularFile(path, allowTornExisting)
    void existing
    const temporaryPath = join(directory, `.${randomUUID()}.tmp`)
    const flags =
      this.fs.constants.O_WRONLY |
      this.fs.constants.O_CREAT |
      this.fs.constants.O_EXCL |
      (this.fs.constants.O_NOFOLLOW || 0)
    let fd: number | null = null
    let renamed = false
    try {
      fd = this.fs.openSync(temporaryPath, flags, PRIVATE_FILE_MODE)
      writeFully(this.fs, fd, Buffer.from(content, 'utf8'))
      this.fs.fsyncSync(fd)
      this.fs.closeSync(fd)
      fd = null
      this.fs.renameSync(temporaryPath, path)
      renamed = true
      this.fsyncDirectory(directory)
    } finally {
      if (fd !== null) this.fs.closeSync(fd)
      if (!renamed) this.removeOwnTemporaryFile(temporaryPath)
    }
  }

  /**
   * Publish a fully-written, fsynced inode with one atomic hard-link create.
   * A crash can leave an unreferenced temp inode, never a truncated mutex.
   */
  private atomicCreateRegularFile(path: string, content: string): boolean {
    const directory = join(path, '..')
    this.ensurePrivateDirectory(directory)
    const temporaryPath = join(directory, `.${randomUUID()}.tmp`)
    const flags =
      this.fs.constants.O_WRONLY |
      this.fs.constants.O_CREAT |
      this.fs.constants.O_EXCL |
      (this.fs.constants.O_NOFOLLOW || 0)
    let fd: number | null = null
    let published = false
    try {
      fd = this.fs.openSync(temporaryPath, flags, PRIVATE_FILE_MODE)
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
      this.fsyncDirectory(directory)
      return published
    } finally {
      if (fd !== null) this.fs.closeSync(fd)
      this.removeOwnTemporaryFile(temporaryPath)
    }
  }

  private removeOwnTemporaryFile(path: string): void {
    try {
      const stat = this.fs.lstatSync(path)
      assertRegularFile(stat, path)
      this.fs.unlinkSync(path)
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
  }

  private fsyncDirectory(path: string): void {
    const flags = this.fs.constants.O_RDONLY | (this.fs.constants.O_NOFOLLOW || 0)
    let fd: number | null = null
    try {
      fd = this.fs.openSync(path, flags)
      const stat = this.fs.fstatSync(fd)
      if (!stat.isDirectory())
        throw new Error(`Workspace-lock fsync target is not a directory: ${path}`)
      this.fs.fsyncSync(fd)
    } catch (error) {
      // Windows and a small number of network filesystems do not support a
      // directory fsync. File fsync + post-write verification still holds.
      if (!isErrno(error, 'EINVAL') && !isErrno(error, 'EPERM') && !isErrno(error, 'EISDIR')) {
        throw error
      }
    } finally {
      if (fd !== null) this.fs.closeSync(fd)
    }
  }
}

function validateExpectedByteLength(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Workspace-lock WAL byte fence must be a non-negative safe integer.')
  }
}

function validateJsonlFrame(value: string): void {
  if (!value.endsWith('\n') || value === '\n' || value.includes('\r\n\n')) {
    throw new Error(
      'Workspace-lock WAL append must be exactly one non-empty JSONL line ending in newline.'
    )
  }
  const body = value.slice(0, -1)
  if (!body || body.includes('\n') || body.includes('\r')) {
    throw new Error('Workspace-lock WAL append must not contain multiple lines.')
  }
  try {
    JSON.parse(body)
  } catch {
    throw new Error('Workspace-lock WAL append is not valid JSON.')
  }
}

function validateJsonLines(raw: string, path: string): void {
  if (!raw) return
  // A final un-terminated fragment was never fsynced as a complete JSONL
  // frame. Keep it in `raw` for the replay codec to report/ignore, but never
  // reject the durable complete prefix. Every newline-terminated frame still
  // has to parse; otherwise history is corrupt and recovery must stop.
  const lastNewline = raw.lastIndexOf('\n')
  if (lastNewline < 0) return
  const lines = raw.slice(0, lastNewline).split('\n')
  for (const [index, line] of lines.entries()) {
    if (!line)
      throw new Error(`Workspace-lock WAL contains an empty frame at line ${index + 1}: ${path}`)
    try {
      JSON.parse(line)
    } catch {
      throw new Error(`Workspace-lock WAL is corrupt at line ${index + 1}: ${path}`)
    }
  }
}

function validateFence(value: WorkspaceLockAuthorityFence): void {
  if (
    !value ||
    !isOpaqueId(value.instanceId) ||
    !isOpaqueId(value.fenceId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !isOpaqueId(value.processBirthIdentity) ||
    !isIsoTimestamp(value.acquiredAt)
  ) {
    throw new Error('Workspace-lock authority fence is malformed.')
  }
}

function parseFence(raw: string, path: string): WorkspaceLockAuthorityFence {
  if (!raw.endsWith('\n')) throw new Error(`Workspace-lock authority fence is truncated: ${path}`)
  let value: unknown
  try {
    value = JSON.parse(raw.slice(0, -1))
  } catch {
    throw new Error(`Workspace-lock authority fence is corrupt: ${path}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Workspace-lock authority fence is corrupt: ${path}`)
  }
  validateFence(value as WorkspaceLockAuthorityFence)
  return value as WorkspaceLockAuthorityFence
}

function parseReclaimGuard(raw: string, path: string): WorkspaceLockReclaimGuard {
  if (!raw.endsWith('\n')) throw new Error(`Workspace-lock reclaim guard is truncated: ${path}`)
  let value: unknown
  try {
    value = JSON.parse(raw.slice(0, -1))
  } catch {
    throw new Error(`Workspace-lock reclaim guard is corrupt: ${path}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Workspace-lock reclaim guard is corrupt: ${path}`)
  }
  const candidate = value as Partial<WorkspaceLockReclaimGuard>
  if (
    !isOpaqueId(candidate.guardId) ||
    !isOpaqueId(candidate.expectedFenceId) ||
    !candidate.contender
  ) {
    throw new Error(`Workspace-lock reclaim guard is corrupt: ${path}`)
  }
  validateFence(candidate.contender)
  return candidate as WorkspaceLockReclaimGuard
}

function assertRegularFile(stat: NodeWorkspaceLockPersistenceStat, path: string): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Workspace-lock authority artefact is not a regular file: ${path}`)
  }
}

function sameIdentity(
  left: Pick<NodeWorkspaceLockPersistenceStat, 'dev' | 'ino'>,
  right: Pick<NodeWorkspaceLockPersistenceStat, 'dev' | 'ino'>
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function numericSize(size: number | bigint, path: string): number {
  const result = typeof size === 'bigint' ? Number(size) : size
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`Workspace-lock authority artefact has an unsafe size: ${path}`)
  }
  return result
}

function writeFully(fs: NodeWorkspaceLockPersistenceFs, fd: number, data: Buffer): void {
  let offset = 0
  while (offset < data.byteLength) {
    const written = fs.writeSync(fd, data.subarray(offset))
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error('Workspace-lock authority write did not make progress.')
    }
    offset += written
  }
}

function decodeUtf8(bytes: Buffer, path: string): string {
  const raw = bytes.toString('utf8')
  if (!Buffer.from(raw, 'utf8').equals(bytes)) {
    throw new Error(`Workspace-lock authority artefact is not valid UTF-8: ${path}`)
  }
  return raw
}

function decodeWalUtf8(bytes: Buffer, path: string): string {
  const lastNewline = bytes.lastIndexOf(0x0a)
  if (lastNewline < 0) return bytes.toString('utf8')
  const prefix = bytes.subarray(0, lastNewline + 1)
  const decodedPrefix = decodeUtf8(prefix, path)
  // The final fragment is explicitly uncommitted. It may end halfway through
  // a UTF-8 sequence; decoding it lossily is safe because repair compares and
  // preserves only the byte-exact committed prefix.
  return `${decodedPrefix}${bytes.subarray(lastNewline + 1).toString('utf8')}`
}

function isSinglePathSegment(value: string): boolean {
  return Boolean(value) && value !== '.' && value !== '..' && !/[\\/\u0000]/.test(value)
}

function isOpaqueId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000\r\n]/.test(value)
  )
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
  )
}
