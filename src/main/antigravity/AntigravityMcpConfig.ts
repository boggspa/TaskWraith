// TaskWraith MCP registration for the official `agy` CLI lane.
//
// MEASURED 2026-08-19 against the shipped agy binary's own embedded docs and a
// live session log. Two facts decide this module's whole shape:
//
//   1. agy reads MCP servers from `<gemini-root>/config/mcp_config.json` — the
//      MIGRATED global path. It does NOT read `<gemini-root>/settings.json`'s
//      `mcpServers` map; that is Gemini CLI's legacy location, which TaskWraith
//      still writes for the retired `gemini` provider. A machine can therefore
//      hold a complete 207-tool TaskWraith registration that agy never sees,
//      which is exactly what a live ensemble seat hit: it reported having no
//      TaskWraith MCP profile and delegated its blackboard write to a peer,
//      while agy logged `empty component: prompt section "mcp_servers"`.
//   2. The document is a plain `{ "mcpServers": { <id>: <spec> } }` map with
//      stdio (`command`/`args`/`env`) or SSE (`serverUrl`) specs.
//
// An ABSENT or EMPTY file is the normal first-run state (agy creates a 0-byte
// `mcp_config.json` at migration), so empty input must project to an empty
// document rather than reading as corrupt — otherwise the registration could
// never install on precisely the machines that need it. Unparseable content is
// different: it is someone else's data, so this module refuses rather than
// clobbering it, and the caller leaves the lane exactly as it found it.
//
// User-installed servers are always preserved. Only TaskWraith's own
// registration key (and its historical rebrands) is ever replaced or removed,
// mirroring `KimiMcpBridge`'s ownership rule.
//
// Kept free of Electron / fs / IPC imports so it unit-tests directly against
// fixed inputs; the caller owns the atomic write and the restore receipt.

import { join } from 'node:path'
import { agyCliRootPath } from './AntigravityConversationReceipt'

/**
 * Registration key. Matches the Gemini / Codex / Claude / Kimi bridge name so
 * the broker's server-side identity is consistent across providers, and so the
 * namespace agy prefixes onto each tool reads as `TaskWraith__<tool>`.
 */
export const AGY_TASKWRAITH_MCP_SERVER_NAME = 'TaskWraith'

/** Historical rebrands. Replaced/removed on sight so a stale key cannot
 * shadow the live registration or leave a dead server in agy's tool list. */
export const AGY_LEGACY_TASKWRAITH_MCP_SERVER_NAMES = ['agentbench', 'AGBench'] as const

/** agy refuses to load a document larger than this is worth reading; the cap
 * exists so a hostile or runaway file cannot be pulled into memory wholesale. */
export const AGY_MCP_CONFIG_MAX_BYTES = 1024 * 1024

export interface AgyMcpServerRegistration {
  /** Absolute path of the TaskWraith binary that hosts the MCP bridge. */
  command: string
  /** argv for the bridge subprocess; carries no socket path or broker token. */
  args: readonly string[]
  /** Static, non-secret env. Live endpoint authority rides the agy child's own
   * environment (`parseMcpBridgeRouteFromEnv`), never this persisted file. */
  env?: Readonly<Record<string, string>>
}

export interface AgyMcpConfigDocument {
  mcpServers: Record<string, unknown>
}

export type AgyMcpConfigParse =
  | { status: 'ok'; document: AgyMcpConfigDocument }
  /** Absent or byte-empty — the normal first-run state, safe to install into. */
  | { status: 'empty' }
  /** Present but not a readable server map: never overwritten. */
  | { status: 'unreadable' }

/**
 * `<gemini-root>/config/mcp_config.json`.
 *
 * The root honours `GEMINI_CLI_HOME` / `GEMINI_HOME` through the shared
 * resolver: `createAgyCliEnv` strips only credential keys, so a user override
 * reaches the agy child and a hard-coded `~/.gemini` would write a file the
 * child never reads.
 */
export function agyGlobalMcpConfigPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  homeDir?: string
): string {
  const root = homeDir === undefined ? agyCliRootPath(env) : agyCliRootPath(env, homeDir)
  return join(root, 'config', 'mcp_config.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isTaskWraithOwnedAgyMcpServerName(name: string): boolean {
  const normalized = name.trim().toLowerCase()
  return [AGY_TASKWRAITH_MCP_SERVER_NAME, ...AGY_LEGACY_TASKWRAITH_MCP_SERVER_NAMES].some(
    (owned) => owned.toLowerCase() === normalized
  )
}

/**
 * Read an existing document conservatively. `null`/`undefined`/blank is the
 * agy first-run state and reports `empty`; anything present but unreadable
 * reports `unreadable` so the caller declines to touch it.
 */
export function parseAgyMcpConfigDocument(raw: string | null | undefined): AgyMcpConfigParse {
  if (raw === null || raw === undefined) return { status: 'empty' }
  if (typeof raw !== 'string') return { status: 'unreadable' }
  if (!raw.trim()) return { status: 'empty' }
  if (Buffer.byteLength(raw, 'utf8') > AGY_MCP_CONFIG_MAX_BYTES) return { status: 'unreadable' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { status: 'unreadable' }
  }
  if (!isRecord(parsed)) return { status: 'unreadable' }
  const servers = parsed.mcpServers
  // A document with no `mcpServers` key at all is still a document; agy treats
  // it as "no servers". Only a present-but-wrong-shaped map is unreadable.
  if (servers !== undefined && !isRecord(servers)) return { status: 'unreadable' }
  return {
    status: 'ok',
    document: { mcpServers: isRecord(servers) ? { ...servers } : {} }
  }
}

export interface BuildAgyMcpConfigInput {
  /** Existing on-disk projection; `empty` and absent both mean "no servers". */
  existing?: AgyMcpConfigDocument | null
  /** Omit or pass null to REMOVE TaskWraith's registration and leave the
   * user's own servers untouched — the restore path for a disabled lane. */
  taskWraith?: AgyMcpServerRegistration | null
}

/**
 * Project the document agy should hold for this machine.
 *
 * Foreign servers survive verbatim and keep their original relative order;
 * TaskWraith's key is rewritten last so a fresh registration always wins over
 * a stale one, and every legacy rebrand is dropped.
 */
export function buildAgyMcpConfigDocument(input: BuildAgyMcpConfigInput): AgyMcpConfigDocument {
  const existingServers = isRecord(input.existing?.mcpServers) ? input.existing!.mcpServers : {}
  const mcpServers: Record<string, unknown> = {}
  for (const [name, definition] of Object.entries(existingServers)) {
    if (!isTaskWraithOwnedAgyMcpServerName(name)) mcpServers[name] = definition
  }
  if (input.taskWraith) {
    mcpServers[AGY_TASKWRAITH_MCP_SERVER_NAME] = {
      command: input.taskWraith.command,
      args: [...input.taskWraith.args],
      env: {
        ...(input.taskWraith.env || {}),
        TASKWRAITH_PARENT_PROVIDER: 'antigravity'
      }
    }
  }
  return { mcpServers }
}

/** Serialize for atomic write. Trailing newline matches agy's own writer. */
export function serializeAgyMcpConfigDocument(document: AgyMcpConfigDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

/**
 * True when the projected document differs from what is already on disk, so a
 * caller can skip the write (and its restore receipt) entirely. Compared on
 * the parsed projection rather than raw bytes: agy rewrites this file itself
 * when the user toggles a server in the TUI, and re-formatting alone is not a
 * reason to take a lease on someone else's config.
 */
export function agyMcpConfigNeedsUpdate(
  existing: AgyMcpConfigParse,
  projected: AgyMcpConfigDocument
): boolean {
  if (existing.status === 'unreadable') return false
  const current = existing.status === 'ok' ? existing.document : { mcpServers: {} }
  return JSON.stringify(current.mcpServers) !== JSON.stringify(projected.mcpServers)
}
