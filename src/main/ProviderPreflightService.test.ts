import { describe, expect, it } from 'vitest'
import { ProviderPreflightService } from './ProviderPreflightService'
import { defaultProviderDescriptor } from './ProviderAdapters'
import type { ProviderCapabilityContract } from './store/types'

function contract(partial: Partial<ProviderCapabilityContract> = {}): ProviderCapabilityContract {
  return {
    provider: 'codex',
    label: 'Codex',
    refreshedAt: '2026-05-08T00:00:00.000Z',
    availability: { available: true },
    tools: {
      shellCommands: {
        id: 'shellCommands',
        label: 'Shell commands',
        state: 'available',
        source: 'taskwraith',
        enforcedByTaskWraith: true,
        enforcement: 'taskwraith',
        requiresApproval: true,
        tools: ['run_shell_command']
      },
      fileChanges: {
        id: 'fileChanges',
        label: 'File changes',
        state: 'available',
        source: 'taskwraith',
        enforcedByTaskWraith: true,
        enforcement: 'taskwraith',
        requiresApproval: true,
        tools: ['edit_file']
      },
      externalPublish: {
        id: 'externalPublish',
        label: 'External publishing',
        state: 'gated',
        source: 'taskwraith',
        enforcedByTaskWraith: true,
        enforcement: 'taskwraith',
        requiresApproval: true,
        tools: ['git_push', 'git_create_pr']
      },
      mcpTools: {
        id: 'mcpTools',
        label: 'MCP and tool calls',
        state: 'available',
        source: 'provider',
        enforcedByTaskWraith: false,
        enforcement: 'provider',
        requiresApproval: true,
        tools: []
      },
      creativeApps: {
        id: 'creativeApps',
        label: 'Creative app tools',
        state: 'available',
        source: 'bridge',
        enforcedByTaskWraith: true,
        enforcement: 'bridge',
        requiresApproval: true,
        tools: [
          'creative_app_status',
          'creative_app_capabilities',
          'creative_project_snapshot',
          'creative_timeline_validate',
          'creative_timeline_ir',
          'creative_timeline_diff'
        ]
      },
      networkAccess: {
        id: 'networkAccess',
        label: 'Network access',
        state: 'available',
        source: 'settings',
        enforcedByTaskWraith: false,
        enforcement: 'none',
        requiresApproval: false,
        tools: []
      },
      elicit: {
        id: 'elicit',
        label: 'Ask the user',
        state: 'available',
        source: 'taskwraith',
        enforcedByTaskWraith: true,
        enforcement: 'taskwraith',
        requiresApproval: false,
        tools: ['ask_user_question']
      },
      delegate: {
        id: 'delegate',
        label: 'Delegate to sub-thread',
        state: 'gated',
        source: 'taskwraith',
        enforcedByTaskWraith: true,
        enforcement: 'taskwraith',
        requiresApproval: true,
        tools: ['delegate_to_subthread']
      }
    },
    approvals: {
      requestedMode: 'default',
      effectiveMode: 'default',
      providerMode: 'default',
      inAppApprovals: true,
      supportsWorkspaceGrants: true,
      notes: []
    },
    mcp: { state: 'available', source: 'provider', available: true, tools: [] },
    warnings: [],
    ...partial
  }
}

describe('ProviderPreflightService', () => {
  const service = new ProviderPreflightService()

  it('marks available providers ready and reports delegated enforcement chips', () => {
    const result = service.evaluate(
      { provider: 'codex', workspacePath: '/repo' },
      contract(),
      defaultProviderDescriptor('codex')
    )

    expect(result.state).toBe('ready')
    expect(result.repairAction).toBe('none')
    expect(result.chips[0].id).toBe('codex-delegated-enforcement')
  })

  it('blocks unavailable providers with a setup repair action', () => {
    const result = service.evaluate(
      { provider: 'claude', workspacePath: '/repo' },
      contract({
        provider: 'claude',
        label: 'Claude',
        availability: { available: false, authState: 'missing', error: 'Claude login required.' }
      }),
      defaultProviderDescriptor('claude')
    )

    expect(result.state).toBe('blocked')
    expect(result.repairAction).toBe('login_provider')
    expect(result.reason).toContain('Claude login required')
  })

  it('blocks non-runnable preview placeholder models before provider launch', () => {
    const result = service.evaluate(
      {
        provider: 'codex',
        workspacePath: '/repo',
        model: 'preview:openai:gpt-5.6:sol'
      },
      contract(),
      defaultProviderDescriptor('codex')
    )

    expect(result.state).toBe('blocked')
    expect(result.reason).toBe('Requires OpenAI preview access')
    expect(result.fallbackAvailable).toBe(false)
    expect(result.chips[0]).toMatchObject({
      id: 'codex-preview-model-access',
      title: 'Preview model unavailable'
    })
  })

  it('blocks stale Claude preview placeholders before provider launch', () => {
    for (const model of ['preview:anthropic:claude-fable-5', 'preview:anthropic:claude-mythos-5']) {
      const result = service.evaluate(
        {
          provider: 'claude',
          workspacePath: '/repo',
          model
        },
        contract({ provider: 'claude', label: 'Claude' }),
        defaultProviderDescriptor('claude')
      )

      expect(result.state).toBe('blocked')
      expect(result.reason).toBe('Requires Claude preview access')
    }
  })

  it('does not block returned Claude 5 model ids', () => {
    for (const model of ['claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5']) {
      const result = service.evaluate(
        {
          provider: 'claude',
          workspacePath: '/repo',
          model
        },
        contract({ provider: 'claude', label: 'Claude' }),
        defaultProviderDescriptor('claude')
      )

      expect(result.state).not.toBe('blocked')
    }
  })

  it('runs GA GPT-5.6 concrete ids with no preview-access gate (5.5 parity)', () => {
    // gpt-5.6-sol/terra/luna are GA now — not preview-risk — so dispatch is ready
    // WITHOUT any previewModelAccessProven flag (unlike a stale preview:… placeholder).
    const result = service.evaluate(
      {
        provider: 'codex',
        workspacePath: '/repo',
        model: 'gpt-5.6-sol'
      },
      contract(),
      defaultProviderDescriptor('codex')
    )

    expect(result.state).toBe('ready')
  })

  it('keeps GPT-5.4 and GPT-5.4 mini runnable without an official sunset', () => {
    for (const model of ['gpt-5.4', 'gpt-5.4-mini']) {
      const result = service.evaluate(
        { provider: 'codex', workspacePath: '/repo', model },
        contract(),
        defaultProviderDescriptor('codex')
      )

      expect(result.state).toBe('ready')
    }
  })

  it('blocks a retired Codex model at the common preflight boundary', () => {
    const result = service.evaluate(
      { provider: 'codex', workspacePath: '/repo', model: 'gpt-5.2' },
      contract(),
      defaultProviderDescriptor('codex')
    )

    expect(result.state).toBe('blocked')
    expect(result.repairAction).toBe('none')
    expect(result.fallbackAvailable).toBe(false)
    expect(result.reason).toContain('retired on 2026-06-02')
    expect(result.chips[0]).toMatchObject({
      id: 'codex-model-retired',
      title: 'Codex model retired'
    })
  })

  it('adds honest Ollama model guidance when a model is selected', () => {
    const result = service.evaluate(
      {
        provider: 'ollama',
        workspacePath: '/repo',
        model: 'qwen3.5:9b',
        ollamaModelInfo: {
          id: 'qwen3.5:9b',
          label: 'Qwen 3.5 (9B Param)',
          parameterSize: '9B',
          capabilities: ['completion', 'tools']
        },
        ollamaInstalledModelIds: ['qwen3.5:9b'],
        totalMemoryBytes: 32 * 1024 ** 3
      },
      contract({
        provider: 'ollama',
        label: 'Ollama'
      }),
      defaultProviderDescriptor('ollama')
    )

    expect(result.state).toBe('ready')
    expect(result.chips.some((chip) => chip.id === 'ollama-model-guidance')).toBe(true)
    expect(result.chips.find((chip) => chip.id === 'ollama-model-guidance')?.message).toContain(
      'scoped tasks'
    )
  })

  it('blocks a retired provider (gemini) before any availability/bridge check', () => {
    // Gemini is retired: preflight short-circuits to a clean "retired" block even
    // when the contract looks bridge-repairable. No repair action is offered
    // because there is nothing for the user to fix.
    const result = service.evaluate(
      { provider: 'gemini', workspacePath: '/repo' },
      contract({
        provider: 'gemini',
        label: 'Gemini',
        mcp: {
          state: 'unavailable',
          source: 'bridge',
          available: false,
          enabled: true,
          installed: false,
          tools: [],
          message: 'TaskWraith MCP bridge not installed.'
        }
      }),
      defaultProviderDescriptor('gemini')
    )

    expect(result.state).toBe('blocked')
    expect(result.repairAction).toBe('none')
    expect(result.reason).toMatch(/unavailable/i)
    expect(result.fallbackAvailable).toBe(false)
  })
})
