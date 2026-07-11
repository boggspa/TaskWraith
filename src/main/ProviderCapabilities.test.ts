import { describe, expect, it } from 'vitest'
import { CURSOR_MCP_SERVER_NAME } from './cursor/CursorMcpBridge'
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

  it('marks Claude and Kimi provider-native tools as delegated', () => {
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
    expect(kimi.tools.fileChanges.state).toBe('delegated')
    expect(kimi.approvals.inAppApprovals).toBe(true)
    expect(kimi.warnings.map((warning) => warning.id)).toContain('kimi-provider-managed-tools')
    // Without an available TaskWraith MCP bridge (no mcpStatus), Claude/Kimi
    // elicit/delegate are unavailable rather than delegated, mirroring how
    // their bridge-backed tooling falls closed.
    expect(claude.tools.elicit.state).toBe('unavailable')
    expect(claude.tools.delegate.state).toBe('unavailable')
    expect(kimi.tools.elicit.state).toBe('unavailable')
    expect(kimi.tools.delegate.state).toBe('unavailable')
  })

  it('marks Claude/Kimi elicit/delegate available once the TaskWraith MCP bridge is up', () => {
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

    expect(claude.tools.elicit.state).toBe('available')
    expect(claude.tools.elicit.requiresApproval).toBe(false)
    expect(claude.tools.delegate.state).toBe('gated')
    expect(claude.tools.delegate.policy).toBe('ask')
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

  it('treats read-only grok/cursor elicit/delegate as provider-delegated when the bridge is off', () => {
    for (const provider of ['cursor', 'grok'] as const) {
      const contract = buildProviderCapabilityContract({
        provider,
        settings: settings(),
        approvalMode: 'plan',
        status: { provider, available: true, version: '1.0.0' }
      })

      expect(contract.tools.elicit.state).toBe('delegated')
      expect(contract.tools.elicit.enforcedByTaskWraith).toBe(false)
      expect(contract.tools.delegate.state).toBe('delegated')
      expect(contract.tools.delegate.enforcedByTaskWraith).toBe(false)
    }
  })

  it('auto-marks Cursor and Grok as TaskWraith MCP bridge-backed for write-capable runs', () => {
    for (const provider of ['cursor', 'grok'] as const) {
      const contract = buildProviderCapabilityContract({
        provider,
        settings: settings(),
        approvalMode: 'default',
        status: { provider, available: true, version: '1.0.0' }
      })

      expect(contract.mcp.state).toBe('available')
      expect(contract.mcp.source).toBe('bridge')
      if (provider === 'cursor') {
        expect(contract.mcp.serverName).toBe(CURSOR_MCP_SERVER_NAME)
      }
      expect(contract.mcp.message).toContain('no manual')
      expect(contract.tools.shellCommands.source).toBe('bridge')
      expect(contract.tools.fileChanges.source).toBe('bridge')
      expect(contract.tools.elicit.state).toBe('available')
      expect(contract.tools.delegate.state).toBe('gated')
    }
  })

  it('marks Cursor and Grok as TaskWraith MCP bridge-backed when the bridge is enabled', () => {
    for (const provider of ['cursor', 'grok'] as const) {
      const contract = buildProviderCapabilityContract({
        provider,
        settings: { ...settings(), geminiMcpBridgeEnabled: true },
        status: { provider, available: true, version: '1.0.0' }
      })

      expect(contract.mcp.state).toBe('available')
      expect(contract.mcp.source).toBe('bridge')
      if (provider === 'cursor') {
        expect(contract.mcp.serverName).toBe(CURSOR_MCP_SERVER_NAME)
      }
      expect(contract.mcp.tools).toContain('write_file')
      expect(contract.tools.shellCommands.source).toBe('bridge')
      expect(contract.tools.shellCommands.enforcedByTaskWraith).toBe(true)
      expect(contract.tools.fileChanges.source).toBe('bridge')
      expect(contract.tools.fileChanges.enforcedByTaskWraith).toBe(true)
      expect(contract.tools.elicit.state).toBe('available')
      expect(contract.tools.delegate.state).toBe('gated')
    }
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
