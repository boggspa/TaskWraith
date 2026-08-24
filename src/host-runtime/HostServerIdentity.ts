/** Production stable Host server identity, lease-gated and Node-only. */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  chmodSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, parse, resolve } from 'node:path'

import type { HostSessionHostIdentity } from './HostSession'

export const HOST_SERVER_IDENTITY_FILENAME = 'host-install-identity.json'
export const HOST_SERVER_PRODUCTION_VERSION = 'node-host-v1'
const MAX_BYTES = 4 * 1024
const MODE = 0o600

export interface HostServerIdentityAuthority {
  assertHeld(): void
}

export interface HostServerIdentityOptions {
  readonly profilePath: string
  readonly authority: HostServerIdentityAuthority
  readonly createHostId?: () => string
  readonly now?: () => string
}

function usable(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    // eslint-disable-next-line no-control-regex -- host identity rejects terminal controls.
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function sameFile(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint }
): boolean {
  return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 80) return false
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
}

function readIdentity(path: string): string {
  const before = lstatSync(path)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (process.platform !== 'win32' && (before.mode & 0o077) !== 0)
  )
    throw new Error('Unsafe Host server identity')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const opened = fstatSync(fd)
    if (
      !opened.isFile() ||
      opened.size < 1 ||
      opened.size > MAX_BYTES ||
      !sameFile(opened, before) ||
      (process.platform !== 'win32' && (opened.mode & 0o077) !== 0)
    )
      throw new Error('Unsafe Host server identity')
    const record = JSON.parse(readFileSync(fd, 'utf8')) as Record<string, unknown>
    const after = lstatSync(path)
    if (
      !sameFile(after, before) ||
      after.size !== opened.size ||
      (process.platform !== 'win32' && (after.mode & 0o077) !== 0) ||
      !usable(record.hostId) ||
      record.schemaVersion !== 1 ||
      !canonicalIso(record.createdAt)
    )
      throw new Error('Invalid Host server identity')
    return record.hostId
  } finally {
    closeSync(fd)
  }
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Load/create the shared desktop/TUI host-runtime install id after lease proof. */
export function loadOrCreateHostServerIdentity(
  options: HostServerIdentityOptions
): HostSessionHostIdentity {
  if (!options?.authority || typeof options.authority.assertHeld !== 'function')
    throw new Error('HostServerIdentity requires authority')
  options.authority.assertHeld()
  if (
    !isAbsolute(options.profilePath) ||
    resolve(options.profilePath) === parse(resolve(options.profilePath)).root
  ) {
    throw new Error('HostServerIdentity requires a canonical non-root profile path')
  }
  const profilePath = realpathSync(resolve(options.profilePath))
  if (profilePath !== options.profilePath)
    throw new Error('HostServerIdentity profile path is not canonical')
  const runtimePath = join(profilePath, 'host-runtime')
  try {
    const existing = lstatSync(runtimePath)
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error('Unsafe Host runtime directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mkdirSync(runtimePath, { recursive: false, mode: 0o700 })
  }
  if (process.platform !== 'win32') chmodSync(runtimePath, 0o700)
  const dir = lstatSync(runtimePath)
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error('Unsafe Host runtime directory')
  const path = join(runtimePath, HOST_SERVER_IDENTITY_FILENAME)
  options.authority.assertHeld()
  try {
    return { hostId: readIdentity(path), hostVersion: HOST_SERVER_PRODUCTION_VERSION }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const hostId = options.createHostId?.() ?? randomUUID()
  if (!usable(hostId)) throw new Error('Invalid generated Host server identity')
  const createdAt = options.now?.() ?? new Date().toISOString()
  if (!canonicalIso(createdAt)) throw new Error('Invalid Host server identity timestamp')
  const record = {
    schemaVersion: 1,
    hostId,
    createdAt
  }
  const temp = join(
    runtimePath,
    `.${HOST_SERVER_IDENTITY_FILENAME}.${process.pid}.${randomUUID()}.tmp`
  )
  let fd: number | null = null
  try {
    fd = openSync(temp, 'wx', MODE)
    writeFileSync(fd, `${JSON.stringify(record)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    options.authority.assertHeld()
    linkSync(temp, path)
    const tempStat = lstatSync(temp)
    const published = lstatSync(path)
    if (!sameFile(tempStat, published))
      throw new Error('Host server identity publication changed inode')
    unlinkSync(temp)
    syncDirectory(runtimePath)
    return { hostId: readIdentity(path), hostVersion: HOST_SERVER_PRODUCTION_VERSION }
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      void 0
    }
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      options.authority.assertHeld()
      return { hostId: readIdentity(path), hostVersion: HOST_SERVER_PRODUCTION_VERSION }
    }
    throw error
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
