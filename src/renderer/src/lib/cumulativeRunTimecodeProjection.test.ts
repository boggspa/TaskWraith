import { describe, expect, it } from 'vitest'
import type { ChatListItem, ChatRecord, ChatRun } from '../../../main/store/types'
import { computeCumulativeRunBaseMs, resolveCumulativeRunBaseMs } from './cumulativeRunTimecode'
import { demoteChatToSummary } from './chatByteLru'
import { projectRendererChatListItem } from '../state/rendererChatListProjection'
import { catalogueChatListItem } from '../../../main/store/ThreadCatalogueMirror'
import { projectThreadCatalogueRecord } from '../../../main/store/ThreadCatalogueFromRecord'
import { copyThreadCatalogueProjection } from '../../../host-shared/thread-catalogue/ThreadCatalogueProjection'

/*
 * The composer's TOTAL THREAD timecode read `chat.runs`, and every projection
 * of a chat record ships `runs: []`. A thread opened from the thread catalogue
 * IS one of those projections, so the timecode measured an empty array and
 * painted 00:00:00:00 over the thread's whole history — reproduced 2026-09-11
 * against a real profile record whose canonical `runs` held two sealed runs
 * (2.950s + 7.325s) while the renderer's `currentChat.runs` was `[]`.
 *
 * These are the exact producers on that path. Each one is asserted separately:
 * deleting any single `runWallMs` stamp must red a named case here, not be
 * absorbed by a sibling.
 */

const FIRST_RUN_MS = 2_950
const SECOND_RUN_MS = 7_325
const TOTAL_MS = FIRST_RUN_MS + SECOND_RUN_MS
const WHOLE_ROUND_TOTAL_MS = 50_000

function run(overrides: Partial<ChatRun>): ChatRun {
  return { runId: 'r', startedAt: '2026-09-11T13:40:27.195Z', ...overrides } as ChatRun
}

const SEALED_RUNS: ChatRun[] = [
  run({
    runId: '1789134027008-ltwlnkur7hs',
    status: 'success',
    startedAt: '2026-09-11T13:40:27.195Z',
    endedAt: '2026-09-11T13:40:30.145Z'
  }),
  run({
    runId: '1789134043513-4fml364n32j',
    status: 'success',
    startedAt: '2026-09-11T13:40:43.621Z',
    endedAt: '2026-09-11T13:40:50.946Z'
  })
]

function hydratedChat(): ChatRecord {
  return {
    appChatId: 'a73f9177-74d0-44e8-8d9b-f7a1905b72f3',
    title: 'hi',
    scope: 'global',
    chatKind: 'single',
    provider: 'claude',
    createdAt: 1_789_134_020_000,
    updatedAt: 1_789_134_050_946,
    archived: false,
    messages: [],
    runs: SEALED_RUNS
  } as unknown as ChatRecord
}

function wholeRoundChat(live = false): ChatRecord {
  const runs: ChatRun[] = [
    run({
      runId: 'round-1-seat-a',
      ensembleRoundId: 'round-1',
      startedAt: '2026-09-11T00:00:00.000Z',
      endedAt: '2026-09-11T00:00:10.000Z'
    }),
    run({
      runId: 'round-1-seat-b',
      ensembleRoundId: 'round-1',
      startedAt: '2026-09-11T00:00:15.000Z',
      endedAt: '2026-09-11T00:00:25.000Z'
    }),
    ...(live
      ? [
          run({
            runId: 'round-live-seat-a',
            ensembleRoundId: 'round-live',
            startedAt: '2026-09-11T00:01:00.000Z',
            endedAt: '2026-09-11T00:01:10.000Z'
          }),
          run({
            runId: 'round-live-seat-b',
            ensembleRoundId: 'round-live',
            startedAt: '2026-09-11T00:01:15.000Z'
          })
        ]
      : [
          run({
            runId: 'round-2-seat-a',
            ensembleRoundId: 'round-2',
            startedAt: '2026-09-11T00:01:02.000Z',
            endedAt: '2026-09-11T00:01:10.000Z'
          })
        ])
  ]
  const roundId = live ? 'round-live' : 'round-2'
  return {
    appChatId: live ? 'ensemble-live' : 'ensemble-terminal',
    title: 'Timer projection fixture',
    scope: 'workspace',
    chatKind: 'ensemble',
    createdAt: Date.parse('2026-09-11T00:00:00.000Z'),
    updatedAt: Date.parse('2026-09-11T00:01:20.000Z'),
    archived: false,
    messages: [],
    runs,
    ensemble: {
      enabled: true,
      maxParticipants: 2,
      participants: [],
      roundWallMsById: { 'round-1': 30_000 },
      activeRound: {
        roundId,
        status: live ? 'running' : 'completed',
        prompt: 'Exercise projection timing.',
        startedAt: '2026-09-11T00:01:00.000Z',
        ...(!live ? { endedAt: '2026-09-11T00:01:20.000Z' } : {}),
        participants: []
      }
    }
  }
}

describe('the arithmetic these projections must preserve', () => {
  it('is the union of the two sealed runs', () => {
    expect(computeCumulativeRunBaseMs(SEALED_RUNS)).toBe(TOTAL_MS)
    expect(resolveCumulativeRunBaseMs(hydratedChat())).toBe(TOTAL_MS)
  })

  it('uses exact whole-round durations instead of summing seat activity', () => {
    expect(resolveCumulativeRunBaseMs(wholeRoundChat())).toBe(WHOLE_ROUND_TOTAL_MS)
  })
})

describe('whole-round time through runs-stripped projections', () => {
  it('survives the thread catalogue and its bounded copier', () => {
    const chat = wholeRoundChat()
    const projection = projectThreadCatalogueRecord(chat)
    const row = catalogueChatListItem(projection)
    const copied = copyThreadCatalogueProjection(projection, chat.appChatId)

    expect(row.runWallMs).toBe(WHOLE_ROUND_TOTAL_MS)
    expect(resolveCumulativeRunBaseMs(row)).toBe(WHOLE_ROUND_TOTAL_MS)
    expect(copied?.summary.runWallMs).toBe(WHOLE_ROUND_TOTAL_MS)
  })

  it('survives renderer demotion without retaining the round ledger', () => {
    const demoted = demoteChatToSummary(wholeRoundChat())
    expect(demoted.runWallMs).toBe(WHOLE_ROUND_TOTAL_MS)
    expect(demoted.ensemble).not.toHaveProperty('roundWallMsById')
    expect(resolveCumulativeRunBaseMs(demoted)).toBe(WHOLE_ROUND_TOTAL_MS)

    const projected = projectRendererChatListItem(wholeRoundChat())
    expect(projected.runWallMs).toBe(WHOLE_ROUND_TOTAL_MS)
    expect(projected.ensemble).not.toHaveProperty('roundWallMsById')
  })

  it('carries only completed rounds while the current round remains live', () => {
    const chat = wholeRoundChat(true)
    const demoted = demoteChatToSummary(chat)

    expect(demoted.runWallMs).toBe(30_000)
    expect(resolveCumulativeRunBaseMs(demoted, '2026-09-11T00:01:00.000Z')).toBe(30_000)
  })
})

describe('resolveCumulativeRunBaseMs over a runs-stripped projection', () => {
  it('survives the thread catalogue row — the reproduced bug', () => {
    const row = catalogueChatListItem(projectThreadCatalogueRecord(hydratedChat()))

    // The row really is the shape that broke it.
    expect(row.summaryOnly).toBe(true)
    expect(row.catalogueProjection).toBe(true)
    expect(row.runs).toEqual([])
    expect(row.runCount).toBe(2)

    expect(resolveCumulativeRunBaseMs(row)).toBe(TOTAL_MS)
  })

  it('survives a renderer byte-LRU demotion', () => {
    const demoted = demoteChatToSummary(hydratedChat())
    expect(demoted.runs).toEqual([])
    expect(resolveCumulativeRunBaseMs(demoted)).toBe(TOTAL_MS)
  })

  it('survives the renderer chat-list projection', () => {
    const projected = projectRendererChatListItem(hydratedChat())
    expect(projected.runs).toEqual([])
    expect(resolveCumulativeRunBaseMs(projected)).toBe(TOTAL_MS)
  })

  it('carries the scalar forward when a summary row is re-projected from a summary', () => {
    const once = projectRendererChatListItem(hydratedChat())
    const twice = projectRendererChatListItem(once, once)
    expect(twice.runWallMs).toBe(TOTAL_MS)
    expect(resolveCumulativeRunBaseMs(twice)).toBe(TOTAL_MS)
  })

  it('round-trips the scalar through the bounded catalogue copier', () => {
    const chat = hydratedChat()
    const copied = copyThreadCatalogueProjection(projectThreadCatalogueRecord(chat), chat.appChatId)
    expect(copied?.summary.runWallMs).toBe(TOTAL_MS)
  })

  it('rejects a malformed scalar at the catalogue boundary rather than storing it', () => {
    const chat = hydratedChat()
    const projection = projectThreadCatalogueRecord(chat)
    const poisoned = {
      ...projection,
      summary: { ...projection.summary, runWallMs: -1 }
    }
    expect(copyThreadCatalogueProjection(poisoned, chat.appChatId)).toBeNull()
  })
})

describe('rows that never learned the field', () => {
  it('falls back to the tail run rather than reading as a thread that never ran', () => {
    const legacy = {
      appChatId: 'legacy',
      summaryOnly: true,
      messages: [],
      runs: [],
      messageCount: 11,
      runCount: 2,
      lastRun: SEALED_RUNS[1]
    } as unknown as ChatListItem

    expect(resolveCumulativeRunBaseMs(legacy)).toBe(SECOND_RUN_MS)
  })

  it('is zero only when the row genuinely has no completed run', () => {
    const empty = {
      appChatId: 'empty',
      summaryOnly: true,
      messages: [],
      runs: [],
      messageCount: 0,
      runCount: 0
    } as unknown as ChatListItem

    expect(resolveCumulativeRunBaseMs(empty)).toBe(0)
    expect(resolveCumulativeRunBaseMs(null)).toBe(0)
    expect(resolveCumulativeRunBaseMs(undefined)).toBe(0)
  })
})

describe('a hydrated record still owns the exact answer', () => {
  it('caps completed spans at the live boundary, unchanged', () => {
    const chat = hydratedChat()
    // Second run treated as the live one: only the first contributes to the base.
    expect(resolveCumulativeRunBaseMs(chat, '2026-09-11T13:40:43.621Z')).toBe(FIRST_RUN_MS)
  })

  it('ignores a stale carried scalar when the canonical array is present', () => {
    const chat = { ...hydratedChat(), runWallMs: 1 } as unknown as ChatRecord
    expect(resolveCumulativeRunBaseMs(chat)).toBe(TOTAL_MS)
  })

  it('prefers the larger of a carried scalar and a bounded run page on a shell', () => {
    // A paged shell carries a TAIL of the runs; measuring from it alone would
    // understate the thread, so the carried union has to win.
    const shell = {
      appChatId: 'paged',
      summaryOnly: true,
      transcriptPaged: true,
      messages: [],
      runs: [SEALED_RUNS[1]],
      messageCount: 11,
      runCount: 2,
      runWallMs: TOTAL_MS
    } as unknown as ChatListItem

    expect(resolveCumulativeRunBaseMs(shell)).toBe(TOTAL_MS)
  })
})
