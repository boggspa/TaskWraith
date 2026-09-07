import { describe, expect, it } from 'vitest'
import {
  museMspCompactionItemToSignal,
  museMspContextPressureIndicatesCompactionQuiet
} from './MuseMspCompaction'
import type { MuseMspItem } from './MuseMspProtocol'

const compactionItem = (overrides: Partial<MuseMspItem> = {}): MuseMspItem => ({
  itemId: 'cmp-1',
  kind: 'compaction',
  revision: 1,
  status: 'inProgress',
  ...overrides
})

describe('museMspContextPressureIndicatesCompactionQuiet', () => {
  it('does not treat occupancy pressure as compaction quiet', () => {
    // 1.0.3 closed vocabulary: normal | warning | blocked. Occupancy vs the
    // host pressure basis, not "currently compacting". Conflating `blocked`
    // with the compaction item is the trap two scouts named.
    expect(museMspContextPressureIndicatesCompactionQuiet('normal')).toBe(false)
    expect(museMspContextPressureIndicatesCompactionQuiet('warning')).toBe(false)
    expect(museMspContextPressureIndicatesCompactionQuiet('blocked')).toBe(false)
  })

  it('still treats an open-enum compacting pressure as compaction quiet', () => {
    expect(museMspContextPressureIndicatesCompactionQuiet('compacting')).toBe(true)
    expect(museMspContextPressureIndicatesCompactionQuiet('compaction')).toBe(true)
  })
})

describe('museMspCompactionItemToSignal', () => {
  it('maps a compaction item onto ContextCompactionSignal without reading pressure', () => {
    expect(museMspCompactionItemToSignal(compactionItem({ trigger: 'auto' }), 'started')).toEqual({
      kind: 'started',
      telemetry: { provider: 'muse', eventUuid: 'cmp-1', trigger: 'auto' }
    })
    expect(
      museMspCompactionItemToSignal(
        compactionItem({
          revision: 2,
          status: 'completed',
          outcome: 'compacted',
          trigger: 'auto',
          tokensBefore: 900_000,
          tokensAfter: 12_000
        }),
        'completed'
      )
    ).toEqual({
      kind: 'completed',
      telemetry: {
        provider: 'muse',
        eventUuid: 'cmp-1',
        trigger: 'auto',
        preTokens: 900_000,
        postTokens: 12_000
      }
    })
  })

  it('maps a failed compaction item to a failed signal', () => {
    expect(
      museMspCompactionItemToSignal(
        compactionItem({
          status: 'failed',
          outcome: 'failed',
          reason: 'no_compactable_history'
        }),
        'completed'
      )
    ).toEqual({
      kind: 'failed',
      telemetry: {
        provider: 'muse',
        eventUuid: 'cmp-1',
        error: 'no_compactable_history'
      }
    })
  })

  it('treats a compaction noop as completed, not failed', () => {
    expect(
      museMspCompactionItemToSignal(
        compactionItem({ status: 'completed', outcome: 'noop', reason: 'no_compactable_history' }),
        'completed'
      )
    ).toMatchObject({ kind: 'completed' })
  })

  it('does not map a toolCall item', () => {
    expect(
      museMspCompactionItemToSignal(
        { itemId: 't1', kind: 'toolCall', revision: 1, status: 'inProgress' },
        'started'
      )
    ).toBeNull()
  })
})
