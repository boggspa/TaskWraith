// Per-tool approval policy for a Kimi Code ACP seat, matching the stdio
// providers' model: read-only / safe tools auto-allow (no prompt), mutating
// tools are gated by the approval ledger on a write-capable seat and denied on
// a read-only / plan seat.
//
// Kimi's built-in Read/Grep/Glob already route through the ACP client fs
// handlers without a permission ask; this classifier governs the tools that DO
// emit session/request_permission — Bash, Write/Edit, and MCP tools. Before
// this, every such tool was gated coarsely (a prompt even for a read-only
// capability_search), which is noisier than the other providers.

import { isReadOnlyAdvertisedTool } from '../mcp/McpAutoAllowedTools'
import { isCapabilityGatewayToolName } from '../mcp/McpToolGateway'

/**
 * Strip the `mcp__<server>__` namespace Kimi puts on MCP tools (the standard
 * MCP convention; our server is "taskwraith", with a capitalized alias). The
 * isolated home guarantees the ONLY MCP server is TaskWraith, so any mcp__
 * prefix is ours. An already-unqualified name passes through unchanged.
 */
export function unqualifyKimiMcpToolName(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  const match = value.match(/^mcp__[A-Za-z0-9_-]+?__(.+)$/)
  return match ? match[1] : value
}

/**
 * True when a Kimi ACP permission request targets a read-only / safe TaskWraith
 * MCP tool (read-only advertised tool or a capability gateway tool). Unlike the
 * Grok classifier this understands Kimi's `mcp__taskwraith__<tool>` namespace —
 * reusing Grok's namespace-only unqualifier here silently mis-classified every
 * Kimi MCP tool as non-safe (caught by the ensemble soak: capability_search was
 * denied on a read-only seat).
 */
export function isKimiSafeMcpTool(request: {
  toolName?: string
  rawToolCall?: unknown
}): boolean {
  const raw = request.rawToolCall as
    | { rawInput?: { tool_name?: unknown; name?: unknown } }
    | undefined
  for (const candidate of [request.toolName, raw?.rawInput?.tool_name, raw?.rawInput?.name]) {
    const tool = unqualifyKimiMcpToolName(candidate)
    if (tool && (isReadOnlyAdvertisedTool(tool) || isCapabilityGatewayToolName(tool))) {
      return true
    }
  }
  return false
}

export type KimiToolDecision = 'allow' | 'gate' | 'deny'

export interface KimiToolPolicyRequest {
  toolName?: string
  toolKind?: string
  rawToolCall?: unknown
}

export interface KimiToolPolicyOptions {
  /** False for a plan / read-only seat: mutating tools are denied, not gated. */
  writeCapable: boolean
  /** True for a read-only / safe TaskWraith MCP tool (or capability gateway). */
  isSafeMcpTool: (request: KimiToolPolicyRequest) => boolean
  /** True for a provably read-only shell command (ls, cat, rg, git status…). */
  isReadOnlyShell: (request: KimiToolPolicyRequest) => boolean
}

/**
 * Classify what to do with a tool that asked for permission:
 *  - `allow` — auto-approve without prompting (read-only / safe).
 *  - `gate`  — route to the approval ledger (mutating, write-capable seat).
 *  - `deny`  — refuse outright (mutating tool on a read-only / plan seat).
 *
 * The mutating-MCP host gates still apply INSIDE the broker (executeGeminiMcpTool)
 * regardless of an `allow` here, so auto-allowing a safe/gateway MCP tool does
 * not bypass the per-instrument host gate for a mutating capability.
 */
export function classifyKimiToolPermission(
  request: KimiToolPolicyRequest,
  options: KimiToolPolicyOptions
): KimiToolDecision {
  if (options.isSafeMcpTool(request)) return 'allow'
  if (options.isReadOnlyShell(request)) return 'allow'
  const kind = (request.toolKind || '').toLowerCase()
  if (kind === 'read' || kind === 'search') return 'allow'
  return options.writeCapable ? 'gate' : 'deny'
}
