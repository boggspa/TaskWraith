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
      pi: 120_000
    },
    mainAuthorityMs: 60_000
  }
}

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
          provider: 'codex',
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

  it('treats canvasEval (RCE) as non-grantable — no session/workspace grant auto-allows it', () => {
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

    // A workspace grant is equally inert — eval always re-prompts.
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

    const withWorkspace = service.resolvePermission('codex', 'externalPublish', '/repo', undefined, {
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
    })
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
      // With grant → allow.
      const withGrant: AppSettings = {
        ...workspaceSettings,
        agenticWorkspaceGrants: [
          {
            id: 'grant-delegation-2',
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

    it('workspace grant is provider-scoped: a Gemini grant does not auto-allow Codex delegation', () => {
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
      // Gemini parent → allow (has grant matching its provider).
      expect(
        service.resolvePermission(
          'gemini',
          'subThreadDelegation',
          '/repo',
          undefined,
          withGeminiGrant
        ).decision
      ).toBe('allow')
      // Codex parent → ask (no Codex grant; orthogonal to the Gemini one).
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

    it("Claude workspace grant auto-allows subsequent Claude delegations (and only Claude's)", () => {
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
            provider: 'claude',
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
      // Gemini parent → still ask (provider-scoped grant).
      expect(
        service.resolvePermission(
          'gemini',
          'subThreadDelegation',
          '/repo',
          undefined,
          withClaudeGrant
        ).decision
      ).toBe('ask')
      // Codex parent → still ask.
      expect(
        service.resolvePermission(
          'codex',
          'subThreadDelegation',
          '/repo',
          undefined,
          withClaudeGrant
        ).decision
      ).toBe('ask')
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

    it("Kimi workspace grant auto-allows subsequent Kimi delegations (and only Kimi's)", () => {
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
            provider: 'kimi',
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
      // Gemini parent → still ask (provider-scoped grant; Gemini grant
      // does not auto-allow Kimi delegation in the same workspace).
      expect(
        service.resolvePermission(
          'gemini',
          'subThreadDelegation',
          '/repo',
          undefined,
          withKimiGrant
        ).decision
      ).toBe('ask')
      // Codex parent → still ask.
      expect(
        service.resolvePermission('codex', 'subThreadDelegation', '/repo', undefined, withKimiGrant)
          .decision
      ).toBe('ask')
      // Claude parent → still ask.
      expect(
        service.resolvePermission(
          'claude',
          'subThreadDelegation',
          '/repo',
          undefined,
          withKimiGrant
        ).decision
      ).toBe('ask')
    })

    it('reverse-direction: a Gemini workspace grant does NOT auto-allow Kimi delegation', () => {
      // Mirror of the "Claude grant doesn't auto-allow Gemini" test for
      // the new Kimi parent provider. Phase I4 closes the matrix so
      // every combination of grant-direction needs to be provider-scoped.
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
            id: 'grant-gemini-for-kimi-test',
            provider: 'gemini',
            service: 'subThreadDelegation',
            workspacePath: '/repo',
            createdAt: '2026-05-16T00:00:00.000Z',
            updatedAt: '2026-05-16T00:00:00.000Z'
          }
        ]
      }
      // Kimi parent → ask (no Kimi grant; provider-scoped).
      expect(
        service.resolvePermission(
          'kimi',
          'subThreadDelegation',
          '/repo',
          undefined,
          withGeminiGrant
        ).decision
      ).toBe('ask')
    })
  })

  // Posture conformance across the REAL resolver → gate-settings → decision
  // chain (no mocks): the contract behind "honor Workspace Write without a
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

    it('publication follows the requested posture split', () => {
      expect(decisionFor('read_only', 'externalPublish')).toBe('ask')
      expect(decisionFor('plan', 'externalPublish')).toBe('ask')
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
