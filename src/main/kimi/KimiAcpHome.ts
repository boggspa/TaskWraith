// Isolated KIMI_CODE_HOME builder. Relocates Kimi Code's entire data root to a
// TaskWraith-owned directory so a contained ACP seat gets: only the
// TaskWraith-curated config (telemetry off + deny wall + no standing allow
// rules), empty plugins/skills (no auto-loaded MCP servers / hooks / skills),
// and a 0600 seeded credential copy that is removed on every exit path. The
// default remains a throwaway per-run home; resumable seats retain only Kimi's
// native session files between turns.
//
// Why seed the credential: an isolated home with an empty credentials/ dir
// fails session/new with -32000 (the B5 paradox). Seeding the real credential
// into the isolated home resolves it (verified: session/new OK) while keeping
// the isolation — the token lives only for the process and is removed after.
//
// fs is injected so the seed/teardown logic is unit-testable without touching
// the real ~/.kimi-code.

import {
  buildKimiIsolatedConfig,
  UNSAFE_WORKSPACE_KIMI_CONFIG_RELPATHS
} from './KimiAcpContainment'
import { effectiveKimiModelContextWindow } from './KimiModelContext'
import { isAbsolute, relative, sep } from 'path'
import type {
  KimiOAuthCredentialLease,
  KimiOAuthCredentialLeaseAcquireResult,
  KimiOAuthCredentialLeaseRequest
} from './KimiOAuthCredentialLease'

export interface KimiHomeFs {
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, data: string, mode: number) => Promise<void>
  mkdir: (path: string) => Promise<void>
  copyFile: (from: string, to: string) => Promise<void>
  chmod: (path: string, mode: number) => Promise<void>
  exists: (path: string) => Promise<boolean>
  rm: (path: string) => Promise<void>
  join: (...parts: string[]) => string
  /** Required by production containment; optional only for legacy probe fakes. */
  readdir?: (path: string) => Promise<string[]>
  /** Must not follow a symlink at the checked path. */
  lstat?: (path: string) => Promise<{
    isDirectory: () => boolean
    isFile: () => boolean
    isSymbolicLink: () => boolean
    mode: number
    nlink?: number
    uid?: number
  }>
  realpath?: (path: string) => Promise<string>
  /**
   * Required for OAuth-backed production seats. The returned durable lease
   * owns the single-use refresh credential from seed through writeback.
   */
  acquireOAuthCredentialLease?: (
    request: KimiOAuthCredentialLeaseRequest
  ) => Promise<KimiOAuthCredentialLeaseAcquireResult>
}

export interface PrepareKimiHomeInput {
  runId: string
  /** Absolute isolated home path (per-run for probes, stable for durable seats). */
  homeDir: string
  /** Trusted root that must contain homeDir. Defaults to homeDir for ephemeral probes. */
  boundaryRoot?: string
  /** The real Kimi Code data root to transform config + seed credentials from. */
  sourceHome: string
  extraDenyTools?: readonly string[]
  /** Per-run thinking preference; omitted keeps the user config's setting. */
  thinkingEnabled?: boolean
  /** Per-run K3 thinking effort; omitted keeps the user config's setting. */
  thinkingEffort?: string
  /** Exact managed model alias selected for this run (for its effective window). */
  selectedModelAlias?: string
  /**
   * Keep Kimi's `sessions/` + `session_index.jsonl` in this home after cleanup.
   * Runtime config, credentials, oauth state, plugins, and skills are still
   * removed after every process exit and regenerated before the next turn.
   */
  preserveSessionState?: boolean
  /** Strict teardown: reject cleanup when an ephemeral home survives or when a
   * durable home cannot be reduced to verified native continuity state. */
  strictCleanup?: boolean
  fs: KimiHomeFs
}

export type PrepareKimiHomeResult =
  | {
      ok: true
      home: string
      env: Record<string, string>
      modelContextWindow?: number
      /** Record the exact child identity before the first ACP initialize. */
      noteProviderProcess: (pid: number) => Promise<void>
      cleanup: () => Promise<void>
    }
  | { ok: false; reason: 'not-authenticated' | 'no-config' | 'error'; message: string }

/** Only provider-native continuity files proven necessary for ACP resume. */
const KIMI_SESSION_CONTINUITY_TOP_LEVEL = new Set(['sessions', 'session_index.jsonl'])

function pathIsWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Kimi Code also supports a non-rotating API key directly in a `kimi` provider
 * table. This is the hosted-CI authentication path: unlike OAuth, it has no
 * single-use refresh credential to copy back after the ephemeral job ends.
 * Return only a boolean so callers never surface the key itself.
 */
export function hasConfiguredKimiApiKey(configBody: string): boolean {
  let inKimiProvider = false
  let hasKimiType = false
  let hasApiKey = false
  const flush = (): boolean => inKimiProvider && hasKimiType && hasApiKey

  for (const line of configBody.split(/\r?\n/)) {
    const trimmed = line.trim()
    const table = trimmed.match(/^\[providers\.(?:"kimi"|kimi)\]$/)
    if (/^\[/.test(trimmed)) {
      if (flush()) return true
      inKimiProvider = Boolean(table)
      hasKimiType = false
      hasApiKey = false
      continue
    }
    if (!inKimiProvider || !trimmed || trimmed.startsWith('#')) continue
    if (/^type\s*=\s*["']kimi["']\s*(?:#.*)?$/.test(trimmed)) hasKimiType = true
    const apiKey = trimmed.match(/^api_key\s*=\s*(["'])(.+)\1\s*(?:#.*)?$/)
    if (apiKey && apiKey[2].trim().length > 0) hasApiKey = true
  }
  return flush()
}

/**
 * Managed ACP authentication comes only from the current Kimi Code home. The
 * legacy ~/.kimi credential is usage-history compatibility and is never seeded
 * into a managed seat. A TaskWraith Settings key is likewise usage-only unless
 * the product later adds a separately reviewed secret-projection design.
 */
export async function detectKimiManagedAuthState(
  sourceHome: string,
  fs: Pick<KimiHomeFs, 'exists' | 'readFile' | 'join'>
): Promise<'oauth' | 'api-key' | 'unknown'> {
  const oauthCredential = fs.join(sourceHome, 'credentials', 'kimi-code.json')
  if (await fs.exists(oauthCredential)) return 'oauth'
  try {
    const config = await fs.readFile(fs.join(sourceHome, 'config.toml'))
    return hasConfiguredKimiApiKey(config) ? 'api-key' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Historical/test-only detector for the project-config exposure documented in
 * dossier B3/B4. Production managed ACP starts in a private synthetic cwd, so
 * workspace `.kimi-code` discovery is inert and this helper is not a runtime
 * admission guard. It remains to preserve the original containment evidence.
 */
export async function findUnsafeWorkspaceKimiConfig(
  workspace: string,
  fs: Pick<KimiHomeFs, 'exists' | 'join'>
): Promise<string | null> {
  for (const rel of UNSAFE_WORKSPACE_KIMI_CONFIG_RELPATHS) {
    const path = fs.join(workspace, ...rel.split('/'))
    if (await fs.exists(path)) return path
  }
  return null
}

/**
 * Build an isolated Kimi home. Cleanup removes either the whole directory or
 * all runtime-only material; callers MUST invoke it on every exit path. Fails
 * closed: a missing source credential returns `not-authenticated` (surfaced as
 * setup-required) rather than building a home that would run unauthenticated.
 */
export async function prepareKimiIsolatedHome(
  input: PrepareKimiHomeInput
): Promise<PrepareKimiHomeResult> {
  const { fs, homeDir, sourceHome } = input

  if (!fs.readdir || !fs.lstat || !fs.realpath) {
    return {
      ok: false,
      reason: 'error',
      message: 'Kimi isolated-home filesystem boundary primitives are unavailable.'
    }
  }

  // Establish and verify the credential-bearing boundary BEFORE reading,
  // copying, or writing any runtime material. mkdir may encounter an existing
  // path, so lstat + realpath are load-bearing: a pre-planted symlinked v2 seat
  // home/root must fail before it can redirect credentials elsewhere.
  const boundaryRoot = input.boundaryRoot || homeDir
  try {
    await fs.mkdir(boundaryRoot)
    let boundaryStat = await fs.lstat(boundaryRoot)
    if (
      !boundaryStat.isDirectory() ||
      boundaryStat.isSymbolicLink()
    ) {
      throw new Error('the isolated-home root is not a private real directory')
    }
    await fs.chmod(boundaryRoot, 0o700)
    boundaryStat = await fs.lstat(boundaryRoot)
    if ((boundaryStat.mode & 0o077) !== 0) {
      throw new Error('the isolated-home root is not mode 0700')
    }
    await fs.mkdir(homeDir)
    let homeStat = await fs.lstat(homeDir)
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) {
      throw new Error('the isolated Kimi home is not a private real directory')
    }
    await fs.chmod(homeDir, 0o700)
    const [rootReal, homeReal, privateHomeStat] = await Promise.all([
      fs.realpath(boundaryRoot),
      fs.realpath(homeDir),
      fs.lstat(homeDir)
    ])
    homeStat = privateHomeStat
    if (
      !homeStat.isDirectory() ||
      homeStat.isSymbolicLink() ||
      (homeStat.mode & 0o077) !== 0 ||
      !pathIsWithin(rootReal, homeReal)
    ) {
      throw new Error('the isolated Kimi home escaped its private root')
    }
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      message: `Failed to establish the isolated Kimi Code home boundary: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined
  const continuityEntryIsSafe = async (path: string): Promise<boolean> => {
    const stat = await fs.lstat!(path)
    if (stat.isSymbolicLink()) return false
    if (currentUid !== undefined && stat.uid !== undefined && stat.uid !== currentUid) return false
    if (stat.isFile()) return stat.nlink === undefined || stat.nlink === 1
    if (!stat.isDirectory()) return false
    const entries = await fs.readdir!(path)
    for (const entry of entries) {
      if (!(await continuityEntryIsSafe(fs.join(path, entry)))) return false
    }
    return true
  }

  const scrubDurableHome = async (bestEffort: boolean): Promise<void> => {
    let entries: string[] = []
    try {
      entries = await fs.readdir!(homeDir)
    } catch (error) {
      if (!bestEffort) throw error
      return
    }
    for (const entry of entries) {
      const path = fs.join(homeDir, entry)
      try {
        if (KIMI_SESSION_CONTINUITY_TOP_LEVEL.has(entry)) {
          const stat = await fs.lstat!(path)
          const valid =
            !stat.isSymbolicLink() &&
            (entry === 'sessions' ? stat.isDirectory() : stat.isFile()) &&
            (await continuityEntryIsSafe(path))
          if (valid) continue
        }
        await fs.rm(path)
      } catch (error) {
        if (!bestEffort) throw error
        // Teardown keeps scrubbing the rest; preparation uses the strict path
        // and refuses to spawn if unknown/invalid material cannot be removed.
      }
    }
  }

  // Kimi Code issues single-use OAuth refresh tokens. The authority lease is
  // acquired before seeding and remains held across the entire provider
  // lifetime. That prevents two managed seats from copying the same refresh
  // token, while its durable record lets the next admitted seat recover a
  // rotated credential after a host crash.
  let oauthCredentialLease: KimiOAuthCredentialLease | null = null
  const persistRotatedCredential = async (): Promise<void> => {
    if (!oauthCredentialLease) return
    await oauthCredentialLease.commitAndRelease()
  }

  const cleanup = async (): Promise<void> => {
    try {
      await persistRotatedCredential()
    } catch {
      // Preserve the isolated credential and durable lease for a joined retry
      // or next-start recovery. Scrubbing it here could discard the only valid
      // single-use refresh token after the provider rotated it.
      throw new Error(
        'Kimi OAuth credential writeback did not complete; the private seat home was preserved for recovery.'
      )
    }
    let cleanupFailed = false
    try {
      if (input.preserveSessionState) await scrubDurableHome(!input.strictCleanup)
      else if (await fs.exists(homeDir)) await fs.rm(homeDir)
    } catch {
      cleanupFailed = true
      // Best-effort teardown; cleanup errors must not replace the run result.
    }
    if (input.strictCleanup && input.preserveSessionState) {
      try {
        const entries = await fs.readdir!(homeDir)
        for (const entry of entries) {
          if (!KIMI_SESSION_CONTINUITY_TOP_LEVEL.has(entry)) {
            throw new Error(`unexpected durable entry survived: ${entry}`)
          }
          if (!(await continuityEntryIsSafe(fs.join(homeDir, entry)))) {
            throw new Error(`unsafe durable continuity entry survived: ${entry}`)
          }
        }
      } catch {
        cleanupFailed = true
      }
      if (cleanupFailed) {
        throw new Error(
          'Strict Kimi cleanup could not reduce the durable seat home to verified session continuity.'
        )
      }
    } else if (input.strictCleanup) {
      let homeRemains = true
      try {
        homeRemains = await fs.exists(homeDir)
      } catch {
        cleanupFailed = true
      }
      if (cleanupFailed || homeRemains) {
        throw new Error('Strict Kimi canary cleanup did not remove its credential-bearing home.')
      }
    }
  }

  let baseConfig: string
  try {
    baseConfig = await fs.readFile(fs.join(sourceHome, 'config.toml'))
  } catch {
    return {
      ok: false,
      reason: 'no-config',
      message: `Kimi Code config.toml was not found under ${sourceHome}; cannot build an isolated profile.`
    }
  }

  // OAuth seats require a copied credential. Hosted canaries instead use a
  // protected, non-rotating API key in config.toml and deliberately have no
  // fake or disposable OAuth credential file.
  const sourceCredential = fs.join(sourceHome, 'credentials', 'kimi-code.json')
  const hasOAuthCredential = await fs.exists(sourceCredential)
  if (!hasOAuthCredential && !hasConfiguredKimiApiKey(baseConfig)) {
    return {
      ok: false,
      reason: 'not-authenticated',
      message:
        'Kimi Code has no current OAuth login or provider API key in ~/.kimi-code/config.toml. Run `kimi login` (or configure that Kimi Code provider), then retry.'
    }
  }

  if (hasOAuthCredential) {
    if (!fs.acquireOAuthCredentialLease) {
      return {
        ok: false,
        reason: 'error',
        message:
          'TaskWraith cannot start managed Kimi OAuth without its durable credential authority.'
      }
    }
    const acquired = await fs.acquireOAuthCredentialLease({
      sourceHome,
      isolatedHome: homeDir,
      boundaryRoot
    })
    if (!acquired.ok) {
      return {
        ok: false,
        reason: 'error',
        message: acquired.message
      }
    }
    oauthCredentialLease = acquired.lease
  }

  try {
    const modelContextWindow = input.selectedModelAlias
      ? effectiveKimiModelContextWindow(baseConfig, input.selectedModelAlias)
      : undefined
    await fs.mkdir(homeDir)
    await fs.chmod(homeDir, 0o700)
    // A prior process crash or provider upgrade may have left unknown top-level
    // material. Keep only the two proven native-continuity entries.
    if (input.preserveSessionState) await scrubDurableHome(false)
    await fs.mkdir(fs.join(homeDir, 'credentials'))
    await fs.mkdir(fs.join(homeDir, 'oauth'))
    // Empty plugins/skills so nothing auto-loads (dossier B4/I3).
    await fs.mkdir(fs.join(homeDir, 'plugins'))
    await fs.mkdir(fs.join(homeDir, 'skills'))

    const isolatedConfig = buildKimiIsolatedConfig({
      baseConfig,
      extraDenyTools: input.extraDenyTools,
      thinkingEnabled: input.thinkingEnabled,
      thinkingEffort: input.thinkingEffort
    })
    await fs.writeFile(fs.join(homeDir, 'config.toml'), isolatedConfig, 0o600)

    // OAuth seats seed the exact snapshot owned by their durable lease. API-key
    // profiles authenticate from the curated config and leave these empty.
    await oauthCredentialLease?.seedIntoIsolatedHome()
    await fs.chmod(fs.join(homeDir, 'credentials'), 0o700)
    await fs.chmod(fs.join(homeDir, 'oauth'), 0o700)

    return {
      ok: true,
      home: homeDir,
      env: { KIMI_CODE_HOME: homeDir },
      ...(modelContextWindow ? { modelContextWindow } : {}),
      noteProviderProcess: (pid) => oauthCredentialLease?.noteProviderProcess(pid) ?? Promise.resolve(),
      cleanup
    }
  } catch (error) {
    let recoveryStatePreserved = false
    try {
      await cleanup()
    } catch {
      // A setup failure can coincide with unsafe crash residue. Keep the
      // durable authority record + candidate for restart recovery rather than
      // turning the typed preparation failure into an unjoined rejection.
      recoveryStatePreserved = true
    }
    return {
      ok: false,
      reason: 'error',
      message: `Failed to build the isolated Kimi Code home: ${
        error instanceof Error ? error.message : String(error)
      }${
        recoveryStatePreserved
          ? ' Private OAuth recovery state was preserved; restart TaskWraith before retrying.'
          : ''
      }`
    }
  }
}
