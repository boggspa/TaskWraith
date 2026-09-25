import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'module'
import { afterAll, describe, expect, it } from 'vitest'
import { createHostPerfInstrumentation } from '../../../src/host-runtime/HostPerfSnapshot'
import { createHostPerfSnapshotFileWriter } from '../../../src/host-runtime/HostPerfSnapshotFile'
import { createWorkSpanRecorder } from '../../../src/host-shared/perf/WorkSpanRecorder'

const require = createRequire(import.meta.url)
const { createHostRecentSpanUnion, foldHostRecentSpanWindows } =
  require('./hostRecentSpanWindows.cjs') as {
    createHostRecentSpanUnion: () => {
      add: (sample: unknown) => { ok: boolean; reason?: string; tail?: boolean }
      evaluate: (windows: unknown, lanes: unknown) => Fold
    }
    foldHostRecentSpanWindows: (options: unknown) => Fold
  }
const { readHostPerfSnapshotFile } = require('./hostSpans.cjs') as {
  readHostPerfSnapshotFile: (options: Record<string, unknown>) => Record<string, unknown>
}

type Timing = {
  count: number
  totalMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  bytes: number
  fallbackCount: number
}
type EvidenceWindow = {
  role: string
  repetition: number
  censored: boolean
  reasons: string[]
  counters: Record<string, number> | null
  brackets: { leadingSequence: number; trailingSequence: number } | null
  lanes: Record<string, { byKind: Record<string, Timing> }> | null
}
type Fold =
  | { ok: false; reason: string }
  | {
      ok: true
      evidence: {
        union: {
          spans: number
          captures: number
          tailCaptures: number
          holes: Array<Record<string, unknown>>
        }
        windows: EvidenceWindow[]
      }
    }

type Tail = { chats: string[]; rows: unknown[][] }

const T = Date.parse('2026-09-24T12:00:00.000Z')
const LIGHT = 'perf-light_beside_large_live-chat-01'
const HEAVY = 'perf-light_beside_large_live-chat-02'
const LANES = { light: LIGHT, heavy: HEAVY }
const COLUMNS = [
  'seq',
  'chat',
  'kind',
  'resource',
  'startedAt',
  'durationMs',
  'bytes',
  'fallback',
  'reason'
]

type Accepted = {
  chatId: string
  startedAt: number
  durationMs: number
  kind?: string
  resource?: string
  bytes?: number
  fallback?: boolean
  reason?: string | null
}

/**
 * A model Host writer: accepts spans in order into a bounded ring and writes
 * each capture's tail exactly as HostPerfSnapshot encodes it.
 */
function modelHost(options: { ringSize?: number; limit?: number } = {}) {
  const ringSize = options.ringSize ?? 64
  const limit = options.limit ?? 16
  const accepted: Array<Accepted & { seq: number }> = []
  const counters = { sampledOut: 0, rejected: 0, degraded: 0 }
  let sequence = 0
  return {
    counters,
    accept(...spans: Accepted[]) {
      for (const span of spans) accepted.push({ ...span, seq: accepted.length + 1 })
    },
    capture(atMs: number, capture: { dropTail?: boolean } = {}) {
      sequence += 1
      const recorded = accepted.length
      const ring = accepted.slice(Math.max(0, recorded - ringSize))
      const tail = ring.slice(Math.max(0, ring.length - limit))
      const omitted = accepted.slice(0, recorded - tail.length)
      const chats: string[] = []
      const rows = tail.map((span) => {
        let chat = chats.indexOf(span.chatId)
        if (chat < 0) chat = chats.push(span.chatId) - 1
        return [
          span.seq,
          chat,
          span.kind ?? 'host_queue_wait',
          span.resource ?? 'host_chain',
          span.startedAt,
          span.durationMs,
          span.bytes ?? 0,
          span.fallback ?? false,
          span.reason ?? null
        ]
      })
      return {
        sequence,
        capturedAt: new Date(atMs).toISOString(),
        ...(capture.dropTail
          ? {
              truncated: true,
              truncation: { extraSections: true, recentSpans: true, byChat: false }
            }
          : {}),
        workSpans: {
          process: 'host',
          recorded,
          dropped: Math.max(0, recorded - ringSize),
          ...counters,
          ...(capture.dropTail
            ? {}
            : {
                recentSpans: {
                  encoding: 'ring_tail_rows_v1',
                  columns: COLUMNS,
                  limit,
                  fromSeq: tail.length > 0 ? tail[0].seq : null,
                  toSeq: tail.length > 0 ? tail[tail.length - 1].seq : null,
                  omittedMaxStartedAt:
                    omitted.length > 0 ? Math.max(...omitted.map((span) => span.startedAt)) : null,
                  chats,
                  rows
                }
              })
        }
      }
    }
  }
}

function window(startMs: number, endMs: number, settledMs: number | undefined, repetition = 0) {
  return {
    role: 'light-beside',
    repetition,
    startedAtMs: T + startMs,
    endedAtMs: T + endMs,
    ...(settledMs === undefined ? {} : { settledAtMs: T + settledMs })
  }
}

function fold(samples: unknown[], windows: unknown[], lanes: unknown = LANES) {
  const result = foldHostRecentSpanWindows({ samples, windows, lanes })
  if (!result.ok) throw new Error(`fold refused: ${result.reason}`)
  return result.evidence
}

describe('foldHostRecentSpanWindows', () => {
  it('cuts each lane’s spans by start inside the window, with the recorder’s nearest rank', () => {
    const host = modelHost()
    const samples = [host.capture(T + 500)]
    host.accept(
      { chatId: LIGHT, startedAt: T + 999, durationMs: 70 },
      {
        chatId: LIGHT,
        startedAt: T + 1_000,
        durationMs: 12,
        kind: 'durable_commit',
        bytes: 2048,
        fallback: true
      },
      { chatId: LIGHT, startedAt: T + 1_050, durationMs: 5 },
      { chatId: LIGHT, startedAt: T + 1_100, durationMs: 1 },
      { chatId: HEAVY, startedAt: T + 1_200, durationMs: 400, kind: 'durable_commit' },
      { chatId: 'unlabeled', startedAt: T + 1_250, durationMs: 2 },
      { chatId: LIGHT, startedAt: T + 1_400, durationMs: 9 },
      { chatId: LIGHT, startedAt: T + 1_500, durationMs: 3 },
      { chatId: LIGHT, startedAt: T + 2_000, durationMs: 80 }
    )
    samples.push(host.capture(T + 3_000))
    const evidence = fold(samples, [window(1_000, 2_000, 2_500)])
    const [only] = evidence.windows
    expect(only).toMatchObject({
      censored: false,
      reasons: [],
      brackets: { leadingSequence: 1, trailingSequence: 2 }
    })
    // [1, 3, 5, 9]: p50 is rank 2, p95 and p99 are rank 4. The spans at 999
    // and 2000 lie outside [start, end). Kinds come in taxonomy order, not
    // the order the lane's spans arrived in.
    expect(only.lanes?.light.byKind).toEqual({
      host_queue_wait: {
        count: 4,
        totalMs: 18,
        p50Ms: 3,
        p95Ms: 9,
        p99Ms: 9,
        maxMs: 9,
        bytes: 0,
        fallbackCount: 0
      },
      durable_commit: {
        count: 1,
        totalMs: 12,
        p50Ms: 12,
        p95Ms: 12,
        p99Ms: 12,
        maxMs: 12,
        bytes: 2048,
        fallbackCount: 1
      }
    })
    expect(Object.keys(only.lanes?.light.byKind ?? {})).toEqual([
      'host_queue_wait',
      'durable_commit'
    ])
    expect(only.lanes?.heavy.byKind).toEqual({
      durable_commit: expect.objectContaining({ count: 1, p99Ms: 400 })
    })
    expect(JSON.stringify(only)).not.toContain('unlabeled')
  })

  it('unions overlapping tails once, and refuses a sequence two reads disagree on', () => {
    const host = modelHost({ limit: 3 })
    const samples = [host.capture(T)]
    host.accept(
      { chatId: LIGHT, startedAt: T + 100, durationMs: 1 },
      { chatId: LIGHT, startedAt: T + 200, durationMs: 2 }
    )
    samples.push(host.capture(T + 300))
    host.accept({ chatId: LIGHT, startedAt: T + 400, durationMs: 3 })
    samples.push(host.capture(T + 500))
    const evidence = fold(samples, [window(1, 450, 499)])
    expect(evidence.union).toMatchObject({ spans: 3, captures: 3, tailCaptures: 3, holes: [] })
    expect(evidence.windows[0].lanes?.light.byKind.host_queue_wait.count).toBe(3)

    const conflicting = structuredClone(samples[2]) as {
      workSpans: { recentSpans: { rows: number[][] } }
    }
    conflicting.workSpans.recentSpans.rows[0][5] = 99
    expect(
      foldHostRecentSpanWindows({
        samples: [...samples.slice(0, 2), conflicting],
        windows: [],
        lanes: LANES
      })
    ).toEqual({
      ok: false,
      reason: 'samples[2]: recent span 1 differs between reads'
    })
  })

  it('censors a window only when a gap’s lost spans could have started in it before it settled', () => {
    const host = modelHost({ limit: 2 })
    const samples = [host.capture(T + 100)]
    host.accept(
      { chatId: LIGHT, startedAt: T + 1_000, durationMs: 1 },
      { chatId: LIGHT, startedAt: T + 1_100, durationMs: 1 }
    )
    samples.push(host.capture(T + 1_200))
    host.accept(
      { chatId: LIGHT, startedAt: T + 1_300, durationMs: 1 },
      { chatId: LIGHT, startedAt: T + 1_400, durationMs: 1 },
      { chatId: LIGHT, startedAt: T + 1_500, durationMs: 1 }
    )
    samples.push(host.capture(T + 1_600))
    samples.push(host.capture(T + 2_000))
    const evidence = fold(samples, [
      // Span 3 (start 1300) was lost, and it started inside this window.
      window(1_250, 1_700, 1_800),
      // Every lost span started before this window did.
      window(1_301, 1_700, 1_800),
      // This window settled before the gap's spans were accepted.
      window(900, 1_150, 1_199)
    ])
    expect(evidence.union.holes).toEqual([
      {
        sequence: 3,
        capturedAtMs: T + 1_600,
        previousCapturedAtMs: T + 1_200,
        missingFromSeq: 3,
        missingToSeq: 3,
        omittedMaxStartedAt: T + 1_300
      }
    ])
    const [lost, after, before] = evidence.windows
    expect(lost).toMatchObject({ censored: true, reasons: ['transport_hole'], lanes: null })
    expect(after).toMatchObject({ censored: false })
    expect(after.lanes?.light.byKind.host_queue_wait.count).toBe(2)
    expect(before).toMatchObject({ censored: false })
    expect(before.lanes?.light.byKind.host_queue_wait.count).toBe(2)
  })

  it('treats a read that lost its tail as no evidence and lets the next tail decide', () => {
    const reachesBack = modelHost({ limit: 3 })
    const samples = [reachesBack.capture(T)]
    reachesBack.accept(
      { chatId: LIGHT, startedAt: T + 100, durationMs: 1 },
      { chatId: LIGHT, startedAt: T + 200, durationMs: 1 }
    )
    samples.push(reachesBack.capture(T + 300))
    reachesBack.accept({ chatId: LIGHT, startedAt: T + 400, durationMs: 1 })
    samples.push(reachesBack.capture(T + 500, { dropTail: true }))
    reachesBack.accept({ chatId: LIGHT, startedAt: T + 600, durationMs: 1 })
    samples.push(reachesBack.capture(T + 700))
    const kept = fold(samples, [window(50, 650, 699)])
    expect(kept.union).toMatchObject({ spans: 4, captures: 4, tailCaptures: 3, holes: [] })
    expect(kept.windows[0]).toMatchObject({ censored: false })

    const tooShort = modelHost({ limit: 1 })
    const gapped = [tooShort.capture(T)]
    tooShort.accept({ chatId: LIGHT, startedAt: T + 100, durationMs: 1 })
    gapped.push(tooShort.capture(T + 300))
    tooShort.accept({ chatId: LIGHT, startedAt: T + 400, durationMs: 1 })
    gapped.push(tooShort.capture(T + 500, { dropTail: true }))
    tooShort.accept({ chatId: LIGHT, startedAt: T + 600, durationMs: 1 })
    gapped.push(tooShort.capture(T + 700))
    const lost = fold(gapped, [window(350, 650, 699)])
    // The gap is measured from the last read that carried a tail.
    expect(lost.union.holes).toEqual([
      expect.objectContaining({ previousCapturedAtMs: T + 300, missingFromSeq: 2, missingToSeq: 2 })
    ])
    expect(lost.windows[0]).toMatchObject({ censored: true, reasons: ['transport_hole'] })
  })

  it('needs a read before the window and a tail-bearing read after it settles', () => {
    const host = modelHost()
    host.accept({ chatId: LIGHT, startedAt: T + 100, durationMs: 1 })
    const late = host.capture(T + 200)
    const tailless = host.capture(T + 900, { dropTail: true })
    const evidence = fold([late, tailless], [window(150, 300, 400), window(250, 300, 400)])
    expect(evidence.windows[0]).toMatchObject({
      censored: true,
      reasons: ['leading_capture_missing', 'trailing_capture_missing'],
      counters: null,
      brackets: null,
      lanes: null
    })
    expect(evidence.windows[1].reasons).toEqual(['trailing_capture_missing'])
  })

  it('counts spans omitted before the first read as a gap', () => {
    const host = modelHost({ limit: 1 })
    host.accept(
      { chatId: LIGHT, startedAt: T + 100, durationMs: 1 },
      { chatId: LIGHT, startedAt: T + 200, durationMs: 1 }
    )
    const evidence = fold([host.capture(T + 300)], [window(50, 250, 280)])
    expect(evidence.union.holes).toEqual([
      expect.objectContaining({ previousCapturedAtMs: null, missingFromSeq: 1, missingToSeq: 1 })
    ])
    expect(evidence.windows[0].reasons).toEqual(['leading_capture_missing', 'transport_hole'])
  })

  it('censors unknown or impossible settle times and window bounds', () => {
    const host = modelHost()
    const samples = [host.capture(T), host.capture(T + 1_000)]
    const evidence = fold(samples, [
      window(100, 200, undefined),
      window(100, 200, 150),
      { role: 'light-beside', repetition: 1, startedAtMs: T + 200, endedAtMs: T + 200 },
      { role: 'light-beside', repetition: 2, startedAtMs: null, endedAtMs: T + 200 }
    ])
    expect(evidence.windows[0].reasons).toEqual(['settle_unknown', 'trailing_capture_missing'])
    expect(evidence.windows[1].reasons).toEqual(['settle_unknown', 'trailing_capture_missing'])
    expect(evidence.windows[2].reasons).toEqual(['window_bounds_unavailable'])
    expect(evidence.windows[3].reasons).toEqual(['window_bounds_unavailable'])
  })

  it('censors a window whose brackets saw a span lost, rejected or sampled out', () => {
    const host = modelHost()
    host.counters.rejected = 4
    const samples = [host.capture(T)]
    host.accept({ chatId: LIGHT, startedAt: T + 100, durationMs: 1 })
    host.counters.sampledOut = 7
    samples.push(host.capture(T + 500))
    // A stride sampler can keep all of one lane and none of another.
    const sampled = fold(samples, [window(50, 200, 300)])
    expect(sampled.windows[0]).toMatchObject({
      censored: true,
      reasons: ['spans_sampled'],
      counters: { recorded: 1, dropped: 0, sampledOut: 7, rejected: 0, degraded: 0 },
      lanes: null
    })

    for (const counter of ['rejected', 'degraded'] as const) {
      const lossy = modelHost()
      const lossySamples = [lossy.capture(T)]
      lossy.counters[counter] = 1
      lossySamples.push(lossy.capture(T + 500))
      const evidence = fold(lossySamples, [window(50, 200, 300)])
      expect(evidence.windows[0]).toMatchObject({ censored: true, reasons: ['spans_lost'] })
    }
  })

  it('censors a window whose lane contradicts its settle claim', () => {
    const acceptedLate = modelHost()
    const samples = [acceptedLate.capture(T)]
    acceptedLate.accept({ chatId: LIGHT, startedAt: T + 100, durationMs: 1 })
    samples.push(acceptedLate.capture(T + 300))
    acceptedLate.accept({ chatId: LIGHT, startedAt: T + 150, durationMs: 1 })
    samples.push(acceptedLate.capture(T + 600))
    expect(fold(samples, [window(50, 200, 250)]).windows[0]).toMatchObject({
      censored: true,
      reasons: ['settle_violated']
    })
    // Another chat's late span is not this lane's claim to break.
    expect(fold(samples, [window(50, 200, 250)], { light: HEAVY }).windows[0].censored).toBe(false)

    const endedLate = modelHost()
    const late = [endedLate.capture(T)]
    endedLate.accept({ chatId: LIGHT, startedAt: T + 100, durationMs: 200 })
    late.push(endedLate.capture(T + 400))
    expect(fold(late, [window(50, 200, 250)]).windows[0].reasons).toEqual(['settle_violated'])
    expect(fold(late, [window(50, 200, 300)]).windows[0].censored).toBe(false)
  })

  it('puts a capture in a boundary millisecond on the unsafe side', () => {
    // A capture reads its tail, then its clock: a span accepted in the same
    // millisecond may fall on either side of it.
    const atStart = modelHost()
    const leading = [atStart.capture(T + 1_000)]
    atStart.accept({ chatId: LIGHT, startedAt: T + 1_000, durationMs: 0 })
    leading.push(atStart.capture(T + 3_000))
    expect(fold(leading, [window(1_000, 2_000, 2_500)]).windows[0]).toMatchObject({
      censored: true,
      reasons: ['leading_capture_missing']
    })

    const atSettle = modelHost()
    const trailing = [atSettle.capture(T + 500)]
    atSettle.accept({ chatId: LIGHT, startedAt: T + 1_000, durationMs: 1_500 })
    trailing.push(atSettle.capture(T + 2_500))
    expect(fold(trailing, [window(1_000, 2_000, 2_500)]).windows[0]).toMatchObject({
      censored: true,
      reasons: ['trailing_capture_missing']
    })
    trailing.push(atSettle.capture(T + 2_501))
    expect(fold(trailing, [window(1_000, 2_000, 2_500)]).windows[0].censored).toBe(false)

    // A lane span ending at the settle time, accepted after a read stamped
    // with that same millisecond, then pushed out of a one-row tail.
    const gap = modelHost({ limit: 1 })
    const holed = [gap.capture(T + 500)]
    gap.accept({ chatId: LIGHT, startedAt: T + 1_000, durationMs: 1 })
    holed.push(gap.capture(T + 2_500))
    gap.accept(
      { chatId: LIGHT, startedAt: T + 1_900, durationMs: 600 },
      { chatId: HEAVY, startedAt: T + 2_550, durationMs: 1 }
    )
    holed.push(gap.capture(T + 2_600))
    expect(fold(holed, [window(1_000, 2_000, 2_500)]).windows[0]).toMatchObject({
      censored: true,
      reasons: ['transport_hole']
    })
  })

  it('runs its brackets and holes to the settle time, not the window end', () => {
    // A lane span offered after the window ended but before it settled, and
    // rejected: only a trailing read after the settle time counts it.
    const rejected = modelHost()
    const lossy = [rejected.capture(T + 500)]
    rejected.accept({ chatId: LIGHT, startedAt: T + 1_000, durationMs: 1 })
    lossy.push(rejected.capture(T + 2_500))
    rejected.counters.rejected = 1
    lossy.push(rejected.capture(T + 3_500))
    expect(fold(lossy, [window(1_000, 2_000, 3_000)]).windows[0]).toMatchObject({
      censored: true,
      reasons: ['spans_lost'],
      brackets: { leadingSequence: 1, trailingSequence: 3 }
    })

    // A lane span accepted after the window ended but before it settled,
    // then pushed out of a one-row tail: the hole follows a read taken
    // after the window's end and still censors it.
    const pushed = modelHost({ limit: 1 })
    const holed = [pushed.capture(T + 500)]
    pushed.accept({ chatId: LIGHT, startedAt: T + 1_000, durationMs: 1 })
    holed.push(pushed.capture(T + 2_500))
    pushed.accept(
      { chatId: LIGHT, startedAt: T + 1_500, durationMs: 1_200 },
      { chatId: HEAVY, startedAt: T + 2_800, durationMs: 1 }
    )
    holed.push(pushed.capture(T + 3_500))
    expect(fold(holed, [window(1_000, 2_000, 3_000)]).windows[0]).toMatchObject({
      censored: true,
      reasons: ['transport_hole']
    })
  })

  it('censors a hole whose latest lost span started exactly at the window start', () => {
    const host = modelHost({ limit: 1 })
    const samples = [host.capture(T + 500)]
    host.accept(
      { chatId: LIGHT, startedAt: T + 1_000, durationMs: 1 },
      // Started earlier, accepted later: it holds the one-row tail.
      { chatId: HEAVY, startedAt: T + 400, durationMs: 700 }
    )
    samples.push(host.capture(T + 2_600))
    const evidence = fold(samples, [window(1_000, 2_000, 2_500)])
    expect(evidence.union.holes).toEqual([
      expect.objectContaining({
        missingFromSeq: 1,
        missingToSeq: 1,
        omittedMaxStartedAt: T + 1_000
      })
    ])
    expect(evidence.windows[0].reasons).toEqual(['transport_hole'])
  })

  it('finds a one-span hole behind an empty tail', () => {
    const host = modelHost({ limit: 0 })
    const samples = [host.capture(T + 500)]
    host.accept({ chatId: LIGHT, startedAt: T + 1_000, durationMs: 1 })
    samples.push(host.capture(T + 2_600))
    const evidence = fold(samples, [window(1_000, 2_000, 2_500)])
    expect(evidence.union.holes).toEqual([
      expect.objectContaining({ missingFromSeq: 1, missingToSeq: 1 })
    ])
    expect(evidence.windows[0].reasons).toEqual(['transport_hole'])
  })

  it('ranks as the recorder does where rounding would differ (p95 of 12)', () => {
    const durations = [7, 12, 1, 9, 3, 11, 5, 2, 10, 4, 8, 6]
    const host = modelHost()
    const recorder = createWorkSpanRecorder({ process: 'host' })
    const samples = [host.capture(T + 500)]
    for (const [index, durationMs] of durations.entries()) {
      host.accept({ chatId: LIGHT, startedAt: T + 1_000 + index, durationMs })
      recorder.record({
        chatId: LIGHT,
        kind: 'host_queue_wait',
        resource: 'host_chain',
        startedAt: T + 1_000 + index,
        durationMs
      })
    }
    samples.push(host.capture(T + 3_000))
    const timing = fold(samples, [window(1_000, 2_000, 2_500)]).windows[0].lanes?.light.byKind
      .host_queue_wait
    const expected = recorder.snapshot().byKind.host_queue_wait
    expect(timing).toMatchObject({
      count: 12,
      p50Ms: expected?.p50Ms,
      p95Ms: expected?.p95Ms,
      p99Ms: expected?.p99Ms
    })
    expect([timing?.p50Ms, timing?.p95Ms, timing?.p99Ms]).toEqual([6, 12, 12])
  })

  it.each([
    ['chat', (tail: Tail) => void (tail.chats = [HEAVY])],
    ['kind', (tail: Tail) => void (tail.rows[0][2] = 'durable_commit')],
    ['resource', (tail: Tail) => void (tail.rows[0][3] = 'ensemble_pool')],
    ['start', (tail: Tail) => void (tail.rows[0][4] = (tail.rows[0][4] as number) + 1)],
    ['duration', (tail: Tail) => void (tail.rows[0][5] = 99)],
    ['bytes', (tail: Tail) => void (tail.rows[0][6] = 7)],
    ['fallback', (tail: Tail) => void (tail.rows[0][7] = true)],
    ['reason', (tail: Tail) => void (tail.rows[0][8] = 'receipt_poll')]
  ])('refuses a duplicate whose %s differs', (_label, perturb) => {
    const host = modelHost({ limit: 3 })
    host.accept({ chatId: LIGHT, startedAt: T + 100, durationMs: 1, kind: 'persist_barrier' })
    const first = host.capture(T + 200)
    const second = structuredClone(host.capture(T + 300))
    perturb(second.workSpans.recentSpans!)
    expect(
      foldHostRecentSpanWindows({ samples: [first, second], windows: [], lanes: LANES })
    ).toEqual({ ok: false, reason: 'samples[1]: recent span 1 differs between reads' })
  })

  it('folds incrementally to the same evidence as a finished list', () => {
    const host = modelHost({ limit: 2 })
    const samples = [host.capture(T)]
    for (let index = 0; index < 6; index += 1) {
      host.accept({
        chatId: index % 2 ? LIGHT : HEAVY,
        startedAt: T + 100 * (index + 1),
        durationMs: index
      })
      if (index % 2) samples.push(host.capture(T + 100 * (index + 1) + 50))
    }
    const windows = [window(50, 350, 400), window(350, 650, 700, 1)]
    const union = createHostRecentSpanUnion()
    for (const sample of samples) expect(union.add(sample)).toMatchObject({ ok: true, tail: true })
    expect(union.evaluate(windows, LANES)).toEqual(
      foldHostRecentSpanWindows({ samples, windows, lanes: LANES })
    )
  })

  it.each([
    ['a sample that is not an object', () => [null], 'samples[0]: sample must be an object'],
    [
      'a sequence that does not increase',
      (host: ReturnType<typeof modelHost>) => {
        const first = host.capture(T)
        return [first, { ...host.capture(T + 1), sequence: first.sequence }]
      },
      'samples[1]: sample.sequence must increase'
    ],
    [
      'a capture time that goes backwards',
      (host: ReturnType<typeof modelHost>) => [host.capture(T + 10), host.capture(T)],
      'samples[1]: sample.capturedAt went backwards'
    ],
    [
      'counters that go backwards',
      (host: ReturnType<typeof modelHost>) => {
        host.counters.rejected = 2
        const first = host.capture(T)
        host.counters.rejected = 1
        return [first, host.capture(T + 1)]
      },
      'samples[1]: span counters went backwards: the Host recorder restarted or reset'
    ],
    [
      'a malformed tail',
      (host: ReturnType<typeof modelHost>) => {
        const sample = host.capture(T)
        const recentSpans = { ...sample.workSpans.recentSpans!, encoding: 'v0' }
        return [{ ...sample, workSpans: { ...sample.workSpans, recentSpans } }]
      },
      'samples[0]: sample.workSpans.recentSpans: recentSpans.encoding must be ring_tail_rows_v1'
    ],
    [
      'a tail whose start moved backwards',
      (host: ReturnType<typeof modelHost>) => {
        host.accept(
          { chatId: LIGHT, startedAt: T + 1, durationMs: 1 },
          { chatId: LIGHT, startedAt: T + 2, durationMs: 1 },
          { chatId: LIGHT, startedAt: T + 3, durationMs: 1 }
        )
        const gapped = host.capture(T + 10)
        const tail = gapped.workSpans.recentSpans!
        // Keep only the newest row: seqs 1 and 2 become a gap.
        const shortened = {
          ...gapped,
          workSpans: {
            ...gapped.workSpans,
            // Valid on its own (a one-row tail), but the next read's tail
            // reaches back past it.
            recentSpans: {
              ...tail,
              limit: 1,
              fromSeq: 3,
              rows: tail.rows.slice(2),
              omittedMaxStartedAt: T + 2
            }
          }
        }
        return [shortened, host.capture(T + 20)]
      },
      'samples[1]: recent span 1 reappeared after a gap'
    ],
    [
      'a read from another Host',
      (host: ReturnType<typeof modelHost>) => {
        const identity = { process: 'host', instanceId: 'host-1', generation: 1, pid: 4242 }
        return [
          { ...host.capture(T), identity },
          { ...host.capture(T + 1), identity: { ...identity, pid: 4243 } }
        ]
      },
      'samples[1]: sample.identity changed: another Host'
    ],
    [
      'an identity after a read without one',
      (host: ReturnType<typeof modelHost>) => [
        host.capture(T),
        { ...host.capture(T + 1), identity: { instanceId: 'host-1', generation: 1, pid: 1 } }
      ],
      'samples[1]: sample.identity changed: another Host'
    ],
    [
      'a malformed identity',
      (host: ReturnType<typeof modelHost>) => [{ ...host.capture(T), identity: 'host-1' }],
      'samples[0]: sample.identity must be an object'
    ]
  ])('refuses %s, and stays refused', (_label, build, reason) => {
    const host = modelHost({ limit: 3 })
    const samples = (build as (host: ReturnType<typeof modelHost>) => unknown[])(host)
    expect(foldHostRecentSpanWindows({ samples, windows: [], lanes: LANES })).toEqual({
      ok: false,
      reason
    })
    const union = createHostRecentSpanUnion()
    for (const sample of samples) union.add(sample)
    expect(union.evaluate([], LANES)).toMatchObject({ ok: false })
    // A later, valid read cannot clear the refusal.
    expect(union.add(modelHost().capture(T + 60_000))).toMatchObject({ ok: false })
  })

  it.each([
    ['no lanes', {}],
    ['nine lanes', Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`l${i}`, `c${i}`]))],
    ['a label with capitals', { Light: LIGHT }],
    ['one chat on two lanes', { a: LIGHT, b: LIGHT }],
    ['an over-long chat id', { light: 'x'.repeat(257) }]
  ])('refuses %s', (_label, lanes) => {
    expect(foldHostRecentSpanWindows({ samples: [], windows: [], lanes })).toEqual({
      ok: false,
      reason: 'lanes must map 1-8 lowercase labels to distinct chat ids'
    })
  })

  it('refuses a window without a role or repetition', () => {
    expect(
      foldHostRecentSpanWindows({ samples: [], windows: [{ repetition: 0 }], lanes: LANES })
    ).toEqual({ ok: false, reason: 'windows[0].role must be a non-empty string' })
    expect(
      foldHostRecentSpanWindows({
        samples: [],
        windows: [{ role: 'light-alone', repetition: -1 }],
        lanes: LANES
      })
    ).toEqual({ ok: false, reason: 'windows[0].repetition must be a non-negative integer' })
  })
})

describe('per-lane settle times', () => {
  type LaneEvidence = {
    settledAtMs: number | null
    censored: boolean
    reasons: string[]
    counters: Record<string, number> | null
    trailingSequence: number | null
    byKind: Record<string, Timing> | null
  }
  type PerLaneWindow = {
    censored: boolean
    reasons: string[]
    leadingSequence: number | null
    lanes: Record<string, LaneEvidence> | null
  }
  const perLane = (settles: Record<string, number>) => ({
    ...window(1_000, 2_000, undefined),
    laneSettledAtMs: Object.fromEntries(
      Object.entries(settles).map(([label, ms]) => [label, T + ms])
    )
  })
  const foldPerLane = (samples: unknown[], settles: Record<string, number>) =>
    fold(samples, [perLane(settles)]).windows[0] as unknown as PerLaneWindow
  const SETTLES = { light: 2_500, heavy: 5_000 }

  it('judges each lane on its own settle time', () => {
    const host = modelHost()
    const samples = [host.capture(T + 500)]
    host.accept(
      { chatId: LIGHT, startedAt: T + 1_000, durationMs: 100 },
      // Started after the window: never the window's.
      { chatId: LIGHT, startedAt: T + 2_000, durationMs: 1 }
    )
    samples.push(host.capture(T + 2_600))
    // A heavy span still running when the light lane settled.
    host.accept({ chatId: HEAVY, startedAt: T + 1_500, durationMs: 2_000 })
    samples.push(host.capture(T + 5_100))
    const evidence = foldPerLane(samples, SETTLES)
    expect(evidence).toMatchObject({ censored: false, reasons: [], leadingSequence: 1 })
    expect(evidence.lanes?.light).toMatchObject({
      settledAtMs: T + 2_500,
      censored: false,
      reasons: [],
      trailingSequence: 2
    })
    expect(evidence.lanes?.light.byKind?.host_queue_wait.count).toBe(1)
    expect(evidence.lanes?.heavy).toMatchObject({
      settledAtMs: T + 5_000,
      censored: false,
      trailingSequence: 3
    })
    expect(evidence.lanes?.heavy.byKind?.host_queue_wait).toMatchObject({ count: 1, maxMs: 2_000 })
    // One settle time for both would have censored the window.
    expect(fold(samples, [window(1_000, 2_000, 2_500)]).windows[0].reasons).toEqual([
      'settle_violated'
    ])
  })

  it('censors only the lane whose own settle claim breaks', () => {
    const host = modelHost()
    const samples = [host.capture(T + 500)]
    host.accept({ chatId: LIGHT, startedAt: T + 1_000, durationMs: 100 })
    samples.push(host.capture(T + 5_100))
    host.accept({ chatId: HEAVY, startedAt: T + 1_500, durationMs: 4_500 })
    samples.push(host.capture(T + 6_100))
    const evidence = foldPerLane(samples, SETTLES)
    expect(evidence.censored).toBe(true)
    expect(evidence.reasons).toEqual([])
    expect(evidence.lanes?.light).toMatchObject({ censored: false, reasons: [] })
    expect(evidence.lanes?.heavy).toMatchObject({
      censored: true,
      reasons: ['settle_violated'],
      byKind: null
    })
  })

  it('lets a hole after the light lane settled censor only the heavy lane', () => {
    const host = modelHost({ limit: 1 })
    const samples = [host.capture(T + 500)]
    host.accept({ chatId: LIGHT, startedAt: T + 1_000, durationMs: 1 })
    samples.push(host.capture(T + 2_600))
    host.accept(
      { chatId: HEAVY, startedAt: T + 1_500, durationMs: 2_000 },
      { chatId: HEAVY, startedAt: T + 3_000, durationMs: 1 }
    )
    samples.push(host.capture(T + 5_100))
    const evidence = foldPerLane(samples, SETTLES)
    expect(evidence.lanes?.light).toMatchObject({ censored: false })
    expect(evidence.lanes?.heavy).toMatchObject({ censored: true, reasons: ['transport_hole'] })
    // At the light lane's own settle time, the same hole censors it too.
    expect(foldPerLane(samples, { light: 2_600, heavy: 5_000 }).lanes?.light).toMatchObject({
      censored: true,
      reasons: ['transport_hole']
    })
  })

  it('counts a loss after the light lane settled against the heavy lane only', () => {
    const host = modelHost()
    const samples = [host.capture(T + 500)]
    host.accept({ chatId: LIGHT, startedAt: T + 1_000, durationMs: 1 })
    samples.push(host.capture(T + 2_600))
    host.counters.rejected = 1
    samples.push(host.capture(T + 5_100))
    const evidence = foldPerLane(samples, SETTLES)
    expect(evidence.lanes?.light).toMatchObject({
      censored: false,
      counters: { recorded: 1, rejected: 0 }
    })
    expect(evidence.lanes?.heavy).toMatchObject({
      censored: true,
      reasons: ['spans_lost'],
      counters: { recorded: 1, rejected: 1 }
    })
  })

  it('shares only what every lane shares, and censors a lane with no settle time', () => {
    const host = modelHost()
    host.accept({ chatId: LIGHT, startedAt: T + 1_000, durationMs: 1 })
    const late = [host.capture(T + 1_500), host.capture(T + 5_100)]
    const unled = foldPerLane(late, SETTLES)
    expect(unled.reasons).toEqual(['leading_capture_missing'])
    expect(unled.leadingSequence).toBeNull()
    expect(unled.lanes?.light.reasons).toEqual(['leading_capture_missing'])
    expect(unled.lanes?.heavy.reasons).toEqual(['leading_capture_missing'])

    const led = [
      modelHost().capture(T + 500),
      ...late.map((sample, index) => ({ ...sample, sequence: index + 2 }))
    ]
    const unsettled = foldPerLane(led, { light: 2_500 })
    expect(unsettled.lanes?.light).toMatchObject({ censored: false })
    expect(unsettled.lanes?.heavy).toMatchObject({
      settledAtMs: null,
      censored: true,
      reasons: ['settle_unknown', 'trailing_capture_missing']
    })
    expect(foldPerLane(led, { light: 2_500, heavy: 1_999 }).lanes?.heavy.reasons).toEqual([
      'settle_unknown',
      'trailing_capture_missing'
    ])
  })

  it('refuses settle times for a lane it does not measure, and bounds it cannot use', () => {
    const samples = [modelHost().capture(T)]
    expect(
      foldHostRecentSpanWindows({
        samples,
        windows: [perLane({ light: 2_500, other: 3_000 })],
        lanes: LANES
      })
    ).toEqual({
      ok: false,
      reason: 'windows[0].laneSettledAtMs must map measured lanes to settle times'
    })
    expect(
      foldHostRecentSpanWindows({
        samples,
        windows: [{ ...perLane(SETTLES), laneSettledAtMs: [T] }],
        lanes: LANES
      })
    ).toMatchObject({ ok: false })
    const unbounded = fold(samples, [{ ...perLane(SETTLES), endedAtMs: T + 1_000 }])
      .windows[0] as unknown as PerLaneWindow
    expect(unbounded).toMatchObject({
      censored: true,
      reasons: ['window_bounds_unavailable'],
      lanes: null
    })
  })
})

describe('the Host writer, the snapshot file and the fold, end to end', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })
  const IDENTITY = { process: 'host' as const, instanceId: 'host-e2e', generation: 1, pid: 4242 }

  /** A real Host instrumentation and writer, read back through the real reader. */
  function realHost(recentSpanLimit: number) {
    const dir = mkdtempSync(join(tmpdir(), 'host-recent-spans-e2e-'))
    dirs.push(dir)
    const path = join(dir, 'host-snapshot.json')
    const instrumentation = createHostPerfInstrumentation({ recentSpanLimit })
    let clock = T
    const writer = createHostPerfSnapshotFileWriter({
      instrumentation,
      path,
      intervalMs: 5_000,
      maxBytes: 256 * 1024,
      identity: IDENTITY,
      now: () => new Date(clock)
    })
    return {
      record: (chatId: string, startedAt: number, durationMs = 3) =>
        instrumentation.spans.record({
          chatId,
          runId: 'cmd-1',
          kind: 'host_queue_wait',
          resource: 'host_chain',
          startedAt: T + startedAt,
          durationMs
        }),
      capture(atMs: number) {
        clock = T + atMs
        expect(writer.writeOnce()).toBe(true)
        const read = readHostPerfSnapshotFile({
          hostPerfSnapshotPath: path,
          expectedIdentity: IDENTITY,
          now: () => new Date(T + atMs + 1_000),
          keepRecentSpans: true
        })
        expect(read.unsupported).toBeUndefined()
        return read
      }
    }
  }

  it('cuts per-lane windows from what the Host actually wrote', () => {
    const host = realHost(8)
    const samples = [host.capture(0)]
    host.record(LIGHT, 1_000, 4)
    host.record(HEAVY, 1_100, 90)
    host.record(LIGHT, 1_200, 2)
    samples.push(host.capture(5_000))
    host.record(LIGHT, 6_000, 8)
    samples.push(host.capture(10_000))
    const evidence = fold(samples, [window(500, 2_000, 4_000), window(5_500, 7_000, 9_000, 1)])
    expect(evidence.union).toMatchObject({ spans: 4, holes: [] })
    const [first, second] = evidence.windows
    expect(first).toMatchObject({
      censored: false,
      brackets: { leadingSequence: 1, trailingSequence: 2 }
    })
    expect(first.lanes?.light.byKind.host_queue_wait).toMatchObject({
      count: 2,
      p50Ms: 2,
      maxMs: 4
    })
    expect(first.lanes?.heavy.byKind.host_queue_wait).toMatchObject({ count: 1, maxMs: 90 })
    expect(second).toMatchObject({ censored: false })
    expect(second.lanes?.light.byKind.host_queue_wait.count).toBe(1)
    expect(second.lanes?.heavy.byKind).toEqual({})
  })

  it('censors the window a too-short tail lost a span from', () => {
    const host = realHost(2)
    const samples = [host.capture(0)]
    host.record(LIGHT, 1_000)
    host.record(LIGHT, 1_100)
    host.record(LIGHT, 1_200)
    samples.push(host.capture(5_000))
    const evidence = fold(samples, [window(500, 2_000, 4_000), window(1_150, 2_000, 4_000, 1)])
    expect(evidence.union.holes).toEqual([
      expect.objectContaining({
        missingFromSeq: 1,
        missingToSeq: 1,
        omittedMaxStartedAt: T + 1_000
      })
    ])
    expect(evidence.windows[0]).toMatchObject({ censored: true, reasons: ['transport_hole'] })
    expect(evidence.windows[1]).toMatchObject({ censored: false })
  })
})
