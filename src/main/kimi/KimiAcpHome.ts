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

export interface KimiHomeFs {
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, data: string, mode: number) => Promise<void>
  mkdir: (path: string) => Promise<void>
  copyFile: (from: string, to: string) => Promise<void>
  chmod: (path: string, mode: number) => Promise<void>
  exists: (path: string) => Promise<boolean>
  rm: (path: string) => Promise<void>
  join: (...parts: string[]) => string
}

export interface PrepareKimiHomeInput {
  runId: string
  /** Absolute isolated home path (per-run for probes, stable for durable seats). */
  homeDir: string
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
  fs: KimiHomeFs
}

export type PrepareKimiHomeResult =
  | {
      ok: true
      home: string
      env: Record<string, string>
      modelContextWindow?: number
      cleanup: () => Promise<void>
    }
  | { ok: false; reason: 'not-authenticated' | 'no-config' | 'error'; message: string }

/** Credential artefacts seeded into the isolated home (relative paths). */
const CREDENTIAL_ARTEFACTS = ['credentials/kimi-code.json', 'oauth/kimi-code', 'device_id'] as const

/** Everything materialized only while the ACP process is live. Session state is
 * deliberately absent from this list. */
const KIMI_RUNTIME_ARTEFACTS = [
  'credentials',
  'oauth',
  'device_id',
  'config.toml',
  'mcp.json',
  'plugins',
  'skills'
] as const

/**
 * Return the first un-sandboxable project Kimi config the workspace carries
 * (`.kimi-code/mcp.json` or `.kimi-code/plugins`), or null. Kimi Code loads
 * these from the ACP session cwd — outside the isolated home + deny wall — so a
 * contained run must refuse when one is present (dossier B3/B4). Only the
 * session-cwd workspace is checked; `--add-dir` grants do NOT trigger project
 * discovery (verified).
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

  const removeRuntimeArtefacts = async (bestEffort: boolean): Promise<void> => {
    for (const rel of KIMI_RUNTIME_ARTEFACTS) {
      const path = fs.join(homeDir, ...rel.split('/'))
      try {
        if (await fs.exists(path)) await fs.rm(path)
      } catch (error) {
        if (!bestEffort) throw error
        // Teardown keeps cleaning the rest; preparation uses the strict path
        // and refuses to spawn if stale runtime material cannot be removed.
      }
    }
  }

  // Kimi Code (Moonshot) issues SINGLE-USE refresh tokens: every refresh
  // consumes the current refresh token and mints a new one (verified live — the
  // refresh token's jti + value rotate on each refresh). Because each run
  // executes in this throwaway home (a 0600 copy of ~/.kimi-code), a refresh
  // during the run writes the ROTATED credential HERE; deleting the home would
  // discard it while the real-home refresh token is now invalidated server-side
  // — forcing `kimi login` again every ~15-minute access-token lifetime. So
  // before teardown, persist a STRICTLY-NEWER refreshed credential back to the
  // real home. Newness-gated on `expires_at` so a concurrent staler run can't
  // clobber a fresher real-home token; best-effort so it never fails a run.
  const persistRotatedCredential = async (): Promise<void> => {
    try {
      const isoCred = fs.join(homeDir, 'credentials', 'kimi-code.json')
      if (!(await fs.exists(isoCred))) return
      const isoRaw = await fs.readFile(isoCred)
      const realCred = fs.join(sourceHome, 'credentials', 'kimi-code.json')
      const realRaw = (await fs.exists(realCred)) ? await fs.readFile(realCred) : null
      if (realRaw === isoRaw) return // no refresh happened this run
      const expiryOf = (raw: string): number => {
        try {
          const value = (JSON.parse(raw) as { expires_at?: unknown }).expires_at
          return typeof value === 'number' ? value : 0
        } catch {
          return 0
        }
      }
      // Only ever advance the real home forward — never regress it.
      if (realRaw !== null && expiryOf(isoRaw) <= expiryOf(realRaw)) return
      // A refresh happened — persist every credential artefact back to the real
      // home (copyFile is binary-safe for the oauth/device artefacts), 0600.
      for (const rel of CREDENTIAL_ARTEFACTS) {
        const isoArtefact = fs.join(homeDir, ...rel.split('/'))
        if (!(await fs.exists(isoArtefact))) continue
        const realArtefact = fs.join(sourceHome, ...rel.split('/'))
        await fs.copyFile(isoArtefact, realArtefact)
        await fs.chmod(realArtefact, 0o600)
      }
    } catch {
      // Best-effort; a failed write-back must never break teardown.
    }
  }

  const cleanup = async (): Promise<void> => {
    await persistRotatedCredential()
    try {
      if (input.preserveSessionState) await removeRuntimeArtefacts(true)
      else if (await fs.exists(homeDir)) await fs.rm(homeDir)
    } catch {
      // Best-effort teardown; cleanup errors must not replace the run result.
    }
  }

  // Scrub crash residue even when the current run cannot proceed (for example,
  // the user logged out and the source credential is now missing).
  if (input.preserveSessionState && (await fs.exists(homeDir))) {
    try {
      await removeRuntimeArtefacts(false)
    } catch (error) {
      return {
        ok: false,
        reason: 'error',
        message: `Failed to scrub the isolated Kimi Code home: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
    }
  }

  // Fail closed if the user has not logged into Kimi Code — no credential to
  // seed means an isolated session would -32000; surface setup-required first.
  const sourceCredential = fs.join(sourceHome, 'credentials', 'kimi-code.json')
  if (!(await fs.exists(sourceCredential))) {
    return {
      ok: false,
      reason: 'not-authenticated',
      message:
        'Kimi Code is not signed in. Run `kimi login` (or `kimi acp --login`) in your shell, then retry.'
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

  try {
    const modelContextWindow = input.selectedModelAlias
      ? effectiveKimiModelContextWindow(baseConfig, input.selectedModelAlias)
      : undefined
    await fs.mkdir(homeDir)
    await fs.chmod(homeDir, 0o700)
    // A prior process crash may have left live runtime material in a durable
    // seat home. Strip it before seeding current credentials/config.
    if (input.preserveSessionState) await removeRuntimeArtefacts(false)
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

    // Seed the credential artefacts (0600) so session/new authenticates.
    for (const rel of CREDENTIAL_ARTEFACTS) {
      const from = fs.join(sourceHome, ...rel.split('/'))
      if (!(await fs.exists(from))) continue
      const to = fs.join(homeDir, ...rel.split('/'))
      await fs.copyFile(from, to)
      await fs.chmod(to, 0o600)
    }
    await fs.chmod(fs.join(homeDir, 'credentials'), 0o700)
    await fs.chmod(fs.join(homeDir, 'oauth'), 0o700)

    return {
      ok: true,
      home: homeDir,
      env: { KIMI_CODE_HOME: homeDir },
      ...(modelContextWindow ? { modelContextWindow } : {}),
      cleanup
    }
  } catch (error) {
    await cleanup()
    return {
      ok: false,
      reason: 'error',
      message: `Failed to build the isolated Kimi Code home: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
}
