import type { ProviderId } from './store/types'
import { GROK_BROKER_MCP_TOOL_NAMESPACE } from './index.constants'

export function taskWraithToolNameForProvider(provider: ProviderId, toolName: string): string {
  if (provider === 'claude') return `mcp__TaskWraith__${toolName}`
  if (provider === 'kimi') return `mcp__taskwraith__${toolName}`
  if (provider === 'cursor') return `taskwraith__${toolName}`
  if (provider === 'grok') return `${GROK_BROKER_MCP_TOOL_NAMESPACE}__${toolName}`
  return `TaskWraith__${toolName}`
}

export function taskWraithToolNamespaceHint(provider: ProviderId): string {
  if (provider === 'kimi') {
    return 'Kimi Code exposes current TaskWraith tools as `mcp__taskwraith__<tool>`. Older versions may list `TaskWraith__<tool>`; use the exact listed name. An absent tool is an availability blocker, not a reason to substitute a native tool.'
  }
  if (provider === 'claude') {
    return 'Claude may expose TaskWraith tools as `mcp__TaskWraith__<tool>`.'
  }
  if (provider === 'cursor') {
    return 'Managed Cursor runs may expose brokered TaskWraith tools as `taskwraith__<tool>` on MCP server `taskwraith-broker` when the TaskWraith gateway is active. Discover them with GetMcpTools on that server — not GetDynamicTools or CallDynamicTool. Native Cursor tools remain provider-owned and sandbox-bounded.'
  }
  if (provider === 'grok') {
    return 'Grok exposes TaskWraith tools as `TaskWraith__<tool>`; ACP may report the read-only scoped alias `taskwraith-grok__<tool>`.'
  }
  if (provider === 'codex') {
    return 'Codex may expose TaskWraith tools as `TaskWraith__<tool>` or as bare tool names depending on CLI version.'
  }
  return `${providerDisplayName(provider)} may expose TaskWraith tools as \`TaskWraith__<tool>\`.`
}

function providerDisplayName(provider: ProviderId): string {
  if (provider === 'gemini') return 'Gemini'
  if (provider === 'kimi') return 'Kimi'
  if (provider === 'grok') return 'Grok'
  if (provider === 'claude') return 'Claude'
  if (provider === 'codex') return 'Codex'
  if (provider === 'cursor') return 'Cursor'
  if (provider === 'ollama') return 'Ollama'
  if (provider === 'antigravity') return 'AntiGravity'
  if (provider === 'pi') return 'Pi'
  if (provider === 'mistral') return 'Mistral'
  return String(provider)
}
