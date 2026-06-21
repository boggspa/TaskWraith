import { describe, expect, it } from 'vitest'
import { buildRemoteFirstLaunchState } from './RemoteFirstLaunchState'
import type { ProviderUsageSummary } from './ProviderUsageStatus'
import type { ProviderCapabilityContract, ProviderId } from './store/types'

function contract(
  provider: ProviderId,
  availability: ProviderCapabilityContract['availability']
): ProviderCapabilityContract {
  return {
    provider,
    label: provider,
    refreshedAt: '2026-06-21T18:00:00.000Z',
    availability,
    tools: {},
    approvals: {},
    mcp: {},
    warnings: []
  } as unknown as ProviderCapabilityContract
}

function usage(provider: ProviderId, usedPercent: number, stale = false): ProviderUsageSummary {
  return {
    provider,
    configured: true,
    source: `${provider}-usage`,
    stale,
    fetchedAt: '2026-06-21T18:01:00.000Z',
    worstBand: usedPercent >= 90 ? 'critical' : 'medium',
    windows: [
      {
        id: `${provider}-session`,
        label: 'Session',
        band: usedPercent >= 90 ? 'critical' : 'medium',
        usedPercent,
        resetAt: '2026-06-21T22:00:00.000Z'
      }
    ]
  }
}

const workspace = {
  visibleCount: 2,
  totalCount: 4,
  runningCount: 1,
  hasVisibleWorkspaces: true,
  capabilities: {
    monitor: true,
    approve: true,
    answer: true,
    startTurn: true,
    steer: true,
    fileRead: true,
    fileWrite: false
  }
}

describe('buildRemoteFirstLaunchState', () => {
  it('projects provider readiness without retired Gemini cards', () => {
    const state = buildRemoteFirstLaunchState({
      generatedAt: '2026-06-21T18:02:00.000Z',
      workspace,
      providers: {
        codex: contract('codex', {
          available: true,
          binaryPath: '/Users/alice/.codex/bin/codex',
          version: '1.0.0',
          authState: 'authenticated'
        }),
        claude: contract('claude', {
          available: true,
          version: '1.0.0',
          authState: 'missing'
        }),
        kimi: contract('kimi', {
          available: false,
          binaryPath: null,
          version: 'missing'
        }),
        cursor: contract('cursor', {
          available: true,
          version: '2.5.0',
          authState: 'not-observable'
        }),
        ollama: contract('ollama', {
          available: true,
          version: '0.9.0',
          authState: 'not-observable'
        }),
        gemini: contract('gemini', {
          available: true,
          authState: 'authenticated'
        })
      },
      usage: {
        codex: usage('codex', 100),
        cursor: usage('cursor', 43)
      },
      notifications: []
    })

    expect(state.providerCards.map((card) => card.id)).toEqual([
      'codex',
      'claude',
      'kimi',
      'cursor',
      'grok',
      'ollama'
    ])
    expect(state.providerCards.find((card) => card.id === 'codex')?.statusKind).toBe(
      'outOfUsage'
    )
    expect(state.providerCards.find((card) => card.id === 'claude')?.statusKind).toBe(
      'needsSignIn'
    )
    expect(state.providerCards.find((card) => card.id === 'kimi')?.statusKind).toBe('cliMissing')
    expect(state.providerCards.find((card) => card.id === 'cursor')?.statusText).toBe(
      'Not observable'
    )
    expect(state.providerCards.find((card) => card.id === 'ollama')?.statusKind).toBe(
      'localReady'
    )
  })

  it('keeps the payload redacted to labels, coarse statuses, setup hints, and usage windows', () => {
    const state = buildRemoteFirstLaunchState({
      workspace,
      providers: {
        codex: contract('codex', {
          available: false,
          binaryPath: '/Users/alice/secret-cli/codex',
          version: 'missing',
          authState: 'missing',
          error: 'raw failure from /Users/alice/private/project'
        })
      },
      usage: { codex: usage('codex', 72, true) },
      notifications: []
    })

    const encoded = JSON.stringify(state)
    expect(encoded).not.toContain('/Users/alice')
    expect(encoded).not.toContain('raw failure')
    expect(encoded).not.toContain('secret-cli')
    expect(state.setupCommands.some((entry) => entry.id === 'codex')).toBe(true)
    expect(state.ollamaModelCommands.length).toBeGreaterThan(0)
  })

  it('surfaces stale usage snapshots and no-workspace access without leaking setup internals', () => {
    const noWorkspace = {
      visibleCount: 0,
      totalCount: 3,
      runningCount: 0,
      hasVisibleWorkspaces: false,
      capabilities: {
        monitor: false,
        approve: false,
        answer: false,
        startTurn: false,
        steer: false,
        fileRead: false,
        fileWrite: false
      }
    }
    const state = buildRemoteFirstLaunchState({
      generatedAt: '2026-06-21T18:02:00.000Z',
      workspace: noWorkspace,
      providers: {
        claude: contract('claude', {
          available: true,
          binaryPath: '/Applications/Claude Code.app/Contents/MacOS/claude',
          version: '1.0.0',
          authState: 'authenticated'
        })
      },
      usage: { claude: usage('claude', 61, true) },
      notifications: []
    })

    expect(state.workspace).toEqual(noWorkspace)
    expect(state.providerCards.find((card) => card.id === 'claude')?.statusKind).toBe('stale')
    expect(JSON.stringify(state)).not.toContain('/Applications/Claude Code.app')
  })
})
