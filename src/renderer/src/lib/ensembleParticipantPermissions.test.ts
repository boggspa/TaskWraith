import { describe, expect, it } from 'vitest'
import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'
import { applyParticipantPermissionsToEnsemble } from './ensembleParticipantPermissions'

function participant(
  id: string,
  permissionPresetId: EnsembleParticipant['permissionPresetId']
): EnsembleParticipant {
  return {
    id,
    provider: 'codex',
    enabled: true,
    role: id,
    instructions: '',
    order: Number(id.slice(-1)),
    permissionPresetId
  }
}

function ensembleChat(): ChatRecord {
  const selected = participant('p1', 'plan')
  selected.permissionOverrides = {
    approvalMode: 'on-request',
    externalPathGrants: [
      {
        id: 'plan-grant',
        provider: 'codex',
        path: '/tmp/plan',
        kind: 'directory',
        access: 'read',
        duration: 'thisThread',
        createdAt: '2026-07-14T00:00:00.000Z'
      }
    ]
  }
  return {
    appChatId: 'chat-a',
    title: 'Roster',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    chatKind: 'ensemble',
    ensemble: {
      enabled: true,
      maxParticipants: 3,
      orchestrationMode: 'turn_bound',
      participants: [selected, participant('p2', 'read_only'), participant('p3', 'default')],
      updatedAt: '2026-07-14T00:00:00.000Z'
    }
  }
}

describe('applyParticipantPermissionsToEnsemble', () => {
  it('updates the full roster in one immutable transform and records every policy shift', () => {
    const source = ensembleChat()
    const updated = applyParticipantPermissionsToEnsemble(source, 'p1')
    const participants = updated.ensemble!.participants

    expect(participants.map((participant) => participant.permissionPresetId)).toEqual([
      'plan',
      'plan',
      'plan'
    ])
    expect(participants[1].permissionOverrides).toEqual(participants[0].permissionOverrides)
    expect(participants[1].permissionOverrides).not.toBe(participants[0].permissionOverrides)
    expect(participants[1].permissionOverrides?.externalPathGrants).not.toBe(
      participants[0].permissionOverrides?.externalPathGrants
    )
    expect(source.ensemble!.participants[1].permissionPresetId).toBe('read_only')
    expect(updated.ensemble?.sessionActivityLedger).toHaveLength(4)
    expect(
      updated.ensemble?.sessionActivityLedger
        ?.filter((entry) => entry.target?.includes('permission preset'))
        .map((entry) => [entry.oldValue, entry.newValue])
    ).toEqual([
      ['read_only', 'plan'],
      ['default', 'plan']
    ])
    expect(
      updated.ensemble?.sessionActivityLedger?.filter((entry) =>
        entry.target?.includes('permission overrides')
      )
    ).toHaveLength(2)
  })

  it('returns the source unchanged when the selected participant is unavailable', () => {
    const source = ensembleChat()
    expect(applyParticipantPermissionsToEnsemble(source, 'missing')).toBe(source)
  })

  it('does not directly overwrite participant permissions during a live round', () => {
    const source = ensembleChat()
    source.ensemble!.activeRound = {
      roundId: 'round-1',
      status: 'running',
      prompt: 'Work.',
      startedAt: '2026-07-14T00:00:00.000Z',
      activeParticipantId: 'p2',
      participants: [
        {
          participantId: 'p1',
          provider: 'codex',
          role: 'p1',
          order: 1,
          status: 'answered'
        },
        {
          participantId: 'p2',
          provider: 'codex',
          role: 'p2',
          order: 2,
          status: 'running'
        },
        {
          participantId: 'p3',
          provider: 'codex',
          role: 'p3',
          order: 3,
          status: 'idle'
        }
      ]
    }

    const updated = applyParticipantPermissionsToEnsemble(source, 'p1')

    expect(updated).toBe(source)
    expect(
      updated.ensemble?.participants.map((participant) => participant.permissionPresetId)
    ).toEqual(['plan', 'read_only', 'default'])
    expect(updated.ensemble?.sessionActivityLedger).toBeUndefined()
  })

  it('audits copied override changes without disclosing granted paths', () => {
    const source = ensembleChat()
    source.ensemble!.participants[1].permissionPresetId = 'plan'
    source.ensemble!.participants[1].permissionOverrides = {
      approvalMode: 'never'
    }

    const updated = applyParticipantPermissionsToEnsemble(source, 'p1')
    const overrideEntry = updated.ensemble?.sessionActivityLedger?.find((entry) =>
      entry.target?.includes('permission overrides')
    )

    expect(overrideEntry).toMatchObject({
      oldValue: 'approval policy',
      newValue: 'approval policy, 1 external path grant',
      reason: 'Participant permission overrides changed.'
    })
    expect(JSON.stringify(overrideEntry)).not.toContain('/tmp/plan')
  })
})
