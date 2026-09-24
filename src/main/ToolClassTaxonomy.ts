/**
 * Permission-posture projection of the exhaustive provider/action taxonomy.
 *
 * Canonical TaskWraith tools have no classifier fallback: their class is
 * declared alongside service, operation, dispatcher, mutation, and lock
 * semantics in `shared/providerActionTaxonomy`. Arbitrary historical labels
 * remain renderable through the explicitly display-only helper below.
 */

import {
  TASKWRAITH_TOOL_ACTIONS,
  resolveToolDispatchContractStrict,
  type CanonicalToolClass,
  type TaskWraithOwnedMcpToolName,
  type UnmappedProviderAction
} from '../shared/providerActionTaxonomy'
import { resolveCatalogToolName } from '../shared/canonicalToolCoalesce'
import type { TaskWraithMcpToolName } from './TaskWraithMcpTools'
import {
  MCP_APP_STATE_MUTATION_TOOLS,
  MCP_ENSEMBLE_PARTICIPATION_TOOLS
} from './mcp/McpAutoAllowedTools'
import { isExactReviewerVerdictInvocation } from './ReviewerVerdictInvocation'

export type ToolClass = CanonicalToolClass

/** Display order: the allowed-under-read-only classes first, writes last. */
export const TOOL_CLASS_ORDER: readonly ToolClass[] = [
  'workspace_read',
  'web_read',
  'orchestration',
  'ui_elicitation',
  'workspace_write'
]

export const TOOL_CLASS_LABELS: Record<ToolClass, string> = {
  workspace_read: 'Workspace reads',
  web_read: 'Web reads',
  workspace_write: 'Workspace writes',
  orchestration: 'Orchestration',
  ui_elicitation: 'User prompts'
}

/**
 * The canonical read-only presentation preset. `grep` and `glob` are retained
 * as historical display aliases; authorization resolves exact catalog actions.
 */
export const READ_ONLY_TOOL_PRESET: ReadonlyArray<string> = Object.freeze([
  'read_file',
  'list_directory',
  'find_files',
  'list_chat_attachments',
  'inspect_chat_attachment',
  'grep',
  'glob',
  'workspace_search',
  'workspace_symbols',
  'git_status',
  'git_diff',
  'git_log',
  'web_search',
  'web_fetch',
  'github_ci_status',
  'attached_window_status',
  'appwatch_status',
  'ide_app_status',
  'ide_app_capabilities',
  'list_running_ides',
  'provider_auth_status',
  'list_active_runs',
  'list_background_processes',
  'read_background_process',
  'creative_app_status',
  'creative_app_capabilities',
  'approval_status',
  'list_ensemble_participants',
  'provider_usage_status',
  'ask_user_question',
  'request_tool_permission',
  'redeem_permission_opportunity',
  'goal_read',
  'goal_update',
  'update_goal',
  'goal_complete',
  'goal_blocked',
  'todo_write',
  'blackboard_post',
  'blackboard_read'
])

export function classifyCatalogTool(toolName: TaskWraithMcpToolName): ToolClass {
  return TASKWRAITH_TOOL_ACTIONS[toolName].toolClass
}

export type StrictToolClassResolution =
  | {
      readonly ok: true
      readonly toolName: Exclude<TaskWraithOwnedMcpToolName, 'capability_invoke'>
      readonly toolClass: ToolClass
    }
  | UnmappedProviderAction

/**
 * Execution/route-guard classifier. Unknown action names produce the canonical
 * typed deny; they never acquire the old generic workspace_write policy.
 */
export function resolveToolClassStrict(
  toolName: string,
  toolArgs?: unknown
): StrictToolClassResolution {
  const resolution = resolveToolDispatchContractStrict(toolName, toolArgs)
  if (!resolution.ok) return resolution
  return {
    ok: true,
    toolName: resolution.effectiveToolName,
    toolClass: resolution.toolClass
  }
}

/**
 * Permissive telemetry/UI classifier for old provider aliases and unknown
 * transcript labels. Unknown display rows remain conservatively grouped with
 * writes, but this result is never execution authority.
 */
export function classifyHistoricalToolForDisplay(name: string): ToolClass {
  const catalog = resolveCatalogToolName(name)
  return catalog ? classifyCatalogTool(catalog) : 'workspace_write'
}

/** @deprecated Display compatibility only. Strict guards use resolveToolClassStrict. */
export function classifyTool(name: string): ToolClass {
  return classifyHistoricalToolForDisplay(name)
}

/**
 * Read-only execution guard. Unmapped actions fail closed; exact audited
 * participation/reviewer exceptions remain argument-scoped as before.
 */
export function isReadOnlyBlockedTool(
  toolName: string,
  effectivePermissions?: { readOnly?: boolean },
  toolArgs?: unknown
): boolean {
  if (!effectivePermissions?.readOnly) return false
  if ((MCP_ENSEMBLE_PARTICIPATION_TOOLS as ReadonlySet<string>).has(toolName)) return false
  if (isExactReviewerVerdictInvocation(toolName, toolArgs)) return false

  const resolution = resolveToolClassStrict(toolName, toolArgs)
  if (!resolution.ok) return true
  return (
    resolution.toolClass === 'workspace_write' ||
    (MCP_APP_STATE_MUTATION_TOOLS as ReadonlySet<string>).has(resolution.toolName)
  )
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '')
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    normalized === '::' ||
    normalized === '0.0.0.0'
  ) {
    return true
  }
  const ipv4 = normalized.split('.').map((part) => Number(part))
  return (
    ipv4.length === 4 &&
    ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    ipv4[0] === 127
  )
}

function isRemoteHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const raw = value.trim()
  if (!raw) return false
  if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(?::|\/|$)/i.test(raw)) return false
  try {
    const parsed = new URL(raw)
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      !isLoopbackHostname(parsed.hostname)
    )
  } catch {
    return false
  }
}

function networkUrlArgumentIsRemote(
  effectiveToolName: string,
  toolArgs: unknown,
  targetDerived: boolean
): boolean {
  const root = recordFromUnknown(toolArgs)
  const args = targetDerived ? recordFromUnknown(root?.arguments) : root
  if (!args) return false
  if (effectiveToolName === 'browser_open') {
    return isRemoteHttpUrl(args.url ?? args.href ?? args.path)
  }
  if (effectiveToolName === 'canvas_open') {
    if (args.driver === 'device') return false
    return isRemoteHttpUrl(args.url)
  }
  if (effectiveToolName === 'canvas_navigate') {
    // History/reload/stop verbs carry no url; only a remote goto is egress.
    return isRemoteHttpUrl(args.url)
  }
  return false
}

/**
 * Network execution guard. When the network posture is deny, an unmapped tool
 * is rejected rather than assumed offline.
 */
export function isNetworkAccessBlockedTool(
  toolName: string,
  effectivePermissions?: { networkAccess?: string | null },
  settings?: { agenticServices?: { networkAccess?: string | null } | null },
  toolArgs?: unknown
): boolean {
  const networkAccess =
    settings?.agenticServices?.networkAccess === 'deny'
      ? 'deny'
      : effectivePermissions?.networkAccess
  if (networkAccess !== 'deny') return false

  const contract = resolveToolDispatchContractStrict(toolName, toolArgs)
  if (!contract.ok) return true
  if (contract.networkEgress === 'always') return true
  if (contract.networkEgress === 'none') return false
  return networkUrlArgumentIsRemote(
    contract.effectiveToolName,
    toolArgs,
    contract.resolution === 'target-derived'
  )
}

/**
 * Display grouping. Every class key is present and per-class order follows the
 * input; provider aliases/unknown historical labels intentionally use the
 * display-only classifier.
 */
export function groupToolsByClass(names: readonly string[]): Record<ToolClass, string[]> {
  const out: Record<ToolClass, string[]> = {
    workspace_read: [],
    web_read: [],
    orchestration: [],
    ui_elicitation: [],
    workspace_write: []
  }
  for (const name of names) out[classifyHistoricalToolForDisplay(name)].push(name)
  return out
}
