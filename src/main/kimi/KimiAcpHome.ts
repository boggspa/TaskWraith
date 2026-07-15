// Per-run isolated KIMI_CODE_HOME builder. Relocates Kimi Code's entire data
// root to a throwaway per-run directory so a contained ACP seat gets: only the
// TaskWraith-curated config (telemetry off + deny wall + no standing allow
// rules), empty plugins/skills (no auto-loaded MCP servers / hooks / skills),
// and a 0600 seeded credential copy that is torn down on every exit path.
//
// Why seed the credential: an isolated home with an empty credentials/ dir
// fails session/new with -32000 (the B5 paradox). Seeding the real credential
// into the throwaway home resolves it (verified: session/new OK) while keeping
// the isolation — the token lives only for the run and is removed after.
//
// fs is injected so the seed/teardown logic is unit-testable without touching
// the real ~/.kimi-code.

import {
  buildKimiIsolatedConfig,
  UNSAFE_WORKSPACE_KIMI_CONFIG_RELPATHS
} from './KimiAcpContainment'

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
  /** Absolute path of the throwaway home dir to create (per-run, unique). */
  homeDir: string
  /** The real Kimi Code data root to transform config + seed credentials from. */
  sourceHome: string
  extraDenyTools?: readonly string[]
  /** Per-run thinking preference; omitted keeps the user config's setting. */
  thinkingEnabled?: boolean
  fs: KimiHomeFs
}

export type PrepareKimiHomeResult =
  | { ok: true; home: string; env: Record<string, string>; cleanup: () => Promise<void> }
  | { ok: false; reason: 'not-authenticated' | 'no-config' | 'error'; message: string }

/** Credential artefacts seeded into the isolated home (relative paths). */
const CREDENTIAL_ARTEFACTS = ['credentials/kimi-code.json', 'oauth/kimi-code', 'device_id'] as const

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
 * Build a per-run isolated home. Returns a cleanup that removes the whole dir;
 * callers MUST invoke it on every exit path (success, failure, cancel). Fails
 * closed: a missing source credential returns `not-authenticated` (surfaced as
 * setup-required) rather than building a home that would run unauthenticated.
 */
export async function prepareKimiIsolatedHome(
  input: PrepareKimiHomeInput
): Promise<PrepareKimiHomeResult> {
  const { fs, homeDir, sourceHome } = input
  const cleanup = async (): Promise<void> => {
    try {
      if (await fs.exists(homeDir)) await fs.rm(homeDir)
    } catch {
      // Best-effort teardown; a leaked throwaway dir is not worth failing a run.
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
    await fs.mkdir(homeDir)
    await fs.chmod(homeDir, 0o700)
    await fs.mkdir(fs.join(homeDir, 'credentials'))
    await fs.mkdir(fs.join(homeDir, 'oauth'))
    // Empty plugins/skills so nothing auto-loads (dossier B4/I3).
    await fs.mkdir(fs.join(homeDir, 'plugins'))
    await fs.mkdir(fs.join(homeDir, 'skills'))

    const isolatedConfig = buildKimiIsolatedConfig({
      baseConfig,
      extraDenyTools: input.extraDenyTools,
      thinkingEnabled: input.thinkingEnabled
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
