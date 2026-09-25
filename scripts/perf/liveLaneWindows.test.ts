import { createRequire } from 'module'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type LightRound = {
  roundId: string
  sentAtMs: number
  acceptedAtMs: number
  pageMs: number | null
  endedAtMs: number | null
  status: string | null
  control?: Record<string, unknown>
}
type WindowRecord = {
  repetition: number
  startedAtMs: number
  endedAtMs: number
  laneSettledAtMs: { light: number | null; heavy: number }
  reasons: string[]
  light: {
    rounds: number
    drainedAtMs: number | null
    statuses: Array<string | null>
    roundStartPage: Record<string, number> | null
    cancelPage: Record<string, number> | null
    cancels: number
  }
  heavy: { idleMs: number }
  d1: { deferredAppends: number; normalSaves: number } | null
  main: {
    ringRise: Record<string, number> | null
    lanes: Record<string, Record<string, Record<string, number>>>
  } | null
  host: Record<string, unknown> | null
}
type Result = { windows: WindowRecord[]; verdict: { ok: boolean; reasons: string[] } }

const windowsModule = require('./liveLaneWindows.cjs') as {
  MAIN_WORK_SPANS_GLOBAL: string
  heavyIdleWithin: (heavy: unknown, startMs: number, endMs: number) => number
  mainWorkSpanWindowExpression: (query: unknown) => string
  pageTimings: (values: unknown[]) => Record<string, number> | null
  parseMainWorkSpanWindow: (text: unknown) => { ok: boolean; reason?: string; window?: unknown }
  runLiveLaneWindows: (options: Record<string, unknown>) => Promise<Result>
}
const { createHostRecentSpanUnion } = require('./collectors/hostRecentSpanWindows.cjs') as {
  createHostRecentSpanUnion: () => {
    add: (sample: unknown) => { ok: boolean }
    evaluate: (windows: unknown, lanes: unknown) => unknown
  }
}

const LIGHT = 'perf-light_beside_large_live-chat-01'
const HEAVY = 'perf-light_beside_large_live-chat-02'
const T0 = Date.parse('2026-09-24T12:00:00.000Z')
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

type Span = {
  chatId: string
  kind: string
  startedAt: number
  durationMs: number
  acceptedAtMs: number
}

/**
 * A scripted world on a virtual clock: lanes that run light rounds and keep a
 * heavy round going, main's recorder behind the S3a read, D1 counters, and a
 * Host whose captures feed the S3b union.
 */
function world(
  options: {
    lightRoundMs?: number
    heavyRoundMs?: number
    deferredPerWindow?: number
    lightFailure?: string | null
    heavyFailureAtMs?: number
    heavyGapMs?: number
    mainRefusal?: string
    mainEvicts?: boolean
    mainSampledAtMs?: number
    omitLightRoundStart?: boolean
    mainDropsHeavy?: boolean
    mainRejectsAtMs?: number
    d1Unavailable?: boolean
    hostRejectsAtMs?: number
  } = {}
) {
  let now = T0
  const lightRoundMs = options.lightRoundMs ?? 10_000
  const heavyRoundMs = options.heavyRoundMs ?? 40_000
  const heavyGapMs = options.heavyGapMs ?? 50
  const spans: Span[] = []
  const ring = { recorded: 0, dropped: 0, sampledOut: 0, rejected: 0, degraded: 0 }
  let deferredAppends = 0
  const heavy = {
    rounds: [] as Array<{ roundId: string; acceptedAtMs: number; endedAtMs: number | null }>,
    idle: [] as Array<{ fromMs: number; toMs: number }>,
    failure: null as string | null
  }
  const lightState = { failure: null as string | null }
  let lightIndex = 0
  const readsAt: number[] = []
  const d1ReadsAt: number[] = []

  const hostUnion = createHostRecentSpanUnion()
  let hostSequence = 0
  const hostCounters = { sampledOut: 0, rejected: 0, degraded: 0 }
  const hostAccepted: Array<Span & { seq: number }> = []

  const addSpan = (span: Span) => {
    spans.push(span)
    ring.recorded += 1
    hostAccepted.push({ ...span, seq: hostAccepted.length + 1 })
  }

  // The heavy lane: rounds back to back from before the first window.
  const heavyRoundAt = (acceptedAtMs: number) => {
    const roundId = `heavy-${heavy.rounds.length + 1}`
    heavy.rounds.push({ roundId, acceptedAtMs, endedAtMs: null })
  }
  heavyRoundAt(T0 - 5_000)

  /** Move the clock, letting the heavy lane and the Host run meanwhile. */
  const advanceTo = (target: number) => {
    while (now < target) {
      const next = Math.min(target, Math.floor(now / 1_000) * 1_000 + 1_000)
      now = next
      const current = heavy.rounds[heavy.rounds.length - 1]
      if (
        options.heavyFailureAtMs !== undefined &&
        heavy.failure === null &&
        now >= T0 + options.heavyFailureAtMs
      ) {
        heavy.failure = 'heavy_unobserved'
      }
      // Exact times, not ticks: a round ends heavyRoundMs after it was
      // accepted, and the next is accepted heavyGapMs after that.
      if (
        heavy.failure === null &&
        current.endedAtMs === null &&
        now - current.acceptedAtMs >= heavyRoundMs
      ) {
        const endedAtMs = current.acceptedAtMs + heavyRoundMs
        current.endedAtMs = endedAtMs
        addSpan({
          chatId: HEAVY,
          kind: 'durable_commit',
          startedAt: endedAtMs - 800,
          durationMs: 800,
          acceptedAtMs: now
        })
        heavy.idle.push({ fromMs: endedAtMs, toMs: endedAtMs + heavyGapMs })
        heavyRoundAt(endedAtMs + heavyGapMs)
      }
      if (heavy.failure === null && now % 5_000 === 0) {
        addSpan({
          chatId: HEAVY,
          kind: 'persist_barrier',
          startedAt: now - 300,
          durationMs: 300,
          acceptedAtMs: now
        })
      }
      if (options.mainSampledAtMs !== undefined && now === T0 + options.mainSampledAtMs) {
        ring.sampledOut += 1
      }
      if (options.mainRejectsAtMs !== undefined && now === T0 + options.mainRejectsAtMs) {
        ring.rejected += 1
      }
      if (options.hostRejectsAtMs !== undefined && now === T0 + options.hostRejectsAtMs) {
        hostCounters.rejected += 1
      }
      if (now % 5_000 === 0) hostCapture()
    }
  }

  const hostCapture = () => {
    hostSequence += 1
    const recorded = hostAccepted.length
    const tail = hostAccepted.slice(Math.max(0, recorded - 1_024))
    const chats: string[] = []
    const rows = tail.map((span) => {
      let chat = chats.indexOf(span.chatId)
      if (chat < 0) chat = chats.push(span.chatId) - 1
      return [
        span.seq,
        chat,
        span.kind,
        'host_chain',
        span.startedAt,
        span.durationMs,
        0,
        false,
        null
      ]
    })
    hostUnion.add({
      identity: { process: 'host', instanceId: 'host-1', generation: 1, pid: 4242 },
      sequence: hostSequence,
      capturedAt: new Date(now).toISOString(),
      workSpans: {
        process: 'host',
        recorded,
        dropped: 0,
        ...hostCounters,
        recentSpans: {
          encoding: 'ring_tail_rows_v1',
          columns: COLUMNS,
          limit: 1_024,
          fromSeq: tail.length > 0 ? tail[0].seq : null,
          toSeq: tail.length > 0 ? tail[tail.length - 1].seq : null,
          omittedMaxStartedAt: null,
          chats,
          rows
        }
      }
    })
  }
  hostCapture()

  const lanes = {
    snapshot: () => ({
      observer: { failure: null },
      light: { failure: lightState.failure },
      heavy: {
        rounds: heavy.rounds.map((round) => ({ ...round })),
        idle: heavy.idle.map((interval) => ({ ...interval })),
        failure: heavy.failure
      }
    }),
    runLight: async ({ untilMs }: { untilMs: number }) => {
      const rounds: LightRound[] = []
      if (options.lightFailure) {
        lightState.failure = options.lightFailure
        return { rounds, failure: options.lightFailure, drainedAtMs: null }
      }
      while (now < untilMs) {
        lightIndex += 1
        const sentAtMs = now
        advanceTo(now + 200)
        if (!options.omitLightRoundStart) {
          addSpan({
            chatId: LIGHT,
            kind: 'round_start',
            startedAt: sentAtMs + 10,
            durationMs: 150,
            acceptedAtMs: now
          })
        }
        deferredAppends += (options.deferredPerWindow ?? 12) / Math.ceil(120_000 / lightRoundMs)
        const round: LightRound = {
          roundId: `light-${lightIndex}`,
          sentAtMs,
          acceptedAtMs: now,
          pageMs: 180 + (lightIndex % 3) * 10,
          endedAtMs: null,
          status: null
        }
        if (lightIndex % 4 === 0) {
          round.control = { action: 'cancel', pageMs: 25 + lightIndex, ok: true, cancelled: true }
        }
        advanceTo(now + lightRoundMs)
        round.endedAtMs = now
        round.status = round.control ? 'cancelled' : 'completed'
        addSpan({
          chatId: LIGHT,
          kind: 'persist_barrier',
          startedAt: now - 40,
          durationMs: 40,
          acceptedAtMs: now
        })
        rounds.push(round)
        if (now >= untilMs) break
        advanceTo(now + 1_000)
      }
      return {
        rounds,
        failure: null,
        drainedAtMs: rounds.length ? rounds[rounds.length - 1].endedAtMs : null
      }
    }
  }

  const readMainWindow = async (query: {
    lanes: Record<string, string>
    sinceMs: number
    untilMs: number
  }) => {
    readsAt.push(now)
    if (options.mainRefusal) return JSON.stringify({ sampledAt: now, refused: options.mainRefusal })
    const laneSpans = (chatId: string) =>
      spans
        .filter(
          (span) =>
            span.chatId === chatId &&
            span.startedAt >= query.sinceMs &&
            span.startedAt < query.untilMs
        )
        .map((span) => ({
          kind: span.kind,
          startedAt: span.startedAt,
          durationMs: span.durationMs,
          resource: 'none',
          bytes: 0,
          fallback: false
        }))
    return JSON.stringify({
      sampledAt: now,
      sinceMs: query.sinceMs,
      untilMs: query.untilMs,
      censored: options.mainEvicts === true,
      ring: { ...ring },
      lanes: {
        light: { spans: laneSpans(query.lanes.light), admission: null },
        heavy: {
          spans: options.mainDropsHeavy ? [] : laneSpans(query.lanes.heavy),
          admission: null
        }
      },
      admission: null
    })
  }
  const readD1Counters = async () => {
    d1ReadsAt.push(now)
    if (options.d1Unavailable) return null
    return {
      deferredAppends: Math.floor(deferredAppends),
      normalSaves: Math.floor(deferredAppends / 3)
    }
  }

  return {
    lanes,
    hostUnion,
    readMainWindow,
    readD1Counters,
    readsAt,
    d1ReadsAt,
    nowMs: () => now,
    sleep: async (ms: number) => advanceTo(now + ms)
  }
}

function run(w: ReturnType<typeof world>, options: Record<string, unknown> = {}) {
  return windowsModule.runLiveLaneWindows({
    lanes: w.lanes,
    lightChatId: LIGHT,
    heavyChatId: HEAVY,
    readMainWindow: w.readMainWindow,
    readD1Counters: w.readD1Counters,
    hostUnion: w.hostUnion,
    nowMs: w.nowMs,
    sleep: w.sleep,
    ...options
  })
}

describe('runLiveLaneWindows', () => {
  it('runs three eligible windows with every kind of evidence', async () => {
    const w = world()
    const result = await run(w)
    expect(result.verdict).toEqual({ ok: true, reasons: [] })
    expect(result.windows).toHaveLength(3)
    for (const window of result.windows) {
      expect(window.reasons).toEqual([])
      expect(window.endedAtMs - window.startedAtMs).toBe(120_000)
      expect(window.laneSettledAtMs.heavy).toBe(window.endedAtMs + 30_000)
      expect(window.laneSettledAtMs.light).toBe(
        Math.max(window.endedAtMs, window.light.drainedAtMs!) + 2_000
      )
      expect(window.light.rounds).toBeGreaterThanOrEqual(10)
      expect(window.light.roundStartPage).toMatchObject({ count: window.light.rounds })
      expect(window.light.cancels).toBeGreaterThan(0)
      expect(window.heavy.idleMs).toBeLessThanOrEqual(2_000)
      expect(window.d1?.deferredAppends).toBeGreaterThan(0)
      expect(window.main?.lanes.light.round_start.count).toBe(window.light.rounds)
      expect(window.main?.lanes.heavy.persist_barrier.count).toBeGreaterThan(0)
      expect(window.host).toMatchObject({
        censored: false,
        lanes: { light: { censored: false }, heavy: { censored: false } }
      })
    }
    // Windows follow one another, each after the one before settled.
    expect(result.windows[1].startedAtMs).toBeGreaterThan(result.windows[0].laneSettledAtMs.heavy)
  })

  it('reads main only after both lanes settled, and D1 only at the fences', async () => {
    const w = world()
    const result = await run(w, { windows: 1 })
    const [window] = result.windows
    // A baseline, then the window's own read after the later settle plus a fence.
    expect(w.readsAt).toHaveLength(2)
    expect(w.readsAt[1]).toBeGreaterThanOrEqual(
      Math.max(window.laneSettledAtMs.light!, window.laneSettledAtMs.heavy) + 2_000
    )
    expect(w.d1ReadsAt).toHaveLength(2)
    expect(w.d1ReadsAt[0]).toBeLessThanOrEqual(window.startedAtMs)
    expect(w.d1ReadsAt[1]).toBeGreaterThanOrEqual(w.readsAt[1])
  })

  it('refuses a window whose rounds never reached the deferred journal', async () => {
    const result = await run(world({ deferredPerWindow: 0 }), { windows: 1 })
    expect(result.windows[0].reasons).toEqual(['d1_no_deferred_append'])
    expect(result.verdict).toEqual({ ok: false, reasons: ['window 0: d1_no_deferred_append'] })
  })

  it('refuses a window where the heavy lane stopped streaming', async () => {
    const idle = await run(world({ heavyGapMs: 3_000, heavyRoundMs: 20_000 }), { windows: 1 })
    expect(idle.windows[0].reasons).toEqual(['heavy_lane_idle'])
    expect(idle.windows[0].heavy.idleMs).toBeGreaterThan(2_000)

    const failed = await run(world({ heavyFailureAtMs: 60_000 }), { windows: 3 })
    expect(failed.windows).toHaveLength(1)
    expect(failed.windows[0].reasons).toContain('heavy_lane_failed:heavy_unobserved')
    expect(failed.verdict.reasons[0]).toBe('windows_run:1/3')
  })

  it('stops at a failed light lane', async () => {
    const result = await run(world({ lightFailure: 'light_steered' }))
    expect(result.windows).toHaveLength(1)
    expect(result.windows[0].reasons).toEqual(
      expect.arrayContaining(['light_lane_failed:light_steered', 'light_rounds_missing'])
    )
    expect(result.verdict.ok).toBe(false)
  })

  it('censors on main’s evidence: refused, evicted, sampled, or missing a lane', async () => {
    expect(
      (await run(world({ mainRefusal: 'window_invalid' }), { windows: 1 })).windows[0].reasons
    ).toContain('main_read_refused_window_invalid')
    expect((await run(world({ mainEvicts: true }), { windows: 1 })).windows[0].reasons).toEqual([
      'main_spans_evicted'
    ])
    expect(
      (await run(world({ mainSampledAtMs: 60_000 }), { windows: 1 })).windows[0].reasons
    ).toEqual(['main_spans_sampled'])
    expect(
      (await run(world({ mainRejectsAtMs: 60_000 }), { windows: 1 })).windows[0].reasons
    ).toEqual(['main_spans_lost'])
    expect(
      (await run(world({ omitLightRoundStart: true }), { windows: 1 })).windows[0].reasons
    ).toEqual(['main_light_round_start_missing'])
  })

  it('says when D1 cannot be read, and when main saw nothing of the heavy lane', async () => {
    expect((await run(world({ d1Unavailable: true }), { windows: 1 })).windows[0].reasons).toEqual([
      'd1_counters_unavailable'
    ])
    expect((await run(world({ mainDropsHeavy: true }), { windows: 1 })).windows[0].reasons).toEqual(
      ['main_heavy_spans_missing']
    )
  })

  it('charges a sampled-out span to its own window only', async () => {
    const result = await run(world({ mainSampledAtMs: 60_000 }), { windows: 2 })
    expect(result.windows.map((window) => window.reasons)).toEqual([['main_spans_sampled'], []])
    expect(result.windows[1].main?.ringRise).toMatchObject({ sampledOut: 0 })
  })

  it('censors a window whose light lane the Host fold censors, and only then', async () => {
    // A Host loss after the light lane settled censors the heavy lane alone.
    const late = await run(world({ hostRejectsAtMs: 150_000 }), { windows: 1 })
    const [window] = late.windows
    expect(window.laneSettledAtMs.light!).toBeLessThan(T0 + 150_000)
    expect(window.laneSettledAtMs.heavy).toBeGreaterThan(T0 + 150_000)
    expect(window.reasons).toEqual([])
    expect(late.windows[0].host).toMatchObject({
      lanes: { light: { censored: false }, heavy: { censored: true, reasons: ['spans_lost'] } }
    })
    const early = await run(world({ hostRejectsAtMs: 60_000 }), { windows: 1 })
    expect(early.windows[0].reasons).toEqual(['host_light_spans_lost'])
  })

  it('says when there is no Host evidence at all', async () => {
    const result = await run(world(), { windows: 1, hostUnion: null })
    expect(result.windows[0].reasons).toEqual(['host_evidence_unavailable'])
  })

  it('refuses bad options', async () => {
    const w = world()
    await expect(run(w, { windows: 0 })).rejects.toThrow(/windows/)
    await expect(run(w, { windowMs: 0 })).rejects.toThrow(/windowMs/)
    await expect(run(w, { readMainWindow: undefined })).rejects.toThrow(/readers/)
  })
})

describe('heavyIdleWithin', () => {
  const heavy = (rounds: Array<[number, number | null]>, idle: Array<[number, number]>) => ({
    rounds: rounds.map(([acceptedAtMs, endedAtMs], index) => ({
      roundId: `heavy-${index + 1}`,
      acceptedAtMs,
      endedAtMs
    })),
    idle: idle.map(([fromMs, toMs]) => ({ fromMs, toMs }))
  })

  it('counts idle intervals, an end not yet followed, and a window with no round', () => {
    expect(
      windowsModule.heavyIdleWithin(
        heavy(
          [
            [0, 500],
            [700, null]
          ],
          [[500, 700]]
        ),
        0,
        1_000
      )
    ).toBe(200)
    expect(
      windowsModule.heavyIdleWithin(
        heavy(
          [
            [0, 500],
            [700, null]
          ],
          [[500, 700]]
        ),
        600,
        1_000
      )
    ).toBe(100)
    expect(windowsModule.heavyIdleWithin(heavy([[0, 800]], []), 0, 1_000)).toBe(200)
    expect(windowsModule.heavyIdleWithin(heavy([[1_500, null]], []), 0, 1_000)).toBe(1_000)
    expect(windowsModule.heavyIdleWithin(heavy([], []), 0, 1_000)).toBe(1_000)
  })
})

describe('the main-side read', () => {
  const valid = {
    sampledAt: 5,
    sinceMs: 1,
    untilMs: 2,
    censored: false,
    ring: { recorded: 3, dropped: 0, sampledOut: 0, rejected: 0, degraded: 0 },
    lanes: {
      light: {
        spans: [
          {
            kind: 'round_start',
            startedAt: 1,
            durationMs: 5,
            resource: 'none',
            bytes: 0,
            fallback: false
          }
        ],
        admission: null
      },
      heavy: { spans: [], admission: null }
    },
    admission: null
  }

  it('evaluates the handle in main and stringifies there', () => {
    const query = { lanes: { light: LIGHT, heavy: HEAVY }, sinceMs: 1, untilMs: 2 }
    let received: unknown = null
    const text = vm.runInNewContext(windowsModule.mainWorkSpanWindowExpression(query), {
      globalThis: {
        [windowsModule.MAIN_WORK_SPANS_GLOBAL]: (q: unknown) => {
          received = q
          return valid
        }
      }
    })
    expect(received).toEqual(query)
    expect(typeof text).toBe('string')
    expect(windowsModule.parseMainWorkSpanWindow(text)).toMatchObject({ ok: true })
    expect(
      vm.runInNewContext(windowsModule.mainWorkSpanWindowExpression(query), { globalThis: {} })
    ).toBeNull()
  })

  it.each([
    ['an absent handle', null, 'main_handle_absent'],
    ['text that is not JSON', '{', 'main_read_invalid'],
    [
      'a refusal',
      JSON.stringify({ sampledAt: 1, refused: 'lanes_invalid' }),
      'main_read_refused_lanes_invalid'
    ],
    [
      'a fractional counter',
      JSON.stringify({ ...valid, ring: { ...valid.ring, recorded: 1.5 } }),
      'main_read_invalid'
    ],
    [
      'a missing lane',
      JSON.stringify({ ...valid, lanes: { light: valid.lanes.light } }),
      'main_read_invalid'
    ],
    [
      'an unknown kind',
      JSON.stringify({
        ...valid,
        lanes: {
          ...valid.lanes,
          heavy: { spans: [{ ...valid.lanes.light.spans[0], kind: 'nap' }] }
        }
      }),
      'main_read_span_kind_invalid'
    ],
    [
      'a negative duration',
      JSON.stringify({
        ...valid,
        lanes: {
          ...valid.lanes,
          heavy: { spans: [{ ...valid.lanes.light.spans[0], durationMs: -1 }] }
        }
      }),
      'main_read_span_time_invalid'
    ]
  ])('refuses %s', (_label, text, reason) => {
    expect(windowsModule.parseMainWorkSpanWindow(text)).toEqual({ ok: false, reason })
  })
})

describe('pageTimings', () => {
  it('ranks page durations and ignores what is not one', () => {
    expect(windowsModule.pageTimings([30, 10, null, 20, -1, Number.NaN])).toEqual({
      count: 3,
      p50Ms: 20,
      p95Ms: 30,
      p99Ms: 30,
      maxMs: 30
    })
    expect(windowsModule.pageTimings([null])).toBeNull()
    // Nearest rank, where rounding would differ: p95 of 1..12 is 12.
    expect(
      windowsModule.pageTimings(Array.from({ length: 12 }, (_, index) => 12 - index))
    ).toMatchObject({ p50Ms: 6, p95Ms: 12 })
  })
})
