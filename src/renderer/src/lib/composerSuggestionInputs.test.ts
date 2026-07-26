import { describe, expect, it } from 'vitest'
import type {
  ChatRecord,
  ConcurrentLane,
  EnsembleRoundParticipantState,
  EnsembleRoundState
} from '../../../main/store/types'
import { failedLanesFromChat } from './composerSuggestionInputs'

function seat(
  overrides: Partial<EnsembleRoundParticipantState> & { participantId: string }
): EnsembleRoundParticipantState {
  return {
    provider: 'codex',
    role: '',
    order: 1,
    status: 'answered',
    ...overrides
  } as EnsembleRoundParticipantState
}

function concurrentLane(overrides: Partial<ConcurrentLane> & { laneId: string }): ConcurrentLane {
  return {
    participantId: 'p-1',
    provider: 'codex',
    status: 'completed',
    intent: 'read',
    startedAt: '2026-07-26T00:00:00.000Z',
    ...overrides
  } as ConcurrentLane
}

function chatWithRound(round: Partial<EnsembleRoundState> | null): ChatRecord {
  if (!round) return {} as unknown as ChatRecord
  const activeRound: EnsembleRoundState = {
    roundId: 'r-1',
    status: 'completed',
    prompt: '',
    startedAt: '2026-07-26T00:00:00.000Z',
    participants: [],
    ...round
  } as EnsembleRoundState
  return { ensemble: { activeRound } } as unknown as ChatRecord
}

describe('failedLanesFromChat', () => {
  it('returns nothing without a round', () => {
    expect(failedLanesFromChat(chatWithRound(null))).toEqual([])
    expect(failedLanesFromChat(null)).toEqual([])
    expect(failedLanesFromChat(undefined)).toEqual([])
  })

  it('returns nothing while the round is still running', () => {
    // Seats fail and recover mid-round; a rerun offered here would race
    // the orchestrator.
    const chat = chatWithRound({
      status: 'running',
      participants: [seat({ participantId: 'p-1', role: 'Captain', status: 'failed' })]
    })
    expect(failedLanesFromChat(chat)).toEqual([])
  })

  describe('serial dispatch (no lanes)', () => {
    it('reads failures off participants[].status', () => {
      const chat = chatWithRound({
        participants: [
          seat({ participantId: 'p-1', role: 'Boss', status: 'answered' }),
          seat({ participantId: 'p-2', role: 'Captain', status: 'failed', provider: 'codex' }),
          seat({ participantId: 'p-3', role: '', status: 'unreachable', provider: 'kimi' })
        ]
      })
      expect(failedLanesFromChat(chat)).toEqual([
        { id: 'p-2', label: 'Captain', provider: 'codex', kind: 'failed' },
        { id: 'p-3', label: 'kimi', provider: 'kimi', kind: 'unreachable' }
      ])
    })

    it('excludes outcomes the user chose', () => {
      const chat = chatWithRound({
        participants: [
          seat({ participantId: 'p-1', status: 'skipped' }),
          seat({ participantId: 'p-2', status: 'cancelled' }),
          seat({ participantId: 'p-3', status: 'sleeping' }),
          seat({ participantId: 'p-4', status: 'yielded' })
        ]
      })
      expect(failedLanesFromChat(chat)).toEqual([])
    })

    it('falls back to the provider id when a seat has no role', () => {
      const chat = chatWithRound({
        participants: [
          seat({ participantId: 'p-1', role: '   ', status: 'failed', provider: 'grok' })
        ]
      })
      expect(failedLanesFromChat(chat)[0].label).toBe('grok')
    })
  })

  describe('concurrent dispatch (lanes present)', () => {
    it('reads failures off lane records and labels them from the round seat', () => {
      const chat = chatWithRound({
        participants: [seat({ participantId: 'p-2', role: 'Specialist', provider: 'kimi' })],
        lanes: {
          'lane-a': concurrentLane({ laneId: 'lane-a', participantId: 'p-1', status: 'completed' }),
          'lane-b': concurrentLane({
            laneId: 'lane-b',
            participantId: 'p-2',
            provider: 'kimi',
            status: 'failed'
          })
        }
      })
      expect(failedLanesFromChat(chat)).toEqual([
        { id: 'lane-b', label: 'Specialist', provider: 'kimi', kind: 'failed' }
      ])
    })

    it('labels a lane by provider when its seat is missing from the round', () => {
      const chat = chatWithRound({
        participants: [],
        lanes: {
          'lane-a': concurrentLane({
            laneId: 'lane-a',
            participantId: 'ghost',
            provider: 'cursor',
            status: 'failed'
          })
        }
      })
      expect(failedLanesFromChat(chat)[0].label).toBe('cursor')
    })

    it('falls through to participants when lanes exist but none failed', () => {
      // An all-green lane map must not mask a seat the serial path
      // recorded as failed.
      const chat = chatWithRound({
        participants: [seat({ participantId: 'p-9', role: 'Boss', status: 'failed' })],
        lanes: {
          'lane-a': concurrentLane({ laneId: 'lane-a', status: 'completed' })
        }
      })
      expect(failedLanesFromChat(chat)).toEqual([
        { id: 'p-9', label: 'Boss', provider: 'codex', kind: 'failed' }
      ])
    })

    it('ignores non-terminal lane statuses', () => {
      const chat = chatWithRound({
        participants: [],
        lanes: {
          'lane-a': concurrentLane({ laneId: 'lane-a', status: 'blocked' }),
          'lane-b': concurrentLane({ laneId: 'lane-b', status: 'awaiting-approval' }),
          'lane-c': concurrentLane({ laneId: 'lane-c', status: 'cancelled' })
        }
      })
      expect(failedLanesFromChat(chat)).toEqual([])
    })
  })
})
