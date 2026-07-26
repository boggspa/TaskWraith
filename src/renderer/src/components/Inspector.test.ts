import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildDelegationTree } from '../lib/DelegationTree'
import type { ChatRecord, ProviderCapabilityContract, ProviderId } from '../../../main/store/types'
import { LIVE_SELECTABLE_PROVIDER_IDS } from '../../../shared/retiredProviders'
import { Inspector, inferProviderFromRawLogContent } from './Inspector'

function makeChat(overrides: Partial<ChatRecord> & Pick<ChatRecord, 'appChatId'>): ChatRecord {
  const { appChatId, ...rest } = overrides
  return {
    appChatId,
    scope: 'workspace',
    provider: 'gemini',
    title: `Chat ${appChatId}`,
    workspaceId: 'ws',
    workspacePath: '/repo',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    messages: [],
    runs: [],
    ...rest
  }
}

function makeCapabilityContract(provider: ProviderId): ProviderCapabilityContract {
  const labels: Record<ProviderId, string> = {
    gemini: 'Gemini',
    codex: 'Codex',
    claude: 'Claude',
    kimi: 'Kimi',
    grok: 'Grok',
    cursor: 'Cursor',
    ollama: 'Ollama',
    antigravity: 'Antigravity',
    pi: 'Pi',
    mistral: 'Mistral',
  }
  const label = labels[provider]
  const tool = (id: keyof ProviderCapabilityContract['tools'], toolLabel: string) => ({
    id,
    label: toolLabel,
    state: 'available' as const,
    source: 'taskwraith' as const,
    enforcedByTaskWraith: true,
    enforcement: 'taskwraith' as const,
    requiresApproval: true,
    tools: [],
    details: `${toolLabel} available`
  })
  return {
    provider,
    label,
    refreshedAt: new Date(0).toISOString(),
    workspacePath: '/repo',
    availability: { available: true, version: '1.0.0' },
    tools: {
      shellCommands: tool('shellCommands', 'Shell'),
      fileChanges: tool('fileChanges', 'Files'),
      externalPublish: tool('externalPublish', 'External publishing'),
      mcpTools: tool('mcpTools', 'MCP'),
      creativeApps: tool('creativeApps', 'Creative apps'),
      networkAccess: tool('networkAccess', 'Network'),
      elicit: tool('elicit', 'Ask the user'),
      delegate: tool('delegate', 'Delegate to sub-thread')
    },
    approvals: {
      requestedMode: 'default',
      effectiveMode: 'default',
      providerMode: 'default',
      inAppApprovals: true,
      supportsWorkspaceGrants: true,
      notes: []
    },
    mcp: {
      state: 'available',
      source: 'taskwraith',
      available: true,
      tools: []
    },
    warnings: []
  }
}

function makeEnsembleChat(): ChatRecord {
  return makeChat({
    appChatId: 'ensemble-1',
    provider: 'codex',
    chatKind: 'ensemble',
    title: 'Ensemble New Ensemble',
    ensemble: {
      enabled: true,
      maxParticipants: 6,
      orchestrationMode: 'continuous',
      activeRound: {
        roundId: 'round-1',
        status: 'running',
        prompt: 'Review this',
        startedAt: new Date(0).toISOString(),
        activeParticipantId: 'ensemble-claude',
        orchestrationMode: 'continuous',
        participants: [
          {
            participantId: 'ensemble-codex',
            provider: 'codex',
            role: 'Worker',
            order: 1,
            status: 'answered'
          },
          {
            participantId: 'ensemble-claude',
            provider: 'claude',
            role: 'Reviewer',
            order: 2,
            status: 'running'
          }
        ]
      },
      participants: [
        {
          id: 'ensemble-codex',
          provider: 'codex',
          enabled: true,
          role: 'Worker',
          instructions: 'Make the change.',
          order: 1,
          model: 'gpt-5.5',
          permissionPresetId: 'workspace_write',
          tokenTotals: { input_tokens: 3200, output_tokens: 1100, total_tokens: 4300 }
        },
        {
          id: 'ensemble-claude',
          provider: 'claude',
          enabled: true,
          role: 'Reviewer',
          instructions: 'Review the change.',
          order: 2,
          model: 'opus-4.7',
          permissionPresetId: 'read_only'
        }
      ]
    }
  })
}

function renderInspector(overrides: Partial<Parameters<typeof Inspector>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(Inspector, {
      rightTab: 'capabilities',
      activeDiff: null,
      refreshDiff: () => {},
      currentWorkspace: { id: 'ws', path: '/repo' },
      diffView: 'this_run',
      setDiffView: () => {},
      runDiff: null,
      diffRefreshStatus: '',
      rawLogs: [],
      rawFilter: 'all',
      setRawFilter: () => {},
      setRawLogs: () => {},
      rawLogsEndRef: { current: null },
      geminiVersion: '',
      isOldVersion: false,
      trustResult: null,
      sessionTrust: false,
      setSessionTrust: () => {},
      showTerminal: false,
      setShowTerminal: () => {},
      workspacePath: '/repo',
      provider: 'codex',
      approvalMode: 'default',
      providerCapabilities: makeCapabilityContract('codex'),
      providerCapabilitiesByProvider: {
        codex: makeCapabilityContract('codex'),
        claude: makeCapabilityContract('claude')
      },
      currentChat: makeEnsembleChat(),
      ...overrides
    })
  )
}

describe('buildDelegationTree', () => {
  it('returns null when no focus chat id is provided', () => {
    const chats = [makeChat({ appChatId: 'root' })]
    expect(buildDelegationTree(chats)).toBeNull()
  })

  it('returns null when focus id does not match any chat', () => {
    const chats = [makeChat({ appChatId: 'root' })]
    expect(buildDelegationTree(chats, 'missing')).toBeNull()
  })

  it('walks up to the root and nests descendants in createdAt order', () => {
    const chats: ChatRecord[] = [
      makeChat({ appChatId: 'root', createdAt: 1 }),
      makeChat({ appChatId: 'sub-a', parentChatId: 'root', createdAt: 3, provider: 'kimi' }),
      makeChat({ appChatId: 'sub-b', parentChatId: 'root', createdAt: 2, provider: 'codex' }),
      makeChat({ appChatId: 'leaf', parentChatId: 'sub-a', createdAt: 4, provider: 'claude' })
    ]

    const tree = buildDelegationTree(chats, 'leaf')
    expect(tree?.chat.appChatId).toBe('root')
    expect(tree?.children.map((c) => c.chat.appChatId)).toEqual(['sub-b', 'sub-a'])
    const subA = tree?.children.find((c) => c.chat.appChatId === 'sub-a')
    expect(subA?.children).toHaveLength(1)
    expect(subA?.children[0].chat.appChatId).toBe('leaf')
    expect(subA?.children[0].isCurrent).toBe(true)
  })

  it('handles a chat that is its own root with no children', () => {
    const chats = [makeChat({ appChatId: 'solo' })]
    const tree = buildDelegationTree(chats, 'solo')
    expect(tree?.chat.appChatId).toBe('solo')
    expect(tree?.children).toEqual([])
    expect(tree?.isCurrent).toBe(true)
  })
})

describe('Inspector capabilities', () => {
  it('renders the selected surface without the redundant destination header', () => {
    const html = renderInspector({ rightTab: 'raw' })

    expect(html).not.toContain('class="inspector-tabs"')
    expect(html).not.toContain('class="inspector-tab')
    expect(html).toContain('class="inspector-body"')
  })

  it('uses shared segmented controls for mutually exclusive inspector views and filters', () => {
    const diffHtml = renderInspector({ rightTab: 'diff', runDiff: [] })
    expect(diffHtml).toContain('aria-label="Diff view"')
    expect(diffHtml).toContain('role="radiogroup"')
    expect(diffHtml).toContain('aria-checked="true"')
    expect(diffHtml).toContain('segmented-control--compact')

    const rawHtml = renderInspector({ rightTab: 'raw' })
    expect(rawHtml).toContain('aria-label="Raw event filter"')
    expect(rawHtml).toContain('data-segmented-control-value="all"')
    expect(rawHtml).toContain('data-segmented-control-value="stdout"')
    expect(rawHtml).toContain('data-segmented-control-value="stderr"')
    expect(rawHtml).toContain('data-segmented-control-value="tool"')
  })

  it('renders an Ensemble-wide capability summary instead of the Codex-only panel', () => {
    const html = renderInspector()

    expect(html).toContain('Ensemble capabilities')
    expect(html).toContain('Multi-provider view')
    expect(html).toContain('Worker')
    expect(html).toContain('Reviewer')
    expect(html).toContain('Codex, Claude')
    expect(html).toContain('Continuous')
    expect(html).not.toContain('<h4>Codex capabilities</h4>')
  })

  it('renders Ensemble context in Raw Events, Delegation, and Safety tabs', () => {
    const rawLogs = [
      {
        type: 'tool' as const,
        content: JSON.stringify({
          provider: 'claude',
          name: 'task',
          params: {
            payload: {
              agentName: 'Review helper',
              summary: 'Checked the patch'
            }
          }
        }),
        sequence: 1
      },
      { type: 'stdout' as const, content: 'stream line', sequence: 2 }
    ]

    const rawHtml = renderInspector({ rightTab: 'raw', rawLogs })
    expect(rawHtml).toContain('Ensemble raw event stream')
    expect(rawHtml).toContain('Worker / Codex')
    expect(rawHtml).toContain('Reviewer / Claude')

    const delegationHtml = renderInspector({ rightTab: 'delegation', rawLogs })
    expect(delegationHtml).toContain('Ensemble agent invocation audit')
    expect(delegationHtml).toContain('Ensemble agent invocation model')
    expect(delegationHtml).toContain('Review helper')
    expect(delegationHtml).not.toContain('Codex agent invocation model')

    const safetyHtml = renderInspector({ rightTab: 'safety' })
    expect(safetyHtml).toContain('Ensemble safety')
    expect(safetyHtml).toContain('Speaker lock')
    expect(safetyHtml).toContain('Provider setup')
    expect(safetyHtml).toContain('Read-Only/Recon')
    expect(safetyHtml).not.toContain('Codex safety')
  })

  it('renders an honest generic capabilities panel for cursor, not the Gemini panel', () => {
    const html = renderInspector({
      provider: 'cursor',
      currentChat: makeChat({ appChatId: 'solo-cursor', provider: 'cursor' }),
      providerCapabilities: makeCapabilityContract('cursor'),
      codexStatus: {
        binaryPath: '/usr/local/bin/cursor-agent',
        version: '2025.07.1',
        authState: 'authenticated',
        transportSupported: true
      },
      codexModels: []
    })

    expect(html).toContain('Cursor capabilities')
    expect(html).toContain('cursor-cli')
    expect(html).toContain('OS-level sandbox')
    expect(html).toContain('admitted')
    expect(html).not.toContain('Gemini capability state')
    expect(html).not.toContain('Install / repair')
    expect(html).not.toContain('Gemini config')
  })

  it('renders generic capabilities panels for grok and ollama', () => {
    const cases: Array<{ provider: ProviderId; label: string }> = [
      { provider: 'grok', label: 'Grok' },
      { provider: 'ollama', label: 'Ollama' }
    ]
    for (const { provider, label } of cases) {
      const html = renderInspector({
        provider,
        currentChat: makeChat({ appChatId: `solo-${provider}`, provider }),
        providerCapabilities: makeCapabilityContract(provider)
      })

      expect(html).toContain(`${label} capabilities`)
      expect(html).toContain(`${label} tooling contract`)
      expect(html).not.toContain('Gemini capability state')
      expect(html).not.toContain('Install / repair')
    }
  })

  it('describes Kimi structural admission without making reviewed tuples an availability gate', () => {
    const overrides = {
      provider: 'kimi' as const,
      currentChat: makeChat({ appChatId: 'solo-kimi', provider: 'kimi' }),
      providerCapabilities: makeCapabilityContract('kimi'),
      codexStatus: {
        available: true,
        binaryPath: '/usr/local/bin/kimi',
        version: '1.2.3',
        authState: 'oauth',
        transportSupported: true
      }
    }
    const capabilitiesHtml = renderInspector(overrides)
    const safetyHtml = renderInspector({ ...overrides, rightTab: 'safety' })

    for (const html of [capabilitiesHtml, safetyHtml]) {
      expect(html).toContain('Structural ACP admission is always enabled')
      expect(html.toLowerCase()).toContain('credentials')
      expect(html).toContain('unattested-development')
      expect(html).not.toContain('reviewed tuple')
    }
  })

  it('keeps the Gemini panel for historical gemini chats', () => {
    const html = renderInspector({
      provider: 'gemini',
      currentChat: makeChat({ appChatId: 'solo-gemini', provider: 'gemini' }),
      providerCapabilities: makeCapabilityContract('gemini')
    })

    expect(html).toContain('Gemini capability state')
    expect(html).toContain('TaskWraith MCP bridge')
  })
})

describe('inferProviderFromRawLogContent', () => {
  it('recognizes every live and retired provider id in JSON and text forms', () => {
    for (const provider of [...LIVE_SELECTABLE_PROVIDER_IDS, 'gemini']) {
      expect(inferProviderFromRawLogContent(JSON.stringify({ provider }))).toBe(provider)
      expect(inferProviderFromRawLogContent(`targetProvider: '${provider}'`)).toBe(provider)
    }
  })

  it('returns null for unknown provider tokens', () => {
    expect(inferProviderFromRawLogContent(JSON.stringify({ provider: 'skynet' }))).toBeNull()
    expect(inferProviderFromRawLogContent('provider: skynet')).toBeNull()
    expect(inferProviderFromRawLogContent('no provider here')).toBeNull()
  })
})
