// Defense-in-depth permission policy for a contained Kimi Code ACP seat.
// Production statically denies every native fs/exec/egress/fan-out tool; this
// classifier repeats that exact wall if a provider build asks anyway. Only
// sanctioned read-only TaskWraith MCP tools auto-allow. Other broker requests
// are gated on write-capable seats and denied on read-only seats.

import { isReadOnlyAdvertisedTool } from '../mcp/McpAutoAllowedTools'
import { isCapabilityGatewayToolName } from '../mcp/McpToolGateway'
import { KIMI_ACP_DENY_TOOLS } from './KimiAcpContainment'
import { resolveToolDispatchContractStrict } from '../../shared/providerActionTaxonomy'
import { MESH_MCP_TOOL_NAMES } from '../../shared/taskWraithMcpCatalog'

const KIMI_NATIVE_DENY_NAMES = new Set(KIMI_ACP_DENY_TOOLS.map((name) => name.toLowerCase()))
const KIMI_BROKER_DEFERRED_MESH_TOOLS: ReadonlySet<string> = new Set(MESH_MCP_TOOL_NAMES)

function resolveKimiTaskWraithMcpTool(request: {
  toolName?: string
  rawToolCall?: unknown
}): string | null {
  const raw = request.rawToolCall as
    | { rawInput?: { tool_name?: unknown; name?: unknown } }
    | undefined
  const rawInput = raw?.rawInput
  const resolveCandidate = (
    candidate: string
  ): { tool: string | null; invalidNamespace: boolean } => {
    const namespaced = candidate.match(/^mcp__([A-Za-z0-9_-]+?)__(.+)$/)
    if (namespaced && namespaced[1].toLowerCase() !== 'taskwraith') {
      return { tool: null, invalidNamespace: true }
    }
    const unqualified = unqualifyKimiMcpToolName(candidate)
    if (!unqualified) return { tool: null, invalidNamespace: false }
    const resolution = resolveToolDispatchContractStrict(unqualified, rawInput)
    return {
      tool: resolution.ok ? resolution.toolName : null,
      invalidNamespace: false
    }
  }

  const rawToolName = typeof rawInput?.tool_name === 'string' ? rawInput.tool_name.trim() : ''
  const requestToolName = typeof request.toolName === 'string' ? request.toolName.trim() : ''

  // rawInput.tool_name is the closest ACP field to a machine identity. If it
  // is present it must resolve exactly; an unknown value cannot be ignored in
  // favour of a model-controlled display title or `name` argument.
  if (rawToolName) {
    const rawResolution = resolveCandidate(rawToolName)
    if (!rawResolution.tool || rawResolution.invalidNamespace) return null
    if (requestToolName) {
      const titleResolution = resolveCandidate(requestToolName)
      if (titleResolution.invalidNamespace) return null
      if (titleResolution.tool && titleResolution.tool !== rawResolution.tool) return null
    }
    return rawResolution.tool
  }

  // A non-empty ACP title is the primary identity on builds that omit
  // rawInput.tool_name. It must resolve on its own; never let an unknown native
  // title fall through to a Mesh-shaped `name` argument.
  if (requestToolName) return resolveCandidate(requestToolName).tool

  // Some ACP builds expose only rawInput.name. It is an identity strictly when
  // both primary fields are absent; otherwise `name` remains an ordinary tool
  // argument (including capability_invoke's target).
  const fallback = typeof rawInput?.name === 'string' ? rawInput.name.trim() : ''
  if (!fallback) return null
  return resolveCandidate(fallback).tool
}

/**
 * Strip the `mcp__<server>__` namespace Kimi puts on MCP tools (the standard
 * MCP convention; our server is "taskwraith", with a capitalized alias). The
 * isolated home guarantees the only configured MCP server is TaskWraith. The
 * resolver still requires that exact namespace; an unqualified name passes
 * through unchanged for ACP builds that omit the prefix.
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
  // read-only seat. The shared resolver accepts the exact TaskWraith namespace
  // and already-unqualified bare names while rejecting foreign identities.
  const tool = resolveKimiTaskWraithMcpTool(request)
  if (!tool) return false
  // Capability gateways are transport wrappers: capability_invoke re-enters
  // the canonical target dispatcher and its real host gate. Some ACP builds
  // label the wrapper execute/edit because its annotations are conservative;
  // the absence of native command/edit payload fields above remains required.
  if (isCapabilityGatewayToolName(tool)) return true
  const toolKind =
    (typeof request.toolKind === 'string' && request.toolKind) ||
    (typeof raw?.kind === 'string' && raw.kind) ||
    ''
  if (['edit', 'delete', 'move', 'execute'].includes(toolKind.trim().toLowerCase())) {
    return false
  }
  if (KIMI_BROKER_DEFERRED_MESH_TOOLS.has(tool)) return false
  return isReadOnlyAdvertisedTool(tool)
}

/**
 * Kimi's outer ACP policy treats Ask/Plan seats as non-write-capable. Exact
 * Mesh identities must nevertheless cross that transport wall so the signed
 * main-process meshCanvas broker can prompt. This is admission only: it does
 * not add the tool to TaskWraith's auto-allow set or bypass the central gate.
 */
export function kimiBrokerDeferredMeshMcpToolName(request: KimiToolPolicyRequest): string | null {
  const raw = request.rawToolCall as
    | {
        rawInput?: {
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
  if (
    raw?.rawInput &&
    [
      raw.rawInput.command,
      raw.rawInput.cmd,
      raw.rawInput.content,
      raw.rawInput.patch,
      raw.rawInput.diff,
      raw.rawInput.changes,
      raw.rawInput.old_string,
      raw.rawInput.new_string
    ].some((value) => value !== undefined)
  ) {
    return null
  }
  const tool = resolveKimiTaskWraithMcpTool(request)
  return tool && KIMI_BROKER_DEFERRED_MESH_TOOLS.has(tool) ? tool : null
}

export function isKimiBrokerDeferredMeshMcpTool(request: KimiToolPolicyRequest): boolean {
  return Boolean(kimiBrokerDeferredMeshMcpToolName(request))
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
  /** Exact mutator admitted only so TaskWraith's inner signed service gate can decide. */
  isBrokerDeferredMcpTool?: (request: KimiToolPolicyRequest) => boolean
  /** @deprecated Native shell is denied in production; retained for callers compiled against v1. */
  isReadOnlyShell: (request: KimiToolPolicyRequest) => boolean
}

/** True only for an exact native tool name in the production deny wall. */
export function isKimiDeniedNativeTool(request: KimiToolPolicyRequest): boolean {
  const raw = request.rawToolCall as
    | { rawInput?: { tool_name?: unknown; name?: unknown } }
    | undefined
  const primaryCandidates = [request.toolName, raw?.rawInput?.tool_name].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0
  )
  const candidates = primaryCandidates.length > 0 ? primaryCandidates : [raw?.rawInput?.name]
  return candidates.some(
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
  if (options.isBrokerDeferredMcpTool?.(request)) return 'gate'
  return options.writeCapable ? 'gate' : 'deny'
}
