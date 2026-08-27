import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../store/types'
import { appendAutoApprovalsChangeTranscriptEvent } from './EnsembleAutoApprovalsTranscript'

function chat(): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    scope: 'workspace',
    title: 'Auto Approvals changes',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: []
  }
}

describe('appendAutoApprovalsChangeTranscriptEvent', () => {
  it('persists a round-owned structured event with an explicit plaintext fallback', () => {
    const updated = appendAutoApprovalsChangeTranscriptEvent(chat(), {
      id: 'auto-approvals-1',
      before: false,
      after: true,
      changedAt: '2026-08-27T12:00:00.000Z',
      changedAtMs: 42,
      roundId: 'round-1'
    })

    expect(updated.updatedAt).toBe(42)
    expect(updated.messages).toEqual([
      expect.objectContaining({
        id: 'auto-approvals-1',
        role: 'system',
        content: 'User enabled thread-wide Auto Approvals.',
        metadata: {
          kind: 'ensembleAutoApprovalsChange',
          ensembleRoundId: 'round-1',
          autoApprovalsChange: {
            before: false,
            after: true,
            changedAt: '2026-08-27T12:00:00.000Z'
          }
        }
      })
    ])
  })

  it('uses an honest disabled fallback and suppresses no-op events', () => {
    const disabled = appendAutoApprovalsChangeTranscriptEvent(chat(), {
      id: 'auto-approvals-2',
      before: true,
      after: false,
      changedAt: '2026-08-27T12:01:00.000Z',
      changedAtMs: 43
    })
    expect(disabled.messages[0].content).toBe('User disabled thread-wide Auto Approvals.')

    const original = chat()
    expect(
      appendAutoApprovalsChangeTranscriptEvent(original, {
        id: 'auto-approvals-noop',
        before: true,
        after: true,
        changedAt: '2026-08-27T12:02:00.000Z',
        changedAtMs: 44
      })
    ).toBe(original)
  })
})
