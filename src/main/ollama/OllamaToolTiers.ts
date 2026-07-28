import { TASKWRAITH_MCP_TOOLS, type TaskWraithMcpToolName } from '../TaskWraithMcpTools'
import {
  PLAN_MCP_ADVERTISE_TOOLS,
  READ_ONLY_MCP_ADVERTISE_TOOLS
} from '../mcp/McpAutoAllowedTools'
import {
  GATEWAY_V9_MCP_DIRECT_TOOLS,
  taskWraithGatewayDirectToolNamesForProfile
} from '../mcp/McpToolProfiles'
import type { OllamaToolControlTier, TaskWraithMcpProfileId } from '../store/types'

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
  'github_ci_status',
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

const OLLAMA_NETWORK_TOOL_NAMES = new Set<OllamaToolName>([
  'web_search',
  'web_fetch',
  'github_ci_status'
])

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

export const OLLAMA_KNOWN_TOOL_NAMES = new Set<OllamaToolName>(TASKWRAITH_MCP_TOOLS)

/**
 * Ollama shares the exact immutable direct membership of
 * `taskwraith-gateway-v9`. Keep this as an alias, not a copied list: the profile
 * declaration is the single authority for the compact tools every fresh
 * gateway session sees. The full catalogue remains callable through the two
 * capability gateway tools, with Ollama's legacy `tool_help` kept alongside.
 * Resumed seats pass their pinned profile id to retain older direct membership.
 */
export const OLLAMA_ADVERTISED_TOOL_NAMES = GATEWAY_V9_MCP_DIRECT_TOOLS

const OLLAMA_ADVERTISED_TOOL_NAME_SET = new Set<OllamaToolName>(OLLAMA_ADVERTISED_TOOL_NAMES)
const READ_ONLY_MCP_ADVERTISE_TOOL_SET = new Set<OllamaToolName>(
  READ_ONLY_MCP_ADVERTISE_TOOLS
)
const PLAN_MCP_ADVERTISE_TOOL_SET = new Set<OllamaToolName>(PLAN_MCP_ADVERTISE_TOOLS)

/**
 * The tool NAMES advertised to a local model, honoring the run's networkAccess
 * (web tools stripped when networkAccess is 'deny') AND its permission posture
 * (the immutable gateway set intersected with the shared read-only or Plan
 * advertise set for a scoped run). Hidden tools stay reachable only as targets
 * of capability_invoke, not as extra top-level names in the fallback grammar.
 */
export function ollamaAdvertisedToolNames(
  options: {
    networkAccess?: string | null
    readOnly?: boolean
    plan?: boolean
    taskWraithMcpProfileId?: TaskWraithMcpProfileId | null
  } = {}
): OllamaToolName[] {
  // Ollama's local parser has one compact callable-name grammar. Keep Mesh on
  // capability discovery as before, while retaining the corresponding profile
  // generation for every other direct tool (including Sketch on v8-mesh).
  const localProfileId =
    options.taskWraithMcpProfileId === 'taskwraith-gateway-v7-mesh'
      ? 'taskwraith-gateway-v7'
      : options.taskWraithMcpProfileId === 'taskwraith-gateway-v8-mesh'
        ? 'taskwraith-gateway-v8'
        : options.taskWraithMcpProfileId === 'taskwraith-gateway-v9-mesh'
          ? 'taskwraith-gateway-v9'
          : options.taskWraithMcpProfileId
  const directNames = localProfileId
    ? taskWraithGatewayDirectToolNamesForProfile(localProfileId)
    : OLLAMA_ADVERTISED_TOOL_NAMES
  let names: OllamaToolName[] = [...directNames]
  if (options.networkAccess === 'deny') {
    names = names.filter((toolName) => !OLLAMA_NETWORK_TOOL_NAMES.has(toolName))
  }
  if (options.readOnly) {
    const postureNames = options.plan
      ? PLAN_MCP_ADVERTISE_TOOL_SET
      : READ_ONLY_MCP_ADVERTISE_TOOL_SET
    names = names.filter((toolName) => postureNames.has(toolName))
  }
  return names
}

/** Is this tool part of the immutable gateway direct set (vs the discovered tail)? */
export function isOllamaAdvertisedTool(toolName: string): boolean {
  return OLLAMA_ADVERTISED_TOOL_NAME_SET.has(toolName as OllamaToolName)
}

/**
 * Canonical top-level names accepted by the local parser. This intentionally
 * matches the immutable gateway direct set; hidden targets are passed as the
 * `name` argument of capability_invoke and do not widen the grammar.
 */
export function ollamaCallableToolNames(
  options: { networkAccess?: string | null } = {}
): OllamaToolName[] {
  const names: OllamaToolName[] = [...OLLAMA_ADVERTISED_TOOL_NAMES]
  return options.networkAccess === 'deny'
    ? names.filter((toolName) => !OLLAMA_NETWORK_TOOL_NAMES.has(toolName))
    : names
}

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
  // The retired tier argument no longer changes membership. Ollama shares the
  // compact gateway direct profile; hidden capabilities are invoked through the
  // gateway and retain their standard run-role policy at main's executor.
  const names: OllamaToolName[] = [...OLLAMA_ADVERTISED_TOOL_NAMES]
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
