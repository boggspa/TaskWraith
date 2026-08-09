import { isAbsolute, relative, resolve } from 'path'
import type { AgentRunRoute } from '../run/AgentRunTypes'
import {
  isTaskWraithCatalogAction,
  resolveToolDispatchContractStrict
} from '../../shared/providerActionTaxonomy'
import { MCP_APP_STATE_MUTATION_TOOLS } from './McpAutoAllowedTools'
import { OUTLOOK_MCP_TOOL_NAMES } from './OutlookToolExecutors'
import { MESH_MCP_TOOL_NAMES } from '../TaskWraithMcpTools'

const OUTLOOK_ALWAYS_PROMPT_TOOLS = new Set<string>(OUTLOOK_MCP_TOOL_NAMES)

export interface McpCallerContext {
  callerCwd?: string
  callerWorkspacePath?: string
  /**
   * Server-derived fixed tool ceiling for constrained transports such as Pi's
   * per-run extension. It must survive nested gateway/permission dispatch so
   * an allowed wrapper cannot widen the credential's original authority.
   */
  fixedToolAllowlist?: readonly string[]
}

export type McpGuardResult = { ok: true } | { ok: false; error: string }

export function validateMcpCallerToolAllowlist(
  toolName: string,
  caller?: McpCallerContext
): McpGuardResult {
  const allowlist = caller?.fixedToolAllowlist
  if (!allowlist) return { ok: true }
  if (allowlist.includes(toolName)) return { ok: true }
  return {
    ok: false,
    error: `The caller's fixed run-bound tool credential does not permit ${toolName}.`
  }
}

export function isMutatingTaskWraithMcpTool(toolName: string, toolArgs?: unknown): boolean {
  const contract = resolveToolDispatchContractStrict(toolName, toolArgs)
  if (!contract.ok) return true
  return (
    contract.toolClass === 'workspace_write' ||
    (isTaskWraithCatalogAction(contract.effectiveToolName) &&
      MCP_APP_STATE_MUTATION_TOOLS.has(contract.effectiveToolName))
  )
}

/**
 * Tools whose approval prompt must reach a human on EVERY call, regardless of
 * standing grants, trusted-session state or session-YOLO.
 *
 * Most are a channel between the agent and a third party that no amount of prior
 * trust in the workspace covers:
 *  - `image_generate` ships agent-chosen text off-box to a third-party API.
 *  - `canvas_eval` executes agent-authored JavaScript.
 *  - Outlook reads pull a stranger's words into the model's context; Outlook
 *    writes put agent-chosen text and recipients into a real mailbox. Both
 *    halves of that channel are prompt-injection surface, so both prompt.
 *
 * `theme_tokens_set` is here for a DIFFERENT reason, and the distinction matters:
 * it sends nothing anywhere. It mutates the window the human reads every later
 * approval in. A standing grant would therefore buy the agent silent, repeatable
 * edits to the presentation surface that every subsequent trust decision is made
 * on — so the user's rule for this capability was "never auto-allow, never
 * elevate". `forcePrompt` is the only mechanism that actually spells that, since
 * it is checked ahead of Bossman auto-approval and trusted-session auto-allow.
 * The `shared/agentThemeTokens` allowlist is the other half and the stronger one:
 * no text colour, background, approval-sheet geometry or focus ring is writable
 * at all, so a granted restyle could never have hidden or falsified consent UI.
 * This closes the residual gap that both halves left — that appearance writes
 * ride the generic `mcpTools` service, so ONE session grant on any unrelated MCP
 * tool would silence them. `theme_tokens_get` is a pure read and stays off this
 * list.
 *
 * Global-scope chats prompt for everything except chat-local Mesh Canvas state.
 * Mesh workspace imports independently require a workspace and remain denied
 * when none exists.
 */
export function mcpToolAlwaysPrompts(
  toolName: string,
  scope?: string,
  toolArgs?: unknown
): boolean {
  const contract = resolveToolDispatchContractStrict(toolName, toolArgs)
  const effectiveToolName = contract.ok ? contract.effectiveToolName : toolName
  if (scope === 'global') {
    return !(MESH_MCP_TOOL_NAMES as readonly string[]).includes(effectiveToolName)
  }
  return (
    effectiveToolName === 'image_generate' ||
    effectiveToolName === 'canvas_eval' ||
    effectiveToolName === 'theme_tokens_set' ||
    OUTLOOK_ALWAYS_PROMPT_TOOLS.has(effectiveToolName)
  )
}

export function hasExplicitMcpRoute(route?: AgentRunRoute | null): boolean {
  return Boolean(route?.appRunId || route?.appChatId)
}

export function validateMutatingMcpRoute(
  toolName: string,
  route?: AgentRunRoute | null,
  toolArgs?: unknown
): McpGuardResult {
  if (!isMutatingTaskWraithMcpTool(toolName, toolArgs) || hasExplicitMcpRoute(route)) {
    return { ok: true }
  }
  return {
    ok: false,
    error: `TaskWraith blocked unrouted mutating MCP tool call "${toolName}". Bridge calls that can mutate workspace or app state must provide TASKWRAITH_RUN_ID or TASKWRAITH_CHAT_ID; the single-active-run fallback is only allowed for read-only tools.`
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

export function mcpCallerWorkspaceCandidate(caller?: McpCallerContext | null): string | null {
  return nonEmptyString(caller?.callerWorkspacePath) || nonEmptyString(caller?.callerCwd)
}

export function isPathWithinOrEqual(candidatePath: string, parentPath: string): boolean {
  const candidate = resolve(candidatePath)
  const parent = resolve(parentPath)
  const delta = relative(parent, candidate)
  return delta === '' || (!!delta && !delta.startsWith('..') && !isAbsolute(delta))
}

export function pathsShareWorkspaceLineage(
  callerPath: string,
  contextWorkspacePath: string
): boolean {
  return (
    isPathWithinOrEqual(callerPath, contextWorkspacePath) ||
    isPathWithinOrEqual(contextWorkspacePath, callerPath)
  )
}

export function validateMcpCallerWorkspace(input: {
  toolName: string
  toolArgs?: unknown
  caller?: McpCallerContext | null
  contextWorkspacePath?: string | null
}): McpGuardResult {
  if (!isMutatingTaskWraithMcpTool(input.toolName, input.toolArgs)) return { ok: true }
  if (!input.caller || !input.contextWorkspacePath) return { ok: true }
  const callerWorkspace = mcpCallerWorkspaceCandidate(input.caller)
  if (!callerWorkspace) {
    return {
      ok: false,
      error: `TaskWraith blocked mutating MCP tool call "${input.toolName}" because the bridge did not provide caller workspace metadata.`
    }
  }
  if (pathsShareWorkspaceLineage(callerWorkspace, input.contextWorkspacePath)) return { ok: true }
  return {
    ok: false,
    error: `TaskWraith blocked mutating MCP tool call "${input.toolName}" because the bridge caller workspace (${callerWorkspace}) does not match the resolved run workspace (${input.contextWorkspacePath}).`
  }
}
