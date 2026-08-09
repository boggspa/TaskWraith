import { mcpBrokerRequestTimeoutMsFor } from '../mcp/McpBrokerTimeouts'
import {
  handleMcpJsonRpcMessage,
  type McpBridgeAgentRunRoute,
  type McpToolDefinition
} from '../mcp/McpBridgeRuntime'
import { mcpUnexpectedInternalError } from '../mcp/McpInternalError'
import {
  isGatewayV13DirectTaskWraithMcpProfile,
  isMeshCanvasDirectTaskWraithMcpProfile,
  isMeshTopologyDirectTaskWraithMcpProfile,
  isPortableEnsembleControlMcpProfile,
  isSketchCanvasDirectTaskWraithMcpProfile
} from '../mcp/McpSessionProfileFence'
import {
  MCP_BRIDGE_ENDPOINT_ENV_KEYS,
  MCP_BRIDGE_PROFILE_ENV_KEYS,
  MCP_BRIDGE_ROUTE_ENV_KEYS
} from '../mcp/McpBridgeRoute'
import type { TaskWraithMcpProfileId } from '../store/types'

export interface KimiMcpDispatchOptions {
  route: McpBridgeAgentRunRoute
  /** Exact profile resolved for this Kimi turn; controls fresh-tool visibility. */
  taskWraithMcpProfileId?: TaskWraithMcpProfileId | null
  workspace?: string
  appVersion: string
  brokerToken: string
  /** Explicit per-run audit profile; never inferred from the ambient process env. */
  auditSubset?: boolean
  /** Exact boot nonce required by the in-process broker authentication wall. */
  instanceEpoch: string
  getMcpToolDefinitions: () => McpToolDefinition[]
  dispatchBrokerRequest: (request: unknown) => Promise<unknown>
  timeoutMs?: number
}

/**
 * Kimi's HTTP bridge runs in the Electron process, so inheriting its ambient
 * environment would let a stale provider launch widen or otherwise alter this
 * run's catalogue. Keep every bridge route and profile selector explicit here;
 * this mirrors the complete-zeroes posture of the stdio route builder.
 */
function buildKimiMcpDispatchEnvironment(options: KimiMcpDispatchOptions): NodeJS.ProcessEnv {
  const portableEnsembleControl = isPortableEnsembleControlMcpProfile(
    options.taskWraithMcpProfileId
  )
  const meshDirect = isMeshCanvasDirectTaskWraithMcpProfile(options.taskWraithMcpProfileId)
  const meshTopologyDirect = isMeshTopologyDirectTaskWraithMcpProfile(
    options.taskWraithMcpProfileId
  )
  const sketchDirect = isSketchCanvasDirectTaskWraithMcpProfile(options.taskWraithMcpProfileId)
  const orchestrationDirect = isGatewayV13DirectTaskWraithMcpProfile(
    options.taskWraithMcpProfileId
  )

  return {
    // This legacy opt-in is not consumed by the bridge, but must not leak as a
    // profile hint to code subsequently reached from the in-process dispatch.
    TASKWRAITH_CORE_MCP_PROFILE: '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.safeSubset]: '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.planSubset]: '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.coreSubset]: '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.gatewaySubset]: '1',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.portableEnsembleControl]: portableEnsembleControl ? '1' : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.meshDirect]: meshDirect ? '1' : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.meshTopologyDirect]: meshTopologyDirect ? '1' : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.sketchDirect]: sketchDirect ? '1' : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.orchestrationDirect]: orchestrationDirect ? '1' : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.auditSubset]: options.auditSubset ? '1' : '0',
    [MCP_BRIDGE_ROUTE_ENV_KEYS.parentProvider]: 'kimi',
    [MCP_BRIDGE_ROUTE_ENV_KEYS.runId]: options.route.appRunId || '',
    [MCP_BRIDGE_ROUTE_ENV_KEYS.chatId]: options.route.appChatId || '',
    [MCP_BRIDGE_ROUTE_ENV_KEYS.workspacePath]: options.workspace || '',
    // Kimi dispatches directly to Electron main rather than a socket bridge.
    // Explicit blank values prevent an inherited endpoint/profile from becoming
    // ambient authority if this adapter later shares more runtime plumbing.
    [MCP_BRIDGE_ENDPOINT_ENV_KEYS.socketPath]: '',
    [MCP_BRIDGE_ENDPOINT_ENV_KEYS.brokerToken]: '',
    [MCP_BRIDGE_ENDPOINT_ENV_KEYS.instanceEpoch]: options.instanceEpoch,
    [MCP_BRIDGE_ENDPOINT_ENV_KEYS.bridgeLogEpoch]: '0',
    [MCP_BRIDGE_ENDPOINT_ENV_KEYS.isolatedInstanceId]: ''
  }
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
    env: buildKimiMcpDispatchEnvironment(options)
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
      } catch {
        finish(mcpUnexpectedInternalError(message.id))
      }

      if (!settled) {
        timeout = setTimeout(
          () =>
            finish({
              jsonrpc: '2.0',
              id: message.id ?? null,
              error: { code: -32000, message: 'TaskWraith MCP dispatch timed out.' }
            }),
          // Match the stdio broker's approval-aware request budget (tool-aware:
          // long-poll tools like ensemble_await get their clamp ceiling +
          // grace). Kimi's normal approval window is longer than 30s; resolving
          // earlier leaves the host mutation running and encourages the model
          // to retry, which can duplicate a roster import after the first call
          // eventually wins.
          options.timeoutMs ?? mcpBrokerRequestTimeoutMsFor(message)
        )
      }
    })
}
