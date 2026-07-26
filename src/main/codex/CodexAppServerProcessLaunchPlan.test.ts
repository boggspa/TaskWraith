import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), 'codex-app-server-process-plan-test'),
    getVersion: () => 'test'
  }
}))

import type { RuntimeProfile } from '../store/types'
import { buildCodexAppServerProcessLaunchPlan } from './CodexAppServerProcessLaunchPlan'

function runtimeProfile(overrides: Partial<RuntimeProfile> = {}): RuntimeProfile {
  return {
    id: 'codex-profile',
    name: 'Codex profile',
    provider: 'codex',
    scope: 'workspace',
    workspaceMode: 'local',
    binaryPath: '/opt/codex',
    env: { PROFILE_VALUE: 'selected-profile' },
    networkPolicy: 'inherit',
    persistence: 'reusable',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...overrides
  }
}

describe('Codex app-server immutable process launch plan', () => {
  it('resolves the exact runtime profile, MCP env, private home and code-mode host once', async () => {
    const profile = runtimeProfile({
      env: {
        PROFILE_VALUE: 'selected-profile',
        CODEX_HOME: '/runtime-profile/must-not-win'
      },
      secretRefs: { env: ['PROFILE_TOKEN'] }
    })
    const getRuntimeProfiles = vi.fn(() => {
      throw new Error('the exact selected profile must not be re-looked-up by id')
    })
    const withCodeModeHostEnv = vi.fn(async (env: Record<string, string>) => ({
      ...env,
      CODEX_CODE_MODE_HOST_PATH: '/opt/codex-code-mode-host'
    }))

    const plan = await buildCodexAppServerProcessLaunchPlan({
      binaryPath: '/opt/codex',
      codexHome: '/private/taskwraith/codex-home',
      mcpConfigArgs: ['-c', 'mcp_servers.TaskWraith.command="/opt/bridge"'],
      mcp: {
        enabled: true,
        parentProvider: 'codex',
        userMcpServers: [
          {
            serverName: 'docs',
            transport: 'stdio',
            command: '/opt/docs-mcp',
            args: [],
            providerEnv: { USER_MCP_TOKEN: 'user-mcp-secret' }
          }
        ]
      },
      runtimeProfile: profile,
      cliRuntimeDeps: {
        env: { PATH: '/usr/bin', HOME: '/Users/test' },
        getRuntimeProfiles,
        resolveExtensionSecretValues: (refs) =>
          refs.map((ref) => ({ ref, status: 'ok' as const, value: 'profile-secret' }))
      },
      withCodeModeHostEnv
    })

    expect(getRuntimeProfiles).not.toHaveBeenCalled()
    expect(withCodeModeHostEnv).toHaveBeenCalledTimes(1)
    expect(plan).toEqual({
      transport: 'app-server',
      startupCompatibility: 'configured',
      command: '/opt/codex',
      args: ['-c', 'mcp_servers.TaskWraith.command="/opt/bridge"', 'app-server'],
      shell: false,
      env: expect.objectContaining({
        PROFILE_VALUE: 'selected-profile',
        PROFILE_TOKEN: 'profile-secret',
        USER_MCP_TOKEN: 'user-mcp-secret',
        CODEX_HOME: '/private/taskwraith/codex-home',
        TASKWRAITH_RUNTIME_PROFILE_ID: 'codex-profile',
        TASKWRAITH_PARENT_PROVIDER: 'codex',
        CODEX_CODE_MODE_HOST_PATH: '/opt/codex-code-mode-host',
        FORCE_COLOR: '0',
        NO_COLOR: '1'
      })
    })
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.args)).toBe(true)
    expect(Object.isFrozen(plan.env)).toBe(true)
  })

  it('keeps a disabled bridge truthful and represents the compatibility spawn separately', async () => {
    const plan = await buildCodexAppServerProcessLaunchPlan({
      binaryPath: '/opt/codex',
      codexHome: '/private/taskwraith/codex-home',
      mcpConfigArgs: [],
      mcp: {
        enabled: false,
        parentProvider: 'codex'
      },
      runtimeProfile: null,
      forceFastServiceTier: true,
      cliRuntimeDeps: {
        env: { PATH: '/usr/bin' }
      },
      withCodeModeHostEnv: async (env) => env
    })

    expect(plan.startupCompatibility).toBe('force-fast-service-tier')
    expect(plan.args).toEqual(['-c', 'service_tier="fast"', 'app-server'])
    expect(plan.env).not.toHaveProperty('TASKWRAITH_PARENT_PROVIDER')
    expect(plan.env).not.toHaveProperty('TASKWRAITH_RUNTIME_PROFILE_ID')
  })
})
