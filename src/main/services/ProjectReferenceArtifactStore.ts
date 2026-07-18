import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { ExternalPathGrant, RunEventArtifactRef } from '../store/types'
import {
  openAuthorizedWorkspaceFile,
  readOpenedWorkspaceFile,
  type WorkspaceFileOpenReason
} from './TranscriptMediaService'

/**
 * A context attachment is deliberately much smaller than a general media
 * asset. It is copied once from an already-authorized descriptor into a
 * private, main-owned store, then the run ledger refers only to this snapshot.
 */
export const PROJECT_REFERENCE_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024
export const PROJECT_REFERENCE_SNAPSHOT_FILE_EXTENSION = '.snapshot'

export interface SnapshotProjectReferenceFileInput {
  /**
   * A dedicated, main-owned directory (normally below Electron userData), not
   * a workspace or an external-grant root. The store creates it with 0700 when
   * absent and refuses an unsafe existing directory.
   */
  snapshotDirectory: string
  /** A local path only. URL/folder references intentionally have no byte snapshot. */
  candidatePath: string
  workspacePath?: string
  /** Existing, signed access only. A project reference never creates a grant. */
  externalPathGrants?: readonly ExternalPathGrant[]
}

export type ProjectReferenceSnapshotReason =
  | WorkspaceFileOpenReason
  | 'unsafe_snapshot_directory'
  | 'content_address_collision'
  | 'write_failed'

export type ProjectReferenceSnapshotResult =
  | { ok: true; artifact: RunEventArtifactRef }
  | { ok: false; reason: ProjectReferenceSnapshotReason }

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  if (left.ino !== right.ino) return false
  // libuv can report dev differently for handle- and path-derived stats on
  // Windows. The NTFS file index remains the identity authority there.
  return process.platform === 'win32' || left.dev === right.dev
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
  const relative = path.relative(root, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * A directory owned by this OS user is not necessarily main-owned: agents can
 * write their workspace and any explicitly granted external directory under
 * that same identity. Never place a durable audit snapshot inside either.
 */
function snapshotDirectoryIsAgentReachable(
  snapshotDirectory: string,
  workspacePath: string | undefined,
  externalPathGrants: readonly ExternalPathGrant[]
): boolean {
  if (workspacePath) {
    try {
      const workspace = fs.realpathSync.native(workspacePath)
      if (pathWithinRoot(snapshotDirectory, workspace)) return true
    } catch {
      // A missing workspace cannot author a snapshot directory. Source
      // authorization later fails independently if it is needed.
    }
  }

  return externalPathGrants.some((grant) => {
    if (grant.kind !== 'directory' || !path.isAbsolute(grant.path)) return false
    try {
      const grantLstat = fs.lstatSync(grant.path)
      if (grantLstat.isSymbolicLink() || !grantLstat.isDirectory()) return false
      return pathWithinRoot(snapshotDirectory, fs.realpathSync.native(grant.path))
    } catch {
      return false
    }
  })
}

/**
 * Returns a canonical private directory, never the caller's possibly symlinked
 * spelling. The returned path is the only base used when publishing assets.
 */
function prepareMainOwnedSnapshotDirectory(directory: string): string | null {
  if (!path.isAbsolute(directory) || directory.includes('\0')) return null
  const requested = path.resolve(directory)
  try {
    fs.mkdirSync(requested, { recursive: true, mode: 0o700 })
    const requestedLstat = fs.lstatSync(requested)
    if (requestedLstat.isSymbolicLink() || !requestedLstat.isDirectory()) return null

    const canonical = fs.realpathSync.native(requested)
    const canonicalLstat = fs.lstatSync(canonical)
    const canonicalStat = fs.statSync(canonical)
    if (
      canonicalLstat.isSymbolicLink() ||
      !canonicalLstat.isDirectory() ||
      !canonicalStat.isDirectory() ||
      !sameFileIdentity(canonicalLstat, canonicalStat)
    ) {
      return null
    }

    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    if (uid !== null && canonicalStat.uid !== uid) return null
    // Windows ACLs, rather than POSIX mode bits, govern directory writability.
    if (process.platform !== 'win32' && (canonicalStat.mode & 0o022) !== 0) return null
    return canonical
  } catch {
    return null
  }
}

function snapshotTargetPath(snapshotDirectory: string, sha256: string): string {
  return path.join(snapshotDirectory, `${sha256}${PROJECT_REFERENCE_SNAPSHOT_FILE_EXTENSION}`)
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

/**
 * Check an already-published content address through a nofollow descriptor.
 * The second lstat and hash prove that a concurrent store writer cannot make us
 * adopt a partial or colliding target.
 */
function storedSnapshotMatches(target: string, sha256: string, byteLength: number): boolean {
  let fd: number | null = null
  try {
    const before = fs.lstatSync(target)
    if (before.isSymbolicLink() || !before.isFile() || before.size !== byteLength) return false
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || !sameFileIdentity(opened, before) || opened.size !== byteLength) {
      return false
    }
    const buffer = readExactDescriptor(fd, byteLength)
    const after = fs.fstatSync(fd)
    const targetAfter = fs.lstatSync(target)
    return (
      !!buffer &&
      createHash('sha256').update(buffer).digest('hex') === sha256 &&
      sameFileSnapshotVersion(after, opened) &&
      !targetAfter.isSymbolicLink() &&
      targetAfter.isFile() &&
      sameFileIdentity(targetAfter, opened) &&
      targetAfter.size === byteLength
    )
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Best-effort close on a rejected descriptor.
      }
    }
  }
}

function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0
  while (offset < buffer.length) {
    const bytesWritten = fs.writeSync(fd, buffer, offset, buffer.length - offset, offset)
    if (bytesWritten <= 0) throw new Error('short_write')
    offset += bytesWritten
  }
}

function fsyncDirectoryBestEffort(directory: string): void {
  let fd: number | null = null
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY)
    fs.fsyncSync(fd)
  } catch {
    // Some platforms/filesystems do not permit directory fsync. The complete
    // hard-link publication remains atomic even where durability is best-effort.
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // Best-effort close.
      }
    }
  }
}

function unlinkIfSameFile(filePath: string, expected: fs.Stats | null): void {
  if (!expected) return
  try {
    const current = fs.lstatSync(filePath)
    if (!current.isSymbolicLink() && current.isFile() && sameFileIdentity(current, expected)) {
      fs.unlinkSync(filePath)
    }
  } catch {
    // Never follow or remove an attacker-swapped cleanup target.
  }
}

/**
 * Atomically publish bytes under their SHA-256 address. A complete private temp
 * inode is hard-linked into its final name; a concurrent winner is adopted only
 * after a nofollow byte-for-byte hash verification.
 */
function persistSnapshot(
  snapshotDirectory: string,
  buffer: Buffer,
  sha256: string
):
  | { ok: true; path: string }
  | { ok: false; reason: 'content_address_collision' | 'write_failed' } {
  const target = snapshotTargetPath(snapshotDirectory, sha256)
  const tempPath = path.join(
    snapshotDirectory,
    `.project-reference-${process.pid}-${randomUUID()}.tmp`
  )
  let tempFd: number | null = null
  let tempStat: fs.Stats | null = null

  try {
    tempFd = fs.openSync(
      tempPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    )
    fs.fchmodSync(tempFd, 0o600)
    tempStat = fs.fstatSync(tempFd)
    if (!tempStat.isFile()) throw new Error('unsafe_temp')
    writeAll(tempFd, buffer)
    fs.fsyncSync(tempFd)

    const finalTempStat = fs.fstatSync(tempFd)
    const tempPathStat = fs.lstatSync(tempPath)
    if (
      !finalTempStat.isFile() ||
      tempPathStat.isSymbolicLink() ||
      !tempPathStat.isFile() ||
      finalTempStat.size !== buffer.length ||
      !sameFileIdentity(finalTempStat, tempStat) ||
      !sameFileIdentity(tempPathStat, tempStat)
    ) {
      throw new Error('unsafe_temp')
    }
    tempStat = finalTempStat

    fs.closeSync(tempFd)
    tempFd = null

    try {
      fs.linkSync(tempPath, target)
      const published = fs.lstatSync(target)
      if (
        published.isSymbolicLink() ||
        !published.isFile() ||
        published.size !== buffer.length ||
        !sameFileIdentity(published, tempStat)
      ) {
        return { ok: false, reason: 'write_failed' }
      }
      fsyncDirectoryBestEffort(snapshotDirectory)
      return { ok: true, path: target }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        return { ok: false, reason: 'write_failed' }
      }
      return storedSnapshotMatches(target, sha256, buffer.length)
        ? { ok: true, path: target }
        : { ok: false, reason: 'content_address_collision' }
    }
  } catch {
    return { ok: false, reason: 'write_failed' }
  } finally {
    if (tempFd !== null) {
      try {
        fs.closeSync(tempFd)
      } catch {
        // Best-effort close.
      }
    }
    unlinkIfSameFile(tempPath, tempStat)
  }
}

/**
 * Snapshot one explicit project-reference file. This is deliberately not a
 * catalogue operation: callers must first resolve the project and its selected
 * reference on the main side, and must pass only already-issued access grants.
 *
 * The result contains no source locator. Its `artifact.path` is the private,
 * content-addressed snapshot path suitable for a durable run-event ledger.
 */
export function snapshotProjectReferenceFile(
  input: SnapshotProjectReferenceFileInput
): ProjectReferenceSnapshotResult {
  const snapshotDirectory = prepareMainOwnedSnapshotDirectory(input.snapshotDirectory)
  if (
    !snapshotDirectory ||
    snapshotDirectoryIsAgentReachable(
      snapshotDirectory,
      input.workspacePath,
      input.externalPathGrants || []
    )
  ) {
    return { ok: false, reason: 'unsafe_snapshot_directory' }
  }

  const opened = openAuthorizedWorkspaceFile({
    workspacePath: input.workspacePath,
    candidatePath: input.candidatePath,
    externalPathGrants: input.externalPathGrants || [],
    maxBytes: PROJECT_REFERENCE_SNAPSHOT_MAX_BYTES
  })
  if (!opened.ok) return opened

  let buffer: Buffer | null = null
  try {
    buffer = readOpenedWorkspaceFile(opened)
  } finally {
    try {
      fs.closeSync(opened.fd)
    } catch {
      // A failed close cannot make the descriptor bytes unsafe; fail closed on
      // future operations by returning no artifact if the read itself failed.
    }
  }
  if (!buffer) return { ok: false, reason: 'missing' }

  const sha256 = createHash('sha256').update(buffer).digest('hex')
  const persisted = persistSnapshot(snapshotDirectory, buffer, sha256)
  if (!persisted.ok) return persisted

  return {
    ok: true,
    artifact: {
      id: `project-reference:${sha256}`,
      kind: 'snapshot',
      path: persisted.path,
      sha256,
      sizeBytes: buffer.length,
      metadata: {
        source: 'project_reference_context',
        storage: 'main_owned_snapshot'
      }
    }
  }
}

/**
 * Convenience wrapper for application wiring that owns one snapshot directory
 * for the process lifetime.
 */
export class ProjectReferenceArtifactStore {
  constructor(private readonly snapshotDirectory: string) {}

  snapshot(
    input: Omit<SnapshotProjectReferenceFileInput, 'snapshotDirectory'>
  ): ProjectReferenceSnapshotResult {
    return snapshotProjectReferenceFile({ ...input, snapshotDirectory: this.snapshotDirectory })
  }
}
