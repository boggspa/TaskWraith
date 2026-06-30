import { describe, expect, it } from 'vitest'
import {
  ASSIGNABLE_PERMISSION_PRESETS,
  evaluateRosterEdit,
  MAX_ENSEMBLE_PARTICIPANTS,
  MIN_ENSEMBLE_PARTICIPANTS,
  type RosterEditContext
} from './EnsembleRosterMutation'
import type { AgenticServicePolicy, EnsembleParticipant, ExternalPathGrant } from './store/types'

function participant(overrides: Partial<EnsembleParticipant>): EnsembleParticipant {
  return {
    id: overrides.id || 'participant',
    provider: overrides.provider || 'codex',
    enabled: overrides.enabled ?? true,
    role: overrides.role || 'Worker',
    instructions: overrides.instructions || 'Do the work.',
    order: overrides.order || 1,
    ...overrides
  }
}

function makeContext(overrides: Partial<RosterEditContext> = {}): RosterEditContext {
  return {
    participants: [
      participant({
        id: 'boss',
        provider: 'claude',
        role: 'Boss',
        order: 1,
        permissionPresetId: 'workspace_write'
      }),
      participant({
        id: 'worker',
        provider: 'codex',
        role: 'Worker',
        order: 2,
        permissionPresetId: 'default'
      })
    ],
    bossmanParticipantId: 'boss',
    autoApprovals: { enabled: true, mode: 'permission_preset_once' },
    roundReadOnly: false,
    nextParticipantId: () => 'new-participant',
    ...overrides
  }
}

function externalGrant(): ExternalPathGrant {
  return {
    id: 'grant-1',
    provider: 'codex',
    path: '/tmp/outside',
    kind: 'directory',
    access: 'write',
    duration: 'thisRun',
    createdAt: '2026-06-30T00:00:00.000Z'
  }
}

describe('evaluateRosterEdit', () => {
  it('exports the main-side roster bounds and assignable preset ceiling', () => {
    expect(MIN_ENSEMBLE_PARTICIPANTS).toBe(2)
    expect(MAX_ENSEMBLE_PARTICIPANTS).toBe(12)
    expect(ASSIGNABLE_PERMISSION_PRESETS).toEqual([
      'read_only',
      'default',
      'workspace_write'
    ])
  })

  it('fails closed when Boss Auto Approvals consent is missing or in the wrong mode', () => {
    expect(
      evaluateRosterEdit(
        { action: 'add_participant', participant: { provider: 'kimi' } },
        makeContext({ autoApprovals: undefined })
      )
    ).toMatchObject({ ok: false, error: 'auto_approvals_disabled' })
    expect(
      evaluateRosterEdit(
        { action: 'add_participant', participant: { provider: 'kimi' } },
        makeContext({ autoApprovals: { enabled: true, mode: 'session' } })
      )
    ).toMatchObject({ ok: false, error: 'auto_approvals_disabled' })
  })

  it('fails closed when the configured Boss is missing or stale', () => {
    expect(
      evaluateRosterEdit(
        { action: 'add_participant', participant: { provider: 'kimi' } },
        makeContext({ bossmanParticipantId: undefined })
      )
    ).toMatchObject({ ok: false, error: 'bossman_not_configured' })
    expect(
      evaluateRosterEdit(
        { action: 'add_participant', participant: { provider: 'kimi' } },
        makeContext({ bossmanParticipantId: 'missing' })
      )
    ).toMatchObject({ ok: false, error: 'bossman_not_configured' })
  })

  it('adds an enabled participant with a minted id and normalized order', () => {
    const result = evaluateRosterEdit(
      {
        action: 'add_participant',
        participant: {
          provider: 'kimi',
          model: 'kimi-k2',
          role: 'Reviewer',
          instructions: 'Review carefully.',
          reasoningEffort: 'high',
          thinkingEnabled: true,
          permissionPresetId: 'workspace_write',
          permissionOverrides: {
            approvalMode: 'plan',
            agenticServices: { mcpTools: 'deny' },
            networkAccess: 'deny'
          }
        }
      },
      makeContext()
    )

    expect(result).toMatchObject({
      ok: true,
      affectedParticipantId: 'new-participant'
    })
    if (!result.ok) throw new Error(result.message)
    expect(result.nextParticipants.map((entry) => [entry.id, entry.order])).toEqual([
      ['boss', 1],
      ['worker', 2],
      ['new-participant', 3]
    ])
    expect(result.nextParticipants[2]).toMatchObject({
      id: 'new-participant',
      provider: 'kimi',
      enabled: true,
      role: 'Reviewer',
      instructions: 'Review carefully.',
      model: 'kimi-k2',
      reasoningEffort: 'high',
      thinkingEnabled: true,
      permissionPresetId: 'workspace_write',
      permissionOverrides: {
        approvalMode: 'plan',
        agenticServices: { mcpTools: 'deny' },
        networkAccess: 'deny'
      }
    })
  })

  it('rejects add requests without a provider and rosters at the max', () => {
    expect(
      evaluateRosterEdit({ action: 'add_participant', participant: {} }, makeContext())
    ).toMatchObject({ ok: false, error: 'no_provider' })

    const fullRoster = Array.from({ length: MAX_ENSEMBLE_PARTICIPANTS }, (_, index) =>
      participant({
        id: index === 0 ? 'boss' : `p-${index}`,
        provider: index === 0 ? 'claude' : 'codex',
        role: index === 0 ? 'Boss' : `Worker ${index}`,
        order: index + 1
      })
    )
    expect(
      evaluateRosterEdit(
        { action: 'add_participant', participant: { provider: 'kimi' } },
        makeContext({ participants: fullRoster })
      )
    ).toMatchObject({ ok: false, error: 'roster_max' })
  })

  it('removes a non-Boss participant and renumbers remaining participants', () => {
    const result = evaluateRosterEdit(
      { action: 'remove_participant', targetParticipantId: 'worker' },
      makeContext({
        participants: [
          participant({ id: 'boss', provider: 'claude', role: 'Boss', order: 3 }),
          participant({ id: 'worker', provider: 'codex', role: 'Worker', order: 7 }),
          participant({ id: 'reviewer', provider: 'kimi', role: 'Reviewer', order: 9 })
        ]
      })
    )

    expect(result).toMatchObject({ ok: true, affectedParticipantId: 'worker' })
    if (!result.ok) throw new Error(result.message)
    expect(result.nextParticipants.map((entry) => [entry.id, entry.order])).toEqual([
      ['boss', 1],
      ['reviewer', 2]
    ])
  })

  it('rejects remove requests for missing targets, the Boss, and the roster floor', () => {
    expect(
      evaluateRosterEdit({ action: 'remove_participant' }, makeContext())
    ).toMatchObject({ ok: false, error: 'invalid_request' })
    expect(
      evaluateRosterEdit(
        { action: 'remove_participant', targetParticipantId: 'missing' },
        makeContext()
      )
    ).toMatchObject({ ok: false, error: 'stale_target' })
    expect(
      evaluateRosterEdit(
        { action: 'remove_participant', targetParticipantId: 'boss' },
        makeContext()
      )
    ).toMatchObject({ ok: false, error: 'remove_boss' })
    expect(
      evaluateRosterEdit(
        { action: 'remove_participant', targetParticipantId: 'worker' },
        makeContext({ participants: makeContext().participants.slice(0, MIN_ENSEMBLE_PARTICIPANTS) })
      )
    ).toMatchObject({ ok: false, error: 'roster_min' })
  })

  it('edits provider, model, reasoning, preset, and narrow permission overrides without mutating input', () => {
    const ctx = makeContext()
    const result = evaluateRosterEdit(
      {
        action: 'edit_participant',
        targetParticipantId: 'worker',
        participant: {
          provider: 'cursor',
          model: 'cursor-pro',
          role: 'Patch lane',
          instructions: 'Edit only assigned files.',
          reasoningEffort: 'medium',
          fastModeEnabled: true,
          permissionPresetId: 'workspace_write',
          permissionOverrides: { agenticServices: { shellCommands: 'deny' } }
        }
      },
      ctx
    )

    expect(result).toMatchObject({ ok: true, affectedParticipantId: 'worker' })
    if (!result.ok) throw new Error(result.message)
    expect(ctx.participants[1]).toMatchObject({
      id: 'worker',
      provider: 'codex',
      role: 'Worker',
      permissionPresetId: 'default'
    })
    expect(result.nextParticipants[1]).toMatchObject({
      id: 'worker',
      provider: 'cursor',
      model: 'cursor-pro',
      role: 'Patch lane',
      instructions: 'Edit only assigned files.',
      reasoningEffort: 'medium',
      fastModeEnabled: true,
      permissionPresetId: 'workspace_write',
      permissionOverrides: { agenticServices: { shellCommands: 'deny' } }
    })
  })

  it('clears optional model, reasoning, and empty permission override fields when explicitly set empty', () => {
    const result = evaluateRosterEdit(
      {
        action: 'edit_participant',
        targetParticipantId: 'worker',
        participant: {
          model: null,
          reasoningEffort: null,
          permissionOverrides: null
        }
      },
      makeContext({
        participants: [
          participant({ id: 'boss', provider: 'claude', role: 'Boss', order: 1 }),
          participant({
            id: 'worker',
            provider: 'codex',
            role: 'Worker',
            order: 2,
            model: 'gpt-5',
            reasoningEffort: 'high'
          })
        ]
      })
    )

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error(result.message)
    expect(result.nextParticipants[1].model).toBeUndefined()
    expect(result.nextParticipants[1].reasoningEffort).toBeUndefined()
    expect(result.nextParticipants[1].permissionOverrides).toBeUndefined()
  })

  it('rejects partial override patches that would drop existing service denies', () => {
    const result = evaluateRosterEdit(
      {
        action: 'edit_participant',
        targetParticipantId: 'worker',
        participant: {
          permissionOverrides: { agenticServices: { shellCommands: 'deny' } }
        }
      },
      makeContext({
        participants: [
          participant({ id: 'boss', provider: 'claude', role: 'Boss', order: 1 }),
          participant({
            id: 'worker',
            provider: 'codex',
            role: 'Worker',
            order: 2,
            permissionOverrides: {
              agenticServices: { fileChanges: 'deny', mcpTools: 'deny' }
            }
          })
        ]
      })
    )

    expect(result).toMatchObject({ ok: false, error: 'tool_grant_widen' })
  })

  it('rejects null-clearing overrides when existing denies would be removed', () => {
    const result = evaluateRosterEdit(
      {
        action: 'edit_participant',
        targetParticipantId: 'worker',
        participant: { permissionOverrides: null }
      },
      makeContext({
        participants: [
          participant({ id: 'boss', provider: 'claude', role: 'Boss', order: 1 }),
          participant({
            id: 'worker',
            provider: 'codex',
            role: 'Worker',
            order: 2,
            permissionOverrides: { agenticServices: { fileChanges: 'deny' } }
          })
        ]
      })
    )

    expect(result).toMatchObject({ ok: false, error: 'tool_grant_widen' })
  })

  it('adds a new deny when existing service denies are preserved', () => {
    const result = evaluateRosterEdit(
      {
        action: 'edit_participant',
        targetParticipantId: 'worker',
        participant: {
          permissionOverrides: {
            agenticServices: { fileChanges: 'deny', mcpTools: 'deny' }
          }
        }
      },
      makeContext({
        participants: [
          participant({ id: 'boss', provider: 'claude', role: 'Boss', order: 1 }),
          participant({
            id: 'worker',
            provider: 'codex',
            role: 'Worker',
            order: 2,
            permissionOverrides: { agenticServices: { fileChanges: 'deny' } }
          })
        ]
      })
    )

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error(result.message)
    expect(result.nextParticipants[1].permissionOverrides).toEqual({
      agenticServices: { fileChanges: 'deny', mcpTools: 'deny' }
    })
  })

  it('raises the coarse preset when existing fine denies are preserved', () => {
    const result = evaluateRosterEdit(
      {
        action: 'edit_participant',
        targetParticipantId: 'worker',
        participant: {
          permissionPresetId: 'workspace_write',
          permissionOverrides: {
            approvalMode: 'plan',
            agenticServices: { fileChanges: 'deny' },
            networkAccess: 'deny'
          }
        }
      },
      makeContext({
        participants: [
          participant({ id: 'boss', provider: 'claude', role: 'Boss', order: 1 }),
          participant({
            id: 'worker',
            provider: 'codex',
            role: 'Worker',
            order: 2,
            permissionPresetId: 'read_only',
            permissionOverrides: {
              approvalMode: 'plan',
              agenticServices: { fileChanges: 'deny' },
              networkAccess: 'deny'
            }
          })
        ]
      })
    )

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error(result.message)
    expect(result.nextParticipants[1]).toMatchObject({
      permissionPresetId: 'workspace_write',
      permissionOverrides: {
        approvalMode: 'plan',
        agenticServices: { fileChanges: 'deny' },
        networkAccess: 'deny'
      }
    })
  })

  it('keeps network deny and approvalMode plan sticky', () => {
    for (const permissionOverrides of [
      { approvalMode: 'plan' },
      { networkAccess: 'deny' }
    ] as const) {
      expect(
        evaluateRosterEdit(
          {
            action: 'edit_participant',
            targetParticipantId: 'worker',
            participant: { permissionOverrides }
          },
          makeContext({
            participants: [
              participant({ id: 'boss', provider: 'claude', role: 'Boss', order: 1 }),
              participant({
                id: 'worker',
                provider: 'codex',
                role: 'Worker',
                order: 2,
                permissionOverrides: {
                  approvalMode: 'plan',
                  networkAccess: 'deny'
                }
              })
            ]
          })
        )
      ).toMatchObject({ ok: false, error: 'tool_grant_widen' })
    }
  })

  it('rejects unsupported actions and edit requests without a target or patch', () => {
    expect(
      evaluateRosterEdit({ action: 'replace_participant' }, makeContext())
    ).toMatchObject({ ok: false, error: 'invalid_request' })
    expect(
      evaluateRosterEdit({ action: 'edit_participant', participant: { model: 'x' } }, makeContext())
    ).toMatchObject({ ok: false, error: 'invalid_request' })
    expect(
      evaluateRosterEdit(
        { action: 'edit_participant', targetParticipantId: 'worker', participant: {} },
        makeContext()
      )
    ).toMatchObject({ ok: false, error: 'invalid_request' })
    expect(
      evaluateRosterEdit(
        { action: 'edit_participant', targetParticipantId: 'missing', participant: { model: 'x' } },
        makeContext()
      )
    ).toMatchObject({ ok: false, error: 'stale_target' })
  })

  it('enforces the coarse permission ceiling', () => {
    for (const permissionPresetId of ['full_access', 'custom'] as const) {
      expect(
        evaluateRosterEdit(
          {
            action: 'edit_participant',
            targetParticipantId: 'worker',
            participant: { permissionPresetId }
          },
          makeContext()
        )
      ).toMatchObject({ ok: false, error: 'permission_ceiling' })
    }
  })

  it('allows only narrow permissionOverrides and rejects tool-grant widening', () => {
    for (const policy of ['ask', 'workspace', 'allow'] as AgenticServicePolicy[]) {
      expect(
        evaluateRosterEdit(
          {
            action: 'edit_participant',
            targetParticipantId: 'worker',
            participant: { permissionOverrides: { agenticServices: { fileChanges: policy } } }
          },
          makeContext()
        )
      ).toMatchObject({ ok: false, error: 'tool_grant_widen' })
    }
    expect(
      evaluateRosterEdit(
        {
          action: 'edit_participant',
          targetParticipantId: 'worker',
          participant: { permissionOverrides: { networkAccess: 'allow' } }
        },
        makeContext()
      )
    ).toMatchObject({ ok: false, error: 'tool_grant_widen' })
    expect(
      evaluateRosterEdit(
        {
          action: 'edit_participant',
          targetParticipantId: 'worker',
          participant: { permissionOverrides: { approvalMode: 'auto_edit' } }
        },
        makeContext()
      )
    ).toMatchObject({ ok: false, error: 'tool_grant_widen' })
  })

  it('rejects external path grants in participant overrides', () => {
    expect(
      evaluateRosterEdit(
        {
          action: 'edit_participant',
          targetParticipantId: 'worker',
          participant: { permissionOverrides: { externalPathGrants: [externalGrant()] } }
        },
        makeContext()
      )
    ).toMatchObject({ ok: false, error: 'external_path_forbidden' })
  })

  it('does not assign write permissions from a read-only round posture', () => {
    expect(
      evaluateRosterEdit(
        {
          action: 'add_participant',
          participant: { provider: 'kimi', permissionPresetId: 'workspace_write' }
        },
        makeContext({ roundReadOnly: true })
      )
    ).toMatchObject({ ok: false, error: 'read_only_posture' })

    const result = evaluateRosterEdit(
      { action: 'add_participant', participant: { provider: 'kimi' } },
      makeContext({ roundReadOnly: true })
    )
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) throw new Error(result.message)
    expect(result.nextParticipants[2].permissionPresetId).toBe('read_only')
  })
})
