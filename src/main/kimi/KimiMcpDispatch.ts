import {
  handleMcpJsonRpcMessage,
  type McpBridgeAgentRunRoute,
  type McpToolDefinition
} from '../mcp/McpBridgeRuntime'

export interface KimiMcpDispatchOptions {
  route: McpBridgeAgentRunRoute
  workspace?: string
  appVersion: string
  brokerToken: string
  getMcpToolDefinitions: () => McpToolDefinition[]
  dispatchBrokerRequest: (request: unknown) => Promise<unknown>
  timeoutMs?: number
}

/**
 * Adapt Kimi Code's per-run HTTP MCP transport to TaskWraith's shared MCP
 * catalogue/call guard. The final broker hop stays in-process: the HTTP server
 * already runs in the Electron main process, so sending the request back out
 * through the Unix socket only adds a second transport that can go stale.
 */
export function createKimiMcpDispatch(
  options: KimiMcpDispatchOptions
): (message: Record<string, unknown>) => Promise<Record<string, unknown> | null> {
  const deps = {
    getDefaultSocketPath: () => 'in-process://kimi',
    getAppVersion: () => options.appVersion,
    getMcpToolDefinitions: options.getMcpToolDefinitions,
    brokerRequest: (_socketPath: string, request: unknown) =>
      options.dispatchBrokerRequest(request),
    env: {
      ...process.env,
      TASKWRAITH_MCP_GATEWAY_SUBSET: '1',
      TASKWRAITH_PARENT_PROVIDER: 'kimi',
      TASKWRAITH_RUN_ID: options.route.appRunId || '',
      TASKWRAITH_CHAT_ID: options.route.appChatId || '',
      TASKWRAITH_WORKSPACE_PATH: options.workspace || ''
    } as NodeJS.ProcessEnv
  }

  return (message) =>
    new Promise((resolve) => {
      if (typeof message.method === 'string' && message.method.startsWith('notifications/')) {
        resolve(null)
        return
      }

      let settled = false
      let timeout: NodeJS.Timeout | null = null
      const finish = (value: Record<string, unknown> | null): void => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        resolve(value)
      }
      const writer = {
        write: (line: string) => {
          try {
            finish(JSON.parse(String(line).trim()))
          } catch {
            finish(null)
          }
          return true
        }
      } as unknown as NodeJS.WriteStream

      try {
        handleMcpJsonRpcMessage(
          { ...deps, stdout: writer },
          'in-process://kimi',
          options.brokerToken,
          message,
          'line'
        )
      } catch (error) {
        finish({
          jsonrpc: '2.0',
          id: message.id ?? null,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) }
        })
      }

      if (!settled) {
        timeout = setTimeout(
          () =>
            finish({
              jsonrpc: '2.0',
              id: message.id ?? null,
              error: { code: -32000, message: 'TaskWraith MCP dispatch timed out.' }
            }),
          // Match the stdio broker's approval-aware request budget. Kimi's
          // normal approval window is longer than 30s; resolving earlier leaves
          // the host mutation running and encourages the model to retry, which
          // can duplicate a roster import after the first call eventually wins.
          options.timeoutMs ?? 130_000
        )
      }
    })
}
