import { TASKWRAITH_MCP_TOOLS, type TaskWraithMcpToolName } from '../TaskWraithMcpTools'
import type { AppSettings, OllamaToolControlTier } from '../store/types'

export type OllamaToolName = TaskWraithMcpToolName

export const OLLAMA_READ_TOOL_NAMES = [
  'read_file',
  'list_directory',
  'find_files',
  'workspace_search',
  'workspace_symbols',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_blame',
  'test_result_summary',
  'list_active_runs',
  'web_search',
  'web_fetch',
  'ask_user_question',
  'goal_read',
  'goal_update',
  'goal_complete',
  'goal_blocked',
  // Cross-thread recall is read-only retrospection — default-tier Ollama (the
  // local-model persona this feature targets) can call it. Cross-workspace
  // reads are still gated by the crossThreadRead approval service.
  'tw_recall_find',
  'tw_recall_read',
  'tw_recall_read_events'
] as const satisfies readonly OllamaToolName[]

const OLLAMA_NETWORK_TOOL_NAMES = new Set<OllamaToolName>(['web_search', 'web_fetch'])

export const OLLAMA_FILE_EDIT_TOOL_NAMES = [
  'write_file',
  'replace',
  'create_directory',
  'delete_path',
  'move_path',
  'rename_path',
  'apply_patch'
] as const satisfies readonly OllamaToolName[]

export const OLLAMA_SHELL_TOOL_NAMES = [
  'run_shell_command',
  'run_task',
  'get_diagnostics'
] as const satisfies readonly OllamaToolName[]

export const OLLAMA_REMOTE_GIT_TOOL_NAMES = [
  'git_push',
  'git_create_pr'
] as const satisfies readonly OllamaToolName[]

export const OLLAMA_PROCESS_CONTROL_TOOL_NAMES = [
  'cancel_active_run'
] as const satisfies readonly OllamaToolName[]

/** Non-mutating coordination tools unlocked at tier 3 (approved edits) and above. */
export const OLLAMA_TIER3_COORDINATION_TOOL_NAMES = [
  'todo_write'
] as const satisfies readonly OllamaToolName[]

const OLLAMA_TIER4_EXTRA_TOOL_NAMES = TASKWRAITH_MCP_TOOLS.filter(
  (toolName) =>
    !OLLAMA_READ_TOOL_NAMES.includes(toolName as (typeof OLLAMA_READ_TOOL_NAMES)[number]) &&
    !OLLAMA_FILE_EDIT_TOOL_NAMES.includes(
      toolName as (typeof OLLAMA_FILE_EDIT_TOOL_NAMES)[number]
    ) &&
    !OLLAMA_SHELL_TOOL_NAMES.includes(toolName as (typeof OLLAMA_SHELL_TOOL_NAMES)[number]) &&
    !OLLAMA_REMOTE_GIT_TOOL_NAMES.includes(
      toolName as (typeof OLLAMA_REMOTE_GIT_TOOL_NAMES)[number]
    ) &&
    !OLLAMA_PROCESS_CONTROL_TOOL_NAMES.includes(
      toolName as (typeof OLLAMA_PROCESS_CONTROL_TOOL_NAMES)[number]
    ) &&
    !OLLAMA_TIER3_COORDINATION_TOOL_NAMES.includes(
      toolName as (typeof OLLAMA_TIER3_COORDINATION_TOOL_NAMES)[number]
    )
) as OllamaToolName[]

export const OLLAMA_KNOWN_TOOL_NAMES = new Set<OllamaToolName>(TASKWRAITH_MCP_TOOLS)

export function normalizeOllamaToolControlTier(value?: string | null): OllamaToolControlTier {
  if (value === 'approved_edits' || value === 'approved_shell' || value === 'provider_parity') {
    return value
  }
  return 'read_only'
}

/** Strict membership test for the 4 tier values. Unlike
 * normalizeOllamaToolControlTier (which coerces anything unknown to read_only),
 * this distinguishes "a real tier was chosen" from "nothing/garbage" — so a
 * per-chat override can fall back to the global default instead of silently
 * downgrading to read_only when the stored value is absent or malformed. */
export function isOllamaToolControlTier(value: unknown): value is OllamaToolControlTier {
  return (
    value === 'read_only' ||
    value === 'approved_edits' ||
    value === 'approved_shell' ||
    value === 'provider_parity'
  )
}

/**
 * Read a chat's per-chat Ollama tool-control tier out of its (untyped)
 * `providerMetadata`, validated. Returns `undefined` when the field is absent or
 * not one of the four tier ids, so callers fall back to the GLOBAL tier via
 * `effectiveOllamaToolControlTier` (never a silent read_only). Mirrors the
 * renderer coalesce in App.tsx `getChatComposerSelection` and the desktop
 * `ComposerService` read — the single source of truth for "what tier did this
 * chat pick" used by the mid-run tool gates.
 */
export function chatOllamaToolControlTier(
  providerMetadata: Record<string, unknown> | null | undefined
): OllamaToolControlTier | undefined {
  const raw = providerMetadata?.ollamaToolControlTier
  return isOllamaToolControlTier(raw) ? raw : undefined
}

export function ollamaToolNamesForTier(
  _tier: OllamaToolControlTier | string | undefined | null,
  options: { networkAccess?: string | null } = {}
): OllamaToolName[] {
  // Tier retirement (2026-07): local Ollama models now get the SAME full tool
  // surface as every first-party provider, governed by the standard permission
  // ROLE at the approval gate (read_only/plan DENY writes+shell; default
  // PROMPTS; workspace_write/full_access honor grants) — not by an Ollama-only
  // tier ladder. The `_tier` arg is retained for call-site compatibility but no
  // longer narrows the surface. The ONLY remaining filter is networkAccess:
  // web_search/web_fetch are stripped when the run's networkAccess is 'deny'
  // (global kill switch or a preview-risk model), matching the gate's
  // networkAccessBlockedToolName check so advertised == executable.
  const names: OllamaToolName[] = [
    ...OLLAMA_READ_TOOL_NAMES,
    ...OLLAMA_FILE_EDIT_TOOL_NAMES,
    ...OLLAMA_SHELL_TOOL_NAMES,
    ...OLLAMA_REMOTE_GIT_TOOL_NAMES,
    ...OLLAMA_PROCESS_CONTROL_TOOL_NAMES,
    ...OLLAMA_TIER3_COORDINATION_TOOL_NAMES,
    ...OLLAMA_TIER4_EXTRA_TOOL_NAMES
  ]
  return options.networkAccess === 'deny'
    ? names.filter((toolName) => !OLLAMA_NETWORK_TOOL_NAMES.has(toolName))
    : names
}

/**
 * Canonicalize a workspace path for provider-parity grant comparison so a grant
 * recorded from the renderer's raw `currentWorkspace.path` still matches the
 * (often node-canonicalized) lookup path used on the run/execution side — a
 * trailing slash or a `.`/`..`/`//` segment must not silently fail the lookup
 * and collapse Tier 4 to read-only.
 *
 * MUST stay PURE (no `os`/`path` node builtins): this module is pulled into the
 * RENDERER bundle transitively via ProviderCapabilities, and node builtins are
 * externalized in the browser build (a node import here blanks the renderer).
 * `~` is intentionally NOT expanded — workspace paths from the folder picker are
 * absolute, and the node execution gate still expands `~` on its own lookup arg.
 */
export function canonicalizeOllamaWorkspacePath(value?: string | null): string {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const isAbsolute = raw.startsWith('/')
  const segments: string[] = []
  for (const segment of raw.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop()
      } else if (!isAbsolute) {
        segments.push('..')
      }
      continue
    }
    segments.push(segment)
  }
  const joined = segments.join('/')
  return isAbsolute ? `/${joined}` : joined
}

export function ollamaProviderParityWorkspaceGranted(
  settings: Pick<AppSettings, 'ollamaProviderParityWorkspaceGrants'>,
  workspacePath?: string | null
): boolean {
  const target = canonicalizeOllamaWorkspacePath(workspacePath)
  if (!target) return false
  const grants = settings.ollamaProviderParityWorkspaceGrants || {}
  // Compare canonical forms on BOTH sides. Grants were historically keyed by the
  // renderer's raw workspace path, while callers (e.g. the execution gate) now look
  // up with a canonicalized path — an exact-string match silently misses on any
  // path-form difference, which is the dominant "I granted parity but it still
  // won't edit" failure.
  for (const [key, grantedAt] of Object.entries(grants)) {
    if (typeof grantedAt !== 'string' || grantedAt.trim().length === 0) continue
    if (canonicalizeOllamaWorkspacePath(key) === target) return true
  }
  return false
}

export function effectiveOllamaToolControlTier(
  settings: Pick<AppSettings, 'ollamaToolControlTier' | 'ollamaProviderParityWorkspaceGrants'>,
  workspacePath?: string | null,
  chatTier?: OllamaToolControlTier | string | null
): OllamaToolControlTier {
  // A per-chat tier (the composer tier picker) takes precedence over the global
  // setting; an absent OR unrecognised chat tier falls back to the global
  // default — NOT a silent read_only downgrade. Tier 4 (provider_parity) is
  // still gated by the per-workspace parity grant wherever the tier was chosen.
  const selected = isOllamaToolControlTier(chatTier) ? chatTier : settings.ollamaToolControlTier
  const tier = normalizeOllamaToolControlTier(selected)
  if (tier !== 'provider_parity') return tier
  return ollamaProviderParityWorkspaceGranted(settings, workspacePath)
    ? 'provider_parity'
    : 'read_only'
}

/**
 * Resolve the tier used by a local Ollama tool execution. A live run passes its
 * run-start tier on every tool request; that carried tier is the auditable
 * receipt for the advertised tool surface and must not be re-derived from
 * mutable settings mid-run. Older/internal callers that do not carry a tier keep
 * the historical live fallback.
 */
export function resolveOllamaExecutionToolControlTier(
  settings: Pick<AppSettings, 'ollamaToolControlTier' | 'ollamaProviderParityWorkspaceGrants'>,
  workspacePath?: string | null,
  requestTier?: OllamaToolControlTier | string | null,
  chatTier?: OllamaToolControlTier | string | null
): OllamaToolControlTier {
  return isOllamaToolControlTier(requestTier)
    ? requestTier
    : effectiveOllamaToolControlTier(settings, workspacePath, chatTier)
}

export function ollamaToolAllowedInTier(
  toolName: string,
  tier: OllamaToolControlTier | string | undefined | null,
  options: { networkAccess?: string | null } = {}
): boolean {
  return ollamaToolNamesForTier(tier, options).includes(toolName as OllamaToolName)
}

export function ollamaToolRequiresIntent(toolName: string): boolean {
  return (
    OLLAMA_FILE_EDIT_TOOL_NAMES.includes(
      toolName as (typeof OLLAMA_FILE_EDIT_TOOL_NAMES)[number]
    ) ||
    OLLAMA_SHELL_TOOL_NAMES.includes(toolName as (typeof OLLAMA_SHELL_TOOL_NAMES)[number]) ||
    OLLAMA_REMOTE_GIT_TOOL_NAMES.includes(
      toolName as (typeof OLLAMA_REMOTE_GIT_TOOL_NAMES)[number]
    ) ||
    OLLAMA_PROCESS_CONTROL_TOOL_NAMES.includes(
      toolName as (typeof OLLAMA_PROCESS_CONTROL_TOOL_NAMES)[number]
    )
  )
}

export function ollamaToolIntent(args: Record<string, unknown>): string {
  return String(args.intent || args.summary || args.reason || args.description || '').trim()
}

export function ollamaTierLabel(tier: OllamaToolControlTier): string {
  if (tier === 'provider_parity') return 'provider-parity'
  if (tier === 'approved_shell') return 'approved shell'
  if (tier === 'approved_edits') return 'approved file-edit'
  return 'read-only workspace'
}
