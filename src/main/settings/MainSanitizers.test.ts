import { describe, expect, it, vi } from 'vitest'
import {
  createMainSanitizers,
  normalizeAuditRunIdentity,
  sanitizeAuditOrchestration
} from './MainSanitizers'
import type { AppSettings, ExternalPathGrant, WorkspaceRecord } from '../store/types'

describe('normalizeAuditRunIdentity', () => {
  it('accepts a valid audit role identity with optional dimension/findingId', () => {
    expect(
      normalizeAuditRunIdentity({
        auditRunId: 'a1',
        role: 'reviewer',
        dimension: 'code health'
      })
    ).toEqual({ auditRunId: 'a1', role: 'reviewer', dimension: 'code health' })
    expect(
      normalizeAuditRunIdentity({ auditRunId: 'a1', role: 'skeptic', findingId: 'f1' })
    ).toEqual({ auditRunId: 'a1', role: 'skeptic', findingId: 'f1' })
  })

  it('rejects an unknown role or non-record', () => {
    expect(normalizeAuditRunIdentity({ auditRunId: 'a1', role: 'hacker' })).toBeUndefined()
    expect(normalizeAuditRunIdentity(null)).toBeUndefined()
    expect(normalizeAuditRunIdentity({ role: 'recon' })).toBeUndefined() // missing id
  })
})

describe('sanitizeAuditOrchestration', () => {
  it('drops unknown providers from the allowlist + per-role prefs', () => {
    const out = sanitizeAuditOrchestration({
      providerAllowlist: ['claude', 'bogus', 'codex'],
      perRolePreferences: { skeptic: ['grok', 'nope'], junk: ['claude'] }
    })
    expect(out?.providerAllowlist).toEqual(['claude', 'codex'])
    expect(out?.perRolePreferences).toEqual({ skeptic: ['grok'] })
  })

  it('clamps the ollama concurrency cap to 1..4 and budgets to bounds', () => {
    expect(sanitizeAuditOrchestration({ ollamaMaxConcurrent: 99 })?.ollamaMaxConcurrent).toBe(4)
    expect(sanitizeAuditOrchestration({ ollamaMaxConcurrent: 0 })?.ollamaMaxConcurrent).toBe(1)
    expect(sanitizeAuditOrchestration({ budgetMaxAgents: 9999 })?.budgetMaxAgents).toBe(200)
  })

  it('keeps ollamaEnabled boolean and returns undefined for empty/garbage input', () => {
    expect(sanitizeAuditOrchestration({ ollamaEnabled: true })?.ollamaEnabled).toBe(true)
    expect(sanitizeAuditOrchestration({})).toBeUndefined()
    expect(sanitizeAuditOrchestration(null)).toBeUndefined()
    expect(sanitizeAuditOrchestration({ providerAllowlist: ['nope'] })?.providerAllowlist).toEqual([])
  })
})

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    activeProvider: 'gemini',
    storeLocalChatHistory: true,
    storeRawEvents: false,
    storePromptResponseInUsage: false,
    ensembleModeEnabled: true,
    geminiCheckpointingEnabled: false,
    chatContextTurns: 6,
    appearanceMode: 'soft_glass',
    visualEffectStyle: 'auto',
    themeAppearance: 'system',
    themeCornerStyle: 'rounded',
    themeAccentStyle: 'system',
    toolIconAccent: 'system',
    userBubbleColor: 'system',
    promptSurfaceStyle: 'liquid_glass',
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
    currency: 'USD',
    currencyOverestimatePercent: 0,
    welcomeHeatmapPrefs: {
      workspaceActivityEnabled: true,
      taskwraithActivityEnabled: true,
      externalActivityEnabled: true
    },
    kimiSanitiserEnabled: false,
    kimiSanitiserCustomKeywords: '',
    reduceTransparency: false,
    reduceMotion: false,
    compactDensity: false,
    liveActivityViewport: true,
    showInspector: true,
    inspectorWidth: 380,
    sidebarWidth: 260,
    agenticServices: {
      shellCommands: 'workspace',
      fileChanges: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      networkAccess: 'allow'
    },
    agenticWorkspaceGrants: [],
    nativeSubAgentRequests: 'ask',
    autoResumeParentOnSubThreadCompletion: true,
    geminiMcpBridgeEnabled: false,
    bridgeDaemonEnabled: true,
    codexSandboxFallback: 'ask_rerun',
    updateChannel: 'debug',
    approvalTimeouts: {
      enabled: true,
      perProviderMs: {
        gemini: 120_000,
        codex: 30_000,
        claude: 120_000,
        kimi: 60_000
      },
      mainAuthorityMs: 60_000
    },
    ...overrides
  } as AppSettings
}

function makeSanitizers(settings: AppSettings) {
  const workspace: WorkspaceRecord = {
    id: 'workspace-1',
    path: '/tmp/taskwraith-workspace',
    displayName: 'Workspace',
    lastOpenedAt: 1,
    createdAt: 1,
    pinned: false
  }
  return createMainSanitizers({
    getSettings: () => settings,
    getScheduledTasks: () => [],
    getWorkflowDefinitions: () => [],
    findRegisteredWorkspace: (workspacePath: string) =>
      workspacePath === workspace.path ? workspace : undefined,
    requireRegisteredWorkspace: (workspacePath: string) => workspacePath,
    canonicalPath: (value: string) => value,
    normalizeExternalPathGrants: (grants: ExternalPathGrant[]) => grants
  })
}

describe('MainSanitizers scheduled tasks', () => {
  it('rejects invalid or past run times before saving scheduled work', () => {
    const { sanitizeScheduledTaskForSave } = makeSanitizers(makeSettings())
    const baseTask = {
      workspaceId: 'workspace-1',
      workspacePath: '/tmp/taskwraith-workspace',
      chatId: 'chat-1',
      provider: 'codex',
      prompt: 'Run later',
      runAt: new Date(Date.now() + 60_000).toISOString()
    }

    expect(() => sanitizeScheduledTaskForSave({ ...baseTask, runAt: 'not-a-date' })).toThrow(
      'Scheduled task run time is invalid.'
    )
    expect(() =>
      sanitizeScheduledTaskForSave({
        ...baseTask,
        runAt: new Date(Date.now() - 60_000).toISOString()
      })
    ).toThrow('Scheduled task run time must be in the future.')
    expect(sanitizeScheduledTaskForSave(baseTask).runAt).toEqual(baseTask.runAt)
  })
})

describe('MainSanitizers workspace boards', () => {
  it('sanitizes board and card provenance metadata', () => {
    const { sanitizeWorkspaceBoardForSave, sanitizeWorkspaceBoardCardForSave } = makeSanitizers(makeSettings())
    const provenance = {
      actor: 'agent',
      sourceKind: 'goal',
      at: '2026-06-29T00:00:00.000Z',
      trust: 'agent-proposed',
      sourceId: 'goal-1',
      sourceTitle: 'Launch plan',
      provider: 'codex',
      runId: 'run-1',
      note: 'Generated from goal'
    }

    expect(
      sanitizeWorkspaceBoardForSave({
        workspaceId: 'workspace-1',
        workspacePath: '/tmp/taskwraith-workspace',
        name: 'Goal board',
        columns: [],
        provenance
      }).provenance
    ).toEqual(provenance)

    expect(
      sanitizeWorkspaceBoardCardForSave({
        boardId: 'board-1',
        workspaceId: 'workspace-1',
        columnId: 'ready',
        title: 'Review',
        provenance: {
          actor: 'unknown',
          sourceKind: 'surprise',
          trust: 'nope',
          sourceTitle: '  Captured  '
        }
      }).provenance
    ).toMatchObject({
      actor: 'user',
      sourceKind: 'manual',
      sourceTitle: 'Captured'
    })
  })

  it('rejects unknown workspace board card link kinds at the IPC sanitizer boundary', () => {
    const { sanitizeWorkspaceBoardCardForSave, sanitizeWorkspaceBoardCardPatch } = makeSanitizers(makeSettings())

    expect(() =>
      sanitizeWorkspaceBoardCardForSave({
        boardId: 'board-1',
        workspaceId: 'workspace-1',
        columnId: 'ready',
        title: 'Bad link',
        link: { kind: 'bogus', id: 'target-1' }
      })
    ).toThrow('Workspace board card link kind is invalid.')

    expect(() =>
      sanitizeWorkspaceBoardCardPatch({
        link: { kind: 'bogus', id: 'target-1' }
      })
    ).toThrow('Workspace board card link kind is invalid.')
  })

  it('preserves precise workspace board card sort orders through IPC sanitization', () => {
    const { sanitizeWorkspaceBoardCardForSave, sanitizeWorkspaceBoardCardPatch } = makeSanitizers(makeSettings())

    expect(
      sanitizeWorkspaceBoardCardForSave({
        boardId: 'board-1',
        workspaceId: 'workspace-1',
        columnId: 'ready',
        title: 'Precise order',
        sortOrder: 1024.5
      }).sortOrder
    ).toBe(1024.5)

    expect(sanitizeWorkspaceBoardCardPatch({ sortOrder: -1014 }).sortOrder).toBe(-1014)
  })
})

describe('MainSanitizers settings patches', () => {
  it('preserves General dashboard, heatmap, and approval timeout preferences', () => {
    const settings = makeSettings({
      dashboardStatPrefs: {
        visibility: {
          sessions: false
        },
        workspacesShown: 8
      },
      welcomeHeatmapPrefs: {
        layout: 'stacked',
        workspaceActivityEnabled: true,
        taskwraithActivityEnabled: true,
        externalActivityEnabled: true
      }
    })
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    const sanitized = sanitizeSettingsPatch({
      dashboardStatPrefs: {
        dashboardEnabled: false,
        dashboardSize: 'small'
      },
      welcomeHeatmapPrefs: {
        layout: 'single',
        workspaceActivityEnabled: false
      },
      approvalTimeouts: {
        enabled: false,
        perProviderMs: {
          gemini: 240_000
        },
        mainAuthorityMs: 0
      }
    })

    expect(sanitized.dashboardStatPrefs).toMatchObject({
      dashboardEnabled: false,
      dashboardSize: 'small',
      visibility: {
        sessions: false
      },
      workspacesShown: 8
    })
    expect(sanitized.welcomeHeatmapPrefs).toMatchObject({
      layout: 'single',
      workspaceActivityEnabled: false,
      taskwraithActivityEnabled: true,
      externalActivityEnabled: true
    })
    expect(sanitized.approvalTimeouts).toMatchObject({
      enabled: false,
      perProviderMs: {
        gemini: 240_000,
        codex: 30_000,
        claude: 120_000,
        kimi: 60_000
      },
      mainAuthorityMs: 60_000
    })
  })

  it('accepts a valid modelUsagePanelView and drops invalid values', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    expect(sanitizeSettingsPatch({ modelUsagePanelView: 'spend' }).modelUsagePanelView).toBe('spend')
    expect(sanitizeSettingsPatch({ modelUsagePanelView: 'plan' }).modelUsagePanelView).toBe('plan')
    expect(sanitizeSettingsPatch({ modelUsagePanelView: 'context' }).modelUsagePanelView).toBe('context')
    // Anything outside the enum is stripped so a malformed value can't persist.
    expect(
      'modelUsagePanelView' in
        sanitizeSettingsPatch({ modelUsagePanelView: 'bogus' as unknown as 'plan' })
    ).toBe(false)
  })

  it('persists a valid appIconVariant and drops invalid ones (SETTINGS_PATCH_KEYS guard)', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    // Guards the landmine: appIconVariant must be in SETTINGS_PATCH_KEYS or the
    // whole key is silently dropped before it can persist.
    expect(sanitizeSettingsPatch({ appIconVariant: 'monoline' }).appIconVariant).toBe('monoline')
    expect(sanitizeSettingsPatch({ appIconVariant: 'regular' }).appIconVariant).toBe('regular')
    expect(
      'appIconVariant' in sanitizeSettingsPatch({ appIconVariant: 'bogus' as unknown as 'regular' })
    ).toBe(false)
  })

  it('gates a NEW wwdc26 selection by the limited-time window', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-31T12:00:00Z'))
      expect(sanitizeSettingsPatch({ appIconVariant: 'wwdc26' }).appIconVariant).toBe('wwdc26')
      vi.setSystemTime(new Date('2026-09-02T12:00:00Z'))
      expect('appIconVariant' in sanitizeSettingsPatch({ appIconVariant: 'wwdc26' })).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('persists toolIconAccent and userBubbleColor (regression: both were missing from the allowlist)', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    expect(sanitizeSettingsPatch({ toolIconAccent: 'cyan' }).toolIconAccent).toBe('cyan')
    expect(sanitizeSettingsPatch({ userBubbleColor: 'green' }).userBubbleColor).toBe('green')
  })

  it('accepts a boolean modelUsageExternalUsage and drops non-boolean values', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    expect(sanitizeSettingsPatch({ modelUsageExternalUsage: true }).modelUsageExternalUsage).toBe(
      true
    )
    expect(sanitizeSettingsPatch({ modelUsageExternalUsage: false }).modelUsageExternalUsage).toBe(
      false
    )
    // A non-boolean (e.g. a stray string) is stripped so it can't persist.
    expect(
      'modelUsageExternalUsage' in
        sanitizeSettingsPatch({
          modelUsageExternalUsage: 'yes' as unknown as boolean
        })
    ).toBe(false)
  })

  it('preserves the General auto-update checkbox setting', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    expect(sanitizeSettingsPatch({ autoUpdateEnabled: false }).autoUpdateEnabled).toBe(false)
    expect(sanitizeSettingsPatch({ autoUpdateEnabled: true }).autoUpdateEnabled).toBe(true)
    for (const value of [undefined, null, 'false', 0, {}]) {
      expect('autoUpdateEnabled' in sanitizeSettingsPatch({ autoUpdateEnabled: value })).toBe(false)
    }
  })

  it('sanitizes the local-servers lifecycle toggles', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    const sanitized = sanitizeSettingsPatch({
      localServersDetachSpawns: true,
      localServersStopOnQuit: true
    })
    expect(sanitized.localServersDetachSpawns).toBe(true)
    expect(sanitized.localServersStopOnQuit).toBe(true)
    // Non-booleans coerce to real booleans.
    const coerced = sanitizeSettingsPatch({
      localServersDetachSpawns: 1 as unknown as boolean,
      localServersStopOnQuit: 0 as unknown as boolean
    })
    expect(coerced.localServersDetachSpawns).toBe(true)
    expect(coerced.localServersStopOnQuit).toBe(false)
  })

  it('sanitizes user-managed MCP server settings', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)
    const sanitized = sanitizeSettingsPatch({
      userMcpServers: [
        {
          id: 'server-1',
          name: ' filesystem ',
          enabled: true,
          transport: 'stdio',
          command: ' npx ',
          args: [' @modelcontextprotocol/server-filesystem ', '', 5],
          env: {
            PROJECT_ROOT: '/repo',
            'bad-key': 'drop'
          },
          description: ' Local files ',
          pluginProvenance: {
            pluginId: 'demo-bundle',
            publisher: 'acme',
            version: '1.0.0',
            source: 'builtin',
            namespace: 'plugin.acme.demo-bundle',
            manifestHash: 'abc123',
            kind: 'mcpServer',
            objectId: 'filesystem',
            materializedAt: '2026-06-29T12:00:00.000Z'
          }
        },
        {
          id: 'server-1',
          name: 'duplicate'
        },
        {
          id: 'server-2',
          name: ' docs ',
          enabled: true,
          transport: 'http',
          url: ' https://example.test/mcp ',
          headers: {
            Authorization: 'Bearer ${DOCS_TOKEN}',
            'bad header': 'drop'
          },
          bearerTokenEnvVar: ' DOCS_TOKEN '
        },
        {
          id: 'server-3',
          name: ' bad remote ',
          enabled: true,
          transport: 'http',
          url: ' ftp://example.test/mcp '
        },
        {
          id: '',
          name: 'missing id'
        }
      ]
    })

    expect(sanitized.userMcpServers).toEqual([
      {
        id: 'server-1',
        name: 'filesystem',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: ['@modelcontextprotocol/server-filesystem'],
        env: {
          PROJECT_ROOT: '/repo'
        },
        description: 'Local files',
        pluginProvenance: {
          pluginId: 'demo-bundle',
          publisher: 'acme',
          version: '1.0.0',
          source: 'builtin',
          namespace: 'plugin.acme.demo-bundle',
          manifestHash: 'abc123',
          kind: 'mcpServer',
          objectId: 'filesystem',
          materializedAt: '2026-06-29T12:00:00.000Z'
        }
      },
      {
        id: 'server-2',
        name: 'docs',
        enabled: true,
        transport: 'http',
        url: 'https://example.test/mcp',
        headers: {
          Authorization: 'Bearer ${DOCS_TOKEN}'
        },
        bearerTokenEnvVar: 'DOCS_TOKEN'
      },
      {
        id: 'server-3',
        name: 'bad remote',
        enabled: false,
        transport: 'http'
      }
    ])
  })

  it('sanitizes changelog persistence settings', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    const sanitized = sanitizeSettingsPatch({
      lastSeenChangelogVersion: ' 1.0.73 ',
      pendingUpdateChangelog: {
        version: ' 1.0.74 ',
        releaseName: ' TaskWraith 1.0.74 ',
        releaseDate: ' 2026-06-04T13:00:00.000Z ',
        releaseNotes: [
          { version: ' 1.0.74 ', note: 'Updater pill.' },
          { version: '', note: 'ignored' }
        ]
      }
    })

    expect(sanitized).toMatchObject({
      lastSeenChangelogVersion: '1.0.73',
      pendingUpdateChangelog: {
        version: '1.0.74',
        releaseName: 'TaskWraith 1.0.74',
        releaseDate: '2026-06-04T13:00:00.000Z',
        releaseNotes: [{ version: '1.0.74', note: 'Updater pill.' }]
      }
    })
  })

  it('sanitizes Ollama tool-control tiers and gates provider parity on acknowledgement', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    expect(
      sanitizeSettingsPatch({
        ollamaToolControlTier: 'approved_shell'
      })
    ).toMatchObject({
      ollamaToolControlTier: 'approved_shell'
    })

    expect(
      sanitizeSettingsPatch({
        ollamaToolControlTier: 'bad-tier'
      })
    ).not.toHaveProperty('ollamaToolControlTier')

    expect(
      sanitizeSettingsPatch({
        ollamaToolControlTier: 'provider_parity'
      })
    ).not.toHaveProperty('ollamaToolControlTier')

    expect(
      sanitizeSettingsPatch({
        ollamaToolControlTier: 'provider_parity',
        ollamaProviderParityAcknowledgedAt: ' 2026-06-08T12:00:00.000Z ',
        ollamaProviderParityWorkspaceGrants: {
          ' /tmp/project ': ' 2026-06-08T12:01:00.000Z ',
          ' ': 'ignored',
          '/tmp/empty': ''
        }
      })
    ).toMatchObject({
      ollamaToolControlTier: 'provider_parity',
      ollamaProviderParityAcknowledgedAt: '2026-06-08T12:00:00.000Z',
      ollamaProviderParityWorkspaceGrants: {
        '/tmp/project': '2026-06-08T12:01:00.000Z'
      }
    })
  })

  it('allows Ollama provider parity when a previous acknowledgement exists', () => {
    const settings = makeSettings({
      ollamaProviderParityAcknowledgedAt: '2026-06-08T12:00:00.000Z'
    })
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    expect(
      sanitizeSettingsPatch({
        ollamaToolControlTier: 'provider_parity'
      })
    ).toMatchObject({
      ollamaToolControlTier: 'provider_parity',
      ollamaProviderParityAcknowledgedAt: '2026-06-08T12:00:00.000Z'
    })
  })

  it('sanitizes Ollama run profile settings', () => {
    const settings = makeSettings()
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    expect(
      sanitizeSettingsPatch({
        ollamaDefaultRunProfile: 'verify_with_shell',
        ollamaRunProfiles: {
          default: { reasoningLevel: 'high' }
        }
      })
    ).toMatchObject({
      ollamaDefaultRunProfile: 'verify_with_shell',
      ollamaRunProfiles: {
        default: { reasoningLevel: 'high' }
      }
    })

    expect(
      sanitizeSettingsPatch({
        ollamaDefaultRunProfile: 'bad-profile',
        ollamaRunProfiles: 'bad'
      })
    ).toMatchObject({
      ollamaRunProfiles: {}
    })
  })

  it('round-trips advancedFx.refraction and coerces non-boolean values', () => {
    const settings = makeSettings() // refraction defaults true in the fixture
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    // Explicit false survives.
    expect(
      sanitizeSettingsPatch({ advancedFx: { ...settings.advancedFx, refraction: false } }).advancedFx
    ).toMatchObject({ refraction: false })

    // Explicit true survives.
    expect(
      sanitizeSettingsPatch({ advancedFx: { ...settings.advancedFx, refraction: true } }).advancedFx
    ).toMatchObject({ refraction: true })

    // A malformed/non-boolean value is coerced via Boolean() — never persists as garbage.
    expect(
      sanitizeSettingsPatch({
        advancedFx: { ...settings.advancedFx, refraction: 'yes' as unknown as boolean }
      }).advancedFx
    ).toMatchObject({ refraction: true })
    expect(
      sanitizeSettingsPatch({
        advancedFx: { ...settings.advancedFx, refraction: 0 as unknown as boolean }
      }).advancedFx
    ).toMatchObject({ refraction: false })
  })

  it('back-fills advancedFx.refraction from current when the key is absent', () => {
    const settings = makeSettings({
      advancedFx: {
        agentAura: true,
        livingWorkspace: true,
        dataViz: true,
        refraction: false,
        intensity: 'cinematic'
      }
    })
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    // Patch omits refraction; sanitizer must preserve the current value, not reset to default.
    const sanitized = sanitizeSettingsPatch({
      advancedFx: { agentAura: false } as unknown as AppSettings['advancedFx']
    })
    expect(sanitized.advancedFx).toMatchObject({ agentAura: false, refraction: false })
  })
})
