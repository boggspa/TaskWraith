import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildContinuationHopsChangeRequest,
  DEFAULT_CONTINUATION_HOPS,
  MAX_CONTINUATION_HOPS,
  MIN_CONTINUATION_HOPS
} from './continuationHopsChangeRequest'

describe('buildContinuationHopsChangeRequest', () => {
  it('captures the chat-level value before an optimistic save', () => {
    expect(
      buildContinuationHopsChangeRequest(
        'chat-1',
        { maxContinuationHops: 4, activeRound: { maxContinuationHops: 3 } },
        12
      )
    ).toEqual({
      chatId: 'chat-1',
      maxContinuationHops: 12,
      previousMaxContinuationHops: 4
    })
  })

  it('falls through to the live-round snapshot, then the product default', () => {
    expect(
      buildContinuationHopsChangeRequest('chat-1', { activeRound: { maxContinuationHops: 9 } }, 10)
        ?.previousMaxContinuationHops
    ).toBe(9)
    expect(buildContinuationHopsChangeRequest('chat-1', {}, 10)?.previousMaxContinuationHops).toBe(
      DEFAULT_CONTINUATION_HOPS
    )
    expect(
      buildContinuationHopsChangeRequest(
        'chat-1',
        { maxContinuationHops: Number.NaN, activeRound: { maxContinuationHops: 11 } },
        12
      )?.previousMaxContinuationHops
    ).toBe(11)
  })

  it('clamps and rounds exactly once before comparing the two sides', () => {
    expect(
      buildContinuationHopsChangeRequest('chat-1', { maxContinuationHops: 8 }, -10)
        ?.maxContinuationHops
    ).toBe(MIN_CONTINUATION_HOPS)
    expect(
      buildContinuationHopsChangeRequest('chat-1', { maxContinuationHops: 8 }, 5000)
        ?.maxContinuationHops
    ).toBe(MAX_CONTINUATION_HOPS)
    expect(
      buildContinuationHopsChangeRequest('chat-1', { maxContinuationHops: 8 }, 11.6)
        ?.maxContinuationHops
    ).toBe(12)
  })

  it('rejects non-finite requests and no-op changes', () => {
    expect(
      buildContinuationHopsChangeRequest('chat-1', { maxContinuationHops: 8 }, Number.NaN)
    ).toBeNull()
    expect(buildContinuationHopsChangeRequest('chat-1', { maxContinuationHops: 8 }, 8)).toBeNull()
  })
})

describe('roster-surface wiring', () => {
  const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
  const layoutSource = readFileSync(
    new URL('../app/views/MainAppLayout.tsx', import.meta.url),
    'utf8'
  )

  it('sends both sides from the main and multiview callback', () => {
    expect(appSource).toContain(
      'buildContinuationHopsChangeRequest(chatId, source.ensemble, nextMax)'
    )
    expect(appSource).toContain('previousMaxContinuationHops?: number')
    expect(appSource).toContain('patch.maxContinuationHops === undefined &&')
    expect(appSource).toContain('requestLiveEnsembleRoundConfigUpdate(chatId, {')
    expect(appSource).toContain('previousMaxContinuationHops: change.previousMaxContinuationHops')
  })

  it('uses the same authoritative request from the linked side-chat popover', () => {
    expect(layoutSource).toContain('const updateSideMaxContinuationHops = (value: number): void =>')
    expect(layoutSource).toContain('const change = buildContinuationHopsChangeRequest(')
    expect(layoutSource).toContain('sideChat.appChatId,')
    expect(layoutSource).toContain('sideChat.ensemble,')
    expect(layoutSource).toContain('.updateLiveEnsembleRoundConfig(change)')
    expect(layoutSource).toContain(
      'updateCurrentEnsembleMaxContinuationHops: updateSideMaxContinuationHops'
    )
  })
})
