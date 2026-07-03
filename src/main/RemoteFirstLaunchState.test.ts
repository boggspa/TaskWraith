import { describe, expect, it } from 'vitest'
import { buildRemoteFirstLaunchState } from './RemoteFirstLaunchState'
import { resolveAppNotifications } from '../shared/appNotifications'
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
    fileWrite: false,
    externalPublish: false
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
    expect(state.providerCards.find((card) => card.id === 'codex')?.statusKind).toBe('outOfUsage')
    expect(state.providerCards.find((card) => card.id === 'claude')?.statusKind).toBe('needsSignIn')
    expect(state.providerCards.find((card) => card.id === 'kimi')?.statusKind).toBe('cliMissing')
    expect(state.providerCards.find((card) => card.id === 'cursor')?.statusText).toBe(
      'Not observable'
    )
    expect(state.providerCards.find((card) => card.id === 'ollama')?.statusKind).toBe('localReady')
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

  it('keeps every Claude quota window on the card, including the Fable weekly meter', () => {
    const claudeUsage: ProviderUsageSummary = {
      provider: 'claude',
      configured: true,
      source: 'claude-oauth-usage',
      stale: false,
      fetchedAt: '2026-07-01T23:00:00.000Z',
      worstBand: 'medium',
      windows: [
        { id: 'claude-5h', label: 'Session', band: 'medium', usedPercent: 55 },
        { id: 'claude-weekly', label: 'Weekly', band: 'low', usedPercent: 10 },
        { id: 'claude-weekly-fable', label: 'Fable', band: 'low', usedPercent: 18 },
        // Transitional payloads can still carry a legacy Opus family window.
        { id: 'claude-weekly-opus', label: 'Opus', band: 'low', usedPercent: 31 }
      ]
    } as ProviderUsageSummary
    const state = buildRemoteFirstLaunchState({
      generatedAt: '2026-07-01T23:00:00.000Z',
      workspace,
      providers: {
        claude: contract('claude', {
          available: true,
          version: '1.0.0',
          authState: 'authenticated'
        })
      },
      usage: { claude: claudeUsage },
      notifications: []
    })

    const card = state.providerCards.find((entry) => entry.id === 'claude')
    expect(card?.usageWindows.map((window) => window.id)).toEqual([
      'claude-5h',
      'claude-weekly',
      'claude-weekly-fable',
      'claude-weekly-opus'
    ])
    expect(card?.usageWindows.find((window) => window.id === 'claude-weekly-fable')).toMatchObject({
      label: 'Fable',
      usedPercent: 18
    })
  })

  it('projects active app notices for the iOS first-launch sheet', () => {
    const state = buildRemoteFirstLaunchState({
      generatedAt: '2026-06-21T18:02:00.000Z',
      notifications: resolveAppNotifications(0),
      workspace,
      providers: {},
      usage: {}
    })

    expect(state.notifications.map((notice) => notice.id)).toContain(
      'ollama-local-models-2026-06-30'
    )
    expect(state.notifications.map((notice) => notice.id)).toContain('claude-sonnet-5-2026-06-30')
    expect(state.notifications.map((notice) => notice.id)).toContain(
      'claude-fable-mythos-return-2026-07-01'
    )
    expect(state.notifications.map((notice) => notice.id)).toContain(
      'changelog-plan-mode-workflow-2026-07-01'
    )
    expect(state.notifications.map((notice) => notice.id)).toContain(
      'changelog-ensemble-recovery-2026-07-01'
    )
    expect(state.notifications.map((notice) => notice.id)).toContain(
      'antigravity-not-planned-2026-06-26'
    )
    expect(state.notifications.map((notice) => notice.id)).not.toContain(
      'gemini-retirement-2026-06-18'
    )
    expect(state.notifications.map((notice) => notice.id)).not.toContain(
      'grok-composer-2-5-fast-2026-06-19'
    )
    const antigravity = state.notifications.find(
      (notice) => notice.id === 'antigravity-not-planned-2026-06-26'
    )
    expect(antigravity?.tone).toBe('default')
    expect(antigravity?.accent).toBe('default')
    expect(antigravity?.kind).toBe('info')
    expect(antigravity?.title).toBe('AntiGravity will not be added.')

    const sonnet = state.notifications.find((notice) => notice.id === 'claude-sonnet-5-2026-06-30')
    expect(sonnet?.tone).toBe('default')
    expect(sonnet?.accent).toBe('claude')
    expect(sonnet?.title).toBe('Claude Sonnet 5 is available.')

    const returnedClaude5 = state.notifications.find(
      (notice) => notice.id === 'claude-fable-mythos-return-2026-07-01'
    )
    expect(returnedClaude5?.tone).toBe('default')
    expect(returnedClaude5?.accent).toBe('claude')
    expect(returnedClaude5?.title).toBe('Claude Fable 5 access is returning.')
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
        fileWrite: false,
        externalPublish: false
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
