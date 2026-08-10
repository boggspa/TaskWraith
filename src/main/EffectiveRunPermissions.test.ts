import { describe, expect, it } from 'vitest'
import {
  LINEAR_PERMISSION_SERVICES,
  isFullShellAccessGranted,
  isPlanInstrumentGrantHold,
  isPostureApprovalOnlyService,
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
        ollama: 120000,
        antigravity: 120000,
        pi: 120000,
        mistral: 120000,
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
      // Web-read allowance (2026-07): web_search/web_fetch/github_ci_status are non-mutating and
      // permitted under Ask/Plan for ALL providers. networkAccess gates only
      // the web_read tool class, never file/shell — the write/shell floor below is
      // untouched. The global-deny kill switch and preview-risk models still force
      // 'deny' ahead of the preset (covered by the deny-path tests below).
      expect(resolved.networkAccess).toBe('allow')
      // Both presets stay readOnly:true / approvalMode 'plan' (native lanes
      // plan-contained) and keep capture denied. Brokered standard services
      // remain reachable through the attended approval modal.
      expect(resolved.agenticServices.mediaRecording).toBe('deny')
    }
  })

  it('read_only ("Ask") asks for everything not auto-allowed — no auto-deny except capture', () => {
    const resolved = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'read_only'
    })
    expect(resolved.agenticServices.fileChanges).toBe('ask')
    expect(resolved.agenticServices.shellCommands).toBe('ask')
    expect(resolved.agenticServices.subThreadDelegation).toBe('ask')
    expect(resolved.agenticServices.simulatorCanvas).toBe('ask')
    expect(resolved.agenticServices.canvasInteraction).toBe('ask')
    expect(resolved.agenticServices.meshCanvas).toBe('ask')
    expect(resolved.agenticServices.mediaEditing).toBe('ask')
    expect(resolved.agenticServices.crossThreadRead).toBe('ask')
    expect(resolved.agenticServices.threadMessage).toBe('ask')
    expect(resolved.agenticServices.externalPublish).toBe('ask')
    expect(resolved.agenticServices.mcpTools).toBe('ask')
    // canvasEval remains non-grantable, so this ASK can never become automatic.
    expect(resolved.agenticServices.canvasEval).toBe('ask')
    // The one deliberate auto-deny: there is no attended capture flow to approve.
    expect(resolved.agenticServices.mediaRecording).toBe('deny')
  })

  it('uses one linear policy for every standard service', () => {
    for (const service of LINEAR_PERMISSION_SERVICES) {
      const policyFor = (
        presetId: Parameters<typeof resolveEffectiveRunPermissions>[0]['presetId']
      ) =>
        resolveEffectiveRunPermissions({
          provider: 'claude',
          workspacePath: '/repo',
          settings: settings(),
          presetId
        }).agenticServices[service]

      expect(policyFor('read_only'), `${service} under Ask`).toBe('ask')
      expect(policyFor('plan'), `${service} under Plan`).toBe('ask')
      expect(policyFor('default'), `${service} under Accept Edits`).toBe('allow')
      expect(policyFor('workspace_write'), `${service} under Full WS Access`).toBe('allow')
      expect(policyFor('full_access'), `${service} under Full Access`).toBe('allow')

      for (const presetId of ['default', 'workspace_write', 'full_access'] as const) {
        const globallyDenied = resolveEffectiveRunPermissions({
          provider: 'claude',
          workspacePath: '/repo',
          settings: settings({
            agenticServices: {
              ...settings().agenticServices,
              [service]: 'deny'
            }
          }),
          presetId
        })
        expect(globallyDenied.agenticServices[service], `${service} global deny`).toBe('deny')
      }
    }
  })

  it('pins the Sketch Canvas mutation ladder across every permission preset', () => {
    const policyFor = (presetId: Parameters<typeof resolveEffectiveRunPermissions>[0]['presetId']) =>
      resolveEffectiveRunPermissions({
        provider: 'claude',
        workspacePath: '/repo',
        settings: settings(),
        presetId
      }).agenticServices.sketchCanvas

    expect(policyFor('read_only')).toBe('ask')
    expect(policyFor('plan')).toBe('ask')
    // Persisted pre-Sketch settings omit the optional key; Accept Edits
    // still adopts the intentional prompt-free fallback.
    expect(policyFor('default')).toBe('allow')
    expect(policyFor('workspace_write')).toBe('allow')
    expect(policyFor('full_access')).toBe('allow')

    const globallyDenied = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings({
        agenticServices: {
          ...settings().agenticServices,
          sketchCanvas: 'deny'
        }
      }),
      presetId: 'full_access'
    })
    expect(globallyDenied.agenticServices.sketchCanvas).toBe('deny')
  })

  it('pins external publishing to the standard permission ladder', () => {
    const policyFor = (presetId: Parameters<typeof resolveEffectiveRunPermissions>[0]['presetId']) =>
      resolveEffectiveRunPermissions({
        provider: 'claude',
        workspacePath: '/repo',
        settings: settings(),
        presetId
      }).agenticServices.externalPublish

    expect(policyFor('read_only')).toBe('ask')
    expect(policyFor('plan')).toBe('ask')
    expect(policyFor('default')).toBe('allow')
    expect(policyFor('workspace_write')).toBe('allow')
    expect(policyFor('full_access')).toBe('allow')

    // read_only/plan additionally carry the posture hold so grants/session-YOLO
    // can never zero-click a publish there; default/write tiers do not.
    expect(isPostureApprovalOnlyService('read_only', 'externalPublish')).toBe(true)
    expect(isPostureApprovalOnlyService('plan', 'externalPublish')).toBe(true)
    expect(isPostureApprovalOnlyService('default', 'externalPublish')).toBe(false)
    expect(isPostureApprovalOnlyService('workspace_write', 'externalPublish')).toBe(false)
    expect(isPostureApprovalOnlyService('full_access', 'externalPublish')).toBe(false)

    const globallyDenied = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings({
        agenticServices: {
          ...settings().agenticServices,
          externalPublish: 'deny'
        }
      }),
      presetId: 'full_access'
    })
    expect(globallyDenied.agenticServices.externalPublish).toBe('deny')
  })

  it('pins the file-changes ladder: Accept Edits auto-accepts in-workspace edits', () => {
    const policyFor = (presetId: Parameters<typeof resolveEffectiveRunPermissions>[0]['presetId']) =>
      resolveEffectiveRunPermissions({
        provider: 'claude',
        workspacePath: '/repo',
        settings: settings(),
        presetId
      }).agenticServices.fileChanges

    expect(policyFor('read_only')).toBe('ask')
    expect(policyFor('plan')).toBe('ask')
    // Accept Edits' defining behavior (user decision 2026-08-04): selecting the
    // preset IS the authorization for in-workspace file edits — no per-edit
    // prompt. Outside-workspace writes still force the external-path prompt at
    // the executors, and the global kill switch below still wins.
    expect(policyFor('default')).toBe('allow')
    expect(policyFor('workspace_write')).toBe('allow')
    expect(policyFor('full_access')).toBe('allow')

    const globallyDenied = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings({
        agenticServices: {
          ...settings().agenticServices,
          fileChanges: 'deny'
        }
      }),
      presetId: 'default'
    })
    expect(globallyDenied.agenticServices.fileChanges).toBe('deny')
  })

  it('pins the Browser navigation (webBrowsing) ladder across every permission preset', () => {
    const policyFor = (presetId: Parameters<typeof resolveEffectiveRunPermissions>[0]['presetId']) =>
      resolveEffectiveRunPermissions({
        provider: 'claude',
        workspacePath: '/repo',
        settings: settings(),
        presetId
      }).agenticServices.webBrowsing

    // Ask and Plan both keep browsing attended through the approval modal.
    expect(policyFor('read_only')).toBe('ask')
    expect(policyFor('plan')).toBe('ask')
    // Accept Edits is the explicit run-level authorization for ordinary
    // browser navigation; no second per-navigation approval is required.
    expect(policyFor('default')).toBe('allow')
    expect(policyFor('workspace_write')).toBe('allow')
    expect(policyFor('full_access')).toBe('allow')

    // The global kill switch still forces deny in every preset.
    const globallyDenied = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings({
        agenticServices: {
          ...settings().agenticServices,
          webBrowsing: 'deny'
        }
      }),
      presetId: 'full_access'
    })
    expect(globallyDenied.agenticServices.webBrowsing).toBe('deny')
  })

  it('webBrowsing stays per-invocation under Ask and Plan, and is allowed by Accept Edits', () => {
    const grants = [
      {
        id: 'grant-browse',
        provider: 'claude' as const,
        workspacePath: '/repo',
        service: 'webBrowsing' as const,
        createdAt: '2026-08-04T00:00:00.000Z',
        updatedAt: '2026-08-04T00:00:00.000Z'
      }
    ]
    const held = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings({ agenticWorkspaceGrants: grants }),
      presetId: 'read_only'
    })
    expect(held.agenticServices.webBrowsing).toBe('ask')
    // A standing grant cannot skip Plan's per-invocation modal.
    const planHeld = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings({ agenticWorkspaceGrants: grants }),
      presetId: 'plan'
    })
    expect(planHeld.agenticServices.webBrowsing).toBe('ask')
    // Accept Edits itself is stronger than the stored grant: it authorizes
    // ordinary browsing for this run without manufacturing a workspace tier.
    const def = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings({ agenticWorkspaceGrants: grants }),
      presetId: 'default'
    })
    expect(def.agenticServices.webBrowsing).toBe('allow')
  })

  it('canvas_render_chart service (mcpTools) is ask under Ask/Plan, not deny', () => {
    // Seat 2: dock charts reuse mcpTools (no new canvasChart service). Ask and
    // Plan must modal-ask — never hard-deny — and Accept Edits+ allow.
    const base = { provider: 'claude' as const, workspacePath: '/repo', settings: settings() }
    expect(
      resolveEffectiveRunPermissions({ ...base, presetId: 'read_only' }).agenticServices.mcpTools
    ).toBe('ask')
    expect(
      resolveEffectiveRunPermissions({ ...base, presetId: 'plan' }).agenticServices.mcpTools
    ).toBe('ask')
    expect(
      resolveEffectiveRunPermissions({ ...base, presetId: 'default' }).agenticServices.mcpTools
    ).toBe('allow')
    expect(
      resolveEffectiveRunPermissions({ ...base, presetId: 'workspace_write' }).agenticServices
        .mcpTools
    ).toBe('allow')
    expect(
      resolveEffectiveRunPermissions({ ...base, presetId: 'full_access' }).agenticServices.mcpTools
    ).toBe('allow')
  })

  it('aligns Plan and Ask on standard services without changing specialist permissions', () => {
    const base = { provider: 'claude' as const, workspacePath: '/repo', settings: settings() }
    const readOnly = resolveEffectiveRunPermissions({
      ...base,
      presetId: 'read_only'
    }).agenticServices
    const plan = resolveEffectiveRunPermissions({ ...base, presetId: 'plan' }).agenticServices

    for (const service of LINEAR_PERMISSION_SERVICES) {
      expect(readOnly[service]).toBe('ask')
      expect(plan[service]).toBe('ask')
    }

    expect(readOnly.crossThreadRead).toBe('ask')
    expect(readOnly.threadMessage).toBe('ask')
    expect(readOnly.canvasEval).toBe('ask')
    expect(plan.crossThreadRead).toBe('deny')
    expect(plan.threadMessage).toBe('deny')
    expect(plan.canvasEval).toBe('deny')
    expect(readOnly.mediaRecording).toBe('deny')
    expect(plan.mediaRecording).toBe('deny')
  })

  it('pins the sub-thread delegation ladder across every permission preset', () => {
    const policyFor = (presetId: Parameters<typeof resolveEffectiveRunPermissions>[0]['presetId']) =>
      resolveEffectiveRunPermissions({
        provider: 'claude',
        workspacePath: '/repo',
        settings: settings(),
        presetId
      }).agenticServices.subThreadDelegation

    expect(policyFor('read_only')).toBe('ask')
    expect(policyFor('plan')).toBe('ask')
    expect(policyFor('default')).toBe('allow')
    expect(policyFor('workspace_write')).toBe('allow')
    expect(policyFor('full_access')).toBe('allow')
  })

  it('pins the Simulator Canvas ladder across every permission preset (mirrors subThreadDelegation)', () => {
    const policyFor = (presetId: Parameters<typeof resolveEffectiveRunPermissions>[0]['presetId']) =>
      resolveEffectiveRunPermissions({
        provider: 'claude',
        workspacePath: '/repo',
        settings: settings(),
        presetId
      }).agenticServices.simulatorCanvas

    expect(policyFor('read_only')).toBe('ask')
    expect(policyFor('plan')).toBe('ask')
    expect(policyFor('default')).toBe('allow')
    expect(policyFor('workspace_write')).toBe('allow')
    expect(policyFor('full_access')).toBe('allow')
  })

  it('keeps Plan modal-only even when standing workspace grants exist', () => {
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
      },
      {
        id: 'grant-sketch',
        provider: 'claude' as const,
        workspacePath: '/repo',
        service: 'sketchCanvas' as const,
        createdAt: '2026-05-24T00:00:00.000Z',
        updatedAt: '2026-05-24T00:00:00.000Z'
      },
      {
        id: 'grant-mesh',
        provider: 'claude' as const,
        workspacePath: '/repo',
        service: 'meshCanvas' as const,
        createdAt: '2026-05-24T00:00:00.000Z',
        updatedAt: '2026-05-24T00:00:00.000Z'
      },
      {
        // canvasEval is non-grantable — this grant must be inert in EVERY
        // preset: it cannot lift plan's deny, and stays ask under default.
        id: 'grant-eval',
        provider: 'claude' as const,
        workspacePath: '/repo',
        service: 'canvasEval' as const,
        createdAt: '2026-05-24T00:00:00.000Z',
        updatedAt: '2026-05-24T00:00:00.000Z'
      }
    ]
    // Under Plan the standing grants are ignored for admission: every standard
    // service remains a per-invocation modal.
    const plan = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings({ agenticWorkspaceGrants: grants }),
      presetId: 'plan'
    })
    expect(plan.agenticServices.canvasInteraction).toBe('ask')
    expect(plan.agenticServices.sketchCanvas).toBe('ask')
    expect(plan.agenticServices.meshCanvas).toBe('ask')
    expect(plan.agenticServices.mediaEditing).toBe('ask')
    expect(plan.agenticServices.canvasEval).toBe('deny')

    // The SAME grant auto-allows in-workspace under default — proving the grant
    // is real and the plan immunity is plan-specific, not a global de-grant.
    // mediaEditing carries that control on its own now.
    const def = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings({ agenticWorkspaceGrants: grants }),
      presetId: 'default'
    })
    expect(def.agenticServices.mediaEditing).toBe('allow')
    expect(def.agenticServices.meshCanvas).toBe('allow')
    expect(def.agenticServices.sketchCanvas).toBe('allow')
    // canvasEval does NOT promote under any preset — it is non-grantable.
    expect(def.agenticServices.canvasEval).toBe('ask')
    // Accept Edits is now the explicit run-level authorization for ordinary
    // click/fill control. The stale workspace grant remains inert (Canvas
    // grants still bind to one surface), but no grant is needed for this run.
    expect(def.agenticServices.canvasInteraction).toBe('allow')
  })

  it('asks Canvas control and Sketch edits under read_only (Ask) and allows both under full_access', () => {
    const readOnly = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'read_only'
    })
    expect(readOnly.agenticServices.canvasInteraction).toBe('ask')
    expect(readOnly.agenticServices.sketchCanvas).toBe('ask')
    expect(readOnly.agenticServices.meshCanvas).toBe('ask')

    const fullAccess = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'full_access'
    })
    expect(fullAccess.agenticServices.canvasInteraction).toBe('allow')
    expect(fullAccess.agenticServices.sketchCanvas).toBe('allow')
    expect(fullAccess.agenticServices.meshCanvas).toBe('allow')
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

  it('matches workspace grants when run path and stored path differ only by trailing slash', () => {
    const resolved = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo/',
      settings: settings({
        agenticWorkspaceGrants: [
          {
            id: 'workspace-grant-slash',
            provider: 'codex',
            workspacePath: '/repo',
            service: 'shellCommands',
            createdAt: '2026-05-24T00:00:00.000Z',
            updatedAt: '2026-05-24T00:00:00.000Z'
          }
        ]
      }),
      presetId: 'default'
    })

    expect(resolved.workspaceGrantServiceIds).toEqual(['shellCommands'])
    expect(resolved.agenticServices.shellCommands).toBe('allow')
  })

  it("resolves 'agents' workspace grants for every provider; legacy rows stay provider-scoped", () => {
    // Lockstep with PermissionService.hasWorkspaceGrant: if the resolver
    // misses the wildcard, unattended lanes resolve 'ask' and auto-deny on
    // timeout while the approval gate would have allowed.
    for (const provider of ['codex', 'claude', 'grok'] as const) {
      const resolved = resolveEffectiveRunPermissions({
        provider,
        workspacePath: '/repo',
        settings: settings({
          agenticWorkspaceGrants: [
            {
              id: 'workspace-grant-agents',
              provider: 'agents',
              workspacePath: '/repo',
              service: 'shellCommands',
              createdAt: '2026-07-28T00:00:00.000Z',
              updatedAt: '2026-07-28T00:00:00.000Z'
            }
          ]
        }),
        presetId: 'default'
      })
      expect(resolved.workspaceGrantServiceIds).toEqual(['shellCommands'])
      expect(resolved.agenticServices.shellCommands).toBe('allow')
    }

    const legacy = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings({
        agenticWorkspaceGrants: [
          {
            id: 'workspace-grant-legacy',
            provider: 'codex',
            workspacePath: '/repo',
            service: 'shellCommands',
            createdAt: '2026-07-28T00:00:00.000Z',
            updatedAt: '2026-07-28T00:00:00.000Z'
          }
        ]
      }),
      presetId: 'default'
    })
    expect(legacy.workspaceGrantServiceIds).toEqual([])
    expect(legacy.agenticServices.shellCommands).toBe('allow')
  })

  it("an 'agents' grant cannot resurrect the canvasInteraction workspace tier", () => {
    const resolved = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings({
        agenticWorkspaceGrants: [
          {
            id: 'workspace-grant-agents-canvas',
            provider: 'agents',
            workspacePath: '/repo',
            service: 'canvasInteraction',
            createdAt: '2026-07-28T00:00:00.000Z',
            updatedAt: '2026-07-28T00:00:00.000Z'
          }
        ]
      }),
      presetId: 'default'
    })
    expect(resolved.workspaceGrantServiceIds).toEqual([])
  })

  it('does not sign malformed or expired workspace grants into the run posture', () => {
    for (const expiresAt of ['not-a-date', '2000-01-01T00:00:00.000Z']) {
      const resolved = resolveEffectiveRunPermissions({
        provider: 'codex',
        workspacePath: '/repo',
        settings: settings({
          agenticWorkspaceGrants: [
            {
              id: `workspace-grant-${expiresAt}`,
              provider: 'codex',
              workspacePath: '/repo',
              service: 'shellCommands',
              createdAt: '2026-05-24T00:00:00.000Z',
              updatedAt: '2026-05-24T00:00:00.000Z',
              expiresAt
            }
          ]
        }),
        presetId: 'default'
      })

      expect(resolved.workspaceGrantServiceIds).toEqual([])
      expect(resolved.agenticServices.shellCommands).toBe('allow')
    }
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

  it('asks canvasEval under read-only (Ask) and never auto-allows it under full access', () => {
    const readOnly = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'read_only'
    })
    // Arbitrary eval (RCE) prompts per-invocation under Ask; non-grantable,
    // so the ask can never become automatic.
    expect(readOnly.agenticServices.canvasEval).toBe('ask')

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
    // A settings/import value of 'allow' must not produce an auto-allow eval policy.
    expect(withAllow.agenticServices.canvasEval).toBe('ask')
    expect(withAllow.agenticServices.externalPublish).toBe('allow')

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

  it('applies externalPublish according to run posture', () => {
    const readOnly = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'read_only'
    })
    const plan = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'plan'
    })
    const workspaceWrite = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'workspace_write'
    })
    const fullAccess = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'full_access'
    })

    expect(readOnly.agenticServices.externalPublish).toBe('ask')
    expect(plan.agenticServices.externalPublish).toBe('ask')
    expect(workspaceWrite.agenticServices.externalPublish).toBe('allow')
    expect(fullAccess.agenticServices.fileChanges).toBe('allow')
    expect(fullAccess.agenticServices.externalPublish).toBe('allow')

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
    expect(withGrant.workspaceGrantServiceIds).toContain('externalPublish')
    expect(withGrant.agenticServices.externalPublish).toBe('allow')
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
    // Accept Edits now auto-allows in-workspace edits at the preset layer, so
    // the standing workspace grant is redundant for the POLICY value ('allow'
    // is strictly more permissive than grant-scoped 'workspace') while the
    // grant itself stays recorded above for audit and Settings revocation.
    expect(resolved.agenticServices.fileChanges).toBe('allow')
    expect(resolved.externalPathGrants).toEqual([grant])
  })

  // GA GPT-5.6 (concrete slugs) is no longer preview-risk — full GPT-5.5 parity,
  // no clamp. The preview-risk CLAMP machinery is exercised by the placeholder
  // test below (and the Claude placeholder test further down).
  it('gives GA GPT-5.6 Codex models full permissions (5.5 parity, no preview-risk clamp)', () => {
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

    expect(resolved.approvalMode).toBe('auto_edit')
    expect(resolved.networkAccess).toBe('allow')
    expect(resolved.workspaceGrantServiceIds).toEqual(['shellCommands'])
    expect(resolved.agenticServices.shellCommands).toBe('allow')
    expect(resolved.agenticServices.fileChanges).toBe('allow')
    expect(resolved.agenticServices.mcpTools).toBe('allow')
    expect(resolved.agenticServices.subThreadDelegation).toBe('allow')
    expect(resolved.agenticServices.canvasInteraction).toBe('allow')
    expect(resolved.agenticServices.sketchCanvas).toBe('allow')
    expect(resolved.agenticServices.meshCanvas).toBe('allow')
    expect(resolved.agenticServices.mediaEditing).toBe('allow')
  })

  it('clamps preview-risk Codex PLACEHOLDER models to explicit approvals and denies network', () => {
    // Legacy preview:… placeholder ids stay preview-risk (isPreviewModelPlaceholder)
    // so the clamp machinery is still covered for the next codex preview family.
    const resolved = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      model: 'preview:openai:gpt-5.6:sol',
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
    expect(resolved.agenticServices.sketchCanvas).toBe('ask')
    // Mesh Canvas follows the user's explicit five-tier ladder even for a
    // preview-risk model; the global service deny still remains authoritative.
    expect(resolved.agenticServices.meshCanvas).toBe('allow')
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
      // The preset now ASKS for these; the preview-risk clamp keeps them at
      // a prompt (never auto) and the network stays force-denied.
      expect(resolved.agenticServices.shellCommands).toBe('ask')
      expect(resolved.agenticServices.fileChanges).toBe('ask')
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

describe('workspace_write preset — run-level auto-allow without a second grant', () => {
  it('auto-allows shell/file/media under workspace_write without standing grants', () => {
    const resolved = resolveEffectiveRunPermissions({
      provider: 'grok',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'workspace_write'
    })
    expect(resolved.presetId).toBe('workspace_write')
    expect(resolved.approvalMode).toBe('auto_edit')
    expect(resolved.readOnly).toBe(false)
    expect(resolved.agenticServices.shellCommands).toBe('allow')
    expect(resolved.agenticServices.fileChanges).toBe('allow')
    expect(resolved.agenticServices.mediaEditing).toBe('allow')
    expect(resolved.agenticServices.sketchCanvas).toBe('allow')
    expect(resolved.agenticServices.meshCanvas).toBe('allow')
    // Publishing follows the signed write posture; true non-grantable services stay prompt-or-deny.
    expect(resolved.agenticServices.externalPublish).toBe('allow')
    expect(resolved.agenticServices.canvasEval).toBe('ask')
    expect(resolved.agenticServices.mediaRecording).toBe('deny')
    // No standing grants are synthesized — the preset policy is enough.
    expect(resolved.workspaceGrantServiceIds).toEqual([])
  })

  it('does not qualify as Full Access sandbox-drop when shell is allow under workspace_write', () => {
    const resolved = resolveEffectiveRunPermissions({
      provider: 'codex',
      workspacePath: '/repo',
      settings: settings(),
      presetId: 'workspace_write'
    })
    expect(resolved.agenticServices.shellCommands).toBe('allow')
    expect(isFullShellAccessGranted(resolved)).toBe(false)
  })

  it('still honors a global shell/file deny kill switch over workspace_write', () => {
    const resolved = resolveEffectiveRunPermissions({
      provider: 'claude',
      workspacePath: '/repo',
      settings: settings({
        agenticServices: {
          shellCommands: 'deny',
          fileChanges: 'deny',
          externalPublish: 'ask',
          mcpTools: 'ask',
          subThreadDelegation: 'ask',
          canvasInteraction: 'ask',
          canvasEval: 'ask',
          networkAccess: 'allow'
        }
      }),
      presetId: 'workspace_write'
    })
    expect(resolved.agenticServices.shellCommands).toBe('deny')
    expect(resolved.agenticServices.fileChanges).toBe('deny')
  })
})

describe('isPlanInstrumentGrantHold — gate-level grant immunity for plan instruments', () => {
  it('holds every standard Plan service so standing grants cannot skip the modal', () => {
    for (const service of LINEAR_PERMISSION_SERVICES) {
      if (service === 'externalPublish') {
        expect(isPlanInstrumentGrantHold('plan', service)).toBe(false)
        expect(isPostureApprovalOnlyService('plan', service)).toBe(true)
      } else {
        expect(isPlanInstrumentGrantHold('plan', service)).toBe(true)
      }
    }
    expect(isPlanInstrumentGrantHold('plan', 'canvasEval')).toBe(false)
  })

  it('holds every asked mutating service under read_only (Ask) — grants cannot zero-click a prompt', () => {
    for (const service of [
      'shellCommands',
      'fileChanges',
      'mcpTools',
      'subThreadDelegation',
      'simulatorCanvas',
      'canvasInteraction',
      'sketchCanvas',
      'meshCanvas',
      'crossThreadRead',
      'threadMessage',
      'mediaEditing',
      'canvasEval',
      'webBrowsing'
    ] as const) {
      expect(isPlanInstrumentGrantHold('read_only', service)).toBe(true)
    }
    // External publishing rides POSTURE_APPROVAL_ONLY_SERVICES.
    expect(isPlanInstrumentGrantHold('read_only', 'externalPublish')).toBe(false)
    expect(isPostureApprovalOnlyService('read_only', 'externalPublish')).toBe(true)
  })

  it('holds simulatorCanvas under plan so standing grants cannot zero-click Simulator Canvas', () => {
    expect(isPlanInstrumentGrantHold('plan', 'simulatorCanvas')).toBe(true)
    expect(isPlanInstrumentGrantHold('default', 'simulatorCanvas')).toBe(false)
    expect(isPlanInstrumentGrantHold('workspace_write', 'simulatorCanvas')).toBe(false)
    expect(isPlanInstrumentGrantHold('full_access', 'simulatorCanvas')).toBe(false)
  })

  it('holds meshCanvas under plan so scene and topology edits always request access', () => {
    expect(isPlanInstrumentGrantHold('plan', 'meshCanvas')).toBe(true)
    expect(isPlanInstrumentGrantHold('default', 'meshCanvas')).toBe(false)
    expect(isPlanInstrumentGrantHold('workspace_write', 'meshCanvas')).toBe(false)
    expect(isPlanInstrumentGrantHold('full_access', 'meshCanvas')).toBe(false)
  })

  it('does NOT hold under other presets — canvas/media stay normally grantable there', () => {
    for (const preset of ['default', 'workspace_write', 'full_access', 'custom']) {
      expect(isPlanInstrumentGrantHold(preset, 'canvasInteraction')).toBe(false)
      expect(isPlanInstrumentGrantHold(preset, 'sketchCanvas')).toBe(false)
      expect(isPlanInstrumentGrantHold(preset, 'meshCanvas')).toBe(false)
      expect(isPlanInstrumentGrantHold(preset, 'mediaEditing')).toBe(false)
    }
    for (const preset of ['default', 'workspace_write', 'full_access', 'custom']) {
      expect(isPlanInstrumentGrantHold(preset, 'webBrowsing')).toBe(false)
    }
    expect(isPlanInstrumentGrantHold(undefined, 'canvasInteraction')).toBe(false)
    expect(isPlanInstrumentGrantHold(null, 'mediaEditing')).toBe(false)
  })
})
