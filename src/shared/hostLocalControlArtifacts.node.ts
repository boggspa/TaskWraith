import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import type { Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const HOST_LOCAL_CONTROL_MAX_DISCOVERY_BYTES = 16 * 1024
export const HOST_LOCAL_CONTROL_MAX_TOKEN_BYTES = 4 * 1024

export interface HostLocalControlArtifactOwnership {
  readonly path: string
  readonly device: string
  readonly inode: string
}

export interface HostLocalControlArtifactPublishOptions {
  readonly afterRename?: () => void
  readonly unlink?: (path: string) => void
}

export type HostLocalControlArtifactRemoval =
  | { readonly kind: 'removed' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'replaced' }

function assertPrivateRegular(path: string): Stats {
  const stat = lstatSync(path) as Stats
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Local control artifact is unsafe')
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('Local control artifact is not owner-only')
  }
  return stat
}

function sameIdentity(
  left: { dev: string | number | bigint; ino: string | number | bigint },
  right: { dev: string | number | bigint; ino: string | number | bigint }
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function fsyncParent(path: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(dirname(path), constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Bounded no-follow read with before/open/after stable-inode verification. */
export function readPrivateLocalControlArtifact(path: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('Artifact byte bound is invalid')
  const before = assertPrivateRegular(path)
  if (before.size < 1 || before.size > maxBytes)
    throw new Error('Local control artifact size is invalid')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.size !== before.size) {
      throw new Error('Local control artifact changed while opening')
    }
    const buffer = Buffer.alloc(opened.size)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0)
    if (bytes !== buffer.length) throw new Error('Local control artifact read was incomplete')
    const after = assertPrivateRegular(path)
    if (!sameIdentity(before, after) || after.size !== opened.size) {
      throw new Error('Local control artifact changed while reading')
    }
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Atomic 0600 write: fsync temp, rename, fsync parent, and return exact ownership. */
export function publishPrivateLocalControlArtifact(
  path: string,
  contents: string,
  maxBytes: number,
  options: HostLocalControlArtifactPublishOptions = {}
): HostLocalControlArtifactOwnership {
  if (
    typeof contents !== 'string' ||
    contents.length === 0 ||
    Buffer.byteLength(contents, 'utf8') > maxBytes
  ) {
    throw new Error('Local control artifact exceeds its byte bound')
  }
  if (existsSync(path)) assertPrivateRegular(path)
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let fd: number | null = null
  let renamed = false
  let completed = false
  let temporaryIdentity: { dev: string | number | bigint; ino: string | number | bigint } | null =
    null
  let ownership: HostLocalControlArtifactOwnership | null = null
  let publishFailure: unknown
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600
    )
    fchmodSync(fd, 0o600)
    const body = Buffer.from(contents, 'utf8')
    if (writeSync(fd, body, 0, body.length, 0) !== body.length) {
      throw new Error('Local control artifact write was incomplete')
    }
    fsyncSync(fd)
    temporaryIdentity = fstatSync(fd)
    closeSync(fd)
    fd = null
    renameSync(temporary, path)
    renamed = true
    options.afterRename?.()
    fsyncParent(path)
    const published = assertPrivateRegular(path)
    if (!temporaryIdentity || !sameIdentity(temporaryIdentity, published)) {
      throw new Error('Local control artifact changed during publication')
    }
    completed = true
    ownership = { path, device: String(published.dev), inode: String(published.ino) }
  } catch (error) {
    publishFailure = error
  } finally {
    if (fd !== null) closeSync(fd)
    if (!renamed) {
      try {
        unlinkSync(temporary)
      } catch {
        // Never-authoritative temporary cleanup is best effort.
      }
    } else if (!completed && temporaryIdentity) {
      try {
        const current = lstatSync(path) as Stats
        if (
          current.isFile() &&
          !current.isSymbolicLink() &&
          sameIdentity(temporaryIdentity, current)
        ) {
          ;(options.unlink ?? unlinkSync)(path)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') publishFailure = error
      }
    }
  }
  if (publishFailure) throw publishFailure
  if (!ownership) throw new Error('Local control artifact publication did not complete')
  return ownership
}

/** Removes only the exact regular file atomically published by this owner. */
export function removeOwnedPrivateLocalControlArtifact(
  ownership: HostLocalControlArtifactOwnership | null | undefined,
  unlink: (path: string) => void = unlinkSync
): HostLocalControlArtifactRemoval {
  if (!ownership) return { kind: 'absent' }
  let current: Stats
  try {
    current = lstatSync(ownership.path) as Stats
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    throw error
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    String(current.dev) !== ownership.device ||
    String(current.ino) !== ownership.inode
  ) {
    return { kind: 'replaced' }
  }
  unlink(ownership.path)
  return { kind: 'removed' }
}
