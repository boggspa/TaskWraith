import { describe, expect, it } from 'vitest'
import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'
import { resolveSlashParticipantForChat } from './resolveSlashParticipant'

describe('resolveSlashParticipantForChat', () => {
  it('returns null for solo chats', () => {
    expect(resolveSlashParticipantForChat({ chatKind: 'single' } as ChatRecord)).toBeNull()
  })

  it('prefers the explicit participant when it belongs to the chat', () => {
    const participants = makeParticipants()
    expect(resolveSlashParticipantForChat(makeEnsembleChat(participants), participants[1])).toBe(
      participants[1]
    )
  })

  it('falls back to side-chat metadata, then first enabled participant by order', () => {
    const participants = makeParticipants()
    expect(
      resolveSlashParticipantForChat(
        makeEnsembleChat(participants, { sideChatSelectedParticipantId: 'third' })
      )
    ).toBe(participants[2])

    expect(resolveSlashParticipantForChat(makeEnsembleChat(participants))).toBe(participants[1])
  })
})

function makeParticipants(): EnsembleParticipant[] {
  return [
    {
      id: 'first',
      provider: 'codex',
      role: 'Planner',
      order: 1,
      enabled: false,
      permissionPresetId: 'read_only'
    },
    {
      id: 'second',
      provider: 'claude',
      role: 'Reviewer',
      order: 2,
      enabled: true,
      permissionPresetId: 'read_only'
    },
    {
      id: 'third',
      provider: 'kimi',
      role: 'Scout',
      order: 3,
      enabled: true,
      permissionPresetId: 'read_only'
    }
  ] as EnsembleParticipant[]
}

function makeEnsembleChat(
  participants: EnsembleParticipant[],
  providerMetadata: Record<string, unknown> = {}
): ChatRecord {
  return {
    chatKind: 'ensemble',
    providerMetadata,
    ensemble: {
      participants
    }
  } as ChatRecord
}
