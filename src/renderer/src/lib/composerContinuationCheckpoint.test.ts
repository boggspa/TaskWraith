import { describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../main/store/types'
import { buildComposerContinuationCheckpoint } from './composerContinuationCheckpoint'

function chat(overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    title: 'Validation repair',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    messages: [
      {
        id: 'user-1',
        role: 'user',
        content: 'Fix the validation failure',
        timestamp: '2026-08-30T00:00:00.000Z'
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'One focused validation still fails.',
        timestamp: '2026-08-30T00:01:00.000Z'
      }
    ],
    runs: [],
    ...overrides
  }
}

describe('buildComposerContinuationCheckpoint', () => {
  it('contains only invalidation state, never draft wording', () => {
    const checkpoint = buildComposerContinuationCheckpoint(chat())!
    expect(checkpoint).toMatchObject({
      schemaVersion: 2,
      hasUserRequest: true,
      hasSettledAssistant: true,
      titleNeedsProposal: true
    })
    expect(JSON.stringify(checkpoint)).not.toContain('Fix the validation failure')
    expect(JSON.stringify(checkpoint)).not.toContain('Continue with')
  })

  it('changes when semantic context changes but not for updatedAt alone', () => {
    const first = buildComposerContinuationCheckpoint(chat())!
    expect(buildComposerContinuationCheckpoint(chat({ updatedAt: 99 }))!.id).toBe(first.id)
    expect(
      buildComposerContinuationCheckpoint(
        chat({ messages: [...chat().messages, { ...chat().messages[1], id: 'assistant-2' }] })
      )!.id
    ).not.toBe(first.id)
  })

  it('suppresses draft generation after a completed goal and title generation after user rename', () => {
    const checkpoint = buildComposerContinuationCheckpoint(
      chat({
        threadTitle: { source: 'user' },
        activeGoal: {
          id: 'goal-1',
          objective: 'Fix validation',
          objectiveSource: 'user',
          status: 'completed',
          provider: 'codex',
          mode: 'taskwraith_steered',
          createdAt: '2026-08-30T00:00:00.000Z',
          updatedAt: '2026-08-30T00:01:00.000Z'
        }
      })
    )!
    expect(checkpoint.phase).toBe('complete')
    expect(checkpoint.titleNeedsProposal).toBe(false)
  })
})
