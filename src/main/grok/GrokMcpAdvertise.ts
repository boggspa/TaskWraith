import { grokWriteCapable } from './GrokCliArgs'
import {
  GROK_BROKER_MCP_TOOL_NAMESPACE,
  GROK_SCOPED_MCP_SERVER_NAME
} from '../index.constants'
import { isReadOnlyAdvertisedTool } from '../mcp/McpAutoAllowedTools'
import { isCapabilityGatewayToolName } from '../mcp/McpToolGateway'

const GROK_TASKWRAITH_MCP_TOOL_NAMESPACES = [
  GROK_SCOPED_MCP_SERVER_NAME,
  GROK_BROKER_MCP_TOOL_NAMESPACE
] as const

function unqualifyGrokTaskWraithMcpTool(value: unknown): string | null {
  if (typeof value !== 'string') return null
  for (const namespace of GROK_TASKWRAITH_MCP_TOOL_NAMESPACES) {
    const prefix = `${namespace}__`
    if (value.startsWith(prefix)) return value.slice(prefix.length) || null
  }
  return null
}

/**
 * Whether a Grok ACP permission request targets one of TaskWraith's immutable
 * read-only tools. Grok can report the configured scoped server name OR the
 * broker's own namespace in rawInput.tool_name, so accept both qualifiers and
 * then fail closed on the unqualified tool membership check.
 */
export function grokTaskWraithSafeToolRequested(request: {
  toolName?: string
  rawToolCall?: unknown
}): boolean {
  const raw = request.rawToolCall as
    | { rawInput?: { tool_name?: unknown; name?: unknown } }
    | undefined
  for (const candidate of [request.toolName, raw?.rawInput?.tool_name, raw?.rawInput?.name]) {
    const toolName = unqualifyGrokTaskWraithMcpTool(candidate)
    if (
      toolName &&
      (isReadOnlyAdvertisedTool(toolName) || isCapabilityGatewayToolName(toolName))
    ) {
      return true
    }
  }
  return false
}

/**
 * Exact eligibility for attaching TaskWraith MCP to a Grok ACP session/new.
 * Write-capable ACP turns auto-attach it; read-only turns require both the
 * global bridge preference and the explicit read-only advertise gate.
 */
export function shouldAdvertiseTaskWraithMcpToGrok(input: {
  acpEnabled: boolean
  approvalMode?: string | null
  bridgeEnabled: boolean
  readOnlyAdvertiseEnabled: boolean
}): boolean {
  if (!input.acpEnabled) return false
  return (
    grokWriteCapable(input.approvalMode) ||
    (input.bridgeEnabled && input.readOnlyAdvertiseEnabled)
  )
}
