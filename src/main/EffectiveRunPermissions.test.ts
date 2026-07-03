import { describe, expect, it } from 'vitest'
import {
  isPlanInstrumentGrantHold,
  resolveEffectiveRunPermissions
} from './EffectiveRunPermissions'
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
      externalPublish: 'ask',
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
      perProviderMs: {
        gemini: 120000,
        codex: 30000,
        claude: 120000,
        kimi: 60000,
        grok: 120000,
        cursor: 120000,
        ollama: 120000
      },
      mainAuthorityMs: 120000
    },
    ...overrides
  }
}

describe('resolveEffectiveRunPermissions', () => {
  it('keeps read_only and plan both no-write, plan approvalMode, but web-readable', () => {
    for (const presetId of ['read_only', 'plan'] as const) {
      const resolved = resolveEffectiveRunPermissions({
        provider: 'claude',
        workspacePath: '/repo',
        settings: settings(),
        presetId
      })
      expect(resolved.presetId).toBe(presetId)
      expect(resolved.approvalMode).toBe('plan')
      expect(resolved.readOnly).toBe(true)
      // Web-read allowance (2026-07): web_search/web_fetch are non-mutating and
      // permitted under Read-Only/Plan for ALL providers. networkAccess gates only
      // the web_read tool class, never file/shell — the write/shell floor below is
      // untouched. The global-deny kill switch and preview-risk models still force
      // 'deny' ahead of the preset (covered by the deny-path tests below).
      expect(resolved.networkAccess).toBe('allow')
      // Shared floor: neither preset can write, run shell, eval, capture, or
      // cross-thread-read — the split only diverges on the instrument services.
      expect(resolved.agenticServices.fileChanges).toBe('deny')
      expect(resolved.agenticServices.externalPublish).toBe('deny')
      expect(resolved.agenticServices.shellCommands).toBe('deny')
      expect(resolved.agenticServices.mcpTools).toBe('ask')
      expect(resolved.agenticServices.crossThreadRead).toBe('deny')
      expect(resolved.agenticServices.mediaRecording).toBe('deny')
      expect(resolved.agenticServices.canvasEval).toBe('deny')
    }
  })

  it('read_only is the strict floor — no elevation path (subthread/canvas/media denied)', () => {
    const resolved = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'read_only'
    })
    expect(resolved.agenticServices.subThreadDelegation).toBe('deny')
    expect(resolved.agenticServices.canvasInteraction).toBe('deny')
    expect(resolved.agenticServices.mediaEditing).toBe('deny')
  })

  it('plan is the instrument tier — subthread/canvas/media approval-queued (ask), never a write', () => {
    const resolved = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'plan'
    })
    expect(resolved.agenticServices.subThreadDelegation).toBe('ask')
    expect(resolved.agenticServices.canvasInteraction).toBe('ask')
    expect(resolved.agenticServices.mediaEditing).toBe('ask')
    expect(resolved.agenticServices.fileChanges).toBe('deny')
    expect(resolved.agenticServices.externalPublish).toBe('deny')
    expect(resolved.agenticServices.shellCommands).toBe('deny')
    expect(resolved.agenticServices.mediaRecording).toBe('deny')
    expect(resolved.agenticServices.canvasEval).toBe('deny')
  })

  it('read_only and plan differ ONLY on the instrument services (guard against re-merge/drift)', () => {
    const base = { provider: 'claude' as const, workspacePath: '/repo', settings: settings() }
    const readOnly = resolveEffectiveRunPermissions({ ...base, presetId: 'read_only' }).agenticServices
    const plan = resolveEffectiveRunPermissions({ ...base, presetId: 'plan' }).agenticServices
    const INSTRUMENT_SERVICES: readonly string[] = [
      'subThreadDelegation',
      'canvasInteraction',
      'mediaEditing'
    ]
    for (const service of Object.keys(readOnly) as (keyof typeof readOnly)[]) {
      if (INSTRUMENT_SERVICES.includes(service)) {
        // plan RELAXES read_only's deny to an approval prompt on these three.
        expect(readOnly[service]).toBe('deny')
        expect(plan[service]).toBe('ask')
      } else {
        // everything else is byte-identical — plan is a strict superset.
        expect(plan[service]).toBe(readOnly[service])
      }
    }
  })

  it('plan instruments stay per-invocation — a standing workspace grant does NOT auto-allow them', () => {
    const grants = [
      {
        id: 'grant-canvas',
        provider: 'claude' as const,
        workspacePath: '/repo',
        service: 'canvasInteraction' as const,
        createdAt: '2026-05-24T00:00:00.000Z',
        updatedAt: '2026-05-24T00:00:00.000Z'
      },
      {
        id: 'grant-media',
        provider: 'claude' as const,
        workspacePath: '/repo',
        service: 'mediaEditing' as const,
        createdAt: '2026-05-24T00:00:00.000Z',
        updatedAt: '2026-05-24T00:00:00.000Z'
      }
    ]
    // Under plan the standing grant is ignored — instruments remain a prompt
    // (standing per-workspace instrument grants are the conformance-gated W7-b rung).
    const plan = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings({ agenticWorkspaceGrants: grants }),
      presetId: 'plan'
    })
    expect(plan.agenticServices.canvasInteraction).toBe('ask')
    expect(plan.agenticServices.mediaEditing).toBe('ask')

    // The SAME grant auto-allows in-workspace under default — proving the grant
    // is real and the immunity is plan-specific, not a global de-grant.
    const def = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings({ agenticWorkspaceGrants: grants }),
      presetId: 'default'
    })
    expect(def.agenticServices.canvasInteraction).toBe('workspace')
    expect(def.agenticServices.mediaEditing).toBe('workspace')
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
          externalPublish: 'allow',
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
    expect(withAllow.agenticServices.externalPublish).toBe('ask')

    const withDeny = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings({
        agenticServices: {
          shellCommands: 'ask',
          fileChanges: 'ask',
          externalPublish: 'deny',
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
    expect(withDeny.agenticServices.externalPublish).toBe('deny')
  })

  it('treats externalPublish as non-grantable and never auto-allows it under full access', () => {
    const fullAccess = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'full_access'
    })
    expect(fullAccess.agenticServices.fileChanges).toBe('allow')
    expect(fullAccess.agenticServices.externalPublish).toBe('ask')

    const withGrant = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings({
        agenticWorkspaceGrants: [
          {
            id: 'workspace-grant-publish',
            provider: 'codex',
            workspacePath: '/repo',
            service: 'externalPublish',
            createdAt: '2026-05-24T00:00:00.000Z',
            updatedAt: '2026-05-24T00:00:00.000Z'
          }
        ]
      }),
      presetId: 'default'
    })
    expect(withGrant.workspaceGrantServiceIds).not.toContain('externalPublish')
    expect(withGrant.agenticServices.externalPublish).toBe('ask')
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

  it('preserves read-only posture for stale Claude preview placeholders', () => {
    for (const model of ['preview:anthropic:claude-fable-5', 'preview:anthropic:claude-mythos-5']) {
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

  it('does not force the read-only preview posture on returned Claude 5 models', () => {
    for (const model of ['claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5']) {
      const resolved = resolveEffectiveRunPermissions({
        provider: 'claude',
        workspacePath: '/repo',
        model,
        settings: settings(),
        presetId: 'full_access'
      })

      // A preview placeholder would be clamped to plan + readOnly even under
      // full_access; returned concrete ids keep the requested posture.
      expect(resolved.approvalMode).not.toBe('plan')
      expect(resolved.readOnly).toBe(false)
    }
  })
})

describe('isPlanInstrumentGrantHold — gate-level grant immunity for plan instruments', () => {
  it('holds (forces a prompt) for plan + canvas/media instruments', () => {
    expect(isPlanInstrumentGrantHold('plan', 'canvasInteraction')).toBe(true)
    expect(isPlanInstrumentGrantHold('plan', 'mediaEditing')).toBe(true)
  })

  it('does NOT hold for plan + non-instrument services (subthread was already grantable)', () => {
    // subThreadDelegation was ASK + grantable under plan before the split — a
    // grant hold here would be a regression, so it is deliberately excluded.
    expect(isPlanInstrumentGrantHold('plan', 'subThreadDelegation')).toBe(false)
    expect(isPlanInstrumentGrantHold('plan', 'mcpTools')).toBe(false)
    expect(isPlanInstrumentGrantHold('plan', 'fileChanges')).toBe(false)
  })

  it('does NOT hold under other presets — canvas/media stay normally grantable there', () => {
    for (const preset of ['read_only', 'default', 'workspace_write', 'full_access', 'custom']) {
      expect(isPlanInstrumentGrantHold(preset, 'canvasInteraction')).toBe(false)
      expect(isPlanInstrumentGrantHold(preset, 'mediaEditing')).toBe(false)
    }
    expect(isPlanInstrumentGrantHold(undefined, 'canvasInteraction')).toBe(false)
    expect(isPlanInstrumentGrantHold(null, 'mediaEditing')).toBe(false)
  })
})
