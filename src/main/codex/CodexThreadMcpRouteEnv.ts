/**
 * Per-thread TaskWraith MCP route identity for the shared Codex app-server.
 *
 * The app-server daemon is shared by concurrent Codex runs, but it starts the
 * configured MCP bridge per thread. Stamping the run route on thread/start and
 * thread/resume disambiguates concurrent seats when that bridge is rebuilt.
 * A retained loaded thread may ignore resume config, so CodexMcpRouteRecovery
 * also correlates stale routes with exact live native tool-call witnesses.
 */

/** Must match the case-sensitive server name in buildCodexTaskWraithMcpArgs. */
export const CODEX_THREAD_MCP_ROUTE_CONFIG_KEY = 'mcp_servers.TaskWraith.env'
export const CODEX_THREAD_UNSUBSCRIBE_METHOD = 'thread/unsubscribe'

export type CodexThreadUnsubscribeStatus = 'unsubscribed' | 'notSubscribed' | 'notLoaded'

/** These acknowledge subscription state; none guarantees the thread unloaded. */
export function isCodexThreadUnsubscribeResult(
  value: unknown
): value is { status: CodexThreadUnsubscribeStatus } {
  if (!value || typeof value !== 'object') return false
  const status = (value as { status?: unknown }).status
  return status === 'unsubscribed' || status === 'notSubscribed' || status === 'notLoaded'
}

export interface CodexThreadMcpRouteEnvInput {
  readonly mcpBridgeEnabled: boolean
  readonly appRunId: string | null | undefined
  readonly appChatId: string | null | undefined
  readonly workspacePath: string | null | undefined
}

function trimmed(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Build the per-thread bridge environment table, or null when no exact run
 * identity is available. The table replaces (rather than merges with) the
 * daemon-level value, so the parent-provider stamp is deliberately repeated.
 */
export function buildCodexThreadMcpRouteEnv(
  input: CodexThreadMcpRouteEnvInput
): Readonly<Record<string, string>> | null {
  if (!input.mcpBridgeEnabled) return null
  const appRunId = trimmed(input.appRunId)
  if (!appRunId) return null
  const appChatId = trimmed(input.appChatId)
  const workspacePath = trimmed(input.workspacePath)
  return Object.freeze({
    TASKWRAITH_PARENT_PROVIDER: 'codex',
    TASKWRAITH_RUN_ID: appRunId,
    ...(appChatId ? { TASKWRAITH_CHAT_ID: appChatId } : {}),
    ...(workspacePath ? { TASKWRAITH_WORKSPACE_PATH: workspacePath } : {})
  })
}
