import { mcpBrokerRequestTimeoutMsFor } from './McpBrokerTimeouts'
import {
  handleMcpJsonRpcMessage,
  type McpBridgeAgentRunRoute,
  type McpToolDefinition
} from './McpBridgeRuntime'
import { mcpUnexpectedInternalError } from './McpInternalError'
import {
  MCP_BRIDGE_ENDPOINT_ENV_KEYS,
  MCP_BRIDGE_PROFILE_ENV_KEYS,
  MCP_BRIDGE_ROUTE_ENV_KEYS,
  type McpBridgeProfileEnvironment
} from './McpBridgeRoute'
import type { ProviderId } from '../store/types'

export interface InProcessMcpDispatchOptions {
  parentProvider: ProviderId
  route: McpBridgeAgentRunRoute
  profile: McpBridgeProfileEnvironment
  workspace?: string
  appVersion: string
  brokerToken: string
  instanceEpoch: string
  getMcpToolDefinitions: () => McpToolDefinition[]
  dispatchBrokerRequest: (request: unknown) => Promise<unknown>
  timeoutMs?: number
  onDispatchTimeout?: (input: InProcessMcpDispatchTimeout) => void | Promise<void>
}

export interface InProcessMcpDispatchTimeout {
  appRunId?: string
  appChatId?: string
  requestId: string | number | null
  toolName?: string
}

function buildInProcessMcpDispatchEnvironment(
  options: InProcessMcpDispatchOptions
): NodeJS.ProcessEnv {
  const profile = options.profile
  return {
    TASKWRAITH_CORE_MCP_PROFILE: '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.safeSubset]: profile.safeSubset ? '1' : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.planSubset]: profile.planSubset ? '1' : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.coreSubset]: profile.coreSubset ? '1' : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.gatewaySubset]: profile.gatewaySubset ? '1' : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.soloSubset]: profile.soloSubset ? '1' : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.portableEnsembleControl]: profile.portableEnsembleControl
      ? '1'
      : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.meshDirect]: profile.meshDirect ? '1' : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.meshTopologyDirect]: profile.meshTopologyDirect ? '1' : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.sketchDirect]: profile.sketchDirect ? '1' : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.orchestrationDirect]: profile.orchestrationDirect ? '1' : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.permissionOpportunityDirect]: profile.permissionOpportunityDirect
      ? '1'
      : '0',
    [MCP_BRIDGE_PROFILE_ENV_KEYS.auditSubset]: profile.auditSubset ? '1' : '0',
    [MCP_BRIDGE_ROUTE_ENV_KEYS.parentProvider]: options.parentProvider,
    [MCP_BRIDGE_ROUTE_ENV_KEYS.runId]: options.route.appRunId || '',
    [MCP_BRIDGE_ROUTE_ENV_KEYS.chatId]: options.route.appChatId || '',
    [MCP_BRIDGE_ROUTE_ENV_KEYS.workspacePath]: options.workspace || '',
    // Direct in-process dispatch owns no reusable socket endpoint. Explicit
    // blanks prevent ambient endpoint authority from leaking into this route.
    [MCP_BRIDGE_ENDPOINT_ENV_KEYS.socketPath]: '',
    [MCP_BRIDGE_ENDPOINT_ENV_KEYS.brokerToken]: '',
    [MCP_BRIDGE_ENDPOINT_ENV_KEYS.instanceEpoch]: options.instanceEpoch,
    [MCP_BRIDGE_ENDPOINT_ENV_KEYS.bridgeLogEpoch]: '0',
    [MCP_BRIDGE_ENDPOINT_ENV_KEYS.isolatedInstanceId]: ''
  }
}

/**
 * Adapt an authenticated, per-run in-process transport to the shared MCP
 * catalogue and call guard. Every route and profile input is explicit; ambient
 * process selectors cannot widen or retarget the request.
 */
export function createInProcessMcpDispatch(
  options: InProcessMcpDispatchOptions
): (message: Record<string, unknown>) => Promise<Record<string, unknown> | null> {
  const transportId = `in-process://${options.parentProvider}`
  const deps = {
    getDefaultSocketPath: () => transportId,
    getAppVersion: () => options.appVersion,
    getMcpToolDefinitions: options.getMcpToolDefinitions,
    brokerRequest: (_socketPath: string, request: unknown) =>
      options.dispatchBrokerRequest(request),
    env: buildInProcessMcpDispatchEnvironment(options)
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
          transportId,
          options.brokerToken,
          message,
          'line'
        )
      } catch {
        finish(mcpUnexpectedInternalError(message.id))
      }

      if (!settled) {
        timeout = setTimeout(
          () => {
            const params =
              message.params && typeof message.params === 'object' && !Array.isArray(message.params)
                ? (message.params as Record<string, unknown>)
                : null
            void (async () => {
              try {
                await options.onDispatchTimeout?.({
                  ...(options.route.appRunId ? { appRunId: options.route.appRunId } : {}),
                  ...(options.route.appChatId ? { appChatId: options.route.appChatId } : {}),
                  requestId:
                    typeof message.id === 'string' || typeof message.id === 'number'
                      ? message.id
                      : null,
                  ...(message.method === 'tools/call' && typeof params?.name === 'string'
                    ? { toolName: params.name }
                    : {})
                })
              } catch {
                // Cancellation failure is not settlement evidence. Leave the
                // call pending so the terminal watchdog remains fail closed.
                return
              }
              finish({
                jsonrpc: '2.0',
                id: message.id ?? null,
                error: { code: -32000, message: 'TaskWraith MCP dispatch timed out.' }
              })
            })()
          },
          options.timeoutMs ?? mcpBrokerRequestTimeoutMsFor(message)
        )
      }
    })
}
