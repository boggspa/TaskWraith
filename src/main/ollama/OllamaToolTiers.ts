import { TASKWRAITH_MCP_TOOLS, type TaskWraithMcpToolName } from '../TaskWraithMcpTools'
import type { OllamaToolControlTier } from '../store/types'

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
