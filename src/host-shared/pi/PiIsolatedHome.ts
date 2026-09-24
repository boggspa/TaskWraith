/**
 * MOVED from src/main/pi/PiIsolatedHome.ts (254 lines) — this is now the single
 * definition, shared by the pure-Node Host and Electron main.
 *
 * src/main/pi/PiIsolatedHome.ts is a re-export shim, so its public API is byte-identical
 * and src/main/index.ts needs no change. Node-pure: node: builtins and
 * src/shared/** only.
 */
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

export interface PiIsolatedHomeAuthority {
  readonly schemaVersion: 1
  readonly strategy: 'node-mkdtemp-random-suffix-v1'
  readonly canonicalRealPathVerified: true
  readonly leafType: 'real-directory'
  readonly fileIdentity: Readonly<{
    readonly device: string
    readonly inode: string
  }>
  readonly fileIdentityVerification: 'device-inode-match' | 'device-inode-best-effort'
  readonly ownerVerification: 'process-uid-match' | 'unsupported-platform'
  readonly modeVerification: 'posix-0700' | 'unsupported-platform'
  readonly cleanupPolicy: 'identity-match-recursive-force'
}

export type PiIsolatedHomeCleanupResult =
  | Readonly<{ ok: true; alreadyAbsent: boolean }>
  | Readonly<{ ok: false; reason: string }>

/**
 * One collision-resistant, identity-bound Pi home.
 *
 * The path itself is route data and belongs only in keyed launch-environment
 * evidence. `authority` is secret-free structural/file-identity evidence that
 * can safely enter the provider launch digest.
 */
export interface PiIsolatedHomeLease {
  readonly path: string
  readonly authority: PiIsolatedHomeAuthority
  verify(): PiIsolatedHomeAuthority
  cleanup(): PiIsolatedHomeCleanupResult
}

export interface CreatePiIsolatedHomeInput {
  readonly temporaryRoot: string
  readonly runId: string
}

const issuedPiIsolatedHomeLeases = new WeakMap<
  PiIsolatedHomeLease,
  Readonly<{
    path: string
    authority: PiIsolatedHomeAuthority
    verify: () => PiIsolatedHomeAuthority
  }>
>()

/**
 * Create and verify the isolated PI_CODING_AGENT_DIR before it is exposed to
 * the provider process.
 *
 * `mkdtemp` supplies the collision-resistant suffix. The run id contributes
 * only a short SHA-256 tag, so path separators/control characters from a route
 * can never alter the target. POSIX platforms chmod then verify exact 0700 and
 * process UID ownership; Windows records those checks as unsupported instead
 * of pretending its mode bits mean the same thing.
 */
export function createPiIsolatedHome(input: CreatePiIsolatedHomeInput): PiIsolatedHomeLease {
  const temporaryRoot = canonicalRealDirectory(input.temporaryRoot)
  const runId = requireRunId(input.runId)
  const routeTag = createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 16)
  const createdPath = mkdtempSync(join(temporaryRoot, `taskwraith-pi-home-${routeTag}-`))
  let canonicalPath = createdPath
  try {
    canonicalPath = realpathSync(createdPath)
    if (process.platform !== 'win32') chmodSync(canonicalPath, 0o700)
    const authority = inspectPiIsolatedHome(canonicalPath)
    let cleaned = false

    const lease: PiIsolatedHomeLease = {
      path: canonicalPath,
      authority,
      verify: () => {
        if (cleaned) throw new Error('The Pi isolated-home lease has already been cleaned.')
        const current = inspectPiIsolatedHome(canonicalPath)
        assertSameAuthority(authority, current)
        return current
      },
      cleanup: () => {
        if (cleaned) return { ok: true, alreadyAbsent: true }
        let current: PiIsolatedHomeAuthority
        try {
          current = inspectPiIsolatedHome(canonicalPath)
        } catch (error) {
          if (isMissingPathError(error)) {
            cleaned = true
            return { ok: true, alreadyAbsent: true }
          }
          return {
            ok: false,
            reason: `Pi isolated-home cleanup refused: ${
              error instanceof Error ? error.message : String(error)
            }`
          }
        }
        try {
          assertSameAuthority(authority, current)
        } catch (error) {
          return {
            ok: false,
            reason: `Pi isolated-home cleanup refused: ${
              error instanceof Error ? error.message : String(error)
            }`
          }
        }
        try {
          rmSync(canonicalPath, { recursive: true, force: true })
          cleaned = true
          return { ok: true, alreadyAbsent: false }
        } catch (error) {
          return {
            ok: false,
            reason: `Pi isolated-home cleanup failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          }
        }
      }
    }
    issuedPiIsolatedHomeLeases.set(
      lease,
      Object.freeze({ path: canonicalPath, authority, verify: lease.verify })
    )
    return Object.freeze(lease)
  } catch (error) {
    // This path was returned by our successful mkdtemp call and has not been
    // exposed to another subsystem yet. Best-effort rollback is narrower than
    // the identity-checked public cleanup path.
    try {
      rmSync(canonicalPath, { recursive: true, force: true })
    } catch {
      /* preserve the original verification error */
    }
    throw error
  }
}

export function verifyPiIsolatedHome(lease: PiIsolatedHomeLease): PiIsolatedHomeAuthority {
  const issued = lease && typeof lease === 'object' ? issuedPiIsolatedHomeLeases.get(lease) : null
  if (!issued) {
    throw new TypeError('A main-issued Pi isolated-home lease is required.')
  }
  if (lease.path !== issued.path || lease.authority !== issued.authority) {
    throw new Error('Pi isolated-home lease projection was altered.')
  }
  const authority = issued.verify()
  assertSameAuthority(issued.authority, authority)
  return authority
}

function canonicalRealDirectory(path: string): string {
  if (typeof path !== 'string' || !path) {
    throw new TypeError('Pi temporary root is required.')
  }
  const real = realpathSync(path)
  if (!isAbsolute(real) || resolve(real) !== real) {
    throw new Error('Pi temporary root must resolve to a canonical absolute path.')
  }
  const info = statSync(real)
  if (!info.isDirectory()) throw new Error('Pi temporary root is not a directory.')
  return real
}

function requireRunId(value: string): string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    !value ||
    value.length > 4_096 ||
    value.includes('\0')
  ) {
    throw new TypeError('Pi isolated-home run id is invalid.')
  }
  return value
}

function inspectPiIsolatedHome(path: string): PiIsolatedHomeAuthority {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error('Pi isolated home is not a canonical real path.')
  }
  const info = lstatSync(path, { bigint: true })
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Pi isolated home is not a real directory.')
  }

  let ownerVerification: PiIsolatedHomeAuthority['ownerVerification']
  let modeVerification: PiIsolatedHomeAuthority['modeVerification']
  if (process.platform === 'win32') {
    ownerVerification = 'unsupported-platform'
    modeVerification = 'unsupported-platform'
  } else {
    const getuid = process.getuid
    if (typeof getuid !== 'function') {
      throw new Error('Pi isolated-home ownership cannot be verified on this POSIX runtime.')
    }
    if (info.uid !== BigInt(getuid())) {
      throw new Error('Pi isolated home is not owned by the current process user.')
    }
    if ((info.mode & 0o777n) !== 0o700n) {
      throw new Error('Pi isolated home does not have exact owner-only mode 0700.')
    }
    ownerVerification = 'process-uid-match'
    modeVerification = 'posix-0700'
  }

  return Object.freeze({
    schemaVersion: 1,
    strategy: 'node-mkdtemp-random-suffix-v1',
    canonicalRealPathVerified: true,
    leafType: 'real-directory',
    fileIdentity: Object.freeze({
      device: info.dev.toString(10),
      inode: info.ino.toString(10)
    }),
    ownerVerification,
    modeVerification,
    fileIdentityVerification:
      process.platform === 'win32' ? 'device-inode-best-effort' : 'device-inode-match',
    cleanupPolicy: 'identity-match-recursive-force'
  })
}

function assertSameAuthority(
  expected: PiIsolatedHomeAuthority,
  current: PiIsolatedHomeAuthority
): void {
  if (
    expected.schemaVersion !== current.schemaVersion ||
    expected.strategy !== current.strategy ||
    expected.canonicalRealPathVerified !== current.canonicalRealPathVerified ||
    expected.leafType !== current.leafType ||
    expected.fileIdentity.device !== current.fileIdentity.device ||
    expected.fileIdentity.inode !== current.fileIdentity.inode ||
    expected.fileIdentityVerification !== current.fileIdentityVerification ||
    expected.ownerVerification !== current.ownerVerification ||
    expected.modeVerification !== current.modeVerification ||
    expected.cleanupPolicy !== current.cleanupPolicy
  ) {
    throw new Error('Pi isolated-home file identity or verified posture changed.')
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
