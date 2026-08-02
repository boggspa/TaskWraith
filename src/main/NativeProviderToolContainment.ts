import type { AgenticServiceId } from './store/types'
import type { NativeWorkspaceToolPreflight } from './native-tools/NativeWorkspaceToolGate'
import {
  claimsTaskWraithMcpNamespace,
  resolveToolDispatchContractStrict
} from '../shared/providerActionTaxonomy'

const NATIVE_MUTATION_OR_SHELL_TOOLS = new Set([
  'bash',
  'shell',
  'runcommand',
  'runterminalcommand',
  'write',
  'writefile',
  'edit',
  'editfile',
  'multiedit',
  'notebookedit',
  'replace',
  'applypatch',
  'createfile',
  'deletefile',
  'deletepath',
  'movefile',
  'movepath',
  'renamefile',
  'renamepath'
])

export function isExplicitTaskWraithBrokerTool(toolName: string, toolArgs?: unknown): boolean {
  if (!claimsTaskWraithMcpNamespace(toolName)) return false
  return resolveToolDispatchContractStrict(toolName, toolArgs).ok
}

/**
 * Native provider mutations and shell tools cannot execute inside
 * TaskWraith's exact per-operation commit fence. Keep them broker-only; native
 * reads remain available because they neither acquire nor need a write lease.
 */
export function nativeProviderToolRequiresBroker(toolName: string, toolArgs?: unknown): boolean {
  if (isExplicitTaskWraithBrokerTool(toolName, toolArgs)) return false
  if (claimsTaskWraithMcpNamespace(toolName)) return true
  const compact = String(toolName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
  return NATIVE_MUTATION_OR_SHELL_TOOLS.has(compact)
}

export type NativeProviderApprovalPriority = 'deny-native' | 'allow-auto' | 'continue'

/**
 * Provider approval callbacks must classify native tools before consulting the
 * canonical MCP auto-allow list. Bare native names such as `read_file` can
 * deliberately share a canonical name with a safe TaskWraith MCP tool; only an
 * explicitly namespaced broker call may take that auto-allow path.
 */
export function nativeProviderApprovalPriority(
  toolName: string,
  autoAllowed: boolean,
  toolArgs?: unknown
): NativeProviderApprovalPriority {
  if (nativeProviderToolRequiresBroker(toolName, toolArgs)) return 'deny-native'
  return autoAllowed ? 'allow-auto' : 'continue'
}

export function nativeProviderBrokerOnlyMessage(provider: string, toolName: string): string {
  return `${provider} native tool ${toolName || 'tool'} is disabled for workspace containment. Use the namespaced TaskWraith MCP workspace tool instead.`
}

export type NativeWorkspaceCanUseDecision =
  | { action: 'deny'; message: string }
  | { action: 'allow' }
  | { action: 'gate'; service: AgenticServiceId }

/**
 * Map a shared `NativeWorkspaceToolGate` result onto a provider permission
 * decision without weakening the exact-mutation boundary:
 *
 *   - `allow` + `read`        → allow directly. The path is already proven
 *     inside the active workspace and reads are preset-safe, mirroring how the
 *     namespaced MCP read tools auto-allow.
 *   - `allow` + `write`/`shell` → deny the opaque native execution and direct
 *     the provider to the namespaced broker, where the ledger and exact target
 *     transaction both apply.
 *   - `deny`                  → deny with the gate's specific workspace-bound
 *     reason (OOW path, missing authority, or unsandboxed shell).
 *   - `not_applicable`        → keep the bare native tool broker-only (the prior
 *     containment posture); never let an unclassifiable native FS/shell name
 *     slip through.
 */
export function classifyNativeWorkspacePreflightDecision(
  provider: string,
  toolName: string,
  preflight: NativeWorkspaceToolPreflight
): NativeWorkspaceCanUseDecision {
  if (preflight.kind === 'allow') {
    if (preflight.access === 'read') return { action: 'allow' }
    return { action: 'deny', message: nativeProviderBrokerOnlyMessage(provider, toolName) }
  }
  if (preflight.kind === 'deny') {
    return { action: 'deny', message: preflight.reason }
  }
  return { action: 'deny', message: nativeProviderBrokerOnlyMessage(provider, toolName) }
}
