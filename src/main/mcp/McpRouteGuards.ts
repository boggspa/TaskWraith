import { isAbsolute, relative, resolve } from 'path'
import type { AgentRunRoute } from '../run/AgentRunTypes'
import type { TaskWraithMcpToolName } from '../TaskWraithMcpTools'
import { classifyTool } from '../ToolClassTaxonomy'
import { MCP_APP_STATE_MUTATION_TOOLS } from './McpAutoAllowedTools'
import { OUTLOOK_MCP_TOOL_NAMES } from './OutlookToolExecutors'

const OUTLOOK_ALWAYS_PROMPT_TOOLS = new Set<string>(OUTLOOK_MCP_TOOL_NAMES)

export interface McpCallerContext {
  callerCwd?: string
  callerWorkspacePath?: string
}

export type McpGuardResult = { ok: true } | { ok: false; error: string }

export function isMutatingTaskWraithMcpTool(toolName: TaskWraithMcpToolName): boolean {
  return classifyTool(toolName) === 'workspace_write' || MCP_APP_STATE_MUTATION_TOOLS.has(toolName)
}

/**
 * Tools whose approval prompt must reach a human on EVERY call, regardless of
 * standing grants, trusted-session state or session-YOLO.
 *
 * The shared property is a channel between the agent and a third party that no
 * amount of prior trust in the workspace covers:
 *  - `image_generate` ships agent-chosen text off-box to a third-party API.
 *  - `canvas_eval` executes agent-authored JavaScript.
 *  - Outlook reads pull a stranger's words into the model's context; Outlook
 *    writes put agent-chosen text and recipients into a real mailbox. Both
 *    halves of that channel are prompt-injection surface, so both prompt.
 *
 * Global-scope chats prompt for everything, which is why scope is a parameter
 * rather than a caller-side `||`.
 */
export function mcpToolAlwaysPrompts(toolName: string, scope?: string): boolean {
  if (scope === 'global') return true
  return (
    toolName === 'image_generate' ||
    toolName === 'canvas_eval' ||
    OUTLOOK_ALWAYS_PROMPT_TOOLS.has(toolName)
  )
}

export function hasExplicitMcpRoute(route?: AgentRunRoute | null): boolean {
  return Boolean(route?.appRunId || route?.appChatId)
}

export function validateMutatingMcpRoute(
  toolName: TaskWraithMcpToolName,
  route?: AgentRunRoute | null
): McpGuardResult {
  if (!isMutatingTaskWraithMcpTool(toolName) || hasExplicitMcpRoute(route)) return { ok: true }
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
  toolName: TaskWraithMcpToolName
  caller?: McpCallerContext | null
  contextWorkspacePath?: string | null
}): McpGuardResult {
  if (!isMutatingTaskWraithMcpTool(input.toolName)) return { ok: true }
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
