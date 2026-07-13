const EXPLICIT_TASKWRAITH_TOOL_PREFIXES = [
  'mcp__taskwraith__',
  'taskwraith__',
  'mcp_taskwraith-broker_',
  'mcp_taskwraith-broker-',
  'mcp_taskwraith_',
  'mcp_taskwraith-',
  'taskwraith-broker__',
  'taskwraith_broker__',
  'taskwraith-broker_',
  'taskwraith_broker_',
  'taskwraith-broker-',
  'taskwraith_broker-'
] as const

const NATIVE_FILESYSTEM_OR_SHELL_TOOLS = new Set([
  'bash',
  'shell',
  'runcommand',
  'runterminalcommand',
  'read',
  'readfile',
  'glob',
  'grep',
  'findfiles',
  'listdirectory',
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

export function isExplicitTaskWraithBrokerTool(toolName: string): boolean {
  const normalized = String(toolName || '').trim().toLowerCase()
  return EXPLICIT_TASKWRAITH_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix))
}

/**
 * Native provider filesystem and shell tools cannot enforce TaskWraith's
 * signed chat/run/workspace grants at every path open. Keep them broker-only;
 * the explicitly namespaced TaskWraith MCP equivalents remain available.
 */
export function nativeProviderToolRequiresBroker(toolName: string): boolean {
  if (isExplicitTaskWraithBrokerTool(toolName)) return false
  const compact = String(toolName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
  return NATIVE_FILESYSTEM_OR_SHELL_TOOLS.has(compact)
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
  autoAllowed: boolean
): NativeProviderApprovalPriority {
  if (nativeProviderToolRequiresBroker(toolName)) return 'deny-native'
  return autoAllowed ? 'allow-auto' : 'continue'
}

export function nativeProviderBrokerOnlyMessage(provider: string, toolName: string): string {
  return `${provider} native tool ${toolName || 'tool'} is disabled for workspace containment. Use the namespaced TaskWraith MCP workspace tool instead.`
}
