// Defense-in-depth permission policy for a contained Kimi Code ACP seat.
// Production statically denies every native fs/exec/egress/fan-out tool; this
// classifier repeats that exact wall if a provider build asks anyway. Only
// sanctioned read-only TaskWraith MCP tools auto-allow. Other broker requests
// are gated on write-capable seats and denied on read-only seats.

import { isReadOnlyAdvertisedTool } from '../mcp/McpAutoAllowedTools'
import { isCapabilityGatewayToolName } from '../mcp/McpToolGateway'
import { KIMI_ACP_DENY_TOOLS } from './KimiAcpContainment'
import { resolveToolDispatchContractStrict } from '../../shared/providerActionTaxonomy'

const KIMI_NATIVE_DENY_NAMES = new Set(KIMI_ACP_DENY_TOOLS.map((name) => name.toLowerCase()))

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
  toolKind?: string
  rawToolCall?: unknown
}): boolean {
  const raw = request.rawToolCall as
    | {
        kind?: unknown
        rawInput?: {
          tool_name?: unknown
          name?: unknown
          command?: unknown
          cmd?: unknown
          content?: unknown
          patch?: unknown
          diff?: unknown
          changes?: unknown
          old_string?: unknown
          new_string?: unknown
        }
      }
    | undefined
  const rawInput = raw?.rawInput
  const toolKind =
    (typeof request.toolKind === 'string' && request.toolKind) ||
    (typeof raw?.kind === 'string' && raw.kind) ||
    ''
  if (['edit', 'delete', 'move', 'execute'].includes(toolKind.trim().toLowerCase())) {
    return false
  }
  if (
    rawInput &&
    [
      rawInput.command,
      rawInput.cmd,
      rawInput.content,
      rawInput.patch,
      rawInput.diff,
      rawInput.changes,
      rawInput.old_string,
      rawInput.new_string
    ].some((value) => value !== undefined)
  ) {
    return false
  }

  // Identity candidates MUST include `request.toolName`. For an ACP seat that is
  // `toolCall.title` (GrokAcpProtocol.parseAcpPermissionRequest), and Kimi puts its
  // machine tool name there — a request carrying the identity only in the title has
  // no rawInput candidate at all. Dropping it, and requiring a literal
  // `mcp__taskwraith__` prefix, is exactly the mis-classification the header comment
  // above records the ensemble soak catching: capability_search denied on a
  // read-only seat. `unqualifyKimiMcpToolName` accepts any `mcp__<server>__`
  // namespace (the isolated home guarantees the only server is ours) and passes an
  // already-unqualified bare name through unchanged.
  const rawCandidates = [request.toolName, rawInput?.tool_name, rawInput?.name].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0
  )
  if (rawCandidates.length === 0) return false
  const resolvedTools: string[] = []
  for (const candidate of rawCandidates) {
    const namespaced = candidate.match(/^mcp__([A-Za-z0-9_-]+?)__(.+)$/)
    // A candidate that explicitly names ANOTHER MCP server is a spoof, not noise:
    // refuse the whole request rather than letting a sibling identity carry it.
    // (The isolated Kimi home means only TaskWraith is attached, so a foreign
    // namespace can only be an attempt to launder one tool as another.)
    if (namespaced && !/^taskwraith([-_]|$)/i.test(namespaced[1])) return false
    const unqualified = unqualifyKimiMcpToolName(candidate)
    if (!unqualified) continue
    const resolution = resolveToolDispatchContractStrict(unqualified, rawInput)
    // An UNRESOLVABLE identity is skipped rather than poisoning the request: an ACP
    // title that is prose ("Search the workspace") must not veto a rawInput that
    // names a real tool. Contradiction between two RESOLVED identities is still
    // fatal below — that is the spoof this check exists to stop.
    if (resolution.ok) resolvedTools.push(resolution.toolName)
  }
  if (resolvedTools.length === 0) return false
  if (new Set(resolvedTools).size !== 1) return false
  const tool = resolvedTools[0]
  return Boolean(isReadOnlyAdvertisedTool(tool) || isCapabilityGatewayToolName(tool))
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
  /** @deprecated Native shell is denied in production; retained for callers compiled against v1. */
  isReadOnlyShell: (request: KimiToolPolicyRequest) => boolean
}

/** True only for an exact native tool name in the production deny wall. */
export function isKimiDeniedNativeTool(request: KimiToolPolicyRequest): boolean {
  const raw = request.rawToolCall as
    | { rawInput?: { tool_name?: unknown; name?: unknown } }
    | undefined
  return [request.toolName, raw?.rawInput?.tool_name, raw?.rawInput?.name].some(
    (candidate) =>
      typeof candidate === 'string' &&
      !candidate.startsWith('mcp__') &&
      KIMI_NATIVE_DENY_NAMES.has(candidate.toLowerCase())
  )
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
  if (isKimiDeniedNativeTool(request)) return 'deny'
  if (options.isSafeMcpTool(request)) return 'allow'
  return options.writeCapable ? 'gate' : 'deny'
}
