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
        muse: contract('muse', {
          available: true,
          version: '0.2.141',
          authState: 'authenticated'
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
      'mistral',
      'muse'
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
    expect(state.ollamaModelCommands).toEqual(
      expect.arrayContaining([
        ...[
          ['ministral-3:3b', 'Ministral 3 (3B Param)'],
          ['granite4:3b', 'Granite 4.0 (3B Param)'],
          ['qwen3.5:2b', 'Qwen 3.5 (2B Param)'],
          ['deepseek-r1:1.5b', 'DeepSeek R1 (1.5B Param)'],
          ['nemotron-3-nano:4b', 'Nemotron 3 Nano (4B Param)'],
          ['lfm2.5-thinking:1.2b', 'LFM 2.5 Thinking (1.2B Param)'],
          ['gemma3:4b', 'Gemma 3 (4B Param)']
        ].map(([id, label]) => ({ id, label, command: `ollama run ${id}` })),
        {
          id: 'llama3.1:8b',
          label: 'Llama 3.1 (8B Param)',
          command: 'ollama run llama3.1:8b'
        },
        {
          id: 'deepseek-r1:8b',
          label: 'DeepSeek R1 (8B Param)',
          command: 'ollama run deepseek-r1:8b'
        },
        expect.objectContaining({ id: 'rnj-1', command: 'ollama run rnj-1' }),
        expect.objectContaining({
          id: 'glm-4.7-flash:q4_K_M',
          command: 'ollama run glm-4.7-flash:q4_K_M'
        }),
        expect.objectContaining({
          id: 'north-mini-code-1.0:q4_K_M',
          command: 'ollama run north-mini-code-1.0:q4_K_M'
        }),
        {
          id: 'nemotron-3.5-lightning:30b-mlx',
          label: 'Nemotron 3.5 Lightning (30B-MLX)',
          command: 'ollama run nemotron-3.5-lightning:30b-mlx'
        },
        {
          id: 'qwen3.8:27b-mlx',
          label: 'Qwen 3.8 (27B-MLX; Ollama 0.32.12+)',
          command: 'ollama run qwen3.8:27b-mlx'
        },
        {
          id: 'muse-glimmer:30b-mlx',
          label: 'Muse Glimmer (30B-MLX)',
          command: 'ollama run muse-glimmer:30b-mlx'
        },
        {
          id: 'llama3.2:3b',
          label: 'Llama 3.2 (3B Param)',
          command: 'ollama run llama3.2:3b'
        }
      ])
    )
    expect(state.providerCards.find((card) => card.id === 'mistral')).toMatchObject({
      setupHint: expect.stringContaining('vibe --setup')
    })
    expect(
      state.providerCards
        .find((card) => card.id === 'mistral')
        ?.setupCommands.some((entry) => entry.id === 'mistral')
    ).toBe(true)
    expect(state.providerCards.find((card) => card.id === 'muse')).toMatchObject({
      optional: true,
      detail: expect.stringContaining('available for runs'),
      setupHint: expect.stringContaining('Muse login')
    })
    expect(
      state.providerCards
        .find((card) => card.id === 'muse')
        ?.setupCommands.some((entry) => entry.id === 'muse')
    ).toBe(true)
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
      'antigravity',
      'grok',
      'cursor',
      'muse',
      'mistral',
      'ollama',
      'pi'
    ])
    expect(
      newAdditions?.groups?.find((group) => group.provider === 'antigravity')?.models[0]?.name
    ).toBe('Gemini 3.7 Flash')
    expect(
      newAdditions?.groups?.find((group) => group.provider === 'grok')?.models[0]?.name
    ).toBe('Grok 4.6 Fast')
    expect(
      newAdditions?.groups?.find((group) => group.provider === 'cursor')?.models[0]?.name
    ).toBe('Grok 4.6')
    const museGroup = newAdditions?.groups?.find((group) => group.provider === 'muse')
    expect(museGroup?.models.map((model) => model.name)).toEqual(['Muse Spark 1.2'])
    const ollamaGroup = newAdditions?.groups?.find((group) => group.provider === 'ollama')
    expect(ollamaGroup?.models.map((model) => model.name)).toEqual([
      'GLM 5.2 (Cloud)',
      'MiniMax M3 (Cloud)',
      'Ornith 1.5 (9B & 35B)',
      'Gemma 4 (31B-MLX)',
      'Qwen 3.8 (27B-MLX)',
      'Muse Glimmer (30B-MLX)',
      'Nemotron 3.5 Lightning (30B-MLX)',
      'North Mini Code 1.0',
      'GLM-4.7-Flash',
      'Rnj-1'
    ])
    expect(ollamaGroup?.models.map((model) => model.accentProvider)).toEqual([
      'zai',
      'minimax',
      'deep-reinforce',
      'google',
      'qwen',
      'meta',
      'nvidia',
      'cohere',
      'zai',
      'essential'
    ])
    expect(newAdditions?.groups?.find((group) => group.provider === 'meta')).toBeUndefined()
    // Mistral is deliberately BACK: `068867185` retired the Pi and Mistral
    // additions (which is where this guard came from), then `aff6db7f9`
    // re-added the Mistral entries and `717f43933` refreshed them. Pi was
    // likewise re-added afterwards, so both now assert presence.
    const piGroup = newAdditions?.groups?.find((group) => group.provider === 'pi')
    expect(piGroup?.label).toBe('Pi')
    expect(piGroup?.models.map((model) => model.name)).toEqual([
      'DeepSeek V4 Flash',
      'GLM-5.2',
      'Qwen3.8 Max',
      'Xiaomi MiMo',
      'Mistral Large 3',
      'Ox Alpha',
      'Laguna S 2.1',
      'Nemotron 3 Ultra'
    ])
    expect(piGroup?.models.map((model) => model.accentProvider)).toEqual([
      'deepseek',
      'zai',
      'qwen',
      'xiaomi',
      'mistral',
      'openrouter',
      'poolside',
      'nvidia'
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
