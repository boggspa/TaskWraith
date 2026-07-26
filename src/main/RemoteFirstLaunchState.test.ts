import { describe, expect, it } from 'vitest'
import { buildRemoteFirstLaunchState } from './RemoteFirstLaunchState'
import {
  NEW_ADDITIONS_NOTIFICATION_ID,
  resolveAppNotifications
} from '../shared/appNotifications'
import type { ProviderUsageSummary } from './ProviderUsageStatus'
import type { ProviderCapabilityContract, ProviderId } from './store/types'
import type { TaskWraithPluginActivatedProviderSetup } from '../shared/plugins/PluginTypes'

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
      'ollama',
      'pi',
      'mistral'
    ])
    expect(state.providerCards.find((card) => card.id === 'codex')?.statusKind).toBe('outOfUsage')
    expect(state.providerCards.find((card) => card.id === 'claude')?.statusKind).toBe('needsSignIn')
    expect(state.providerCards.find((card) => card.id === 'kimi')?.statusKind).toBe('cliMissing')
    expect(state.providerCards.find((card) => card.id === 'cursor')).toMatchObject({
      statusKind: 'notObservable',
      statusText: 'Not observable'
    })
    expect(
      state.providerCards.find((card) => card.id === 'cursor')?.setupCommands.some(
        (entry) => entry.id === 'cursor'
      )
    ).toBe(true)
    expect(state.setupCommands.some((entry) => entry.id === 'cursor')).toBe(true)
    expect(state.providerCards.find((card) => card.id === 'ollama')?.statusKind).toBe('localReady')
  })

  it('projects a present but unqualified Kimi runtime as managed-runtime unavailable', () => {
    const state = buildRemoteFirstLaunchState({
      generatedAt: '2026-07-19T01:00:00.000Z',
      workspace,
      providers: {
        kimi: contract('kimi', {
          available: false,
          setupRequired: true,
          binaryPath: '/Users/alice/.kimi-code/bin/kimi',
          version: 'security-unavailable',
          authState: 'oauth',
          error: 'Kimi bounded inventory probes failed.'
        })
      },
      usage: {},
      notifications: []
    })

    const kimi = state.providerCards.find((card) => card.id === 'kimi')
    expect(kimi).toMatchObject({
      statusKind: 'notObservable',
      statusText: 'Managed runtime unavailable'
    })
    expect(kimi?.detail).toContain('bounded startup probes')
    expect(kimi?.detail).toContain('Structural ACP admission is always enabled')
    expect(kimi?.detail).toContain('credentials do not bypass')
    expect(kimi?.detail).toContain('unattested-development')
    expect(kimi?.detail).not.toContain('reviewed tuple')
    expect(JSON.stringify(kimi)).not.toContain('/Users/alice')
  })

  it('does not let Codex usage telemetry override a missing private-home sign-in', () => {
    const state = buildRemoteFirstLaunchState({
      generatedAt: '2026-07-24T15:00:00.000Z',
      workspace,
      providers: {
        codex: contract('codex', {
          available: true,
          version: '1.0.0',
          authState: 'missing',
          setupRequired: true
        })
      },
      usage: { codex: usage('codex', 100) },
      notifications: []
    })

    expect(state.providerCards.find((card) => card.id === 'codex')).toMatchObject({
      statusKind: 'needsSignIn',
      statusText: 'Needs sign-in on Mac'
    })
  })

  it('includes activated plugin provider setup hints in remote provider cards', () => {
    const providerSetup: TaskWraithPluginActivatedProviderSetup[] = [
      {
        id: 'plugin.taskwraith.provider-setup-bundle:providerSetup:codex',
        plugin: {
          pluginId: 'provider-setup-bundle',
          publisher: 'taskwraith',
          version: '1.0.0',
          source: 'builtin',
          namespace: 'plugin.taskwraith.provider-setup-bundle',
          manifestHash: 'sha256:setup'
        },
        setup: {
          provider: 'codex',
          label: 'Codex CLI',
          installHint: 'Install Codex through the plugin setup recipe.',
          authHint: 'Run codex login.',
          preflightChecks: ['binary', 'auth', 'mcp']
        },
        pluginProvenance: {
          pluginId: 'provider-setup-bundle',
          publisher: 'taskwraith',
          version: '1.0.0',
          source: 'builtin',
          namespace: 'plugin.taskwraith.provider-setup-bundle',
          manifestHash: 'sha256:setup',
          kind: 'providerSetup',
          objectId: 'codex',
          materializedAt: '2026-06-21T18:02:00.000Z'
        }
      }
    ]
    const state = buildRemoteFirstLaunchState({
      generatedAt: '2026-06-21T18:02:00.000Z',
      workspace,
      providers: {},
      usage: {},
      notifications: [],
      providerSetup
    })

    const codex = state.providerCards.find((card) => card.id === 'codex')
    expect(codex?.pluginSetupHints).toEqual([
      {
        id: 'plugin.taskwraith.provider-setup-bundle:providerSetup:codex',
        pluginId: 'provider-setup-bundle',
        label: 'Codex CLI',
        installHint: 'Install Codex through the plugin setup recipe.',
        authHint: 'Run codex login.',
        preflightChecks: ['binary', 'auth', 'mcp']
      }
    ])
    expect(codex?.setupHint).toContain('Plugin setup: Codex CLI')
    expect(codex?.setupHint).toContain('Checks: binary, auth, mcp.')
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

    // Pin via the registry constant, not a dated literal — the id bumps every
    // time the New Additions lineup changes.
    expect(state.notifications.map((notice) => notice.id)).toContain(
      NEW_ADDITIONS_NOTIFICATION_ID
    )
    expect(state.notifications.map((notice) => notice.id)).not.toContain(
      'gemini-retirement-2026-06-18'
    )
    expect(state.notifications.map((notice) => notice.id)).not.toContain(
      'grok-composer-2-5-fast-2026-06-19'
    )

    const newAdditions = state.notifications.find(
      (notice) => notice.id === NEW_ADDITIONS_NOTIFICATION_ID
    )
    expect(newAdditions?.tone).toBe('default')
    expect(newAdditions?.accent).toBe('default')
    expect(newAdditions?.kind).toBe('addition')
    expect(newAdditions?.title).toBe('New Additions')
    expect(newAdditions?.groups?.map((group) => group.provider)).toEqual([
      'pi',
      'mistral',
      'claude',
      'antigravity',
      'kimi'
    ])
    // Pi's per-upstream spoof accents must survive the bridge projection —
    // without them every Pi row renders in one seat colour on the phone.
    const piGroup = newAdditions?.groups?.find((group) => group.provider === 'pi')
    expect(piGroup?.models.map((model) => model.accentProvider)).toEqual([
      'deepseek',
      'zai',
      'qwen',
      'minimax',
      'mistral',
      'groq',
      'cerebras'
    ])
    const claudeGroup = newAdditions?.groups?.find((group) => group.provider === 'claude')
    expect(claudeGroup?.models.map((model) => model.name)).toEqual(['Opus 5'])
    expect(claudeGroup?.models[0]?.blurb).toMatch(/half the price.*Fast mode/)
    const antigravityGroup = newAdditions?.groups?.find(
      (group) => group.provider === 'antigravity'
    )
    expect(antigravityGroup?.models.map((model) => model.name)).toEqual([
      'Gemini 3.6 Flash',
      'Gemini 3.5 Flash',
      'Gemini 3.5 Flash-Lite'
    ])
    expect(antigravityGroup?.models[0]?.blurb).toMatch(/bring your own Gemini API key/)
    const kimiGroup = newAdditions?.groups?.find((group) => group.provider === 'kimi')
    expect(kimiGroup?.models).toEqual([
      expect.objectContaining({
        name: 'K3',
        blurb: expect.stringMatching(/256K on Moderato.*up to 1M on Allegretto\+.*Low, High, or Max thinking/)
      })
    ])
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
