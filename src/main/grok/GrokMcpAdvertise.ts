import { grokWriteCapable } from './GrokCliArgs'
import { GROK_BROKER_MCP_TOOL_NAMESPACE, GROK_SCOPED_MCP_SERVER_NAME } from '../index.constants'
import { isReadOnlyAdvertisedTool } from '../mcp/McpAutoAllowedTools'
import { isCapabilityGatewayToolName } from '../mcp/McpToolGateway'
import {
  resolveProviderNativeActionStrict,
  resolveToolDispatchContractStrict
} from '../../shared/providerActionTaxonomy'

const GROK_LEGACY_BROKER_MCP_TOOL_NAMESPACE = 'taskwraith-broker'

const GROK_TASKWRAITH_MCP_TOOL_NAMESPACES = [
  GROK_SCOPED_MCP_SERVER_NAME,
  GROK_BROKER_MCP_TOOL_NAMESPACE,
  // Legacy Cursor-colliding alias — keep unqualifying so old ACP sessions
  // and leftover permission requests still parse as TaskWraith tools.
  GROK_LEGACY_BROKER_MCP_TOOL_NAMESPACE
] as const

function unqualifyTaskWraithMcpTool(value: unknown, namespaces: readonly string[]): string | null {
  if (typeof value !== 'string') return null
  for (const namespace of namespaces) {
    const prefix = `${namespace}__`
    if (value.startsWith(prefix)) return value.slice(prefix.length) || null
  }
  return null
}

export interface StructuredTaskWraithToolRequest {
  toolName?: string
  toolKind?: string
  rawToolCall?: unknown
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function structuredPayloadRecords(value: unknown): Record<string, unknown>[] {
  const root = record(value)
  if (!root) return []
  const records = [root]
  const pending = [root]
  const seen = new Set<unknown>([root])
  while (pending.length > 0 && records.length < 20) {
    const current = pending.shift()!
    for (const key of ['rawInput', 'input', 'arguments', 'args', 'parameters', 'params']) {
      const nested = record(current[key])
      if (!nested || seen.has(nested)) continue
      seen.add(nested)
      records.push(nested)
      pending.push(nested)
    }
  }
  return records
}

/**
 * ACP `toolName` is a human display title and never proves broker provenance.
 * Only the transport's stable rawInput machine identifier may qualify for the
 * safe broker shortcut, and a mutating native kind contradicts that identity.
 */
export function structuredTaskWraithSafeToolRequested(
  request: StructuredTaskWraithToolRequest,
  namespaces: readonly string[]
): boolean {
  const raw = record(request.rawToolCall)
  const rawInput = record(raw?.rawInput)
  const kinds = [request.toolKind, raw?.kind, rawInput?.kind]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.trim().toLowerCase())
  if (
    new Set(kinds).size > 1 ||
    kinds.some((kind) => ['edit', 'delete', 'move', 'execute'].includes(kind))
  ) {
    return false
  }

  const mutationKeys = new Set([
    'command',
    'cmd',
    'content',
    'streamContent',
    'patch',
    'diff',
    'changes',
    'old',
    'new',
    'old_string',
    'new_string',
    'oldString',
    'newString'
  ])
  if (
    structuredPayloadRecords(request.rawToolCall).some((payload) =>
      Object.keys(payload).some((key) => mutationKeys.has(key))
    )
  ) {
    return false
  }

  // `rawInput.name` is ambiguous. For an ordinary tool it is a machine identity,
  // but for the capability gateway it is the envelope's OWN ARGUMENT — the target
  // being invoked. Counting it as a competing identity makes the agreement check
  // below unsatisfiable for every `capability_invoke` call (the envelope resolves
  // to `capability_invoke`, the argument to something else), so the gateway could
  // never classify as safe and read-only seats denied it outright.
  const envelopeIdentities = [
    raw?.tool_name,
    raw?.toolName,
    raw?.name,
    rawInput?.tool_name,
    rawInput?.toolName
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const gatewayEnvelope = envelopeIdentities.some((candidate) => {
    const toolName = unqualifyTaskWraithMcpTool(candidate, namespaces)
    return Boolean(toolName && isCapabilityGatewayToolName(toolName))
  })
  const targetArgument =
    typeof rawInput?.name === 'string' && rawInput.name.trim().length > 0 ? rawInput.name : null
  const identities =
    gatewayEnvelope || !targetArgument ? envelopeIdentities : [...envelopeIdentities, targetArgument]
  if (identities.length === 0) return false
  const resolved = identities.map((candidate) => {
    const toolName = unqualifyTaskWraithMcpTool(candidate, namespaces)
    if (!toolName) return null
    const contract = resolveToolDispatchContractStrict(candidate, rawInput)
    if (!contract.ok) return null
    return contract
  })
  if (resolved.some((contract) => contract === null)) return false
  const contracts = resolved.filter((contract) => contract !== null)
  if (
    new Set(contracts.map((contract) => contract.toolName)).size !== 1 ||
    new Set(contracts.map((contract) => contract.effectiveToolName)).size !== 1
  ) {
    return false
  }
  const toolName = contracts[0]?.toolName
  return Boolean(
    toolName && (isReadOnlyAdvertisedTool(toolName) || isCapabilityGatewayToolName(toolName))
  )
}

/**
 * Whether a Grok ACP permission request targets one of TaskWraith's immutable
 * read-only tools. Grok can report the configured scoped server name OR the
 * broker's own namespace in rawInput.tool_name, so accept both qualifiers and
 * then fail closed on the unqualified tool membership check.
 */
export function grokTaskWraithSafeToolRequested(request: StructuredTaskWraithToolRequest): boolean {
  return structuredTaskWraithSafeToolRequested(request, GROK_TASKWRAITH_MCP_TOOL_NAMESPACES)
}

/**
 * Exact network-read classifier for ACP-native requests. Human titles never
 * choose the policy branch; the closed provider adapter must resolve the
 * structured kind/raw machine identity to a declared network action.
 */
export function structuredProviderNetworkReadRequested(
  provider: 'grok' | 'mistral',
  request: StructuredTaskWraithToolRequest
): boolean {
  const resolution = resolveProviderNativeActionStrict(provider, request.toolName || '', {
    toolKind: request.toolKind,
    rawToolCall: request.rawToolCall
  })
  return resolution.ok && resolution.action === 'network.read'
}

/** Global deny is a ceiling; a run-stamped allow cannot weaken it. */
export function structuredProviderNetworkAccessAllowed(
  effectivePolicy: string | null | undefined,
  globalPolicy: string | null | undefined
): boolean {
  return effectivePolicy !== 'deny' && globalPolicy !== 'deny'
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
    grokWriteCapable(input.approvalMode) || (input.bridgeEnabled && input.readOnlyAdvertiseEnabled)
  )
}
