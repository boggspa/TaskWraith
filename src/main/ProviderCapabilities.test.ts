import { describe, expect, it } from 'vitest'
import { GATEWAY_MCP_ADVERTISE_TOOLS } from './mcp/McpToolProfiles'
import { buildProviderCapabilityContract } from './ProviderCapabilities'
import type { AgenticServicesSettings, AppSettings } from './store/types'

const defaultServices: AgenticServicesSettings = {
  shellCommands: 'workspace',
  fileChanges: 'ask',
  mcpTools: 'ask',
  subThreadDelegation: 'ask',
  canvasInteraction: 'ask',
  canvasEval: 'ask',
  networkAccess: 'allow'
}

function settings(
  agenticServices: AgenticServicesSettings = defaultServices,
  extra: Partial<AppSettings> = {}
): Pick<
  AppSettings,
  'agenticServices' | 'geminiMcpBridgeEnabled' | 'codexSandboxFallback' | 'userMcpServers'
> {
  return {
    agenticServices,
    geminiMcpBridgeEnabled: false,
    codexSandboxFallback: 'ask_rerun' as const,
    ...extra
  }
}

describe('ProviderCapabilities', () => {
  it('describes AntiGravity as the sandboxed official CLI without claiming a tool bridge', () => {
    const contract = buildProviderCapabilityContract({
      provider: 'antigravity',
      settings: settings(),
      approvalMode: 'default',
      status: { provider: 'antigravity', available: true, binaryPath: '/usr/local/bin/agy' }
    })

    expect(contract.approvals.providerMode).toContain('--sandbox --mode plan')
    expect(contract.approvals.inAppApprovals).toBe(false)
    expect(contract.approvals.notes.join(' ')).toContain('no credential access')
    expect(contract.approvals.notes.join(' ')).toContain('isolated worktrees')
    expect(contract.mcp.state).toBe('unavailable')
    expect(contract.tools.mcpTools.state).toBe('unavailable')
    expect(contract.tools.delegate.state).toBe('unavailable')
  })

  // Pi had no branch at all, so it inherited the default whose note describes
  // Claude Code's permission handling — a different provider entirely.
  describe('Pi', () => {
    const piContract = (approvalMode: string) =>
      buildProviderCapabilityContract({
        provider: 'pi',
        settings: settings(),
        approvalMode,
        status: { provider: 'pi', available: true }
      })

    it('describes its own tool allowlist, not Claude', () => {
      const contract = piContract('default')
      expect(contract.approvals.notes.join(' ')).toContain('native read tools only')
      expect(contract.approvals.notes.join(' ')).not.toContain('Claude')
      expect(contract.approvals.providerMode).toContain('brokered exact file tools')
      expect(contract.approvals.inAppApprovals).toBe(true)
      expect(
        contract.warnings.find((warning) => warning.id === 'pi-native-tools-downgraded')
      ).toBeUndefined()
    })

    it('signposts the verified Ensemble-only coordination surface without claiming a generic MCP bridge', () => {
      const contract = piContract('default')

      expect(contract.mcp.source).toBe('taskwraith')
      expect(contract.mcp.serverName).toBe('TaskWraith Pi managed tools')
      expect(contract.mcp.message).toContain('no manual Pi/MCP installation')
      expect(contract.mcp.tools).toEqual(
        expect.arrayContaining(['ensemble_yield', 'ensemble_send', 'blackboard_post'])
      )
      expect(contract.tools.mcpTools.source).toBe('taskwraith')
      expect(contract.tools.mcpTools.details).toContain('readiness receipt')
      expect(contract.tools.elicit.state).toBe('unavailable')
      expect(contract.tools.delegate.state).toBe('unavailable')
      expect(contract.tools.creativeApps.state).toBe('unavailable')
    })

    it('removes coordination but retains exact file tools when Tool calls are denied', () => {
      const contract = buildProviderCapabilityContract({
        provider: 'pi',
        settings: settings({ ...defaultServices, mcpTools: 'deny' }),
        approvalMode: 'default',
        status: { provider: 'pi', available: true }
      })

      expect(contract.mcp.state).toBe('available')
      expect(contract.mcp.available).toBe(true)
      expect(contract.mcp.tools).toEqual(['write_file', 'replace', 'apply_patch'])
      expect(contract.tools.mcpTools.state).toBe('unavailable')
    })

    // Pi's exact-default baseline is stricter than the house convention (any
    // mode except 'plan'); the signed posture can only narrow it further. If
    // the runtime is ever intentionally widened, this test must change with it
    // — the contract must not claim a tool set the launch does not use.
    it.each(['plan', 'acceptEdits', 'auto_edit'])(
      'reports the read-only allowlist for %s',
      (approvalMode) => {
        const approvals = piContract(approvalMode).approvals
        expect(approvals.effectiveMode).toBe('plan')
        expect(approvals.providerMode).toContain('read-only tool allowlist')
        const downgradeWarning = piContract(approvalMode).warnings.find(
          (warning) => warning.id === 'pi-native-tools-downgraded'
        )
        if (approvalMode === 'plan') expect(downgradeWarning).toBeUndefined()
        else expect(downgradeWarning).toMatchObject({ severity: 'warning' })
      }
    )

    it.each([
      [
        'read-only',
        {
          readOnly: true,
          agenticServices: { shellCommands: 'allow' as const, fileChanges: 'allow' as const }
        }
      ],
      [
        'file-change deny',
        {
          readOnly: false,
          agenticServices: { shellCommands: 'allow' as const, fileChanges: 'deny' as const }
        }
      ]
    ])(
      'reports default mode as read-only for a signed %s posture',
      (_label, effectivePermissions) => {
        const contract = buildProviderCapabilityContract({
          provider: 'pi',
          settings: settings(),
          approvalMode: 'default',
          effectivePermissions,
          status: { provider: 'pi', available: true }
        })

        expect(contract.approvals.requestedMode).toBe('default')
        expect(contract.approvals.effectiveMode).toBe('plan')
        expect(contract.approvals.providerMode).toContain('read-only tool allowlist')
        expect(
          contract.warnings.find((warning) => warning.id === 'pi-native-tools-downgraded')
        ).toMatchObject({ severity: 'warning' })
      }
    )

    it.each([['file changes', { ...defaultServices, fileChanges: 'deny' as const }]])(
      'uses current service settings to downgrade capability reporting for %s',
      (_label, services) => {
        const contract = buildProviderCapabilityContract({
          provider: 'pi',
          settings: settings(services),
          approvalMode: 'default',
          status: { provider: 'pi', available: true }
        })

        expect(contract.approvals.effectiveMode).toBe('plan')
        expect(contract.approvals.providerMode).toContain('read-only tool allowlist')
        expect(
          contract.warnings.find((warning) => warning.id === 'pi-native-tools-downgraded')
        ).toMatchObject({ severity: 'warning' })
      }
    )

    it('keeps brokered file edits when only native shell commands are denied', () => {
      const contract = buildProviderCapabilityContract({
        provider: 'pi',
        settings: settings({ ...defaultServices, shellCommands: 'deny' }),
        approvalMode: 'default',
        status: { provider: 'pi', available: true }
      })

      expect(contract.approvals.effectiveMode).toBe('default')
      expect(contract.approvals.providerMode).toContain('brokered exact file tools')
      expect(contract.tools.shellCommands.state).toBe('unavailable')
      expect(contract.tools.fileChanges.tools).toEqual(['write_file', 'replace', 'apply_patch'])
    })
  })

  // agy has no per-tool approval bridge, so a denied shell/file service can only
  // be honoured by launching read-only. This clamp existed for gemini but not
  // antigravity, so the contract reported accept-edits as enforced while the run
  // ignored the setting. prepareAntigravityProviderLaunch shares the predicate.
  it.each([
    ['shell commands', { ...defaultServices, shellCommands: 'deny' as const }],
    ['file changes', { ...defaultServices, fileChanges: 'deny' as const }]
  ])('clamps AntiGravity to plan mode when %s is denied', (_label, services) => {
    const contract = buildProviderCapabilityContract({
      provider: 'antigravity',
      settings: settings(services),
      approvalMode: 'default',
      status: { provider: 'antigravity', available: true, binaryPath: '/usr/local/bin/agy' }
    })

    expect(contract.approvals.effectiveMode).toBe('plan')
    expect(contract.approvals.providerMode).toContain('--sandbox --mode plan')
    expect(contract.approvals.providerMode).not.toContain('accept-edits')
  })

  // The provenance mapping is explicit because this builder drops unknown status
  // fields: without it the publisher check would be computed and discarded, and
  // the mismatch warning would never reach a user.
  it('forwards binary provenance and warns on a publisher mismatch', () => {
    const contract = buildProviderCapabilityContract({
      provider: 'antigravity',
      settings: settings(),
      approvalMode: 'default',
      status: {
        provider: 'antigravity',
        available: true,
        binaryPath: '/usr/local/bin/agy',
        binaryProvenance: 'mismatch',
        binaryTeamId: 'ABCDE12345',
        binaryProvenanceDetail: 'The resolved agy executable is signed by team ABCDE12345, not Google (EQHXZ8M8AV).'
      }
    })

    expect(contract.availability.binaryProvenance).toBe('mismatch')
    expect(contract.availability.binaryTeamId).toBe('ABCDE12345')
    const publisherWarning = contract.warnings.find((entry) =>
      entry.id.endsWith('binary-unverified-publisher')
    )
    expect(publisherWarning?.severity).toBe('warning')
    expect(publisherWarning?.message).toContain('ABCDE12345')
  })

  // Not-checkable is not evidence against the binary: every Linux and Windows
  // install reports 'unverified', which must stay silent.
  it.each(['verified', 'unverified'])('raises no publisher warning for %s', (state) => {
    const contract = buildProviderCapabilityContract({
      provider: 'antigravity',
      settings: settings(),
      approvalMode: 'default',
      status: {
        provider: 'antigravity',
        available: true,
        binaryPath: '/usr/local/bin/agy',
        binaryProvenance: state
      }
    })

    expect(
      contract.warnings.some((entry) => entry.id.endsWith('binary-unverified-publisher'))
    ).toBe(false)
  })

  it('does not advertise TaskWraith MCP tools when the bridge is disabled', () => {
    const contract = buildProviderCapabilityContract({
      provider: 'gemini',
      settings: settings(),
      status: { provider: 'gemini', available: true, version: '1.0.0' },
      geminiMcpBridgeStatus: {
        checkedAt: '2026-05-06T00:00:00.000Z',
        enabled: false,
        installed: false,
        available: false,
        serverName: 'TaskWraith',
        message: 'Bridge disabled'
      }
    })

    expect(contract.tools.shellCommands.state).toBe('unavailable')
    expect(contract.tools.fileChanges.tools).toEqual([])
    expect(contract.mcp.tools).toEqual([])
    expect(contract.warnings.map((warning) => warning.id)).toContain('gemini-bridge-disabled')
    // elicit/delegate are unavailable until the bridge is up.
    expect(contract.tools.elicit.state).toBe('unavailable')
    expect(contract.tools.delegate.state).toBe('unavailable')
    expect(contract.tools.elicit.tools).toEqual([])
    expect(contract.tools.delegate.tools).toEqual([])
  })

  it('advertises Gemini bridge tools with TaskWraith approval gates when available', () => {
    const contract = buildProviderCapabilityContract({
      provider: 'gemini',
      settings: settings(),
      status: { provider: 'gemini', available: true, version: '1.0.0' },
      geminiMcpBridgeStatus: {
        checkedAt: '2026-05-06T00:00:00.000Z',
        enabled: true,
        installed: true,
        available: true,
        serverName: 'TaskWraith'
      }
    })

    expect(contract.tools.shellCommands.state).toBe('gated')
    expect(contract.tools.shellCommands.tools).toEqual(['run_shell_command', 'get_diagnostics'])
    expect(contract.tools.fileChanges.tools).toEqual(['write_file', 'replace'])
    expect(contract.tools.creativeApps.tools).toEqual([
      'creative_app_status',
      'creative_app_capabilities',
      'creative_project_snapshot',
      'creative_timeline_validate',
      'creative_timeline_ir',
      'creative_timeline_diff'
    ])
    expect(contract.mcp.tools).toContain('list_directory')
    expect(contract.approvals.inAppApprovals).toBe(true)
    // ask_user_question is auto-allowed once the bridge is up; delegate
    // inherits the subThreadDelegation policy ('ask' -> gated).
    expect(contract.tools.elicit.state).toBe('available')
    expect(contract.tools.elicit.requiresApproval).toBe(false)
    expect(contract.tools.elicit.tools).toEqual(['ask_user_question'])
    expect(contract.tools.delegate.state).toBe('gated')
    expect(contract.tools.delegate.tools).toEqual(['delegate_to_subthread'])
    expect(contract.tools.delegate.policy).toBe('ask')
  })

  it('honors blocked settings in the Codex tooling contract', () => {
    const contract = buildProviderCapabilityContract({
      provider: 'codex',
      settings: {
        ...settings({
          ...defaultServices,
          shellCommands: 'deny',
          networkAccess: 'deny'
        }),
        geminiMcpBridgeEnabled: true
      },
      status: { provider: 'codex', available: true, version: '1.0.0', appServer: 'started' },
      mcpStatus: { data: [{ name: 'local', tools: { search: {}, read: {} } }] }
    })

    expect(contract.tools.shellCommands.state).toBe('blocked')
    expect(contract.tools.networkAccess.state).toBe('blocked')
    expect(contract.mcp.tools).toEqual(['read', 'search'])
    expect(contract.warnings.map((warning) => warning.id)).toContain('codex-shellCommands-blocked')
    // Codex routes the TaskWraith elicitation/delegation tools regardless of the
    // codex-native MCP server count; delegate tracks subThreadDelegation ('ask').
    expect(contract.tools.elicit.state).toBe('available')
    expect(contract.tools.elicit.enforcedByTaskWraith).toBe(true)
    expect(contract.tools.delegate.state).toBe('gated')
    expect(contract.tools.delegate.enforcedByTaskWraith).toBe(true)
  })

  it('keeps a provider runnable when optional metadata has an error', () => {
    const contract = buildProviderCapabilityContract({
      provider: 'codex',
      settings: { ...settings(), geminiMcpBridgeEnabled: true },
      status: {
        provider: 'codex',
        version: '1.0.0',
        appServer: 'started',
        error: 'Rate-limit metadata failed'
      }
    })

    expect(contract.availability.available).toBe(true)
    expect(contract.availability.error).toBe('Rate-limit metadata failed')
    expect(contract.warnings.map((warning) => warning.id)).not.toContain('codex-unavailable')
  })

  it('treats Codex MCP as available when TaskWraith registration is enabled but live listing is absent', () => {
    const contract = buildProviderCapabilityContract({
      provider: 'codex',
      settings: { ...settings(), geminiMcpBridgeEnabled: true },
      status: { provider: 'codex', available: true, version: '1.0.0', appServer: 'started' },
      mcpStatus: { data: [] }
    })

    expect(contract.mcp.state).toBe('available')
    expect(contract.mcp.serverName).toBe('TaskWraith')
    expect(contract.mcp.tools).toContain('write_file')
    expect(contract.mcp.message).toContain('did not expose a live server listing')
  })

  it('reports Codex user-managed MCP servers even when the TaskWraith bridge is disabled', () => {
    const contract = buildProviderCapabilityContract({
      provider: 'codex',
      settings: settings(defaultServices, {
        userMcpServers: [
          {
            id: 'docs',
            name: 'Docs',
            enabled: true,
            transport: 'http',
            url: 'https://example.test/mcp'
          }
        ]
      }),
      status: { provider: 'codex', available: true, version: '1.0.0', appServer: 'started' },
      mcpStatus: { data: [] }
    })

    expect(contract.mcp.state).toBe('available')
    expect(contract.mcp.serverName).toBe('User MCP servers')
    expect(contract.mcp.tools).toEqual([])
    expect(contract.mcp.message).toContain('1 user-managed MCP server')
    expect(contract.mcp.message).toContain('TaskWraith MCP bridge is disabled')
  })

  it('keeps Claude tools delegated and Kimi native tools unavailable without its gateway', () => {
    const claude = buildProviderCapabilityContract({
      provider: 'claude',
      settings: settings(),
      status: { provider: 'claude', available: true, version: '1.0.0' }
    })
    const kimi = buildProviderCapabilityContract({
      provider: 'kimi',
      settings: settings(),
      status: { provider: 'kimi', available: true, version: '1.0.0' }
    })

    expect(claude.tools.shellCommands.state).toBe('delegated')
    expect(claude.approvals.inAppApprovals).toBe(false)
    expect(kimi.tools.fileChanges.state).toBe('unavailable')
    expect(kimi.tools.fileChanges.source).toBe('bridge')
    expect(kimi.approvals.inAppApprovals).toBe(true)
    expect(kimi.approvals.supportsWorkspaceGrants).toBe(true)
    // Without an available TaskWraith MCP bridge (no mcpStatus), Claude/Kimi
    // elicit/delegate are unavailable rather than delegated, mirroring how
    // their bridge-backed tooling falls closed.
    expect(claude.tools.elicit.state).toBe('unavailable')
    expect(claude.tools.delegate.state).toBe('unavailable')
    expect(kimi.tools.elicit.state).toBe('unavailable')
    expect(kimi.tools.delegate.state).toBe('unavailable')
  })

  it('marks Claude/Kimi gateway tooling available once the TaskWraith MCP bridge is up', () => {
    const claude = buildProviderCapabilityContract({
      provider: 'claude',
      settings: settings(),
      status: { provider: 'claude', available: true, version: '1.0.0' },
      mcpStatus: {
        enabled: true,
        available: true,
        serverName: 'TaskWraith',
        tools: ['ask_user_question', 'delegate_to_subthread']
      }
    })
    const kimi = buildProviderCapabilityContract({
      provider: 'kimi',
      settings: settings(),
      status: { provider: 'kimi', available: true, version: 'reviewed-runtime' },
      mcpStatus: {
        enabled: true,
        available: true,
        serverName: 'TaskWraith',
        tools: [...GATEWAY_MCP_ADVERTISE_TOOLS]
      }
    })

    expect(claude.tools.elicit.state).toBe('available')
    expect(claude.tools.elicit.requiresApproval).toBe(false)
    expect(claude.tools.delegate.state).toBe('gated')
    expect(claude.tools.delegate.policy).toBe('ask')
    expect(kimi.mcp.source).toBe('bridge')
    expect(kimi.tools.shellCommands.source).toBe('bridge')
    expect(kimi.tools.fileChanges.source).toBe('bridge')
    expect(kimi.tools.fileChanges.enforcedByTaskWraith).toBe(true)
    expect(kimi.approvals.providerMode).toContain('ACP governed authenticated')
    expect(kimi.approvals.supportsWorkspaceGrants).toBe(true)
  })

  it('does not expose TaskWraith elicit/delegate rows for Claude user MCP servers only', () => {
    const claude = buildProviderCapabilityContract({
      provider: 'claude',
      settings: settings(defaultServices, {
        userMcpServers: [
          {
            id: 'docs',
            name: 'Docs',
            enabled: true,
            transport: 'http',
            url: 'https://example.test/mcp'
          }
        ]
      }),
      status: { provider: 'claude', available: true, version: '1.0.0' },
      mcpStatus: {
        enabled: true,
        available: true,
        source: 'provider',
        serverName: 'User MCP servers',
        tools: [],
        message:
          '1 user-managed MCP server will attach to Claude runs at launch. The built-in TaskWraith MCP bridge is disabled.'
      }
    })

    expect(claude.mcp.state).toBe('available')
    expect(claude.mcp.source).toBe('provider')
    expect(claude.tools.mcpTools.state).toBe('delegated')
    expect(claude.tools.mcpTools.enforcedByTaskWraith).toBe(false)
    expect(claude.tools.elicit.state).toBe('unavailable')
    expect(claude.tools.delegate.state).toBe('unavailable')
  })

  it('treats read-only Grok elicit/delegate as provider-delegated when the bridge is off', () => {
    const contract = buildProviderCapabilityContract({
      provider: 'grok',
      settings: settings(),
      approvalMode: 'plan',
      status: { provider: 'grok', available: true, version: '1.0.0' }
    })

    expect(contract.tools.elicit.state).toBe('delegated')
    expect(contract.tools.elicit.enforcedByTaskWraith).toBe(false)
    expect(contract.tools.delegate.state).toBe('delegated')
    expect(contract.tools.delegate.enforcedByTaskWraith).toBe(false)
  })

  it('reports Cursor as available (always-enabled; containment lives on the run, not a gate)', () => {
    const contract = buildProviderCapabilityContract({
      provider: 'cursor',
      settings: { ...settings(), geminiMcpBridgeEnabled: true },
      approvalMode: 'default',
      status: { provider: 'cursor', available: true, version: '1.0.0' }
    })

    // No per-build fingerprint gate: Cursor is available and its run mode is not
    // forced to 'unavailable'. Containment is the contained --sandbox argv on the
    // run itself (runCursorProvider), not this availability contract.
    expect(contract.availability.available).toBe(true)
    // An available Cursor carries no disabled-state error.
    expect(contract.availability.error).toBeUndefined()
    expect(contract.approvals.effectiveMode).not.toBe('unavailable')
    // Cursor's brokered TaskWraith MCP tools route through the central
    // approval gate, so workspace Tool Grants apply (provider parity).
    expect(contract.approvals.supportsWorkspaceGrants).toBe(true)
  })

  it('marks write-capable Grok as TaskWraith MCP bridge-backed', () => {
    const contract = buildProviderCapabilityContract({
      provider: 'grok',
      settings: { ...settings(), geminiMcpBridgeEnabled: true },
      status: { provider: 'grok', available: true, version: '1.0.0' }
    })

    expect(contract.mcp.state).toBe('available')
    expect(contract.mcp.source).toBe('bridge')
    expect(contract.mcp.tools).toContain('write_file')
    expect(contract.tools.shellCommands.source).toBe('bridge')
    expect(contract.tools.fileChanges.source).toBe('bridge')
    expect(contract.tools.elicit.state).toBe('available')
    expect(contract.tools.delegate.state).toBe('gated')
  })

  it('advertises Ollama with the compact TaskWraith gateway surface in workspace chats', () => {
    const contract = buildProviderCapabilityContract({
      provider: 'ollama',
      settings: settings(),
      workspacePath: '/tmp/project',
      status: { provider: 'ollama', available: true }
    })

    expect(contract.mcp.state).toBe('available')
    expect(contract.mcp.serverName).toBe('TaskWraith-local')
    expect(contract.mcp.tools).toEqual([...GATEWAY_MCP_ADVERTISE_TOOLS])
    expect(contract.tools.mcpTools.state).toBe('gated')
    expect(contract.tools.mcpTools.enforcedByTaskWraith).toBe(true)
    expect(contract.tools.elicit.state).toBe('available')
    expect(contract.tools.elicit.requiresApproval).toBe(false)
    expect(contract.tools.shellCommands.state).toBe('gated')
    expect(contract.tools.fileChanges.state).toBe('gated')
    expect(contract.tools.shellCommands.enforcedByTaskWraith).toBe(true)
    expect(contract.tools.fileChanges.enforcedByTaskWraith).toBe(true)
    expect(contract.approvals.providerMode).toContain('gateway tool surface')
    expect(contract.approvals.notes.join(' ')).toContain('run permission role')
  })

  it('keeps Ollama file and shell capability governed by standard service policy', () => {
    const blocked = buildProviderCapabilityContract({
      provider: 'ollama',
      settings: settings({
        ...defaultServices,
        fileChanges: 'deny',
        shellCommands: 'deny'
      }),
      workspacePath: '/tmp/project',
      status: { provider: 'ollama', available: true }
    })
    expect(blocked.mcp.tools).toContain('write_file')
    expect(blocked.mcp.tools).toContain('run_shell_command')
    expect(blocked.tools.fileChanges.state).toBe('blocked')
    expect(blocked.tools.shellCommands.state).toBe('blocked')
  })

  it('does not advertise Ollama read-only tools outside a workspace', () => {
    const contract = buildProviderCapabilityContract({
      provider: 'ollama',
      settings: settings(),
      status: { provider: 'ollama', available: true }
    })

    expect(contract.mcp.state).toBe('unavailable')
    expect(contract.tools.mcpTools.state).toBe('unavailable')
    expect(contract.mcp.message).toContain('workspace thread')
  })

  it('reflects a denied subThreadDelegation policy as a blocked delegate row', () => {
    const codex = buildProviderCapabilityContract({
      provider: 'codex',
      settings: {
        ...settings({ ...defaultServices, subThreadDelegation: 'deny' }),
        geminiMcpBridgeEnabled: true
      },
      status: { provider: 'codex', available: true, version: '1.0.0', appServer: 'started' }
    })

    expect(codex.tools.delegate.state).toBe('blocked')
    expect(codex.tools.delegate.policy).toBe('deny')
    // elicit is unaffected by the delegation policy.
    expect(codex.tools.elicit.state).toBe('available')
  })

  it('does not double-count the elicit/delegate rows against the enforcement tally', () => {
    // Roster where delegation was already enforced (subThreadDelegation 'allow').
    // The five functional controls drive the enforced count; promoting
    // elicit/delegate to rows must NOT change that 5-row tally.
    const codex = buildProviderCapabilityContract({
      provider: 'codex',
      settings: {
        ...settings({ ...defaultServices, subThreadDelegation: 'allow' }),
        geminiMcpBridgeEnabled: true
      },
      status: { provider: 'codex', available: true, version: '1.0.0', appServer: 'started' }
    })

    const controlIds = [
      'shellCommands',
      'fileChanges',
      'mcpTools',
      'creativeApps',
      'networkAccess'
    ] as const
    const controlRows = controlIds.map((id) => codex.tools[id])
    const enforcedControls = controlRows.filter((tool) => tool.enforcedByTaskWraith).length

    // Codex: shell+file+creative are TaskWraith-enforced, mcpTools(provider) and
    // networkAccess(allow/none) are not -> 3/5, unchanged by the new rows.
    expect(controlRows.length).toBe(5)
    expect(enforcedControls).toBe(3)
    // delegate is allowed/enforced as a DISPLAY row but lives outside the tally.
    expect(codex.tools.delegate.state).toBe('available')
    expect(codex.tools.delegate.enforcedByTaskWraith).toBe(true)
    expect(controlIds).not.toContain('delegate')
    expect(controlIds).not.toContain('elicit')
  })
})
