import { createRequire } from 'node:module'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)

type Verdict = { ok: boolean; reasons: string[] }
function windowProbeFixture(nowMs: () => number, late = 0, endAsks: number[] = []) {
  let startedAtMs = 0
  let durationMs = 0
  return (request: { action: string; id: string; durationMs?: number }) => {
    if (request.action === 'begin') {
      startedAtMs = nowMs()
      durationMs = request.durationMs ?? 0
      endAsks.push(0)
      return { status: 'started', id: request.id, startedAtMs }
    }
    // Asked before main's own timer has run: no receipt yet.
    endAsks[endAsks.length - 1] += 1
    if (endAsks[endAsks.length - 1] <= late) {
      return { status: 'unavailable', reason: 'window_incomplete' }
    }
    return {
      status: 'complete',
      id: request.id,
      startedAtMs,
      endedAtMs: startedAtMs + durationMs,
      eventLoopLag: {
        sampling: true,
        observedForMs: durationMs,
        p50Ms: 1,
        p95Ms: 3,
        p99Ms: 5,
        maxMs: 10,
        meanMs: 2
      }
    }
  }
}
type PhaseResult = {
  schemaVersion: number
  chats: { light: string; heavy: string }
  models: { light: string; heavy: string }
  options: Record<string, number>
  windows: Array<{
    repetition: number
    reasons: string[]
    host: unknown
    activity: Record<string, Record<string, number> | null>
    startedAtMs: number
    laneSettledAtMs: { light: number | null; heavy: number }
    barrierDurability?: { change: unknown; unavailable: string | null }
  }>
  hostLag: {
    windows: Array<{ role: string; outcome: string; lag: { sampleCount: number } }>
  } | null
  lanes: unknown
  hostSampler: Record<string, unknown> | null
  teardown: { light: string; heavy: string; observer: string } | null
  verdict: Verdict
}

const {
  liveLaneChatsOf,
  liveLanesTeardownFailures,
  readMainWorkSpanWindow,
  readMainPerfWindow,
  runT2LiveLanes,
  withLiveLanesVerdict
} = require('./t2LiveLanes.cjs') as {
  liveLaneChatsOf: (fixture: unknown) => { light: string; heavy: string }
  liveLanesTeardownFailures: (lanes: unknown) => string[]
  readMainWorkSpanWindow: (session: unknown, query: unknown, timeoutMs: number) => Promise<unknown>
  readMainPerfWindow: (page: unknown, request: unknown, timeoutMs: number) => Promise<unknown>
  runT2LiveLanes: (options: Record<string, unknown>) => Promise<PhaseResult>
  withLiveLanesVerdict: (rounds: unknown, lanes: unknown) => Verdict
}
const { generatePerfFixture } = require('./fixtureGenerator.cjs') as {
  generatePerfFixture: (options: Record<string, unknown>) => {
    chats: Array<{ appChatId: string }>
    shape: { chatShapes: Array<{ seatCount: number }> }
  }
}
const { attachMainInspectorSession } = require('./cdpWebSocketSession.cjs') as {
  attachMainInspectorSession: (options: Record<string, unknown>) => Promise<{
    post: (method: string, params?: unknown, sendOptions?: unknown) => Promise<unknown>
  }>
}
const { D1_COUNTERS_EXPRESSION } = require('./liveRounds.cjs') as { D1_COUNTERS_EXPRESSION: string }
const { MAIN_WORK_SPANS_GLOBAL } = require('./liveLaneWindows.cjs') as {
  MAIN_WORK_SPANS_GLOBAL: string
}
const { LANE_OBSERVER_GLOBAL } = require('./liveLaneObserver.cjs') as {
  LANE_OBSERVER_GLOBAL: string
}
const { scriptedActivity } = require('./scriptedOllamaDaemon.cjs') as {
  scriptedActivity: (
    turns: DaemonTurn[],
    model: string,
    fromMs: number,
    toMs: number,
    nowMs: number
  ) => Record<string, number>
}
type DaemonTurn = { model: string; startedAtMs: number; endedAtMs: number; outcome: string }

const LIGHT = 'perf-light_beside_large_live-chat-01'
const HEAVY = 'perf-light_beside_large_live-chat-02'
const LIGHT_TITLE = 'Perf fixture light_beside_large_live #1'
const LIGHT_MODEL = 'scripted-llama:latest'
const HEAVY_MODEL = 'scripted-llama:heavy'
const TITLES: Record<string, string> = {
  [LIGHT]: LIGHT_TITLE,
  [HEAVY]: 'Perf fixture light_beside_large_live #2'
}
const T0 = Date.parse('2026-09-25T09:00:00.000Z')
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
const WINDOW_OPTIONS = {
  windows: 2,
  windowMs: 20_000,
  fenceMs: 500,
  lightSettleMarginMs: 3_000,
  heavySettleMarginMs: 3_000,
  maxHeavyIdleMs: 2_000,
  hostCaptureWaitMs: 7_000
}

afterEach(() => {
  vi.useRealTimers()
})

function laneError(code: string, reason?: string) {
  return Object.assign(new Error(`${code} ${reason ?? ''}`), {
    code,
    ...(reason ? { reason } : {})
  })
}

type Span = { chatId: string; kind: string; startedAt: number; durationMs: number }

/** Main's barrier durability section with only its switch read: the layer's own parts unreported. */
function switchSection(enabled: boolean) {
  return {
    enabled,
    ignored: null,
    debt: null,
    port: null,
    tickets: null,
    gates: null,
    threads: null,
    checkpoints: {},
    tornTailsRepaired: 0
  }
}

/**
 * The phase's surroundings on a virtual clock: scripted lanes (a heavy round
 * that streams from its start, light rounds every four seconds), each lane's
 * model turns in the scripted daemon under the lane chat's own tag, main's
 * S3a handle evaluated from the real expression, D1 counters behind the
 * page, and a Host that captures every five seconds into whatever union the
 * sampler was handed.
 */
function world(
  options: {
    installError?: Error
    heavyError?: Error
    stopError?: Error
    samplerStarts?: boolean
    rowMissing?: boolean
    neverOpens?: boolean
    rowNeverActive?: boolean
    titleNeverShows?: boolean
    pageFails?: boolean
    cancelHangs?: boolean
    cancelRejects?: boolean
    /** How many times main answers each window's end with no receipt yet. */
    probeLate?: number
    /** Main answers a window's end with a snapshot that has no window. */
    endNoWindow?: boolean
    /** The journal path main's saves take, and what main's section says of it by default. */
    barrier?: 'off' | 'on'
    /** Main's barrier durability section at a moment; null for a build without it. */
    barrierSection?: ((nowMs: number) => unknown) | null
  } = {}
) {
  // Main's section: as the test gives it, or one that says the world's own switch.
  const barrierSection =
    options.barrierSection === undefined
      ? () => switchSection(options.barrier === 'on')
      : options.barrierSection
  let now = T0
  const markers: number[] = []
  const endAsks: number[] = []
  const events: string[] = []
  const mainSpans: Span[] = []
  const mainPosts: Array<{ method: string; sendOptions: unknown }> = []
  const hostSpans: Array<Span & { seq: number }> = []
  const samples: Array<Record<string, unknown>> = []
  let union: { add: (sample: unknown) => { ok: boolean } } | null = null
  let samplerStarted = false
  let hostSequence = 0
  let deferredAppends = 0
  let heavyStarted = false
  let heavyFailure: string | null = null
  let laneOptions: Record<string, unknown> | null = null
  let lightIndex = 0
  const daemonTurns: DaemonTurn[] = []
  const daemonReads: Array<{ model: string; fromMs: number; toMs: number }> = []
  const barrierReadsAt: number[] = []

  const addSpan = (span: Span) => {
    mainSpans.push(span)
    hostSpans.push({ ...span, seq: hostSpans.length + 1 })
  }

  const capture = () => {
    hostSequence += 1
    const chats: string[] = []
    const rows = hostSpans.map((span) => {
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
    const workSpans = {
      process: 'host',
      recorded: hostSpans.length,
      dropped: 0,
      sampledOut: 0,
      rejected: 0,
      degraded: 0
    }
    const sample = {
      identity: { process: 'host', instanceId: 'host-1', generation: 1, pid: 4242 },
      sequence: hostSequence,
      capturedAt: new Date(now).toISOString(),
      eventLoopLag: {
        observedForMs: 5_000,
        configuredIntervalMs: 20,
        p50Ms: 1,
        p95Ms: 2,
        p99Ms: 3,
        maxMs: 4,
        meanMs: 1
      },
      workSpans: {
        ...workSpans,
        recentSpans: {
          encoding: 'ring_tail_rows_v1',
          columns: COLUMNS,
          limit: 1_024,
          fromSeq: rows.length > 0 ? hostSpans[0].seq : null,
          toSeq: rows.length > 0 ? hostSpans[hostSpans.length - 1].seq : null,
          omittedMaxStartedAt: null,
          chats,
          rows
        }
      }
    }
    if (!samplerStarted || union === null) return
    union.add(sample)
    samples.push({ ...sample, workSpans })
  }

  const advanceTo = (target: number) => {
    while (now < target) {
      now = Math.min(target, Math.floor(now / 1_000) * 1_000 + 1_000)
      if (heavyStarted && now % 5_000 === 0) {
        addSpan({ chatId: HEAVY, kind: 'persist_barrier', startedAt: now - 300, durationMs: 300 })
      }
      if (heavyStarted && heavyRunning && now % 2_000 === 0) {
        daemonTurns.push({
          model: HEAVY_MODEL,
          startedAtMs: now,
          endedAtMs: now + 1_500,
          outcome: 'done'
        })
      }
      if (now % 5_000 === 0) capture()
    }
  }
  // A loop that never ends would starve vitest's own timeout (every wait
  // here resolves at once), so a runaway clock or poll fails instead.
  const sleep = async (ms: number) => {
    events.push(`sleep:${ms}`)
    if (now - T0 > 6 * 3_600_000) throw new Error('the virtual clock ran away')
    advanceTo(now + ms)
  }
  let titleReads = 0

  const heavyRounds: Array<{
    roundId: string
    acceptedAtMs: number
    endedAtMs: number | null
    status: string | null
  }> = []
  const lightRounds: Array<Record<string, unknown>> = []
  // Whether the heavy chat has a round running, as the app would answer a cancel.
  let heavyRunning = false
  const snapshot = () => ({
    observer: {
      installId: 'install-1',
      faults: 0,
      otherSource: { light: 0, heavy: 0 },
      failure: null
    },
    light: { rounds: lightRounds.map((round) => ({ ...round })), failure: null },
    heavy: { rounds: heavyRounds.map((round) => ({ ...round })), idle: [], failure: heavyFailure }
  })
  // The page's window: the app's cancel, and the observer global the lanes install.
  const probeWindow = windowProbeFixture(() => now, options.probeLate ?? 0, endAsks)
  const pageWindow: Record<string, unknown> = {
    api: {
      getMainPerfSnapshot: async (request?: { window: Parameters<typeof probeWindow>[0] }) => {
        if (request === undefined) {
          barrierReadsAt.push(now)
          return {
            sections:
              barrierSection === null ? {} : { threadBarrierDurability: barrierSection(now) }
          }
        }
        return options.endNoWindow && request.window.action === 'end'
          ? { sections: {} }
          : { window: probeWindow(request.window), sections: {} }
      },
      cancelEnsembleRound: (chatId: string) => {
        events.push(`cancel:${chatId}`)
        if (options.cancelHangs) return new Promise(() => {})
        if (options.cancelRejects) return Promise.reject(new Error('refused'))
        const running = chatId === HEAVY && heavyRunning
        if (chatId === HEAVY) heavyRunning = false
        return Promise.resolve(running)
      }
    }
  }
  const createLanes = (received: Record<string, unknown>) => {
    laneOptions = received
    return {
      install: async () => {
        events.push('install')
        if (options.installError) throw options.installError
        pageWindow[LANE_OBSERVER_GLOBAL] = { unsubscribe: [() => events.push('unsubscribed')] }
      },
      startHeavy: async () => {
        events.push('startHeavy')
        if (options.heavyError) {
          heavyFailure = (options.heavyError as { reason?: string }).reason ?? 'heavy_failed'
          throw options.heavyError
        }
        heavyStarted = true
        heavyRunning = true
        heavyRounds.push({ roundId: 'heavy-1', acceptedAtMs: now, endedAtMs: null, status: null })
      },
      runLight: async ({ untilMs }: { untilMs: number }) => {
        events.push('runLight')
        const rounds = []
        while (now < untilMs) {
          lightIndex += 1
          const sentAtMs = now
          addSpan({ chatId: LIGHT, kind: 'round_start', startedAt: now, durationMs: 120 })
          deferredAppends += 1
          daemonTurns.push({
            model: LIGHT_MODEL,
            startedAtMs: now + 200,
            endedAtMs: now + 2_800,
            outcome: 'done'
          })
          advanceTo(now + 3_000)
          const round = {
            roundId: `light-${lightIndex}`,
            sentAtMs,
            acceptedAtMs: sentAtMs + 150,
            pageMs: 150,
            endedAtMs: now,
            status: 'completed'
          }
          rounds.push(round)
          lightRounds.push(round)
          advanceTo(now + 1_000)
        }
        return { rounds, failure: null, drainedAtMs: rounds[rounds.length - 1].endedAtMs }
      },
      snapshot,
      stop: async () => {
        events.push('lanes.stop')
        if (options.stopError) throw options.stopError
        return snapshot()
      }
    }
  }

  // The sidebar and the main pane's title, as far as the page expressions
  // see them: a click marks the row selected at once, and the pane shows the
  // chat a moment later.
  let shownTitle = 'New chat'
  let activeRow: string | null = null
  let opening: { title: string; atMs: number } | null = null
  const document = {
    getElementsByClassName: (name: string) =>
      name !== 'sidebar-recents-item'
        ? []
        : [HEAVY, ...(options.rowMissing ? [] : [LIGHT])].map((chatId) => ({
            getAttribute: (attribute: string) =>
              attribute === 'data-sidebar-thread-id' ? chatId : null,
            classList: {
              contains: (name: string) => name === 'active' && activeRow === chatId
            },
            click: () => {
              events.push(`click:${chatId}`)
              if (!options.neverOpens && !options.rowNeverActive) activeRow = chatId
              if (!options.neverOpens && !options.titleNeverShows) {
                opening = { title: TITLES[chatId], atMs: now + 600 }
              }
            }
          })),
    querySelector: (selector: string) => {
      titleReads += 1
      if (titleReads > 10_000) throw new Error('the pane title was polled without end')
      if (selector !== '.app-transcript .chat-corner-thread-title') return null
      if (opening !== null && now >= opening.atMs) shownTitle = opening.title
      return { getAttribute: (attribute: string) => (attribute === 'title' ? shownTitle : null) }
    }
  }
  const page = {
    evaluate: async (expression: string) => {
      if (expression === D1_COUNTERS_EXPRESSION) {
        return options.barrier === 'on'
          ? { deferredAppends: 0, unsyncedAppends: deferredAppends, normalSaves: deferredAppends }
          : { deferredAppends, unsyncedAppends: 0, normalSaves: deferredAppends }
      }
      if (options.pageFails) throw new Error('renderer went away')
      return vm.runInNewContext(expression, {
        document,
        window: pageWindow,
        performance: { now: () => now }
      })
    }
  }
  const mainSession = {
    post: async (method: string, params: { expression: string }, sendOptions: unknown) => {
      if (params.expression.includes('tw_calibration_')) {
        markers.push(now - T0)
        return {
          result: {
            value: {
              tag: `tw_calibration_${markers.length}`,
              beforeMs: now - T0,
              afterMs: now - T0 + 40,
              pid: 4242,
              clockId: 'node.performance.now',
              timeOrigin: T0,
              identity: `main:4242:performance.timeOrigin:${T0}`
            }
          }
        }
      }
      mainPosts.push({ method, sendOptions })
      const handle = (query: {
        lanes: Record<string, string>
        sinceMs: number
        untilMs: number
      }) => ({
        sampledAt: now,
        sinceMs: query.sinceMs,
        untilMs: query.untilMs,
        censored: false,
        ring: { recorded: mainSpans.length, dropped: 0, sampledOut: 0, rejected: 0, degraded: 0 },
        lanes: Object.fromEntries(
          Object.entries(query.lanes).map(([label, chatId]) => [
            label,
            {
              spans: mainSpans
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
                })),
              admission: null
            }
          ])
        ),
        admission: null
      })
      const value = vm.runInNewContext(params.expression, { [MAIN_WORK_SPANS_GLOBAL]: handle })
      return { result: { type: 'string', value } }
    }
  }
  const createHostSampler = (received: typeof union) => {
    union = received
    return {
      start: async () => {
        events.push('sampler.start')
        samplerStarted = options.samplerStarts !== false
        return samplerStarted
      },
      stop: () => {
        events.push('sampler.stop')
        samplerStarted = false
        return { status: 'stopped', accepted: samples.length, refusals: {}, samples }
      }
    }
  }

  const readDaemonActivity = async (query: { model: string; fromMs: number; toMs: number }) => {
    daemonReads.push(query)
    return scriptedActivity(daemonTurns, query.model, query.fromMs, query.toMs, now)
  }

  return {
    events,
    mainPosts,
    markers,
    endAsks,
    daemonReads,
    barrierReadsAt,
    pageWindow,
    clock: () => now,
    laneOptions: () => laneOptions,
    run: (extra: Record<string, unknown> = {}) =>
      runT2LiveLanes({
        page,
        mainSession,
        lightChatId: LIGHT,
        lightChatTitle: LIGHT_TITLE,
        heavyChatId: HEAVY,
        laneModels: { light: LIGHT_MODEL, heavy: HEAVY_MODEL },
        readDaemonActivity,
        createHostSampler,
        createLanes,
        nowMs: () => now,
        sleep,
        windowOptions: WINDOW_OPTIONS,
        barrierDurability: 'off',
        ...extra
      }),
    page
  }
}

describe('runT2LiveLanes', () => {
  it('runs the windows between the sampler and the lanes, and stops both on the way out', async () => {
    const w = world()
    const result = await w.run()
    expect(result.verdict).toEqual({ ok: true, reasons: [] })
    expect(result.windows.map((window) => window.reasons)).toEqual([[], []])
    for (const window of result.windows) {
      expect(window.host).toMatchObject({ lanes: { light: { censored: false } } })
    }

    // The sampler reads before the lanes start; the heavy lane gets its
    // lead-in before the first light round; both stop, lanes first.
    const at = (event: string) => w.events.indexOf(event)
    expect(at('sampler.start')).toBeGreaterThan(-1)
    // The light chat is opened from the sidebar before the lanes start, and
    // nothing ever opens the heavy one.
    expect(at(`click:${LIGHT}`)).toBeGreaterThan(at('sampler.start'))
    expect(at('install')).toBeGreaterThan(at(`click:${LIGHT}`))
    expect(w.events).not.toContain(`click:${HEAVY}`)
    expect(at('startHeavy')).toBeGreaterThan(at('install'))
    expect(w.events[at('startHeavy') + 1]).toBe('sleep:10000')
    expect(at('runLight')).toBeGreaterThan(at('sleep:10000'))
    // Stopped, then tidied: the heavy round cancelled, then the observer removed.
    expect(w.events.slice(-4)).toEqual([
      'lanes.stop',
      'sampler.stop',
      `cancel:${HEAVY}`,
      'unsubscribed'
    ])
    expect(result.teardown).toEqual({
      light: 'not_running',
      heavy: 'cancelled',
      observer: 'uninstalled'
    })
    expect(w.pageWindow).not.toHaveProperty(LANE_OBSERVER_GLOBAL)

    expect(w.laneOptions()).toMatchObject({
      page: w.page,
      lightChatId: LIGHT,
      heavyChatId: HEAVY,
      callTimeoutMs: 60_000,
      cancelEvery: 3,
      cancelAfterMs: 1_500
    })
    // A baseline read, then one per window, each bounded by the transport.
    expect(w.mainPosts).toEqual(
      Array.from({ length: 3 }, () => ({
        method: 'Runtime.evaluate',
        sendOptions: { timeoutMs: 60_000 }
      }))
    )

    expect(result.chats).toEqual({ light: LIGHT, heavy: HEAVY })
    expect(result.models).toEqual({ light: LIGHT_MODEL, heavy: HEAVY_MODEL })
    // Each lane's turns are read under its own chat's tag: per window the
    // light lane, the heavy lane, then each completed light round.
    const completed = (result.windows as unknown as Array<{ light: { completed: number } }>).map(
      (window) => window.light.completed
    )
    expect(completed.every((count) => count > 0)).toBe(true)
    expect(w.daemonReads.map((read) => read.model)).toEqual(
      completed.flatMap((count) => [
        LIGHT_MODEL,
        HEAVY_MODEL,
        ...Array.from({ length: count }, () => LIGHT_MODEL)
      ])
    )
    for (const window of result.windows) {
      expect(window.activity.light?.done).toBeGreaterThan(0)
      expect(window.activity.heavy?.done).toBeGreaterThan(0)
    }
    expect(result.options).toEqual({
      callTimeoutMs: 60_000,
      openChatTimeoutMs: 30_000,
      heavyLeadInMs: 10_000,
      cancelEvery: 3,
      cancelAfterMs: 1_500
    })
    expect(result.hostSampler).toMatchObject({ status: 'stopped' })
    expect(result.hostSampler).not.toHaveProperty('samples')
    expect(result.hostLag?.windows).toHaveLength(2)
    for (const window of result.hostLag!.windows) {
      expect(window).toMatchObject({ role: 'light-beside', outcome: 'eligible' })
      expect(window.lag.sampleCount).toBeGreaterThan(0)
    }
  })

  it("reads barrier durability through the page at each window's fences", async () => {
    const raisedAt = (atMs: number) => Math.floor((atMs - T0) / 100)
    const w = world({
      barrier: 'on',
      barrierSection: (atMs) => ({
        enabled: true,
        ignored: null,
        debt: null,
        port: { started: raisedAt(atMs), inFlight: 0, queued: 0, joined: 0, peakInFlight: 2 },
        tickets: null,
        gates: null,
        checkpoints: {},
        tornTailsRepaired: 0
      })
    })
    const result = await w.run({ barrierDurability: 'on' })
    expect(result.windows.map((window) => window.reasons)).toEqual([[], []])
    expect(w.barrierReadsAt).toHaveLength(4)
    result.windows.forEach((window, index) => {
      const [before, after] = w.barrierReadsAt.slice(2 * index, 2 * index + 2)
      expect(before).toBeLessThanOrEqual(window.startedAtMs)
      expect(after).toBeGreaterThanOrEqual(window.laneSettledAtMs.heavy)
      expect(window.barrierDurability).toMatchObject({
        unavailable: null,
        change: { enabled: true, port: { started: raisedAt(after) - raisedAt(before) } }
      })
    })
    // A build without the section cannot say which journal path the windows took.
    const without = await world({ barrierSection: null }).run()
    expect(without.windows.map((window) => window.reasons)).toEqual([
      ['d1_path_unconfirmed'],
      ['d1_path_unconfirmed']
    ])
    for (const window of without.windows) {
      expect(window.barrierDurability?.unavailable).toBe('section_absent')
    }
  })

  it('judges the windows on the journal path its run pinned, and starts nothing without it', async () => {
    // Pinned on, and main ran with it off: each window fails.
    const mismatched = await world().run({ barrierDurability: 'on' })
    expect(mismatched.windows.map((window) => window.reasons)).toEqual([
      ['barrier_switch_off_in_main'],
      ['barrier_switch_off_in_main']
    ])
    const on = await world({ barrier: 'on' }).run({ barrierDurability: 'on' })
    expect(on.verdict).toEqual({ ok: true, reasons: [] })
    expect(on.windows[0].d1).toMatchObject({ deferredAppends: 0 })
    const w = world()
    await expect(w.run({ barrierDurability: undefined })).rejects.toThrow(
      "barrier durability must be pinned 'on' or 'off'"
    )
    expect(w.events).toEqual([])
  })

  it('names a lane that could not start, and still stops everything', async () => {
    const cases: Array<[Record<string, Error>, string]> = [
      [{ installError: laneError('T2_LIVE_LANE_OBSERVER', 'api_missing') }, 'api_missing'],
      [{ heavyError: laneError('T2_LIVE_LANE_HEAVY', 'heavy_not_started') }, 'heavy_not_started'],
      [{ installError: laneError('T2_LIVE_PAGE_CALL_TIMEOUT') }, 'T2_LIVE_PAGE_CALL_TIMEOUT']
    ]
    for (const [failure, reason] of cases) {
      const w = world(failure)
      const result = await w.run()
      expect(result.verdict).toEqual({
        ok: false,
        reasons: [`lanes_not_started:${reason}`, 'windows_run:0/2']
      })
      expect(result.windows).toEqual([])
      expect(result.hostLag).toBeNull()
      expect(w.events).not.toContain('runLight')
      expect(w.events.indexOf('sampler.stop')).toBe(w.events.indexOf('lanes.stop') + 1)
    }
    // A failed heavy start may have left a round behind: it is cancelled
    // (the app answers that none was running), and the observer removed.
    const heavyFailed = await world({
      heavyError: laneError('T2_LIVE_LANE_HEAVY', 'heavy_not_started')
    }).run()
    expect(heavyFailed.teardown).toEqual({
      light: 'not_running',
      heavy: 'not_cancelled',
      observer: 'uninstalled'
    })
    const neverInstalled = await world({
      installError: laneError('T2_LIVE_LANE_OBSERVER', 'api_missing')
    }).run()
    expect(neverInstalled.teardown).toEqual({
      light: 'not_running',
      heavy: 'not_running',
      observer: 'not_installed'
    })
  })

  it('names a light chat that would not open, and starts no lane', async () => {
    const cases: Array<[Record<string, boolean>, string]> = [
      [{ rowMissing: true }, 'light_chat_row_missing'],
      [{ neverOpens: true }, 'light_chat_not_opened'],
      // The pane shows the title but the sidebar never selected the row, or
      // the row is selected but the pane never caught up: neither is open.
      [{ rowNeverActive: true }, 'light_chat_not_opened'],
      [{ titleNeverShows: true }, 'light_chat_not_opened'],
      [{ pageFails: true }, 'light_chat_call_failed']
    ]
    for (const [failure, reason] of cases) {
      const w = world(failure)
      const result = await w.run()
      expect(result.verdict).toEqual({
        ok: false,
        reasons: [`lanes_not_started:${reason}`, 'windows_run:0/2']
      })
      expect(w.events).not.toContain('install')
      expect(w.events.slice(-2)).toEqual(['lanes.stop', 'sampler.stop'])
      expect(result.teardown).toMatchObject({ light: 'not_running', heavy: 'not_running' })
    }
    // A page that fails every call cannot be tidied either, and says so.
    expect((await world({ pageFails: true }).run()).teardown).toEqual({
      light: 'not_running',
      heavy: 'not_running',
      observer: 'failed'
    })
  })

  it('waits for the pane to show the light chat, within its bound', async () => {
    const opened = world()
    await opened.run({ windowOptions: { ...WINDOW_OPTIONS, windows: 1 } })
    // The pane showed it 600 ms after the click: three polls of 250 ms.
    expect(opened.events.filter((event) => event === 'sleep:250')).toHaveLength(3)

    const slow = world({ neverOpens: true })
    await slow.run({ openChatTimeoutMs: 1_000 })
    expect(slow.events.filter((event) => event === 'sleep:250')).toHaveLength(4)
  })

  it('rethrows what is not a lane failure, after stopping both and tidying', async () => {
    const w = world({ installError: new Error('harness defect') })
    await expect(w.run()).rejects.toThrow(/harness defect/)
    expect(w.events.slice(-2)).toEqual(['lanes.stop', 'sampler.stop'])

    // Lanes that would not stop leave no snapshot: both chats are cancelled
    // blind, and the observer is still removed.
    const stopping = world({ stopError: new Error('lanes would not stop') })
    await expect(stopping.run()).rejects.toThrow(/lanes would not stop/)
    expect(stopping.events.slice(-5)).toEqual([
      'lanes.stop',
      'sampler.stop',
      `cancel:${LIGHT}`,
      `cancel:${HEAVY}`,
      'unsubscribed'
    ])
  })

  it('asks the daemon for whole milliseconds, widening a fractional range outward', async () => {
    const w = world()
    const result = await w.run({
      nowMs: () => w.clock() + 0.5,
      windowOptions: { ...WINDOW_OPTIONS, windows: 1 }
    })
    const [window] = result.windows as unknown as Array<{
      startedAtMs: number
      endedAtMs: number
      laneSettledAtMs: { heavy: number }
    }>
    expect(Number.isInteger(window.startedAtMs)).toBe(false)
    expect(w.daemonReads.length).toBeGreaterThan(2)
    for (const read of w.daemonReads) {
      expect(Number.isSafeInteger(read.fromMs)).toBe(true)
      expect(Number.isSafeInteger(read.toMs)).toBe(true)
    }
    for (const read of w.daemonReads.slice(0, 2)) {
      expect(read.fromMs).toBe(Math.floor(window.startedAtMs))
    }
    // The heavy lane's range ends with its settle; ceil, not floor.
    expect(Number.isInteger(window.laneSettledAtMs.heavy)).toBe(false)
    expect(w.daemonReads[1].toMs).toBe(Math.ceil(window.laneSettledAtMs.heavy))
  })

  it('bounds each teardown call, and reports one that never answered', async () => {
    const w = world({ cancelHangs: true })
    const result = await w.run({ callTimeoutMs: 30 })
    expect(result.teardown).toEqual({
      light: 'not_running',
      heavy: 'failed',
      observer: 'uninstalled'
    })
    // The windows' verdict is theirs alone.
    expect(result.verdict.ok).toBe(true)
    // A cancel the app refused is answered in the page, and still failed.
    const refused = await world({ cancelRejects: true }).run()
    expect(refused.teardown).toEqual({
      light: 'not_running',
      heavy: 'failed',
      observer: 'uninstalled'
    })
  })

  it('bounds a lane failure’s reason', async () => {
    const result = await world({
      installError: laneError('T2_LIVE_LANE_OBSERVER', 'x'.repeat(300))
    }).run()
    expect(result.verdict.reasons[0]).toBe(`lanes_not_started:${'x'.repeat(182)}`)
  })

  it('runs without Host evidence when the sampler cannot start', async () => {
    const result = await world({ samplerStarts: false }).run()
    expect(result.windows.map((window) => window.reasons)).toEqual([
      ['host_evidence_unavailable'],
      ['host_evidence_unavailable']
    ])
    expect(result.verdict.ok).toBe(false)
    expect(
      result.hostLag?.windows.map((window) => [
        window.outcome,
        (window as unknown as { reason: string }).reason
      ])
    ).toEqual([
      ['censored', 'host_evidence_unavailable'],
      ['censored', 'host_evidence_unavailable']
    ])
  })

  // The quarter-second waits of a run whose windows main ends on time (opening the light chat).
  const quarterWaits = (events: string[]) => events.filter((event) => event === 'sleep:250').length
  const onTime = async () => {
    const w = world()
    await w.run()
    expect(w.endAsks).toEqual([1, 1])
    return quarterWaits(w.events)
  }

  it('asks main again for a window whose timer had not yet run, and marks its end after', async () => {
    const waitsOnTime = await onTime()
    const w = world({ probeLate: 2 })
    const result = await w.run({ onCalibrationMarker: () => {} })
    expect(result.verdict).toEqual({ ok: true, reasons: [] })
    // Each window's end asked three times, a quarter of a second apart.
    expect(w.endAsks).toEqual([3, 3])
    expect(quarterWaits(w.events)).toBe(waitsOnTime + 4)
    // Each window's start is marked as it begins, its end once main has answered.
    const windows = result.windows as unknown as Array<{ startedAtMs: number; endedAtMs: number }>
    expect(w.markers).toEqual(
      windows.flatMap((window) => [window.startedAtMs - T0, window.endedAtMs - T0 + 500])
    )
  })

  it('gives up on a window main never finishes timing, and says so', async () => {
    const waitsOnTime = await onTime()
    const w = world({ probeLate: 1_000 })
    const result = await w.run()
    expect(result.windows.map((window) => window.reasons)).toEqual([
      ['window_incomplete'],
      ['window_incomplete']
    ])
    // Forty asks a window: ten seconds, no more.
    expect(w.endAsks).toEqual([40, 40])
    expect(quarterWaits(w.events)).toBe(waitsOnTime + 78)
  })

  it('does not ask again when main answers a window’s end with no window at all', async () => {
    const w = world({ endNoWindow: true })
    const result = await w.run()
    expect(result.windows.map((window) => window.reasons)).toEqual([
      ['main_probe_invalid'],
      ['main_probe_invalid']
    ])
  })

  it('passes a progress observer through to the windows', async () => {
    const seen: number[] = []
    await world().run({
      onWindow: (window: { repetition: number }) => seen.push(window.repetition)
    })
    expect(seen).toEqual([0, 1])
  })

  it('refuses bad options', async () => {
    const w = world()
    await expect(w.run({ page: null })).rejects.toThrow(/page adapter/)
    await expect(w.run({ mainSession: {} })).rejects.toThrow(/inspector session/)
    await expect(w.run({ createHostSampler: undefined })).rejects.toThrow(/sampler factory/)
    await expect(w.run({ lightChatTitle: '' })).rejects.toThrow(/light chat’s title/)
    await expect(w.run({ readDaemonActivity: undefined })).rejects.toThrow(/model tag per lane/)
    await expect(w.run({ laneModels: undefined })).rejects.toThrow(/model tag per lane/)
    await expect(w.run({ laneModels: { light: LIGHT_MODEL } })).rejects.toThrow(
      /model tag per lane/
    )
    await expect(w.run({ laneModels: { light: LIGHT_MODEL, heavy: LIGHT_MODEL } })).rejects.toThrow(
      /model tag per lane/
    )
    await expect(w.run({ laneModels: { light: '', heavy: HEAVY_MODEL } })).rejects.toThrow(
      /model tag per lane/
    )
    await expect(w.run({ laneModels: { light: LIGHT_MODEL, heavy: '' } })).rejects.toThrow(
      /model tag per lane/
    )
    await expect(w.run({ openChatTimeoutMs: 0 })).rejects.toThrow(/openChatTimeoutMs/)
    await expect(w.run({ heavyLeadInMs: 0 })).rejects.toThrow(/heavyLeadInMs/)
    await expect(w.run({ cancelEvery: -1 })).rejects.toThrow(/cancelEvery/)
    await expect(w.run({ callTimeoutMs: 1.5 })).rejects.toThrow(/callTimeoutMs/)
    const noCancels = world()
    await expect(noCancels.run({ cancelEvery: 0 })).resolves.toMatchObject({
      options: { cancelEvery: 0 }
    })
    expect(noCancels.laneOptions()).toMatchObject({ cancelEvery: 0 })
  })
})

type Listener = (payload: unknown) => void

/** Advance the fake clock until `promise` settles. */
async function drive<T>(promise: Promise<T>, maxMs: number): Promise<T> {
  let settled = false
  let failed = false
  let value: T | undefined
  let error: unknown
  promise.then(
    (result) => {
      settled = true
      value = result
    },
    (reason) => {
      settled = true
      failed = true
      error = reason
    }
  )
  for (let elapsed = 0; !settled && elapsed < maxMs; elapsed += 10) {
    await vi.advanceTimersByTimeAsync(10)
  }
  if (!settled) throw new Error(`did not settle within ${maxMs} ms`)
  if (failed) throw error
  return value as T
}

/**
 * The page and a scripted main for the real lanes: rounds start, stream and
 * end on the fake clock, the light chat's changes arrive as chat-updated
 * patches and the heavy chat's as invalidations (the light chat is the open
 * one), the sidebar opens a chat when its row is clicked, and main's spans,
 * D1 counters, the Host's captures and the daemon's turns all follow the
 * rounds.
 */
function liveApp(options: { dropEndOf?: string[] } = {}) {
  const listeners = { delivery: [] as Listener[], invalidation: [] as Listener[] }
  const active = new Map<string, string | null>()
  const counters = new Map<string, number>()
  const endTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const rounds: Array<{
    chatId: string
    roundId: string
    startedAtMs: number
    endedAtMs: number | null
    status: string | null
  }> = []
  const spans: Array<Span & { seq: number }> = []
  let deferredAppends = 0
  const cancels: string[] = []
  const addSpan = (span: Span) => spans.push({ ...span, seq: spans.length + 1 })
  const emit = (chatId: string, roundId: string, status: string) => {
    const ensemble = { activeRound: { roundId, status } }
    if (chatId === LIGHT) {
      for (const listener of [...listeners.delivery]) {
        listener({
          protocolVersion: 2,
          kind: 'patch',
          chatId,
          baseRevision: 1,
          revision: 2,
          recordMask: ['ensemble'],
          recordDelta: { ensemble }
        })
      }
    } else {
      for (const listener of [...listeners.invalidation]) {
        listener({
          protocolVersion: 1,
          kind: 'invalidation',
          chatId,
          revision: 3,
          summary: { appChatId: chatId, summaryOnly: true, ensemble }
        })
      }
    }
  }
  const end = (chatId: string, roundId: string, status: string) => {
    if (active.get(chatId) !== roundId) return
    active.set(chatId, null)
    const round = rounds.find((candidate) => candidate.roundId === roundId)!
    round.endedAtMs = Date.now()
    round.status = status
    deferredAppends += 1
    addSpan({ chatId, kind: 'durable_commit', startedAt: Date.now() - 40, durationMs: 40 })
    // A dropped end: the app ended the round, but the page never hears of it.
    if (!options.dropEndOf?.includes(roundId)) emit(chatId, roundId, status)
  }
  const start = (chatId: string): string => {
    const index = (counters.get(chatId) ?? 0) + 1
    counters.set(chatId, index)
    const roundId = `${chatId === LIGHT ? 'light' : 'heavy'}-${index}`
    active.set(chatId, roundId)
    rounds.push({ chatId, roundId, startedAtMs: Date.now(), endedAtMs: null, status: null })
    addSpan({ chatId, kind: 'round_start', startedAt: Date.now(), durationMs: 5 })
    setTimeout(() => emit(chatId, roundId, 'running'), 5)
    endTimers.set(
      roundId,
      setTimeout(() => end(chatId, roundId, 'completed'), chatId === LIGHT ? 300 : 1_000)
    )
    return roundId
  }
  const subscribe = (channel: 'delivery' | 'invalidation') => (callback: Listener) => {
    listeners[channel].push(callback)
    return () => {
      listeners[channel] = listeners[channel].filter((listener) => listener !== callback)
    }
  }
  const probeWindow = windowProbeFixture(Date.now)
  const window: Record<string, unknown> = {
    api: {
      onChatUpdated: subscribe('delivery'),
      onChatUpdateInvalidated: subscribe('invalidation'),
      runEnsembleRound: (payload: { chatId: string }) =>
        new Promise((resolve) => {
          const current = active.get(payload.chatId)
          if (current) {
            setTimeout(() => resolve({ status: 'steered', roundId: current }), 20)
            return
          }
          const roundId = start(payload.chatId)
          setTimeout(() => resolve({ status: 'started', roundId }), 20)
        }),
      cancelEnsembleRound: (chatId: string) =>
        new Promise((resolve) => {
          cancels.push(chatId)
          const roundId = active.get(chatId)
          if (!roundId) {
            setTimeout(() => resolve(false), 5)
            return
          }
          clearTimeout(endTimers.get(roundId))
          setTimeout(() => end(chatId, roundId, 'cancelled'), 30)
          setTimeout(() => resolve(true), 10)
        }),
      getMainPerfSnapshot: async (options?: {
        window?: Parameters<ReturnType<typeof windowProbeFixture>>[0]
      }) => ({
        ...(options?.window ? { window: probeWindow(options.window) } : {}),
        sections: {
          incrementalChatPersistence: {
            journal: { deferredAppends, unsyncedAppends: 0 },
            boundaryMix: { normal: deferredAppends }
          },
          threadBarrierDurability: switchSection(false)
        }
      })
    }
  }
  let activeRow: string | null = null
  let shownTitle = 'New chat'
  const document = {
    getElementsByClassName: (name: string) =>
      name !== 'sidebar-recents-item'
        ? []
        : [HEAVY, LIGHT].map((chatId) => ({
            getAttribute: (attribute: string) =>
              attribute === 'data-sidebar-thread-id' ? chatId : null,
            classList: { contains: (name: string) => name === 'active' && activeRow === chatId },
            click: () => {
              activeRow = chatId
              setTimeout(() => {
                shownTitle = TITLES[chatId]
              }, 400)
            }
          })),
    querySelector: (selector: string) =>
      selector === '.app-transcript .chat-corner-thread-title'
        ? { getAttribute: (attribute: string) => (attribute === 'title' ? shownTitle : null) }
        : null
  }
  const context = vm.createContext({
    window,
    document,
    Date: { now: () => Date.now() },
    performance: { now: () => Date.now() }
  })
  const page = {
    evaluate: (expression: string) => Promise.resolve(vm.runInContext(expression, context))
  }

  // Main's S3a handle over the same spans.
  const mainSession = {
    post: async (_method: string, params: { expression: string }) => {
      const handle = (query: {
        lanes: Record<string, string>
        sinceMs: number
        untilMs: number
      }) => ({
        sampledAt: Date.now(),
        sinceMs: query.sinceMs,
        untilMs: query.untilMs,
        censored: false,
        ring: { recorded: spans.length, dropped: 0, sampledOut: 0, rejected: 0, degraded: 0 },
        lanes: Object.fromEntries(
          Object.entries(query.lanes).map(([label, chatId]) => [
            label,
            {
              spans: spans
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
                })),
              admission: null
            }
          ])
        ),
        admission: null
      })
      const value = vm.runInNewContext(params.expression, { [MAIN_WORK_SPANS_GLOBAL]: handle })
      return { result: { type: 'string', value } }
    }
  }

  // The Host captures its span ring every second while the sampler runs.
  const createHostSampler = (union: { add: (sample: unknown) => { ok: boolean } }) => {
    let timer: ReturnType<typeof setInterval> | null = null
    let sequence = 0
    const refused: unknown[] = []
    const capture = () => {
      sequence += 1
      const chats: string[] = []
      const rows = spans.map((span) => {
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
      const added = union.add({
        identity: { process: 'host', instanceId: 'host-1', generation: 1, pid: 4242 },
        sequence,
        capturedAt: new Date(Date.now()).toISOString(),
        eventLoopLag: { unsupported: 'host_perf_lag_unobserved' },
        workSpans: {
          process: 'host',
          recorded: spans.length,
          dropped: 0,
          sampledOut: 0,
          rejected: 0,
          degraded: 0,
          recentSpans: {
            encoding: 'ring_tail_rows_v1',
            columns: COLUMNS,
            limit: 1_024,
            fromSeq: rows.length > 0 ? spans[0].seq : null,
            toSeq: rows.length > 0 ? spans[spans.length - 1].seq : null,
            omittedMaxStartedAt: null,
            chats,
            rows
          }
        }
      })
      if (!added.ok) refused.push(added)
    }
    return {
      start: async () => {
        capture()
        timer = setInterval(capture, 1_000)
        return true
      },
      stop: () => {
        if (timer !== null) clearInterval(timer)
        return { status: 'stopped', accepted: sequence - refused.length, refused, samples: [] }
      }
    }
  }

  // The daemon's turns: each round's seats stream 180 ms turns back to back.
  const readDaemonActivity = async (query: { model: string; fromMs: number; toMs: number }) => {
    const chatId = query.model === LIGHT_MODEL ? LIGHT : HEAVY
    const turns: DaemonTurn[] = []
    for (const round of rounds.filter((candidate) => candidate.chatId === chatId)) {
      const endMs = round.endedAtMs ?? Date.now()
      for (let at = round.startedAtMs + 10; at < endMs; at += 200) {
        const open = round.endedAtMs === null && at + 180 > Date.now()
        const endedAtMs = open ? null : Math.min(at + 180, endMs)
        turns.push({
          model: query.model,
          startedAtMs: at,
          endedAtMs: endedAtMs as number,
          outcome: open
            ? 'streaming'
            : round.status === 'cancelled' && at + 180 >= endMs
              ? 'aborted'
              : 'done'
        })
      }
    }
    return scriptedActivity(turns, query.model, query.fromMs, query.toMs, Date.now())
  }

  return {
    window,
    rounds,
    cancels,
    active,
    run: (extra: Record<string, unknown> = {}) =>
      runT2LiveLanes({
        page,
        mainSession,
        lightChatId: LIGHT,
        lightChatTitle: LIGHT_TITLE,
        heavyChatId: HEAVY,
        laneModels: { light: LIGHT_MODEL, heavy: HEAVY_MODEL },
        readDaemonActivity,
        createHostSampler,
        callTimeoutMs: 5_000,
        openChatTimeoutMs: 2_000,
        heavyLeadInMs: 500,
        cancelEvery: 3,
        cancelAfterMs: 100,
        laneOptions: { pollMs: 50, lightGapMs: 100 },
        barrierDurability: 'off',
        windowOptions: {
          windows: 2,
          windowMs: 5_000,
          fenceMs: 100,
          lightSettleMarginMs: 1_000,
          heavySettleMarginMs: 1_500,
          maxHeavyIdleMs: 1_000,
          maxHeavyQuietMs: 2_000,
          hostCaptureWaitMs: 1_500
        },
        ...extra
      })
  }
}

describe('runT2LiveLanes over the real lanes and observer', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: T0 })
  })

  it('measures eligible windows from the lanes’ own records, and tidies the page after', async () => {
    const app = liveApp()
    const result = await drive(app.run(), 120_000)
    expect(result.verdict).toEqual({ ok: true, reasons: [] })
    expect(result.windows).toHaveLength(2)
    const lanes = result.lanes as {
      observer: { faults: number; otherSource: { light: number; heavy: number } }
      light: { rounds: Array<{ status: string; control?: { cancelled?: boolean } }> }
      heavy: { rounds: Array<{ status: string | null; endedAtMs: number | null }> }
    }
    // The lanes really ran: light rounds with the lane's own cancels among
    // them, and heavy rounds back to back, all through the observer.
    expect(lanes.observer).toMatchObject({ faults: 0, otherSource: { light: 0, heavy: 0 } })
    const lightStatuses = new Set(lanes.light.rounds.map((round) => round.status))
    expect(lightStatuses).toEqual(new Set(['completed', 'cancelled']))
    expect(
      lanes.light.rounds
        .filter((round) => round.status === 'cancelled')
        .every((round) => round.control?.cancelled === true)
    ).toBe(true)
    expect(lanes.heavy.rounds.length).toBeGreaterThanOrEqual(10)
    for (const window of result.windows) {
      expect(window.activity.light?.done).toBeGreaterThan(0)
      expect(window.activity.heavy?.maxQuietMs).toBeLessThanOrEqual(2_000)
    }

    // The heavy lane was stopped mid-round: its round is cancelled, and the
    // observer is gone from the page.
    expect(lanes.heavy.rounds.at(-1)?.endedAtMs).toBeNull()
    expect(result.teardown).toEqual({
      light: 'not_running',
      heavy: 'cancelled',
      observer: 'uninstalled'
    })
    expect(app.cancels.at(-1)).toBe(HEAVY)
    await vi.advanceTimersByTimeAsync(100)
    expect(app.active.get(HEAVY)).toBeNull()
    expect(app.window).not.toHaveProperty(LANE_OBSERVER_GLOBAL)
  })

  it('refuses the windows once a heavy round’s end never reaches the page', async () => {
    // The observer keeps showing heavy-3 running, so the lane never sends
    // again and shows no idle time; only the daemon sees the seats stop.
    const app = liveApp({ dropEndOf: ['heavy-3'] })
    const result = await drive(app.run(), 120_000)
    expect(result.verdict.ok).toBe(false)
    expect(result.windows).toHaveLength(2)
    for (const window of result.windows) {
      expect(window.reasons).toContain('heavy_lane_quiet')
      expect((window as unknown as { heavy: { idleMs: number } }).heavy.idleMs).toBe(0)
    }
    const lanes = result.lanes as { heavy: { rounds: Array<{ roundId: string }> } }
    expect(lanes.heavy.rounds.map((round) => round.roundId)).toEqual([
      'heavy-1',
      'heavy-2',
      'heavy-3'
    ])
    // The lanes still think heavy-3 runs, so the teardown asks; the app has
    // nothing left to cancel.
    expect(result.teardown).toMatchObject({ heavy: 'not_cancelled', observer: 'uninstalled' })
  })
})

describe('liveLanesTeardownFailures', () => {
  it('names each teardown step that failed, and nothing for a tidy page', () => {
    const tidy = { light: 'not_running', heavy: 'cancelled', observer: 'uninstalled' }
    expect(liveLanesTeardownFailures({ teardown: tidy })).toEqual([])
    expect(
      liveLanesTeardownFailures({
        teardown: { light: 'not_cancelled', heavy: 'not_running', observer: 'not_installed' }
      })
    ).toEqual([])
    expect(
      liveLanesTeardownFailures({
        teardown: { light: 'failed', heavy: 'failed', observer: 'failed' }
      })
    ).toEqual([
      "the light lane's round could not be cancelled",
      "the heavy lane's round could not be cancelled",
      'the lane observer could not be removed (failed)'
    ])
    expect(liveLanesTeardownFailures({ teardown: { ...tidy, observer: 'invalid' } })).toEqual([
      'the lane observer could not be removed (invalid)'
    ])
    for (const lanes of [null, {}, { teardown: null }]) {
      expect(liveLanesTeardownFailures(lanes)).toEqual([])
    }
  })
})

describe('withLiveLanesVerdict', () => {
  it('joins the lanes to the smoke, and never passes lanes that did not run', () => {
    const ok = { ok: true, reasons: [] }
    expect(withLiveLanesVerdict(ok, { verdict: ok })).toEqual(ok)
    expect(
      withLiveLanesVerdict(ok, {
        verdict: { ok: false, reasons: ['window 0: d1_no_deferred_append'] }
      })
    ).toEqual({ ok: false, reasons: ['lanes: window 0: d1_no_deferred_append'] })
    expect(withLiveLanesVerdict(ok, null)).toEqual({ ok: false, reasons: ['lanes: not run'] })
    expect(
      withLiveLanesVerdict({ ok: false, reasons: ['smoke: no deferred journal append'] }, null)
    ).toEqual({
      ok: false,
      reasons: ['smoke: no deferred journal append', 'lanes: not run']
    })
    expect(
      withLiveLanesVerdict({ ok: false, reasons: ['smoke: timeout'] }, { verdict: ok })
    ).toEqual({ ok: false, reasons: ['smoke: timeout'] })
  })
})

describe('liveLaneChatsOf', () => {
  it('takes the light chat first and the heavy chat second from the live fixture', () => {
    const fixture = generatePerfFixture({
      workload: 'light_beside_large_live',
      seed: 42,
      lean: true
    })
    expect(liveLaneChatsOf(fixture)).toEqual({
      light: LIGHT,
      heavy: HEAVY,
      lightTitle: LIGHT_TITLE,
      lightModel: LIGHT_MODEL,
      heavyModel: HEAVY_MODEL
    })
  })

  it('refuses a fixture that is not one light chat beside one heavier chat', () => {
    const fixture = (
      ids: string[],
      seats: number[],
      titles = ['light', 'heavy', 'third'],
      models: unknown[][] = [['m-light'], ['m-heavy', 'm-heavy'], ['m-third']]
    ) => ({
      chats: ids.map((appChatId, index) => ({
        appChatId,
        title: titles[index],
        ensemble: { participants: (models[index] ?? []).map((model) => ({ model })) }
      })),
      shape: { chatShapes: seats.map((seatCount) => ({ seatCount })) }
    })
    const refusals = [
      fixture([LIGHT], [4]),
      fixture([LIGHT, HEAVY, 'third'], [4, 30, 30]),
      fixture([LIGHT, HEAVY, 'third'], [4, 30]),
      fixture([LIGHT, HEAVY], [4, 30.5]),
      fixture([LIGHT, HEAVY], [30, 4]),
      fixture([LIGHT, HEAVY], [4, 4]),
      fixture([LIGHT, LIGHT], [4, 30]),
      fixture([LIGHT, ''], [4, 30]),
      fixture([LIGHT, HEAVY], [4]),
      fixture([LIGHT, HEAVY], [4, 30, 50]),
      { chats: [{ appChatId: LIGHT }, { appChatId: HEAVY }] },
      null
    ]
    for (const refused of refusals) {
      expect(() => liveLaneChatsOf(refused)).toThrow(
        expect.objectContaining({ code: 'T2_LIVE_LANES_FIXTURE' })
      )
    }
    for (const titles of [
      ['', 'heavy'],
      ['same', 'same']
    ]) {
      expect(() => liveLaneChatsOf(fixture(['a', 'b'], [1, 2], titles))).toThrow(
        expect.objectContaining({ code: 'T2_LIVE_LANES_FIXTURE' })
      )
    }
    expect(() =>
      liveLaneChatsOf({
        chats: [{ appChatId: 'a' }, { appChatId: 'b', title: 'heavy' }],
        shape: { chatShapes: [{ seatCount: 1 }, { seatCount: 2 }] }
      })
    ).toThrow(expect.objectContaining({ code: 'T2_LIVE_LANES_FIXTURE' }))
    // Each lane chat's seats run one tag, and the two tags differ.
    for (const models of [
      [['m-light'], ['m-light', 'm-light']],
      [['m-light', 'm-other'], ['m-heavy']],
      [[], ['m-heavy']],
      [['m-light'], ['']],
      [['m-light'], [undefined]],
      [['m-light'], [7]]
    ]) {
      expect(() => liveLaneChatsOf(fixture(['a', 'b'], [1, 2], undefined, models))).toThrow(
        expect.objectContaining({ code: 'T2_LIVE_LANES_FIXTURE' })
      )
    }
    expect(() =>
      liveLaneChatsOf({
        chats: [
          { appChatId: 'a', title: 'light' },
          { appChatId: 'b', title: 'heavy' }
        ],
        shape: { chatShapes: [{ seatCount: 1 }, { seatCount: 2 }] }
      })
    ).toThrow(expect.objectContaining({ code: 'T2_LIVE_LANES_FIXTURE' }))
    expect(liveLaneChatsOf(fixture(['a', 'b'], [1, 2]))).toEqual({
      light: 'a',
      heavy: 'b',
      lightTitle: 'light',
      lightModel: 'm-light',
      heavyModel: 'm-heavy'
    })
  })
})

describe('readMainPerfWindow', () => {
  it('reads the labelled snapshot receipt and exact durability section through preload', async () => {
    const requests: unknown[] = []
    const request = { action: 'begin', id: 'beside_0', durationMs: 120 }
    const value = await readMainPerfWindow(
      {
        evaluate: (expression: string) =>
          vm.runInNewContext(expression, {
            window: {
              api: {
                getMainPerfSnapshot: async (options: unknown) => {
                  requests.push(options)
                  return {
                    window: {
                      status: 'started',
                      id: 'beside_0',
                      durability: { flags: { child: '0' } }
                    },
                    sections: { mainDurability: { flags: { child: '0' } } }
                  }
                }
              }
            }
          })
      },
      request,
      100
    )
    expect(requests).toEqual([{ window: request }])
    expect(value).toEqual({
      status: 'started',
      id: 'beside_0',
      durability: { flags: { child: '0' } }
    })
  })

  it('bounds a stalled main invocation', async () => {
    await expect(
      readMainPerfWindow(
        { evaluate: () => new Promise(() => {}) },
        { action: 'end', id: 'beside_0' },
        1
      )
    ).rejects.toMatchObject({ code: 'CAPTURE_TIMEOUT' })
  })
})

describe('readMainWorkSpanWindow', () => {
  const QUERY = { lanes: { light: LIGHT, heavy: HEAVY }, sinceMs: T0, untilMs: T0 + 1_000 }

  /** A main inspector socket that answers each evaluate through `answer`, or never. */
  function fakeSocket(answer: ((message: { id: number; params: unknown }) => unknown) | null) {
    const sent: Array<{ method: string; params: { expression: string } }> = []
    const FakeWs = class {
      handlers: Record<string, (...args: unknown[]) => void> = {}
      constructor() {
        queueMicrotask(() => this.handlers.open && this.handlers.open())
      }
      on(event: string, handler: (...args: unknown[]) => void) {
        this.handlers[event] = handler
      }
      send(data: string) {
        const message = JSON.parse(data)
        sent.push(message)
        if (answer === null) return
        queueMicrotask(() =>
          this.handlers.message(JSON.stringify({ id: message.id, result: answer(message) }))
        )
      }
      close() {
        // Nothing to release.
      }
    }
    return { sent, FakeWs }
  }

  it('reads through the real inspector wrapper and returns main’s text', async () => {
    const { sent, FakeWs } = fakeSocket(() => ({ result: { type: 'string', value: '{"ok":1}' } }))
    const session = await attachMainInspectorSession({
      webSocketDebuggerUrl: 'ws://127.0.0.1:9813/main',
      WebSocket: FakeWs
    })
    await expect(readMainWorkSpanWindow(session, QUERY, 1_000)).resolves.toBe('{"ok":1}')
    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe('Runtime.evaluate')
    expect(sent[0].params.expression).toContain(JSON.stringify(QUERY))
    expect(sent[0].params.expression).toContain(MAIN_WORK_SPANS_GLOBAL)
  })

  it('is bounded by the transport when main never answers', async () => {
    const { FakeWs } = fakeSocket(null)
    const session = await attachMainInspectorSession({
      webSocketDebuggerUrl: 'ws://127.0.0.1:9813/main',
      WebSocket: FakeWs
    })
    await expect(readMainWorkSpanWindow(session, QUERY, 25)).rejects.toThrow(/timed out after 25ms/)
  })

  it('is bounded even by a transport that ignores its per-send bound', async () => {
    vi.useFakeTimers()
    const read = readMainWorkSpanWindow({ post: () => new Promise(() => {}) }, QUERY, 50)
    const settled = expect(read).rejects.toThrow(/main work-span read timed out after 1050ms/)
    await vi.advanceTimersByTimeAsync(1_050)
    await settled
  })

  it('refuses an exception or a reply without a result, and passes a missing handle as null', async () => {
    const session = (reply: unknown) => ({ post: async () => reply })
    await expect(
      readMainWorkSpanWindow(session({ exceptionDetails: { text: 'x' }, result: {} }), QUERY, 50)
    ).rejects.toThrow(/main work-span read failed/)
    await expect(readMainWorkSpanWindow(session({}), QUERY, 50)).rejects.toThrow(
      /main work-span read failed/
    )
    await expect(readMainWorkSpanWindow(session(null), QUERY, 50)).rejects.toThrow(
      /main work-span read failed/
    )
    await expect(
      readMainWorkSpanWindow(
        session({ result: { type: 'object', subtype: 'null', value: null } }),
        QUERY,
        50
      )
    ).resolves.toBeNull()
    await expect(
      readMainWorkSpanWindow(session({ result: { type: 'undefined' } }), QUERY, 50)
    ).resolves.toBeNull()
  })
})
