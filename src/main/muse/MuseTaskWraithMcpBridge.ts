import { GEMINI_MCP_BRIDGE_ENV } from '../geminiMcpConstants'
import type { McpBridgeProviderRunEnvironmentInput } from '../mcp/McpBridgeRuntime'
import type {
  McpBridgeProfileEnvironment,
  McpBridgeRouteEnvironmentVariables
} from '../mcp/McpBridgeRoute'
import {
  isCoreTaskWraithMcpProfile,
  isGatewayTaskWraithMcpProfile,
  isGatewayV13DirectTaskWraithMcpProfile,
  isMeshCanvasDirectTaskWraithMcpProfile,
  isMeshTopologyDirectTaskWraithMcpProfile,
  isPortableEnsembleControlMcpProfile,
  isSketchCanvasDirectTaskWraithMcpProfile
} from '../mcp/McpSessionProfileFence'
import type { TaskWraithMcpProfileId } from '../store/types'
import type { MuseTaskWraithMcpInvocation } from './MuseMcpConfig'

export interface MuseTaskWraithMcpPreparationInput {
  readonly appRunId: string
  readonly appChatId?: string
  readonly workspacePath: string
  readonly approvalMode?: string | null
  readonly taskWraithMcpProfileId?: TaskWraithMcpProfileId | null
}

export interface MuseTaskWraithMcpBridgeCommandStatus {
  readonly command: string
  readonly available: boolean
  readonly error?: string
}

/** The small runtime surface a Muse run needs; the composition root owns the instance. */
export interface MuseTaskWraithMcpBridgeRuntime {
  startGeminiMcpBroker(): Promise<unknown>
  buildProviderRunMcpBridgeEnv(
    input: McpBridgeProviderRunEnvironmentInput
  ): McpBridgeRouteEnvironmentVariables
}

export interface MuseTaskWraithMcpBridgeDeps {
  readonly runtime: MuseTaskWraithMcpBridgeRuntime
  readonly getCommandStatus: () => MuseTaskWraithMcpBridgeCommandStatus
  readonly unavailableMessage: (status: MuseTaskWraithMcpBridgeCommandStatus) => string
  readonly staticRegistrationArgs: () => readonly string[]
  readonly isolatedInstanceId?: string
}

/**
 * Resolve the immutable MCP profile receipt to the exact runtime scope for a
 * Muse child. Plan seats get the read-only safe subset; native Muse tools stay
 * outside this broker and retain their provider-owned containment.
 */
export function buildMuseTaskWraithMcpProfile(input: {
  readonly approvalMode?: string | null
  readonly taskWraithMcpProfileId: TaskWraithMcpProfileId
}): McpBridgeProfileEnvironment {
  const profileId = input.taskWraithMcpProfileId
  return {
    safeSubset: input.approvalMode?.trim() === 'plan',
    planSubset: false,
    coreSubset: isCoreTaskWraithMcpProfile(profileId),
    gatewaySubset: isGatewayTaskWraithMcpProfile(profileId),
    portableEnsembleControl: isPortableEnsembleControlMcpProfile(profileId),
    meshDirect: isMeshCanvasDirectTaskWraithMcpProfile(profileId),
    meshTopologyDirect: isMeshTopologyDirectTaskWraithMcpProfile(profileId),
    sketchDirect: isSketchCanvasDirectTaskWraithMcpProfile(profileId),
    orchestrationDirect: isGatewayV13DirectTaskWraithMcpProfile(profileId),
    auditSubset: false
  }
}

/**
 * Prepare the exact app-owned stdio invocation Muse receives in its isolated
 * settings document. Static argv carries no authority; live route credentials
 * are placed only in the one-run settings file and removed at teardown.
 */
export async function prepareMuseTaskWraithMcpInvocation(
  input: MuseTaskWraithMcpPreparationInput,
  deps: MuseTaskWraithMcpBridgeDeps
): Promise<MuseTaskWraithMcpInvocation> {
  const profileId = input.taskWraithMcpProfileId
  if (!profileId) {
    throw new Error('The composed Muse broker request has no TaskWraith MCP profile.')
  }
  const commandStatus = deps.getCommandStatus()
  if (!commandStatus.available) {
    throw new Error(deps.unavailableMessage(commandStatus))
  }
  await deps.runtime.startGeminiMcpBroker()
  return {
    command: commandStatus.command,
    args: [...deps.staticRegistrationArgs()],
    env: {
      [GEMINI_MCP_BRIDGE_ENV]: '1',
      ...deps.runtime.buildProviderRunMcpBridgeEnv({
        route: { appRunId: input.appRunId, appChatId: input.appChatId },
        parentProvider: 'muse',
        workspacePath: input.workspacePath,
        profile: buildMuseTaskWraithMcpProfile({
          approvalMode: input.approvalMode,
          taskWraithMcpProfileId: profileId
        }),
        ...(deps.isolatedInstanceId ? { isolatedInstanceId: deps.isolatedInstanceId } : {})
      })
    }
  }
}
