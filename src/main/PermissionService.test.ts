import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'path'
import { PermissionService } from './PermissionService'
import { RunManager } from './RunManager'
import { resolveEffectiveRunPermissions } from './EffectiveRunPermissions'
import { effectiveAgenticSettings } from './NativeApprovalPolicy'
import type { AppSettings } from './store/types'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/taskwraith-test'
  }
}))

const settings: AppSettings = {
  activeProvider: 'gemini',
  claudeBinaryPath: '',
  kimiBinaryPath: '',
  storeLocalChatHistory: true,
  storeRawEvents: false,
  storePromptResponseInUsage: false,
  ensembleModeEnabled: true,
  geminiCheckpointingEnabled: false,
  chatContextTurns: 6,
  currency: 'USD',
  kimiSanitiserEnabled: false,
  kimiSanitiserCustomKeywords: '',
  appearanceMode: 'soft_glass',
  visualEffectStyle: 'auto',
  themeAppearance: 'system',
  themeCornerStyle: 'rounded',
  themeAccentStyle: 'system',
  toolIconAccent: 'system',
  userBubbleColor: 'system',
  appIconVariant: 'regular',
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
  reduceTransparency: false,
  reduceMotion: false,
  compactDensity: false,
  liveActivityViewport: true,
  showInspector: true,
  inspectorWidth: 380,
  sidebarWidth: 260,
  sidebarOpacity: 100,
  mainPaneOpacity: 100,
  agenticServices: {
    shellCommands: 'workspace',
    fileChanges: 'ask',
    externalPublish: 'ask',
    mcpTools: 'deny',
    subThreadDelegation: 'ask',
    canvasInteraction: 'ask',
    canvasEval: 'ask',
    networkAccess: 'allow'
  },
  agenticWorkspaceGrants: [],
  autoResumeParentOnSubThreadCompletion: true,
  geminiMcpBridgeEnabled: false,
  codexSandboxFallback: 'ask_rerun',
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
      ollama: 120_000,
      antigravity: 120_000,
      pi: 120_000,
      mistral: 120_000,
      muse: 120_000,
      devin: 120_000
    },
    mainAuthorityMs: 60_000
  }
}

describe('PermissionService — surface-scoped canvas grants', () => {
  /**
   * The escalation this closes: `canvasInteraction` grants were keyed
   * provider:service:workspace with no surface, so one "allow for session"
   * covered every canvas in the run AND every canvas opened afterwards — and an
   * agent can enumerate the chat's canvases with canvas_list, including a
   * renderer-created one the user logged into themselves. "The user chose this
   * window" was a property of the prompt, never of the grant.
   */
  function harness(): { service: PermissionService; runManager: RunManager } {
    const runManager = new RunManager()
    runManager.create({ runId: 'run-1', provider: 'gemini', workspacePath: '/repo' })
    return {
      service: new PermissionService({ runManager, sessionGrants: new Set() }),
      runManager
    }
  }

  it('a grant on one canvas does NOT auto-allow a different canvas', () => {
    const { service } = harness()
    service.addSessionGrant('gemini', '/repo', 'canvasInteraction', 'run-1', 'canvas-approved')

    const sameSurface = service.resolvePermission(
      'gemini',
      'canvasInteraction',
      '/repo',
      'run-1',
      settings,
      'canvas-approved'
    )
    const otherSurface = service.resolvePermission(
      'gemini',
      'canvasInteraction',
      '/repo',
      'run-1',
      settings,
      'canvas-the-user-logged-into'
    )

    expect(sameSurface.sessionGrantAllowed).toBe(true)
    expect(sameSurface.decision).toBe('allow')
    // The whole point: same run, same provider, same workspace, same service.
    expect(otherSurface.sessionGrantAllowed).toBe(false)
    expect(otherSurface.decision).toBe('ask')
  })

  it('fails closed when a request carries no surface at all', () => {
    // A call that simply omits its canvasId must not fall back to the unscoped
    // key — that would reopen the hole by omission rather than intent.
    const { service } = harness()
    service.addSessionGrant('gemini', '/repo', 'canvasInteraction', 'run-1', 'canvas-approved')

    const unscoped = service.resolvePermission(
      'gemini',
      'canvasInteraction',
      '/repo',
      'run-1',
      settings
    )

    expect(unscoped.sessionGrantAllowed).toBe(false)
    expect(unscoped.decision).toBe('ask')
  })

  it('refuses to mint an unscoped canvas grant rather than storing a dead one', () => {
    // A stored grant that can never match is worse than none: the UI would
    // report it as given while every call still prompts.
    const { service } = harness()
    service.addSessionGrant('gemini', '/repo', 'canvasInteraction', 'run-1')

    expect(
      service.hasSessionGrant('gemini', '/repo', 'canvasInteraction', 'run-1', 'any-canvas')
    ).toBe(false)
  })

  it('scopes the RUN-attached grant, which is the path that actually fires', () => {
    // addSessionGrant delegates to RunManager and returns whenever a run is
    // live, so scoping only the process-global Set would have left the common
    // case wide open.
    const { service, runManager } = harness()
    service.addSessionGrant('gemini', '/repo', 'canvasInteraction', 'run-1', 'canvas-a')

    expect(runManager.hasSessionGrant('run-1', 'canvasInteraction', 'canvas-a')).toBe(true)
    expect(runManager.hasSessionGrant('run-1', 'canvasInteraction', 'canvas-b')).toBe(false)
    expect(runManager.hasSessionGrant('run-1', 'canvasInteraction')).toBe(false)
  })

  it('has no workspace tier for canvas interaction, even from a stored grant', () => {
    // Defence against a grant persisted by an older build or hand-edited in.
    const { service } = harness()
    const withWorkspaceGrant = service.resolvePermission(
      'gemini',
      'canvasInteraction',
      '/repo',
      undefined,
      {
        ...settings,
        agenticWorkspaceGrants: [
          {
            id: 'grant-legacy-canvas',
            provider: 'gemini',
            service: 'canvasInteraction',
            workspacePath: '/repo',
            createdAt: '2026-05-08T00:00:00.000Z',
            updatedAt: '2026-05-08T00:00:00.000Z'
          }
        ]
      },
      'canvas-a'
    )

    expect(withWorkspaceGrant.workspaceGrantAllowed).toBe(false)
    expect(withWorkspaceGrant.decision).toBe('ask')
  })

  it('leaves non-surface services untouched by the scoping', () => {
    // Proves the change is targeted rather than a global de-grant — shellCommands
    // still auto-allows from a plain session grant with no surface in sight.
    const { service } = harness()
    service.addSessionGrant('gemini', '/repo', 'shellCommands', 'run-1')

    expect(
      service.resolvePermission('gemini', 'shellCommands', '/repo', 'run-1', settings).decision
    ).toBe('allow')
  })

  it('requires an exact Simulator surface even when the broad policy says allow', () => {
    const { service } = harness()
    const simulatorSettings = {
      ...settings,
      agenticServices: { ...settings.agenticServices, simulatorCanvas: 'allow' as const }
    }
    expect(
      service.resolvePermission(
        'gemini',
        'simulatorCanvas',
        '/repo',
        'run-1',
        simulatorSettings,
        'simulator:DEVICE-1:com.example.App'
      ).decision
    ).toBe('ask')
    service.addSessionGrant(
      'gemini',
      '/repo',
      'simulatorCanvas',
      'run-1',
      'simulator:DEVICE-1:com.example.App'
    )
    expect(
      service.resolvePermission(
        'gemini',
        'simulatorCanvas',
        '/repo',
        'run-1',
        simulatorSettings,
        'simulator:DEVICE-1:com.example.App'
      ).decision
    ).toBe('allow')
  })

  it('revokes the exact surface grant after navigation, takeover, or lease expiry', () => {
    const { service, runManager } = harness()
    service.addSessionGrant('gemini', '/repo', 'canvasInteraction', 'run-1', 'canvas-a')
    expect(runManager.hasSessionGrant('run-1', 'canvasInteraction', 'canvas-a')).toBe(true)
    expect(
      service.removeSessionGrant('gemini', '/repo', 'canvasInteraction', 'run-1', 'canvas-a')
    ).toBe(true)
    expect(runManager.hasSessionGrant('run-1', 'canvasInteraction', 'canvas-a')).toBe(false)
  })
})

describe('PermissionService', () => {
  it('resolves workspace and session grants through one authority', () => {
    const runManager = new RunManager()
    runManager.create({ runId: 'run-1', provider: 'gemini', workspacePath: '/repo' })
    const service = new PermissionService({ runManager, sessionGrants: new Set() })

    expect(
      service.resolvePermission('gemini', 'shellCommands', '/repo', 'run-1', settings).decision
    ).toBe('ask')

    service.addSessionGrant('gemini', '/repo', 'shellCommands', 'run-1')
    expect(
      service.resolvePermission('gemini', 'shellCommands', '/repo', 'run-1', settings).decision
    ).toBe('allow')

    expect(
      service.resolvePermission('gemini', 'shellCommands', '/repo', undefined, {
        ...settings,
        agenticWorkspaceGrants: [
          {
            id: 'grant-1',
            provider: 'gemini',
            service: 'shellCommands',
            workspacePath: '/repo',
            createdAt: '2026-05-08T00:00:00.000Z',
            updatedAt: '2026-05-08T00:00:00.000Z'
          }
        ]
      }).decision
    ).toBe('allow')
  })

  it('does not authorize an action from an expired or malformed workspace grant', () => {
    const service = new PermissionService({
      runManager: new RunManager(),
      sessionGrants: new Set()
    })
    const grant = {
      id: 'grant-expiring',
      provider: 'gemini' as const,
      service: 'shellCommands' as const,
      workspacePath: '/repo',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z'
    }

    for (const expiresAt of ['2000-01-01T00:00:00.000Z', 'not-a-date']) {
      const expiredSettings: AppSettings = {
        ...settings,
        agenticWorkspaceGrants: [{ ...grant, expiresAt }]
      }
      expect(service.hasWorkspaceGrant(expiredSettings, 'gemini', '/repo', 'shellCommands')).toBe(
        false
      )
      expect(
        service.resolvePermission('gemini', 'shellCommands', '/repo', undefined, expiredSettings)
          .decision
      ).toBe('ask')
    }
  })

  it('continues to honor an unexpired workspace grant at action time', () => {
    const service = new PermissionService({
      runManager: new RunManager(),
      sessionGrants: new Set()
    })
    const activeSettings: AppSettings = {
      ...settings,
      agenticWorkspaceGrants: [
        {
          id: 'grant-active',
          provider: 'gemini',
          service: 'shellCommands',
          workspacePath: '/repo',
          createdAt: '2026-05-08T00:00:00.000Z',
          updatedAt: '2026-05-08T00:00:00.000Z',
          expiresAt: '2999-01-01T00:00:00.000Z'
        }
      ]
    }

    expect(
      service.resolvePermission('gemini', 'shellCommands', '/repo', undefined, activeSettings)
        .decision
    ).toBe('allow')
  })

  it('applies approved actions while keeping declines non-approved', () => {
    const service = new PermissionService({
      runManager: new RunManager(),
      sessionGrants: new Set()
    })

    expect(service.isApprovedAction('accept')).toBe(true)
    expect(service.isApprovedAction('acceptForSession')).toBe(true)
    expect(service.isApprovedAction('decline')).toBe(false)
    expect(service.isApprovedAction('cancel')).toBe(false)
  })

  it('uses session grants for global approvals without workspace grants', () => {
    const service = new PermissionService({
      runManager: new RunManager(),
      sessionGrants: new Set()
    })

    expect(
      service.resolvePermission('codex', 'shellCommands', undefined, undefined, settings).decision
    ).toBe('ask')
    service.applyApprovalDecision({
      provider: 'codex',
      service: 'shellCommands',
      action: 'acceptForSession'
    })

    expect(
      service.resolvePermission('codex', 'shellCommands', undefined, undefined, settings).decision
    ).toBe('allow')
    expect(service.hasWorkspaceGrant(settings, 'codex', undefined, 'shellCommands')).toBe(false)
  })

  it('routes workspace grant writes through the managed settings updater', () => {
    let persistedSettings: AppSettings = {
      ...settings,
      agenticServices: { ...settings.agenticServices, shellCommands: 'workspace' },
      agenticWorkspaceGrants: []
    }
    const updateSettings = vi.fn((partial: Partial<AppSettings>) => {
      // Mirrors SettingsService + ManagedPolicyService filtering when
      // agenticWorkspaceGrants is managed/cleared by organization policy.
      persistedSettings = {
        ...persistedSettings,
        ...partial,
        agenticWorkspaceGrants: []
      }
    })
    const service = new PermissionService({
      runManager: new RunManager(),
      sessionGrants: new Set(),
      getSettings: () => persistedSettings,
      updateSettings
    })

    expect(
      service.applyApprovalDecision({
        provider: 'codex',
        workspacePath: '/repo',
        service: 'shellCommands',
        action: 'acceptForWorkspace'
      })
    ).toBe(true)
    expect(updateSettings).toHaveBeenCalledWith({
      agenticWorkspaceGrants: [
        expect.objectContaining({
          provider: 'agents',
          service: 'shellCommands',
          workspacePath: resolve('/repo'),
          expiresOn: 'workspace_revocation'
        })
      ]
    })
    expect(persistedSettings.agenticWorkspaceGrants).toEqual([])
    expect(
      service.resolvePermission('codex', 'shellCommands', '/repo', undefined, persistedSettings)
        .decision
    ).toBe('ask')
  })

  it('keeps broad session/workspace grants from covering unrelated canvasEval surfaces', () => {
    const runManager = new RunManager()
    runManager.create({ runId: 'run-eval', provider: 'gemini', workspacePath: '/repo' })
    const service = new PermissionService({ runManager, sessionGrants: new Set() })

    // Baseline: canvasEval prompts (settings default 'ask').
    expect(
      service.resolvePermission('gemini', 'canvasEval', '/repo', 'run-eval', settings).decision
    ).toBe('ask')

    // A session grant — which auto-allows shellCommands above — is INERT for eval.
    service.addSessionGrant('gemini', '/repo', 'canvasEval', 'run-eval')
    const withSession = service.resolvePermission(
      'gemini',
      'canvasEval',
      '/repo',
      'run-eval',
      settings
    )
    expect(withSession.sessionGrantAllowed).toBe(false)
    expect(withSession.decision).toBe('ask')

    // A workspace grant is equally inert. The dedicated surface-window path is
    // intentionally separate and is exercised below.
    const withWorkspace = service.resolvePermission('gemini', 'canvasEval', '/repo', undefined, {
      ...settings,
      agenticWorkspaceGrants: [
        {
          id: 'grant-eval',
          provider: 'gemini',
          service: 'canvasEval',
          workspacePath: '/repo',
          createdAt: '2026-05-08T00:00:00.000Z',
          updatedAt: '2026-05-08T00:00:00.000Z'
        }
      ]
    })
    expect(withWorkspace.workspaceGrantAllowed).toBe(false)
    expect(withWorkspace.decision).toBe('ask')

    expect(
      service.applyApprovalDecision({
        provider: 'codex',
        workspacePath: '/repo',
        service: 'canvasEval',
        runId: 'run-publish',
        action: 'acceptForSession'
      })
    ).toBe(true)
    expect(service.hasSessionGrant('codex', '/repo', 'canvasEval', 'run-publish')).toBe(false)
  })

  it('treats externalPublish as grantable for session/workspace approvals', () => {
    const runManager = new RunManager()
    runManager.create({ runId: 'run-publish', provider: 'codex', workspacePath: '/repo' })
    const service = new PermissionService({ runManager, sessionGrants: new Set() })

    service.addSessionGrant('codex', '/repo', 'externalPublish', 'run-publish')
    const withSession = service.resolvePermission(
      'codex',
      'externalPublish',
      '/repo',
      'run-publish',
      settings
    )
    expect(withSession.sessionGrantAllowed).toBe(true)
    expect(withSession.decision).toBe('allow')

    const withWorkspace = service.resolvePermission(
      'codex',
      'externalPublish',
      '/repo',
      undefined,
      {
        ...settings,
        agenticWorkspaceGrants: [
          {
            id: 'grant-publish',
            provider: 'codex',
            service: 'externalPublish',
            workspacePath: '/repo',
            createdAt: '2026-05-08T00:00:00.000Z',
            updatedAt: '2026-05-08T00:00:00.000Z'
          }
        ]
      }
    )
    expect(withWorkspace.workspaceGrantAllowed).toBe(true)
    expect(withWorkspace.decision).toBe('allow')
  })

  // Phase I1.b: approval gate on multi-provider delegation.
  // The same resolvePermission / applyApprovalDecision machinery
  // handles the new 'subThreadDelegation' service id generically —
  // these tests pin that behaviour so a future regression in the
  // gate (e.g. someone hardcodes a special case) trips immediately.
  describe('subThreadDelegation service', () => {
    it("default 'ask' policy returns ask decision", () => {
      const service = new PermissionService({
        runManager: new RunManager(),
        sessionGrants: new Set()
      })
      expect(
        service.resolvePermission('gemini', 'subThreadDelegation', '/repo', undefined, settings)
          .decision
      ).toBe('ask')
    })

    it("workspace grant for 'subThreadDelegation' auto-allows subsequent calls (with 'workspace' policy)", () => {
      const service = new PermissionService({
        runManager: new RunManager(),
        sessionGrants: new Set()
      })
      const withGrant: AppSettings = {
        ...settings,
        agenticServices: {
          ...settings.agenticServices,
          subThreadDelegation: 'workspace'
        },
        agenticWorkspaceGrants: [
          {
            id: 'grant-delegation',
            provider: 'gemini',
            service: 'subThreadDelegation',
            workspacePath: '/repo',
            createdAt: '2026-05-16T00:00:00.000Z',
            updatedAt: '2026-05-16T00:00:00.000Z'
          }
        ]
      }
      expect(
        service.resolvePermission('gemini', 'subThreadDelegation', '/repo', undefined, withGrant)
          .decision
      ).toBe('allow')
    })

    it("session grant survives a single run for 'subThreadDelegation'", () => {
      const runManager = new RunManager()
      runManager.create({ runId: 'delegating-run', provider: 'gemini', workspacePath: '/repo' })
      const service = new PermissionService({ runManager, sessionGrants: new Set() })
      // First call: ask.
      expect(
        service.resolvePermission(
          'gemini',
          'subThreadDelegation',
          '/repo',
          'delegating-run',
          settings
        ).decision
      ).toBe('ask')
      // Apply "acceptForSession" → second call: allow.
      service.applyApprovalDecision({
        provider: 'gemini',
        workspacePath: '/repo',
        service: 'subThreadDelegation',
        runId: 'delegating-run',
        action: 'acceptForSession'
      })
      expect(
        service.resolvePermission(
          'gemini',
          'subThreadDelegation',
          '/repo',
          'delegating-run',
          settings
        ).decision
      ).toBe('allow')
    })

    it("'deny' policy short-circuits to deny without prompting", () => {
      const service = new PermissionService({
        runManager: new RunManager(),
        sessionGrants: new Set()
      })
      const denySettings: AppSettings = {
        ...settings,
        agenticServices: {
          ...settings.agenticServices,
          subThreadDelegation: 'deny'
        }
      }
      expect(
        service.resolvePermission('gemini', 'subThreadDelegation', '/repo', undefined, denySettings)
          .decision
      ).toBe('deny')
    })

    it("'allow' policy short-circuits to allow without prompting", () => {
      const service = new PermissionService({
        runManager: new RunManager(),
        sessionGrants: new Set()
      })
      const allowSettings: AppSettings = {
        ...settings,
        agenticServices: {
          ...settings.agenticServices,
          subThreadDelegation: 'allow'
        }
      }
      expect(
        service.resolvePermission(
          'gemini',
          'subThreadDelegation',
          '/repo',
          undefined,
          allowSettings
        ).decision
      ).toBe('allow')
    })

    it("'workspace' policy returns ask until a workspace grant exists", () => {
      const service = new PermissionService({
        runManager: new RunManager(),
        sessionGrants: new Set()
      })
      const workspaceSettings: AppSettings = {
        ...settings,
        agenticServices: {
          ...settings.agenticServices,
          subThreadDelegation: 'workspace'
        }
      }
      // No grant yet → ask.
      expect(
        service.resolvePermission(
          'gemini',
          'subThreadDelegation',
          '/repo',
          undefined,
          workspaceSettings
        ).decision
      ).toBe('ask')
      // With an 'agents' workspace grant → allow for any provider in that workspace.
      const withGrant: AppSettings = {
        ...workspaceSettings,
        agenticWorkspaceGrants: [
          {
            id: 'grant-delegation-2',
            provider: 'agents',
            service: 'subThreadDelegation',
            workspacePath: '/repo',
            createdAt: '2026-05-16T00:00:00.000Z',
            updatedAt: '2026-05-16T00:00:00.000Z'
          }
        ]
      }
      expect(
        service.resolvePermission('gemini', 'subThreadDelegation', '/repo', undefined, withGrant)
          .decision
      ).toBe('allow')
      expect(
        service.resolvePermission('codex', 'subThreadDelegation', '/repo', undefined, withGrant)
          .decision
      ).toBe('allow')
    })

    it('legacy per-provider workspace grants remain scoped to that provider', () => {
      const service = new PermissionService({
        runManager: new RunManager(),
        sessionGrants: new Set()
      })
      const withGeminiGrant: AppSettings = {
        ...settings,
        agenticServices: {
          ...settings.agenticServices,
          subThreadDelegation: 'workspace'
        },
        agenticWorkspaceGrants: [
          {
            id: 'grant-gemini-delegation',
            provider: 'gemini',
            service: 'subThreadDelegation',
            workspacePath: '/repo',
            createdAt: '2026-05-16T00:00:00.000Z',
            updatedAt: '2026-05-16T00:00:00.000Z'
          }
        ]
      }
      // Gemini parent → allow (legacy grant matches its provider).
      expect(
        service.resolvePermission(
          'gemini',
          'subThreadDelegation',
          '/repo',
          undefined,
          withGeminiGrant
        ).decision
      ).toBe('allow')
      // Codex parent → ask (legacy grant is scoped to Gemini).
      expect(
        service.resolvePermission(
          'codex',
          'subThreadDelegation',
          '/repo',
          undefined,
          withGeminiGrant
        ).decision
      ).toBe('ask')
    })

    // Phase I3 (Claude initiator): with Claude now able to spawn cross-
    // provider sub-threads via the TaskWraith MCP server, the gate must
    // route through 'provider: claude' on every broker request. Pin the
    // ask + grant + provider-scope semantics for the Claude path so the
    // approval modal and workspace-grant logic stay symmetric with
    // Gemini/Codex.
    it("Claude-initiated delegation triggers the gate with provider: 'claude'", () => {
      const service = new PermissionService({
        runManager: new RunManager(),
        sessionGrants: new Set()
      })
      // Default 'ask' policy: every Claude-initiated delegate_to_subthread
      // hits the approval modal until a grant exists.
      expect(
        service.resolvePermission('claude', 'subThreadDelegation', '/repo', undefined, settings)
          .decision
      ).toBe('ask')
    })

    it('Claude-initiated workspace grant auto-allows all providers in that workspace', () => {
      const service = new PermissionService({
        runManager: new RunManager(),
        sessionGrants: new Set()
      })
      const withClaudeGrant: AppSettings = {
        ...settings,
        agenticServices: {
          ...settings.agenticServices,
          subThreadDelegation: 'workspace'
        },
        agenticWorkspaceGrants: [
          {
            id: 'grant-claude-delegation',
            provider: 'agents',
            service: 'subThreadDelegation',
            workspacePath: '/repo',
            createdAt: '2026-05-16T00:00:00.000Z',
            updatedAt: '2026-05-16T00:00:00.000Z'
          }
        ]
      }
      // Claude parent → allow.
      expect(
        service.resolvePermission(
          'claude',
          'subThreadDelegation',
          '/repo',
          undefined,
          withClaudeGrant
        ).decision
      ).toBe('allow')
      // Gemini/Codex parents also → allow because the grant is 'agents'-scoped.
      expect(
        service.resolvePermission(
          'gemini',
          'subThreadDelegation',
          '/repo',
          undefined,
          withClaudeGrant
        ).decision
      ).toBe('allow')
      expect(
        service.resolvePermission(
          'codex',
          'subThreadDelegation',
          '/repo',
          undefined,
          withClaudeGrant
        ).decision
      ).toBe('allow')
    })

    // Phase I4 (Kimi initiator): with Kimi now able to spawn cross-
    // provider sub-threads via `kimi mcp add TaskWraith`, the gate must
    // route through 'provider: kimi' on every broker request. Pin the
    // ask + grant + provider-scope semantics for the Kimi path so the
    // approval modal and workspace-grant logic stay symmetric with
    // Gemini / Codex / Claude.
    it("Kimi-initiated delegation triggers the gate with provider: 'kimi'", () => {
      const service = new PermissionService({
        runManager: new RunManager(),
        sessionGrants: new Set()
      })
      // Default 'ask' policy: every Kimi-initiated delegate_to_subthread
      // hits the approval modal until a grant exists.
      expect(
        service.resolvePermission('kimi', 'subThreadDelegation', '/repo', undefined, settings)
          .decision
      ).toBe('ask')
    })

    it('Kimi-initiated workspace grant auto-allows all providers in that workspace', () => {
      const service = new PermissionService({
        runManager: new RunManager(),
        sessionGrants: new Set()
      })
      const withKimiGrant: AppSettings = {
        ...settings,
        agenticServices: {
          ...settings.agenticServices,
          subThreadDelegation: 'workspace'
        },
        agenticWorkspaceGrants: [
          {
            id: 'grant-kimi-delegation',
            provider: 'agents',
            service: 'subThreadDelegation',
            workspacePath: '/repo',
            createdAt: '2026-05-16T00:00:00.000Z',
            updatedAt: '2026-05-16T00:00:00.000Z'
          }
        ]
      }
      // Kimi parent → allow.
      expect(
        service.resolvePermission('kimi', 'subThreadDelegation', '/repo', undefined, withKimiGrant)
          .decision
      ).toBe('allow')
      // Other providers also → allow because the grant is 'agents'-scoped.
      expect(
        service.resolvePermission(
          'gemini',
          'subThreadDelegation',
          '/repo',
          undefined,
          withKimiGrant
        ).decision
      ).toBe('allow')
      expect(
        service.resolvePermission('codex', 'subThreadDelegation', '/repo', undefined, withKimiGrant)
          .decision
      ).toBe('allow')
      expect(
        service.resolvePermission(
          'claude',
          'subThreadDelegation',
          '/repo',
          undefined,
          withKimiGrant
        ).decision
      ).toBe('allow')
    })

    it('upsertWorkspaceGrant stores an agents-scoped grant regardless of requesting provider', () => {
      let persistedSettings: AppSettings = {
        ...settings,
        agenticServices: {
          ...settings.agenticServices,
          subThreadDelegation: 'workspace'
        },
        agenticWorkspaceGrants: []
      }
      const service = new PermissionService({
        runManager: new RunManager(),
        sessionGrants: new Set(),
        getSettings: () => persistedSettings,
        updateSettings: (partial) => {
          persistedSettings = { ...persistedSettings, ...partial }
        }
      })
      service.upsertWorkspaceGrant('gemini', '/repo', 'subThreadDelegation')
      expect(persistedSettings.agenticWorkspaceGrants).toHaveLength(1)
      expect(persistedSettings.agenticWorkspaceGrants[0].provider).toBe('agents')
      expect(
        service.resolvePermission(
          'gemini',
          'subThreadDelegation',
          '/repo',
          undefined,
          persistedSettings
        ).decision
      ).toBe('allow')
      expect(
        service.resolvePermission(
          'codex',
          'subThreadDelegation',
          '/repo',
          undefined,
          persistedSettings
        ).decision
      ).toBe('allow')
    })
  })

  // Posture conformance across the REAL resolver → gate-settings → decision
  // chain (no mocks): the contract behind "honor Full WS Access without a
  // second grant". The 2026-07-21 00:21–01:00 regression session showed the
  // failure mode this fences: preset entries overriding the user's globals back
  // to a grant-gated policy, with the grant store unable to satisfy it —
  // 21 manual acceptForWorkspace clicks and 11 timeout auto-denies in one run.
  describe('write-preset approval conformance (resolver → gate settings → decision)', () => {
    const allAskSettings: AppSettings = {
      ...settings,
      agenticServices: {
        shellCommands: 'ask',
        fileChanges: 'ask',
        externalPublish: 'ask',
        mcpTools: 'ask',
        subThreadDelegation: 'ask',
        canvasInteraction: 'ask',
        crossThreadRead: 'ask',
        mediaEditing: 'ask',
        mediaRecording: 'deny',
        canvasEval: 'ask',
        networkAccess: 'allow'
      },
      agenticWorkspaceGrants: []
    }

    function decisionFor(
      presetId: 'read_only' | 'plan' | 'default' | 'workspace_write' | 'full_access',
      service: Parameters<PermissionService['resolvePermission']>[1],
      globals: AppSettings = allAskSettings
    ): string {
      const permissions = resolveEffectiveRunPermissions({
        provider: 'grok',
        workspacePath: '/repo',
        settings: globals,
        presetId
      })
      const gateSettings = effectiveAgenticSettings(globals, permissions)
      const permissionService = new PermissionService({
        runManager: new RunManager(),
        sessionGrants: new Set()
      })
      return permissionService.resolvePermission('grok', service, '/repo', undefined, gateSettings)
        .decision
    }

    it('workspace_write auto-allows shell/file/media with zero grants and all-ask globals', () => {
      expect(decisionFor('workspace_write', 'shellCommands')).toBe('allow')
      expect(decisionFor('workspace_write', 'fileChanges')).toBe('allow')
      expect(decisionFor('workspace_write', 'mediaEditing')).toBe('allow')
    })

    it('trusted full_access auto-allows the grantable belt the same way', () => {
      expect(decisionFor('full_access', 'shellCommands')).toBe('allow')
      expect(decisionFor('full_access', 'fileChanges')).toBe('allow')
      expect(decisionFor('full_access', 'mcpTools')).toBe('allow')
      expect(decisionFor('full_access', 'subThreadDelegation')).toBe('allow')
      expect(decisionFor('full_access', 'crossThreadRead')).toBe('allow')
    })

    it('publication asks through Accept Edits and auto-allows on the write tiers', () => {
      expect(decisionFor('read_only', 'externalPublish')).toBe('ask')
      expect(decisionFor('plan', 'externalPublish')).toBe('ask')
      // Accept Edits keeps external publishing as an attended decision (push/PR
      // require a separate workspace grant or per-invocation approval).
      expect(decisionFor('default', 'externalPublish')).toBe('ask')
      expect(decisionFor('workspace_write', 'externalPublish')).toBe('allow')
      expect(decisionFor('full_access', 'externalPublish')).toBe('allow')
    })

    it('a global deny survives both write presets (kill switch wins)', () => {
      const globalShellDeny: AppSettings = {
        ...allAskSettings,
        agenticServices: { ...allAskSettings.agenticServices, shellCommands: 'deny' }
      }
      expect(decisionFor('workspace_write', 'shellCommands', globalShellDeny)).toBe('deny')
      expect(decisionFor('full_access', 'shellCommands', globalShellDeny)).toBe('deny')
    })
  })
})

describe('canvas_eval 12h approval window', () => {
  const HOUR = 60 * 60 * 1000
  const WINDOW = 12 * HOUR

  function makeService(): PermissionService {
    const runManager = new RunManager()
    return new PermissionService({ runManager, sessionGrants: new Set() })
  }

  it('is not granted before any approval', () => {
    expect(makeService().hasLiveCanvasEvalWindowGrant('canvas-a', 1_000)).toBe(false)
  })

  it('grants for exactly 12h from the first accept, then re-prompts', () => {
    const service = makeService()
    const t0 = 1_000_000
    service.recordCanvasEvalWindowGrant('canvas-a', t0)
    expect(service.hasLiveCanvasEvalWindowGrant('canvas-a', t0)).toBe(true)
    expect(service.hasLiveCanvasEvalWindowGrant('canvas-a', t0 + HOUR)).toBe(true)
    expect(service.hasLiveCanvasEvalWindowGrant('canvas-a', t0 + WINDOW - 1)).toBe(true)
    // At the 12h boundary the window has elapsed → the next eval re-prompts.
    expect(service.hasLiveCanvasEvalWindowGrant('canvas-a', t0 + WINDOW)).toBe(false)
  })

  it('anchors the window to the FIRST accept — a later eval never slides the 12h', () => {
    const service = makeService()
    const t0 = 5_000_000
    service.recordCanvasEvalWindowGrant('canvas-a', t0)
    // A second accept / auto-approve 6h in must NOT extend the window.
    service.recordCanvasEvalWindowGrant('canvas-a', t0 + 6 * HOUR)
    expect(service.hasLiveCanvasEvalWindowGrant('canvas-a', t0 + WINDOW - 1)).toBe(true)
    expect(service.hasLiveCanvasEvalWindowGrant('canvas-a', t0 + WINDOW)).toBe(false)
  })

  it('is bound to the exact canvasId and requires one', () => {
    const service = makeService()
    const t0 = 2_000_000
    service.recordCanvasEvalWindowGrant('canvas-a', t0)
    expect(service.hasLiveCanvasEvalWindowGrant('canvas-b', t0 + HOUR)).toBe(false)
    // A missing / blank surface can never establish or match a window grant.
    service.recordCanvasEvalWindowGrant(undefined, t0)
    service.recordCanvasEvalWindowGrant('', t0)
    expect(service.hasLiveCanvasEvalWindowGrant(undefined, t0)).toBe(false)
    expect(service.hasLiveCanvasEvalWindowGrant('', t0)).toBe(false)
  })

  it('continues on the same live Canvas surface across navigation and later turns', () => {
    const service = makeService()
    const t0 = 2_500_000
    service.recordCanvasEvalWindowGrant('canvas-live', t0)

    // The window key is the live canvas id, deliberately not its current URL,
    // provider, or run. Navigation and a later agent turn therefore retain it.
    expect(service.hasLiveCanvasEvalWindowGrant('canvas-live', t0 + HOUR)).toBe(true)
    expect(service.hasLiveCanvasEvalWindowGrant('canvas-other', t0 + HOUR)).toBe(false)
  })

  it('a re-prompt after expiry starts a fresh 12h window', () => {
    const service = makeService()
    const t0 = 3_000_000
    service.recordCanvasEvalWindowGrant('canvas-a', t0)
    expect(service.hasLiveCanvasEvalWindowGrant('canvas-a', t0 + WINDOW)).toBe(false)
    // The human is asked again and accepts; the window restarts from that accept.
    const t1 = t0 + WINDOW + HOUR
    service.recordCanvasEvalWindowGrant('canvas-a', t1)
    expect(service.hasLiveCanvasEvalWindowGrant('canvas-a', t1 + HOUR)).toBe(true)
  })

  it('a human accept opens the window; decline does not; it never becomes a generic session grant', () => {
    const runManager = new RunManager()
    runManager.create({ runId: 'run-eval', provider: 'claude', workspacePath: '/repo' })
    const service = new PermissionService({ runManager, sessionGrants: new Set() })

    // Accept, carrying the exact surface the user was shown → window opens.
    expect(
      service.applyApprovalDecision({
        provider: 'claude',
        workspacePath: '/repo',
        service: 'canvasEval',
        runId: 'run-eval',
        action: 'accept',
        surfaceId: 'canvas-a'
      })
    ).toBe(true)
    expect(service.hasLiveCanvasEvalWindowGrant('canvas-a', Date.now())).toBe(true)
    // The generic session/workspace machinery remains separate: its broad grant
    // key is not populated. The approval gate consults the live surface window
    // before showing another prompt.
    expect(service.hasSessionGrant('claude', '/repo', 'canvasEval', 'run-eval', 'canvas-a')).toBe(
      false
    )

    // A decline opens nothing for that surface.
    service.applyApprovalDecision({
      provider: 'claude',
      workspacePath: '/repo',
      service: 'canvasEval',
      runId: 'run-eval',
      action: 'decline',
      surfaceId: 'canvas-b'
    })
    expect(service.hasLiveCanvasEvalWindowGrant('canvas-b', Date.now())).toBe(false)
  })
})
