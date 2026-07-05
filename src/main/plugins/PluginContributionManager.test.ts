import { describe, expect, it, vi } from 'vitest'
import { PluginContributionManager } from './PluginContributionManager'
import type {
  AppSettings,
  RuntimeProfile,
  UserMcpServerConfig
} from '../store/types'
import type { TaskWraithPluginContributionSnapshot } from '../../shared/plugins/PluginTypes'

const materializedAt = '2026-06-29T12:00:00.000Z'

function baseSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    activeProvider: 'codex',
    providerRunPauses: {},
    storeLocalChatHistory: true,
    storeRawEvents: true,
    storePromptResponseInUsage: false,
    ensembleModeEnabled: true,
    geminiCheckpointingEnabled: false,
    chatContextTurns: 20,
    appearanceMode: 'solid',
    visualEffectStyle: 'auto',
    themeAppearance: 'system',
    themeCornerStyle: 'rounded',
    themeAccentStyle: 'system',
    toolIconAccent: 'system',
    userBubbleColor: 'system',
    appIconVariant: 'classic',
    promptSurfaceStyle: 'theme',
    composerStyle: 'default',
    agenticServices: {
      shellCommands: 'workspace',
      fileChanges: 'ask',
      externalPublish: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      canvasEval: 'ask',
      crossThreadRead: 'ask',
      mediaEditing: 'ask',
      mediaRecording: 'deny',
      networkAccess: 'allow'
    },
    nativeSubAgentRequests: 'ask',
    geminiApiRuntime: 'auto',
    userMcpServers: [],
    storeLocalChatHistoryPromptedAt: '',
    geminiMcpBridgeEnabled: true,
    bridgeDaemonEnabled: false,
    localServersDetachSpawns: true,
    localServersStopOnQuit: false,
    codexSandboxFallback: 'ask_rerun',
    autoUpdateEnabled: true,
    updateChannel: 'stable',
    approvalTimeouts: {
      defaultMs: 120_000,
      perProviderMs: {}
    },
    ...overrides
  } as AppSettings
}

function contributions(): TaskWraithPluginContributionSnapshot {
  const plugin = {
    pluginId: 'demo-bundle',
    publisher: 'acme',
    version: '1.0.0',
    source: 'builtin' as const,
    namespace: 'plugin.acme.demo-bundle',
    manifestHash: 'sha256:abc'
  }
  return {
    schemaVersion: 1,
    generatedAt: materializedAt,
    mcpServers: [
      {
        plugin,
        preset: {
          id: 'docs',
          name: 'Docs',
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          requiredSecrets: ['token']
        },
        userMcpServerConfig: {
          id: 'plugin:demo-bundle:mcp:docs',
          name: 'Demo Bundle: Docs',
          enabled: false,
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          secretRefs: { env: ['DEMO_TOKEN'] }
        }
      }
    ],
    taskwraithToolBundles: [
      {
        plugin,
        bundle: {
          id: 'review-tools',
          label: 'Review tools',
          tools: ['git_diff', 'git_status']
        }
      }
    ],
    workflowTemplates: [
      {
        plugin,
        template: {
          id: 'review',
          name: 'Review',
          prompt: 'Review this change.',
          provider: 'codex',
          requiredTools: ['git_diff']
        }
      }
    ],
    runtimeProfiles: [
      {
        plugin,
        profile: {
          id: 'codex-review',
          name: 'Codex review',
          provider: 'codex',
          scope: 'workspace',
          workspaceMode: 'local',
          approvalMode: 'default',
          agenticServices: {
            shellCommands: 'ask',
            fileChanges: 'ask',
            mcpTools: 'ask'
          }
        },
        runtimeProfileId: 'plugin:demo-bundle:runtime:codex-review'
      }
    ],
    connectors: [
      {
        plugin,
        connector: {
          id: 'github',
          label: 'GitHub',
          kind: 'mcp',
          requiredSecrets: ['token']
        }
      }
    ],
    localServices: [
      {
        plugin,
        service: {
          id: 'browser',
          label: 'Browser service',
          ports: [4173],
          managedByTaskWraith: true
        },
        serviceId: 'plugin:demo-bundle:service:browser'
      }
    ],
    providerSetup: [
      {
        plugin,
        setup: {
          provider: 'codex',
          label: 'Codex CLI',
          installHint: 'Install Codex.',
          preflightChecks: ['binary', 'auth']
        }
      }
    ],
    mobileRemoteProjection: [
      {
        plugin,
        projection: {
          id: 'ios',
          label: 'iOS remote',
          remoteCapabilities: ['viewStatus']
        },
        projectionId: 'plugin:demo-bundle:remote:ios'
      }
    ],
    counts: {
      enabledPlugins: 1,
      mcpServers: 1,
      taskwraithToolBundles: 1,
      workflowTemplates: 1,
      runtimeProfiles: 1,
      connectors: 1,
      localServices: 1,
      providerSetup: 1,
      mobileRemoteProjection: 1
    }
  }
}

function emptyContributions(): TaskWraithPluginContributionSnapshot {
  return {
    ...contributions(),
    mcpServers: [],
    taskwraithToolBundles: [],
    workflowTemplates: [],
    runtimeProfiles: [],
    connectors: [],
    localServices: [],
    providerSetup: [],
    mobileRemoteProjection: [],
    counts: {
      enabledPlugins: 0,
      mcpServers: 0,
      taskwraithToolBundles: 0,
      workflowTemplates: 0,
      runtimeProfiles: 0,
      connectors: 0,
      localServices: 0,
      providerSetup: 0,
      mobileRemoteProjection: 0
    }
  }
}

function makeHarness(snapshot: TaskWraithPluginContributionSnapshot = contributions()) {
  let settings = baseSettings()
  let runtimeProfiles: RuntimeProfile[] = []
  const manager = new PluginContributionManager({
    pluginHost: {
      getContributionSnapshot: vi.fn(() => snapshot)
    },
    getSettings: () => settings,
    updateSettings: (partial) => {
      settings = { ...settings, ...partial }
    },
    getRuntimeProfiles: () => runtimeProfiles,
    saveRuntimeProfile: (profile) => {
      const now = materializedAt
      const saved: RuntimeProfile = {
        id: profile.id || `profile-${runtimeProfiles.length + 1}`,
        name: profile.name,
        provider: profile.provider,
        scope: profile.scope || 'workspace',
        workspaceMode: profile.workspaceMode || 'local',
        binaryPath: profile.binaryPath,
        env: profile.env || {},
        secretRefs: profile.secretRefs,
        mcpProfileId: profile.mcpProfileId,
        approvalMode: profile.approvalMode,
        agenticServices: profile.agenticServices,
        networkPolicy: profile.networkPolicy || 'inherit',
        persistence: profile.persistence || 'reusable',
        containerConfig: profile.containerConfig,
        pluginProvenance: profile.pluginProvenance,
        builtin: profile.builtin,
        createdAt: profile.createdAt || now,
        updatedAt: profile.updatedAt || now
      }
      const index = runtimeProfiles.findIndex((item) => item.id === saved.id)
      if (index >= 0) runtimeProfiles[index] = saved
      else runtimeProfiles.push(saved)
      return saved
    },
    deleteRuntimeProfile: (id) => {
      runtimeProfiles = runtimeProfiles.filter((profile) => profile.id !== id)
    },
    now: () => new Date(materializedAt)
  })
  return {
    manager,
    getSettings: () => settings,
    setSettings: (next: AppSettings) => {
      settings = next
    },
    getRuntimeProfiles: () => runtimeProfiles,
    setRuntimeProfiles: (next: RuntimeProfile[]) => {
      runtimeProfiles = next
    }
  }
}

describe('PluginContributionManager', () => {
  it('materializes enabled plugin MCP servers and runtime profiles with provenance', () => {
    const harness = makeHarness()

    const activation = harness.manager.sync()

    const [server] = harness.getSettings().userMcpServers || []
    expect(server).toMatchObject({
      id: 'plugin:demo-bundle:mcp:docs',
      name: 'Demo Bundle: Docs',
      enabled: false,
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      secretRefs: { env: ['DEMO_TOKEN'] },
      pluginReview: {
        status: 'pending',
        reason: 'new-plugin-resource',
        manifestHash: 'sha256:abc'
      },
      pluginProvenance: {
        pluginId: 'demo-bundle',
        kind: 'mcpServer',
        objectId: 'docs',
        materializedAt
      }
    })
    expect(harness.getRuntimeProfiles()[0]).toMatchObject({
      id: 'plugin:demo-bundle:runtime:codex-review',
      name: 'Codex review',
      provider: 'codex',
      pluginProvenance: {
        pluginId: 'demo-bundle',
        kind: 'runtimeProfile',
        objectId: 'codex-review',
        materializedAt
      }
    })
    expect(activation.counts).toMatchObject({
      enabledPlugins: 1,
      mcpServers: 1,
      runtimeProfiles: 1,
      taskwraithToolBundles: 1,
      workflowTemplates: 1,
      connectors: 1,
      localServices: 1,
      providerSetup: 1,
      mobileRemoteProjection: 1
    })
    expect(activation.taskwraithToolBundles[0]).toMatchObject({
      id: 'plugin:demo-bundle:tool:review-tools',
      pluginProvenance: {
        kind: 'toolBundle',
        objectId: 'review-tools'
      }
    })
  })

  it('is idempotent and preserves enabled MCP server state for the same manifest', () => {
    const harness = makeHarness()
    harness.manager.sync()
    const existing = (harness.getSettings().userMcpServers || [])[0] as UserMcpServerConfig
    harness.setSettings({
      ...harness.getSettings(),
      userMcpServers: [{ ...existing, enabled: true }]
    })

    harness.manager.sync()

    expect(harness.getSettings().userMcpServers).toHaveLength(1)
    expect(harness.getSettings().userMcpServers?.[0]?.enabled).toBe(true)
    expect(harness.getSettings().userMcpServers?.[0]?.pluginReview).toMatchObject({
      status: 'accepted',
      reason: 'user-enabled-reviewed-resource',
      manifestHash: 'sha256:abc',
      reviewedAt: materializedAt
    })
    expect(harness.getRuntimeProfiles()).toHaveLength(1)
  })

  it('marks changed plugin MCP server manifests as pending review and disables them', () => {
    const harness = makeHarness()
    harness.manager.sync()
    const existing = (harness.getSettings().userMcpServers || [])[0] as UserMcpServerConfig
    harness.setSettings({
      ...harness.getSettings(),
      userMcpServers: [{ ...existing, enabled: true }]
    })
    harness.manager.sync()

    const nextContributions = contributions()
    const plugin = nextContributions.mcpServers[0]?.plugin
    if (!plugin) throw new Error('missing fixture plugin')
    plugin.version = '1.1.0'
    plugin.manifestHash = 'sha256:def'
    const changedHarness = makeHarness(nextContributions)
    changedHarness.setSettings(harness.getSettings())
    changedHarness.setRuntimeProfiles(harness.getRuntimeProfiles())

    changedHarness.manager.sync()

    expect(changedHarness.getSettings().userMcpServers?.[0]).toMatchObject({
      id: 'plugin:demo-bundle:mcp:docs',
      enabled: false,
      pluginReview: {
        status: 'pending',
        reason: 'manifest-update',
        manifestHash: 'sha256:def'
      }
    })
  })

  it('disables stale plugin MCP servers and removes stale plugin runtime profiles', () => {
    const harness = makeHarness()
    harness.manager.sync()

    const staleHarness = makeHarness(emptyContributions())
    staleHarness.setSettings(harness.getSettings())
    staleHarness.setRuntimeProfiles(harness.getRuntimeProfiles())
    const activation = staleHarness.manager.sync()

    expect(staleHarness.getSettings().userMcpServers?.[0]).toMatchObject({
      id: 'plugin:demo-bundle:mcp:docs',
      enabled: false
    })
    expect(staleHarness.getRuntimeProfiles()).toEqual([])
    expect(activation.counts).toMatchObject({
      enabledPlugins: 0,
      mcpServers: 0,
      runtimeProfiles: 0
    })
  })

  it('does not overwrite prefix-colliding resources without plugin provenance', () => {
    const harness = makeHarness()
    const conflicting: UserMcpServerConfig = {
      id: 'plugin:demo-bundle:mcp:docs',
      name: 'Manual docs',
      enabled: true,
      transport: 'stdio',
      command: 'manual'
    }
    harness.setSettings({
      ...harness.getSettings(),
      userMcpServers: [conflicting]
    })

    harness.manager.sync()

    expect(harness.getSettings().userMcpServers).toEqual([conflicting])
  })
})
