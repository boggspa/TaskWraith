import {
  createInProcessMcpDispatch,
  type InProcessMcpDispatchTimeout
} from '../mcp/InProcessMcpDispatch'
import {
  isGatewayV13DirectTaskWraithMcpProfile,
  isMeshCanvasDirectTaskWraithMcpProfile,
  isMeshTopologyDirectTaskWraithMcpProfile,
  isPortableEnsembleControlMcpProfile,
  isSoloTaskWraithMcpProfile,
  isSketchCanvasDirectTaskWraithMcpProfile
} from '../mcp/McpSessionProfileFence'
import type { McpBridgeAgentRunRoute, McpToolDefinition } from '../mcp/McpBridgeRuntime'
import type { McpBridgeProfileEnvironment } from '../mcp/McpBridgeRoute'
import type { TaskWraithMcpProfileId } from '../store/types'
export type KimiMcpDispatchTimeout = InProcessMcpDispatchTimeout

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
  onDispatchTimeout?: (input: KimiMcpDispatchTimeout) => void | Promise<void>
}

function kimiMcpDispatchProfile(options: KimiMcpDispatchOptions): McpBridgeProfileEnvironment {
  return {
    // Preserve the historical Kimi in-process profile exactly: Kimi always
    // enters through the gateway catalogue, with optional newer direct surfaces.
    safeSubset: false,
    planSubset: false,
    coreSubset: false,
    gatewaySubset: true,
    soloSubset: isSoloTaskWraithMcpProfile(options.taskWraithMcpProfileId),
    portableEnsembleControl: isPortableEnsembleControlMcpProfile(options.taskWraithMcpProfileId),
    meshDirect: isMeshCanvasDirectTaskWraithMcpProfile(options.taskWraithMcpProfileId),
    meshTopologyDirect: isMeshTopologyDirectTaskWraithMcpProfile(options.taskWraithMcpProfileId),
    sketchDirect: isSketchCanvasDirectTaskWraithMcpProfile(options.taskWraithMcpProfileId),
    orchestrationDirect: isGatewayV13DirectTaskWraithMcpProfile(options.taskWraithMcpProfileId),
    permissionOpportunityDirect: false,
    auditSubset: options.auditSubset === true
  }
}

/**
 * Kimi's HTTP bridge runs in Electron main, so it must receive a complete
 * explicit route/profile rather than inherit ambient MCP selectors.
 */
export function createKimiMcpDispatch(
  options: KimiMcpDispatchOptions
): (message: Record<string, unknown>) => Promise<Record<string, unknown> | null> {
  return createInProcessMcpDispatch({
    parentProvider: 'kimi',
    route: options.route,
    profile: kimiMcpDispatchProfile(options),
    workspace: options.workspace,
    appVersion: options.appVersion,
    brokerToken: options.brokerToken,
    instanceEpoch: options.instanceEpoch,
    getMcpToolDefinitions: options.getMcpToolDefinitions,
    dispatchBrokerRequest: options.dispatchBrokerRequest,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.onDispatchTimeout ? { onDispatchTimeout: options.onDispatchTimeout } : {})
  })
}
