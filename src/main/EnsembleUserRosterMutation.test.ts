import { describe, expect, it } from 'vitest'
import type { ChatRecord, EnsembleParticipant, ProviderId } from './store/types'
import {
  parseEnsembleUserRosterMutationInput,
  resolveEnsembleUserRosterMutation,
  type EnsembleUserRosterMutationInput
} from './EnsembleUserRosterMutation'

function participant(
  id: string,
  order: number,
  patch: Partial<EnsembleParticipant> = {}
): EnsembleParticipant {
  return {
    id,
    provider: 'codex',
    enabled: true,
    role: id,
    instructions: `Handle ${id}.`,
    order,
    permissionPresetId: 'default',
    ...patch
  }
}

function ensemble(
  patch: Partial<NonNullable<ChatRecord['ensemble']>> = {}
): NonNullable<ChatRecord['ensemble']> {
  return {
    enabled: true,
    participants: [participant('one', 1), participant('two', 2)],
    maxParticipants: 2,
    ...patch
  }
}

function resolve(
  config: NonNullable<ChatRecord['ensemble']>,
  input: EnsembleUserRosterMutationInput
) {
  return resolveEnsembleUserRosterMutation(config, input, {
    nowIso: '2026-07-29T01:00:00.000Z',
    isProviderSelectable: (provider) =>
      new Set<ProviderId>(['codex', 'claude', 'kimi']).has(provider as ProviderId)
  })
}

describe('resolveEnsembleUserRosterMutation', () => {
  it('parses only the bounded renderer mutation vocabulary', () => {
    expect(
      parseEnsembleUserRosterMutationInput({
        chatId: 'chat-1',
        action: 'set_authority',
        participantId: 'one',
        authority: 'captain'
      })
    ).toEqual({
      chatId: 'chat-1',
      action: 'set_authority',
      participantId: 'one',
      authority: 'captain'
    })
    expect(() =>
      parseEnsembleUserRosterMutationInput({
        chatId: 'chat-1',
        action: 'replace_everything'
      })
    ).toThrow('action is invalid')
  })

  it('inserts a selectable participant at the requested live order and grows the cap', () => {
    const result = resolve(ensemble(), {
      chatId: 'chat-1',
      action: 'add',
      participant: participant('new-seat', 2, {
        provider: 'kimi',
        role: 'New worker'
      })
    })

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        action: 'add',
        affectedParticipantId: 'new-seat',
        maxParticipants: 3
      })
    })
    if (!result.ok) return
    expect(result.value.participants.map(({ id, order }) => ({ id, order }))).toEqual([
      { id: 'one', order: 1 },
      { id: 'new-seat', order: 2 },
      { id: 'two', order: 3 }
    ])
  })

  it('rejects retired providers for additions without blocking an existing legacy seat', () => {
    const legacy = ensemble({
      participants: [participant('legacy', 1, { provider: 'gemini' }), participant('two', 2)]
    })

    expect(
      resolve(legacy, {
        chatId: 'chat-1',
        action: 'reorder',
        participantIds: ['two', 'legacy']
      })
    ).toMatchObject({ ok: true })
    expect(
      resolve(legacy, {
        chatId: 'chat-1',
        action: 'add',
        participant: participant('new-gemini', 3, { provider: 'gemini' })
      })
    ).toMatchObject({ ok: false, error: 'unknown_provider' })
  })

  it('removes an idle target and clears authority that no longer resolves', () => {
    const result = resolve(
      ensemble({
        bossmanParticipantId: 'one',
        bossmanAutoApprovals: {
          enabled: true,
          mode: 'permission_preset_once',
          confirmedAt: '2026-07-28T00:00:00.000Z'
        }
      }),
      {
        chatId: 'chat-1',
        action: 'remove',
        participantId: 'one'
      }
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        participants: [{ id: 'two', order: 1 }],
        bossmanParticipantId: undefined,
        secondInCommandParticipantId: undefined,
        bossmanAutoApprovals: undefined
      }
    })
  })

  it('reorders only when every current participant is named exactly once', () => {
    expect(
      resolve(ensemble(), {
        chatId: 'chat-1',
        action: 'reorder',
        participantIds: ['two', 'one']
      })
    ).toMatchObject({
      ok: true,
      value: {
        participants: [
          { id: 'two', order: 1 },
          { id: 'one', order: 2 }
        ]
      }
    })
    expect(
      resolve(ensemble(), {
        chatId: 'chat-1',
        action: 'reorder',
        participantIds: ['two', 'two']
      })
    ).toMatchObject({ ok: false, error: 'invalid_request' })
  })

  it('moves exclusive authority and stamps explicit Auto Approvals consent', () => {
    const captain = resolve(ensemble({ bossmanParticipantId: 'one' }), {
      chatId: 'chat-1',
      action: 'set_authority',
      participantId: 'one',
      authority: 'captain'
    })
    expect(captain).toMatchObject({
      ok: true,
      value: {
        bossmanParticipantId: undefined,
        secondInCommandParticipantId: 'one'
      }
    })
    if (!captain.ok) return

    expect(
      resolve(
        {
          ...ensemble(),
          ...captain.value
        },
        {
          chatId: 'chat-1',
          action: 'set_auto_approvals',
          enabled: true
        }
      )
    ).toMatchObject({
      ok: true,
      value: {
        bossmanAutoApprovals: {
          enabled: true,
          mode: 'permission_preset_once',
          confirmedAt: '2026-07-29T01:00:00.000Z'
        }
      }
    })
  })
})
