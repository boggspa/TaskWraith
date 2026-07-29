import { describe, expect, it } from 'vitest'
import type { EnsembleParticipant } from '../../../main/store/types'
import {
  clearPendingEnsembleSeatSelection,
  overlayPendingEnsembleSeatSelections,
  queuePendingEnsembleSeatSelection,
  reconcilePendingEnsembleSeatSelections,
  setPendingEnsembleSeatSelection,
  type PendingEnsembleSeatSelections
} from './pendingEnsembleSeatSelection'

function participant(patch: Partial<EnsembleParticipant> = {}): EnsembleParticipant {
  return {
    id: 'seat-1',
    provider: 'claude',
    model: 'claude-opus-4-7',
    role: 'Reviewer',
    instructions: '',
    enabled: true,
    order: 1,
    ...patch
  }
}

describe('pendingEnsembleSeatSelection', () => {
  it('composes rapid provider/model and reasoning edits on the visible pending target', () => {
    const first = queuePendingEnsembleSeatSelection({}, 'chat-1', participant(), {
      provider: 'codex',
      model: 'gpt-5.6'
    })
    const second = queuePendingEnsembleSeatSelection(first.selections, 'chat-1', participant(), {
      reasoningEffort: 'xhigh'
    })

    expect(second.participant).toMatchObject({
      provider: 'codex',
      model: 'gpt-5.6',
      reasoningEffort: 'xhigh'
    })
    expect(
      overlayPendingEnsembleSeatSelections([participant()], second.selections['chat-1'])[0]
    ).toEqual(second.participant)
  })

  it('replaces an optimistic target with the main-authoritative queued target', () => {
    const pending = participant({
      provider: 'kimi',
      model: 'kimi-k2.7-code',
      reasoningEffort: 'high'
    })
    const selections = setPendingEnsembleSeatSelection({}, 'chat-1', pending)

    expect(selections['chat-1']['seat-1']).toEqual(pending)
    expect(clearPendingEnsembleSeatSelection(selections, 'chat-1', 'seat-1')).toEqual({})
  })

  it('keeps pending values while the running seat is unchanged and clears at application or close', () => {
    const current = participant()
    const pending = participant({ model: 'claude-sonnet-4-7', reasoningEffort: 'high' })
    const selections: PendingEnsembleSeatSelections = {
      'chat-1': { 'seat-1': pending }
    }

    expect(
      reconcilePendingEnsembleSeatSelections(selections, {
        chatId: 'chat-1',
        participants: [current],
        roundLive: true
      })
    ).toBe(selections)
    expect(
      reconcilePendingEnsembleSeatSelections(selections, {
        chatId: 'chat-1',
        participants: [pending],
        roundLive: true
      })
    ).toEqual({})
    expect(
      reconcilePendingEnsembleSeatSelections(selections, {
        chatId: 'chat-1',
        participants: [current],
        roundLive: false
      })
    ).toEqual({})
  })
})
