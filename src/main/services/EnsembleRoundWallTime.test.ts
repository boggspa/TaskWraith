import { describe, expect, it } from 'vitest'
import { recordEnsembleRoundWallMs } from './EnsembleRoundWallTime'

describe('recordEnsembleRoundWallMs', () => {
  it('records the whole terminal round from start through close', () => {
    expect(
      recordEnsembleRoundWallMs(
        { older: 10_000 },
        {
          roundId: 'round-2',
          startedAt: '2026-09-12T10:00:00.000Z',
          endedAt: '2026-09-12T10:02:34.000Z'
        }
      )
    ).toEqual({ older: 10_000, 'round-2': 154_000 })
  })

  it('is idempotent when terminal delivery repeats', () => {
    const ledger = { 'round-2': 154_000 }
    expect(
      recordEnsembleRoundWallMs(ledger, {
        roundId: 'round-2',
        startedAt: '2026-09-12T10:00:00.000Z',
        endedAt: '2026-09-12T10:02:34.000Z'
      })
    ).toBe(ledger)
  })

  it('preserves the prior ledger when a boundary is invalid or negative', () => {
    const ledger = { older: 10_000 }
    expect(
      recordEnsembleRoundWallMs(ledger, {
        roundId: 'round-invalid',
        startedAt: 'not-a-time',
        endedAt: '2026-09-12T10:02:34.000Z'
      })
    ).toBe(ledger)
    expect(
      recordEnsembleRoundWallMs(ledger, {
        roundId: 'round-negative',
        startedAt: '2026-09-12T10:03:00.000Z',
        endedAt: '2026-09-12T10:02:34.000Z'
      })
    ).toBe(ledger)
  })

  it('does not carry array entries into a newly recorded ledger', () => {
    expect(
      recordEnsembleRoundWallMs([30_000] as unknown as Record<string, number>, {
        roundId: 'round-3',
        startedAt: '2026-09-12T10:03:00.000Z',
        endedAt: '2026-09-12T10:03:05.000Z'
      })
    ).toEqual({ 'round-3': 5_000 })
  })
})
