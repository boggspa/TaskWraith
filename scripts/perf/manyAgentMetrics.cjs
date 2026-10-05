'use strict'

/**
 * What a many-agent window shows, from two records that never read a chat:
 * the runner's record of each thread's rounds (when each was sent, accepted
 * and seen to end, `manyAgentRounds.cjs`) and the scripted model's record of
 * every turn it streamed. Each thread's seats run a model tag of the thread's
 * own, so a turn names its thread, and a thread runs one round at a time, so
 * a turn that began between a round's send and the next round's send is that
 * round's.
 *
 * Per thread and over all threads:
 * - rounds sent in the window, rounds that ran at some moment of it, rounds
 *   completed in it, and of the rounds that ran in it, those that ended any
 *   other way (whenever they did: the runner follows a round to its end) and
 *   those never seen to end;
 * - send to accepted, as the page measured the call;
 * - accepted to the round's first model turn starting, by the daemon's
 *   clock against the runner's (a turn can begin before the runner hears the
 *   acceptance, so the figure can be negative), and send to that turn;
 * - the spacing of a round's turns against the model's own pace: how long a
 *   turn streamed, start to start, the gap from one turn's end to the next
 *   turn's start, and the round's time with no turn streaming shared out per
 *   turn. That last figure is the app's own time per turn whether the seats
 *   ran one after another or together;
 * - how many agents were streaming at once, against how many were asked for.
 *
 * The round figures are taken from every round that ran at some moment of
 * the window, whole, whether it was sent in the window or before it: a round
 * of many seats can outlast the window, which would otherwise have none.
 *
 * Waiting behind the app's own limits is reported as waiting, by cause, from
 * main's admission counters and its wait spans (`summariseAgentWaiting`).
 *
 * The first burst, when every thread sends its first round at once, is
 * summarised on its own (`summariseFirstBurst`).
 *
 * Every time is this machine's wall clock in milliseconds.
 */

const SEAT_MODES = Object.freeze(['serial', 'parallel'])
const POOL_LIMITS = Object.freeze(['maxActive', 'maxForeground', 'maxQueued'])
const POOL_COUNTERS = Object.freeze([
  'requests',
  'reservations',
  'admitted',
  'initiallyQueued',
  'admittedQueueWaitMs',
  'overflowRejected',
  'cancelledQueued'
])
const POOL_PEAKS = Object.freeze(['peakActive', 'peakQueued', 'maxAdmittedQueueWaitMs'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}

function nearestRank(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((q / 100) * sorted.length) - 1))]
}

/** Nearest-rank figures over the numbers of a list (a negative one is kept), or null for none. */
function timingsOf(values) {
  const sorted = values
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((left, right) => left - right)
  if (sorted.length === 0) return null
  return {
    count: sorted.length,
    minMs: round3(sorted[0]),
    p50Ms: round3(nearestRank(sorted, 50)),
    p95Ms: round3(nearestRank(sorted, 95)),
    maxMs: round3(sorted[sorted.length - 1])
  }
}

function countInto(counts, key) {
  counts[key] = (counts[key] || 0) + 1
}

/** How long at least one interval of the list covers: time under two is counted once. */
function coveredMs(intervals) {
  let covered = 0
  let reach = -Infinity
  for (const [start, end] of [...intervals].sort((left, right) => left[0] - right[0])) {
    if (end <= reach) continue
    covered += end - Math.max(start, reach)
    reach = end
  }
  return covered
}

/** The most turns streaming at one moment of the window, and their mean over it. */
function runningAtOnce(turns, window) {
  const { startedAtMs, endedAtMs } = window
  const intervals = turns
    // A turn still streaming at the read streamed to the window's end.
    .map((turn) => [
      Math.max(turn.startedAtMs, startedAtMs),
      Math.min(turn.endedAtMs ?? endedAtMs, endedAtMs)
    ])
    .filter(([start, end]) => end > start)
  const steps = []
  for (const [start, end] of intervals) {
    steps.push([start, 1], [end, -1])
  }
  // An end before a start at the same moment: the two never ran together.
  steps.sort((left, right) => left[0] - right[0] || left[1] - right[1])
  let running = 0
  let max = 0
  for (const [, step] of steps) {
    running += step
    max = Math.max(max, running)
  }
  const lengthMs = endedAtMs - startedAtMs
  const streamedMs = intervals.reduce((sum, [start, end]) => sum + (end - start), 0)
  return {
    max,
    mean: round3(streamedMs / lengthMs),
    noneMs: lengthMs - coveredMs(intervals)
  }
}

function emptyMeasures() {
  return {
    rounds: { sent: 0, ran: 0, completed: 0, endedOther: {}, unended: 0, withoutTurn: 0 },
    turns: { started: 0, done: 0, notDone: {} },
    sendToAccepted: [],
    acceptedToFirstTurn: [],
    sendToFirstTurn: [],
    roundMs: [],
    modelTurn: [],
    startToStart: [],
    betweenTurns: [],
    overlapped: 0,
    appMsPerTurn: []
  }
}

/** One thread's measures as lists, so every thread's can be pooled before any figure is taken. */
function measureThread(thread, turns, window) {
  const inWindow = (ms) => ms !== null && ms >= window.startedAtMs && ms < window.endedAtMs
  const measures = emptyMeasures()
  for (const turn of turns) {
    if (!inWindow(turn.startedAtMs)) continue
    measures.turns.started += 1
    if (turn.outcome === 'done') {
      measures.turns.done += 1
      measures.modelTurn.push(turn.endedAtMs - turn.startedAtMs)
    } else countInto(measures.turns.notDone, turn.outcome)
  }
  for (const [index, round] of thread.rounds.entries()) {
    // A round that ran at some moment of the window is the window's: one
    // that failed after the window closed still carried its load, and one
    // sent before it opened ran its turns in it.
    const ranInWindow =
      round.sentAtMs < window.endedAtMs &&
      (round.endedAtMs === null || round.endedAtMs >= window.startedAtMs)
    if (!ranInWindow) continue
    measures.rounds.ran += 1
    if (inWindow(round.sentAtMs)) measures.rounds.sent += 1
    if (round.endedAtMs === null) measures.rounds.unended += 1
    else if (round.status !== 'completed') {
      countInto(measures.rounds.endedOther, String(round.status))
    } else if (inWindow(round.endedAtMs)) measures.rounds.completed += 1
    measures.sendToAccepted.push(round.pageMs)
    const next = thread.rounds[index + 1]
    const untilMs = next ? next.sentAtMs : Infinity
    const own = turns.filter(
      (turn) => turn.startedAtMs >= round.sentAtMs && turn.startedAtMs < untilMs
    )
    if (own.length === 0) {
      measures.rounds.withoutTurn += 1
      continue
    }
    measures.acceptedToFirstTurn.push(own[0].startedAtMs - round.acceptedAtMs)
    measures.sendToFirstTurn.push(own[0].startedAtMs - round.sentAtMs)
    // The spacing is judged over a whole round only.
    if (round.endedAtMs === null) continue
    const roundMs = round.endedAtMs - round.sentAtMs
    measures.roundMs.push(roundMs)
    for (let turn = 1; turn < own.length; turn += 1) {
      const before = own[turn - 1]
      measures.startToStart.push(own[turn].startedAtMs - before.startedAtMs)
      if (before.endedAtMs !== null && own[turn].startedAtMs >= before.endedAtMs) {
        measures.betweenTurns.push(own[turn].startedAtMs - before.endedAtMs)
      } else measures.overlapped += 1
    }
    // A turn still streaming, or one the daemon closed after the round was
    // seen to end, streamed to the round's end.
    const streamingMs = coveredMs(
      own.map((turn) => [
        turn.startedAtMs,
        Math.min(turn.endedAtMs ?? round.endedAtMs, round.endedAtMs)
      ])
    )
    measures.appMsPerTurn.push((roundMs - streamingMs) / own.length)
  }
  return measures
}

function pooled(all) {
  const pool = emptyMeasures()
  for (const measures of all) {
    for (const group of ['rounds', 'turns']) {
      for (const [name, value] of Object.entries(measures[group])) {
        if (typeof value === 'number') pool[group][name] += value
        else {
          for (const [key, count] of Object.entries(value)) {
            pool[group][name][key] = (pool[group][name][key] || 0) + count
          }
        }
      }
    }
    for (const [name, value] of Object.entries(measures)) {
      if (Array.isArray(value)) pool[name].push(...value)
    }
    pool.overlapped += measures.overlapped
  }
  return pool
}

function figuresOf(measures) {
  return {
    rounds: measures.rounds,
    turns: measures.turns,
    sendToAcceptedMs: timingsOf(measures.sendToAccepted),
    acceptedToFirstTurnMs: timingsOf(measures.acceptedToFirstTurn),
    sendToFirstTurnMs: timingsOf(measures.sendToFirstTurn),
    roundMs: timingsOf(measures.roundMs),
    turnSpacing: {
      modelTurnMs: timingsOf(measures.modelTurn),
      startToStartMs: timingsOf(measures.startToStart),
      betweenTurnsMs: timingsOf(measures.betweenTurns),
      overlapped: measures.overlapped,
      appMsPerTurn: timingsOf(measures.appMsPerTurn)
    }
  }
}

/**
 * How many agents a shape asks for, and how many of them at one moment: one
 * seat of each thread when a thread's seats run one after another, every
 * seat of every thread when they run together.
 */
function agentsAsked({ threads, seats, seatMode }) {
  if (!Number.isSafeInteger(threads) || threads < 1) {
    throw new Error('threads must be a positive integer')
  }
  if (!Number.isSafeInteger(seats) || seats < 1) throw new Error('seats must be a positive integer')
  if (!SEAT_MODES.includes(seatMode)) throw new Error('seatMode must be serial or parallel')
  const agents = threads * seats
  return { threads, seats, agents, seatMode, atOnce: seatMode === 'parallel' ? agents : threads }
}

function checkThreads(threads) {
  if (
    !Array.isArray(threads) ||
    threads.some(
      (thread) =>
        !isPlainObject(thread) ||
        typeof thread.chatId !== 'string' ||
        typeof thread.model !== 'string' ||
        thread.model.length === 0 ||
        !Array.isArray(thread.rounds)
    ) ||
    new Set(threads.map((thread) => thread.model)).size !== threads.length
  ) {
    throw new Error('threads must each have a chat, a model tag of their own and their rounds')
  }
}

/** Each thread's turns by its model tag, in start order, and how many turns are no thread's. */
function turnsByThread(threads, turns) {
  const byModel = new Map(threads.map((thread) => [thread.model, []]))
  let otherTurns = 0
  for (const turn of [...turns].sort((left, right) => left.startedAtMs - right.startedAtMs)) {
    const own = byModel.get(turn.model)
    if (own) own.push(turn)
    else otherTurns += 1
  }
  return { byModel, otherTurns }
}

/**
 * @param {{
 *   window: { startedAtMs: number, endedAtMs: number },
 *   threads: Array<{ chatId: string, model: string, failure: string | null, rounds: Array<{
 *     roundId: string, sentAtMs: number, acceptedAtMs: number, pageMs: number | null,
 *     endedAtMs: number | null, status: string | null }> }>,
 *   turns: Array<{ model: string, startedAtMs: number, endedAtMs: number | null, outcome: string }>,
 *   seats: number, seatMode: 'serial' | 'parallel', configuredTurnMs: number
 * }} input the daemon's turns must cover every round that ran in the window, from its send
 */
function summariseManyAgents(input) {
  const { window, threads, turns, seats, seatMode, configuredTurnMs } = isPlainObject(input)
    ? input
    : {}
  if (
    !isPlainObject(window) ||
    !Number.isFinite(window.startedAtMs) ||
    !Number.isFinite(window.endedAtMs) ||
    !(window.endedAtMs > window.startedAtMs)
  ) {
    throw new Error('window must have a start before its end')
  }
  checkThreads(threads)
  if (!Array.isArray(turns)) throw new Error('turns must be the daemon’s list')
  const asked = agentsAsked({ threads: threads.length, seats, seatMode })
  if (!Number.isFinite(configuredTurnMs) || configuredTurnMs <= 0) {
    throw new Error('configuredTurnMs must be positive')
  }

  const { byModel, otherTurns } = turnsByThread(threads, turns)
  const measured = threads.map((thread) => measureThread(thread, byModel.get(thread.model), window))
  return {
    window: {
      startedAtMs: window.startedAtMs,
      endedAtMs: window.endedAtMs,
      lengthMs: window.endedAtMs - window.startedAtMs
    },
    asked,
    configuredTurnMs,
    overall: {
      ...figuresOf(pooled(measured)),
      runningAtOnce: {
        asked: asked.atOnce,
        ...runningAtOnce([...byModel.values()].flat(), window)
      },
      threadsFailed: threads.filter((thread) => thread.failure !== null).length,
      otherTurns
    },
    threads: threads.map((thread, place) => ({
      thread: place + 1,
      chatId: thread.chatId,
      model: thread.model,
      failure: thread.failure,
      ...figuresOf(measured[place]),
      runningAtOnce: { max: runningAtOnce(byModel.get(thread.model), window).max }
    }))
  }
}

/** An admission read with every figure the pool summary needs, or null. */
function admissionOf(value) {
  if (!isPlainObject(value) || !isPlainObject(value.occupancy) || !isPlainObject(value.metrics)) {
    return null
  }
  const whole = (record, names) => names.every((name) => Number.isFinite(record[name]))
  return whole(value.occupancy, [...POOL_LIMITS, 'active', 'queued']) &&
    whole(value.metrics, [...POOL_COUNTERS, ...POOL_PEAKS])
    ? value
    : null
}

/** A thread's wait spans grouped by what was waited on, in kind and resource order. */
function waitsOf(spans) {
  const groups = new Map()
  for (const span of spans) {
    if (!String(span.kind).endsWith('_wait')) continue
    const key = `${span.kind}\n${span.resource}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(span)
  }
  return [...groups.keys()].sort().map((key) => {
    const group = groups.get(key)
    const durations = group.map((span) => span.durationMs).sort((left, right) => left - right)
    const reasons = {}
    for (const span of group) {
      if (typeof span.reason === 'string') countInto(reasons, span.reason)
    }
    return {
      kind: group[0].kind,
      resource: group[0].resource,
      count: group.length,
      waited: durations.filter((duration) => duration > 0).length,
      totalMs: round3(durations.reduce((sum, duration) => sum + duration, 0)),
      p50Ms: round3(nearestRank(durations, 50)),
      p95Ms: round3(nearestRank(durations, 95)),
      maxMs: round3(durations[durations.length - 1]),
      reasons
    }
  })
}

/**
 * Waiting behind the app's own limits over a window, with its cause.
 *
 * The pool figures are the admission scheduler's own counters, read at the
 * window's start and end, so they are exact whatever became of the spans:
 * how many runs asked, how many had to queue for a slot and for how long in
 * all, and how many the full queue turned away. `limited` says whether the
 * pool held any run back. Each thread's wait spans (one per run admitted,
 * with the time it queued) are grouped by kind and by the resource waited
 * on; a thread whose spans could not be read is null and counted.
 *
 * @param {{
 *   spansByThread: Array<Array<{ kind: string, resource: string, durationMs: number,
 *     reason?: string }> | null>,
 *   admissionBefore: { occupancy: object, metrics: object } | null,
 *   admissionAtEnd: { occupancy: object, metrics: object } | null
 * }} input
 */
/**
 * The pool's limits and what queued behind them between two admission reads,
 * from the scheduler's own counters; null figures without both reads.
 */
function poolWaiting(admissionBefore, admissionAtEnd) {
  const before = admissionOf(admissionBefore)
  const atEnd = admissionOf(admissionAtEnd)
  if (!before || !atEnd) return { limits: null, pool: null, limited: null }
  const rise = (name) => atEnd.metrics[name] - before.metrics[name]
  const pool = {
    cause: 'ensemble_pool',
    requests: rise('requests'),
    reservations: rise('reservations'),
    admitted: rise('admitted'),
    queued: rise('initiallyQueued'),
    queueWaitMs: rise('admittedQueueWaitMs'),
    overflowRejected: rise('overflowRejected'),
    cancelledQueued: rise('cancelledQueued'),
    activeAtEnd: atEnd.occupancy.active,
    queuedAtEnd: atEnd.occupancy.queued,
    // The scheduler keeps these as peaks since it started, not per window.
    sinceLaunch: {
      peakActive: atEnd.metrics.peakActive,
      peakQueued: atEnd.metrics.peakQueued,
      maxQueueWaitMs: atEnd.metrics.maxAdmittedQueueWaitMs
    }
  }
  return {
    limits: Object.fromEntries(POOL_LIMITS.map((name) => [name, atEnd.occupancy[name]])),
    pool,
    limited: pool.queued > 0 || pool.overflowRejected > 0
  }
}

function summariseAgentWaiting(input) {
  const { spansByThread } = isPlainObject(input) ? input : {}
  if (!Array.isArray(spansByThread)) throw new Error('spansByThread must be one list per thread')
  const read = spansByThread.filter((spans) => spans !== null)
  return {
    ...poolWaiting(input.admissionBefore, input.admissionAtEnd),
    waits: waitsOf(read.flat()),
    threads: spansByThread.map((spans) => (spans === null ? null : waitsOf(spans))),
    threadsUnread: spansByThread.length - read.length
  }
}

/**
 * The first burst: as the phase starts every thread sends its first round at
 * once, and the wait for first rounds ends once each has ended or its bound
 * has passed. What the app made of it: each thread's first send to its
 * acceptance and to its round's first model turn; how long until every send
 * was accepted and every thread was streaming; how long the first rounds
 * took; how many agents streamed at once over the burst; and the waiting it
 * caused behind the pool, from admission reads before the sends and as the
 * wait ended. A thread's rounds are as the runner saw them when the wait
 * ended: a first round not seen to end by then is unended.
 *
 * @param {{
 *   burst: { startedAtMs: number, endedAtMs: number },
 *   threads: Array<{ chatId: string, model: string, rounds: Array<{ sentAtMs: number,
 *     acceptedAtMs: number, pageMs: number | null, endedAtMs: number | null,
 *     status: string | null }> }>,
 *   turns: Array<{ model: string, startedAtMs: number, endedAtMs: number | null }>,
 *   seats: number, seatMode: 'serial' | 'parallel',
 *   admissionBefore: object | null, admissionAtEnd: object | null
 * }} input the daemon's turns must cover the burst from its first send
 */
function summariseFirstBurst(input) {
  const { burst, threads, turns, seats, seatMode } = isPlainObject(input) ? input : {}
  if (
    !isPlainObject(burst) ||
    !Number.isFinite(burst.startedAtMs) ||
    !Number.isFinite(burst.endedAtMs) ||
    !(burst.endedAtMs > burst.startedAtMs)
  ) {
    throw new Error('burst must have a start before its end')
  }
  checkThreads(threads)
  if (!Array.isArray(turns)) throw new Error('turns must be the daemon’s list')
  const asked = agentsAsked({ threads: threads.length, seats, seatMode })

  const { byModel } = turnsByThread(threads, turns)
  const firstRounds = { sent: 0, completed: 0, endedOther: {}, unended: 0, withoutTurn: 0 }
  const sendToAccepted = []
  const acceptedToFirstTurn = []
  const sendToFirstTurn = []
  const firstRoundMs = []
  let lastAcceptedAtMs = null
  let lastStreamingAtMs = null
  let everyThreadStreaming = true
  for (const thread of threads) {
    const [first, second] = thread.rounds
    if (!first) {
      everyThreadStreaming = false
      continue
    }
    firstRounds.sent += 1
    if (first.endedAtMs === null) firstRounds.unended += 1
    else if (first.status !== 'completed') {
      countInto(firstRounds.endedOther, String(first.status))
    } else {
      firstRounds.completed += 1
      firstRoundMs.push(first.endedAtMs - first.sentAtMs)
    }
    sendToAccepted.push(first.pageMs)
    lastAcceptedAtMs = Math.max(lastAcceptedAtMs ?? -Infinity, first.acceptedAtMs)
    // The round's turns began after its send and before the thread's next.
    const untilMs = second ? second.sentAtMs : Infinity
    const firstTurn = byModel
      .get(thread.model)
      .find((turn) => turn.startedAtMs >= first.sentAtMs && turn.startedAtMs < untilMs)
    if (!firstTurn) {
      firstRounds.withoutTurn += 1
      everyThreadStreaming = false
      continue
    }
    acceptedToFirstTurn.push(firstTurn.startedAtMs - first.acceptedAtMs)
    sendToFirstTurn.push(firstTurn.startedAtMs - first.sentAtMs)
    lastStreamingAtMs = Math.max(lastStreamingAtMs ?? -Infinity, firstTurn.startedAtMs)
  }
  return {
    burst: {
      startedAtMs: burst.startedAtMs,
      endedAtMs: burst.endedAtMs,
      lengthMs: burst.endedAtMs - burst.startedAtMs
    },
    asked,
    firstRounds,
    sendToAcceptedMs: timingsOf(sendToAccepted),
    acceptedToFirstTurnMs: timingsOf(acceptedToFirstTurn),
    sendToFirstTurnMs: timingsOf(sendToFirstTurn),
    firstRoundMs: timingsOf(firstRoundMs),
    allAcceptedAfterMs:
      lastAcceptedAtMs === null ? null : round3(lastAcceptedAtMs - burst.startedAtMs),
    allStreamingAfterMs:
      everyThreadStreaming && lastStreamingAtMs !== null
        ? round3(lastStreamingAtMs - burst.startedAtMs)
        : null,
    runningAtOnce: { asked: asked.atOnce, ...runningAtOnce([...byModel.values()].flat(), burst) },
    waiting: poolWaiting(input.admissionBefore, input.admissionAtEnd)
  }
}

module.exports = {
  agentsAsked,
  summariseAgentWaiting,
  summariseFirstBurst,
  summariseManyAgents,
  timingsOf
}
