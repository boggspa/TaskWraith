import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, parse, resolve } from 'node:path'

import type { HostSessionHostIdentity } from './HostSession'

export const HOST_DIAGNOSTIC_IDENTITY_FILENAME = 'taskwraith-diagnostic-install-v1.json'
export const HOST_DIAGNOSTIC_HOST_VERSION = 'diagnostic-node-host-v1'
const IDENTITY_PURPOSE = 'taskwraith:diagnostic-install:v1'
const IDENTITY_SCHEMA_VERSION = 1
const PRIVATE_FILE_MODE = 0o600
const MAX_IDENTITY_BYTES = 1024
const INSTALL_ID_PATTERN = /^[a-f0-9]{48}$/

export interface HostDiagnosticInstallIdentity extends HostSessionHostIdentity {
  readonly installId: string
}

interface HostDiagnosticIdentityRecord {
  readonly schemaVersion: 1
  readonly purpose: typeof IDENTITY_PURPOSE
  readonly installId: string
}

interface FileIdentity {
  readonly dev: string
  readonly ino: string
}

export interface HostDiagnosticIdentityOptions {
  readonly createInstallId?: () => string
  /** Fault-injection seam; the default writes the entire private temp file. */
  readonly writeTemp?: (descriptor: number, bytes: string) => void
  /** Fault-injection seam; the default fsyncs the fully written temp file. */
  readonly syncTemp?: (descriptor: number) => void
  /** Fault-injection seam; the default is atomic hard-link publication. */
  readonly publish?: (tempPath: string, identityPath: string) => void
  /** Fault-injection seam; the default fsyncs the containing profile directory. */
  readonly syncProfile?: (profilePath: string) => void
}

function defaultInstallId(): string {
  return randomBytes(24).toString('hex')
}

function assertCanonicalProfilePath(profilePath: string): string {
  if (typeof profilePath !== 'string' || !isAbsolute(profilePath)) {
    throw new TypeError('Diagnostic Host identity requires an absolute profile path.')
  }
  const canonical = resolve(profilePath)
  if (canonical !== profilePath || canonical === parse(canonical).root) {
    throw new TypeError('Diagnostic Host identity requires a canonical non-root profile path.')
  }
  return canonical
}

function recordToIdentity(record: HostDiagnosticIdentityRecord): HostDiagnosticInstallIdentity {
  return {
    installId: record.installId,
    hostId: `taskwraith-diagnostic-${record.installId}`,
    hostVersion: HOST_DIAGNOSTIC_HOST_VERSION
  }
}

function identityOf(stat: { dev: number | bigint; ino: number | bigint }): FileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

function isFileIdentity(
  value: FileIdentity | { dev: number | bigint; ino: number | bigint }
): value is FileIdentity {
  return typeof value.dev === 'string' && typeof value.ino === 'string'
}

function identitiesMatch(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint } | FileIdentity
): boolean {
  const rightIdentity = isFileIdentity(right) ? right : identityOf(right)
  return String(left.dev) === rightIdentity.dev && String(left.ino) === rightIdentity.ino
}

function assertPrivateRegularFile(
  stat: {
    mode: number | bigint
    isFile(): boolean
    isSymbolicLink(): boolean
  },
  path: string
): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Diagnostic Host identity is not a regular file: ${path}`)
  }
  if (process.platform !== 'win32' && (Number(stat.mode) & 0o077) !== 0) {
    throw new Error(`Diagnostic Host identity is not owner-only: ${path}`)
  }
}

function assertBoundedIdentitySize(size: number | bigint, path: string): number {
  const byteLength = Number(size)
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_IDENTITY_BYTES) {
    throw new Error(`Diagnostic Host identity is oversized: ${path}`)
  }
  return byteLength
}

function parseRecord(raw: string, path: string): HostDiagnosticIdentityRecord {
  if (Buffer.byteLength(raw, 'utf8') > MAX_IDENTITY_BYTES) {
    throw new Error(`Diagnostic Host identity is oversized: ${path}`)
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`Diagnostic Host identity is malformed: ${path}`)
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).schemaVersion !== IDENTITY_SCHEMA_VERSION ||
    (value as Record<string, unknown>).purpose !== IDENTITY_PURPOSE ||
    !INSTALL_ID_PATTERN.test(String((value as Record<string, unknown>).installId || '')) ||
    Object.keys(value as Record<string, unknown>).length !== 3
  ) {
    throw new Error(`Diagnostic Host identity is invalid: ${path}`)
  }
  return value as HostDiagnosticIdentityRecord
}

/** Read only a stable, regular, owner-only identity inode; never follow a symlink. */
function readExistingIdentity(path: string): HostDiagnosticInstallIdentity {
  const before = lstatSync(path)
  assertPrivateRegularFile(before, path)
  const expected = identityOf(before)
  let descriptor: number | null = null
  try {
    descriptor = openSync(path, 'r')
    const opened = fstatSync(descriptor)
    assertPrivateRegularFile(opened, path)
    const openedSize = assertBoundedIdentitySize(opened.size, path)
    if (!identitiesMatch(opened, expected)) {
      throw new Error(`Diagnostic Host identity changed while opening: ${path}`)
    }
    const raw = readFileSync(descriptor, 'utf8')
    const after = lstatSync(path)
    assertPrivateRegularFile(after, path)
    const afterSize = assertBoundedIdentitySize(after.size, path)
    if (!identitiesMatch(after, expected)) {
      throw new Error(`Diagnostic Host identity changed while reading: ${path}`)
    }
    if (afterSize !== openedSize) {
      throw new Error(`Diagnostic Host identity changed size while reading: ${path}`)
    }
    return recordToIdentity(parseRecord(raw, path))
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function defaultPublish(tempPath: string, identityPath: string): void {
  // link(2) atomically creates the destination only when it does not already
  // exist. Unlike rename, it can never replace another process's winner.
  linkSync(tempPath, identityPath)
}

function defaultSyncProfile(profilePath: string): void {
  if (process.platform === 'win32') return
  let descriptor: number | null = null
  try {
    descriptor = openSync(profilePath, 'r')
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function removeExactTemp(tempPath: string, expected: FileIdentity | null): void {
  if (!expected) return
  try {
    const current = lstatSync(tempPath)
    if (!identitiesMatch(current, expected)) return
    unlinkSync(tempPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
  }
}

/**
 * Atomically load or create the profile's opaque diagnostic install identity.
 *
 * Call only after profile authority acquisition. First creation writes and
 * fsyncs an owner-only O_EXCL temp file, verifies that exact inode, hard-links
 * it to the authoritative name without replacement, then fsyncs the profile.
 * A publisher race reads and validates the winner; no partial temp bytes ever
 * become the authoritative identity path.
 */
export function loadOrCreateHostDiagnosticInstallIdentity(
  canonicalProfilePath: string,
  options: HostDiagnosticIdentityOptions = {}
): HostDiagnosticInstallIdentity {
  const profilePath = assertCanonicalProfilePath(canonicalProfilePath)
  const identityPath = join(profilePath, HOST_DIAGNOSTIC_IDENTITY_FILENAME)
  try {
    return readExistingIdentity(identityPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
  }

  const createInstallId = options.createInstallId ?? defaultInstallId
  const installId = createInstallId()
  if (!INSTALL_ID_PATTERN.test(installId)) {
    throw new Error('Diagnostic Host identity factory produced an invalid opaque install id.')
  }
  const record: HostDiagnosticIdentityRecord = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    purpose: IDENTITY_PURPOSE,
    installId
  }
  const tempPath = join(
    profilePath,
    `.${HOST_DIAGNOSTIC_IDENTITY_FILENAME}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`
  )
  const bytes = `${JSON.stringify(record)}\n`
  let descriptor: number | null = null
  let tempIdentity: FileIdentity | null = null
  try {
    descriptor = openSync(tempPath, 'wx', PRIVATE_FILE_MODE)
    const created = fstatSync(descriptor)
    assertPrivateRegularFile(created, tempPath)
    tempIdentity = identityOf(created)
    ;(options.writeTemp ?? ((fd, text) => writeFileSync(fd, text, 'utf8')))(descriptor, bytes)
    const opened = fstatSync(descriptor)
    assertPrivateRegularFile(opened, tempPath)
    if (!identitiesMatch(opened, tempIdentity)) {
      throw new Error(`Diagnostic Host identity temp changed while writing: ${tempPath}`)
    }
    ;(options.syncTemp ?? fsyncSync)(descriptor)
    closeSync(descriptor)
    descriptor = null

    // Re-open by path and compare inode identity before publication. This
    // closes a temp-path substitution race without ever following a symlink.
    readExistingIdentity(tempPath)
    const verifiedTemp = lstatSync(tempPath)
    if (!identitiesMatch(verifiedTemp, tempIdentity)) {
      throw new Error(`Diagnostic Host identity temp changed before publication: ${tempPath}`)
    }

    try {
      ;(options.publish ?? defaultPublish)(tempPath, identityPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST') {
        return readExistingIdentity(identityPath)
      }
      throw error
    }
    ;(options.syncProfile ?? defaultSyncProfile)(profilePath)
    return recordToIdentity(record)
  } finally {
    try {
      if (descriptor !== null) closeSync(descriptor)
    } finally {
      removeExactTemp(tempPath, tempIdentity)
    }
  }
}
