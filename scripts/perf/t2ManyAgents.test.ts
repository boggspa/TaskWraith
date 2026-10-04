import { createRequire } from 'node:module'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type Verdict = { ok: boolean; reasons: string[] }
type Timings = { count: number; minMs: number; p50Ms: number; p95Ms: number; maxMs: number } | null
type Measures = {
  rounds: { sent: number; completed: number; endedOther: Record<string, number>; unended: number }
  turns: { started: number; done: number; notDone: Record<string, number> }
  sendToAcceptedMs: Timings
  acceptedToFirstTurnMs: Timings
  sendToFirstTurnMs: Timings
  roundMs: Timings
  turnSpacing: {
    modelTurnMs: Timings
    startToStartMs: Timings
    betweenTurnsMs: Timings
    overlapped: number
    appMsPerTurn: Timings
  }
}
type Window = {
  role: string
  repetition: number
  startedAtMs: number
  endedAtMs: number
  drainedAtMs: number
  settledAtMs: number
  reasons: string[]
  agents: {
    window: { startedAtMs: number; endedAtMs: number; lengthMs: number }
    asked: Record<string, unknown>
    configuredTurnMs: number
    overall: Measures & {
      runningAtOnce: { asked: number; max: number; mean: number; noneMs: number }
      threadsFailed: number
    }
    threads: Array<Measures & { thread: number; chatId: string; failure: string | null }>
  } | null
  waiting: {
    limits: Record<string, number> | null
    pool: Record<string, unknown> | null
    limited: boolean | null
    waits: Array<Record<string, unknown>>
    threads: Array<Array<Record<string, unknown>> | null>
    threadsUnread: number
  }
  d1: { deferredAppends: number; normalSaves: number } | null
  main: {
    basis: string
    censored: boolean
    ringRise: Record<string, number> | null
    byKind: Record<string, { count: number; totalMs: number; maxMs: number }>
  } | null
  mainWindow: Record<string, unknown> | null
  mainWindowCensored: boolean
  host: {
    censored: boolean
    reasons: string[]
    counters: Record<string, number> | null
    threadsFolded: number
    byKind: Record<string, Record<string, number>>
  } | null
}
type PhaseResult = {
  schemaVersion: number
  asked: { threads: number; seats: number; agents: number; seatMode: string; atOnce: number }
  options: Record<string, number>
  leadIn: { startedAtMs: number; endedAtMs: number; threadsReady: number; complete: boolean } | null
  windows: Window[]
  hostLag: {
    windows: Array<{ role: string; outcome: string; lag: { sampleCount: number } }>
  } | null
  lanes: { threads: Array<{ chatId: string; rounds: unknown[]; failure: string | null }> } | null
  hostSampler: Record<string, unknown> | null
  teardown: {
    rounds: { notRunning: number; cancelled: number; notCancelled: number; failed: number }
    observer: string
  } | null
  verdict: Verdict
}

const phase = require('./t2ManyAgents.cjs') as {
  DEFAULT_T2_MANY_AGENT_OPTIONS: Record<string, number>
  manyAgentChatsOf: (fixture: unknown) => {
    threads: Array<{ chatId: string; model: string }>
    seats: number
    seatMode: string
  }
  manyAgentsTeardownFailures: (agents: unknown) => string[]
  parseMainAgentSpans: (text: unknown, labels: string[]) => Record<string, unknown>
  runT2ManyAgents: (options: Record<string, unknown>) => Promise<PhaseResult>
  withManyAgentsVerdict: (rounds: unknown, agents: unknown) => Verdict
}
const { generatePerfFixture } = require('./fixtureGenerator.cjs') as {
  generatePerfFixture: (options: Record<string, unknown>) => {
    chats: Array<{ appChatId: string; ensemble: { participants: Array<{ model: string }> } }>
    shape: Record<string, unknown>
  }
}
const { D1_COUNTERS_EXPRESSION } = require('./liveRounds.cjs') as { D1_COUNTERS_EXPRESSION: string }
const { MAIN_WORK_SPANS_GLOBAL } = require('./liveLaneWindows.cjs') as {
  MAIN_WORK_SPANS_GLOBAL: string
}
const { THREAD_OBSERVER_GLOBAL } = require('./liveThreadObserver.cjs') as {
  THREAD_OBSERVER_GLOBAL: string
}
const { scriptedTurnsIn } = require('./scriptedOllamaDaemon.cjs') as {
  scriptedTurnsIn: (turns: DaemonTurn[], fromMs: number, toMs: number) => DaemonTurn[]
}
type DaemonTurn = {
  model: string
  startedAtMs: number
  endedAtMs: number | null
  outcome: string
}

const T0 = Date.parse('2026-10-04T09:00:00.000Z')
const TURN_MS = 1_600
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
const PHASE_OPTIONS = {
  windowMs: 20_000,
  leadInTimeoutMs: 60_000,
  leadInPollMs: 500,
  settleMarginMs: 3_000,
  fenceMs: 500,
  hostCaptureWaitMs: 7_000
}

function laneError(reason: string) {
  return Object.assign(new Error(`thread observer ${reason}`), {
    code: 'T2_LIVE_THREAD_OBSERVER',
    reason
  })
}

type Span = {
  chatId: string
  kind: string
  resource: string
  startedAt: number
  durationMs: number
  reason?: string
}
type WorldOptions = {
  threads?: number
  seats?: number
  mode?: 'serial' | 'parallel'
  installError?: Error
  stopError?: Error
  samplerStarts?: boolean
  /** How long each run queues for the pool before its turn starts. */
  poolWaitMs?: number
  /** Threads (by place) that stop with this failure once they have sent `afterRounds`. */
  failing?: { place: number | number[]; failure: string; afterRounds: number }
  /** A thread whose rounds never end, or every thread. */
  stuck?: number | 'all'
  /** A thread, or every thread, whose rounds end this way. */
  roundStatus?: { place: number | 'all'; status: string }
  /** A thread whose rounds run no model turn. */
  silent?: number
  /** How the daemon records every turn's end. */
  turnOutcome?: string
  daemonFails?: boolean
  d1Throws?: boolean
  /** Every D1 read answers nothing, or only the one before or after the window. */
  d1Unavailable?: boolean | 'before' | 'after'
  d1Frozen?: boolean
  mainHandleAbsent?: boolean
  mainCensored?: boolean
  /** The ring sampled spans out during the window, or had already before it. */
  mainSampledOut?: boolean | 'before'
  mainRejected?: boolean
  noAdmission?: boolean
  /** Span reads (not the two admission reads) for this batch throw. */
  failingBatch?: number
  baselineFails?: boolean
  probeFails?: boolean
  probeHangs?: boolean
  /** Main answers the probe with a snapshot that has no window. */
  probeNoWindow?: boolean
  /** What main answers a window's start and end with, given what it would have. */
  probeBegin?: (receipt: Record<string, unknown>) => unknown
  probeReceipt?: (receipt: Record<string, any>) => unknown
  markerFails?: boolean
  /** The clock starts this far past a whole millisecond, and keeps the fraction. */
  clockOffsetMs?: number
  /** From its third capture the Host answers as another Host. */
  hostIdentityChanges?: boolean
  /** What the sampler answers when stopped, in place of its reads. */
  samplerSummary?: unknown
  /** How many times main answers the window's end with no receipt yet. */
  probeLate?: number
  observerFaults?: boolean
  /** Faults the observer had already counted when the phase began. */
  observerFaultsBefore?: number
  /** The observer's removal fails, or answers this. */
  uninstallFails?: boolean
  uninstallAnswers?: unknown
  /** The sends take this long to stop once the last round has ended. */
  stopTakesMs?: number
  cancelRejects?: boolean
  cancelHangs?: boolean
  hostHole?: boolean
}

/**
 * The phase's surroundings on a virtual clock: scripted lanes whose threads
 * each run rounds back to back (every seat a 1,600 ms turn of the thread's
 * own tag, one after another or together), main's span handle evaluated from
 * the real expression with the admission scheduler's counters, D1 counters
 * behind the page, the daemon's turn record, and a Host that captures every
 * five seconds into whatever union the sampler was handed.
 */
function world(options: WorldOptions = {}) {
  const threadCount = options.threads ?? 3
  const seats = options.seats ?? 2
  const mode = options.mode ?? 'serial'
  const poolWaitMs = options.poolWaitMs ?? 0
  const pad = (place: number, width: number) => String(place + 1).padStart(width, '0')
  const chatIds = Array.from(
    { length: threadCount },
    (_value, place) => `perf-many_agents_live-chat-${pad(place, 2)}`
  )
  const models = chatIds.map((_chatId, place) => `scripted-llama:t${pad(place, 3)}`)

  let now = T0 + (options.clockOffsetMs ?? 0)
  const events: string[] = []
  const queue: Array<{ at: number; order: number; run: () => void }> = []
  let order = 0
  const at = (time: number, run: () => void) => queue.push({ at: time, order: order++, run })
  const advanceTo = (target: number) => {
    for (;;) {
      let next: (typeof queue)[number] | null = null
      for (const event of queue) {
        if (event.at > target) continue
        if (
          next === null ||
          event.at < next.at ||
          (event.at === next.at && event.order < next.order)
        )
          next = event
      }
      if (next === null) break
      queue.splice(queue.indexOf(next), 1)
      now = Math.max(now, next.at)
      next.run()
    }
    now = Math.max(now, target)
  }
  // Every wait here resolves at once, so a runaway loop fails instead of
  // starving vitest's own timeout.
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
    if (now - T0 > 6 * 3_600_000) throw new Error('the virtual clock ran away')
    advanceTo(now + ms)
  }

  const mainSpans: Span[] = []
  const hostSpans: Array<Span & { seq: number }> = []
  const daemonTurns: DaemonTurn[] = []
  const daemonReads: Array<{ fromMs: number; toMs: number }> = []
  const pool = { requests: 0, admitted: 0, initiallyQueued: 0, admittedQueueWaitMs: 0 }
  let streaming = 0
  let peakActive = 0
  let deferredAppends = 0
  let sending = false
  let observerFaults = options.observerFaultsBefore ?? 0
  type Round = {
    roundId: string
    sentAtMs: number
    acceptedAtMs: number
    pageMs: number
    endedAtMs: number | null
    status: string | null
  }
  const threads = chatIds.map((chatId) => ({
    chatId,
    rounds: [] as Round[],
    failure: null as string | null,
    active: false
  }))

  const runTurn = (place: number, startAt: number) => {
    at(startAt - 20, () => {
      pool.requests += 1
      pool.admitted += 1
      if (poolWaitMs > 0) {
        pool.initiallyQueued += 1
        pool.admittedQueueWaitMs += poolWaitMs
      }
      mainSpans.push({
        chatId: chatIds[place],
        kind: 'admission_wait',
        resource: 'ensemble_pool',
        reason: 'admitted',
        startedAt: startAt - 20 - poolWaitMs,
        durationMs: poolWaitMs
      })
      mainSpans.push({
        chatId: chatIds[place],
        kind: 'prompt_build',
        resource: 'none',
        startedAt: startAt - 20,
        durationMs: 15
      })
    })
    at(startAt, () => {
      const turn: DaemonTurn = {
        model: models[place],
        startedAtMs: startAt,
        endedAtMs: null,
        outcome: 'streaming'
      }
      daemonTurns.push(turn)
      streaming += 1
      peakActive = Math.max(peakActive, streaming)
      at(startAt + TURN_MS, () => {
        streaming -= 1
        if (options.turnOutcome === 'streaming') return
        turn.endedAtMs = startAt + TURN_MS
        turn.outcome = options.turnOutcome ?? 'done'
        deferredAppends += 1
        hostSpans.push({
          seq: hostSpans.length + 1,
          chatId: chatIds[place],
          kind: 'durable_commit',
          resource: 'host_chain',
          // A longer commit on each later thread: 10, 11, 12 ms...
          startedAt: startAt + TURN_MS - 10 - place,
          durationMs: 10 + place
        })
      })
    })
  }

  const send = (place: number) => {
    const thread = threads[place]
    if (!sending || thread.failure !== null || thread.active) return
    if (
      options.failing &&
      [options.failing.place].flat().includes(place) &&
      thread.rounds.length >= options.failing.afterRounds
    ) {
      thread.failure = options.failing.failure
      return
    }
    const sentAtMs = now
    const round: Round = {
      roundId: `t${place + 1}-${thread.rounds.length + 1}`,
      sentAtMs,
      acceptedAtMs: sentAtMs + 50,
      pageMs: 45,
      endedAtMs: null,
      status: null
    }
    thread.rounds.push(round)
    thread.active = true
    mainSpans.push({
      chatId: chatIds[place],
      kind: 'round_start',
      resource: 'none',
      startedAt: sentAtMs,
      durationMs: 40
    })
    let turnsEndAt = sentAtMs + 150
    if (options.silent !== place) {
      for (let seat = 0; seat < seats; seat += 1) {
        const startAt = sentAtMs + 150 + seat * (mode === 'serial' ? TURN_MS + 100 : 10)
        runTurn(place, startAt)
        turnsEndAt = startAt + TURN_MS
      }
      if (mode === 'serial') turnsEndAt += 100
    }
    if (options.stuck === 'all' || options.stuck === place) return
    at(turnsEndAt + 50, () => {
      round.endedAtMs = turnsEndAt + 50
      round.status =
        options.roundStatus && ['all', place].includes(options.roundStatus.place)
          ? options.roundStatus.status
          : 'completed'
      thread.active = false
      // The driver sees the end a poll later and sends again.
      at(round.endedAtMs + 250, () => send(place))
    })
  }

  const snapshot = () => ({
    observer: { installId: 'install-1', faults: observerFaults, failure: null },
    sending,
    threads: threads.map((thread) => ({
      chatId: thread.chatId,
      rounds: thread.rounds.map((round) => ({ ...round })),
      failure: thread.failure,
      deliveries: { full: 0, compact: thread.rounds.length * 2 }
    }))
  })

  // The page's window: the app's cancel, the main window probe, and the
  // observer global the lanes install.
  let probeStartedAtMs = 0
  let probeDurationMs = 0
  let probeEndAsks = 0
  const cancels: string[] = []
  const pageWindow: Record<string, unknown> = {
    api: {
      getMainPerfSnapshot: async (request: {
        window: { action: string; id: string; durationMs?: number }
      }) => {
        if (options.probeFails) throw new Error('main went away')
        if (options.probeHangs) return new Promise(() => {})
        if (options.probeNoWindow) return { sections: {} }
        const { action, id, durationMs } = request.window
        if (action === 'begin') {
          probeStartedAtMs = now
          probeDurationMs = durationMs ?? 0
          const begun = { status: 'started', id, startedAtMs: now }
          return { window: options.probeBegin ? options.probeBegin(begun) : begun, sections: {} }
        }
        probeEndAsks += 1
        if (probeEndAsks <= (options.probeLate ?? 0)) {
          return { window: { status: 'unavailable', reason: 'window_incomplete' }, sections: {} }
        }
        const receipt = {
          status: 'complete',
          id,
          startedAtMs: probeStartedAtMs,
          endedAtMs: probeStartedAtMs + probeDurationMs,
          eventLoopLag: {
            sampling: true,
            observedForMs: probeDurationMs,
            p50Ms: 1,
            p95Ms: 3,
            p99Ms: 5,
            maxMs: 10,
            meanMs: 2
          }
        }
        return {
          window: options.probeReceipt ? options.probeReceipt(receipt) : receipt,
          sections: {}
        }
      },
      cancelEnsembleRound: (chatId: string) => {
        cancels.push(chatId)
        if (options.cancelHangs) return new Promise(() => {})
        if (options.cancelRejects) return Promise.reject(new Error('refused'))
        const thread = threads[chatIds.indexOf(chatId)]
        const running = thread.active
        thread.active = false
        return Promise.resolve(running)
      }
    }
  }
  let laneOptions: Record<string, unknown> | null = null
  const createLanes = (received: Record<string, unknown>) => {
    laneOptions = received
    return {
      install: async () => {
        events.push('install')
        if (options.installError) throw options.installError
        pageWindow[THREAD_OBSERVER_GLOBAL] = { unsubscribe: [() => events.push('unsubscribed')] }
      },
      start: () => {
        events.push('start')
        sending = true
        threads.forEach((_thread, place) => send(place))
      },
      stopSending: async () => {
        events.push('stopSending')
        sending = false
        if (options.observerFaults) observerFaults += 1
        // Every round in flight runs to its end; a stuck one hits its bound.
        for (let waited = 0; threads.some((thread) => thread.active); waited += 100) {
          if (waited >= 10_000) {
            for (const thread of threads.filter((entry) => entry.active)) {
              thread.failure = 'unobserved'
              thread.active = false
            }
            break
          }
          advanceTo(now + 100)
        }
        // As when a send in flight ran to its bound after the last round ended.
        if (options.stopTakesMs) advanceTo(now + options.stopTakesMs)
        const ends = threads.map((thread) => thread.rounds[thread.rounds.length - 1]?.endedAtMs)
        return {
          drainedAtMs: ends.some((end) => end === null || end === undefined)
            ? null
            : Math.max(...(ends as number[]))
        }
      },
      snapshot,
      stop: async () => {
        events.push('lanes.stop')
        sending = false
        if (options.stopError) throw options.stopError
        return snapshot()
      }
    }
  }

  let d1Reads = 0
  const page = {
    evaluate: async (expression: string) => {
      if (expression === D1_COUNTERS_EXPRESSION) {
        d1Reads += 1
        if (options.d1Throws) throw new Error('renderer went away')
        if (
          options.d1Unavailable === true ||
          (options.d1Unavailable === 'before' && d1Reads === 1) ||
          (options.d1Unavailable === 'after' && d1Reads === 2)
        ) {
          return null
        }
        const count = options.d1Frozen ? 0 : deferredAppends
        return { deferredAppends: count, normalSaves: count }
      }
      if (expression.includes('uninstallThreadObserverInPage')) {
        if (options.uninstallFails) throw new Error('renderer went away')
        if ('uninstallAnswers' in options) return options.uninstallAnswers
      }
      return vm.runInNewContext(expression, {
        window: pageWindow,
        performance: { now: () => now }
      })
    }
  }

  const mainQueries: Array<{ lanes: Record<string, string>; sinceMs: number; untilMs: number }> = []
  const markers: string[] = []
  let spanReads = 0
  const mainReadBounds: unknown[] = []
  const mainSession = {
    post: async (_method: string, params: { expression: string }, sendOptions?: unknown) => {
      if (!params.expression.includes('tw_calibration_')) mainReadBounds.push(sendOptions)
      if (params.expression.includes('tw_calibration_')) {
        markers.push(`marker@${now - T0}`)
        if (options.markerFails) return { exceptionDetails: { text: 'marker refused' } }
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
      const handle = (query: (typeof mainQueries)[number]) => {
        mainQueries.push(query)
        const isSpanRead = query.untilMs > query.sinceMs
        if (isSpanRead) {
          spanReads += 1
          if (options.failingBatch === spanReads - 1) throw new Error('main read failed')
        } else if (options.baselineFails && mainQueries.length === 1) {
          throw new Error('main read failed')
        }
        return {
          sampledAt: now,
          sinceMs: query.sinceMs,
          untilMs: query.untilMs,
          censored: options.mainCensored === true && isSpanRead,
          ring: {
            recorded: mainSpans.length,
            dropped: 0,
            sampledOut:
              options.mainSampledOut === 'before' || (options.mainSampledOut && isSpanRead) ? 3 : 0,
            rejected: options.mainRejected && isSpanRead ? 1 : 0,
            degraded: 0
          },
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
                    resource: span.resource,
                    bytes: 0,
                    fallback: false,
                    ...(span.reason === undefined ? {} : { reason: span.reason })
                  })),
                admission: { active: 0, queued: 0 }
              }
            ])
          ),
          admission: options.noAdmission
            ? null
            : {
                occupancy: {
                  maxActive: 30,
                  maxForeground: 24,
                  reservedLaneSlots: 6,
                  maxQueued: 256,
                  active: streaming,
                  activeForeground: streaming,
                  activeLanes: 0,
                  queued: 0,
                  queuedForeground: 0,
                  queuedLanes: 0,
                  shuttingDown: false
                },
                metrics: {
                  requests: pool.requests,
                  reservations: pool.requests,
                  initiallyQueued: pool.initiallyQueued,
                  admitted: pool.admitted,
                  released: pool.admitted - streaming,
                  cancelledQueued: 0,
                  cancelledUnclaimed: 0,
                  overflowRejected: 0,
                  admittedQueueWaitMs: pool.admittedQueueWaitMs,
                  maxAdmittedQueueWaitMs: poolWaitMs,
                  peakActive,
                  peakQueued: poolWaitMs > 0 ? 1 : 0
                }
              }
        }
      }
      const value = vm.runInNewContext(
        params.expression,
        options.mainHandleAbsent ? {} : { [MAIN_WORK_SPANS_GLOBAL]: handle }
      )
      return { result: { type: 'string', value } }
    }
  }

  // The Host: a capture every five seconds into the sampler's union.
  const samples: Array<Record<string, unknown>> = []
  let union: { add: (sample: unknown) => { ok: boolean } } | null = null
  let samplerStarted = false
  let hostSequence = 0
  const capture = () => {
    at(now + 5_000, capture)
    if (!samplerStarted || union === null) return
    hostSequence += 1
    const chats: string[] = []
    // A hole: the tail no longer reaches back to the previous capture's.
    const tail = options.hostHole ? hostSpans.slice(-2) : hostSpans
    const rows = tail.map((span) => {
      let chat = chats.indexOf(span.chatId)
      if (chat < 0) chat = chats.push(span.chatId) - 1
      return [
        span.seq,
        chat,
        span.kind,
        span.resource,
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
      identity: {
        process: 'host',
        instanceId: options.hostIdentityChanges && hostSequence > 2 ? 'host-2' : 'host-1',
        generation: 1,
        pid: 4242
      },
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
          limit: options.hostHole ? 2 : 1_024,
          fromSeq: rows.length > 0 ? tail[0].seq : null,
          toSeq: rows.length > 0 ? tail[tail.length - 1].seq : null,
          omittedMaxStartedAt:
            options.hostHole && hostSpans.length > 2
              ? hostSpans[hostSpans.length - 3].startedAt
              : null,
          chats,
          rows
        }
      }
    }
    union.add(sample)
    samples.push({ ...sample, workSpans })
  }
  at(T0 + 5_000, capture)
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
        return 'samplerSummary' in options
          ? options.samplerSummary
          : { status: 'stopped', accepted: samples.length, refusals: {}, samples }
      }
    }
  }

  const readDaemonTurns = async (range: { fromMs: number; toMs: number }) => {
    daemonReads.push(range)
    if (options.daemonFails) throw new Error('daemon went away')
    if (range.toMs > now) throw new Error('to must not be in the future')
    return scriptedTurnsIn(daemonTurns, range.fromMs, range.toMs)
  }

  const calibration: Array<Record<string, unknown>> = []
  const calibrationFailures: string[] = []
  const run = (extra: Record<string, unknown> = {}) =>
    phase.runT2ManyAgents({
      page,
      mainSession,
      threads: chatIds.map((chatId, place) => ({ chatId, model: models[place] })),
      seats,
      seatMode: mode,
      configuredTurnMs: TURN_MS,
      readDaemonTurns,
      createHostSampler,
      createLanes,
      nowMs: () => now,
      sleep,
      onCalibrationMarker: (marker: Record<string, unknown>) => calibration.push(marker),
      onCalibrationFailure: (reason: string) => calibrationFailures.push(reason),
      ...PHASE_OPTIONS,
      ...extra
    })
  return {
    run,
    events,
    sleeps,
    chatIds,
    models,
    mainQueries,
    markers,
    calibration,
    calibrationFailures,
    daemonReads,
    cancels,
    pageWindow,
    threads,
    get laneOptions() {
      return laneOptions
    },
    get probeEndAsks() {
      return probeEndAsks
    },
    mainReadBounds,
    get now() {
      return now
    }
  }
}

const timing = (value: number, count: number) => ({
  count,
  minMs: value,
  p50Ms: value,
  p95Ms: value,
  maxMs: value
})

describe('a many-agent window, seats one after another', () => {
  it('runs the phase in order: sampler, observer, rounds, window, drain, reads, teardown', async () => {
    const w = world()
    const result = await w.run()
    expect(w.events).toEqual([
      'sampler.start',
      'install',
      'start',
      'stopSending',
      'lanes.stop',
      'sampler.stop',
      'unsubscribed'
    ])
    expect(result.verdict).toEqual({ ok: true, reasons: [] })
    expect(result.schemaVersion).toBe(1)
    expect(result.windows).toHaveLength(1)
    expect(result.windows[0].reasons).toEqual([])
  })

  it('waits for every thread’s first round to end before it measures', async () => {
    const w = world()
    const result = await w.run()
    // Each first round ends 3,600 ms in; the lead-in polls every 500 ms.
    expect(result.leadIn).toEqual({
      startedAtMs: T0,
      endedAtMs: T0 + 4_000,
      threadsReady: 3,
      complete: true
    })
    // Then a Host capture's wait, and the window.
    expect(result.windows[0]).toMatchObject({
      role: 'many-agents',
      repetition: 0,
      startedAtMs: T0 + 11_000,
      endedAtMs: T0 + 31_000
    })
  })

  it('stops the sends at the window’s end and reads only once the rounds have drained and settled', async () => {
    const w = world()
    const result = await w.run()
    // The round sent 30,800 ms in ends at 34,400; then the margin and the fence.
    expect(result.windows[0]).toMatchObject({
      drainedAtMs: T0 + 34_400,
      settledAtMs: T0 + 37_400
    })
    const spanReads = w.mainQueries.filter((query) => query.untilMs > query.sinceMs)
    expect(spanReads).toEqual([
      {
        lanes: { t001: w.chatIds[0], t002: w.chatIds[1], t003: w.chatIds[2] },
        sinceMs: T0 + 11_000,
        untilMs: T0 + 31_000
      }
    ])
    expect(w.daemonReads).toEqual([{ fromMs: T0 + 11_000, toMs: T0 + 37_900 }])
  })

  it('reports each thread’s rounds, its send and first-turn times and its turn spacing', async () => {
    const w = world()
    const { agents } = (await w.run()).windows[0]
    expect(agents?.window).toEqual({
      startedAtMs: T0 + 11_000,
      endedAtMs: T0 + 31_000,
      lengthMs: 20_000
    })
    expect(agents?.configuredTurnMs).toBe(1_600)
    expect(agents?.threads).toHaveLength(3)
    for (const [place, thread] of agents!.threads.entries()) {
      expect(thread).toMatchObject({ thread: place + 1, chatId: w.chatIds[place], failure: null })
      expect(thread.rounds).toMatchObject({ sent: 6, completed: 6, endedOther: {}, unended: 0 })
      expect(thread.turns).toEqual({ started: 11, done: 11, notDone: {} })
      expect(thread.sendToAcceptedMs).toEqual(timing(45, 6))
      expect(thread.acceptedToFirstTurnMs).toEqual(timing(100, 6))
      expect(thread.sendToFirstTurnMs).toEqual(timing(150, 6))
      expect(thread.roundMs).toEqual(timing(3_600, 6))
      expect(thread.turnSpacing).toEqual({
        modelTurnMs: timing(1_600, 11),
        startToStartMs: timing(1_700, 6),
        betweenTurnsMs: timing(100, 6),
        overlapped: 0,
        appMsPerTurn: timing(200, 6)
      })
    }
    expect(agents?.overall.rounds).toMatchObject({ sent: 18, completed: 18 })
    expect(agents?.overall.turns).toEqual({ started: 33, done: 33, notDone: {} })
  })

  it('says how many agents ran at once against how many were asked for', async () => {
    const w = world()
    const result = await w.run()
    expect(result.asked).toEqual({ threads: 3, seats: 2, agents: 6, seatMode: 'serial', atOnce: 3 })
    expect(result.windows[0].agents?.asked).toEqual(result.asked)
    // One seat of each thread at a time, 16,200 ms of each thread's 20,000.
    expect(result.windows[0].agents?.overall.runningAtOnce).toEqual({
      asked: 3,
      max: 3,
      mean: 2.43,
      noneMs: 3_800
    })
  })

  it('reports the pool’s limits and that nothing waited behind them', async () => {
    const w = world()
    const { waiting } = (await w.run()).windows[0]
    expect(waiting.limits).toEqual({ maxActive: 30, maxForeground: 24, maxQueued: 256 })
    expect(waiting.pool).toMatchObject({
      cause: 'ensemble_pool',
      requests: 33,
      admitted: 33,
      queued: 0,
      queueWaitMs: 0,
      overflowRejected: 0
    })
    expect(waiting.limited).toBe(false)
    expect(waiting.threadsUnread).toBe(0)
    expect(waiting.threads[0]).toEqual([
      {
        kind: 'admission_wait',
        resource: 'ensemble_pool',
        count: 11,
        waited: 0,
        totalMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        maxMs: 0,
        reasons: { admitted: 11 }
      }
    ])
    // The two admission reads bracket the window, each a read of no spans.
    const admissionReads = w.mainQueries.filter((query) => query.untilMs === query.sinceMs)
    expect(admissionReads).toEqual([
      { lanes: { t001: w.chatIds[0] }, sinceMs: T0 + 11_000, untilMs: T0 + 11_000 },
      { lanes: { t001: w.chatIds[0] }, sinceMs: T0 + 31_000, untilMs: T0 + 31_000 }
    ])
  })

  it('shows waiting behind the pool as waiting, with its cause', async () => {
    const w = world({ poolWaitMs: 400 })
    const { waiting, reasons } = (await w.run()).windows[0]
    expect(waiting.pool).toMatchObject({
      cause: 'ensemble_pool',
      queued: waiting.pool?.requests,
      queueWaitMs: 400 * (waiting.pool?.requests as number)
    })
    expect(waiting.limited).toBe(true)
    expect(waiting.waits[0]).toMatchObject({
      kind: 'admission_wait',
      resource: 'ensemble_pool',
      p50Ms: 400,
      maxMs: 400
    })
    expect(waiting.waits[0].waited).toBe(waiting.waits[0].count)
    // Waiting is a finding, not a fault of the window.
    expect(reasons).toEqual([])
  })

  it('folds main’s spans of every thread by kind, with the ring’s rise', async () => {
    const w = world()
    const { main } = (await w.run()).windows[0]
    expect(main?.censored).toBe(false)
    // What the ring recorded between the read before the window and the spans' read.
    expect(main?.ringRise).toEqual({
      recorded: 90,
      dropped: 0,
      sampledOut: 0,
      rejected: 0,
      degraded: 0
    })
    expect(Object.keys(main!.byKind)).toEqual(['round_start', 'admission_wait', 'prompt_build'])
    expect(main?.byKind.round_start).toMatchObject({ count: 18, totalMs: 720, maxMs: 40 })
    expect(main?.byKind.admission_wait).toMatchObject({ count: 33, totalMs: 0 })
    expect(main?.byKind.prompt_build).toMatchObject({ count: 33, totalMs: 495, maxMs: 15 })
  })

  it('brackets the window with main’s own probe and two profile markers', async () => {
    const w = world()
    const { mainWindow, mainWindowCensored } = (await w.run()).windows[0]
    expect(mainWindowCensored).toBe(false)
    expect(mainWindow).toMatchObject({
      status: 'complete',
      id: 'many_agents_0',
      startedAtMs: T0 + 11_000,
      endedAtMs: T0 + 31_000,
      eventLoopLag: { sampling: true, p95Ms: 3 },
      durabilityBefore: null
    })
    expect(w.markers).toEqual(['marker@11000', 'marker@31000'])
    expect(w.calibration.map((marker) => marker.windowId)).toEqual([
      'many_agents_0',
      'many_agents_0'
    ])
    expect(w.calibrationFailures).toEqual([])
  })

  it('counts the deferred appends between the window’s fences', async () => {
    const w = world()
    // Thirteen turns of each thread end between the two reads.
    expect((await w.run()).windows[0].d1).toEqual({ deferredAppends: 39, normalSaves: 39 })
  })

  it('folds the Host’s spans of every thread, and its lag over the window', async () => {
    const w = world()
    const result = await w.run()
    const { host } = result.windows[0]
    expect(host).toMatchObject({ censored: false, reasons: [], threadsFolded: 3 })
    expect(host?.counters).toMatchObject({ sampledOut: 0, rejected: 0, degraded: 0 })
    // Eleven commits a thread, of 10, 11 and 12 ms: pooled, with the slowest thread's p95.
    expect(host?.byKind).toEqual({
      durable_commit: {
        count: 33,
        totalMs: 363,
        maxMs: 12,
        bytes: 0,
        fallbackCount: 0,
        threadP95MsMax: 12
      }
    })
    expect(result.hostLag?.windows).toHaveLength(1)
    expect(result.hostLag?.windows[0]).toMatchObject({ role: 'many-agents', outcome: 'eligible' })
    expect(result.hostLag?.windows[0].lag.sampleCount).toBeGreaterThan(0)
    expect(result.hostSampler).toMatchObject({ status: 'stopped' })
    expect(result.hostSampler).not.toHaveProperty('samples')
  })

  it('keeps every thread’s rounds as the driver recorded them', async () => {
    const w = world()
    const result = await w.run()
    expect(result.lanes?.threads.map((thread) => thread.chatId)).toEqual(w.chatIds)
    expect(result.lanes?.threads[0].rounds).toHaveLength(9)
    expect(result.lanes?.threads[0].rounds[0]).toEqual({
      roundId: 't1-1',
      sentAtMs: T0,
      acceptedAtMs: T0 + 50,
      pageMs: 45,
      endedAtMs: T0 + 3_600,
      status: 'completed'
    })
  })

  it('hands the lanes the page, the chats, the clock and its options', async () => {
    const w = world()
    const result = await w.run({ laneOptions: { roundTimeoutMs: 9_000 }, callTimeoutMs: 4_000 })
    expect(w.laneOptions).toMatchObject({
      chatIds: w.chatIds,
      callTimeoutMs: 4_000,
      roundTimeoutMs: 9_000
    })
    expect(typeof w.laneOptions?.nowMs).toBe('function')
    expect(typeof w.laneOptions?.sleep).toBe('function')
    expect(result.options).toEqual({ ...PHASE_OPTIONS, callTimeoutMs: 4_000 })
    // Every read of main's span handle carries the same bound to the inspector.
    expect(w.mainReadBounds).toEqual([
      { timeoutMs: 4_000 },
      { timeoutMs: 4_000 },
      { timeoutMs: 4_000 }
    ])
    // Lane options that are not a set of options are left out.
    const other = world()
    await other.run({ laneOptions: 'fast' })
    expect(Object.keys(other.laneOptions!).sort()).toEqual([
      'callTimeoutMs',
      'chatIds',
      'nowMs',
      'page',
      'sleep'
    ])
  })

  it('hands the window to whoever asked for it as it closes, and survives them', async () => {
    const seen: Window[] = []
    const result = await world().run({
      onWindow: (window: Window) => {
        seen.push(window)
        throw new Error('listener broke')
      }
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(result.windows[0])
    // Its reasons are a copy: the listener cannot add one.
    expect(seen[0].reasons).not.toBe(result.windows[0].reasons)
    expect(result.verdict).toEqual({ ok: true, reasons: [] })
  })

  it('reads the daemon over whole milliseconds on a clock that has fractions', async () => {
    const w = world({ clockOffsetMs: 0.75 })
    const result = await w.run()
    expect(result.windows[0].startedAtMs).toBe(T0 + 11_000.75)
    expect(w.daemonReads).toEqual([{ fromMs: T0 + 11_000, toMs: T0 + 37_900 }])
    expect(result.verdict).toEqual({ ok: true, reasons: [] })
  })

  it('takes no marker when no one asked for them', async () => {
    const w = world()
    const result = await w.run({ onCalibrationMarker: undefined })
    expect(w.markers).toEqual([])
    expect(result.verdict.ok).toBe(true)
  })

  it('reports a marker it could not take, and still measures the window', async () => {
    const w = world({ markerFails: true })
    const result = await w.run()
    expect(w.calibration).toEqual([])
    expect(w.calibrationFailures).toEqual([
      'window_start_marker_failed',
      'window_end_marker_failed'
    ])
    expect(result.verdict).toEqual({ ok: true, reasons: [] })
    // With no one to tell, it carries on all the same.
    const untold = await world({ markerFails: true }).run({ onCalibrationFailure: undefined })
    expect(untold.verdict.ok).toBe(true)
  })

  it('keeps what main said of durability as the window began', async () => {
    const w = world({ probeBegin: (receipt) => ({ ...receipt, durability: { mainFsyncs: 3 } }) })
    expect((await w.run()).windows[0].mainWindow).toMatchObject({
      durabilityBefore: { mainFsyncs: 3 }
    })
  })

  it('tidies the page: nothing left running, the observer removed', async () => {
    const w = world()
    const result = await w.run()
    expect(result.teardown).toEqual({
      rounds: { notRunning: 3, cancelled: 0, notCancelled: 0, failed: 0 },
      observer: 'uninstalled'
    })
    expect(w.cancels).toEqual([])
    expect(w.pageWindow[THREAD_OBSERVER_GLOBAL]).toBeUndefined()
    expect(phase.manyAgentsTeardownFailures(result)).toEqual([])
  })
})

describe('a many-agent window, seats together', () => {
  it('asks for every seat at once and sees them stream together', async () => {
    const w = world({ mode: 'parallel' })
    const result = await w.run()
    expect(result.verdict).toEqual({ ok: true, reasons: [] })
    expect(result.asked).toEqual({
      threads: 3,
      seats: 2,
      agents: 6,
      seatMode: 'parallel',
      atOnce: 6
    })
    const { overall, threads } = result.windows[0].agents!
    expect(overall.runningAtOnce).toMatchObject({ asked: 6, max: 6 })
    expect(threads[0].turnSpacing.betweenTurnsMs).toBeNull()
    expect(threads[0].turnSpacing.overlapped).toBe(threads[0].turnSpacing.startToStartMs?.count)
    expect(threads[0].turnSpacing.startToStartMs).toMatchObject({ minMs: 10, maxMs: 10 })
    // A round is 1,810 ms with a turn streaming for 1,610 of them, two turns.
    expect(threads[0].turnSpacing.appMsPerTurn).toMatchObject({ minMs: 100, maxMs: 100 })
  })
})

describe('many threads', () => {
  it('reads main’s spans and folds the Host’s eight threads at a time', async () => {
    const w = world({ threads: 20, seats: 1 })
    const result = await w.run()
    expect(result.verdict).toEqual({ ok: true, reasons: [] })
    const spanReads = w.mainQueries.filter((query) => query.untilMs > query.sinceMs)
    expect(spanReads.map((query) => Object.keys(query.lanes).length)).toEqual([8, 8, 4])
    expect(spanReads.flatMap((query) => Object.values(query.lanes))).toEqual(w.chatIds)
    expect(Object.keys(spanReads[2].lanes)).toEqual(['t017', 't018', 't019', 't020'])
    const window = result.windows[0]
    expect(window.agents?.threads).toHaveLength(20)
    expect(window.waiting.threads).toHaveLength(20)
    expect(window.waiting.threadsUnread).toBe(0)
    expect(window.host).toMatchObject({ censored: false, threadsFolded: 20 })
    expect(window.host?.byKind.durable_commit.count).toBe(window.agents?.overall.turns.done)
    expect(window.agents?.overall.runningAtOnce).toMatchObject({ asked: 20, max: 20 })
  })
})

describe('a window that is not evidence says why', () => {
  const reasonsOf = async (options: WorldOptions, extra: Record<string, unknown> = {}) => {
    const result = await world(options).run(extra)
    expect(result.verdict.ok).toBe(false)
    expect(result.verdict.reasons).toEqual(
      result.windows[0].reasons.map((reason) => `window 0: ${reason}`)
    )
    return result.windows[0].reasons
  }

  it('names a thread that failed, once per kind of failure', async () => {
    const w = world({ threads: 4, failing: { place: [1, 2], failure: 'steered', afterRounds: 4 } })
    const result = await w.run()
    expect(result.windows[0].reasons).toEqual(['thread_failed:steered'])
    expect(result.windows[0].agents?.overall.threadsFailed).toBe(2)
    expect(result.windows[0].agents?.threads[1].failure).toBe('steered')
    // The other threads kept their rounds going.
    expect(result.windows[0].agents?.threads[0].rounds.completed).toBe(6)
  })

  it('names a thread whose round never drained', async () => {
    expect(await reasonsOf({ stuck: 2 })).toEqual([
      'lead_in_incomplete',
      'thread_failed:unobserved',
      'threads_not_drained'
    ])
  })

  it('settles from when the sends stopped draining when a round never ended', async () => {
    const result = await world({ stuck: 2 }).run()
    // The lead-in ran its full minute; the stuck round hit its bound ten
    // seconds after the window's end.
    expect(result.windows[0]).toMatchObject({
      startedAtMs: T0 + 67_000,
      endedAtMs: T0 + 87_000,
      drainedAtMs: T0 + 97_000,
      settledAtMs: T0 + 100_000
    })
  })

  it('settles from the window’s end when every round had ended before it', async () => {
    const w = world({ threads: 1, failing: { place: 0, failure: 'steered', afterRounds: 5 } })
    const result = await w.run()
    // Its fifth round ended 19,000 ms in; the window ran to 31,000.
    expect(result.windows[0]).toMatchObject({
      drainedAtMs: T0 + 31_000,
      settledAtMs: T0 + 34_000
    })
  })

  it('names rounds that ended any other way than completed', async () => {
    expect(await reasonsOf({ roundStatus: { place: 0, status: 'failed' } })).toEqual([
      'round_failed'
    ])
    // The Host's lag for that window is marked with the first reason.
    const failed = await world({ roundStatus: { place: 0, status: 'failed' } }).run()
    expect(failed.hostLag?.windows[0]).toMatchObject({
      outcome: 'censored',
      reason: 'round_failed'
    })
    // And says so when none completed at all.
    expect(await reasonsOf({ roundStatus: { place: 'all', status: 'failed' } })).toEqual([
      'rounds_missing',
      'round_failed'
    ])
  })

  it('names rounds that ran no model turn', async () => {
    expect(await reasonsOf({ silent: 1 })).toEqual(['rounds_without_turn'])
  })

  it('names turns the model did not finish', async () => {
    expect(await reasonsOf({ turnOutcome: 'aborted' })).toEqual(['turns_aborted'])
    // Nor one still streaming once the rounds had drained and settled.
    expect(await reasonsOf({ turnOutcome: 'streaming' })).toEqual([
      'turns_streaming',
      'd1_no_deferred_append'
    ])
  })

  it('names an observer that counted a fault during the window', async () => {
    expect(await reasonsOf({ observerFaults: true })).toEqual(['observer_faults'])
    // Faults from before the window are not the window's.
    const earlier = await world({ observerFaultsBefore: 2 }).run()
    expect(earlier.verdict).toEqual({ ok: true, reasons: [] })
  })

  it('has no agent figures when the daemon’s turns cannot be read', async () => {
    const result = await world({ daemonFails: true }).run()
    expect(result.windows[0].reasons).toEqual(['daemon_turns_unavailable'])
    expect(result.windows[0].agents).toBeNull()
    // The rest of the window's evidence stands.
    expect(result.windows[0].waiting.pool).not.toBeNull()
  })

  it('names missing or unmoved D1 counters', async () => {
    expect(await reasonsOf({ d1Unavailable: true })).toEqual(['d1_counters_unavailable'])
    expect(await reasonsOf({ d1Throws: true })).toEqual(['d1_counters_unavailable'])
    expect(await reasonsOf({ d1Unavailable: 'before' })).toEqual(['d1_counters_unavailable'])
    expect(await reasonsOf({ d1Unavailable: 'after' })).toEqual(['d1_counters_unavailable'])
    expect(await reasonsOf({ d1Frozen: true })).toEqual(['d1_no_deferred_append'])
  })

  it('names a main that has no span handle', async () => {
    const result = await world({ mainHandleAbsent: true }).run()
    expect(result.windows[0].reasons).toEqual(['admission_unavailable', 'main_handle_absent'])
    expect(result.windows[0].main).toBeNull()
    expect(result.windows[0].waiting).toMatchObject({ pool: null, limited: null, threadsUnread: 3 })
  })

  it('names a batch of threads whose spans could not be read, and keeps the others', async () => {
    // Twenty threads are three reads: the second fails, the third is still made.
    const w = world({ threads: 20, seats: 1, failingBatch: 1 })
    const result = await w.run()
    expect(result.windows[0].reasons).toEqual(['main_read_failed'])
    expect(result.windows[0].waiting.threadsUnread).toBe(8)
    expect(result.windows[0].waiting.threads.slice(8, 16)).toEqual(Array(8).fill(null))
    expect(result.windows[0].waiting.threads[0]).not.toBeNull()
    expect(result.windows[0].waiting.threads[19]).not.toBeNull()
    expect(result.windows[0].main?.byKind.round_start.count).toBeGreaterThan(0)
  })

  it('names spans the ring evicted, sampled out or lost', async () => {
    expect(await reasonsOf({ mainCensored: true })).toEqual(['main_spans_evicted'])
    expect((await world({ mainCensored: true }).run()).windows[0].main?.censored).toBe(true)
    expect(await reasonsOf({ mainSampledOut: true })).toEqual(['main_spans_sampled'])
    expect(await reasonsOf({ mainRejected: true })).toEqual(['main_spans_lost'])
    // Spans the ring had sampled out before the window are not the window's.
    const earlier = await world({ mainSampledOut: 'before' }).run()
    expect(earlier.verdict).toEqual({ ok: true, reasons: [] })
    expect(earlier.windows[0].main?.ringRise).toMatchObject({ sampledOut: 0 })
  })

  it('names a missing baseline read: no ring rise and no pool figures', async () => {
    const result = await world({ baselineFails: true }).run()
    expect(result.windows[0].reasons).toEqual([
      'admission_unavailable',
      'main_baseline_unavailable'
    ])
    expect(result.windows[0].main?.ringRise).toBeNull()
    expect(result.windows[0].waiting.pool).toBeNull()
  })

  it('names admission figures main did not give', async () => {
    const result = await world({ noAdmission: true }).run()
    expect(result.windows[0].reasons).toEqual(['admission_unavailable'])
    expect(result.windows[0].waiting.limited).toBeNull()
    // The wait spans are still each thread's own.
    expect(result.windows[0].waiting.threads[0]?.[0]).toMatchObject({ count: 11 })
  })

  it('names a main window probe that failed, and keeps the rest', async () => {
    const result = await world({ probeFails: true }).run()
    expect(result.windows[0].reasons).toEqual(['main_probe_failed'])
    expect(result.windows[0].mainWindow).toBeNull()
    expect(result.windows[0].mainWindowCensored).toBe(true)
    expect(result.windows[0].agents?.overall.rounds.completed).toBe(18)
  })

  it('names a main that answers the probe with no window, or not in time', async () => {
    expect(await reasonsOf({ probeNoWindow: true })).toEqual(['main_probe_invalid'])
    expect(await reasonsOf({ probeHangs: true }, { callTimeoutMs: 30 })).toEqual([
      'main_unresponsive'
    ])
  })

  it('keeps main’s own reason for a window it would not start, and asks for no end', async () => {
    const w = world({ probeBegin: () => ({ status: 'unavailable', reason: 'window_held' }) })
    const result = await w.run()
    expect(result.windows[0].reasons).toEqual(['window_held'])
    expect(result.windows[0].mainWindow).toBeNull()
    expect(w.probeEndAsks).toBe(0)
    // Only the start's marker: there is no end to mark.
    expect(w.markers).toEqual(['marker@11000'])
  })

  it.each<[string, (receipt: Record<string, any>) => unknown]>([
    ['another status', (receipt) => ({ ...receipt, status: 'started' })],
    ['another window', (receipt) => ({ ...receipt, id: 'many_agents_1' })],
    ['no start', (receipt) => ({ ...receipt, startedAtMs: undefined })],
    ['a start that is null', (receipt) => ({ ...receipt, startedAtMs: null })],
    ['no end', (receipt) => ({ ...receipt, endedAtMs: null })],
    ['an end that is text', (receipt) => ({ ...receipt, endedAtMs: String(receipt.endedAtMs) })],
    ['a shorter window', (receipt) => ({ ...receipt, endedAtMs: receipt.endedAtMs - 1 })],
    ['no lag', (receipt) => ({ ...receipt, eventLoopLag: null })],
    [
      'lag that was not sampled',
      (receipt) => ({ ...receipt, eventLoopLag: { ...receipt.eventLoopLag, sampling: false } })
    ],
    [
      'a lag figure missing',
      (receipt) => ({ ...receipt, eventLoopLag: { ...receipt.eventLoopLag, p99Ms: undefined } })
    ],
    [
      'no time observed',
      (receipt) => ({ ...receipt, eventLoopLag: { ...receipt.eventLoopLag, observedForMs: 0 } })
    ]
  ])('does not take a receipt with %s for the window', async (_name, probeReceipt) => {
    const result = await world({ probeReceipt }).run()
    expect(result.windows[0].reasons).toEqual(['main_probe_invalid'])
    expect(result.windows[0].mainWindow).toBeNull()
  })

  it('does not take a receipt for a window main never said it started', async () => {
    const w = world({
      probeBegin: (begun) => ({
        ...begun,
        status: 'complete',
        endedAtMs: (begun.startedAtMs as number) + 20_000,
        eventLoopLag: {
          sampling: true,
          observedForMs: 20_000,
          p50Ms: 1,
          p95Ms: 3,
          p99Ms: 5,
          maxMs: 10,
          meanMs: 2
        }
      })
    })
    const result = await w.run()
    expect(result.windows[0].reasons).toEqual(['main_probe_invalid'])
    expect(result.windows[0].mainWindow).toBeNull()
    expect(w.probeEndAsks).toBe(0)
  })

  it('does not take the receipt of a window begun under another name', async () => {
    const w = world({ probeBegin: (receipt) => ({ ...receipt, id: 'many_agents_1' }) })
    expect((await w.run()).windows[0].reasons).toEqual(['main_probe_invalid'])
  })

  it('asks main again for a window whose timer had not yet run', async () => {
    const w = world({ probeLate: 2 })
    const result = await w.run()
    expect(result.verdict).toEqual({ ok: true, reasons: [] })
    expect(w.probeEndAsks).toBe(3)
    expect(w.sleeps.filter((ms) => ms === 250)).toHaveLength(2)
    expect(result.windows[0].mainWindow).toMatchObject({
      startedAtMs: T0 + 11_000,
      endedAtMs: T0 + 31_000
    })
    // The end marker is taken once main's window is over, and the window's
    // own bounds do not move.
    expect(w.markers).toEqual(['marker@11000', 'marker@31500'])
    expect(result.windows[0]).toMatchObject({ startedAtMs: T0 + 11_000, endedAtMs: T0 + 31_000 })
  })

  it('gives up on a window main never finishes timing, and says so', async () => {
    const w = world({ probeLate: 1_000 })
    const result = await w.run()
    expect(result.windows[0].reasons).toEqual(['window_incomplete'])
    expect(result.windows[0].mainWindow).toBeNull()
    // Forty asks a quarter of a second apart: ten seconds, no more.
    expect(w.probeEndAsks).toBe(40)
    expect(w.sleeps.filter((ms) => ms === 250)).toHaveLength(39)
  })

  it('names a Host sampler that never started', async () => {
    const w = world({ samplerStarts: false })
    const result = await w.run()
    expect(result.windows[0].reasons).toEqual(['host_evidence_unavailable'])
    expect(result.windows[0].host).toBeNull()
    // No capture to wait for, before the window or after it.
    expect(w.sleeps.filter((ms) => ms === 7_000)).toEqual([])
    expect(result.windows[0].startedAtMs).toBe(T0 + 4_000)
  })

  it('names what censored the Host’s spans', async () => {
    const result = await world({ hostHole: true }).run()
    expect(result.windows[0].reasons).toEqual(['host_transport_hole'])
    expect(result.windows[0].host).toMatchObject({
      censored: true,
      reasons: ['transport_hole'],
      threadsFolded: 0,
      byKind: {}
    })
    // One reason however many batches of threads it censored.
    const many = await world({ threads: 10, seats: 1, hostHole: true }).run()
    expect(many.windows[0].reasons).toEqual(['host_transport_hole'])
    expect(many.windows[0].host?.reasons).toEqual(['transport_hole'])
  })

  it('polls the lanes at its interval while it waits for their first rounds', async () => {
    const result = await world().run({ leadInPollMs: 400 })
    // The tenth look, 3,600 ms in, is the first to see every first round ended.
    expect(result.leadIn).toMatchObject({ endedAtMs: T0 + 3_600, complete: true })
  })

  it('reads at once when the sends took longer to stop than the settle margin', async () => {
    const w = world({ stopTakesMs: 10_000 })
    const result = await w.run()
    expect(result.windows[0]).toMatchObject({
      drainedAtMs: T0 + 34_400,
      settledAtMs: T0 + 37_400
    })
    // The settle time had already passed: no wait is asked for, least of all a negative one.
    expect(w.sleeps.filter((ms) => !(ms > 0))).toEqual([])
    expect(w.daemonReads).toEqual([{ fromMs: T0 + 11_000, toMs: T0 + 44_400 }])
  })

  it('names a Host fold the union refused', async () => {
    const result = await world({ hostIdentityChanges: true }).run()
    expect(result.windows[0].reasons).toEqual([
      'host_fold_refused:sample.identity changed: another Host'
    ])
    expect(result.windows[0].host).toBeNull()
  })

  it('reports Host lag it could not fold, and a sampler that stopped with nothing', async () => {
    const broken = await world({
      samplerSummary: { status: 'stopped', samples: [{ sequence: 0 }] }
    }).run()
    expect(broken.hostLag).toEqual({
      error: 'samples[0].sequence must be a positive safe integer'
    })
    expect(broken.hostSampler).toEqual({ status: 'stopped' })
    const silent = await world({ samplerSummary: null }).run()
    expect(silent.hostSampler).toBeNull()
    expect(silent.hostLag?.windows).toHaveLength(1)
    const listless = await world({ samplerSummary: { status: 'stopped', samples: 'none' } }).run()
    expect(listless.hostLag?.windows).toHaveLength(1)
  })

  it('counts a thread that failed after a round of its own as ready, once', async () => {
    // The first thread's short round ends and its next send fails while the
    // second thread's first round is still running.
    const w = world({
      threads: 2,
      silent: 0,
      failing: { place: 0, failure: 'steered', afterRounds: 1 }
    })
    const result = await w.run()
    expect(result.leadIn).toEqual({
      startedAtMs: T0,
      endedAtMs: T0 + 4_000,
      threadsReady: 2,
      complete: true
    })
  })

  it('reports a lead-in that ran out, and still measures the threads that are running', async () => {
    const w = world({ stuck: 0 })
    const result = await w.run({ leadInTimeoutMs: 6_000 })
    expect(result.leadIn).toEqual({
      startedAtMs: T0,
      endedAtMs: T0 + 6_000,
      threadsReady: 2,
      complete: false
    })
    expect(result.windows[0].reasons).toContain('lead_in_incomplete')
    expect(result.windows[0].agents?.threads[1].rounds.completed).toBeGreaterThan(0)
  })
})

describe('a phase that cannot start', () => {
  it('reports an observer that would not install as a verdict, not a throw', async () => {
    const w = world({ installError: laneError('already_installed') })
    const result = await w.run()
    expect(result.verdict).toEqual({
      ok: false,
      reasons: ['agents_not_started:already_installed', 'windows_run:0/1']
    })
    expect(result.windows).toEqual([])
    expect(result.leadIn).toBeNull()
    expect(result.hostLag).toBeNull()
    expect(w.events).toEqual(['sampler.start', 'install', 'lanes.stop', 'sampler.stop'])
    expect(result.teardown?.observer).toBe('not_installed')
  })

  it('names a lane error that carries no reason by its code, and bounds a long one', async () => {
    const coded = Object.assign(new Error('page call'), { code: 'T2_LIVE_PAGE_CALL_TIMEOUT' })
    expect((await world({ installError: coded }).run()).verdict.reasons[0]).toBe(
      'agents_not_started:T2_LIVE_PAGE_CALL_TIMEOUT'
    )
    const long = await world({ installError: laneError('x'.repeat(400)) }).run()
    expect(long.verdict.reasons[0]).toHaveLength(200)
    expect(long.verdict.reasons[0].startsWith('agents_not_started:xxx')).toBe(true)
  })

  it('reports that no thread got a round through', async () => {
    const w = world({ failing: { place: 0, failure: 'not_started', afterRounds: 0 }, threads: 1 })
    const result = await w.run()
    expect(result.verdict).toEqual({
      ok: false,
      reasons: ['agents_not_started:no_round_completed', 'windows_run:0/1']
    })
    // A thread that failed with no round to its name is not waited for.
    expect(result.leadIn).toEqual({
      startedAtMs: T0,
      endedAtMs: T0,
      threadsReady: 0,
      complete: false
    })
    expect(result.windows).toEqual([])
    expect(w.events).toEqual([
      'sampler.start',
      'install',
      'start',
      'lanes.stop',
      'sampler.stop',
      'unsubscribed'
    ])
  })

  it('throws anything else, after stopping the lanes and the sampler', async () => {
    const w = world({ installError: new Error('renderer went away') })
    await expect(w.run()).rejects.toThrow('renderer went away')
    expect(w.events).toEqual(['sampler.start', 'install', 'lanes.stop', 'sampler.stop'])
    // An error with a code that is not text, or of another family, is not the lanes'.
    const odd = Object.assign(new Error('odd code'), { code: 7 })
    await expect(world({ installError: odd }).run()).rejects.toThrow('odd code')
    const other = Object.assign(new Error('other family'), { code: 'CAPTURE_TIMEOUT' })
    await expect(world({ installError: other }).run()).rejects.toThrow('other family')
  })

  it('stops the sampler and tidies the page even when the lanes will not stop', async () => {
    const w = world({ stopError: new Error('lanes stuck') })
    await expect(w.run()).rejects.toThrow('lanes stuck')
    expect(w.events).toEqual([
      'sampler.start',
      'install',
      'start',
      'stopSending',
      'lanes.stop',
      'sampler.stop',
      'unsubscribed'
    ])
    // With no snapshot, every thread may still be running.
    expect(w.cancels).toEqual(w.chatIds)
  })
})

describe('the teardown', () => {
  it('cancels the round of a thread that may still be running', async () => {
    const w = world({ stuck: 2 })
    const result = await w.run()
    expect(w.cancels).toEqual([w.chatIds[2]])
    expect(result.teardown).toEqual({
      rounds: { notRunning: 2, cancelled: 0, notCancelled: 1, failed: 0 },
      observer: 'uninstalled'
    })
    expect(phase.manyAgentsTeardownFailures(result)).toEqual([])
  })

  it('cancels the rounds left running when no thread got one through', async () => {
    const w = world({ stuck: 'all' })
    const result = await w.run({ leadInTimeoutMs: 6_000 })
    expect(result.verdict.reasons).toEqual([
      'agents_not_started:no_round_completed',
      'windows_run:0/1'
    ])
    expect(result.leadIn).toEqual({
      startedAtMs: T0,
      endedAtMs: T0 + 6_000,
      threadsReady: 0,
      complete: false
    })
    // No thread failed: each one's round was simply never seen to end.
    expect(w.cancels).toEqual(w.chatIds)
    expect(result.teardown?.rounds).toEqual({
      notRunning: 0,
      cancelled: 3,
      notCancelled: 0,
      failed: 0
    })
  })

  it('reports an observer it could not remove', async () => {
    const failed = await world({ uninstallFails: true }).run()
    expect(failed.teardown?.observer).toBe('failed')
    expect(phase.manyAgentsTeardownFailures(failed)).toEqual([
      'the thread observer could not be removed (failed)'
    ])
    const odd = await world({ uninstallAnswers: 'what' }).run()
    expect(odd.teardown?.observer).toBe('invalid')
    // The window was judged before the teardown.
    expect(odd.verdict.ok).toBe(true)
  })

  it('reports a cancel main refused', async () => {
    const w = world({ stuck: 2, cancelRejects: true })
    const result = await w.run()
    expect(result.teardown?.rounds).toEqual({
      notRunning: 2,
      cancelled: 0,
      notCancelled: 0,
      failed: 1
    })
    expect(phase.manyAgentsTeardownFailures(result)).toEqual([
      '1 thread round(s) could not be cancelled'
    ])
  })

  it('gives up on the page after one cancel that never answers', async () => {
    const w = world({ threads: 4, cancelHangs: true })
    // Every thread failed, as when the page lost its observer.
    for (const thread of w.threads) thread.failure = 'observer_not_installed'
    const result = await w.run({ callTimeoutMs: 30 })
    expect(w.cancels).toEqual([w.chatIds[0]])
    expect(result.teardown?.rounds).toEqual({
      notRunning: 0,
      cancelled: 0,
      notCancelled: 0,
      failed: 4
    })
  })

  it('names what it left undone', () => {
    const rounds = { notRunning: 0, cancelled: 2, notCancelled: 1, failed: 0 }
    expect(phase.manyAgentsTeardownFailures({ teardown: { rounds, observer: 'failed' } })).toEqual([
      'the thread observer could not be removed (failed)'
    ])
    expect(phase.manyAgentsTeardownFailures({ teardown: { rounds, observer: 'invalid' } })).toEqual(
      ['the thread observer could not be removed (invalid)']
    )
    expect(
      phase.manyAgentsTeardownFailures({
        teardown: { rounds: { ...rounds, failed: 3 }, observer: 'not_installed' }
      })
    ).toEqual(['3 thread round(s) could not be cancelled'])
    expect(phase.manyAgentsTeardownFailures(null)).toEqual([])
    expect(phase.manyAgentsTeardownFailures({ teardown: null })).toEqual([])
  })
})

describe('main’s span read for a batch of threads', () => {
  const read = (extra: Record<string, unknown> = {}) => ({
    sampledAt: 5,
    sinceMs: 1,
    untilMs: 4,
    censored: false,
    ring: { recorded: 9, dropped: 0, sampledOut: 0, rejected: 0, degraded: 0 },
    lanes: {
      t001: {
        spans: [
          {
            kind: 'admission_wait',
            startedAt: 2,
            durationMs: 1,
            resource: 'ensemble_pool',
            bytes: 0,
            fallback: false,
            reason: 'admitted'
          }
        ],
        admission: { active: 1, queued: 0 }
      },
      t002: { spans: [], admission: null }
    },
    admission: { occupancy: { maxActive: 30 }, metrics: { requests: 4 } },
    ...extra
  })
  const parse = (value: unknown, labels = ['t001', 't002']) =>
    phase.parseMainAgentSpans(typeof value === 'string' ? value : JSON.stringify(value), labels)

  it('keeps each thread’s spans with what they waited on, and the admission figures', () => {
    expect(parse(read())).toEqual({
      ok: true,
      window: {
        sinceMs: 1,
        untilMs: 4,
        censored: false,
        ring: { recorded: 9, dropped: 0, sampledOut: 0, rejected: 0, degraded: 0 },
        lanes: {
          t001: [
            {
              kind: 'admission_wait',
              startedAt: 2,
              durationMs: 1,
              resource: 'ensemble_pool',
              bytes: 0,
              fallback: false,
              reason: 'admitted'
            }
          ],
          t002: []
        },
        admission: { occupancy: { maxActive: 30 }, metrics: { requests: 4 } }
      }
    })
    expect(parse(read({ admission: null }))).toMatchObject({
      ok: true,
      window: { admission: null }
    })
    // Nothing but a span's own fields is kept.
    const tagged = read()
    Object.assign(tagged.lanes.t001.spans[0], { chatId: 'chat-1' })
    expect(parse(tagged)).toEqual(parse(read()))
  })

  it('refuses an absent handle, a refusal and a malformed read, each by name', () => {
    expect(phase.parseMainAgentSpans(null, ['t001'])).toEqual({
      ok: false,
      reason: 'main_handle_absent'
    })
    expect(phase.parseMainAgentSpans(undefined, ['t001'])).toEqual({
      ok: false,
      reason: 'main_handle_absent'
    })
    expect(parse({ sampledAt: 1, refused: 'lanes_invalid' })).toEqual({
      ok: false,
      reason: 'main_read_refused_lanes_invalid'
    })
    const invalid = { ok: false, reason: 'main_read_invalid' }
    expect(parse('{not json')).toEqual(invalid)
    expect(phase.parseMainAgentSpans(7, ['t001'])).toEqual(invalid)
    expect(parse([])).toEqual(invalid)
    expect(parse(read({ sinceMs: -1 }))).toEqual(invalid)
    expect(parse(read({ untilMs: '4' }))).toEqual(invalid)
    expect(parse(read({ censored: 'no' }))).toEqual(invalid)
    expect(parse(read({ ring: null }))).toEqual(invalid)
    expect(parse(read({ ring: { recorded: 9, dropped: 0, sampledOut: 0, rejected: 0 } }))).toEqual(
      invalid
    )
    expect(
      parse(read({ ring: { recorded: -1, dropped: 0, sampledOut: 0, rejected: 0, degraded: 0 } }))
    ).toEqual(invalid)
    expect(
      parse(read({ ring: { recorded: 1.5, dropped: 0, sampledOut: 0, rejected: 0, degraded: 0 } }))
    ).toEqual(invalid)
    expect(parse(read({ lanes: null }))).toEqual(invalid)
    expect(parse(read({ lanes: { t001: null, t002: { spans: [] } } }))).toEqual(invalid)
    // A thread asked for and not answered.
    expect(parse(read(), ['t001', 't003'])).toEqual(invalid)
    expect(parse(read({ lanes: { t001: { spans: {} }, t002: { spans: [] } } }))).toEqual(invalid)
    expect(parse(read({ admission: 'none' }))).toEqual(invalid)
    // Main gives null when it has no admission figures: it never leaves them out.
    expect(parse(read({ admission: undefined }))).toEqual(invalid)
    expect(parse(read({ admission: { occupancy: {}, metrics: null } }))).toEqual(invalid)
    expect(parse(read({ admission: { occupancy: [], metrics: {} } }))).toEqual(invalid)
  })

  it('refuses a span that is not one of main’s', () => {
    const withSpan = (span: unknown) =>
      parse(read({ lanes: { t001: { spans: [span] }, t002: { spans: [] } } }))
    const span = {
      kind: 'prompt_build',
      startedAt: 2,
      durationMs: 1,
      resource: 'none',
      bytes: 0,
      fallback: false
    }
    expect(withSpan(span)).toMatchObject({ ok: true })
    expect(withSpan(null)).toEqual({ ok: false, reason: 'main_read_span_invalid' })
    expect(withSpan({ ...span, kind: 'coffee_break' })).toEqual({
      ok: false,
      reason: 'main_read_span_invalid'
    })
    for (const bad of [
      { startedAt: -1 },
      { durationMs: Number.NaN },
      { resource: 7 },
      { bytes: -1 },
      { fallback: 'no' },
      { reason: 7 }
    ]) {
      expect(withSpan({ ...span, ...bad })).toEqual({ ok: false, reason: 'main_read_span_invalid' })
    }
  })
})

describe('the fixture’s threads', () => {
  it('names every thread’s chat and its own model tag, with the seats and their mode', () => {
    const fixture = generatePerfFixture({
      workload: 'many_agents_live',
      seed: 1,
      threads: 3,
      seats: 2,
      seatMode: 'parallel'
    })
    expect(phase.manyAgentChatsOf(fixture)).toEqual({
      threads: [
        { chatId: 'perf-many_agents_live-chat-01', model: 'scripted-llama:t001' },
        { chatId: 'perf-many_agents_live-chat-02', model: 'scripted-llama:t002' },
        { chatId: 'perf-many_agents_live-chat-03', model: 'scripted-llama:t003' }
      ],
      seats: 2,
      seatMode: 'parallel'
    })
  })

  it('refuses any other fixture', () => {
    const refused = (fixture: unknown) =>
      expect(() => phase.manyAgentChatsOf(fixture)).toThrow(
        expect.objectContaining({ code: 'T2_LIVE_AGENTS_FIXTURE' })
      )
    refused(null)
    refused(generatePerfFixture({ workload: 'light_beside_large_live', seed: 1 }))
    const fixture = () =>
      generatePerfFixture({ workload: 'many_agents_live', seed: 1, threads: 2, seats: 2 })
    // A thread whose seats are on two tags, and two threads on one tag.
    const mixed = fixture()
    mixed.chats[0].ensemble.participants[1].model = 'scripted-llama:t002'
    refused(mixed)
    const shared = fixture()
    for (const seat of shared.chats[1].ensemble.participants) seat.model = 'scripted-llama:t001'
    refused(shared)
    const unnamed = fixture()
    unnamed.chats[0].appChatId = ''
    refused(unnamed)
    const misnamed = fixture()
    misnamed.chats[0].appChatId = 7 as unknown as string
    refused(misnamed)
    const untagged = fixture()
    for (const seat of untagged.chats[0].ensemble.participants)
      delete (seat as { model?: string }).model
    refused(untagged)
    const blank = fixture()
    for (const seat of blank.chats[0].ensemble.participants) seat.model = ''
    refused(blank)
    const hollow = fixture()
    hollow.chats[0] = null as never
    refused(hollow)
    const planless = fixture()
    planless.shape.manyAgents = null
    refused(planless)
    const fewer = fixture()
    fewer.chats.pop()
    refused(fewer)
    const seatless = fixture()
    seatless.chats[0].ensemble.participants.pop()
    refused(seatless)
  })
})

describe('the phase’s verdict beside the smoke’s', () => {
  it('joins the two, each agents reason named as such', () => {
    const smoke = { ok: true, reasons: [] }
    expect(phase.withManyAgentsVerdict(smoke, { verdict: { ok: true, reasons: [] } })).toEqual({
      ok: true,
      reasons: []
    })
    expect(
      phase.withManyAgentsVerdict(smoke, {
        verdict: { ok: false, reasons: ['window 0: round_failed'] }
      })
    ).toEqual({ ok: false, reasons: ['agents: window 0: round_failed'] })
    expect(
      phase.withManyAgentsVerdict(
        { ok: false, reasons: ['smoke: timeout'] },
        { verdict: { ok: true, reasons: [] } }
      )
    ).toEqual({ ok: false, reasons: ['smoke: timeout'] })
    expect(phase.withManyAgentsVerdict(smoke, null)).toEqual({
      ok: false,
      reasons: ['agents: not run']
    })
    expect(phase.withManyAgentsVerdict(null, null)).toEqual({
      ok: false,
      reasons: ['agents: not run']
    })
    // No smoke verdict is not a smoke that passed.
    expect(phase.withManyAgentsVerdict(null, { verdict: { ok: true, reasons: [] } })).toEqual({
      ok: false,
      reasons: []
    })
  })
})

describe('what the phase refuses', () => {
  const base = () => {
    const w = world()
    return (extra: Record<string, unknown>) => w.run(extra)
  }

  it('needs its page, main’s inspector, a sampler factory and a daemon reader', async () => {
    await expect(base()({ page: null })).rejects.toThrow(/page adapter/)
    await expect(base()({ mainSession: {} })).rejects.toThrow(/inspector/)
    await expect(base()({ createHostSampler: null })).rejects.toThrow(/sampler/)
    await expect(base()({ readDaemonTurns: null })).rejects.toThrow(/daemon/)
    await expect(phase.runT2ManyAgents(null as never)).rejects.toThrow(/page adapter/)
  })

  it('needs threads with a chat and a tag each, seats and their mode', async () => {
    await expect(base()({ threads: [] })).rejects.toThrow(/threads/)
    await expect(base()({ threads: [{ chatId: 'a' }] })).rejects.toThrow(/threads/)
    await expect(base()({ threads: [null] })).rejects.toThrow(/threads/)
    await expect(base()({ threads: [{ model: 'm:a' }] })).rejects.toThrow(/threads/)
    await expect(base()({ threads: [{ chatId: 'a', model: '' }] })).rejects.toThrow(/threads/)
    await expect(
      base()({
        threads: [
          { chatId: 'a', model: 'm:a' },
          { chatId: 'b', model: 'm:a' }
        ]
      })
    ).rejects.toThrow(/model tag of its own/)
    await expect(base()({ seats: 0 })).rejects.toThrow(/seats/)
    await expect(base()({ seatMode: 'both' })).rejects.toThrow(/seatMode/)
    await expect(base()({ configuredTurnMs: 0 })).rejects.toThrow(/configuredTurnMs/)
  })

  it('refuses a bad shape before it starts anything', async () => {
    for (const bad of [
      { configuredTurnMs: 0 },
      { configuredTurnMs: Number.NaN },
      { seats: 0 },
      { seatMode: 'both' },
      { windowMs: 0 },
      { threads: [] }
    ]) {
      const w = world()
      await expect(w.run(bad)).rejects.toThrow()
      expect(w.events).toEqual([])
    }
  })

  it.each(Object.keys(PHASE_OPTIONS).concat('callTimeoutMs'))(
    'refuses a %s that is not a positive whole number',
    async (name) => {
      await expect(base()({ [name]: 0 })).rejects.toThrow(name)
      await expect(base()({ [name]: 1.5 })).rejects.toThrow(name)
    }
  )

  it('has defaults for a real run', () => {
    expect(phase.DEFAULT_T2_MANY_AGENT_OPTIONS).toEqual({
      windowMs: 120_000,
      leadInTimeoutMs: 600_000,
      leadInPollMs: 500,
      settleMarginMs: 30_000,
      fenceMs: 2_000,
      hostCaptureWaitMs: 7_000,
      callTimeoutMs: 60_000
    })
  })
})
