// Cursor workspace config helpers. The transient workspace `.cursor/cli.json`
// (native-tool allow/deny rules) + `.cursor/mcp.json` (server isolation) writes
// are production-wired by runCursorProvider in index.ts, and
// ensureGlobalCursorBrokerRegistered is the GLOBAL "B"-mode broker registry the
// launch refreshes each run. These helpers are still not a sandbox by
// themselves: native-tool impact is bounded by the contained argv's
// `--sandbox enabled`, and brokered MCP tools are guarded by TaskWraith's
// gateway policy — this module only installs the files.
//
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
// SAFETY: ordinary workspaces never touch global `~/.cursor`. The transient MCP
// registry is isolated to TaskWraith-owned broker entries plus servers explicitly
// supplied from TaskWraith settings; unrelated project/global definitions are not
// carried into a `--approve-mcps` / `--force` run. Existing config bytes are
// restored exactly on completion. Symlinked config directories/files are rejected
// before any transient write. The caller stops the managed run if setup fails.
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

/** Opaque native filesystem/shell tools are blocked while the broker is active. */
export const CURSOR_WRITE_MODE_DENY_RULES: readonly string[] = [
  'Shell(**)',
  'Write(**)',
  'Read(**)',
  'Glob(**)',
  'Grep(**)'
]

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
  lstatSync(path: string): { isSymbolicLink(): boolean }
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string): void
  mkdirSync(path: string, options: { recursive: boolean }): void
  rmSync(path: string, options: { force?: boolean; recursive?: boolean }): void
}

/**
 * Optional MCP bridge setup applied alongside the native-tool deny-list.
 * `allowRules` are always merged into the cli.json write. `mcpConfigPath` +
 * `serverEntry` are OPTIONAL: supply both to install the isolated per-run
 * workspace `.cursor/mcp.json`. Current global-broker mode still supplies both
 * (with an empty settings entry map when appropriate) so project servers cannot
 * join the managed run. Omit both only when no transient MCP registry is needed.
 */
export interface CursorMcpBridgeOptions {
  /** Allow rules to add to cli.json (normally `CURSOR_MCP_ALLOW_RULES`). */
  allowRules: readonly string[]
  /** Absolute path to the workspace `.cursor/mcp.json` when isolation is required. */
  mcpConfigPath?: string
  /** Complete allowlisted `mcpServers` entries for the managed run. */
  serverEntry?: Record<string, unknown>
  /**
   * Preserve only the exact canonical TaskWraith broker registrations while
   * installing `serverEntry`.
   *
   * This is only for a global chat whose normalized workspace is the user's
   * home directory: in that case the apparent workspace config path and the
   * global registry are the same `~/.cursor/mcp.json` file. User/global servers
   * are deliberately hidden for the transient run and restored byte-for-byte
   * afterwards. Ordinary workspace configs must leave this false so a project-
   * local reserved name cannot shadow TaskWraith's canonical global broker.
   */
  preserveExistingMcpServers?: boolean
}

/**
 * "B" mode: durably register the TaskWraith broker entries in the GLOBAL
 * `~/.cursor/mcp.json` so `cursor-agent mcp enable` gives them the persistent
 * "ready" approval a per-run workspace server never gets. PERSISTENT (never
 * restored — the whole point is durability) and user-server preserving.
 * `removeServerNames` is only for obsolete TaskWraith-owned registrations that
 * would otherwise add their tools to Cursor's aggregate model catalogue.
 * Idempotent: only writes when the broker entries or removals changed (the socket
 * token rotates each launch, so this refreshes them — "ready" is keyed on the
 * server NAME, so it survives an args refresh).
 *
 * `globalMcpDir` = the user's `~/.cursor` (created if missing). Returns whether a
 * write happened. Best-effort by design at the caller; throws only on a real fs
 * failure so the caller can surface it.
 */
export function ensureGlobalCursorBrokerRegistered(
  fs: CursorConfigFs,
  globalMcpPath: string,
  globalMcpDir: string,
  brokerEntries: Record<string, unknown>,
  removeServerNames: readonly string[] = []
): boolean {
  assertNotSymlink(fs, globalMcpDir, 'global .cursor directory')
  assertNotSymlink(fs, globalMcpPath, 'global mcp.json')
  const cap = captureFile(fs, globalMcpPath)
  if (!globalCursorMcpNeedsUpdate(cap.parsed, brokerEntries, removeServerNames)) return false
  const merged = mergeGlobalCursorMcpServers(cap.parsed, brokerEntries, removeServerNames)
  if (!fs.existsSync(globalMcpDir)) fs.mkdirSync(globalMcpDir, { recursive: true })
  assertNotSymlink(fs, globalMcpDir, 'global .cursor directory')
  assertNotSymlink(fs, globalMcpPath, 'global mcp.json')
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
    // Setup must fail before mutation if exact restoration cannot be promised.
    original = fs.readFileSync(path, 'utf8')
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

function assertNotSymlink(fs: CursorConfigFs, path: string, label: string): void {
  let stat: { isSymbolicLink(): boolean }
  try {
    // lstat (rather than existsSync) is load-bearing here: existsSync follows a
    // dangling symlink and reports false, after which a write would follow it.
    stat = fs.lstatSync(path)
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return
    }
    throw error
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing Cursor config write through symlinked ${label}: ${path}`)
  }
}

function assertSafeTransientTargets(
  fs: CursorConfigFs,
  dirPath: string,
  configPath: string,
  mcpConfigPath?: string
): void {
  assertNotSymlink(fs, dirPath, '.cursor directory')
  assertNotSymlink(fs, configPath, 'cli.json')
  if (mcpConfigPath) assertNotSymlink(fs, mcpConfigPath, 'mcp.json')
}

/** Restore a captured file: rewrite original bytes if it existed, else remove. */
function restoreFile(fs: CursorConfigFs, path: string, cap: CapturedFile): void {
  try {
    if (cap.existed && cap.original != null) {
      assertNotSymlink(fs, path, 'restore target')
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
  options?: { fullAccess?: boolean; denyRules?: readonly string[] }
): () => void {
  const mcpConfigPath = bridge?.mcpConfigPath
  const serverEntry = bridge?.serverEntry
  const writeMcp = Boolean(mcpConfigPath && serverEntry)
  assertSafeTransientTargets(fs, dirPath, configPath, writeMcp ? mcpConfigPath : undefined)

  const dirExisted = fs.existsSync(dirPath)

  // cli.json: deny native tools per the caller's seat posture + optionally
  // allow the bridge's MCP tools — merged into a single write so there's one
  // file state. The deny-list defaults to the containment-era full set (every
  // opaque native tool routed through the broker). Production Cursor seats now
  // keep native tools callable (bounded by the argv's `--sandbox enabled`), so
  // `runCursorProvider` passes a narrower list: write seats pass [] (native
  // shell/write stay available, sandbox-bounded — the both-stacks directive);
  // read-only seats deny only the native mutators (Shell/Write) so the
  // read-only posture holds on the native stack as well as the broker.
  // Full Workspace Access expands what the signed TaskWraith broker may do in
  // the canonical workspace. It never authorizes Cursor's opaque native tools
  // to open arbitrary host paths under `--force`.
  void options?.fullAccess
  const denyRules = options?.denyRules ?? CURSOR_WRITE_MODE_DENY_RULES
  const cli = captureFile(fs, configPath)
  let cliMerged = mergeCursorDenyRules(cli.parsed, denyRules)
  if (bridge) cliMerged = mergeCursorAllowRules(cliMerged, bridge.allowRules)

  // mcp.json: install the complete isolated server set only when the bridge
  // supplies BOTH a path and an entry. Global-broker mode also uses this path to
  // hide project servers while retaining the canonical global broker when the
  // workspace aliases Home.
  const mcp = writeMcp && mcpConfigPath ? captureFile(fs, mcpConfigPath) : null
  const mcpMerged =
    writeMcp && serverEntry
      ? mergeCursorMcpConfig(mcp?.parsed ?? null, serverEntry, {
          preserveExistingTaskWraithBrokers: bridge?.preserveExistingMcpServers
        })
      : null

  try {
    if (!dirExisted) fs.mkdirSync(dirPath, { recursive: true })
    // Recheck after directory creation and immediately before each write. This
    // does not claim to solve hostile filesystem races, but it ensures existing
    // and setup-time symlinks are never followed.
    assertSafeTransientTargets(fs, dirPath, configPath, writeMcp ? mcpConfigPath : undefined)
    fs.writeFileSync(configPath, `${JSON.stringify(cliMerged, null, 2)}\n`)
    if (mcpConfigPath && mcpMerged) {
      assertSafeTransientTargets(fs, dirPath, configPath, mcpConfigPath)
      fs.writeFileSync(mcpConfigPath, `${JSON.stringify(mcpMerged, null, 2)}\n`)
    }
  } catch (error) {
    restoreFile(fs, configPath, cli)
    if (mcpConfigPath && mcp) restoreFile(fs, mcpConfigPath, mcp)
    if (!dirExisted) {
      try {
        fs.rmSync(dirPath, { force: true, recursive: true })
      } catch {
        // Preserve the setup error; cleanup is best-effort.
      }
    }
    throw error
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
