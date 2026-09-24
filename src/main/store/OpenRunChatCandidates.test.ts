import { describe, expect, it, vi } from 'vitest'
import type { ChatListRunSummary } from './types'
import {
  runSummaryIsUnsettled,
  selectOpenRunCandidateChatIds,
  type OpenRunCandidateSource
} from './OpenRunChatCandidates'

function summary(runId: string, endedAt?: string): ChatListRunSummary {
  return {
    runId,
    startedAt: '2026-09-07T00:00:00.000Z',
    diffFileCount: 0,
    ...(endedAt ? { endedAt } : {})
  }
}

function source(overrides: Partial<OpenRunCandidateSource> = {}): OpenRunCandidateSource {
  return {
    vouchesForSourceBytes: () => true,
    readRunsSummary: () => [],
    ...overrides
  }
}

describe('selectOpenRunCandidateChatIds', () => {
  it('skips a vouched chat whose summarised runs have all ended', () => {
    const candidates = selectOpenRunCandidateChatIds(
      ['a'],
      source({ readRunsSummary: () => [summary('r1', '2026-09-07T01:00:00.000Z')] })
    )
    expect(candidates).toEqual([])
  })

  it('keeps a vouched chat whose summary still holds an unsettled run', () => {
    const candidates = selectOpenRunCandidateChatIds(
      ['a'],
      source({ readRunsSummary: () => [summary('r1', '2026-09-07T01:00:00.000Z'), summary('r2')] })
    )
    expect(candidates).toEqual(['a'])
  })

  it('keeps a chat the index cannot vouch for, without reading its summary', () => {
    const readRunsSummary = vi.fn(() => [] as ChatListRunSummary[])
    const candidates = selectOpenRunCandidateChatIds(
      ['a'],
      source({ vouchesForSourceBytes: () => false, readRunsSummary })
    )
    expect(candidates).toEqual(['a'])
    expect(readRunsSummary).not.toHaveBeenCalled()
  })

  it('keeps a chat whose summary is missing', () => {
    const candidates = selectOpenRunCandidateChatIds(['a'], source({ readRunsSummary: () => null }))
    expect(candidates).toEqual(['a'])
  })

  it('keeps a chat whose summary read throws', () => {
    const candidates = selectOpenRunCandidateChatIds(
      ['a'],
      source({
        readRunsSummary: () => {
          throw new Error('unreadable')
        }
      })
    )
    expect(candidates).toEqual(['a'])
  })

  it('skips a vouched chat that summarised no runs at all', () => {
    // Not a vacuous pass: the vouch pins these exact bytes, so an empty
    // summary means the record genuinely holds no run to reconcile.
    expect(selectOpenRunCandidateChatIds(['a'], source())).toEqual([])
  })

  it('preserves the caller sweep order and drops empty ids', () => {
    const candidates = selectOpenRunCandidateChatIds(
      ['a', '', 'b', 'c'],
      source({
        readRunsSummary: (chatId) =>
          chatId === 'b' ? [summary('r1', '2026-09-07T01:00:00.000Z')] : [summary('open')]
      })
    )
    expect(candidates).toEqual(['a', 'c'])
  })

  it('does not let a run summary with no runId force a canonical read', () => {
    const candidates = selectOpenRunCandidateChatIds(
      ['a'],
      source({ readRunsSummary: () => [{ runId: '  ', diffFileCount: 0 } as ChatListRunSummary] })
    )
    expect(candidates).toEqual([])
  })
})

describe('runSummaryIsUnsettled', () => {
  it('treats a blank endedAt as unsettled', () => {
    expect(runSummaryIsUnsettled(summary('r1', '   '))).toBe(true)
    expect(runSummaryIsUnsettled(summary('r1'))).toBe(true)
    expect(runSummaryIsUnsettled(summary('r1', '2026-09-07T01:00:00.000Z'))).toBe(false)
  })
})
