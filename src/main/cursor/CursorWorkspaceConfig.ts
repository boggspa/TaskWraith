// CR6 — workspace-local Cursor permission config for TaskWraith-owned WRITE mode.
//
// The CR3 spike proved a bare `cursor-agent -p` runs native write+shell
// UNMEDIATED, and that a `.cursor/cli.json` deny-list hard-blocks them. Cursor
// has no `--deny` argv flag (unlike Grok) — permissions are file-based — so
// write-capable runs write a transient workspace-local `.cursor/cli.json` that
// **denies native shell + native writes** (`Shell(**)`, `Write(**)`) while the
// TaskWraith MCP bridge supplies governed write_file / replace / apply_patch
// tools. Edits then flow through TaskWraith's approval ledger and workspace/path
// checks instead of Cursor-native side effects. Restored after the run.
//
// SAFETY: never touches global `~/.cursor`. Merges (not clobbers) any existing
// workspace `.cursor/cli.json` — we only ADD the shell deny — and restores the
// exact original bytes on completion. A crash that skips restore leaves only
// extra Shell(**) / Write(**) deny rules (conservative, never destructive). The
// caller falls back to read-only (`--mode plan`) if this config can't be applied.
//
// Write mode also sets up the TaskWraith MCP bridge: a per-run
// `.cursor/mcp.json` registering the full brokered TaskWraith MCP server plus
// matching `Mcp(<server>:<tool>)` allow rules merged into the SAME cli.json write
// (one write, one restore for both files). Default mode is the only mode where
// Cursor executes MCP tools (plan mode rejects them), and TaskWraith write mode
// == default Cursor mode, so the bridge rides exactly the write-mode trigger.

import {
  globalCursorMcpNeedsUpdate,
  mergeCursorAllowRules,
  mergeCursorMcpConfig,
  mergeGlobalCursorMcpServers
} from './CursorMcpBridge'

export interface CursorCliConfig {
  permissions: { allow: string[]; deny: string[] }
  [key: string]: unknown
}

/** Native side effects denied in write mode. Edits stay allowed (diff-reviewed);
 *  shell and provider-native writes are blocked outright. */
export const CURSOR_WRITE_MODE_DENY_RULES: readonly string[] = ['Shell(**)', 'Write(**)']

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Merge `denyRules` into an existing `.cursor/cli.json` shape (or {}), preserving
 * any existing allow/deny entries + unknown top-level keys, deduping deny rules.
 * Pure.
 */
export function mergeCursorDenyRules(
  existing: unknown,
  denyRules: readonly string[]
): CursorCliConfig {
  const base = asRecord(existing)
  const perms = asRecord(base.permissions)
  const allow = stringArray(perms.allow)
  const deny = stringArray(perms.deny)
  for (const rule of denyRules) {
    if (!deny.includes(rule)) deny.push(rule)
  }
  return { ...base, permissions: { allow, deny } }
}

/** Minimal sync-fs surface (subset of node:fs) — injected for testability. */
export interface CursorConfigFs {
  existsSync(path: string): boolean
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string): void
  mkdirSync(path: string, options: { recursive: boolean }): void
  rmSync(path: string, options: { force?: boolean; recursive?: boolean }): void
}

/**
 * Optional MCP bridge setup applied alongside the write-mode deny-list.
 * `allowRules` are always merged into the cli.json write. `mcpConfigPath` +
 * `serverEntry` are OPTIONAL: supply both to also register a per-run workspace
 * `.cursor/mcp.json` (the original approach); OMIT both for CRUX39 "B" mode,
 * which relies on a user-approved GLOBAL `~/.cursor/mcp.json` server and so needs
 * only the cli.json allow rule (no per-run registration).
 */
export interface CursorMcpBridgeOptions {
  /** Allow rules to add to cli.json (normally `CURSOR_MCP_ALLOW_RULES`). */
  allowRules: readonly string[]
  /** Absolute path to the workspace `.cursor/mcp.json` (omit in "B" mode). */
  mcpConfigPath?: string
  /** The `mcpServers` entry (from `buildCursorMcpServerEntry`; omit in "B" mode). */
  serverEntry?: Record<string, unknown>
}

/**
 * "B" mode: durably register the TaskWraith broker entries in the GLOBAL
 * `~/.cursor/mcp.json` so `cursor-agent mcp enable` gives them the persistent
 * "ready" approval a per-run workspace server never gets. PERSISTENT (never
 * restored — the whole point is durability) and ADDITIVE (preserves every other
 * server, incl the user's own). Idempotent: only writes when the broker entries
 * changed (the socket token rotates each launch, so this refreshes them —
 * "ready" is keyed on the server NAME, so it survives an args refresh).
 *
 * `globalMcpDir` = the user's `~/.cursor` (created if missing). Returns whether a
 * write happened. Best-effort by design at the caller; throws only on a real fs
 * failure so the caller can surface it.
 */
export function ensureGlobalCursorBrokerRegistered(
  fs: CursorConfigFs,
  globalMcpPath: string,
  globalMcpDir: string,
  brokerEntries: Record<string, unknown>
): boolean {
  const cap = captureFile(fs, globalMcpPath)
  if (!globalCursorMcpNeedsUpdate(cap.parsed, brokerEntries)) return false
  const merged = mergeGlobalCursorMcpServers(cap.parsed, brokerEntries)
  if (!fs.existsSync(globalMcpDir)) fs.mkdirSync(globalMcpDir, { recursive: true })
  fs.writeFileSync(globalMcpPath, `${JSON.stringify(merged, null, 2)}\n`)
  return true
}

export function cursorWriteModeSetupFailureMessage(error: unknown): string {
  const reason =
    error instanceof Error
      ? error.message
      : typeof error === 'string' && error.trim()
        ? error.trim()
        : 'Unknown setup error.'
  return `Cursor write-mode MCP setup failed, so this run was stopped instead of silently degrading to a tool-less read-only run (which would reject every TaskWraith tool call). ${reason}`
}

interface CapturedFile {
  existed: boolean
  original: string | null
  parsed: unknown
}

/** Snapshot a JSON config file's prior bytes + parsed value for later restore. */
function captureFile(fs: CursorConfigFs, path: string): CapturedFile {
  const existed = fs.existsSync(path)
  let original: string | null = null
  if (existed) {
    try {
      original = fs.readFileSync(path, 'utf8')
    } catch {
      original = null
    }
  }
  let parsed: unknown = null
  if (original) {
    try {
      parsed = JSON.parse(original)
    } catch {
      parsed = null
    }
  }
  return { existed, original, parsed }
}

/** Restore a captured file: rewrite original bytes if it existed, else remove. */
function restoreFile(fs: CursorConfigFs, path: string, cap: CapturedFile): void {
  try {
    if (cap.existed && cap.original != null) {
      fs.writeFileSync(path, cap.original)
    } else {
      fs.rmSync(path, { force: true })
    }
  } catch {
    // Best-effort restore; never throws.
  }
}

/**
 * Apply the write-mode deny-list to `configPath` (inside `dirPath` = workspace
 * `.cursor/`), optionally also setting up the MCP bridge (`bridge`). Returns an
 * idempotent `restore()` to call when the run ends: rewrites the original bytes
 * of each touched file if it existed, else removes it (and the `.cursor` dir if
 * we created it). Never throws on restore (best-effort).
 */
export function applyCursorWriteModeConfig(
  fs: CursorConfigFs,
  configPath: string,
  dirPath: string,
  bridge?: CursorMcpBridgeOptions,
  options?: { fullAccess?: boolean }
): () => void {
  const dirExisted = fs.existsSync(dirPath)

  // cli.json: deny the native shell (write containment) + optionally allow the
  // bridge's MCP tools — merged into a single write so there's one file state.
  // Full Workspace Access: a signed full_access run drops the native shell/write
  // deny-list entirely (parity with Codex danger-full-access + Grok write mode),
  // so Cursor's native shell/writes run unmediated. The caller gates this strictly
  // on the post-clamp trusted grant; every other write run keeps the containment.
  const denyRules = options?.fullAccess ? [] : CURSOR_WRITE_MODE_DENY_RULES
  const cli = captureFile(fs, configPath)
  let cliMerged = mergeCursorDenyRules(cli.parsed, denyRules)
  if (bridge) cliMerged = mergeCursorAllowRules(cliMerged, bridge.allowRules)

  // mcp.json: register the TaskWraith server — only when the bridge supplies BOTH a
  // path and an entry. "B" mode omits them (it relies on the user's approved
  // global server), so only the cli.json allow rule above is written.
  const mcpConfigPath = bridge?.mcpConfigPath
  const serverEntry = bridge?.serverEntry
  const writeMcp = Boolean(mcpConfigPath && serverEntry)
  const mcp = writeMcp && mcpConfigPath ? captureFile(fs, mcpConfigPath) : null
  const mcpMerged =
    writeMcp && serverEntry ? mergeCursorMcpConfig(mcp?.parsed ?? null, serverEntry) : null

  if (!dirExisted) fs.mkdirSync(dirPath, { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify(cliMerged, null, 2)}\n`)
  if (mcpConfigPath && mcpMerged) {
    fs.writeFileSync(mcpConfigPath, `${JSON.stringify(mcpMerged, null, 2)}\n`)
  }

  let restored = false
  return () => {
    if (restored) return
    restored = true
    restoreFile(fs, configPath, cli)
    if (mcpConfigPath && mcp) restoreFile(fs, mcpConfigPath, mcp)
    // Remove the `.cursor` dir only if WE created it (it's ours to clean).
    if (!dirExisted) {
      try {
        fs.rmSync(dirPath, { force: true, recursive: true })
      } catch {
        // Best-effort; never throws.
      }
    }
  }
}
