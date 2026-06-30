import { describe, expect, it } from 'vitest'
import { resolveEffectiveRunPermissions } from './EffectiveRunPermissions'
import type { AppSettings, ExternalPathGrant } from './store/types'

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    storeLocalChatHistory: true,
    storeRawEvents: true,
    storePromptResponseInUsage: false,
    ensembleModeEnabled: true,
    geminiCheckpointingEnabled: false,
    chatContextTurns: 8,
    currency: 'USD',
    kimiSanitiserEnabled: false,
    kimiSanitiserCustomKeywords: '',
    appearanceMode: 'solid',
    visualEffectStyle: 'classic',
    themeAppearance: 'system',
    themeCornerStyle: 'rounded',
    themeAccentStyle: 'system',
    toolIconAccent: 'system',
    userBubbleColor: 'system',
    appIconVariant: 'regular',
    promptSurfaceStyle: 'theme',
    composerStyle: 'default',
    funFxEnabled: false,
    funFxMode: 'off',
    advancedFx: {
      agentAura: false,
      livingWorkspace: false,
      dataViz: false,
      refraction: false,
      intensity: 'subtle'
    },
    reduceTransparency: false,
    reduceMotion: false,
    compactDensity: false,
    liveActivityViewport: true,
    showInspector: true,
    inspectorWidth: 320,
    sidebarWidth: 300,
    sidebarOpacity: 100,
    mainPaneOpacity: 100,
    agenticServices: {
      shellCommands: 'ask',
      fileChanges: 'ask',
      mcpTools: 'ask',
      subThreadDelegation: 'ask',
      canvasInteraction: 'ask',
      canvasEval: 'ask',
      networkAccess: 'allow'
    },
    agenticWorkspaceGrants: [],
    autoResumeParentOnSubThreadCompletion: true,
    geminiMcpBridgeEnabled: true,
    bridgeDaemonEnabled: false,
    codexSandboxFallback: 'ask_rerun',
    updateChannel: 'stable',
    approvalTimeouts: {
      enabled: true,
      perProviderMs: { gemini: 120000, codex: 30000, claude: 120000, kimi: 60000 },
      mainAuthorityMs: 120000
    },
    ...overrides
  }
}

describe('resolveEffectiveRunPermissions', () => {
  it('turns read-only presets into plan mode with write services denied', () => {
    const resolved = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'read_only'
    })
    expect(resolved.approvalMode).toBe('plan')
    expect(resolved.readOnly).toBe(true)
    expect(resolved.agenticServices.fileChanges).toBe('deny')
    expect(resolved.agenticServices.shellCommands).toBe('deny')
  })

  it('denies canvasInteraction under read_only and allows it under full_access', () => {
    const readOnly = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'read_only'
    })
    expect(readOnly.agenticServices.canvasInteraction).toBe('deny')

    const fullAccess = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'full_access'
    })
    expect(fullAccess.agenticServices.canvasInteraction).toBe('allow')
  })

  it('keeps global deny stronger than participant overrides', () => {
    const resolved = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings({
        agenticServices: {
          shellCommands: 'deny',
          fileChanges: 'ask',
          mcpTools: 'ask',
          subThreadDelegation: 'ask',
          canvasInteraction: 'ask',
          canvasEval: 'ask',
          networkAccess: 'deny'
        }
      }),
      presetId: 'full_access'
    })
    expect(resolved.agenticServices.shellCommands).toBe('deny')
    expect(resolved.networkAccess).toBe('deny')
  })

  it('applies participant-scoped tool grant overrides without requiring workspace grants', () => {
    const resolved = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'default',
      overrides: {
        agenticServices: {
          shellCommands: 'allow',
          fileChanges: 'allow'
        }
      }
    })

    expect(resolved.agenticServices.shellCommands).toBe('allow')
    expect(resolved.agenticServices.fileChanges).toBe('allow')
    expect(resolved.workspaceGrantServiceIds).toEqual([])
  })

  it('lets participant denies override workspace grants', () => {
    const resolved = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings({
        agenticWorkspaceGrants: [
          {
            id: 'workspace-grant-1',
            provider: 'codex',
            workspacePath: '/repo',
            service: 'shellCommands',
            createdAt: '2026-05-24T00:00:00.000Z',
            updatedAt: '2026-05-24T00:00:00.000Z'
          }
        ]
      }),
      presetId: 'default',
      overrides: {
        agenticServices: {
          shellCommands: 'deny'
        }
      }
    })

    expect(resolved.workspaceGrantServiceIds).toEqual(['shellCommands'])
    expect(resolved.agenticServices.shellCommands).toBe('deny')
  })

  it('denies canvasEval under read-only and never auto-allows it under full access', () => {
    const readOnly = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'read_only'
    })
    // Arbitrary eval (RCE) is denied outright under read-only.
    expect(readOnly.agenticServices.canvasEval).toBe('deny')

    const fullAccess = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'full_access'
    })
    // Full access lifts every OTHER service to allow, but canvasEval must stay at
    // the 'ask' default — eval is signed-elevated and never auto-allowed.
    expect(fullAccess.agenticServices.canvasInteraction).toBe('allow')
    expect(fullAccess.agenticServices.canvasEval).toBe('ask')
  })

  it('treats canvasEval as non-grantable — a workspace grant cannot promote it', () => {
    const resolved = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings({
        agenticWorkspaceGrants: [
          {
            id: 'workspace-grant-eval',
            provider: 'codex',
            workspacePath: '/repo',
            service: 'canvasEval',
            createdAt: '2026-05-24T00:00:00.000Z',
            updatedAt: '2026-05-24T00:00:00.000Z'
          }
        ]
      }),
      presetId: 'default'
    })

    // The (stale/forged) workspace grant is dropped: canvasEval is not promoted to
    // 'workspace', and it is absent from the resolved workspace-grant service ids.
    expect(resolved.workspaceGrantServiceIds).not.toContain('canvasEval')
    expect(resolved.agenticServices.canvasEval).toBe('ask')
  })

  it('clamps a stored canvasEval allow/workspace policy down to ask, but honors deny', () => {
    const withAllow = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings({
        agenticServices: {
          shellCommands: 'ask',
          fileChanges: 'ask',
          mcpTools: 'ask',
          subThreadDelegation: 'ask',
          canvasInteraction: 'ask',
          canvasEval: 'allow',
          networkAccess: 'allow'
        }
      }),
      presetId: 'default'
    })
    // A settings/import value of 'allow' must not produce an auto-allow policy.
    expect(withAllow.agenticServices.canvasEval).toBe('ask')

    const withDeny = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings({
        agenticServices: {
          shellCommands: 'ask',
          fileChanges: 'ask',
          mcpTools: 'ask',
          subThreadDelegation: 'ask',
          canvasInteraction: 'ask',
          canvasEval: 'deny',
          networkAccess: 'allow'
        }
      }),
      presetId: 'default'
    })
    // An explicit deny is still honored.
    expect(withDeny.agenticServices.canvasEval).toBe('deny')
  })

  it('merges workspace grants and provider-scoped external path grants', () => {
    const grant: ExternalPathGrant = {
      id: 'grant-1',
      provider: 'codex',
      path: '/outside',
      kind: 'directory',
      access: 'write',
      duration: 'thisThread',
      createdAt: new Date().toISOString()
    }
    const resolved = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings({
        agenticWorkspaceGrants: [
          {
            id: 'workspace-grant-1',
            provider: 'codex',
            workspacePath: '/repo',
            service: 'fileChanges',
            createdAt: '2026-05-24T00:00:00.000Z',
            updatedAt: '2026-05-24T00:00:00.000Z'
          }
        ]
      }),
      presetId: 'default',
      explicitExternalPathGrants: [
        grant,
        { ...grant, id: 'grant-2', provider: 'claude', path: '/claude-only' }
      ]
    })
    expect(resolved.workspaceGrantServiceIds).toEqual(['fileChanges'])
    expect(resolved.agenticServices.fileChanges).toBe('workspace')
    expect(resolved.externalPathGrants).toEqual([grant])
  })

  it('clamps preview-risk Codex models to explicit approvals and denies network access', () => {
    const resolved = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      model: 'gpt-5.6-sol',
      settings: settings({
        agenticServices: {
          shellCommands: 'ask',
          fileChanges: 'ask',
          mcpTools: 'ask',
          subThreadDelegation: 'ask',
          canvasInteraction: 'ask',
          canvasEval: 'ask',
          mediaEditing: 'ask',
          mediaRecording: 'deny',
          networkAccess: 'allow'
        },
        agenticWorkspaceGrants: [
          {
            id: 'workspace-grant-shell',
            provider: 'codex',
            workspacePath: '/repo',
            service: 'shellCommands',
            createdAt: '2026-06-29T00:00:00.000Z',
            updatedAt: '2026-06-29T00:00:00.000Z'
          }
        ]
      }),
      presetId: 'full_access'
    })

    expect(resolved.approvalMode).toBe('default')
    expect(resolved.networkAccess).toBe('deny')
    expect(resolved.workspaceGrantServiceIds).toEqual([])
    expect(resolved.agenticServices.shellCommands).toBe('ask')
    expect(resolved.agenticServices.fileChanges).toBe('ask')
    expect(resolved.agenticServices.mcpTools).toBe('ask')
    expect(resolved.agenticServices.subThreadDelegation).toBe('ask')
    expect(resolved.agenticServices.canvasInteraction).toBe('ask')
    expect(resolved.agenticServices.mediaEditing).toBe('ask')
  })

  it('preserves read-only posture for preview-risk models', () => {
    for (const model of ['claude-sonnet-5', 'claude-mythos-5']) {
      const resolved = resolveEffectiveRunPermissions({
        provider: 'claude',
        workspacePath: '/repo',
        model,
        settings: settings(),
        presetId: 'read_only'
      })

      expect(resolved.approvalMode).toBe('plan')
      expect(resolved.readOnly).toBe(true)
      expect(resolved.agenticServices.shellCommands).toBe('deny')
      expect(resolved.agenticServices.fileChanges).toBe('deny')
      expect(resolved.networkAccess).toBe('deny')
    }
  })
})
