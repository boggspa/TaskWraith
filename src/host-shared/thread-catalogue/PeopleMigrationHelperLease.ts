import * as fs from 'node:fs'
import { dirname, isAbsolute, join, parse } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface PeopleMigrationLease {
  version: 1
  nonce: string
  parentPid: number
  childPid?: number
}
export interface PeopleMigrationLeaseReference {
  path: string
  device: number
  inode: number
  value: PeopleMigrationLease
}

export function peopleMigrationLeasePath(profilePath: string): string {
  if (!isAbsolute(profilePath) || profilePath === parse(profilePath).root)
    throw new Error('Invalid migration profile')
  return join(profilePath, 'thread-history-control-v1', 'people-migration-helper.json')
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(fd)
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !['EINVAL', 'EPERM', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      throw error
  } finally {
    fs.closeSync(fd)
  }
}

export function readPeopleMigrationLease(
  profilePath: string
): PeopleMigrationLeaseReference | null {
  const path = peopleMigrationLeasePath(profilePath)
  try {
    const stat = fs.lstatSync(path)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 4096 ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
    )
      throw new Error('Migration ownership is unreadable')
    const value = JSON.parse(fs.readFileSync(path, 'utf8')) as PeopleMigrationLease
    const after = fs.lstatSync(path)
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.parentPid) ||
      value.parentPid < 2 ||
      typeof value.nonce !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(value.nonce) ||
      (value.childPid !== undefined &&
        (!Number.isSafeInteger(value.childPid) || value.childPid < 2))
    )
      throw new Error('Migration ownership is unreadable')
    return { path, device: stat.dev, inode: stat.ino, value }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function assertPeopleMigrationLease(expected: PeopleMigrationLeaseReference): void {
  const current = readPeopleMigrationLease(dirname(dirname(expected.path)))
  if (
    !current ||
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    JSON.stringify(current.value) !== JSON.stringify(expected.value)
  )
    throw new Error('Migration ownership changed')
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

export function releasePeopleMigrationLease(reference: PeopleMigrationLeaseReference): void {
  assertPeopleMigrationLease(reference)
  fs.unlinkSync(reference.path)
  syncDirectory(dirname(reference.path))
}

/** A live/unknown helper is never stolen merely because a deadline elapsed. */
export async function waitForPeopleMigrationIdle(profilePath: string): Promise<void> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const lease = readPeopleMigrationLease(profilePath)
    if (!lease) return
    if (!alive(lease.value.childPid) && !alive(lease.value.parentPid)) {
      releasePeopleMigrationLease(lease)
      continue
    }
    if (Date.now() >= deadline) throw new Error('Collaboration history still has a migration owner')
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

export async function acquirePeopleMigrationLease(
  profilePath: string
): Promise<PeopleMigrationLeaseReference> {
  await waitForPeopleMigrationIdle(profilePath)
  const path = peopleMigrationLeasePath(profilePath)
  const directory = dirname(path)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Migration ownership directory is unsafe')
  const value: PeopleMigrationLease = { version: 1, parentPid: process.pid, nonce: randomUUID() }
  const fd = fs.openSync(path, 'wx', 0o600)
  const created = fs.fstatSync(fd)
  try {
    try {
      fs.writeFileSync(fd, JSON.stringify(value))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    syncDirectory(directory)
    return readPeopleMigrationLease(profilePath)!
  } catch (error) {
    // No child has been spawned or authorized. Retire only the exact inert
    // file we created, even if its first write/fsync left unreadable bytes.
    try {
      const current = fs.lstatSync(path)
      if (current.dev === created.dev && current.ino === created.ino) {
        fs.unlinkSync(path)
        syncDirectory(directory)
      }
    } catch {
      /* Preserve the initiating failure; no helper can hold this lease. */
    }
    throw error
  }
}

/** The child remains inert until this durable registration and its watchdog are acknowledged. */
export function bindPeopleMigrationChild(
  reference: PeopleMigrationLeaseReference,
  childPid: number
): void {
  assertPeopleMigrationLease(reference)
  if (!Number.isSafeInteger(childPid) || childPid < 2) throw new Error('Invalid migration child')
  const next = { ...reference.value, childPid }
  const temporary = `${reference.path}.${reference.value.nonce}.tmp`
  const fd = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(next))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  assertPeopleMigrationLease(reference)
  fs.renameSync(temporary, reference.path)
  const stat = fs.lstatSync(reference.path)
  Object.assign(reference, { device: stat.dev, inode: stat.ino, value: next })
  syncDirectory(dirname(reference.path))
}

export interface PeopleMigrationDeletionScope {
  operationId: string
  kind: 'chat' | 'workspace' | 'truncate'
  chatIds: readonly string[]
}

export function peopleMigrationDeletionKey(value: unknown): string | null {
  const scope = value as Partial<PeopleMigrationDeletionScope> | null
  if (
    !scope ||
    typeof scope.operationId !== 'string' ||
    !scope.operationId ||
    scope.operationId.length > 128 ||
    !['chat', 'workspace', 'truncate'].includes(scope.kind ?? '') ||
    !Array.isArray(scope.chatIds) ||
    scope.chatIds.some((id) => typeof id !== 'string' || !id)
  )
    return null
  return JSON.stringify([scope.operationId, scope.kind, [...scope.chatIds].sort()])
}

/** Ordinary capture requires no erasure; recovery-only capture binds its exact old intent. */
export function assertNoPeopleMigrationDeletion(
  profilePath: string,
  expected?: PeopleMigrationDeletionScope
): void {
  const file = join(profilePath, 'history-deletion-intent.json')
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && expected === undefined) return
    throw error
  }
  const key = peopleMigrationDeletionKey(expected)
  if (
    key &&
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.size <= 64 * 1024 * 1024 &&
    peopleMigrationDeletionKey(JSON.parse(fs.readFileSync(file, 'utf8'))) === key
  )
    return
  throw new Error('History deletion owns the collaboration source')
}
