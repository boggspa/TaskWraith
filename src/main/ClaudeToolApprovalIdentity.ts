import {
  claimsTaskWraithMcpNamespace,
  hasMcpToolNamespace,
  resolveToolDispatchContractStrict,
  type ResolvedToolDispatchContract
} from '../shared/providerActionTaxonomy'

export type ClaudeToolApprovalIdentity =
  | {
      readonly kind: 'taskwraith-mcp'
      readonly contract: ResolvedToolDispatchContract
    }
  | {
      readonly kind: 'invalid-taskwraith-mcp'
      readonly reason: string
    }
  | {
      readonly kind: 'foreign-mcp'
    }
  | {
      readonly kind: 'provider-native'
    }

export type NormalizedClaudeCanUseToolArgs =
  | {
      readonly ok: true
      readonly toolName: string
      readonly input: unknown
    }
  | {
      readonly ok: false
      readonly reason: string
    }

export function normalizeClaudeCanUseToolArgs(
  toolNameOrRequest: unknown,
  input?: unknown
): NormalizedClaudeCanUseToolArgs {
  if (typeof toolNameOrRequest === 'string') {
    return { ok: true, toolName: toolNameOrRequest, input }
  }
  if (
    !toolNameOrRequest ||
    typeof toolNameOrRequest !== 'object' ||
    Array.isArray(toolNameOrRequest)
  ) {
    return { ok: true, toolName: 'tool', input }
  }
  const request = toolNameOrRequest as Record<string, unknown>
  const identities: string[] = []
  for (const key of ['toolName', 'tool_name', 'name', 'tool']) {
    if (!Object.prototype.hasOwnProperty.call(request, key)) continue
    const value = request[key]
    if (typeof value !== 'string' || !value.trim()) {
      return {
        ok: false,
        reason: `Claude tool approval carried an invalid ${key} machine identity.`
      }
    }
    identities.push(value.trim())
  }
  if (new Set(identities).size > 1) {
    return {
      ok: false,
      reason: 'Claude tool approval carried contradictory machine identities.'
    }
  }
  return {
    ok: true,
    toolName: identities[0] || 'tool',
    input: input ?? request.input ?? request.parameters ?? request.params ?? {}
  }
}

/**
 * Claude's canUseTool callback mixes provider-native and MCP tool identities.
 * Keep the raw namespace until ownership is proven: a foreign MCP tool with a
 * familiar tail must remain generic MCP, while a malformed reserved
 * TaskWraith identity is denied instead of falling through.
 */
export function resolveClaudeToolApprovalIdentity(
  toolName: string,
  toolArgs?: unknown
): ClaudeToolApprovalIdentity {
  if (claimsTaskWraithMcpNamespace(toolName)) {
    const contract = resolveToolDispatchContractStrict(toolName, toolArgs)
    return contract.ok
      ? { kind: 'taskwraith-mcp', contract }
      : { kind: 'invalid-taskwraith-mcp', reason: contract.reason }
  }
  if (hasMcpToolNamespace(toolName)) return { kind: 'foreign-mcp' }
  return { kind: 'provider-native' }
}
