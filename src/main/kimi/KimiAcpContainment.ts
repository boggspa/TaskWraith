// Kimi Code ACP containment: the isolated KIMI_CODE_HOME + curated config that
// makes a full-tool `kimi acp` seat safe to run. Historical kimi-code 0.24.1
// traces motivated these controls; they do not qualify any current binary.
// Source-ahead production admission comes only from the embedded exact-build
// roster populated by the credentialed containment canary.
//
// Live findings that shape this module:
//   - Production seats advertise NO ACP client fs capability. Read/Write/Edit
//     are denied statically alongside the server-side Bash/Glob/Grep tools, so
//     every workspace byte flows through the governed TaskWraith HTTP gateway.
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
// also strips any migrated `decision = "allow"` permission rule (dossier B8).
// The sole managed allow that is then added covers the isolated, authenticated
// TaskWraith MCP server. It is transport admission only: every call still
// crosses Electron main's signed, argument-aware broker and service gate.

/**
 * Historical workspace-relative Kimi project-config entries that auto-execute
 * or auto-load when the real workspace is used as `session/new` cwd. Production
 * TaskWraith seats no longer use the workspace as process or session cwd; these
 * names remain for compatibility probes and migration diagnostics only.
 */
export const UNSAFE_WORKSPACE_KIMI_CONFIG_RELPATHS = [
  '.kimi-code/mcp.json',
  '.kimi-code/plugins'
] as const

/** Historical diagnostic retained for compatibility probes. Production seats
 * use a private empty cwd, so project Kimi config in the real workspace is not
 * discovered and does not require a check-before-use refusal. */
export function buildKimiWorkspaceConfigRefusalMessage(offendingPath: string): string {
  return (
    `This workspace contains a project-level Kimi config (${offendingPath}). Legacy TaskWraith Kimi seats ` +
    `could load it from the real session working directory before any prompt or permission check. Current ` +
    `production seats use a private synthetic cwd and do not load this workspace config.`
  )
}

/** Built-in tools denied by construction on every contained Kimi ACP seat.
 *  Two classes:
 *   - EGRESS / fan-out: FetchURL/WebSearch auto-run the server-side network
 *     egress vector; AgentSwarm fans out unbrokered sub-agents.
 *   - NATIVE FS / EXEC: Bash/Glob/Grep execute INSIDE the kimi acp process
 *     and do NOT route through the client fs authority, so they can read AND
 *     write ANY absolute path outside the workspace roots. Verified live: Bash
 *     `cat` leaked an out-of-workspace file and Bash `echo >` WROTE one; Glob
 *     enumerated an out-of-workspace directory. Read/Write/Edit are also denied
 *     because omitting client fs capability must not be allowed to shift them
 *     to provider-side execution. Denying every native filesystem door forces
 *     all workspace access onto the workspace-confined TaskWraith gateway MCP
 *     (run_shell_command / list_directory / find_files / workspace_search).
 *  Deny rules are static and inherit into any sub-agent that is spawned. */
export const KIMI_ACP_DENY_TOOLS = [
  'FetchURL',
  'WebSearch',
  'AgentSwarm',
  'Bash',
  'Glob',
  'Grep',
  'Read',
  'Write',
  'Edit'
] as const

/** Kimi validates permission rules before ACP session/new registers the
 * per-run HTTP server. A server wildcard remains valid at that point whereas
 * individual dynamically registered tool names are discarded as unknown.
 * The isolated home has no other MCP server with this name. */
export const KIMI_ACP_BROKERED_MCP_ALLOW_PATTERN = 'mcp__taskwraith__*' as const

/**
 * Strip every `[[permission.rules]]` block whose decision is `allow` from a
 * config.toml body (dossier B8: a migrated always-allow rule would become a
 * standing allow into every ACP session). `deny` and `ask` rules are kept —
 * they only tighten. Line-oriented so it never needs a TOML parser: an array-
 * of-tables block runs from a `[[permission.rules]]` header to the next table
 * header or EOF.
 */
export function stripAllowPermissionRules(configBody: string): string {
  if (configBody.includes('"""') || configBody.includes("'''")) {
    throw new Error('Multiline TOML strings are unsupported in a contained Kimi profile.')
  }
  const lines = configBody.split(/\r?\n/)
  const out: string[] = []
  let block: string[] | null = null
  let blockDecision: 'allow' | 'deny' | 'ask' | null = null
  const permissionRuleHeader =
    /^\s*\[\[\s*(?:permission|"permission"|'permission')\s*\.\s*(?:rules|"rules"|'rules')\s*\]\]\s*(?:#.*)?$/
  const codeBeforeComment = (line: string): string => {
    let quote: 'single' | 'double' | null = null
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index]
      if (quote === 'double' && char === '\\') {
        index += 1
        continue
      }
      if (char === '"' && quote !== 'single') quote = quote === 'double' ? null : 'double'
      else if (char === "'" && quote !== 'double') quote = quote === 'single' ? null : 'single'
      else if (char === '#' && quote === null) return line.slice(0, index)
    }
    return line
  }

  const flush = (): void => {
    if (!block) return
    if (!blockDecision) {
      throw new Error('Kimi permission.rules block has no supported decision.')
    }
    if (blockDecision !== 'allow') out.push(...block)
    block = null
    blockDecision = null
  }
  const isTableHeader = (line: string): boolean =>
    /^\s*\[\[?.+?\]\]?\s*(?:#.*)?$/.test(line)

  for (const line of lines) {
    const code = codeBeforeComment(line).trim()
    const keyOrHeader = code.includes('=') ? code.slice(0, code.indexOf('=')) : code
    if (keyOrHeader.includes('\\')) {
      throw new Error('Escaped TOML keys are unsupported in a contained Kimi profile.')
    }
    if (permissionRuleHeader.test(line)) {
      flush()
      block = [line]
      blockDecision = null
      continue
    }
    // A permission-rule-looking array header that this bounded parser cannot
    // understand is a containment error, not something to preserve and hope
    // deny precedence handles.
    if (/^\[/.test(code) && /permission/i.test(code)) {
      throw new Error('Unsupported Kimi permission.rules table syntax.')
    }
    // TOML object equivalence permits standing rules without an array-table,
    // e.g. `permission.rules = [...]` or `permission = { rules = [...] }`.
    // This bounded transform supports only the canonical array-table form and
    // rejects every other permission assignment instead of relying on rule
    // precedence that the host cannot prove.
    if (
      /^(?:permission|"permission"|'permission')\s*(?:\.|=)/i.test(code) ||
      /^(?:"permission\.rules"|'permission\.rules')\s*=/i.test(code)
    ) {
      throw new Error('Unsupported inline or dotted Kimi permission syntax.')
    }
    if (block) {
      // A new table header ends the current permission-rule block.
      if (isTableHeader(line) && !permissionRuleHeader.test(line)) {
        flush()
        out.push(line)
        continue
      }
      const decision = line.match(
        /^\s*decision\s*=\s*(["'])(allow|deny|ask)\1\s*(?:#.*)?$/
      )
      if (decision) {
        if (blockDecision) {
          throw new Error('Kimi permission.rules block has duplicate decisions.')
        }
        blockDecision = decision[2] as 'allow' | 'deny' | 'ask'
      } else if (/^\s*(?:decision|"decision"|'decision')\s*=/.test(line)) {
        throw new Error('Kimi permission.rules block uses unsupported decision syntax.')
      }
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
  if (configBody.includes('"""') || configBody.includes("'''")) {
    throw new Error('Multiline TOML strings are unsupported in a contained Kimi profile.')
  }
  if (/^\s*(?:"telemetry"|'telemetry')\s*=/m.test(configBody)) {
    throw new Error('Quoted telemetry keys are unsupported in a contained Kimi profile.')
  }
  const lines = configBody.split(/\r?\n/)
  const firstTable = lines.findIndex((l) => /^\s*\[/.test(l.trim()))
  const topLevelEnd = firstTable === -1 ? lines.length : firstTable
  const telemetryIndex = lines
    .slice(0, topLevelEnd)
    .findIndex((line) => /^\s*telemetry\s*=/.test(line))
  const topLevelTelemetryCount = lines
    .slice(0, topLevelEnd)
    .filter((line) => /^\s*telemetry\s*=/.test(line)).length
  if (topLevelTelemetryCount > 1) {
    throw new Error('Duplicate top-level telemetry keys are unsupported in a contained Kimi profile.')
  }
  if (telemetryIndex >= 0) {
    lines[telemetryIndex] = 'telemetry = false'
    return lines.join('\n')
  }
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

/** Admit the app-owned MCP transport at Kimi's provider-local layer. This does
 * not authorize a tool action: the authenticated TaskWraith broker applies the
 * signed run posture, exact service policy, approval ledger, and call guard.
 * Existing user deny/ask rules stay earlier in the transformed config and can
 * therefore tighten this default through Kimi's first-match semantics. */
export function buildKimiBrokeredMcpAllowRule(
  pattern: string = KIMI_ACP_BROKERED_MCP_ALLOW_PATTERN
): string {
  return (
    `\n[[permission.rules]]\n` +
    `decision = "allow"\n` +
    `pattern = "${pattern}"\n` +
    `reason = "TaskWraith main broker owns tool approval"\n`
  )
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
  const brokeredMcpAllow = buildKimiBrokeredMcpAllowRule()
  const deny = buildKimiDenyWall(denyTools)
  return (
    `# TaskWraith-managed isolated Kimi Code profile (per-run KIMI_CODE_HOME).\n` +
    `# User allow-rules are stripped; the authenticated TaskWraith MCP transport\n` +
    `# is broker-owned; telemetry is off; native deny wall: ${denyTools.join(', ')}.\n` +
    `# Do not edit by hand.\n` +
    `${withThinkingEffort.replace(/\s*$/, '')}\n${brokeredMcpAllow}${deny}`
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
