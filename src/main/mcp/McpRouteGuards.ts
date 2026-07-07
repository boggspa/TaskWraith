import { isAbsolute, relative, resolve } from 'path'
import type { AgentRunRoute } from '../run/AgentRunTypes'
import type { TaskWraithMcpToolName } from '../TaskWraithMcpTools'
import { classifyTool } from '../ToolClassTaxonomy'
import { MCP_APP_STATE_MUTATION_TOOLS } from './McpAutoAllowedTools'

export interface McpCallerContext {
  callerCwd?: string
  callerWorkspacePath?: string
}

export type McpGuardResult = { ok: true } | { ok: false; error: string }

export function isMutatingTaskWraithMcpTool(toolName: TaskWraithMcpToolName): boolean {
  return classifyTool(toolName) === 'workspace_write' || MCP_APP_STATE_MUTATION_TOOLS.has(toolName)
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
