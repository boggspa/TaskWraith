import { describe, expect, it } from 'vitest'
import {
  applyPendingEnsembleRosterPresetOnFinalize,
  applyPendingEnsembleRosterPresetOnRunTerminal,
  buildAgentRosterPresetExportFromDraft,
  buildEnsembleRosterPresetApply,
  buildUserEnsembleRosterPresetApplyPlan,
  hasPendingEnsembleRosterPresetApply,
  parsePendingEnsembleRosterPresetApply,
  parseSingleAgentRosterPresetExport,
  queuePendingEnsembleRosterPresetApply
} from './EnsembleRosterPresetApply'
import {
  MAX_ROSTER_PRESET_PARTICIPANTS,
  type EnsembleRosterPreset
} from './EnsembleRosterPresetContract'
import type { ChatRecord, EnsembleParticipant } from './store/types'

function participant(
  id: string,
  provider: EnsembleParticipant['provider'],
  role: string,
  order: number
): EnsembleParticipant {
  return {
    id,
    provider,
    enabled: true,
    role,
    instructions: '',
    order,
    model: 'cli-default',
    permissionPresetId: 'default',
    linkedProviderSessionId: `session-${id}`
  }
}

function soloChat(provider: EnsembleParticipant['provider'] = 'codex'): ChatRecord {
  return {
    appChatId: 'chat-1',
    chatKind: 'single',
    scope: 'workspace',
    provider,
    title: 'Existing thread',
    workspaceId: 'ws-1',
    workspacePath: '/tmp/project',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    linkedProviderSessionId: 'solo-session',
    providerMetadata: { selectedModelType: 'gpt-5.6-terra' },
    messages: [
      { id: 'm-1', role: 'user', content: 'Set up my ensemble', timestamp: '2026-07-12' }
    ],
    runs: []
  }
}

function ensembleChat(): ChatRecord {
  const boss = participant('boss-id', 'codex', 'General', 1)
  const captain = participant('captain-id', 'claude', 'Captain', 2)
  const worker = participant('worker-id', 'kimi', 'Worker', 3)
  return {
    ...soloChat(),
    chatKind: 'ensemble',
    ensemble: {
      enabled: true,
      maxParticipants: MAX_ROSTER_PRESET_PARTICIPANTS,
      orchestrationMode: 'turn_bound',
      participants: [boss, captain, worker],
      bossmanParticipantId: boss.id,
      captainParticipantIds: [captain.id],
      secondInCommandParticipantId: captain.id,
      bossmanAutoApprovals: {
        enabled: true,
        mode: 'permission_preset_once',
        confirmedAt: '2026-07-12T10:00:00.000Z'
      }
    }
  }
}

function preset(overrides: Partial<EnsembleRosterPreset> = {}): EnsembleRosterPreset {
  return {
    id: 'agent-preset',
    name: 'Task-specific implementation panel',
    createdAt: 1,
    updatedAt: 1,
    orchestrationMode: 'continuous',
    maxParticipants: 6,
    maxContinuationHops: 16,
    fanoutPolicy: 'all',
    ensembleContextChars: 120_000,
    participants: [
      {
        provider: 'codex',
        enabled: true,
        role: 'Boss',
        instructions: 'Own the outcome and coordinate the panel.',
        order: 1,
        isBossman: true,
        model: 'gpt-5.6-terra',
        reasoningEffort: 'high',
        permissionPresetId: 'default'
      },
      {
        provider: 'claude',
        enabled: true,
        role: 'Captain',
        instructions: 'Run the second lane and challenge the implementation.',
        order: 2,
        isSecondInCommand: true,
        model: 'claude-sonnet-4-7',
        reasoningEffort: 'medium',
        permissionPresetId: 'plan',
        stageRole: 'reviewer'
      },
      {
        provider: 'grok',
        enabled: true,
        role: 'Scout',
        instructions: 'Map the relevant code before workers edit.',
        order: 3,
        model: 'grok-code-fast-1',
        permissionPresetId: 'read_only',
        stageRole: 'scout'
      }
    ],
    ...overrides
  }
}

function idFactory(...ids: string[]): () => string {
  let index = 0
  return () => ids[index++] || `generated-${index}`
}

describe('EnsembleRosterPresetApply', () => {
  it('builds an explicit user roster change for the next round boundary', () => {
    const boss = participant('new-boss', 'codex', 'Boss', 1)
    boss.permissionOverrides = {
      approvalMode: 'on-request',
      networkAccess: 'allow'
    }
    const worker = participant('new-worker', 'claude', 'Worker', 2)
    const plan = buildUserEnsembleRosterPresetApplyPlan({
      preset: preset({
        maxParticipants: 99,
        maxContinuationHops: 999,
        ensembleContextChars: 999_999
      }),
      participants: [boss, worker],
      bossmanParticipantId: boss.id,
      queuedAt: '2026-07-28T23:00:00.000Z'
    })

    expect(plan).toMatchObject({
      authority: 'user',
      presetId: 'agent-preset',
      bossmanParticipantId: 'new-boss',
      captainParticipantIds: [],
      maxParticipants: MAX_ROSTER_PRESET_PARTICIPANTS,
      maxContinuationHops: 500,
      ensembleContextChars: 256_000
    })
    expect(plan.participants[0]).toMatchObject({
      linkedProviderSessionId: null,
      permissionOverrides: {
        approvalMode: 'on-request',
        networkAccess: 'allow'
      }
    })

    const queued = queuePendingEnsembleRosterPresetApply(ensembleChat(), plan)
    expect(hasPendingEnsembleRosterPresetApply(queued)).toBe(true)
    const applied = applyPendingEnsembleRosterPresetOnFinalize(queued)
    expect(applied.ensemble?.activeRosterPresetId).toBe('agent-preset')
    expect(applied.ensemble?.participants.map((entry) => entry.id)).toEqual([
      'new-boss',
      'new-worker'
    ])

    expect(
      parsePendingEnsembleRosterPresetApply({
        ...plan,
        captainParticipantIds: undefined,
        secondInCommandParticipantId: 'new-worker'
      })
    ).toMatchObject({
      captainParticipantIds: ['new-worker'],
      secondInCommandParticipantId: 'new-worker'
    })
  })

  it('builds a valid export from compact agent input without caller metadata', () => {
    const json = buildAgentRosterPresetExportFromDraft(
      {
        name: 'Compact QA roster',
        participants: [
          {
            provider: 'kimi',
            enabled: true,
            role: 'Boss',
            instructions: 'Coordinate the panel.',
            order: 1,
            isBossman: true,
            permissionPresetId: 'default'
          }
        ]
      },
      { id: 'host-generated', now: 1_784_316_912_899 }
    )

    expect(JSON.parse(json)).toMatchObject({
      exportedAt: '2026-07-17T19:35:12.899Z',
      presets: [
        {
          id: 'host-generated',
          createdAt: 1_784_316_912_899,
          updatedAt: 1_784_316_912_899,
          orchestrationMode: 'turn_bound',
          maxParticipants: MAX_ROSTER_PRESET_PARTICIPANTS
        }
      ]
    })
    expect(parseSingleAgentRosterPresetExport(json).name).toBe('Compact QA roster')
  })

  it('overwrites caller-supplied storage metadata in compact agent input', () => {
    const json = buildAgentRosterPresetExportFromDraft(
      {
        ...preset(),
        id: 'caller-id',
        createdAt: 1,
        updatedAt: 2
      },
      { id: 'host-id', now: 3 }
    )

    expect(parseSingleAgentRosterPresetExport(json)).toMatchObject({
      id: 'host-id',
      createdAt: 3,
      updatedAt: 3
    })
  })

  it('accepts exactly one normal versioned export and rejects loose/multi-preset JSON', () => {
    const source = preset()
    const envelope = JSON.stringify({
      format: 'taskwraith.ensembleRosterPresets',
      version: 1,
      exportedAt: '2026-07-12T12:00:00.000Z',
      presets: [source]
    })
    expect(parseSingleAgentRosterPresetExport(envelope)).toEqual(source)
    expect(() => parseSingleAgentRosterPresetExport(JSON.stringify([source]))).toThrow(
      'must use taskwraith.ensembleRosterPresets'
    )
    expect(() =>
      parseSingleAgentRosterPresetExport(
        JSON.stringify({
          format: 'taskwraith.ensembleRosterPresets',
          version: 1,
          exportedAt: '2026-07-12T12:00:00.000Z',
          presets: [source, { ...source, id: 'second' }]
        })
      )
    ).toThrow('exactly one')
    expect(() =>
      parseSingleAgentRosterPresetExport(
        JSON.stringify({
          format: 'taskwraith.ensembleRosterPresets',
          version: 1,
          exportedAt: 'not-a-date',
          presets: [source]
        })
      )
    ).toThrow('must use taskwraith.ensembleRosterPresets')
  })

  it('converts a solo chat while forcing the current provider to inherit Boss', () => {
    const chat = soloChat('codex')
    const result = buildEnsembleRosterPresetApply({
      chat,
      preset: preset(),
      queuedAt: '2026-07-12T12:00:00.000Z',
      sourceRunId: 'run-1',
      makeParticipantId: idFactory('new-boss', 'new-captain', 'new-scout')
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.authority).toBe('solo_inherited_boss')
    expect(result.plan.bossmanParticipantId).toBe('new-boss')
    expect(result.plan.captainParticipantIds).toEqual(['new-captain'])
    expect(result.plan.secondInCommandParticipantId).toBe('new-captain')

    const queued = queuePendingEnsembleRosterPresetApply(chat, result.plan)
    expect(hasPendingEnsembleRosterPresetApply(queued)).toBe(true)
    const applied = applyPendingEnsembleRosterPresetOnFinalize(queued)

    expect(applied.appChatId).toBe(chat.appChatId)
    expect(applied.messages).toEqual(chat.messages)
    expect(applied.chatKind).toBe('ensemble')
    expect(applied).not.toHaveProperty('linkedProviderSessionId')
    expect(applied.ensemble).toMatchObject({
      activeRosterPresetId: 'agent-preset',
      orchestrationMode: 'continuous',
      fanoutPolicy: 'all',
      maxContinuationHops: 16,
      ensembleContextChars: 120_000,
      bossmanParticipantId: 'new-boss',
      captainParticipantIds: ['new-captain'],
      secondInCommandParticipantId: 'new-captain'
    })
    expect(applied.ensemble?.participants.map((entry) => entry.role)).toEqual([
      'Boss',
      'Captain',
      'Scout'
    ])
    expect(hasPendingEnsembleRosterPresetApply(applied)).toBe(false)
  })

  it('activates a queued solo roster from the matching terminal run only', () => {
    const chat = soloChat('codex')
    const result = buildEnsembleRosterPresetApply({
      chat,
      preset: preset(),
      queuedAt: '2026-07-12T12:00:00.000Z',
      sourceRunId: 'run-that-imported-the-roster',
      makeParticipantId: idFactory('new-boss', 'new-captain', 'new-scout')
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const queued = queuePendingEnsembleRosterPresetApply(chat, result.plan)

    expect(
      applyPendingEnsembleRosterPresetOnRunTerminal(queued, 'unrelated-run')
    ).toBe(queued)

    const applied = applyPendingEnsembleRosterPresetOnRunTerminal(
      queued,
      'run-that-imported-the-roster'
    )
    expect(applied.chatKind).toBe('ensemble')
    expect(applied.ensemble?.activeRosterPresetId).toBe('agent-preset')
    expect(hasPendingEnsembleRosterPresetApply(applied)).toBe(false)
  })

  it('consumes a stale pending marker when the matching preset is already active', () => {
    const source = soloChat('codex')
    const result = buildEnsembleRosterPresetApply({
      chat: source,
      preset: preset(),
      queuedAt: '2026-07-12T12:00:00.000Z',
      sourceRunId: 'run-1',
      makeParticipantId: idFactory('queued-boss', 'queued-captain', 'queued-scout')
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const manuallyApplied = queuePendingEnsembleRosterPresetApply(
      {
        ...ensembleChat(),
        ensemble: {
          ...ensembleChat().ensemble!,
          activeRosterPresetId: result.plan.presetId
        }
      },
      result.plan
    )
    const existingParticipants = manuallyApplied.ensemble?.participants
    const cleaned = applyPendingEnsembleRosterPresetOnRunTerminal(manuallyApplied, 'run-1')

    expect(cleaned.ensemble?.participants).toBe(existingParticipants)
    expect(hasPendingEnsembleRosterPresetApply(cleaned)).toBe(false)
  })

  it('leaves a different pending Ensemble preset for the round boundary', () => {
    const chat = ensembleChat()
    const result = buildEnsembleRosterPresetApply({
      chat,
      preset: preset(),
      callerParticipantId: 'boss-id',
      queuedAt: '2026-07-12T12:00:00.000Z',
      sourceRunId: 'participant-run',
      makeParticipantId: idFactory('fresh-scout')
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const queued = queuePendingEnsembleRosterPresetApply(chat, result.plan)

    expect(
      applyPendingEnsembleRosterPresetOnRunTerminal(queued, 'participant-run')
    ).toBe(queued)
  })

  it('rejects a solo preset whose marked Boss is a different provider', () => {
    const source = preset()
    source.participants[0].provider = 'claude'
    const result = buildEnsembleRosterPresetApply({
      chat: soloChat('codex'),
      preset: source,
      queuedAt: '2026-07-12T12:00:00.000Z',
      makeParticipantId: idFactory('unused')
    })

    expect(result).toMatchObject({ ok: false, error: 'boss_provider_mismatch' })
  })

  it('uses the main-owned conditional-provider predicate for roster admission', () => {
    const source = preset()
    source.participants[2].provider = 'antigravity'

    const admitted = buildEnsembleRosterPresetApply({
      chat: soloChat('codex'),
      preset: source,
      queuedAt: '2026-07-12T12:00:00.000Z',
      makeParticipantId: idFactory('boss', 'captain', 'antigravity'),
      isProviderSelectable: (provider) => provider !== 'gemini'
    })
    expect(admitted.ok).toBe(true)

    const walled = buildEnsembleRosterPresetApply({
      chat: soloChat('codex'),
      preset: source,
      queuedAt: '2026-07-12T12:00:00.000Z',
      makeParticipantId: idFactory('unused'),
      isProviderSelectable: (provider) => provider !== 'gemini' && provider !== 'antigravity'
    })
    expect(walled).toMatchObject({ ok: false, error: 'provider_unavailable' })
  })

  it('lets an existing Boss load a preset and preserves the authority seat ids', () => {
    const chat = ensembleChat()
    const result = buildEnsembleRosterPresetApply({
      chat,
      preset: preset(),
      callerParticipantId: 'boss-id',
      queuedAt: '2026-07-12T12:00:00.000Z',
      makeParticipantId: idFactory('fresh-scout')
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.authority).toBe('ensemble_boss')
    expect(result.plan.bossmanParticipantId).toBe('boss-id')
    expect(result.plan.captainParticipantIds).toEqual(['captain-id'])
    expect(result.plan.secondInCommandParticipantId).toBe('captain-id')
    expect(result.plan.participants.map((entry) => entry.id)).toEqual([
      'boss-id',
      'captain-id',
      'fresh-scout'
    ])

    const applied = applyPendingEnsembleRosterPresetOnFinalize(
      queuePendingEnsembleRosterPresetApply(chat, result.plan)
    )
    expect(applied.ensemble?.bossmanAutoApprovals).toBeUndefined()
    expect(applied.ensemble?.participants.every((entry) => entry.linkedProviderSessionId === null))
      .toBe(true)
  })

  it('lets Captain refine a roster but not clear Captain authority', () => {
    const chat = ensembleChat()
    const allowed = buildEnsembleRosterPresetApply({
      chat,
      preset: preset(),
      callerParticipantId: 'captain-id',
      queuedAt: '2026-07-12T12:00:00.000Z',
      makeParticipantId: idFactory('fresh-scout')
    })
    expect(allowed).toMatchObject({ ok: true, plan: { authority: 'ensemble_captain' } })

    const withoutCaptain = preset()
    delete withoutCaptain.participants[1].isSecondInCommand
    const rejected = buildEnsembleRosterPresetApply({
      chat,
      preset: withoutCaptain,
      callerParticipantId: 'captain-id',
      queuedAt: '2026-07-12T12:00:00.000Z',
      makeParticipantId: idFactory('unused')
    })
    expect(rejected).toMatchObject({ ok: false, error: 'captain_assignment_forbidden' })
  })

  it('keeps a disabled Boss configured while an available Captain imports a roster', () => {
    const chat = ensembleChat()
    chat.ensemble!.participants[0].enabled = false

    const result = buildEnsembleRosterPresetApply({
      chat,
      preset: preset(),
      callerParticipantId: 'captain-id',
      queuedAt: '2026-07-12T12:00:00.000Z',
      makeParticipantId: idFactory('fresh-scout')
    })

    expect(result).toMatchObject({
      ok: true,
      plan: {
        authority: 'ensemble_captain',
        bossmanParticipantId: 'boss-id',
        captainParticipantIds: ['captain-id']
      }
    })
  })

  it('preserves the complete three-Captain set for a Captain-authored import', () => {
    const chat = ensembleChat()
    const captainTwo = participant('captain-two', 'kimi', 'Captain Two', 3)
    const captainThree = participant('captain-three', 'grok', 'Captain Three', 4)
    chat.ensemble = {
      ...chat.ensemble!,
      participants: [chat.ensemble!.participants[0], chat.ensemble!.participants[1], captainTwo, captainThree],
      captainParticipantIds: ['captain-id', 'captain-two', 'captain-three'],
      secondInCommandParticipantId: 'captain-id'
    }
    const source = preset()
    source.participants[2].isSecondInCommand = true
    source.participants.push({
      provider: 'grok',
      enabled: true,
      role: 'Captain Three',
      instructions: 'Review the panel outcome.',
      order: 4,
      isSecondInCommand: true,
      permissionPresetId: 'default'
    })

    const result = buildEnsembleRosterPresetApply({
      chat,
      preset: source,
      callerParticipantId: 'captain-two',
      queuedAt: '2026-07-12T12:00:00.000Z',
      makeParticipantId: idFactory('unused')
    })

    expect(result).toMatchObject({
      ok: true,
      plan: {
        authority: 'ensemble_captain',
        captainParticipantIds: ['captain-id', 'captain-two', 'captain-three'],
        secondInCommandParticipantId: 'captain-id'
      }
    })
  })

  it('rejects non-authority callers and permission widening', () => {
    const unauthorized = buildEnsembleRosterPresetApply({
      chat: ensembleChat(),
      preset: preset(),
      callerParticipantId: 'worker-id',
      queuedAt: '2026-07-12T12:00:00.000Z',
      makeParticipantId: idFactory('unused')
    })
    expect(unauthorized).toMatchObject({ ok: false, error: 'not_authorized' })

    const elevated = preset()
    elevated.participants[2].permissionPresetId = 'workspace_write'
    const rejected = buildEnsembleRosterPresetApply({
      chat: soloChat(),
      preset: elevated,
      queuedAt: '2026-07-12T12:00:00.000Z',
      makeParticipantId: idFactory('unused')
    })
    expect(rejected).toMatchObject({ ok: false, error: 'permission_ceiling' })
  })

  it('requires exactly one enabled Boss and clamps portable settings', () => {
    const source = preset({
      maxParticipants: 2,
      maxContinuationHops: 999,
      ensembleContextChars: 999_999
    })
    const result = buildEnsembleRosterPresetApply({
      chat: soloChat(),
      preset: source,
      queuedAt: '2026-07-12T12:00:00.000Z',
      makeParticipantId: idFactory('boss', 'captain', 'scout')
    })
    expect(result).toMatchObject({
      ok: true,
      plan: {
        maxParticipants: 3,
        maxContinuationHops: 500,
        ensembleContextChars: 256_000
      }
    })

    delete source.participants[0].isBossman
    const noBoss = buildEnsembleRosterPresetApply({
      chat: soloChat(),
      preset: source,
      queuedAt: '2026-07-12T12:00:00.000Z',
      makeParticipantId: idFactory('unused')
    })
    expect(noBoss).toMatchObject({ ok: false, error: 'boss_required' })
  })
})
