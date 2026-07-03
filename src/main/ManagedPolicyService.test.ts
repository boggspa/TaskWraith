import { describe, expect, it } from 'vitest'
import {
  loadManagedPolicyFromEnvironment,
  ManagedPolicyService,
  parseManagedPolicyDocument
} from './ManagedPolicyService'
import type { AppSettings } from './store/types'

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    activeProvider: 'codex',
    storeLocalChatHistory: true,
    storeRawEvents: false,
    storePromptResponseInUsage: true,
    ensembleModeEnabled: true,
    geminiCheckpointingEnabled: false,
    chatContextTurns: 6,
    appearanceMode: 'soft_glass',
    visualEffectStyle: 'sidebar',
    themeAppearance: 'dark',
    themeCornerStyle: 'rounded',
    themeAccentStyle: 'system',
    toolIconAccent: 'system',
    userBubbleColor: 'system',
    appIconVariant: 'regular',
    promptSurfaceStyle: 'default',
    composerStyle: 'default',
    funFxEnabled: true,
    funFxMode: 'cinematic',
    advancedFx: {
      agentAura: true,
      livingWorkspace: true,
      dataViz: true,
      refraction: true,
      intensity: 'cinematic'
    },
    reduceTransparency: false,
    reduceMotion: false,
    compactDensity: false,
    liveActivityViewport: true,
    showInspector: true,
    inspectorWidth: 420,
    sidebarWidth: 280,
    agenticServices: {
      shellCommands: 'allow',
      fileChanges: 'workspace',
      externalPublish: 'allow',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      canvasEval: 'ask',
      crossThreadRead: 'ask',
      mediaEditing: 'ask',
      mediaRecording: 'deny',
      networkAccess: 'allow'
    },
    agenticWorkspaceGrants: [
      {
        id: 'grant-1',
        workspacePath: '/repo',
        provider: 'codex',
        service: 'shellCommands',
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z'
      }
    ],
    geminiMcpBridgeEnabled: true,
    codexSandboxFallback: 'ask_rerun',
    autoUpdateEnabled: false,
    updateChannel: 'debug',
    approvalTimeouts: {
      enabled: true,
      perProviderMs: {
        gemini: 120_000,
        codex: 30_000,
        claude: 120_000,
        kimi: 60_000
      },
      mainAuthorityMs: 120_000
    },
    userMcpServers: [
      {
        id: 'unsafe',
        name: 'Unsafe',
        enabled: true,
        transport: 'stdio',
        command: '/tmp/unsafe',
        args: []
      }
    ],
    currency: 'USD',
    ...overrides
  } as AppSettings
}

describe('ManagedPolicyService', () => {
  it('loads env JSON and computes locked/enforced settings', () => {
    const service = loadManagedPolicyFromEnvironment({
      env: {
        TASKWRAITH_MANAGED_POLICY_JSON: JSON.stringify({
          schemaVersion: 1,
          organizationName: 'Acme Corp',
          lockedSettings: ['approvalTimeouts'],
          settings: {
            autoUpdateEnabled: true,
            updateChannel: 'stable',
            geminiMcpBridgeEnabled: false,
            codexSandboxFallback: 'off',
            agenticServices: {
              shellCommands: 'ask',
              fileChanges: 'ask',
              externalPublish: 'deny',
              networkAccess: 'deny'
            },
            approvalTimeouts: {
              enabled: true,
              perProviderMs: { codex: 45_000 },
              mainAuthorityMs: 90_000
            },
            userMcpServers: [{ ignored: true }],
            agenticWorkspaceGrants: [{ ignored: true }]
          }
        })
      }
    })

    expect(service.snapshot()).toMatchObject({
      active: true,
      source: 'env-json',
      organizationName: 'Acme Corp',
      lockedSettings: expect.arrayContaining([
        'approvalTimeouts',
        'autoUpdateEnabled',
        'updateChannel',
        'geminiMcpBridgeEnabled',
        'codexSandboxFallback',
        'agenticServices',
        'userMcpServers',
        'agenticWorkspaceGrants'
      ]),
      errors: []
    })
    const patch = service.enforcedSettingsPatch(settings())
    expect(patch).toMatchObject({
      autoUpdateEnabled: true,
      updateChannel: 'stable',
      geminiMcpBridgeEnabled: false,
      codexSandboxFallback: 'off',
      userMcpServers: [],
      agenticWorkspaceGrants: []
    })
    expect(patch.agenticServices).toMatchObject({
      shellCommands: 'ask',
      fileChanges: 'ask',
      externalPublish: 'deny',
      networkAccess: 'deny'
    })
    expect(patch.approvalTimeouts).toMatchObject({
      enabled: true,
      perProviderMs: { codex: 45_000 },
      mainAuthorityMs: 90_000
    })
  })

  it('filters locked settings from user patches while keeping unrelated changes', () => {
    const service = new ManagedPolicyService(
      'env-json',
      parseManagedPolicyDocument({
        lockedSettings: ['updateChannel'],
        settings: { agenticServices: { shellCommands: 'deny' } }
      })
    )
    expect(
      service.filterSettingsPatch({
        updateChannel: 'nightly',
        agenticServices: settings().agenticServices,
        chatContextTurns: 2
      })
    ).toEqual({ chatContextTurns: 2 })
  })

  it('disables user MCP servers that fail the managed launch allowlist at save time', () => {
    const service = new ManagedPolicyService(
      'env-json',
      parseManagedPolicyDocument({
        userMcpLaunchAllowlist: {
          allowedTransports: ['stdio'],
          allowedCommandRoots: ['/opt/taskwraith/mcp']
        }
      })
    )

    const filtered = service.filterSettingsPatch({
      userMcpServers: [
        {
          id: 'safe',
          name: 'Safe',
          enabled: true,
          transport: 'stdio',
          command: '/opt/taskwraith/mcp/safe-server'
        },
        {
          id: 'unsafe',
          name: 'Unsafe',
          enabled: true,
          transport: 'stdio',
          command: '/tmp/unsafe-server'
        }
      ]
    })

    expect(filtered.userMcpServers).toEqual([
      expect.objectContaining({ id: 'safe', enabled: true }),
      expect.objectContaining({ id: 'unsafe', enabled: false })
    ])
  })

  it('reports malformed env policy without throwing during startup', () => {
    const service = loadManagedPolicyFromEnvironment({
      env: { TASKWRAITH_MANAGED_POLICY_JSON: '{' }
    })
    expect(service.snapshot()).toMatchObject({
      active: true,
      source: 'env-json',
      errors: [expect.any(String)]
    })
    expect(service.enforcedSettingsPatch(settings())).toEqual({})
  })

  it('surfaces a redacted user MCP launch allowlist policy', () => {
    const service = loadManagedPolicyFromEnvironment({
      env: {
        TASKWRAITH_MANAGED_POLICY_JSON: JSON.stringify({
          userMcpLaunchAllowlist: {
            allowedTransports: ['stdio', 'http', 'bogus'],
            allowedCommandRoots: ['/opt/taskwraith/mcp'],
            allowedCommandArgPrefixes: ['--config=', '/opt/taskwraith/config/'],
            allowedRemoteSchemes: ['https', 'ftp'],
            allowedRemoteHosts: ['mcp.example.com'],
            allowedRemotePorts: [443, '8443', 70_000, 0],
            allowedRemotePathPrefixes: ['mcp', '/api'],
            allowedHeaderNames: ['X-TaskWraith'],
            allowedEnvKeys: ['SAFE_TOKEN'],
            requirePluginProvenance: true,
            allowedPluginIds: ['managed-tools']
          }
        })
      }
    })

    expect(service.userMcpLaunchAllowlistPolicy()).toEqual({
      allowedTransports: ['stdio', 'http'],
      allowedCommandRoots: ['/opt/taskwraith/mcp'],
      allowedCommandArgPrefixes: ['--config=', '/opt/taskwraith/config/'],
      allowedRemoteSchemes: ['https'],
      allowedRemoteHosts: ['mcp.example.com'],
      allowedRemotePorts: [443, 8443],
      allowedRemotePathPrefixes: ['/mcp', '/api'],
      allowedHeaderNames: ['X-TaskWraith'],
      allowedEnvKeys: ['SAFE_TOKEN'],
      requirePluginProvenance: true,
      allowedPluginIds: ['managed-tools']
    })
    expect(service.snapshot()).toMatchObject({
      active: true,
      userMcpLaunchAllowlist: {
        active: true,
        allowedTransportCount: 2,
        allowedCommandRootCount: 1,
        allowedCommandArgPrefixCount: 2,
        allowedRemoteSchemeCount: 1,
        allowedRemoteHostCount: 1,
        allowedRemotePortCount: 2,
        allowedRemotePathPrefixCount: 2,
        allowedHeaderNameCount: 1,
        allowedEnvKeyCount: 1,
        requirePluginProvenance: true,
        allowedPluginIdCount: 1
      }
    })
  })
})
