import { describe, expect, it, vi } from 'vitest'
import { GEMINI_MCP_BRIDGE_ENV } from '../geminiMcpConstants'
import { taskWraithMcpAdvertisedToolNamesForProfile } from '../mcp/McpToolProfiles'
import {
  TASKWRAITH_GATEWAY_MCP_PROFILE_ID,
  TASKWRAITH_GATEWAY_SOLO_V1_MCP_PROFILE_ID
} from '../mcp/McpSessionProfileFence'
import {
  buildMuseTaskWraithMcpProfile,
  prepareMuseTaskWraithMcpInvocation,
  type MuseTaskWraithMcpBridgeDeps
} from './MuseTaskWraithMcpBridge'

function bridgeDeps(overrides: Partial<MuseTaskWraithMcpBridgeDeps> = {}) {
  const startGeminiMcpBroker = vi.fn(async () => undefined)
  const buildProviderRunMcpBridgeEnv = vi.fn(() => ({
    TASKWRAITH_PARENT_PROVIDER: 'muse',
    TASKWRAITH_RUN_ID: 'run-muse-1',
    TASKWRAITH_CHAT_ID: 'chat-muse-1',
    TASKWRAITH_MCP_BROKER_TOKEN: 'a'.repeat(64)
  }))
  return {
    runtime: { startGeminiMcpBroker, buildProviderRunMcpBridgeEnv },
    getCommandStatus: () => ({ command: '/Applications/TaskWraith', available: true }),
    unavailableMessage: () => 'bridge unavailable',
    staticRegistrationArgs: () => [
      '--taskwraith-gemini-mcp-bridge',
      '--taskwraith-mcp-route-from-env'
    ],
    ...overrides
  } satisfies MuseTaskWraithMcpBridgeDeps
}

describe('Muse TaskWraith MCP bridge preparation', () => {
  it('preserves ensemble_yield in the fresh gateway profile and scopes plan Muse seats safely', () => {
    expect(taskWraithMcpAdvertisedToolNamesForProfile(TASKWRAITH_GATEWAY_MCP_PROFILE_ID)).toContain(
      'ensemble_yield'
    )
    expect(
      buildMuseTaskWraithMcpProfile({
        approvalMode: 'plan',
        taskWraithMcpProfileId: TASKWRAITH_GATEWAY_MCP_PROFILE_ID
      })
    ).toMatchObject({ safeSubset: true, gatewaySubset: true, planSubset: false })
  })

  it('selects the exact lean solo subset without losing orchestration primitives', () => {
    expect(
      taskWraithMcpAdvertisedToolNamesForProfile(TASKWRAITH_GATEWAY_SOLO_V1_MCP_PROFILE_ID)
    ).toEqual(expect.arrayContaining(['ensemble_await', 'ensemble_lane_result', 'delegate_wave']))
    expect(
      buildMuseTaskWraithMcpProfile({
        approvalMode: 'default',
        taskWraithMcpProfileId: TASKWRAITH_GATEWAY_SOLO_V1_MCP_PROFILE_ID
      })
    ).toMatchObject({
      safeSubset: false,
      gatewaySubset: true,
      soloSubset: true,
      portableEnsembleControl: true,
      orchestrationDirect: true
    })
  })

  it('starts the broker and returns static argv with route authority only in child env', async () => {
    const deps = bridgeDeps({ isolatedInstanceId: 'a'.repeat(32) })

    const invocation = await prepareMuseTaskWraithMcpInvocation(
      {
        appRunId: 'run-muse-1',
        appChatId: 'chat-muse-1',
        workspacePath: '/workspace',
        approvalMode: 'plan',
        taskWraithMcpProfileId: TASKWRAITH_GATEWAY_MCP_PROFILE_ID
      },
      deps
    )

    expect(deps.runtime.startGeminiMcpBroker).toHaveBeenCalledOnce()
    expect(deps.runtime.buildProviderRunMcpBridgeEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        route: { appRunId: 'run-muse-1', appChatId: 'chat-muse-1' },
        parentProvider: 'muse',
        workspacePath: '/workspace',
        isolatedInstanceId: 'a'.repeat(32),
        profile: expect.objectContaining({ safeSubset: true, gatewaySubset: true })
      })
    )
    expect(invocation).toEqual({
      command: '/Applications/TaskWraith',
      args: ['--taskwraith-gemini-mcp-bridge', '--taskwraith-mcp-route-from-env'],
      env: expect.objectContaining({
        [GEMINI_MCP_BRIDGE_ENV]: '1',
        TASKWRAITH_PARENT_PROVIDER: 'muse',
        TASKWRAITH_MCP_BROKER_TOKEN: 'a'.repeat(64)
      })
    })
    expect(invocation.args.join(' ')).not.toMatch(/token|socket|epoch|profile/i)
  })

  it('passes the solo selector through the complete bridge profile', async () => {
    const deps = bridgeDeps()

    await prepareMuseTaskWraithMcpInvocation(
      {
        appRunId: 'run-muse-solo',
        appChatId: 'chat-muse-solo',
        workspacePath: '/workspace',
        taskWraithMcpProfileId: TASKWRAITH_GATEWAY_SOLO_V1_MCP_PROFILE_ID
      },
      deps
    )

    expect(deps.runtime.buildProviderRunMcpBridgeEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          gatewaySubset: true,
          soloSubset: true,
          orchestrationDirect: true
        })
      })
    )
  })

  it('fails closed before broker startup when the profile or executable is unavailable', async () => {
    const missingProfile = bridgeDeps()
    await expect(
      prepareMuseTaskWraithMcpInvocation(
        { appRunId: 'run-muse-1', workspacePath: '/workspace' },
        missingProfile
      )
    ).rejects.toThrow(/no TaskWraith MCP profile/i)
    expect(missingProfile.runtime.startGeminiMcpBroker).not.toHaveBeenCalled()

    const unavailable = bridgeDeps({
      getCommandStatus: () => ({ command: '/Applications/TaskWraith', available: false }),
      unavailableMessage: () => 'TaskWraith bridge executable is unavailable'
    })
    await expect(
      prepareMuseTaskWraithMcpInvocation(
        {
          appRunId: 'run-muse-1',
          workspacePath: '/workspace',
          taskWraithMcpProfileId: TASKWRAITH_GATEWAY_MCP_PROFILE_ID
        },
        unavailable
      )
    ).rejects.toThrow(/executable is unavailable/i)
    expect(unavailable.runtime.startGeminiMcpBroker).not.toHaveBeenCalled()
  })
})
