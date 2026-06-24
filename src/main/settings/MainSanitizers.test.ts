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
  return createMainSanitizers({
    getSettings: () => settings,
    getScheduledTasks: () => [],
    getWorkflowDefinitions: () => [],
    findRegisteredWorkspace: () => undefined as WorkspaceRecord | undefined,
    requireRegisteredWorkspace: (workspacePath: string) => workspacePath,
    canonicalPath: (value: string) => value,
    normalizeExternalPathGrants: (grants: ExternalPathGrant[]) => grants
  })
}

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

  it('requires explicit booleans for iMessage scheduled polling', () => {
    const settings = makeSettings({
      messageBridgeEnabled: false,
      messageBridgePollIntervalMs: 30_000
    })
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    expect(
      sanitizeSettingsPatch({
        messageBridgeEnabled: true,
        messageBridgePollIntervalMs: 250
      })
    ).toMatchObject({
      messageBridgeEnabled: true,
      messageBridgePollIntervalMs: 5_000
    })
    expect(
      sanitizeSettingsPatch({
        messageBridgeEnabled: 'false'
      })
    ).toMatchObject({
      messageBridgeEnabled: false
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

  it('preserves current iMessage polling state for malformed enablement patches', () => {
    const settings = makeSettings({
      messageBridgeEnabled: true,
      messageBridgePollIntervalMs: 30_000
    })
    const { sanitizeSettingsPatch } = makeSanitizers(settings)

    expect(
      sanitizeSettingsPatch({
        messageBridgeEnabled: ''
      })
    ).toMatchObject({
      messageBridgeEnabled: true
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
