'use strict'

/**
 * The many-agent workload inside a T2 run: `runT2Baseline --live-agents`.
 *
 * The fixture is N threads of S seats on the scripted model, each thread's
 * seats on a model tag of the thread's own. The phase runs once the
 * live-round warm-up and smoke have settled. It starts a round on every
 * thread at once (`manyAgentRounds.cjs`), keeps one running on each, waits
 * until every thread has had a first round end, measures one window, stops
 * the sends, and reads its evidence only once every round in flight has been
 * seen to end and a settle margin has passed.
 *
 * What it reports, none of it from a chat record (a read of a thread costs
 * main the very thing being measured):
 * - per thread and over all threads, from the runner's record of the rounds
 *   and the scripted model's record of its turns (`manyAgentMetrics.cjs`):
 *   send to accepted, accepted to the first model turn, the spacing of the
 *   turns against the model's own pace, rounds completed, and how many
 *   agents ran at once against how many were asked for;
 * - waiting behind the app's own limits, as waiting, with its cause: the
 *   admission scheduler's counters read at the window's two ends, and each
 *   thread's wait spans;
 * - main's spans of every thread by kind, main's own window probe (the
 *   main-loop delay) between two profile markers, main's D1 counters at the
 *   fences, and the Host's spans and lag.
 *
 * Main's span handle and the Host fold each take at most eight chats a
 * call, so both are read in batches of eight threads.
 *
 * A window that is not evidence names every reason. A phase that cannot
 * start is a verdict reason, not a thrown run. The lanes and the sampler are
 * stopped on every path, and then the page is tidied: a thread's round that
 * may still be running is cancelled and the observer removed, each bounded
 * and reported.
 */

const { awaitWithTimeout } = require('./boundedAwait.cjs')
const { WORK_SPAN_KINDS, aggregateHostWindowSamples } = require('./collectors/hostSpans.cjs')
const {
  createHostRecentSpanUnion,
  timingsByKind
} = require('./collectors/hostRecentSpanWindows.cjs')
const { captureProfileMarker } = require('./collectors/mainProfileCalibration.cjs')
const { liveLaneWindowsVerdict } = require('./liveLaneWindows.cjs')
const { cancelRoundExpression } = require('./liveRoundLanes.cjs')
const { readD1Counters } = require('./liveRounds.cjs')
const {
  threadObserverConfig,
  uninstallThreadObserverExpression
} = require('./liveThreadObserver.cjs')
const {
  agentsAsked,
  summariseAgentWaiting,
  summariseManyAgents
} = require('./manyAgentMetrics.cjs')
const { createManyAgentLanes } = require('./manyAgentRounds.cjs')
const { readMainPerfWindow, readMainWorkSpanWindow } = require('./t2LiveLanes.cjs')

const DEFAULT_OPTIONS = Object.freeze({
  windowMs: 120_000,
  // Every thread's first round must end before the window. A round is
  // several model turns a seat and the app's own time per turn grows with
  // the threads running, so a large shape needs longer: the runner raises
  // this with the operator's bound on a round.
  leadInTimeoutMs: 600_000,
  leadInPollMs: 500,
  settleMarginMs: 30_000,
  fenceMs: 2_000,
  hostCaptureWaitMs: 7_000,
  callTimeoutMs: 60_000
})
// Main ends its window on its own timer, which a busy loop runs late; asked
// before then it has no receipt. Ten seconds of asking, then the window is
// reported as main left it.
const END_PROBE_TRIES = 40
const END_PROBE_RETRY_MS = 250
const WINDOW_ROLE = 'many-agents'
/** As many chats as main's span handle and the Host fold take in one call. */
const BATCH_SIZE = 8
const RING_FIELDS = Object.freeze(['recorded', 'dropped', 'sampledOut', 'rejected', 'degraded'])
const KIND_SET = new Set(WORK_SPAN_KINDS)
const LAG_FIELDS = Object.freeze(['p50Ms', 'p95Ms', 'p99Ms', 'maxMs', 'meanMs', 'observedForMs'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fixtureError(message) {
  const error = new Error(`Refusing --live-agents: ${message}`)
  error.code = 'T2_LIVE_AGENTS_FIXTURE'
  return error
}

/**
 * A many-agent fixture's threads: each chat with the one model tag all its
 * seats run, a tag no other thread has (the daemon tells the threads' turns
 * apart by tag). Any other fixture is refused.
 */
function manyAgentChatsOf(fixture) {
  const plan =
    isPlainObject(fixture) && isPlainObject(fixture.shape) ? fixture.shape.manyAgents : null
  const chats = isPlainObject(fixture) && Array.isArray(fixture.chats) ? fixture.chats : []
  if (!isPlainObject(plan) || chats.length !== plan.threads) {
    throw fixtureError('the fixture needs the many-agent workload’s threads')
  }
  const threads = chats.map((chat) => {
    const seats =
      isPlainObject(chat) &&
      isPlainObject(chat.ensemble) &&
      Array.isArray(chat.ensemble.participants)
        ? chat.ensemble.participants
        : []
    const models = new Set(seats.map((seat) => (isPlainObject(seat) ? seat.model : undefined)))
    const [model] = models
    // The seats first: a chat that is no object has none.
    if (
      seats.length !== plan.seats ||
      models.size !== 1 ||
      typeof model !== 'string' ||
      model.length === 0 ||
      typeof chat.appChatId !== 'string' ||
      chat.appChatId.length === 0
    ) {
      throw fixtureError('each thread needs its chat and every seat on one model tag')
    }
    return { chatId: chat.appChatId, model }
  })
  if (new Set(threads.map((thread) => thread.model)).size !== threads.length) {
    throw fixtureError('each thread needs a model tag of its own')
  }
  return { threads, seats: plan.seats, seatMode: plan.seatMode }
}

/**
 * Validate one read of main's span handle for a batch of threads. `{ ok:
 * true, window }` with each label's spans (what each waited on kept) and the
 * admission scheduler's figures, or `{ ok: false, reason }`; a refusal keeps
 * the handle's own reason.
 */
function parseMainAgentSpans(text, labels) {
  if (text === null || text === undefined) return { ok: false, reason: 'main_handle_absent' }
  const invalid = { ok: false, reason: 'main_read_invalid' }
  let value = null
  try {
    value = JSON.parse(text)
  } catch {
    value = null
  }
  if (!isPlainObject(value)) return invalid
  if (typeof value.refused === 'string') {
    return { ok: false, reason: `main_read_refused_${value.refused}` }
  }
  if (
    !finiteNonNegative(value.sinceMs) ||
    !finiteNonNegative(value.untilMs) ||
    typeof value.censored !== 'boolean' ||
    !isPlainObject(value.ring) ||
    !isPlainObject(value.lanes)
  ) {
    return invalid
  }
  const ring = {}
  for (const field of RING_FIELDS) {
    if (!Number.isSafeInteger(value.ring[field]) || value.ring[field] < 0) return invalid
    ring[field] = value.ring[field]
  }
  const { admission } = value
  if (
    admission !== null &&
    (!isPlainObject(admission) ||
      !isPlainObject(admission.occupancy) ||
      !isPlainObject(admission.metrics))
  ) {
    return invalid
  }
  const lanes = {}
  for (const label of labels) {
    const lane = value.lanes[label]
    if (!isPlainObject(lane) || !Array.isArray(lane.spans)) return invalid
    lanes[label] = []
    for (const span of lane.spans) {
      if (
        !isPlainObject(span) ||
        !KIND_SET.has(span.kind) ||
        !finiteNonNegative(span.startedAt) ||
        !finiteNonNegative(span.durationMs) ||
        typeof span.resource !== 'string' ||
        !finiteNonNegative(span.bytes) ||
        typeof span.fallback !== 'boolean' ||
        (span.reason !== undefined && typeof span.reason !== 'string')
      ) {
        return { ok: false, reason: 'main_read_span_invalid' }
      }
      lanes[label].push({
        kind: span.kind,
        startedAt: span.startedAt,
        durationMs: span.durationMs,
        resource: span.resource,
        bytes: span.bytes,
        fallback: span.fallback,
        ...(span.reason === undefined ? {} : { reason: span.reason })
      })
    }
  }
  return {
    ok: true,
    window: {
      sinceMs: value.sinceMs,
      untilMs: value.untilMs,
      censored: value.censored,
      ring,
      lanes,
      admission
    }
  }
}

/** The Host's per-thread timings pooled by kind, in taxonomy order. */
function pooledHostKinds(lanes) {
  const byKind = {}
  for (const kind of WORK_SPAN_KINDS) {
    const ofKind = lanes.map((lane) => lane.byKind[kind]).filter(Boolean)
    if (ofKind.length === 0) continue
    const sum = (field) => ofKind.reduce((total, timings) => total + timings[field], 0)
    byKind[kind] = {
      count: sum('count'),
      totalMs: sum('totalMs'),
      maxMs: Math.max(...ofKind.map((timings) => timings.maxMs)),
      bytes: sum('bytes'),
      fallbackCount: sum('fallbackCount'),
      // A percentile cannot be pooled from per-thread figures: the worst thread's.
      threadP95MsMax: Math.max(...ofKind.map((timings) => timings.p95Ms))
    }
  }
  return byKind
}

/**
 * Whether a thread may have left a round running once the lanes stopped: it
 * failed (a send that timed out may still have started one), its last round
 * was never seen to end, or the lanes' snapshot is missing.
 */
function threadMayBeRunning(snapshot, place) {
  const thread =
    isPlainObject(snapshot) && Array.isArray(snapshot.threads) ? snapshot.threads[place] : null
  if (!isPlainObject(thread) || !Array.isArray(thread.rounds)) return true
  if (thread.failure !== null) return true
  const last = thread.rounds[thread.rounds.length - 1]
  return isPlainObject(last) && last.endedAtMs === null
}

/**
 * Tidy the page once the lanes have stopped: cancel each thread's round that
 * may still be running (a cancel on an idle chat answers false and does
 * nothing), then remove the observer. Each step is one bounded call whose
 * outcome is counted; none throws. A page that fails one cancel is not asked
 * again: the rest are counted as failed.
 */
async function tidyAgents({ page, snapshot, chatIds, callTimeoutMs }) {
  const call = async (expression, what) => {
    try {
      return {
        value: await awaitWithTimeout(
          Promise.resolve().then(() => page.evaluate(expression)),
          callTimeoutMs,
          what
        )
      }
    } catch {
      return { failed: true }
    }
  }
  const rounds = { notRunning: 0, cancelled: 0, notCancelled: 0, failed: 0 }
  let pageGone = false
  for (const [place, chatId] of chatIds.entries()) {
    if (!threadMayBeRunning(snapshot, place)) rounds.notRunning += 1
    else if (pageGone) rounds.failed += 1
    else {
      const reply = await call(cancelRoundExpression(chatId), `cancel thread ${place + 1}’s round`)
      pageGone = reply.failed === true
      if (!isPlainObject(reply.value) || reply.value.ok !== true) rounds.failed += 1
      else if (reply.value.cancelled === true) rounds.cancelled += 1
      else rounds.notCancelled += 1
    }
  }
  const removed = await call(
    uninstallThreadObserverExpression(threadObserverConfig({ chatIds })),
    'thread observer uninstall'
  )
  const observer = removed.failed
    ? 'failed'
    : removed.value === 'uninstalled' || removed.value === 'not_installed'
      ? removed.value
      : 'invalid'
  return { rounds, observer }
}

/**
 * Run the many-agent phase.
 *
 * @param {{
 *   page: { evaluate(expression: string): Promise<unknown> },
 *   mainSession: { post(method: string, params?: object, sendOptions?: object): Promise<unknown> },
 *   threads: Array<{ chatId: string, model: string }>,
 *   seats: number, seatMode: 'serial' | 'parallel', configuredTurnMs: number,
 *   readDaemonTurns: (range: { fromMs: number, toMs: number }) => Promise<Array<{
 *     model: string, startedAtMs: number, endedAtMs: number | null, outcome: string }>>,
 *   createHostSampler: (union: { add(sample: object): object }) =>
 *     { start(): Promise<boolean>, stop(): { samples?: object[] } & Record<string, unknown> },
 *   createLanes?: typeof createManyAgentLanes,
 *   nowMs?: () => number, sleep?: (ms: number) => Promise<void>,
 *   windowMs?: number, leadInTimeoutMs?: number, leadInPollMs?: number,
 *   settleMarginMs?: number, fenceMs?: number, hostCaptureWaitMs?: number,
 *   callTimeoutMs?: number, laneOptions?: object,
 *   onCalibrationMarker?: (marker: object) => void,
 *   onCalibrationFailure?: (reason: string) => void,
 *   onWindow?: (window: object) => void
 * }} options
 */
async function runT2ManyAgents(options) {
  if (!isPlainObject(options) || !options.page || typeof options.page.evaluate !== 'function') {
    throw new Error('runT2ManyAgents needs a page adapter')
  }
  if (!options.mainSession || typeof options.mainSession.post !== 'function') {
    throw new Error('runT2ManyAgents needs main’s inspector session')
  }
  if (typeof options.createHostSampler !== 'function') {
    throw new Error('runT2ManyAgents needs a Host sampler factory')
  }
  if (typeof options.readDaemonTurns !== 'function') {
    throw new Error('runT2ManyAgents needs a reader of the daemon’s turns')
  }
  const threads = Array.isArray(options.threads) ? options.threads : []
  if (
    threads.some(
      (thread) =>
        !isPlainObject(thread) ||
        typeof thread.chatId !== 'string' ||
        typeof thread.model !== 'string' ||
        thread.model.length === 0
    ) ||
    new Set(threads.map((thread) => thread.model)).size !== threads.length
  ) {
    throw new Error('runT2ManyAgents needs threads, each with its chat and a model tag of its own')
  }
  const { seats, seatMode, configuredTurnMs } = options
  // Refuses no threads, bad seats or a bad mode before anything starts.
  const asked = agentsAsked({ threads: threads.length, seats, seatMode })
  if (!finiteNonNegative(configuredTurnMs) || configuredTurnMs === 0) {
    throw new Error('configuredTurnMs must be positive')
  }
  const settings = {}
  for (const name of Object.keys(DEFAULT_OPTIONS)) {
    const value = options[name] === undefined ? DEFAULT_OPTIONS[name] : options[name]
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`)
    }
    settings[name] = value
  }
  const { page, mainSession } = options
  const nowMs = options.nowMs || Date.now
  const sleep = options.sleep || defaultSleep
  const chatIds = threads.map((thread) => thread.chatId)
  const lanes = (options.createLanes || createManyAgentLanes)({
    page,
    chatIds,
    nowMs,
    sleep,
    callTimeoutMs: settings.callTimeoutMs,
    ...(isPlainObject(options.laneOptions) ? options.laneOptions : {})
  })
  const union = createHostRecentSpanUnion()
  const sampler = options.createHostSampler(union)

  const labelled = chatIds.map((chatId, place) => ({
    place,
    chatId,
    label: `t${String(place + 1).padStart(3, '0')}`
  }))
  const batches = []
  for (let from = 0; from < labelled.length; from += BATCH_SIZE) {
    batches.push(labelled.slice(from, from + BATCH_SIZE))
  }
  const lanesOf = (batch) => Object.fromEntries(batch.map(({ label, chatId }) => [label, chatId]))

  const sleepUntil = async (atMs) => {
    const wait = atMs - nowMs()
    if (wait > 0) await sleep(wait)
  }
  const readMain = async (batch, sinceMs, untilMs) => {
    try {
      return parseMainAgentSpans(
        await readMainWorkSpanWindow(
          mainSession,
          { lanes: lanesOf(batch), sinceMs, untilMs },
          settings.callTimeoutMs
        ),
        batch.map(({ label }) => label)
      )
    } catch {
      return { ok: false, reason: 'main_read_failed' }
    }
  }
  /** The ring's counters and the admission figures at one moment: a read of no spans. */
  const readMainAt = async (atMs) => {
    const read = await readMain(batches[0].slice(0, 1), atMs, atMs)
    return read.ok ? read.window : null
  }
  const readD1 = async () => {
    try {
      return await readD1Counters(page, { timeoutMs: settings.callTimeoutMs })
    } catch {
      return null
    }
  }
  const probeMain = async (request) => {
    try {
      const result = await readMainPerfWindow(page, request, settings.callTimeoutMs)
      return isPlainObject(result)
        ? result
        : { status: 'unavailable', reason: 'main_probe_invalid' }
    } catch (error) {
      return {
        status: 'unavailable',
        reason: error?.code === 'CAPTURE_TIMEOUT' ? 'main_unresponsive' : 'main_probe_failed'
      }
    }
  }
  /** A profile marker beside a probe, so the window can be placed in main's CPU profile. */
  const mark = async (windowId, failure) => {
    if (typeof options.onCalibrationMarker !== 'function') return
    try {
      options.onCalibrationMarker(
        await captureProfileMarker(mainSession, {
          windowId,
          durationMs: 40,
          timeoutMs: settings.callTimeoutMs
        })
      )
    } catch {
      options.onCalibrationFailure?.(failure)
    }
  }

  /** Wait until every thread has had a round end, or has failed without one. */
  async function leadIn() {
    const startedAtMs = nowMs()
    for (;;) {
      const snapshot = lanes.snapshot()
      const ready = snapshot.threads.filter((thread) =>
        thread.rounds.some((round) => round.endedAtMs !== null)
      ).length
      const lost = snapshot.threads.filter(
        (thread) =>
          thread.failure !== null && !thread.rounds.some((round) => round.endedAtMs !== null)
      ).length
      if (ready + lost === threads.length || nowMs() >= startedAtMs + settings.leadInTimeoutMs) {
        return {
          startedAtMs,
          endedAtMs: nowMs(),
          threadsReady: ready,
          complete: ready === threads.length
        }
      }
      await sleep(settings.leadInPollMs)
    }
  }

  async function measureWindow(hostUnion, leadInComplete) {
    const reasons = []
    if (!leadInComplete) reasons.push('lead_in_incomplete')
    // The Host fold needs a read strictly before the window starts.
    if (hostUnion !== null) await sleep(settings.hostCaptureWaitMs)
    const before = lanes.snapshot()
    const d1Before = await readD1()
    const windowId = 'many_agents_0'
    const mainBefore = await readMainAt(nowMs())
    await mark(windowId, 'window_start_marker_failed')
    const probeBegin = await probeMain({
      action: 'begin',
      id: windowId,
      durationMs: settings.windowMs
    })
    const startedAtMs = nowMs()
    const endedAtMs = startedAtMs + settings.windowMs
    await sleepUntil(endedAtMs)
    let probeEnd = probeBegin
    if (probeBegin.status === 'started') {
      for (let asked = 1; ; asked += 1) {
        probeEnd = await probeMain({ action: 'end', id: windowId })
        if (probeEnd.reason !== 'window_incomplete' || asked === END_PROBE_TRIES) break
        await sleep(END_PROBE_RETRY_MS)
      }
      await mark(windowId, 'window_end_marker_failed')
    }
    const mainAtEnd = await readMainAt(endedAtMs)
    let mainWindow = null
    if (
      probeBegin.status === 'started' &&
      probeBegin.id === windowId &&
      probeEnd.status === 'complete' &&
      probeEnd.id === windowId &&
      finiteNonNegative(probeEnd.startedAtMs) &&
      finiteNonNegative(probeEnd.endedAtMs) &&
      probeEnd.endedAtMs - probeEnd.startedAtMs >= settings.windowMs &&
      isPlainObject(probeEnd.eventLoopLag) &&
      probeEnd.eventLoopLag.sampling === true &&
      LAG_FIELDS.every((name) => finiteNonNegative(probeEnd.eventLoopLag[name])) &&
      probeEnd.eventLoopLag.observedForMs > 0
    ) {
      mainWindow = { ...probeEnd, durabilityBefore: probeBegin.durability ?? null }
    } else reasons.push(probeEnd.reason ?? 'main_probe_invalid')

    // No more rounds; every one in flight runs to its end, then the margin.
    const drained = await lanes.stopSending()
    const drainedAtMs = Math.max(endedAtMs, drained.drainedAtMs ?? nowMs())
    const settledAtMs = drainedAtMs + settings.settleMarginMs
    await sleepUntil(settledAtMs + settings.fenceMs)

    const after = lanes.snapshot()
    for (const failure of new Set(after.threads.map((thread) => thread.failure))) {
      if (failure !== null) reasons.push(`thread_failed:${failure}`)
    }
    if (drained.drainedAtMs === null) reasons.push('threads_not_drained')
    if (after.observer.faults > before.observer.faults) reasons.push('observer_faults')

    // The scripted model's own record of its turns, to this moment.
    let turns = null
    try {
      turns = await options.readDaemonTurns({
        // The daemon keys whole milliseconds, and refuses a range that ends
        // after its own clock: widen a fractional start outward, and end at
        // the last whole millisecond.
        fromMs: Math.floor(startedAtMs),
        toMs: Math.floor(nowMs())
      })
    } catch {
      reasons.push('daemon_turns_unavailable')
    }
    const agents =
      turns === null
        ? null
        : summariseManyAgents({
            window: { startedAtMs, endedAtMs },
            threads: after.threads.map((thread, place) => ({
              ...thread,
              model: threads[place].model
            })),
            turns,
            seats,
            seatMode,
            configuredTurnMs
          })
    if (agents !== null) {
      const { rounds, turns } = agents.overall
      if (rounds.completed === 0) reasons.push('rounds_missing')
      for (const status of Object.keys(rounds.endedOther)) reasons.push(`round_${status}`)
      if (rounds.withoutTurn > 0) reasons.push('rounds_without_turn')
      for (const outcome of Object.keys(turns.notDone)) reasons.push(`turns_${outcome}`)
    }

    // D1: real rounds reached the deferred journal inside the fences.
    const d1After = await readD1()
    const d1 =
      d1Before && d1After
        ? {
            deferredAppends: d1After.deferredAppends - d1Before.deferredAppends,
            normalSaves: d1After.normalSaves - d1Before.normalSaves
          }
        : null
    if (d1 === null) reasons.push('d1_counters_unavailable')
    else if (!(d1.deferredAppends > 0)) reasons.push('d1_no_deferred_append')

    // Main's spans that started inside the window, eight threads a read.
    const spansByThread = threads.map(() => null)
    const readProblems = new Set()
    let lastRead = null
    let censored = false
    for (const batch of batches) {
      const read = await readMain(batch, startedAtMs, endedAtMs)
      if (!read.ok) {
        readProblems.add(read.reason)
        continue
      }
      lastRead = read.window
      censored = censored || read.window.censored
      for (const { label, place } of batch) spansByThread[place] = read.window.lanes[label]
    }
    const waiting = summariseAgentWaiting({
      spansByThread,
      admissionBefore: mainBefore ? mainBefore.admission : null,
      admissionAtEnd: mainAtEnd ? mainAtEnd.admission : null
    })
    if (waiting.pool === null) reasons.push('admission_unavailable')
    reasons.push(...readProblems)
    let main = null
    if (lastRead !== null) {
      const ringRise =
        mainBefore === null
          ? null
          : Object.fromEntries(
              RING_FIELDS.map((field) => [field, lastRead.ring[field] - mainBefore.ring[field]])
            )
      if (censored) reasons.push('main_spans_evicted')
      if (ringRise === null) reasons.push('main_baseline_unavailable')
      else {
        if (ringRise.sampledOut > 0) reasons.push('main_spans_sampled')
        if (ringRise.rejected > 0 || ringRise.degraded > 0) reasons.push('main_spans_lost')
      }
      main = {
        // A span is recorded when its work completes: one still open at the
        // read is absent.
        basis: 'spans started in the window and completed by the read, after its rounds drained',
        censored,
        ringRise,
        byKind: timingsByKind(spansByThread.filter((spans) => spans !== null).flat())
      }
    }

    // The Host's spans, folded eight threads at a time on the one settle time.
    let host = null
    if (hostUnion === null) reasons.push('host_evidence_unavailable')
    else {
      await sleep(settings.hostCaptureWaitMs)
      const folded = []
      let refused = null
      for (const batch of batches) {
        const fold = hostUnion.evaluate(
          [{ role: WINDOW_ROLE, repetition: 0, startedAtMs, endedAtMs, settledAtMs }],
          lanesOf(batch)
        )
        if (!fold.ok) {
          refused = fold.reason
          break
        }
        folded.push(fold.evidence.windows[0])
      }
      if (refused !== null) reasons.push(`host_fold_refused:${refused}`)
      else {
        // What censors a window is the same for every batch but a broken
        // settle claim, which is a batch's own spans'.
        const hostReasons = [...new Set(folded.flatMap((evidence) => evidence.reasons))]
        const foldedLanes = folded.flatMap((evidence) =>
          evidence.lanes ? Object.values(evidence.lanes) : []
        )
        host = {
          censored: folded.some((evidence) => evidence.censored),
          reasons: hostReasons,
          counters: folded[0].counters,
          threadsFolded: foldedLanes.length,
          byKind: pooledHostKinds(foldedLanes)
        }
        reasons.push(...hostReasons.map((reason) => `host_${reason}`))
      }
    }

    const window = {
      role: WINDOW_ROLE,
      repetition: 0,
      startedAtMs,
      endedAtMs,
      drainedAtMs,
      settledAtMs,
      reasons,
      agents,
      waiting,
      d1,
      main,
      mainWindow,
      mainWindowCensored: mainWindow === null,
      host
    }
    if (typeof options.onWindow === 'function') {
      try {
        options.onWindow({ ...window, reasons: [...reasons] })
      } catch {
        // Progress only: a failing observer never costs a window.
      }
    }
    return window
  }

  const windows = []
  let startFailure = null
  let leadInRecord = null
  let lanesSnapshot = null
  let samplerSummary = null
  let teardown = null
  try {
    const samplerStarted = (await sampler.start()) === true
    try {
      await lanes.install()
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : ''
      if (!code.startsWith('T2_LIVE_')) throw error
      const reason = typeof error.reason === 'string' && error.reason ? error.reason : code
      startFailure = `agents_not_started:${reason}`.slice(0, 200)
    }
    if (startFailure === null) {
      lanes.start()
      leadInRecord = await leadIn()
      if (leadInRecord.threadsReady === 0) startFailure = 'agents_not_started:no_round_completed'
      else {
        windows.push(await measureWindow(samplerStarted ? union : null, leadInRecord.complete))
      }
    }
  } finally {
    try {
      lanesSnapshot = await lanes.stop()
    } finally {
      try {
        samplerSummary = sampler.stop()
      } finally {
        teardown = await tidyAgents({
          page,
          snapshot: lanesSnapshot,
          chatIds,
          callTimeoutMs: settings.callTimeoutMs
        })
      }
    }
  }

  const samples =
    isPlainObject(samplerSummary) && Array.isArray(samplerSummary.samples)
      ? samplerSummary.samples
      : []
  const hostSampler = isPlainObject(samplerSummary) ? { ...samplerSummary } : null
  if (hostSampler) delete hostSampler.samples
  const hostLag =
    windows.length === 0
      ? null
      : aggregateHostWindowSamples({
          samples,
          windows: windows.map((window) => ({
            role: window.role,
            repetition: window.repetition,
            startedAtMs: window.startedAtMs,
            endedAtMs: window.endedAtMs,
            outcome: window.reasons.length === 0 ? 'eligible' : 'censored',
            reason: window.reasons.length === 0 ? null : window.reasons[0]
          }))
        })
  return {
    schemaVersion: 1,
    asked,
    options: { ...settings },
    leadIn: leadInRecord,
    windows,
    hostLag: hostLag === null ? null : hostLag.ok ? hostLag.evidence : { error: hostLag.reason },
    lanes: lanesSnapshot,
    hostSampler,
    teardown,
    verdict: liveLaneWindowsVerdict(windows, 1, startFailure === null ? [] : [startFailure])
  }
}

/**
 * What the phase's teardown left undone, as cleanup failures: rounds it
 * could not cancel, or an observer it could not remove. The window was
 * judged before the teardown, so these never touch the verdict.
 */
function manyAgentsTeardownFailures(agents) {
  const teardown = isPlainObject(agents) && isPlainObject(agents.teardown) ? agents.teardown : null
  if (teardown === null) return []
  const failures = []
  if (teardown.rounds.failed > 0) {
    failures.push(`${teardown.rounds.failed} thread round(s) could not be cancelled`)
  }
  if (teardown.observer === 'failed' || teardown.observer === 'invalid') {
    failures.push(`the thread observer could not be removed (${teardown.observer})`)
  }
  return failures
}

/**
 * The live-round verdict with the phase's folded in, each of its reasons
 * prefixed; the phase never ran when `agents` is null.
 */
function withManyAgentsVerdict(roundsVerdict, agents) {
  const base = isPlainObject(roundsVerdict) ? roundsVerdict : { ok: false, reasons: [] }
  const verdict = isPlainObject(agents) && isPlainObject(agents.verdict) ? agents.verdict : null
  const reasons = [...base.reasons]
  if (verdict === null) reasons.push('agents: not run')
  else reasons.push(...verdict.reasons.map((reason) => `agents: ${reason}`))
  return { ok: base.ok === true && verdict !== null && verdict.ok === true, reasons }
}

module.exports = {
  DEFAULT_T2_MANY_AGENT_OPTIONS: DEFAULT_OPTIONS,
  manyAgentChatsOf,
  manyAgentsTeardownFailures,
  parseMainAgentSpans,
  runT2ManyAgents,
  withManyAgentsVerdict
}
