import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  serializeMuseSkillPinSettings,
  type MuseSkillPinSettings,
  buildMuseSkillPinSettings
} from './MuseSkillPin'

export interface MuseIsolatedHomeAuthority {
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

export type MuseIsolatedHomeCleanupResult =
  | Readonly<{ ok: true; alreadyAbsent: boolean }>
  | Readonly<{ ok: false; reason: string }>

/**
 * One collision-resistant, identity-bound Muse HOME+XDG lease.
 *
 * The path itself is route data and belongs only in keyed launch-environment
 * evidence. `authority` is secret-free structural/file-identity evidence that
 * can safely enter a provider launch digest.
 */
export interface MuseIsolatedHomeLease {
  readonly path: string
  readonly homePath: string
  readonly xdgConfigHome: string
  readonly xdgDataHome: string
  readonly xdgCacheHome: string
  readonly xdgStateHome: string
  readonly xdgRuntimeDir: string
  readonly tmpDir: string
  readonly museConfigDir: string
  readonly museDataDir: string
  readonly settingsPath: string
  readonly trustPath: string
  readonly env: Readonly<Record<string, string>>
  readonly authority: MuseIsolatedHomeAuthority
  verify(): MuseIsolatedHomeAuthority
  cleanup(): MuseIsolatedHomeCleanupResult
}

export interface CreateMuseIsolatedHomeInput {
  readonly temporaryRoot: string
  readonly runId: string
  /**
   * Optional process env to scrub into the launch environment. Credential /
   * Muse / foreign-agent keys are never forwarded from this source — only the
   * Cursor-probe allowlist plus relocated HOME/XDG paths and Muse seat flags.
   */
  readonly sourceEnvironment?: NodeJS.ProcessEnv
  /** Override the seeded skill-pin settings body (defaults to full off pin). */
  readonly skillPinSettings?: MuseSkillPinSettings
  /**
   * When true (default), write empty `trust.json` with `projects: {}`.
   * Never copies the user's real trust file.
   */
  readonly seedEmptyTrust?: boolean
}

const issuedMuseIsolatedHomeLeases = new WeakMap<
  MuseIsolatedHomeLease,
  Readonly<{
    path: string
    authority: MuseIsolatedHomeAuthority
    verify: () => MuseIsolatedHomeAuthority
  }>
>()

/** Inherited keys safe for Muse inventory / seat probes (Cursor probe pattern). */
export const MUSE_PROBE_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT'
] as const)

export const MUSE_EMPTY_TRUST_DOCUMENT = Object.freeze({
  schema_version: 1 as const,
  projects: Object.freeze({})
})

/**
 * Create and verify an isolated Muse home before it is exposed to the provider
 * process. Relocates HOME + all XDG_* roots, seeds skill-pin settings and empty
 * trust, and never inherits the user's real `~/.config/muse/trust.json`.
 */
export function createMuseIsolatedHome(input: CreateMuseIsolatedHomeInput): MuseIsolatedHomeLease {
  const temporaryRoot = canonicalRealDirectory(input.temporaryRoot)
  const runId = requireRunId(input.runId)
  const routeTag = createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 16)
  const createdPath = mkdtempSync(join(temporaryRoot, `taskwraith-muse-home-${routeTag}-`))
  let canonicalPath = createdPath
  try {
    canonicalPath = realpathSync(createdPath)
    if (process.platform !== 'win32') chmodSync(canonicalPath, 0o700)

    const homePath = join(canonicalPath, 'home')
    const xdgConfigHome = join(canonicalPath, 'xdg-config')
    const xdgDataHome = join(canonicalPath, 'xdg-data')
    const xdgCacheHome = join(canonicalPath, 'xdg-cache')
    const xdgStateHome = join(canonicalPath, 'xdg-state')
    const xdgRuntimeDir = join(canonicalPath, 'xdg-runtime')
    const tmpDir = join(canonicalPath, 'tmp')
    const museConfigDir = join(xdgConfigHome, 'muse')
    const museDataDir = join(xdgDataHome, 'muse')

    for (const dir of [
      homePath,
      xdgConfigHome,
      xdgDataHome,
      xdgCacheHome,
      xdgStateHome,
      xdgRuntimeDir,
      tmpDir,
      museConfigDir,
      museDataDir
    ]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') chmodSync(dir, 0o700)
    }

    const skillPinSettings = input.skillPinSettings ?? buildMuseSkillPinSettings('off')
    const settingsPath = join(museConfigDir, 'settings.json')
    writeFileSync(settingsPath, serializeMuseSkillPinSettings(skillPinSettings), {
      encoding: 'utf8',
      mode: 0o600
    })

    const trustPath = join(museConfigDir, 'trust.json')
    const seedEmptyTrust = input.seedEmptyTrust !== false
    if (seedEmptyTrust) {
      writeFileSync(trustPath, `${JSON.stringify(MUSE_EMPTY_TRUST_DOCUMENT, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      })
    }

    const env = buildMuseIsolatedHomeEnvironment({
      root: canonicalPath,
      homePath,
      xdgConfigHome,
      xdgDataHome,
      xdgCacheHome,
      xdgStateHome,
      xdgRuntimeDir,
      tmpDir,
      sourceEnvironment: input.sourceEnvironment ?? process.env
    })

    const authority = inspectMuseIsolatedHome(canonicalPath)
    let cleaned = false

    const lease: MuseIsolatedHomeLease = {
      path: canonicalPath,
      homePath,
      xdgConfigHome,
      xdgDataHome,
      xdgCacheHome,
      xdgStateHome,
      xdgRuntimeDir,
      tmpDir,
      museConfigDir,
      museDataDir,
      settingsPath,
      trustPath,
      env,
      authority,
      verify: () => {
        if (cleaned) throw new Error('The Muse isolated-home lease has already been cleaned.')
        const current = inspectMuseIsolatedHome(canonicalPath)
        assertSameAuthority(authority, current)
        return current
      },
      cleanup: () => {
        if (cleaned) return { ok: true, alreadyAbsent: true }
        let current: MuseIsolatedHomeAuthority
        try {
          current = inspectMuseIsolatedHome(canonicalPath)
        } catch (error) {
          if (isMissingPathError(error)) {
            cleaned = true
            return { ok: true, alreadyAbsent: true }
          }
          return {
            ok: false,
            reason: `Muse isolated-home cleanup refused: ${
              error instanceof Error ? error.message : String(error)
            }`
          }
        }
        try {
          assertSameAuthority(authority, current)
        } catch (error) {
          return {
            ok: false,
            reason: `Muse isolated-home cleanup refused: ${
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
            reason: `Muse isolated-home cleanup failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          }
        }
      }
    }
    issuedMuseIsolatedHomeLeases.set(
      lease,
      Object.freeze({ path: canonicalPath, authority, verify: lease.verify })
    )
    return Object.freeze(lease)
  } catch (error) {
    try {
      rmSync(canonicalPath, { recursive: true, force: true })
    } catch {
      /* preserve the original verification error */
    }
    throw error
  }
}

export function verifyMuseIsolatedHome(lease: MuseIsolatedHomeLease): MuseIsolatedHomeAuthority {
  const issued = lease && typeof lease === 'object' ? issuedMuseIsolatedHomeLeases.get(lease) : null
  if (!issued) {
    throw new TypeError('A main-issued Muse isolated-home lease is required.')
  }
  if (lease.path !== issued.path || lease.authority !== issued.authority) {
    throw new Error('Muse isolated-home lease projection was altered.')
  }
  const authority = issued.verify()
  assertSameAuthority(issued.authority, authority)
  return authority
}

export interface BuildMuseIsolatedHomeEnvironmentInput {
  readonly root: string
  readonly homePath: string
  readonly xdgConfigHome: string
  readonly xdgDataHome: string
  readonly xdgCacheHome: string
  readonly xdgStateHome: string
  readonly xdgRuntimeDir: string
  readonly tmpDir: string
  readonly sourceEnvironment?: NodeJS.ProcessEnv
}

/**
 * Scrubbed launch env: allowlisted inherited keys only, relocated HOME + XDG_*,
 * and `MUSE_NO_AUTO_UPDATE=1`. Never forwards `MUSE_AUTH_PATH`, API keys, or
 * Cursor/Codex credential env from the parent process.
 */
export function buildMuseIsolatedHomeEnvironment(
  input: BuildMuseIsolatedHomeEnvironmentInput
): Readonly<Record<string, string>> {
  const root = requireAbsoluteCanonicalPath(input.root, 'Muse isolated-home root')
  for (const [label, value] of [
    ['HOME', input.homePath],
    ['XDG_CONFIG_HOME', input.xdgConfigHome],
    ['XDG_DATA_HOME', input.xdgDataHome],
    ['XDG_CACHE_HOME', input.xdgCacheHome],
    ['XDG_STATE_HOME', input.xdgStateHome],
    ['XDG_RUNTIME_DIR', input.xdgRuntimeDir],
    ['TMPDIR', input.tmpDir]
  ] as const) {
    requirePathWithinRoot(root, value, label)
  }

  const source = input.sourceEnvironment ?? {}
  const env: Record<string, string> = {}
  for (const key of MUSE_PROBE_ENV_ALLOWLIST) {
    const value = source[key]
    if (typeof value === 'string') env[key] = value
  }

  return Object.freeze({
    ...env,
    HOME: input.homePath,
    USERPROFILE: input.homePath,
    TMPDIR: input.tmpDir,
    TMP: input.tmpDir,
    TEMP: input.tmpDir,
    XDG_CONFIG_HOME: input.xdgConfigHome,
    XDG_DATA_HOME: input.xdgDataHome,
    XDG_CACHE_HOME: input.xdgCacheHome,
    XDG_STATE_HOME: input.xdgStateHome,
    XDG_RUNTIME_DIR: input.xdgRuntimeDir,
    APPDATA: join(root, 'appdata'),
    LOCALAPPDATA: join(root, 'local-appdata'),
    MUSE_NO_AUTO_UPDATE: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1'
  })
}

/** True when every Muse-relevant path in `env` is a strict child of `root`. */
export function museLaunchEnvPathsStayInsideLease(
  root: string,
  env: Readonly<Record<string, string | undefined>>
): boolean {
  const keys = [
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'XDG_RUNTIME_DIR',
    'MUSE_AUTH_PATH'
  ] as const
  for (const key of keys) {
    const value = env[key]
    if (typeof value !== 'string' || !value) {
      if (key === 'MUSE_AUTH_PATH') continue
      return false
    }
    if (!pathIsWithin(root, value)) return false
  }
  return true
}

function canonicalRealDirectory(path: string): string {
  if (typeof path !== 'string' || !path) {
    throw new TypeError('Muse temporary root is required.')
  }
  const real = realpathSync(path)
  if (!isAbsolute(real) || resolve(real) !== real) {
    throw new Error('Muse temporary root must resolve to a canonical absolute path.')
  }
  const info = statSync(real)
  if (!info.isDirectory()) throw new Error('Muse temporary root is not a directory.')
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
    throw new TypeError('Muse isolated-home run id is invalid.')
  }
  return value
}

function requireAbsoluteCanonicalPath(path: string, label: string): string {
  if (typeof path !== 'string' || !path || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be a canonical absolute path.`)
  }
  return path
}

function requirePathWithinRoot(root: string, path: string, label: string): void {
  requireAbsoluteCanonicalPath(path, label)
  if (!pathIsWithin(root, path)) {
    throw new Error(`${label} must stay inside the Muse isolated-home lease.`)
  }
}

function pathIsWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function inspectMuseIsolatedHome(path: string): MuseIsolatedHomeAuthority {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) {
    throw new Error('Muse isolated home is not a canonical real path.')
  }
  const info = lstatSync(path, { bigint: true })
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Muse isolated home is not a real directory.')
  }

  let ownerVerification: MuseIsolatedHomeAuthority['ownerVerification']
  let modeVerification: MuseIsolatedHomeAuthority['modeVerification']
  if (process.platform === 'win32') {
    ownerVerification = 'unsupported-platform'
    modeVerification = 'unsupported-platform'
  } else {
    const getuid = process.getuid
    if (typeof getuid !== 'function') {
      throw new Error('Muse isolated-home ownership cannot be verified on this POSIX runtime.')
    }
    if (info.uid !== BigInt(getuid())) {
      throw new Error('Muse isolated home is not owned by the current process user.')
    }
    if ((info.mode & 0o777n) !== 0o700n) {
      throw new Error('Muse isolated home does not have exact owner-only mode 0700.')
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
  expected: MuseIsolatedHomeAuthority,
  current: MuseIsolatedHomeAuthority
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
    throw new Error('Muse isolated-home file identity or verified posture changed.')
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
