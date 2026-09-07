import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { museAuthJsonUsesKeychainStorage, parseMuseAuthJsonCredential } from './MuseProbe'
import { type MuseSkillPinSettings, buildMuseSkillPinSettings } from './MuseSkillPin'
import { mergeMuseMcpSettings, serializeMuseSettings, type MuseMcpSettings } from './MuseMcpConfig'

export interface MuseIsolatedHomeAuthority {
  readonly schemaVersion: 1
  readonly strategy: 'node-mkdtemp-random-suffix-v1' | 'node-durable-seat-verified-v1'
  readonly canonicalRealPathVerified: true
  readonly leafType: 'real-directory'
  readonly fileIdentity: Readonly<{
    readonly device: string
    readonly inode: string
  }>
  readonly fileIdentityVerification: 'device-inode-match' | 'device-inode-best-effort'
  readonly ownerVerification: 'process-uid-match' | 'unsupported-platform'
  readonly modeVerification: 'posix-0700' | 'unsupported-platform'
  readonly cleanupPolicy: 'identity-match-recursive-force' | 'identity-match-scrub-to-continuity'
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
  /** Optional app-owned MCP entries written only into this disposable home. */
  readonly mcpSettings?: MuseMcpSettings
  /**
   * Opt-in Muse log level (e.g., 'debug'). When set, MUSE_LOG is forwarded to the
   * spawned muse serve process to surface internal diagnostics.
   */
  readonly museLogLevel?: string
  /**
   * When true (default), write empty `trust.json` with `projects: {}`.
   * Never copies the user's real trust file.
   */
  readonly seedEmptyTrust?: boolean
  /**
   * Attach a DURABLE per-chat seat home instead of minting a disposable one
   * under `temporaryRoot`.
   *
   * Required by the MSP lane: `session/resume` reads the session log out of
   * `XDG_DATA_HOME/muse/sessions`, so a home destroyed at teardown can never
   * be resumed. The lease keeps every verification the disposable home has —
   * canonical real path, owner, exact 0700, device+inode identity — and adds
   * two the disposable one never needed, because the tree is now reachable by
   * anything running as this user between turns:
   *
   * - the home is REDUCED TO CONTINUITY on attach as well as at teardown, so a
   *   turn never inherits the previous turn's credentials, trust grants, MCP
   *   broker token, temp files or tracing logs; and
   * - every retained entry is re-proven (no symlinks, owner match, no hard
   *   links) before the seat is handed to a provider process.
   *
   * `boundaryRoot` is the shared `muse-seats-v1` directory and is established
   * and verified BEFORE the seat, so a pre-planted symlinked root cannot
   * redirect credentials out of userData. Both must be absolute.
   */
  readonly durableSeat?: Readonly<{ boundaryRoot: string; path: string }>
}

/**
 * The ONLY material a Muse seat home may carry across a turn boundary,
 * expressed as a path from the home root: `xdg-data/muse/{sessions,
 * session-index.db}`.
 *
 * Measured against Muse Code 1.0.3-R2198.1 by resuming from a second host
 * process against a relocated XDG_DATA_HOME: `sessions/` holds the
 * `.msp-view-v1` snapshot+journal set and the dated event tree, and
 * `session-index.db` is what resolves a session id. Everything else Muse
 * writes — `local-tracing/`, `.auth.json.lock`, cron state — is residue.
 *
 * Fail-closed by construction: the scrub retains this list and deletes
 * everything else, so material from a future Muse version is removed rather
 * than silently inherited.
 */
export const MUSE_DURABLE_SEAT_CONTINUITY = Object.freeze({
  /** Home-root child that survives; matches the XDG_DATA_HOME leaf name. */
  dataRoot: 'xdg-data' as const,
  /** Muse's own directory inside XDG_DATA_HOME. */
  providerDir: 'muse' as const,
  entries: Object.freeze(['sessions', 'session-index.db'] as const),
  /**
   * Children `sessions/` may hold: the MSP view store and the dated event
   * tree. Shape-pinned because this is the one directory the provider process
   * writes into freely, so without it `cp auth.json sessions/x.json` is
   * permanent retained storage for anything the model touched.
   */
  sessionChild: /^(?:\.msp-view-v1|\d{4})$/
})

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

const MUSE_AUTH_JSON_MAX_BYTES = 1024 * 1024

/**
 * Create and verify an isolated Muse home before it is exposed to the provider
 * process. Relocates HOME + all XDG_* roots, seeds skill-pin settings and empty
 * trust, and never inherits the user's real `~/.config/muse/trust.json`.
 */
export function createMuseIsolatedHome(input: CreateMuseIsolatedHomeInput): MuseIsolatedHomeLease {
  const durableSeat = input.durableSeat ?? null
  const posture = durableSeat ? MUSE_DURABLE_SEAT_POSTURE : MUSE_TEMPORARY_HOME_POSTURE
  const runId = requireRunId(input.runId)
  let createdPath: string
  if (durableSeat) {
    createdPath = establishMuseDurableSeat(durableSeat.boundaryRoot, durableSeat.path)
  } else {
    const temporaryRoot = canonicalRealDirectory(input.temporaryRoot)
    const routeTag = createHash('sha256').update(runId, 'utf8').digest('hex').slice(0, 16)
    createdPath = mkdtempSync(join(temporaryRoot, `taskwraith-muse-home-${routeTag}-`))
  }
  let canonicalPath = createdPath
  try {
    canonicalPath = realpathSync(createdPath)
    if (process.platform !== 'win32') chmodSync(canonicalPath, 0o700)
    // Reduce a REUSED seat before this turn's material lands. Doing it here
    // rather than only at teardown means a seat left behind by a crashed run
    // is cleaned before it can be handed to a provider process.
    //
    // Fail CLOSED: a seat that cannot be fully reduced is destroyed rather than
    // handed over, even though that costs the transcript. The next attach then
    // starts from an empty seat, so the failure is self-healing rather than
    // permanent — an undeletable entry would otherwise brick the chat.
    if (durableSeat) {
      const attachScrub = scrubMuseDurableSeatHome(canonicalPath, {
        boundaryRoot: durableSeat.boundaryRoot
      })
      if (!attachScrub.ok) {
        // The destroy can fail for the same reason the scrub did (an
        // unreadable directory defeats both). Say which happened: a seat that
        // survived a failed reduction may still hold credential material, and
        // that is a different operational problem from one that was discarded.
        let discarded = true
        try {
          rmSync(canonicalPath, { recursive: true, force: true })
        } catch {
          discarded = false
        }
        throw new Error(
          `The Muse seat could not be reduced to session continuity and was ${
            discarded ? 'discarded' : 'left in place — it may still hold run material'
          }: ${attachScrub.failures.join('; ')}`
        )
      }
    }

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
    // Written WHOLESALE every turn, never merged onto what is already there.
    // `mergeMuseMcpSettings` omits `mcp_servers` when this turn has no MCP
    // grant, so a full rewrite is what deletes a previous turn's block — and
    // that block carries a minted TASKWRAITH_MCP_BROKER_TOKEN.
    const settingsPath = join(museConfigDir, 'settings.json')
    writePrivateFileAtomic(
      settingsPath,
      serializeMuseSettings(mergeMuseMcpSettings(skillPinSettings, input.mcpSettings))
    )

    const trustPath = join(museConfigDir, 'trust.json')
    const seedEmptyTrust = input.seedEmptyTrust !== false
    if (seedEmptyTrust) {
      // Re-seeded every turn: Muse writes project approvals into this file
      // during a turn, and a reused seat must not inherit them.
      writePrivateFileAtomic(trustPath, `${JSON.stringify(MUSE_EMPTY_TRUST_DOCUMENT, null, 2)}\n`)
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
      sourceEnvironment: input.sourceEnvironment ?? process.env,
      museLogLevel: input.museLogLevel
    })

    const authority = inspectMuseIsolatedHome(canonicalPath, posture)
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
        const current = inspectMuseIsolatedHome(canonicalPath, posture)
        assertSameAuthority(authority, current)
        return current
      },
      cleanup: () => {
        if (cleaned) return { ok: true, alreadyAbsent: true }
        let current: MuseIsolatedHomeAuthority
        try {
          current = inspectMuseIsolatedHome(canonicalPath, posture)
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
          if (durableSeat) {
            // A durable seat is REDUCED, never removed — the session log is
            // the whole reason it exists. Verify the reduction actually
            // happened: leaving a credential at rest under userData is worse
            // than losing the ability to resume, so a seat that cannot be
            // reduced is destroyed outright below.
            const scrub = scrubMuseDurableSeatHome(canonicalPath, {
              boundaryRoot: durableSeat.boundaryRoot,
              identity: authority.fileIdentity
            })
            if (!scrub.ok) throw new Error(scrub.failures.join('; '))
            assertMuseDurableSeatReducedToContinuity(canonicalPath)
          } else {
            rmSync(canonicalPath, { recursive: true, force: true })
          }
          cleaned = true
          return { ok: true, alreadyAbsent: false }
        } catch (error) {
          if (durableSeat) {
            try {
              // The identity was last proven before the scrub, and the scrub
              // walks a tree of unbounded size. Re-prove it: `canonicalPath` is
              // a captured string the kernel re-resolves at rmSync time, so a
              // rename landing in that window would redirect the delete.
              assertSameAuthority(authority, inspectMuseIsolatedHome(canonicalPath, posture))
              rmSync(canonicalPath, { recursive: true, force: true })
              cleaned = true
            } catch {
              /* report the original reduction failure */
            }
          }
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
      // A half-built DISPOSABLE home is destroyed. A durable seat is only
      // scrubbed: destroying it here would discard the chat's whole session
      // history over one transient verification failure on turn N.
      //
      // This path reaches the scrub with NOTHING verified — the failure may
      // have come from the verification itself — so the boundary guard is not
      // optional here.
      if (durableSeat) {
        scrubMuseDurableSeatHome(canonicalPath, { boundaryRoot: durableSeat.boundaryRoot })
      } else {
        rmSync(canonicalPath, { recursive: true, force: true })
      }
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

export interface ProjectMuseAuthJsonOptions {
  /** Platform override (tests). Defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
  /**
   * Real user keychain directory to graft for schema-v2 keychain locators
   * (tests). Defaults to `~/Library/Keychains` on macOS.
   */
  readonly realKeychainsDir?: string
}

/**
 * Project a validated Muse-owned credential into an already-issued private
 * lease. This deliberately happens inside the run lifecycle's `try/finally`,
 * so every post-write failure still removes the credential at teardown.
 */
export function projectMuseAuthJson(
  lease: MuseIsolatedHomeLease,
  raw: string,
  options: ProjectMuseAuthJsonOptions = {}
): string {
  verifyMuseIsolatedHome(lease)
  const authJsonText = validateMuseAuthJsonProjection(raw)
  const authPath = join(lease.museConfigDir, 'auth.json')
  // `wx` is deliberate: never write THROUGH an existing path, which could be a
  // symlink someone else planted. Remove first so the projection is also safe
  // to re-run inside one turn; on the durable-seat lane the attach scrub has
  // already taken the whole config tree, so this is defence in depth.
  rmSync(authPath, { force: true })
  writeFileSync(authPath, authJsonText, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  })
  projectMuseKeychainAccessIfRequired(lease, authJsonText, options)
  return authPath
}

/**
 * Muse 1.x (subscription-era) `muse login` stores the Meta OAuth secret in the
 * macOS login keychain and leaves only a non-secret schema-v2 locator in
 * auth.json. The CLI resolves that keychain through `$HOME/Library/Keychains`,
 * so a locator projected into a relocated seat HOME fails with
 * "missing meta credentials" even though auth.json is present (confirmed
 * against Muse Code 1.0.1). Graft keychain access into the disposable home via
 * one symlink; the secret itself is never read or copied by TaskWraith —
 * securityd and the item ACLs still gate the actual unlock — and lease
 * teardown removes only the symlink, never its target.
 */
export function projectMuseKeychainAccessIfRequired(
  lease: MuseIsolatedHomeLease,
  authJsonText: string,
  options: ProjectMuseAuthJsonOptions = {}
): string | null {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') return null
  if (!museAuthJsonUsesKeychainStorage(authJsonText)) return null

  const realKeychainsDir = options.realKeychainsDir ?? join(homedir(), 'Library', 'Keychains')
  try {
    if (!statSync(realKeychainsDir).isDirectory()) return null
  } catch {
    // No user keychain directory — leave the seat untouched and let the CLI
    // report its own credential state.
    return null
  }

  const libraryDir = join(lease.homePath, 'Library')
  mkdirSync(libraryDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(libraryDir, 0o700)
  const linkPath = join(libraryDir, 'Keychains')
  // Re-point rather than trust whatever is already there. An existing link is
  // only kept when it still resolves to the expected keychain directory —
  // anything else is removed, so a graft can never be silently redirected at a
  // keychain the seat was not meant to reach.
  try {
    const existing = lstatSync(linkPath)
    if (existing.isSymbolicLink() && readlinkSync(linkPath) === realKeychainsDir) return linkPath
    rmSync(linkPath, { recursive: true, force: true })
  } catch (error) {
    if (!isMissingPathError(error)) throw error
  }
  symlinkSync(realKeychainsDir, linkPath)
  return linkPath
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
  readonly museLogLevel?: string
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
  if (input.museLogLevel !== undefined) env.MUSE_LOG = input.museLogLevel
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

function validateMuseAuthJsonProjection(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new TypeError('Muse auth.json projection requires a non-empty JSON document.')
  }
  if (Buffer.byteLength(raw, 'utf8') > MUSE_AUTH_JSON_MAX_BYTES) {
    throw new Error('Muse auth.json projection exceeds the 1 MiB safety limit.')
  }

  try {
    JSON.parse(raw)
  } catch {
    throw new Error('Muse auth.json projection is not valid JSON.')
  }

  if (!parseMuseAuthJsonCredential(raw).present) {
    throw new Error('Muse auth.json projection contains no supported Meta credential.')
  }
  return raw
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

type MuseIsolatedHomePosture = Readonly<{
  strategy: MuseIsolatedHomeAuthority['strategy']
  cleanupPolicy: MuseIsolatedHomeAuthority['cleanupPolicy']
}>

const MUSE_TEMPORARY_HOME_POSTURE: MuseIsolatedHomePosture = Object.freeze({
  strategy: 'node-mkdtemp-random-suffix-v1',
  cleanupPolicy: 'identity-match-recursive-force'
})

const MUSE_DURABLE_SEAT_POSTURE: MuseIsolatedHomePosture = Object.freeze({
  strategy: 'node-durable-seat-verified-v1',
  cleanupPolicy: 'identity-match-scrub-to-continuity'
})

/**
 * Write a private file so the 0600 guarantee survives a REUSED home.
 *
 * `writeFileSync`'s `mode` is only honoured at O_CREAT, so writing over an
 * existing file silently keeps whatever mode that file already had. Create a
 * fresh private temp under the same directory, chmod it explicitly, then
 * rename over the target — which also means a crash mid-write can never leave
 * a truncated settings.json for the next turn to parse.
 */
function writePrivateFileAtomic(path: string, body: string): void {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    writeFileSync(temporaryPath, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    if (process.platform !== 'win32') chmodSync(temporaryPath, 0o600)
    renameSync(temporaryPath, path)
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true })
    } catch {
      /* preserve the original write error */
    }
    throw error
  }
}

function assertRealDirectoryLeaf(path: string, label: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`The Muse ${label} is not a real directory.`)
  }
}

function assertPrivateRealDirectory(path: string, label: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`The Muse ${label} is not a real directory.`)
  }
  if (process.platform !== 'win32') {
    const getuid = process.getuid
    if (typeof getuid !== 'function') {
      throw new Error(`Muse ${label} ownership cannot be verified on this POSIX runtime.`)
    }
    if (info.uid !== getuid()) {
      throw new Error(`The Muse ${label} is not owned by the current process user.`)
    }
    if ((info.mode & 0o777) !== 0o700) {
      throw new Error(`The Muse ${label} does not have exact owner-only mode 0700.`)
    }
  }
}

/**
 * Establish the shared seat root and one seat directory inside it, verifying
 * both BEFORE any credential-bearing material is written. mkdir here routinely
 * meets an existing path, so the lstat/realpath checks are load-bearing: a
 * pre-planted symlink at either level must fail closed rather than redirect a
 * projected credential out of userData.
 */
function establishMuseDurableSeat(boundaryRoot: string, seatPath: string): string {
  if (!isAbsolute(boundaryRoot) || !isAbsolute(seatPath)) {
    throw new Error('Muse durable seat paths must be absolute.')
  }
  // Order matters: mkdir succeeds silently on an existing symlink-to-directory
  // and chmod FOLLOWS it, so chmod before the leaf-type check would set an
  // arbitrary directory to 0700 before the guard rejects the path.
  mkdirSync(boundaryRoot, { recursive: true, mode: 0o700 })
  assertRealDirectoryLeaf(boundaryRoot, 'seat root')
  if (process.platform !== 'win32') chmodSync(boundaryRoot, 0o700)
  assertPrivateRealDirectory(boundaryRoot, 'seat root')

  mkdirSync(seatPath, { recursive: true, mode: 0o700 })
  assertRealDirectoryLeaf(seatPath, 'seat home')
  if (process.platform !== 'win32') chmodSync(seatPath, 0o700)
  assertPrivateRealDirectory(seatPath, 'seat home')

  const rootReal = realpathSync(boundaryRoot)
  const seatReal = realpathSync(seatPath)
  if (!pathIsWithin(rootReal, seatReal) || rootReal === seatReal) {
    throw new Error('The Muse durable seat home escaped its private seat root.')
  }
  return seatReal
}

/**
 * Whether a retained entry is safe to hand to the next provider process.
 *
 * A disposable home never needed this — nothing outside the run could reach
 * it. A durable seat sits on disk between turns, so anything that survives is
 * re-proven: no symlink (which could redirect a Muse write anywhere this user
 * can write), owner match, and no hard link into the retained tree from
 * outside it.
 */
function durableContinuityEntryIsSafe(path: string): boolean {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) return false
  const getuid = process.getuid
  if (process.platform !== 'win32') {
    // Fail CLOSED, not open: a POSIX runtime that cannot tell us the owner
    // cannot re-prove retained material either.
    if (typeof getuid !== 'function') return false
    if (info.uid !== getuid()) return false
    // Deliberately NO mode check. Muse chooses the mode of its own session log
    // and index; requiring owner-only here would delete the real log on every
    // attach. Confidentiality comes from the seat root being 0700 — nothing
    // outside this user can traverse in whatever the leaf mode says.
  }
  // `undefined` on platforms that do not report link counts; only a REPORTED
  // count above one is evidence of a link from outside the retained tree.
  if (info.isFile()) return info.nlink === undefined || info.nlink === 1
  if (!info.isDirectory()) return false
  for (const entry of readdirSync(path)) {
    if (!durableContinuityEntryIsSafe(join(path, entry))) return false
  }
  return true
}

/**
 * Reduce a durable seat home to MUSE_DURABLE_SEAT_CONTINUITY.
 *
 * Runs on attach AND at teardown. On attach it is what stops turn N inheriting
 * turn 1's `auth.json`, trust grants, MCP broker token and temp material; at
 * teardown it is what stops that material resting on disk between turns.
 *
 * It RE-PROVES the root before touching anything. `readdirSync` follows a
 * symlink-to-directory and `rmSync(recursive)` deletes THROUGH one, so a scrub
 * that trusted its argument would turn "the sandboxed child swapped its own
 * seat for a link" into a recursive delete of the link's target. The disposable
 * lane cannot do this — there the destructive step is a single `rmSync` on the
 * leaf, which merely unlinks a symlink.
 *
 * Every entry is removed under its own try/catch. A single undeletable entry
 * (an unreadable directory, a `chflags uchg` file, a tree deeper than PATH_MAX)
 * must not abandon the reduction with the rest of the credential material still
 * in place — it reports failure instead, and the caller decides.
 */
export function scrubMuseDurableSeatHome(
  root: string,
  guard: Readonly<{
    boundaryRoot?: string
    identity?: MuseIsolatedHomeAuthority['fileIdentity']
  }> = {}
): { ok: boolean; failures: string[] } {
  const failures: string[] = []
  try {
    // On POSIX the mode check below also rejects a symlink (0777 !== 0700).
    // This is the guard that carries win32, where the whole uid/mode block is
    // skipped and nothing else would notice the leaf type.
    assertRealDirectoryLeaf(root, 'seat home')
    const info = lstatSync(root, { bigint: true })
    if (process.platform !== 'win32') {
      const getuid = process.getuid
      if (typeof getuid !== 'function') throw new Error('owner cannot be verified')
      if (info.uid !== BigInt(getuid())) throw new Error('not owned by this user')
      if ((info.mode & 0o777n) !== 0o700n) throw new Error('not mode 0700')
    }
    if (
      guard.identity &&
      (guard.identity.device !== info.dev.toString(10) ||
        guard.identity.inode !== info.ino.toString(10))
    ) {
      throw new Error('file identity moved')
    }
    if (guard.boundaryRoot) {
      const rootReal = realpathSync(guard.boundaryRoot)
      if (!pathIsWithin(rootReal, realpathSync(root)) || rootReal === realpathSync(root)) {
        throw new Error('escaped its private seat root')
      }
    }
  } catch (error) {
    return {
      ok: false,
      failures: [
        `Muse seat scrub refused: ${error instanceof Error ? error.message : String(error)}`
      ]
    }
  }

  const { dataRoot, providerDir, sessionChild } = MUSE_DURABLE_SEAT_CONTINUITY
  const drop = (path: string): void => {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const listOrDrop = (path: string): string[] | null => {
    try {
      return readdirSync(path)
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      drop(path)
      return null
    }
  }
  const isRealDirectory = (path: string): boolean => {
    try {
      const info = lstatSync(path)
      return info.isDirectory() && !info.isSymbolicLink()
    } catch {
      return false
    }
  }

  const rootEntries = listOrDrop(root)
  if (!rootEntries) return { ok: false, failures }
  for (const child of rootEntries) {
    const childPath = join(root, child)
    if (child !== dataRoot || !isRealDirectory(childPath)) {
      drop(childPath)
      continue
    }
    const dataEntries = listOrDrop(childPath)
    if (!dataEntries) continue
    for (const dataChild of dataEntries) {
      const dataChildPath = join(childPath, dataChild)
      if (dataChild !== providerDir || !isRealDirectory(dataChildPath)) {
        drop(dataChildPath)
        continue
      }
      const providerEntries = listOrDrop(dataChildPath)
      if (!providerEntries) continue
      for (const leaf of providerEntries) {
        const leafPath = join(dataChildPath, leaf)
        if (!durableContinuityLeafIsRetained(leaf, leafPath)) {
          drop(leafPath)
          continue
        }
        // The session log is the one tree the provider writes into freely, so
        // it is shaped as well as type-checked: anything the provider stashed
        // beside the log — a copied credential, a cache — is not a session and
        // is evicted. Unknown children are dropped INDIVIDUALLY so a future
        // Muse layout degrades resume rather than deleting the whole log.
        if (leaf !== 'sessions') continue
        const sessionEntries = listOrDrop(leafPath)
        if (!sessionEntries) continue
        for (const session of sessionEntries) {
          if (sessionChild.test(session)) continue
          drop(join(leafPath, session))
        }
      }
    }
  }
  return { ok: failures.length === 0, failures }
}

/**
 * Whether one child of `XDG_DATA_HOME/muse` is retained.
 *
 * Type-pinned, not just name-pinned: `session-index.db` recreated as a
 * DIRECTORY would otherwise be unbounded permanent storage under a name the
 * allowlist blesses.
 */
function durableContinuityLeafIsRetained(leaf: string, path: string): boolean {
  const { entries } = MUSE_DURABLE_SEAT_CONTINUITY
  if (!(entries as readonly string[]).includes(leaf)) return false
  let info: ReturnType<typeof lstatSync>
  try {
    info = lstatSync(path)
  } catch {
    return false
  }
  if (info.isSymbolicLink()) return false
  if (leaf === 'sessions' ? !info.isDirectory() : !info.isFile()) return false
  return durableContinuityEntryIsSafe(path)
}

/**
 * Throw unless the seat home holds nothing but verified session continuity.
 *
 * Uses the SAME predicates as the scrub, including the leaf-type guards — it is
 * the trigger for destroying a seat that could not be reduced, so a weaker
 * check here would let material the scrub would have dropped survive.
 */
function assertMuseDurableSeatReducedToContinuity(root: string): void {
  const { dataRoot, providerDir, sessionChild } = MUSE_DURABLE_SEAT_CONTINUITY
  const listReal = (path: string, label: string): string[] => {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Muse seat ${label} is not a real directory after cleanup.`)
    }
    return readdirSync(path)
  }
  for (const child of listReal(root, 'home')) {
    if (child !== dataRoot) {
      throw new Error(`Unexpected Muse seat entry survived cleanup: ${child}`)
    }
    for (const dataChild of listReal(join(root, child), dataRoot)) {
      if (dataChild !== providerDir) {
        throw new Error(`Unexpected Muse seat data entry survived cleanup: ${dataChild}`)
      }
      const providerPath = join(root, child, dataChild)
      for (const leaf of listReal(providerPath, providerDir)) {
        if (!durableContinuityLeafIsRetained(leaf, join(providerPath, leaf))) {
          throw new Error(`Unsafe Muse seat continuity entry survived cleanup: ${leaf}`)
        }
        if (leaf !== 'sessions') continue
        for (const session of listReal(join(providerPath, leaf), 'sessions')) {
          if (!sessionChild.test(session)) {
            throw new Error(`Unexpected Muse session entry survived cleanup: ${session}`)
          }
        }
      }
    }
  }
}

function inspectMuseIsolatedHome(
  path: string,
  posture: MuseIsolatedHomePosture = MUSE_TEMPORARY_HOME_POSTURE
): MuseIsolatedHomeAuthority {
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
    strategy: posture.strategy,
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
    cleanupPolicy: posture.cleanupPolicy
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
