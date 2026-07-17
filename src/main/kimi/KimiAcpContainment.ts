// Kimi Code ACP containment: the isolated KIMI_CODE_HOME + curated config that
// makes a full-tool `kimi acp` seat safe to run. Every element here was live-
// verified against kimi-code 0.24.1 before it was written (traces in the
// migration dossier follow-up); see the block comments for what each closes.
//
// Live findings that shape this module:
//   - File tools (Read/Grep/Glob/Write/Edit) route through the ACP CLIENT fs
//     capabilities, so TaskWraith regains per-path authority by implementing
//     the fs handlers (KimiAcpClient) — the `--agent-file allowed_tools:[]`
//     successor. That is the client's job, not this module's.
//   - WebSearch + FetchURL AUTO-RUN server-side (no permission ask) and reach
//     api.kimi.com/coding/v1/{search,fetch}. They are the egress vector.
//     Removing [services.moonshot_search] kills WebSearch but FetchURL SURVIVES
//     config omission — so egress must be closed with a static [[permission.rules]]
//     DENY wall, which "remains in effect" even under auto/-p mode and PROVABLY
//     inherits into sub-agents (a sub-agent's FetchURL was denied by the wall).
//   - An isolated KIMI_CODE_HOME with empty credentials/ fails session/new with
//     -32000; SEEDING the real credential into the isolated home resolves it
//     (verified: session/new OK). The seed is 0600 and torn down every exit.
//   - telemetry defaults to true; the isolated config forces it false.
//
// The config is TRANSFORMED from the user's real config.toml (proven to keep
// the built-in tool surface working) rather than synthesised from scratch (a
// hand-built minimal config silently produced an empty tool set). The transform
// also strips any migrated `decision = "allow"` permission rule (dossier B8) so
// no standing always-allow reaches the ACP session.

/**
 * Workspace-relative Kimi project-config entries that auto-execute or auto-load
 * at session start. Kimi Code discovers project config from the ACP `session/new`
 * cwd (verified: a project `.kimi-code/mcp.json` ran `/usr/bin/touch` at
 * session/new despite the isolated KIMI_CODE_HOME, `mcpServers:[]`, and the deny
 * wall) — that discovery is driven by the session cwd, which MUST be the real
 * workspace for the seat to be usable, so it cannot be relocated like the data
 * root. `.kimi-code/mcp.json` executes arbitrary stdio servers pre-prompt (RCE +
 * egress that bypasses the by-name deny wall); `.kimi-code/plugins` auto-loads
 * MCP servers / hooks. A workspace carrying either cannot be sandboxed, so a
 * contained Kimi ACP run must REFUSE rather than execute it. (dossier B3/B4.)
 */
export const UNSAFE_WORKSPACE_KIMI_CONFIG_RELPATHS = [
  '.kimi-code/mcp.json',
  '.kimi-code/plugins'
] as const

/** User-facing copy for the refuse-to-run when a workspace carries an
 *  un-sandboxable project Kimi config. */
export function buildKimiWorkspaceConfigRefusalMessage(offendingPath: string): string {
  return (
    `This workspace contains a project-level Kimi config (${offendingPath}) that TaskWraith cannot sandbox: ` +
    `Kimi Code loads it from the session working directory before any prompt or permission check, outside the ` +
    `isolated profile and the tool deny wall, so it could run arbitrary commands. Kimi runs are blocked in this ` +
    `workspace for safety. Remove or relocate the .kimi-code project config to run Kimi here.`
  )
}

/** Built-in tools denied by construction on every contained Kimi ACP seat.
 *  Two classes:
 *   - EGRESS / fan-out: FetchURL/WebSearch auto-run the server-side network
 *     egress vector; AgentSwarm fans out unbrokered sub-agents.
 *   - SERVER-SIDE FS / EXEC: Bash/Glob/Grep execute INSIDE the kimi acp process
 *     and do NOT route through the client fs authority, so they can read AND
 *     write ANY absolute path outside the workspace roots. Verified live: Bash
 *     `cat` leaked an out-of-workspace file and Bash `echo >` WROTE one; Glob
 *     enumerated an out-of-workspace directory. (Read/Write/Edit route through
 *     the client fs handler — `fs/read_text_file`/`fs/write_text_file` — and are
 *     already boundary-enforced: they returned `failed` for the same paths.)
 *     Denying the escapers forces all filesystem/exec access onto the two
 *     ENFORCED doors — the client fs handler (Read/Write/Edit) and the
 *     workspace-confined TaskWraith gateway MCP (run_shell_command /
 *     list_directory / find_files / workspace_search).
 *  Deny rules are static and inherit into any sub-agent that is spawned. */
export const KIMI_ACP_DENY_TOOLS = [
  'FetchURL',
  'WebSearch',
  'AgentSwarm',
  'Bash',
  'Glob',
  'Grep'
] as const

/**
 * Strip every `[[permission.rules]]` block whose decision is `allow` from a
 * config.toml body (dossier B8: a migrated always-allow rule would become a
 * standing allow into every ACP session). `deny` and `ask` rules are kept —
 * they only tighten. Line-oriented so it never needs a TOML parser: an array-
 * of-tables block runs from a `[[permission.rules]]` header to the next table
 * header or EOF.
 */
export function stripAllowPermissionRules(configBody: string): string {
  const lines = configBody.split(/\r?\n/)
  const out: string[] = []
  let block: string[] | null = null
  let blockIsAllow = false

  const flush = (): void => {
    if (!block) return
    if (!blockIsAllow) out.push(...block)
    block = null
    blockIsAllow = false
  }
  const isTableHeader = (line: string): boolean => /^\s*\[\[?[^\]]+\]\]?\s*$/.test(line.trim())

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '[[permission.rules]]') {
      flush()
      block = [line]
      blockIsAllow = false
      continue
    }
    if (block) {
      // A new table header ends the current permission-rule block.
      if (isTableHeader(line) && trimmed !== '[[permission.rules]]') {
        flush()
        out.push(line)
        continue
      }
      if (/^\s*decision\s*=\s*["']allow["']/.test(line)) blockIsAllow = true
      block.push(line)
      continue
    }
    out.push(line)
  }
  flush()
  return out.join('\n')
}

/** Force `telemetry = false`: replace an existing top-level assignment, or add
 *  one if absent (before the first table header so it stays top-level). */
export function forceTelemetryOff(configBody: string): string {
  if (/^\s*telemetry\s*=/m.test(configBody)) {
    return configBody.replace(/^\s*telemetry\s*=.*$/m, 'telemetry = false')
  }
  const lines = configBody.split(/\r?\n/)
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l.trim()))
  if (firstTable === -1) return `${configBody.replace(/\s*$/, '')}\ntelemetry = false\n`
  lines.splice(firstTable, 0, 'telemetry = false', '')
  return lines.join('\n')
}

/** The deny-wall TOML appended to every contained config. */
export function buildKimiDenyWall(tools: readonly string[] = KIMI_ACP_DENY_TOOLS): string {
  return tools
    .map((tool) => `\n[[permission.rules]]\ndecision = "deny"\npattern = "${tool}"\n`)
    .join('')
}

/**
 * Force `[thinking] enabled = <value>` in a config body. Kimi Code dropped the
 * `--thinking/--no-thinking` CLI flags (poison on any kimi-code argv); thinking
 * is a config setting now, so a per-run thinking preference is applied here,
 * never as an argument. Replaces an existing `enabled` under `[thinking]`, adds
 * one if the table exists without it, or appends the whole table if absent.
 */
export function forceThinkingMode(configBody: string, enabled: boolean): string {
  const value = enabled ? 'true' : 'false'
  const lines = configBody.split(/\r?\n/)
  const tableIdx = lines.findIndex((l) => l.trim() === '[thinking]')
  if (tableIdx === -1) {
    return `${configBody.replace(/\s*$/, '')}\n\n[thinking]\nenabled = ${value}\n`
  }
  for (let i = tableIdx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i].trim())) break // next table ends [thinking]
    if (/^\s*enabled\s*=/.test(lines[i])) {
      lines[i] = `enabled = ${value}`
      return lines.join('\n')
    }
  }
  lines.splice(tableIdx + 1, 0, `enabled = ${value}`)
  return lines.join('\n')
}

/** Force `[thinking] effort = "<value>"` while preserving the rest of the
 * user's model catalogue. Callers pass only provider-validated effort tokens. */
export function forceThinkingEffort(configBody: string, effort: string): string {
  const value = effort.trim().toLowerCase()
  if (!/^[a-z][a-z0-9_-]*$/.test(value)) return configBody
  const lines = configBody.split(/\r?\n/)
  const tableIdx = lines.findIndex((line) => line.trim() === '[thinking]')
  if (tableIdx === -1) {
    return `${configBody.replace(/\s*$/, '')}\n\n[thinking]\neffort = "${value}"\n`
  }
  for (let i = tableIdx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i].trim())) break
    if (/^\s*effort\s*=/.test(lines[i])) {
      lines[i] = `effort = "${value}"`
      return lines.join('\n')
    }
  }
  lines.splice(tableIdx + 1, 0, `effort = "${value}"`)
  return lines.join('\n')
}

export interface KimiIsolatedConfigOptions {
  /** The user's real config.toml body (the transform base). */
  baseConfig: string
  /** Extra tools to deny beyond the default egress/sub-agent wall. */
  extraDenyTools?: readonly string[]
  /** Per-run thinking preference; when omitted the base config's setting is kept. */
  thinkingEnabled?: boolean
  /** K3 thinking effort. K2.7 Coding omits this because its thinking is binary-on. */
  thinkingEffort?: string
}

/**
 * Produce the isolated config.toml: the user's config with allow-rules stripped
 * (B8), telemetry forced off (B7), and the deny wall appended (B1 egress
 * residue). A trailing marker comment records that this is a TaskWraith-managed
 * isolated profile.
 */
export function buildKimiIsolatedConfig(options: KimiIsolatedConfigOptions): string {
  const stripped = stripAllowPermissionRules(options.baseConfig)
  const telemetryOff = forceTelemetryOff(stripped)
  const withThinking =
    options.thinkingEnabled === undefined
      ? telemetryOff
      : forceThinkingMode(telemetryOff, options.thinkingEnabled)
  const withThinkingEffort = options.thinkingEffort
    ? forceThinkingEffort(withThinking, options.thinkingEffort)
    : withThinking
  const denyTools = [...KIMI_ACP_DENY_TOOLS, ...(options.extraDenyTools ?? [])]
  const deny = buildKimiDenyWall(denyTools)
  return (
    `# TaskWraith-managed isolated Kimi Code profile (per-run KIMI_CODE_HOME).\n` +
    `# Generated from the user config with allow-rules stripped, telemetry off,\n` +
    `# and a static deny wall (${denyTools.join(', ')}). Do not edit by hand.\n` +
    `${withThinkingEffort.replace(/\s*$/, '')}\n${deny}`
  )
}

/**
 * Decide whether a path an ACP fs request targets is inside the authority the
 * seat was granted (the workspace root plus any external path grants). This is
 * the client-side fs deny wall: a read/write for a path outside every root is
 * refused, so the model cannot use its built-in file tools to escape the
 * workspace even though they auto-run. Paths are compared after normalisation;
 * a root boundary must be a full segment (so `/ws` does not authorise
 * `/ws-secrets`).
 *
 * `resolvePath`/`relativize` are injected (node path.resolve / path.relative)
 * so this stays a pure, unit-testable predicate.
 */
export function isPathWithinRoots(
  target: string,
  roots: readonly string[],
  helpers: {
    resolve: (p: string) => string
    relative: (from: string, to: string) => string
  }
): boolean {
  if (!target) return false
  const resolvedTarget = helpers.resolve(target)
  for (const root of roots) {
    if (!root) continue
    const resolvedRoot = helpers.resolve(root)
    if (resolvedTarget === resolvedRoot) return true
    const rel = helpers.relative(resolvedRoot, resolvedTarget)
    if (rel && !rel.startsWith('..') && !rel.startsWith('/') && !/^[A-Za-z]:/.test(rel)) {
      return true
    }
  }
  return false
}
