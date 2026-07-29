import { describe, expect, it, vi } from 'vitest'
import {
  SettingsService,
  type SettingsServiceDeps,
  type SettingsUpdateContext
} from './SettingsService'
import type { AppSettings } from '../store/types'

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    activeProvider: 'gemini',
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
    themeAccentStyle: 'default',
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
      shellCommands: 'ask',
      fileChanges: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      networkAccess: 'ask'
    },
    agenticWorkspaceGrants: [],
    geminiMcpBridgeEnabled: false,
    codexSandboxFallback: 'ask',
    updateChannel: 'debug',
    approvalTimeouts: {
      enabled: true,
      perProviderMs: {
        gemini: 120_000,
        codex: 30_000,
        claude: 120_000,
        kimi: 60_000,
        grok: 120_000,
        cursor: 120_000,
        ollama: 120_000
      },
      mainAuthorityMs: 120_000
    },
    ...overrides
  } as AppSettings
}

function makeDeps(overrides: Partial<SettingsServiceDeps> = {}): {
  deps: SettingsServiceDeps
  readonly settings: AppSettings
} {
  let settings = makeSettings()
  const deps: SettingsServiceDeps = {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((partial: Partial<AppSettings>) => {
      settings = { ...settings, ...partial }
    }),
    sanitizeSettingsPatch: vi.fn((partial: unknown) => partial as Partial<AppSettings>),
    ...overrides
  }
  return {
    deps,
    get settings() {
      return settings
    }
  }
}

describe('SettingsService', () => {
  it('returns settings from the injected store', () => {
    const { deps, settings } = makeDeps()
    const service = new SettingsService(deps)
    expect(service.getSettings()).toBe(settings)
    expect(deps.getSettings).toHaveBeenCalledTimes(1)
    // Pin the refractive-glass default so a dropped field is caught here.
    expect(service.getSettings().advancedFx.refraction).toBe(true)
  })

  it('sanitizes before persisting a settings patch', () => {
    const sanitized = { updateChannel: 'stable' as const }
    const { deps } = makeDeps({
      sanitizeSettingsPatch: vi.fn(() => sanitized)
    })
    const service = new SettingsService(deps)
    service.updateSettings({ updateChannel: 'stable', ignored: true })
    expect(deps.sanitizeSettingsPatch).toHaveBeenCalledWith({
      updateChannel: 'stable',
      ignored: true
    })
    expect(deps.updateSettings).toHaveBeenCalledWith(sanitized)
  })

  it('runs side effects after persistence with previous and next settings', () => {
    const sideEffect = vi.fn((context: SettingsUpdateContext) => context)
    const { deps } = makeDeps({
      sideEffects: [sideEffect]
    })
    const service = new SettingsService(deps)
    service.updateSettings({ chatContextTurns: 2 })
    expect(sideEffect).toHaveBeenCalledTimes(1)
    const context = sideEffect.mock.calls[0][0] as SettingsUpdateContext
    expect(context.previousSettings.chatContextTurns).toBe(6)
    expect(context.sanitizedPatch.chatContextTurns).toBe(2)
    expect(context.nextSettings.chatContextTurns).toBe(2)
  })

  it('supports multiple side effects in insertion order', () => {
    const calls: string[] = []
    const { deps } = makeDeps({
      sideEffects: [() => calls.push('first'), () => calls.push('second')]
    })
    const service = new SettingsService(deps)
    service.updateSettings({ compactDensity: true })
    expect(calls).toEqual(['first', 'second'])
  })

  it('lets side-effect failures propagate like the original inline handler', () => {
    const { deps } = makeDeps({
      sideEffects: [
        () => {
          throw new Error('side effect failed')
        }
      ]
    })
    const service = new SettingsService(deps)
    expect(() => service.updateSettings({ updateChannel: 'nightly' })).toThrow('side effect failed')
    expect(deps.updateSettings).toHaveBeenCalledTimes(1)
  })

  it('can gate UpdateService reconfiguration on updateChannel and auto-update patches', () => {
    const configure = vi.fn()
    const { deps } = makeDeps({
      sideEffects: [
        ({ sanitizedPatch, nextSettings }) => {
          if (
            sanitizedPatch.updateChannel !== undefined ||
            sanitizedPatch.autoUpdateEnabled !== undefined
          ) {
            configure({
              channel: nextSettings.updateChannel,
              enabled: nextSettings.autoUpdateEnabled !== false
            })
          }
        }
      ]
    })
    const service = new SettingsService(deps)
    service.updateSettings({ compactDensity: true })
    expect(configure).not.toHaveBeenCalled()
    service.updateSettings({ updateChannel: 'stable' })
    expect(configure).toHaveBeenCalledWith({
      channel: 'stable',
      enabled: true
    })
    service.updateSettings({ autoUpdateEnabled: false })
    expect(configure).toHaveBeenLastCalledWith({
      channel: 'stable',
      enabled: false
    })
  })

  it('enforces managed policy before persisting settings updates', () => {
    const { deps } = makeDeps({
      managedPolicy: {
        effectiveSettings: (current) => ({
          ...current,
          updateChannel: 'stable',
          agenticServices: { ...current.agenticServices, shellCommands: 'deny' }
        }),
        filterSettingsPatch: (patch) => {
          const filtered = { ...patch }
          delete filtered.updateChannel
          delete filtered.agenticServices
          return filtered
        },
        enforcedSettingsPatch: (current) => ({
          ...(current.updateChannel !== 'stable' ? { updateChannel: 'stable' as const } : {}),
          agenticServices: { ...current.agenticServices, shellCommands: 'deny' as const }
        })
      }
    })
    const service = new SettingsService(deps)

    service.updateSettings({
      updateChannel: 'nightly',
      agenticServices: { ...makeSettings().agenticServices, shellCommands: 'allow' },
      chatContextTurns: 3
    })

    expect(deps.updateSettings).toHaveBeenCalledWith({
      chatContextTurns: 3,
      updateChannel: 'stable',
      agenticServices: expect.objectContaining({ shellCommands: 'deny' })
    })
  })

  it('persists agenticWorkspaceGrants when the real settings sanitizer is wired', async () => {
    // PermissionService.upsertWorkspaceGrant routes through SettingsService.
    // If the real sanitizer drops agenticWorkspaceGrants, tool grants never stick.
    const { createMainSanitizers } = await import('../settings/MainSanitizers')
    let settings = makeSettings()
    const { sanitizeSettingsPatch } = createMainSanitizers({
      getSettings: () => settings,
      getScheduledTasks: () => [],
      getWorkflowDefinitions: () => [],
      getChat: () => null,
      findRegisteredWorkspace: () => undefined,
      requireRegisteredWorkspace: (path: string) => path,
      canonicalPath: (value: string) => value,
      normalizeExternalPathGrants: (grants) => grants,
      stageScheduledAttachments: () => []
    } as never)
    const storeUpdate = vi.fn((partial: Partial<AppSettings>) => {
      settings = { ...settings, ...partial }
    })
    const service = new SettingsService({
      getSettings: () => settings,
      updateSettings: storeUpdate,
      sanitizeSettingsPatch
    })

    const grant = {
      id: 'grant-1',
      workspacePath: '/repo',
      provider: 'codex' as const,
      service: 'shellCommands' as const,
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      expiresOn: 'workspace_revocation' as const
    }
    service.updateSettings({ agenticWorkspaceGrants: [grant] })

    const sanitizedGrant = { ...grant, provider: 'agents' as const }
    expect(storeUpdate).toHaveBeenCalledWith({ agenticWorkspaceGrants: [sanitizedGrant] })
    expect(settings.agenticWorkspaceGrants).toEqual([sanitizedGrant])
  })
})
